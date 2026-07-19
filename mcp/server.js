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

import { loadFingerprint, loadFingerprintPreferCache } from './fingerprint-source.js';
import { hasPairingRecord, loadPairingRecord } from './phone-source.js';
import { depositDelegationSuggestions } from './delegation-sync.js';
import { depositReceiptsDigest, drainAndApplyMarks } from './receipts-sync.js';
import { buildDelegationPromotions } from './consult-core.js';
import { depositEscalation, pollEscalationOnce, shouldEscalate, loadEscalationPolicy } from './escalation.js';
import { buildInjectionResponse, errorResponse, PhaedoError } from './projection.js';
import { resolveConsultation, checkAuthorization, consultOptsFromEnv, CONSULTATION_TYPES, consultDrivers, deriveDelegationSignals, withDelegationSignals, authoredDelegationSignals } from './consult.js';
import { defaultStateDir } from './cache.js';
import { buildReceipt, appendReceipt, receiptsCapFromEnv, readReceipts, markOutcome, USER_ACTIONS } from './receipts.js';

const BASE_DIR = dirname(fileURLToPath(import.meta.url));

// §10.6 receipts: every resolved consultation gets an encrypted, append-only,
// on-device receipt. Written AFTER resolution (the resolver stays pure) and
// FAIL-SAFE: a receipt-write failure warns on stderr but never breaks the answer.
const RECEIPTS_CAP = receiptsCapFromEnv(process.env);
async function emitReceipt(via, args, response, drivers) {
  try {
    const receipt = buildReceipt({ via, agentId: args?.agent_id, request: args, response, drivers });
    await appendReceipt(defaultStateDir(), receipt, { cap: RECEIPTS_CAP });
  } catch (e) {
    process.stderr.write(`[phaedo-mcp] receipt write failed (consultation still answered): ${e.message}\n`);
  }
}

// Load the fingerprint for a consult and fold in the act-as-me channel: delegation
// signals derived from this subject's own override history (§10.6 receipts). The
// origin-aware resolver then lets a `delegation` correction outrank a `self` signal on
// the same dimension. Best-effort — if receipts are unreadable, the consult still
// answers from the plain fingerprint (delegation learning never breaks a consultation).
async function loadConsultVd(baseDir, { preferCache = false } = {}) {
  // preferCache (escalation): read the at-rest cache instead of a live phone pull, so the
  // escalation doesn't add a fingerprint-read AUTHORIZE prompt on top of its decision card.
  const vd = preferCache ? await loadFingerprintPreferCache(baseDir) : await loadFingerprint(baseDir);
  try {
    // Two delegation sources, both origin-aware: live override history (every override)
    // + the subject's ENDORSED, portable delegation rules (authored_delegation). The
    // authored rule thus shapes consult too, not only the §9 injection it already renders in.
    const signals = deriveDelegationSignals(await readReceipts(defaultStateDir()))
      .concat(authoredDelegationSignals(vd && vd.phaedo_fingerprint));
    return withDelegationSignals(vd, signals);
  } catch (e) {
    process.stderr.write(`[phaedo-mcp] delegation derive skipped (consult unaffected): ${e.message}\n`);
    return vd;
  }
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
    const promos = buildDelegationPromotions(await readReceipts(defaultStateDir()), (vd && vd.phaedo_fingerprint) || {});
    if (!promos.length) return;
    const sig = promos.map(p => `${p.decision?.dimension}|${p.decision?.domain || ''}|${p.decision?.value}`).sort().join(',');
    if (sig === _lastDepositSig) return;                           // identical set already deposited — skip the relay round-trip
    const res = await depositDelegationSuggestions(await loadPairingRecord(BASE_DIR), promos);
    if (res && res.deposited) _lastDepositSig = sig;               // latch only on success, so a failed deposit retries next consult
    else if (res && !res.deposited)                                // promotions existed but didn't land — say why (don't fail silently)
      process.stderr.write(`[phaedo-mcp] ${promos.length} delegation promotion(s) ready but deposit skipped: ${res.reason || 'http ' + res.status}${res.reason === 'no-relay-device-id' ? ' — pairing has no relay lane (local-only pairing)' : ''}\n`);
  } catch (e) {
    process.stderr.write(`[phaedo-mcp] delegation promotion deposit skipped: ${e.message}\n`);
  }
}

