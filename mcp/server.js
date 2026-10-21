#!/usr/bin/env node
// Phaedo MCP server — Phase 1 (push injection).
//
// Exposes the fingerprint projection to any MCP client (Claude Desktop, Claude
// Code, Cursor, agent frameworks) per docs/protocol/mcp-binding.md:
//   - tool      phaedo_request_injection      (§9.2 request → §9.3 response)
//   - resource  phaedo://fingerprint/projection (default projection, all layers)
//
// Injection-only: MCP does not return the conversation, so there is NO capture
// here (binding §5). Local stdio transport only in this cut.

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadFingerprint, sourceOf } from './fingerprint-source.js';
import { hasPairingRecord, loadPairingRecord } from './phone-source.js';
import { depositDelegationSuggestions } from './delegation-sync.js';
import { depositReceiptsDigest, drainAndApplyMarks } from './receipts-sync.js';
import { buildDelegationPromotions } from './consult-core.js';
import { buildAutonomyPromotions } from './autonomy-promotion.js';
import { depositEscalation, pollEscalationOnce, shouldEscalate, loadEscalationPolicy } from './escalation.js';
import { buildIntentMandatePayload } from './ap2.js';
import { depositSignRequest, pollSignOnce } from './signing-request.js';
import { buildSigningAuditRecord, appendSigningAudit } from './signing-audit.js';
import { buildInjectionResponse, errorResponse, PhaedoError } from './projection.js';
import { resolveConsultation, checkAuthorization, CONSULTATION_TYPES, consultDrivers, withRevision } from './consult.js';
import { defaultStateDir } from './cache.js';
import { buildConsultOpts, loadConsultVd } from './consult-runtime.js';
import { buildReceipt, appendReceipt, receiptsCapFromEnv, readReceipts, markOutcome, USER_ACTIONS } from './receipts.js';

const BASE_DIR = dirname(fileURLToPath(import.meta.url));

// §10.6 receipts: every resolved consultation gets an encrypted, append-only,
// on-device receipt. Written AFTER resolution (the resolver stays pure) and
// FAIL-SAFE: a receipt-write failure warns on stderr but never breaks the answer.
const RECEIPTS_CAP = receiptsCapFromEnv(process.env);
async function emitReceipt(via, args, response, drivers) {
  try {
    // `clientId` is what the audit can actually rely on: the paired client that
    // SERVED this call, versus `agentId` — the vendor string the caller claimed.
    // Recording both is the point; they are believed to different degrees.
    const receipt = buildReceipt({ via, agentId: args?.agent_id, clientId: CONSULT_OPTS.clientId, request: args, response, drivers });
    await appendReceipt(defaultStateDir(), receipt, { cap: RECEIPTS_CAP });
    // RETURN THE HANDLE. The tool descriptions instruct the agent to record what the subject
    // decided, but no tool gave it anything to name — so `phaedo_record_outcome` defaulted to
    // 'latest' and attributed the decision to whatever receipt happened to be newest. A $12k
    // payment rejection landed on an unrelated writing consult. That feeds deriveDelegationSignals
    // and the §10.7 promotion evidence, so a mis-attributed override both erodes caution on the
    // wrong dimension AND removes the contrary evidence that would have disqualified the right one.
    return receipt.receipt_id;
  } catch (e) {
    process.stderr.write(`[phaedo-mcp] receipt write failed (consultation still answered): ${e.message}\n`);
  }
  return null;
}

// Effects that let an agent act with LESS oversight. Only these are withheld when the read
// is stale; a restrictive effect keeps applying, because a guardrail the subject may since
// have removed still fails in the safe direction.
const EXPANDING_SIGNALS = new Set(['proceed', 'autoproceed', 'bias_bold']);

/**
 * Downgrade an authority-EXPANDING answer that was computed from a stale (cached) read.
 * Returns the response unchanged for a live read, or for any answer that already defers.
 * Always annotates provenance so the caller can SAY where the answer came from — the
 * silence is what let a stale "you're authorized" go unnoticed for a day.
 */
function withStaleAuthorityGuard(response, vd) {
  const src = sourceOf(vd);
  const out = { ...response };
  const hours = src.ageMs != null ? Math.round(src.ageMs / 3600000) : null;
  out.profile_source = src.live
    ? { live: true }
    : { live: false, cached_age_hours: hours, note: 'Answered from a cached profile — the subject\'s device could not be reached.' };
  if (src.live) return out;
  if (!EXPANDING_SIGNALS.has(String(response?.signal))) return out;

  out.signal = 'escalate';
  out.authorization_matched = false;
  out.stale_downgrade = true;
  out.rationale_hint =
    `Withheld: this would have proceeded automatically, but the decision was computed from a cached copy of the ` +
    `subject's profile${hours != null ? ` about ${hours}h old` : ''} because their device could not be reached. ` +
    `A pre-approval that may since have been revoked must not be acted on unattended — ask the subject.`;
  return out;
}

// Act-as-me PROMOTION (delegation-sync.js): when the override history shows an
// ESTABLISHED pattern that isn't already authored/staged, deposit a delegation
// SUGGESTION across the sync boundary (relay agent_to_ext) for the subject to review +
// endorse in the extension. Best-effort and isolated — never throws into the consult.
// Only proposes a suggestion; the subject still authors (the authored-only invariant).
let _lastDepositSig = null;   // dedup: the promo set last deposited THIS process (extension-side
                              // endorsement never round-trips into the agent's fp, so without this
                              // every consult would re-encrypt + re-POST the identical suggestion)
// §10.6 receipts audit channel (receipts-sync.js): deposit the latest receipts to the
// phone's audit slot (agent_to_phone) so the subject can mark outcomes in the flow
// rather than via `node receipts.js mark`. Dedup on the latest receipt_id +
// user_action set: identical state → skip the round-trip. Best-effort; a deposit
// failure NEVER throws into the tool that triggered it.
let _lastReceiptsSig = null;
async function maybeDepositReceiptsDigest() {
  try {
    if (!hasPairingRecord(BASE_DIR)) return;
    const receipts = await readReceipts(defaultStateDir());
    if (!receipts.length) return;
    // Signature: latest id + a tally of marked states. Catches "new receipt arrived"
    // AND "an existing receipt got marked" (so the next phone drain reflects the mark).
    const latest = receipts[receipts.length - 1];
    const tally = receipts.reduce((acc, r) => { acc[r.user_action ?? 'null'] = (acc[r.user_action ?? 'null'] || 0) + 1; return acc; }, {});
    const sig = `${latest.receipt_id}|${JSON.stringify(tally)}`;
    if (sig === _lastReceiptsSig) return;
    const res = await depositReceiptsDigest(await loadPairingRecord(BASE_DIR), receipts);
    if (res && res.deposited) _lastReceiptsSig = sig;
    else if (res && !res.deposited && res.reason !== 'no-receipts')
      process.stderr.write(`[phaedo-mcp] receipts digest deposit skipped: ${res.reason || 'http ' + res.status}\n`);
  } catch (e) {
    process.stderr.write(`[phaedo-mcp] receipts digest deposit skipped: ${e.message}\n`);
  }
}

// Drain phone-deposited outcome marks and apply them via markOutcome. Best-effort;
// called before tools that read receipts (consult uses delegation derivation; the
// outcome tool may default to "latest") so a recent phone-side mark is reflected
// before the next operation. Idempotent on the MCP side.
async function maybePullPhoneMarks() {
  try {
    if (!hasPairingRecord(BASE_DIR)) return { applied: 0, skipped: 0 };
    return await drainAndApplyMarks(await loadPairingRecord(BASE_DIR), defaultStateDir());
  } catch (e) {
    process.stderr.write(`[phaedo-mcp] phone marks drain skipped: ${e.message}\n`);
    return { applied: 0, skipped: 0, reason: e.message };
  }
}

async function maybeDepositDelegationPromotions(vd) {
  try {
    if (!hasPairingRecord(BASE_DIR)) return;                       // no extension to deposit to
    const receipts = await readReceipts(defaultStateDir());
    const fp = (vd && vd.phaedo_fingerprint) || {};
    // Two channels over one deposit. Delegation promotions learn from the subject's
    // DISAGREEMENTS and can only make the agent more deferential; autonomy promotions
    // (§10.7) learn from deliberate, repeated AGREEMENT and are the only channel that
    // can propose less friction — bounded, binding-gated and expiring, and still only
    // a proposal the subject endorses.
    const promos = buildDelegationPromotions(receipts, fp)
      .concat(buildAutonomyPromotions(receipts, fp));
    if (!promos.length) return;
    const sig = promos.map(p => p.source === 'autonomy_promotion'
      ? `auto|${(p.match?.domains || []).join('+')}|${p.match?.magnitude_max}`
      : `${p.decision?.dimension}|${p.decision?.domain || ''}|${p.decision?.value}`).sort().join(',');
    if (sig === _lastDepositSig) return;                           // identical set already deposited — skip the relay round-trip
    const res = await depositDelegationSuggestions(await loadPairingRecord(BASE_DIR), promos);
    if (res && res.deposited) _lastDepositSig = sig;               // latch only on success, so a failed deposit retries next consult
    else if (res && !res.deposited)                                // promotions existed but didn't land — say why (don't fail silently)
      process.stderr.write(`[phaedo-mcp] ${promos.length} rule promotion(s) ready but deposit skipped: ${res.reason || 'http ' + res.status}${res.reason === 'no-relay-device-id' ? ' — pairing has no relay lane (local-only pairing)' : ''}\n`);
  } catch (e) {
    process.stderr.write(`[phaedo-mcp] rule promotion deposit skipped: ${e.message}\n`);
  }
}

// Env config + the subject's deference policies + this install's paired-client id —
// built in consult-runtime.js, the one copy the Claude Code ship hook shares.
const CONSULT_OPTS = buildConsultOpts(BASE_DIR, process.env);
// Real-time escalation window (docs/roadmap/escalation-and-push.md §crux): how long a
// blocking decision waits for the subject before the agent applies the safe-default
// (hold). Configurable; bounded by the relay's own MAX_WINDOW_MS.
const ESCALATION_WINDOW_MS = (() => {
  const n = Number(process.env.PHAEDO_ESCALATION_WINDOW_MS);
  return Number.isFinite(n) && n > 0 ? n : 3 * 60 * 1000;
})();

// Escalation PUSH policy (which signals wake the subject): the subject-configurable knob
// over the stakes-gated default. Local file (PHAEDO_ESCALATION_POLICY, else
// mcp/escalation-policy.json beside the server) overrides; the portable vault policy
// (phaedo_fingerprint.escalation_policy) is merged in per-call (loadEscalationPolicy).
const ESCALATION_POLICY_PATH = process.env.PHAEDO_ESCALATION_POLICY || join(BASE_DIR, 'escalation-policy.json');
let ESCALATION_POLICY_FILE = null;
if (existsSync(ESCALATION_POLICY_PATH)) {
  try { ESCALATION_POLICY_FILE = JSON.parse(readFileSync(ESCALATION_POLICY_PATH, 'utf8')); }
  catch (e) { process.stderr.write(`[phaedo-mcp] ignoring malformed escalation policy (${ESCALATION_POLICY_PATH}): ${e.message}\n`); }
}