const CONSULT_OPTS = consultOptsFromEnv(process.env);
// Real-time escalation window (docs/roadmap/escalation-and-push.md §crux): how long a
// blocking decision waits for the subject before the agent applies the safe-default
// (hold). Configurable; bounded by the relay's own MAX_WINDOW_MS.
const ESCALATION_WINDOW_MS = (() => {
  const n = Number(process.env.PHAEDO_ESCALATION_WINDOW_MS);
  return Number.isFinite(n) && n > 0 ? n : 3 * 60 * 1000;
})();
// Deference policies: PHAEDO_CONSULT_POLICIES if set, else the default file beside
// the server (mcp/consult-policies.json — what policy-editor.html produces). Zero
// config: drop the file in and restart the client. (Portable vault policies in
// phaedo_consult_policies always apply too, regardless of this file.)
const POLICIES_PATH = process.env.PHAEDO_CONSULT_POLICIES || join(BASE_DIR, 'consult-policies.json');
if (existsSync(POLICIES_PATH)) {
  try { CONSULT_OPTS.policies = JSON.parse(readFileSync(POLICIES_PATH, 'utf8')); }
  catch (e) { process.stderr.write(`[phaedo-mcp] ignoring malformed consult policies (${POLICIES_PATH}): ${e.message}\n`); }
}

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

const server = new McpServer({ name: 'phaedo', version: '0.2.1' });

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

// ── Tool: phaedo_consult (binding §3.2, spec §10) ─────────────────────────────
// Agent consultation: query the fingerprint at a decision point and get back a
// constrained SIGNAL (§10.3) — never layer content (§10.4 boundary). One tool,
// all four consultation types via `consultation_type`.
server.registerTool(
  'phaedo_consult',
  {
    title: 'Consult the Phaedo fingerprint at a decision point',
    description:
      "Ask how the user's cognitive pattern bears on a decision — without ingesting the fingerprint. " +
      'Returns a signal (proceed | proceed_with_note | clarify | escalate | decline), a confidence, a ' +
      'short rationale_hint, and a deference_level (how strongly to weight it). Use at agent decision points.',
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
      context: z.record(z.any()).optional(),
    },
    // Not read-only: appends a local §10.6 audit receipt and may best-effort deposit a
    // delegation suggestion. Non-destructive and device-local (no external entities).
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      const vd = await loadConsultVd(BASE_DIR);   // fingerprint + act-as-me delegation overlay
      const response = await resolveConsultation(vd, args || {}, CONSULT_OPTS);
      // Provenance for the local audit receipt only — the cues that drove this
      // (never in `response`; §10.4). Best-effort: a failure must not block the answer.
      let drivers = [];
      try { drivers = consultDrivers(vd, args || {}); } catch { /* provenance is non-critical */ }
      await emitReceipt('phaedo_consult', args, response, drivers); // every resolution, abstains included
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
      '(§10.5) already decides this action — escalate, decline, or pre-approve — without running ' +
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
    },
    // Deterministic pre-flight; appends a local audit receipt. Non-destructive, device-local.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      const req = { consultation_type: 'action_approval', ...(args || {}) };
      const vd = await loadFingerprint(BASE_DIR);
      const response = checkAuthorization(vd, req, CONSULT_OPTS);
      // A matched pre-flight IS a resolved decision (the authorization fired) →
      // receipt. A no-match is not a decision — no receipt (keeps the store from
      // filling with probes; the follow-up phaedo_consult writes its own).
      if (response.authorization_matched) {
        await emitReceipt('phaedo_check_authorization', req, { signal: response.signal, confidence: 1.0, deference_level: 'high' });
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
      'After you consulted Phaedo and the USER decided what to do, record their outcome on the receipt: ' +
      'approved | rejected | modified | unknown. Record what the USER chose, NOT whether you proceeded. ' +
      'A rejected/modified outcome teaches Phaedo how the user wants delegated work handled (the act-as-me ' +
      'channel). Defaults to the most recent receipt; pass receipt_id to mark a specific one.',
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
      const response = await resolveConsultation(vd, req, CONSULT_OPTS);
      let drivers = [];
      try { drivers = consultDrivers(vd, req); } catch { /* non-critical */ }
      await emitReceipt('phaedo_escalate', req, response, drivers);   // the decision being escalated
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