// Read from package.json rather than a literal: this string was pinned at '0.2.2'
// while package.json moved on, so the handshake advertised a version that had not
// been the package's for two months. One source of truth; test-package-closure.mjs
// asserts the two agree.
const PKG_VERSION = JSON.parse(readFileSync(join(BASE_DIR, 'package.json'), 'utf8')).version;
// The one place a client is told how the tools fit together. Without it an app saw eight
// tool descriptions and nothing saying "load the profile first" or "consult before you ship" —
// so whether Phaedo was used at all depended on the model guessing. Short on purpose: clients
// put this in the model's context on every turn.
const SERVER_INSTRUCTIONS = [
  'Phaedo holds the user\'s profile: how they like answers written, and how they want decisions handled when an AI acts for them.',
  '- At the start of a session, call phaedo_request_injection once and treat the returned projection as background on the user\'s style.',
  '- Before a consequential action for the user (merging, deploying, publishing, sending a message, spending money, deleting, changing an account or setting), call phaedo_consult and follow its signal. If you are acting on your own and the decision should be the user\'s, use phaedo_escalate and do not proceed until it resolves.',
  '- When the user reacts to an action you consulted on, call phaedo_record_outcome with its receipt_id: record what they chose, never what you inferred.',
  '- If a tool says no Phaedo profile is set up, tell the user once, plainly, and carry on normally. Do not retry.',
].join('\n');
const server = new McpServer({ name: 'phaedo', version: PKG_VERSION }, { instructions: SERVER_INSTRUCTIONS });

// ── Tool: phaedo_request_injection (binding §3.1) ─────────────────────────────
server.registerTool(
  'phaedo_request_injection',
  {
    title: 'Request a Phaedo fingerprint injection',
    description:
      "Returns the user's Phaedo cognitive-fingerprint projection as a system-prompt " +
      'block to insert at the start of an AI session, so the assistant responds in the ' +
      "user's style. Call once at session start and prepend the returned `projection`.",
    inputSchema: {
      session_context: z
        .object({
          platform: z.string().optional(),
          domain: z.string().optional(),
          task_hint: z.string().optional(),
          audience_hint: z.string().optional(),
          max_tokens: z.number().optional(),
        })
        .optional(),
      mode: z.enum(['standard', 'enhanced_privacy']).optional(),
      requested_layers: z.array(z.string()).optional(),
      consumer_id: z.string().optional(),
    },
    // Read-only: returns the projection, writes nothing. Safe to auto-allow.
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      const vd = await loadFingerprint(BASE_DIR);
      const response = buildInjectionResponse(vd, args || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    } catch (err) {
      // Surface as an MCP tool error carrying the §9.3 error response, with the
      // §9.5 code preserved (binding §4).
      const body = errorResponse(err);
      const code = err instanceof PhaedoError ? err.code : 'internal_error';
      return {
        content: [{ type: 'text', text: `Phaedo injection error [${code}]: ${JSON.stringify(body)}` }],
        isError: true,
      };
    }
  }
);

// §10.2 `action_binding` — the concrete call the action_descriptor claims to
// describe. Optional and back-compatible: an unbound request resolves exactly as
// before. Shared by phaedo_consult / phaedo_check_authorization / phaedo_escalate
// so the three can't drift. See mcp/action-binding.js for why this exists.
const ACTION_BINDING_SCHEMA = z
  .object({
    tool_name: z.string().describe('The tool/function the agent is about to invoke.'),
    arguments_hash: z.string().describe('Hex or base64url digest over the RFC 8785 canonical form of the arguments. Never the arguments themselves.'),
    arguments_preview: z.string().optional().describe('Optional short human-readable summary of the arguments, shown to the subject on an escalation.'),
  })
  .optional()
  .describe(
    'Binds this consultation to the concrete call it describes. The action_descriptor is your ACCOUNT of the action; ' +
    'this is the action. Recorded on the audit receipt so a later mismatch is provable, shown to the user when an ' +
    'escalation reaches their phone, and REQUIRED by any standing rule the user marked require_binding before it ' +
    'will auto-proceed.',
  );

// ── Tool: phaedo_consult (binding §3.2, spec §10) ─────────────────────────────
// Agent consultation: query the fingerprint at a decision point and get back a
// constrained SIGNAL (§10.3) — never layer content (§10.4 boundary). One tool,
// all four consultation types via `consultation_type`.
server.registerTool(
  'phaedo_consult',
  {
    title: 'Consult the Phaedo fingerprint at a decision point',
    description:
      // Names the MOMENTS. "Use at agent decision points" told no agent when it was at one: not
      // one consultation was written between 2026-07-28 and 2026-10-18. And it closes the loop —
      // the receipt_id is the only handle that attributes the user's reaction to THIS action.
      'Ask how the user would want an action handled, before you take it on their behalf — without ' +
      'reading their profile. Call it BEFORE any consequential action you are about to take for the ' +
      'user: merging or deploying, publishing or posting, sending a message, paying or committing money, ' +
      'deleting, or changing an account or setting. Describe the action in action_descriptor (domain, ' +
      'reversible, magnitude, a short summary; amount when money moves) and bind it to the exact call ' +
      'with action_binding. Returns a signal (proceed | proceed_with_note | clarify | escalate | decline | ' +
      'insufficient_signal), a confidence, a short rationale_hint, a deference_level (how strongly to ' +
      'weight it) and a receipt_id. Keep the receipt_id: when the user reacts to what you did — confirms ' +
      'it, overrides it, or wants it done differently — record that with phaedo_record_outcome.',
    inputSchema: {
      consultation_type: z.enum(CONSULTATION_TYPES),
      agent_id: z.string().optional(),
      // RESERVED for v0.3 authenticated agent identity (§10.5 enforcement / OQ9).
      // Today `agent_id` is self-asserted and unverified; v0.3 will carry a signed
      // per-agent credential here so a subject can honestly scope `agents`. Declared
      // now (optional, ignored) so the v0.3 addition is backward-compatible — an
      // agent sending it against this server is simply unaffected.
      agent_credential: z.string().optional(),
      action_descriptor: z
        .object({
          domain: z.string().optional(),
          reversible: z.boolean().optional(),
          magnitude: z.enum(['low', 'medium', 'high']).optional(),
          amount: z.number().optional(),
          summary: z.string().optional(),
        })
        .optional(),
      action_binding: ACTION_BINDING_SCHEMA,
      context: z.record(z.any()).optional(),
    },
    // Not read-only: appends a local §10.6 audit receipt and may best-effort deposit a
    // delegation suggestion. Non-destructive and device-local (no external entities).
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      const vd = await loadConsultVd(BASE_DIR);   // fingerprint + act-as-me delegation overlay
      // STALE-AUTHORITY GUARD. This used to be applied to phaedo_check_authorization ALONE, so
      // the two tools an autonomous agent actually uses answered from a possibly-revoked cached
      // profile with no downgrade and no provenance. That is the 2026-07-25 device defect (a
      // revoked $500 grant honoured from a 22h cache) still live on the paths that matter most.
      const raw = await resolveConsultation(vd, args || {}, CONSULT_OPTS);
      const response = withStaleAuthorityGuard(raw, vd);
      // Provenance for the local audit receipt only — the cues that drove this
      // (never in `response`; §10.4). Best-effort: a failure must not block the answer.
      let drivers = [];
      try { drivers = withRevision(consultDrivers(vd, args || {}, CONSULT_OPTS), raw); } catch { /* provenance is non-critical */ }
      const receiptId = await emitReceipt('phaedo_consult', args, response, drivers); // every resolution, abstains included
      if (receiptId) response.receipt_id = receiptId;   // the handle for phaedo_record_outcome
      await maybeDepositDelegationPromotions(vd);                    // act-as-me promotion (best-effort)
      await maybeDepositReceiptsDigest();                            // G1+G2 audit channel — refresh the phone's view
      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    } catch (err) {
      const body = errorResponse(err, 'consultation');
      const code = err instanceof PhaedoError ? err.code : 'internal_error';
      return {
        content: [{ type: 'text', text: `Phaedo consultation error [${code}]: ${JSON.stringify(body)}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: phaedo_check_authorization (binding §3.2, spec §10.5) ───────────────
// Lightweight, DETERMINISTIC-only pre-flight: does a standing authorization
// (§10.5 force rule) already decide this action? Skips inferred evaluation and the
// model judge entirely — a fast check an agent runs before a full phaedo_consult.
// Returns { authorization_matched, signal, rule_id, rationale_hint }; a match is the
// subject's pre-decision (confidence 1.0 / deference high, by definition). Never
// returns layer content (§10.4).
server.registerTool(
  'phaedo_check_authorization',
  {
    title: 'Check standing authorizations for an action',
    description:
      "Deterministic pre-flight: check whether one of the user's standing authorizations " +
      'already decides this action — escalate, decline, or pre-approve — without running ' +
      'the full consultation. Returns authorization_matched plus the authorized signal and the ' +
      'rule that fired. If no rule matches, fall back to phaedo_consult or your own default.',
    inputSchema: {
      consultation_type: z.enum(CONSULTATION_TYPES).optional(),
      agent_id: z.string().optional(),
      // RESERVED for v0.3 authenticated agent identity (§10.5) — see phaedo_consult.
      // Optional + ignored today; declared so v0.3 enforcement is additive.
      agent_credential: z.string().optional(),
      action_descriptor: z
        .object({
          domain: z.string().optional(),
          reversible: z.boolean().optional(),
          magnitude: z.enum(['low', 'medium', 'high']).optional(),
          amount: z.number().optional(),
          summary: z.string().optional(),
        })
        .optional(),
      action_binding: ACTION_BINDING_SCHEMA,
    },
    // Deterministic pre-flight; appends a local audit receipt. Non-destructive, device-local.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      const req = { consultation_type: 'action_approval', ...(args || {}) };
      const vd = await loadFingerprint(BASE_DIR);
      // STALENESS MAY NOT EXPAND AUTONOMY. When the live pull failed we are answering from
      // an at-rest cache that predates anything the subject has changed since — including a
      // REVOCATION. Observed on device 2026-07-25: a revoked $500 payment grant kept
      // returning "authorized" from a 22-hour-old copy. A stale read may still make an agent
      // MORE deferential (that direction is safe and useful phone-absent); it may never be
      // the basis for proceeding unattended. Same asymmetry as `expires_at`, `require_binding`
      // and the §10.2 domain aliases: narrow freely, widen never.
      // The receipt is gated on `authorization_matched`, which the guard CLEARS — so the one
      // case that most needs an audit trail (an authorization fired against a possibly-revoked
      // cached grant and had to be withheld) used to leave no record at all. §10.6: "a matched
      // deterministic pre-flight is a resolution and produces a receipt."
      const preGuard = checkAuthorization(vd, req, CONSULT_OPTS);
      const matchedPreGuard = preGuard.authorization_matched === true;
      const response = withStaleAuthorityGuard(preGuard, vd);
      // A matched pre-flight IS a resolved decision (the authorization fired) →
      // receipt. A no-match is not a decision — no receipt (keeps the store from
      // filling with probes; the follow-up phaedo_consult writes its own).
      if (matchedPreGuard) {
        const rid = await emitReceipt('phaedo_check_authorization', req, { signal: response.signal, confidence: 1.0, deference_level: 'high' });
        if (rid) response.receipt_id = rid;
        await maybeDepositReceiptsDigest();                          // G1+G2 audit channel — only on a matched preflight (no-match writes no receipt)
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    } catch (err) {
      const body = errorResponse(err, 'authorization_check');
      const code = err instanceof PhaedoError ? err.code : 'internal_error';
      return {
        content: [{ type: 'text', text: `Phaedo authorization-check error [${code}]: ${JSON.stringify(body)}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: phaedo_record_outcome (spec §10.6 — the act-as-me loop closer) ──────
// After consulting Phaedo and the SUBJECT decided what to do, record their outcome on
// the consultation receipt. This is the source of delegation learning: a `rejected` or
// `modified` outcome — the subject CORRECTING an agent that acted on their behalf —
// teaches Phaedo how they want delegated work handled (a `delegation`-origin signal that
// outranks their own `self` pattern in future consults). Honesty rail: record what the
// SUBJECT chose, never whether YOU (the agent) proceeded — `approved` self-reported by an
// obedient agent teaches nothing, by design, so the agreement metric can't collapse into
// "agent obedience". §10.4-safe: returns only {matched, receipt_id, user_action}.
server.registerTool(
  'phaedo_record_outcome',
  {
    title: 'Record what the subject decided about a consulted action',
    description:
      'Record what the USER decided about an action you consulted Phaedo on: approved | rejected | ' +
      'modified | unknown. Call it when the user reacts to that action — they confirm it (approved), ' +
      'refuse or undo it (rejected), or want it done differently (modified). Always pass the receipt_id ' +
      'that phaedo_consult (or a Phaedo hook) gave you; without it the most recent receipt is marked, ' +
      'which may be a different action. Record what the user chose, never whether you proceeded: ' +
      'silence is not approval, and an approval you inferred teaches nothing. A rejected/modified ' +
      'outcome teaches Phaedo how the user wants delegated work handled (the act-as-me channel).',
    inputSchema: {
      outcome: z.enum(USER_ACTIONS),
      receipt_id: z.string().optional(),
      // RESERVED for v0.3 learning-loop integrity (OQ16). This is the act-as-me
      // training channel: an adversary inside the same MCP boundary could poison
      // delegation preferences with forged outcome calls. v0.3 will require the
      // recording agent to be authenticated (agent_id + signed agent_credential),
      // rate-limited per dimension, and anomaly-checked. Declared now (optional,
      // ignored) so that enforcement is a backward-compatible addition.
      agent_id: z.string().optional(),
      agent_credential: z.string().optional(),
    },
    // Writes the subject's decision onto a local receipt (the act-as-me learning signal).
    // Non-destructive + idempotent (re-recording the same outcome is a no-op); device-local.
    // Recommend "Always allow" so the learning isn't gated behind a per-call prompt.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      // Drain any phone-deposited marks first (G1+G2 audit channel): if the subject
      // already marked outcomes from the phone, they should land before the agent's
      // own self-record so "latest" resolves against the freshest state. Best-effort.
      await maybePullPhoneMarks();
      const res = await markOutcome(defaultStateDir(), args?.receipt_id || 'latest', args.outcome);
      // Refresh the phone's view so the just-applied mark is reflected on next drain.
      await maybeDepositReceiptsDigest();
      const body = res.matched
        ? { request_type: 'outcome_record', recorded: true, receipt_id: res.receipt_id, user_action: res.user_action }
        : { request_type: 'outcome_record', recorded: false, reason: res.reason };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
    } catch (err) {
      const code = err instanceof PhaedoError ? err.code : 'request_malformed';
      return {
        content: [{ type: 'text', text: `Phaedo record-outcome error [${code}]: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: phaedo_escalate (docs/roadmap/escalation-and-push.md) ───────────────
// REAL-TIME escalation for an AUTONOMOUS agent: when an agent acting on the subject's
// behalf hits a decision it can't make alone, wake the subject's phone for a live
// approve/deny/modify instead of guessing. Self-gating: it runs the consult itself and
// only wakes the subject when the signal is genuinely blocking (escalate/clarify) — a
// proceed* signal returns "just proceed", so the subject isn't pinged for low-stakes
// calls. Non-blocking: deposits + wakes, returns a request_id immediately; the agent
// then polls phaedo_escalation_status and HOLDS until it resolves (the safe default if
// the window lapses is do-not-proceed). §10.4-safe: only the agent's own action
// descriptor + the consult signal/rationale cross the wire (encrypted), never layer
// content.
server.registerTool(
  'phaedo_escalate',
  {
    title: 'Escalate a blocking decision to the subject in real time',
    description:
      "When you're acting autonomously for the user and hit a decision you shouldn't make alone, " +
      'escalate it to them live instead of guessing. Runs the consultation and, only if the signal is ' +
      'blocking (escalate/clarify), wakes the user\'s phone for an approve/deny/modify. Returns a ' +
      'request_id immediately — then poll phaedo_escalation_status and DO NOT PROCEED until it resolves ' +
      '(if the user doesn\'t answer in time, hold). Use for consequential, hard-to-undo actions.',
    inputSchema: {
      consultation_type: z.enum(CONSULTATION_TYPES).optional(),
      agent_id: z.string().optional(),
      // RESERVED for v0.3 authenticated agent identity (§10.5) — see phaedo_consult.
      // Optional + ignored today; declared so v0.3 enforcement is additive.
      agent_credential: z.string().optional(),
      action_descriptor: z
        .object({
          domain: z.string().optional(),
          reversible: z.boolean().optional(),
          magnitude: z.enum(['low', 'medium', 'high']).optional(),
          amount: z.number().optional(),
          summary: z.string().optional(),
        })
        .optional(),
      action_binding: ACTION_BINDING_SCHEMA,
      context: z.record(z.any()).optional(),
    },
    // Opens a channel to an EXTERNAL entity (the subject's device, via the relay) and
    // writes a local receipt — not read-only, not destructive, but openWorld (it reaches off-device).
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const req = { consultation_type: 'action_approval', ...(args || {}) };
      // Cache-preferred read: escalation shouldn't trigger a fingerprint-read authorize
      // prompt on top of the decision card the subject already answers (one prompt, not two).
      const vd = await loadConsultVd(BASE_DIR, { preferCache: true });
      // Guarded like the others, and it needs it MOST: this path reads the cache
      // UNCONDITIONALLY, so without the guard it always reasoned from a possibly-stale profile
      // and then told the agent the signal was not blocking — i.e. "just proceed", and never
      // wake the subject, on authority that may have been revoked hours earlier.
      const raw = await resolveConsultation(vd, req, CONSULT_OPTS);
      const response = withStaleAuthorityGuard(raw, vd);
      let drivers = [];
      try { drivers = withRevision(consultDrivers(vd, req, CONSULT_OPTS), raw); } catch { /* non-critical */ }
      const escReceiptId = await emitReceipt('phaedo_escalate', req, response, drivers);   // the decision being escalated
      await maybeDepositReceiptsDigest();                              // G1+G2 audit channel

      // Self-gate: only wake the subject for a genuinely blocking signal. `escalate`
      // always; `clarify` per the subject's push policy (default: only when the action is
      // consequential — irreversible / high magnitude). A low-stakes clarify is the
      // agent's to resolve in its own flow.
      const pushPolicy = loadEscalationPolicy(vd, { escalationPolicy: ESCALATION_POLICY_FILE });
      if (!shouldEscalate(response.signal, req.action_descriptor, pushPolicy)) {
        const subThresholdClarify = response.signal === 'clarify';
        const body = {
          request_type: 'escalation', escalated: false, signal: response.signal,
          rationale_hint: response.rationale_hint, confidence: response.confidence,
          ...(escReceiptId ? { receipt_id: escReceiptId } : {}),
          ...(subThresholdClarify ? { reason: 'clarify_below_threshold' } : {}),
          message: subThresholdClarify
            ? 'Low-stakes clarification — handle it in your own flow (ask your clarifying question, or make a reasonable assumption and state it). It will surface in the user\'s review queue; no need to wake them. Raise an explicit escalate if you truly need a live decision.'
            : 'Signal is not blocking — act on it with your own judgment; no need to interrupt the user.',
        };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }

      const pairing = await loadPairingRecord(BASE_DIR);
      const dep = await depositEscalation(pairing, req, response, { windowMs: ESCALATION_WINDOW_MS });
      const body = dep.deposited
        ? {
            request_type: 'escalation', escalated: true, status: 'pending',
            // Both handles. `request_id` correlates the live decision; `receipt_id` names the
            // §10.6 record to mark afterwards. Returning only the first meant
            // phaedo_escalation_status could not mark correctly and a real-time approve/deny was
            // auto-recorded onto whatever receipt happened to be newest.
            ...(escReceiptId ? { receipt_id: escReceiptId } : {}),
            request_id: dep.request_id, window_ms: dep.window_ms, expires_at: dep.expires_at,
            signal: response.signal, rationale_hint: response.rationale_hint,
            // The relay's push-to-wake result for a BACKGROUNDED phone: { sent, reason }.
            // sent:true → APNs accepted the wake; reason 'not_configured' → relay APNS_* unset,
            // 'no_token'/'not_registered' → phone never registered its APNs token, 'apns_*' →
            // Apple rejected (e.g. BadDeviceToken = sandbox/prod mismatch). A FOREGROUNDED phone
            // is woken over the WS regardless, so a non-sent wake is not necessarily a failure.
            woke: dep.woke,
            message: 'Escalated to the user. Poll phaedo_escalation_status with this request_id; DO NOT PROCEED until it resolves. If it expires unanswered, hold (do not act).',
          }
        : {
            request_type: 'escalation', escalated: false, status: 'unreachable', reason: dep.reason,
            signal: response.signal, rationale_hint: response.rationale_hint,
            message: dep.reason === 'no-relay-device-id' || dep.reason === 'unpaired'
              ? 'No real-time channel to the user (no paired device with a relay lane). Hold or fall back to surfacing the decision in your own conversation.'
              : 'Could not reach the user right now. Hold (do not act) or surface the decision in your own conversation.',
          };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
    } catch (err) {
      const body = errorResponse(err, 'escalation');
      const code = err instanceof PhaedoError ? err.code : 'internal_error';
      return { content: [{ type: 'text', text: `Phaedo escalation error [${code}]: ${JSON.stringify(body)}` }], isError: true };
    }
  }
);

// ── Tool: phaedo_escalation_status ────────────────────────────────────────────
// Poll a pending escalation (from phaedo_escalate). Returns the subject's decision once
// they answer — approve/deny/modify — and AUTOMATICALLY records it as the §10.6 outcome
// (roadmap Q7: a real-time approve/deny IS the strongest act-as-me signal, so it feeds the
// same override-learning loop as phaedo_record_outcome). While unanswered it returns
// pending (keep holding); past the window it returns expired (apply the safe-default: hold).
server.registerTool(
  'phaedo_escalation_status',
  {
    title: 'Check whether the subject has decided an escalation',
    description:
      'Poll an escalation you opened with phaedo_escalate. Returns resolved + the decision (approve | deny | ' +
      'modify) once the user answers, pending while you should keep waiting, or expired once the window lapsed ' +
      '(then HOLD — do not proceed). A resolved decision is recorded automatically as the act-as-me outcome.',
    inputSchema: {
      request_id: z.string(),
      expires_at: z.number().optional(),
      receipt_id: z.string().optional(),
    },
    // Reaches the relay (openWorld) and, on resolution, writes the outcome onto a local receipt.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const pairing = await loadPairingRecord(BASE_DIR);
      const r = await pollEscalationOnce(pairing, args.request_id, { expiresAt: args.expires_at });
      if (r.resolved) {
        // The live decision IS an outcome — record it on the consult receipt automatically.
        let recorded = false;
        try {
          const m = await markOutcome(defaultStateDir(), args.receipt_id || 'latest', r.outcome);
          recorded = !!(m && m.matched);
          await maybeDepositReceiptsDigest();                         // G1+G2: phone sees the recorded outcome on next drain
        } catch { /* outcome-record is best-effort; the decision still returns */ }
        const body = {
          request_type: 'escalation_status', status: 'resolved',
          decision: r.decision, proceed: r.proceed, outcome: r.outcome,
          ...(r.note ? { note: r.note } : {}), ...(r.modified != null ? { modified: r.modified } : {}),
          recorded,
          message: !r.proceed
            ? 'The user declined — do not proceed.'
            : (r.decision === 'modify'
                ? (r.modified != null
                    ? 'The user approved with changes — proceed using the modified parameters.'
                    : `The user wants a change before you proceed${r.note ? `: "${r.note}"` : ''}. Apply their instruction; do not proceed as originally planned.`)
                : 'The user approved — proceed.'),
        };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      const expired = r.status === 'expired';
      const body = {
        request_type: 'escalation_status', status: r.status,
        ...(expired ? { proceed: false } : {}),
        message: expired
          ? 'The decision window lapsed with no answer. Apply the safe default: hold — do not proceed.'
          : 'Not answered yet. Keep holding; poll again shortly.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
    } catch (err) {
      const code = err instanceof PhaedoError ? err.code : 'request_malformed';
      return { content: [{ type: 'text', text: `Phaedo escalation-status error [${code}]: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: phaedo_sign_mandate (§8.3 signing ceremony) ─────────────────────────
// Ask the subject to SIGN an AP2 Intent Mandate built from their standing authorizations.
// Two-call shape like escalation: this deposits the request and returns immediately with a
// request_id + the mandate; the agent then polls phaedo_sign_status. The subject signs on
// their phone inside the Secure Enclave (the server never holds the key). Until a signature
// comes back the mandate is a PROPOSAL, never a credential — do not present it as authorized.
const SIGN_WINDOW_MS = 5 * 60 * 1000;

server.registerTool(
  'phaedo_sign_mandate',
  {
    title: 'Ask the subject to sign a payment authorization (AP2 Intent Mandate)',
    description:
      'Request the user\'s cryptographic signature on an AP2 Intent Mandate built from their ' +
      'standing authorizations — a credential a merchant or payments network can verify. Returns a ' +
      'request_id and the unsigned mandate immediately; then poll phaedo_sign_status with BOTH, and ' +
      'DO NOT treat the mandate as authorized until it returns signed. The user signs on their ' +
      'phone (Face ID, key in the Secure Enclave); they may also decline. Use only when you need a ' +
      'verifiable payment credential — not for ordinary consultations.',
    inputSchema: {
      agent_id: z.string().optional(),
      prompt_playback: z.string().optional(),  // your stated understanding of the request (AP2)
    },
    // Reaches the subject's device via the relay; read-only w.r.t. local state (no receipt yet).
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const vd = await loadConsultVd(BASE_DIR, { preferCache: true });
      const fp = (vd && vd.phaedo_fingerprint) || {};
      const mandate = buildIntentMandatePayload(fp, {
        agentId: args?.agent_id ?? null,
        promptPlayback: args?.prompt_playback ?? null,
      });
      if (!mandate) {
        const body = {
          request_type: 'sign_mandate', status: 'nothing_to_sign',
          message: 'The subject has granted no standing authorizations, so there is nothing to sign. ' +
                   'An empty mandate must never be synthesized — it would read as unlimited authority.',
        };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }

      // Make sure we hold the subject's signing key BEFORE the sheet goes up.
      //
      // Verification needs the published key. Fetching it lazily at poll time meant a live
      // fingerprint pull fired WHILE the signing sheet was on screen — which puts an
      // authorize card up right as that sheet dismisses, and iOS kills the app when two of
      // these sheets overlap ("already presenting"; the nav layer warns about exactly this).
      // Observed on device: the ceremony completed, then the app crashed and the pull that
      // would have supplied the key died with it, so a genuine signature came back
      // unverifiable. Pulling here is free of that hazard — no sheet exists yet — and it
      // also fails fast, before the subject is asked to sign something we could not check.
      if (!(vd && vd.phaedo_signing_public_key)) {
        try { await loadConsultVd(BASE_DIR); } catch { /* best-effort; poll still retries */ }
      }

      const pairing = await loadPairingRecord(BASE_DIR);
      const dep = await depositSignRequest(pairing, mandate, { windowMs: SIGN_WINDOW_MS });
      const body = dep.deposited
        ? {
            request_type: 'sign_mandate', status: 'pending',
            request_id: dep.request_id, window_ms: dep.window_ms, expires_at: dep.expires_at, woke: dep.woke,
            mandate,
            message: 'Sent to the subject to sign. Poll phaedo_sign_status with this request_id AND this ' +
                     'mandate; do not treat it as authorized until it returns signed. If it expires or the ' +
                     'user declines, the mandate stays an unsigned proposal.',
          }
        : {
            request_type: 'sign_mandate', status: 'unreachable', reason: dep.reason,
            message: dep.reason === 'no-relay-device-id' || dep.reason === 'unpaired'
              ? 'No real-time channel to the subject (no paired device with a relay lane). Cannot obtain a signature.'
              : 'Could not reach the subject right now. The mandate remains an unsigned proposal.',
          };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
    } catch (err) {
      const code = err instanceof PhaedoError ? err.code : 'internal_error';
      return { content: [{ type: 'text', text: `Phaedo sign-mandate error [${code}]: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: phaedo_sign_status ──────────────────────────────────────────────────
// Poll a signing request opened with phaedo_sign_mandate. The `mandate` returned by that
// call is passed back here to verify against — a tampered mandate simply fails verification
// (the phone signed only what it displayed), so round-tripping it is safe and restart-proof.
server.registerTool(
  'phaedo_sign_status',
  {
    title: 'Check whether the subject has signed the mandate',
    description:
      'Poll a request from phaedo_sign_mandate. Pass the request_id AND the mandate that call returned. ' +
      'Returns signed + the mandate carrying the verified signature once the user signs, refused if ' +
      'they declined, pending while you should keep waiting, or expired once the window lapsed. A signed ' +
      'result is verified against the user\'s published signing key before it is returned.',
    inputSchema: {
      request_id: z.string(),
      mandate: z.record(z.any()),
      expires_at: z.number().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const vd = await loadConsultVd(BASE_DIR, { preferCache: true });
      let signingPublicKey = vd && vd.phaedo_signing_public_key;
      // NOTE: no live pull here, deliberately. A live pull raises an authorize card on the
      // phone, and this runs while the signing sheet may still be dismissing — overlapping
      // sheets crash iOS ("already presenting"), which is exactly how a good signature was
      // lost on device. The key is fetched at DEPOSIT time instead (see phaedo_sign_mandate),
      // where no sheet exists. If it is still missing here, report that honestly rather than
      // interrupting the subject mid-ceremony to fix it.
      const pairing = await loadPairingRecord(BASE_DIR);
      const r = await pollSignOnce(pairing, args.request_id, args.mandate, {
        expiresAt: args.expires_at, signingPublicKey,
      });

      // A stale key (the subject rotated their signing identity) would also present as a
      // plain mismatch. That is NOT retried with a live pull here, on purpose: the pull
      // raises an authorize card while the signing sheet may still be dismissing, and
      // overlapping sheets crash iOS. Fetching at DEPOSIT time makes staleness effectively
      // impossible anyway — the key is read moments before the sheet appears, and rotation
      // requires a deliberate device action. A genuine mismatch is reported as such.

      if (r.resolved && r.signed) {
        // Audit the minted credential — its own log, NOT a §10.6 consult receipt (a
        // signature has no signal and must not feed act-as-me learning). Records a digest
        // of the signed bytes + coarse metadata, never the mandate content or the signature.
        // Best-effort: a failed audit write must never make a real signature look unsigned.
        let recorded = false;
        try {
          await appendSigningAudit(defaultStateDir(), buildSigningAuditRecord({
            requestId: args.request_id, mandate: r.mandate, clientId: CONSULT_OPTS.clientId, agentId: r.mandate?.agent_id,
          }));
          recorded = true;
        } catch (e) {
          process.stderr.write(`[phaedo-mcp] signing-audit write failed (mandate still signed): ${e.message}\n`);
        }
        const body = {
          request_type: 'sign_status', status: 'signed', mandate: r.mandate, recorded,
          message: 'The subject signed. The mandate now carries a verified signature and may be presented ' +
                   'as a credential.',
        };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      if (r.resolved && !r.signed) {
        const refused = r.reason === 'refused';
        const body = {
          request_type: 'sign_status', status: refused ? 'refused' : 'not_signed', reason: r.reason,
          ...(r.detail ? { detail: r.detail } : {}),
          message: refused
            ? 'The subject declined to sign. Do not proceed with an action that needs this credential.'
            : 'A response arrived but did not verify (' + (r.detail || 'unknown') + '). Treat as unsigned; do not proceed.',
        };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      const expired = r.status === 'expired';
      const body = {
        request_type: 'sign_status', status: r.status,
        message: expired
          ? 'The signing window lapsed with no signature. The mandate remains an unsigned proposal.'
          : 'Not signed yet. Keep waiting; poll again shortly.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
    } catch (err) {
      const code = err instanceof PhaedoError ? err.code : 'request_malformed';
      return { content: [{ type: 'text', text: `Phaedo sign-status error [${code}]: ${err.message}` }], isError: true };
    }
  }
);

// ── Resource: phaedo://fingerprint/projection (binding §3.1) ──────────────────
// Default projection (all layers, standard mode) for resource-only clients.
server.registerResource(
  'phaedo-projection',
  'phaedo://fingerprint/projection',
  {
    title: 'Phaedo fingerprint projection',
    description: 'Default Phaedo injection projection (all layers, standard mode).',
    mimeType: 'text/plain',
  },
  async (uri) => {
    const vd = await loadFingerprint(BASE_DIR);
    const response = buildInjectionResponse(vd, { requested_layers: ['all'], mode: 'standard' });
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: response.projection }] };
  }
);

// ── Prompt: phaedo (one-click session-start injection) ────────────────────────
// MCP prompts surface in clients as a user-invokable command (a `/phaedo` slash
// command in Claude Desktop / Claude Code). Selecting it inserts the projection
// as a conversation message, so the user gets near-automatic injection without
// having to ask the model to call the tool. The text is rendered by the SAME
// context-block path as the tool/resource — byte-identical injection.
server.registerPrompt(
  'phaedo',
  {
    title: 'Load my Phaedo fingerprint',
    description:
      "Insert your Phaedo cognitive-fingerprint projection so the assistant responds in your " +
      "style. Run once at the start of a session.",
  },
  async () => {
    const vd = await loadFingerprint(BASE_DIR);
    const response = buildInjectionResponse(vd, { requested_layers: ['all'], mode: 'standard' });
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'The following is my Phaedo cognitive fingerprint — a profile of how I think, ' +
              'communicate, and want responses formatted. Treat it as authoritative guidance for ' +
              'the rest of this conversation, and do not announce that you read it.\n\n' +
              response.projection,
          },
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport owns stdout for protocol framing — never console.log here.
  process.stderr.write('[phaedo-mcp] ready on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`[phaedo-mcp] fatal: ${err.stack || err}\n`);
  process.exit(1);
});
