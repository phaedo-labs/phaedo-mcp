// Phaedo §10.5 consultation — standing authorizations / deference policies
// (user-authored guardrails).
//
// Lets the user PRE-DECIDE how consultation resolves for given domains / magnitudes
// / reversibility / numeric thresholds — e.g. "escalate any irreversible financial
// action over $5,000", "decline autonomous external email", "auto-proceed low-stakes
// writing". These are AUTHORED standing rules (§5-style: subject-confirmed, applied
// verbatim, not inferred), so a matched FORCE rule is an authorization: it OVERRIDES
// the inferred base signal and resolves the decision deterministically at
// confidence 1.0 / deference high — more authoritative than the inferred pattern.
// This is what makes consultation trustworthy enough to delegate. (Per the A→B fork
// decision, these live in the fingerprint — `phaedo_fingerprint.consult_policies` —
// for v0.1; the §5 User-Configuration home is the v0.2 destination. Extraction MUST
// NOT write this structure — locked by scripts/test_consult_policies_invariant.mjs.)
//
// Deterministic + local. PORTABLE: policies ride the vault as
// `phaedo_consult_policies` and travel with the user (authoring UI is a follow-up;
// a local JSON via PHAEDO_CONSULT_POLICIES works today for testing). §10.3 response
// shape is preserved — policy provenance goes in `rationale_hint` for transparency.

// §5.7 commitments (decision state) project into the same rule shape. commitments.js
// is a CLASSIC script shared with the popup (the sync-merge.js / rule-review.js
// pattern), so it loads through createRequire — and it lives at the REPO ROOT, which
// the published npm tarball does not ship. Same prefer-vendor/fall-back-to-root
// resolution lib/phaedo-crypto.js uses, so the server works from both a dev clone and
// an npm install; build-package.mjs vendors it.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Required for its SIDE EFFECT, then read off the global the IIFE sets — exactly what
// lib/phaedo-crypto.js does with the other vendored classic modules. The destructured
// form looks cleaner and is wrong: mcp/package.json is `type: module`, so a vendored
// `.js` under mcp/vendor/ is parsed as ESM, `module.exports` never runs, and the
// require() returns an empty object. That failure is SILENT here (loadPolicies is
// defensive by design), which would have shipped a server where every commitment
// quietly stopped gating — so the global is the load-bearing path, not a fallback.
const _here = dirname(fileURLToPath(import.meta.url));
const _vendored = resolve(_here, 'vendor', 'commitments.js');
createRequire(import.meta.url)(existsSync(_vendored) ? _vendored : resolve(_here, '..', 'commitments.js'));
const { commitmentsAsPolicies } = globalThis.PhaedoCommitments;
import { normalizeDomain, canonicalDomain } from './lib/domain.js';

const MAG = { low: 0, medium: 1, high: 2 };
const LADDER = ['proceed', 'proceed_with_note', 'clarify', 'escalate']; // bold → cautious
// "Force" effects set the signal outright (the user's hard pre-decision) — these are
// the authorizations. (bias_* effects are soft nudges, not authorizations.)
const FORCE = { escalate: 'escalate', require_human: 'escalate', decline: 'decline', autoproceed: 'proceed' };
const FORCE_NOTES = {
  escalate: 'a standing rule surfaces this for a live decision',
  require_human: 'a standing rule requires human review here',
  decline: 'a standing rule declines this action',
  autoproceed: 'a standing rule pre-approves low-stakes actions here',
};

// Effects that EXPAND the agent's autonomy. Only these are gated by
// `require_binding` and `agents` (§10.5): a rule that makes the agent more
// deferential must keep applying whether or not the request is bound and whoever
// is serving it, or either gate would become a way to shed guardrails — by
// omitting a field, or by running an unlisted client. Authority-narrowing only —
// the same fail-safe direction as `expires_at`.
const RELAXING = new Set(['autoproceed', 'bias_bold']);

const magRank = (m) => MAG[String(m || '').toLowerCase()] ?? 1;

// Normalize a raw policy doc (array, or { rules: [...] }) → usable rules. Defensive:
// silently skips malformed/unknown-effect rules. Never throws.
export function normalizePolicies(raw) {
  const rules = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.rules) ? raw.rules : []);
  // §10.5 TOMBSTONES. The sync merge already drops revoked rules from `rules`, so this is a
  // belt-and-braces read: a fingerprint that arrived from a producer which does not implement
  // tombstones, or a restored backup predating the revocation, can still carry a rule the
  // subject revoked. The schema makes dropping it a consumer MUST, and the failure direction
  // matters — honoring a revoked `autoproceed` grants autonomy that was explicitly taken back.
  const revokedRaw = (raw && !Array.isArray(raw) && Array.isArray(raw.revoked)) ? raw.revoked : [];
  const revoked = new Set(
    revokedRaw.map((t) => (t && typeof t === 'object' && t.id != null ? String(t.id) : null)).filter(Boolean)
  );
  const out = [];
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    if (r.id != null && revoked.has(String(r.id))) continue;   // revoked → never resolves
    const effect = String(r.effect || '').toLowerCase();
    if (!(effect in FORCE) && effect !== 'bias_cautious' && effect !== 'bias_bold') continue;
    const m = (r.match && typeof r.match === 'object') ? r.match : {};
    out.push({
      id: r.id || null,
      domains: (Array.isArray(m.domains) ? m.domains : []).map((d) => normalizeDomain(d)).filter(Boolean),
      // §10.2 vocabulary form of the same scope, used ONLY by the restrictive-rule
      // alias path in domainCovers — see the safety argument there. Precomputed so
      // matching stays allocation-free on the hot path.
      domainsCanonical: (Array.isArray(m.domains) ? m.domains : []).map((d) => canonicalDomain(d)).filter(Boolean),
      magMin: m.magnitude_min != null ? magRank(m.magnitude_min) : null,
      magMax: m.magnitude_max != null ? magRank(m.magnitude_max) : null,
      reversible: typeof m.reversible === 'boolean' ? m.reversible : null,
      amountGt: typeof m.amount_gt === 'number' && isFinite(m.amount_gt) ? m.amount_gt : null,
      amountLt: typeof m.amount_lt === 'number' && isFinite(m.amount_lt) ? m.amount_lt : null,
      // Conditional + revocable authority (§10.5). `expiresAt` is ENFORCED: a lapsed
      // authorization stops firing (time-bound = revocable, no identity needed; the
      // direction is always authority-NARROWING, so it's fail-safe).
      //
      // `agents` is now ENFORCED too, against the SERVING PAIRED CLIENT's own
      // `client_id` — never against the self-asserted `agent_id`, which stays an
      // untrusted audit label. One MCP server process serves exactly one paired
      // client, so the server does not have to ask who is calling: it knows who it
      // is, from its own `pairing.json`. Nothing agent-supplied enters the decision.
      // See `docs/roadmap/paired-client-identity-2026-07-22.md`.
      //
      // Compared EXACTLY: these are opaque, phone-issued identifiers, so case is
      // significant and lowercasing them (as the RESERVED parse used to) could alias
      // two distinct clients. Trimmed only.
      //
      // ABSENT vs EMPTY are DIFFERENT, and the distinction is load-bearing:
      //   null  → no scope was authored → the rule is unscoped and applies to all
      //   []    → a scope WAS authored and it names nobody → matches no client
      // Collapsing both to [] (as the first cut did) would make an authoring UI that
      // deselects every client silently grant UNIVERSAL autonomy — the exact inverse
      // of what the subject just expressed, and in the widening direction.
      //
      // Entries must actually BE strings. Coercing with String() would turn `[null]`
      // into a rule scoped to the literal "null", and `[42]` into one that matches a
      // client whose id is "42" — type confusion inventing principals that don't
      // exist. Non-strings are dropped, matching how every other field here is
      // type-checked rather than coerced.
      expiresAt: typeof r.expires_at === 'string' && Number.isFinite(Date.parse(r.expires_at)) ? Date.parse(r.expires_at) : null,
      agents: Array.isArray(r.agents) ? r.agents.filter((a) => typeof a === 'string').map((a) => a.trim()).filter(Boolean) : null,
      // §10.2/§10.5 binding gate: when true, this rule only RELAXES for a request
      // bound to a concrete call (action_binding). Defaults FALSE so every existing
      // authorization keeps its current behaviour — the tightening is opt-in per
      // rule, and the promotion path (which authors rules from observed approvals)
      // always sets it.
      requireBinding: r.require_binding === true,
      // §5.7 provenance. Only `commitment` is meaningful today; it makes a cautious
      // nudge from decision state explain itself (see applyPolicies).
      ruleKind: r.rule_kind === 'commitment' ? 'commitment' : null,
      effect,
      note: typeof r.note === 'string' ? r.note : null,
    });
  }
  return out;
}

// Project the AUTHORIZATION-kind entries of `standing_rules` (Proposal 0007 — the
// single authored home) into the raw consult_policies rule shape normalizePolicies
// consumes. `kind:"instruction"` entries are verbatim injection rules, not gates —
// the resolver ignores them. `note` falls back to the injectable `text` so the
// rationale_hint still names the rule.
function authorizationsFromStandingRules(fp) {
  const rules = Array.isArray(fp?.standing_rules) ? fp.standing_rules : [];
  return rules
    .filter((r) => r && r.kind === 'authorization' && r.effect)
    .map((r) => ({
      id: r.instruction_id || null,
      match: r.match || {},
      effect: r.effect,
      note: r.note || r.text || null,
      expires_at: r.expires_at,
      agents: r.agents,
      // Must be carried: the authored home is where real authorizations live, so
      // dropping it here would leave the §10.5 binding gate declared-but-inert for
      // every rule a subject actually wrote.
      require_binding: r.require_binding,
    }));
}

// Project a bound `kind:"instruction"` (Proposal 0007 §D) into a consultation BIAS.
// An instruction carries prose + a `decision` dimension + polarity, but not a
// structured enum value, so it cannot resolve a dimension to a value the way an
// inferred signal does. v0.1 semantics, deliberately conservative: a NEGATIVE
// (anti-preference / "I won't…") bound rule nudges the matching-domain consultation
// one step cautious (bias_cautious) — authored rules may make the agent MORE
// deferential, never less. POSITIVE-polarity rules expand autonomy, the riskier
// direction, and are NOT projected in v0.1 (they still inject verbatim); that is
// gated behind structured per-dimension values. An unscoped (no decision.domain)
// rule biases all actions cautious — global by construction.
function biasesFromStandingRules(fp) {
  const rules = Array.isArray(fp?.standing_rules) ? fp.standing_rules : [];
  return rules
    .filter((r) => r && r.kind === 'instruction' && r.decision && r.decision.polarity === 'negative')
    .map((r) => ({ id: r.instruction_id || null, match: { domains: r.decision.domain ? [r.decision.domain] : [] }, effect: 'bias_cautious', note: r.text || null }));
}

// Merge policy sources, the authored home first:
//   1. the §5 User Configuration sibling (`vd.phaedo_user_configuration`) — CANONICAL
//      when present (config home migration, part 2): its `standing_instructions`
//      REPLACE the fingerprint A-home for the authored read (the two homes are
//      dual-home lockstep, so reading both would double every rule).
//   2. `phaedo_fingerprint.standing_rules` — the Proposal 0007 A-home (used when no
//      sibling travels yet): kind:authorization → a deterministic gate;
//      kind:instruction bound negative → a cautious bias (§D). Rides `inner.data`
//      on the phone pull with NO profile-schema change.
//   3. `phaedo_fingerprint.consult_policies` — DEPRECATED (0007) back-compat read path.
//   4. a top-level vault sibling (`phaedo_consult_policies`) — DEPRECATED, local/extension use.
//   5. opts.policies — a loaded local file (server: mcp/consult-policies.json).
// Force rules (authorizations) always take precedence over bias rules in applyPolicies,
// so ordering within the list only affects which same-class rule wins (first match).
// Defensive — never throws.
export function loadPolicies(vd, opts = {}) {
  let list = [];
  const cfg = vd?.phaedo_user_configuration;
  const authoredHome = (cfg && typeof cfg === 'object' && Array.isArray(cfg.standing_instructions))
    ? { standing_rules: cfg.standing_instructions }   // §5 canonical — same entry shape by construction
    : vd?.phaedo_fingerprint;
  try { list = list.concat(normalizePolicies(authorizationsFromStandingRules(authoredHome))); } catch { /* ignore */ }
  try { list = list.concat(normalizePolicies(biasesFromStandingRules(authoredHome))); } catch { /* ignore */ }
  // §5.7 decision STATE. Projected into the same rule shape so precedence, expiry
  // and the deterministic pre-flight all work unchanged. Ordered AFTER authorizations
  // deliberately: an authored gate is a durable policy, a commitment is a temporary
  // fact about right now, and where both match the standing policy should speak first
  // (both can only be deferential or more so, so neither ordering is unsafe).
  try { list = list.concat(normalizePolicies(commitmentsAsPolicies(vd?.phaedo_fingerprint, opts))); } catch { /* ignore */ }
  try { list = list.concat(normalizePolicies(vd?.phaedo_fingerprint?.consult_policies)); } catch { /* ignore */ }
  try { list = list.concat(normalizePolicies(vd?.phaedo_consult_policies)); } catch { /* ignore */ }
  try { if (opts.policies) list = list.concat(normalizePolicies(opts.policies)); } catch { /* ignore */ }
  return list;
}

// Does this rule's domain scope cover the action?
//
// Two paths, and the asymmetry is the whole safety argument for the §10.2 vocabulary:
//
//   SUBSTRING (unchanged, always available) — today's behaviour, on normalized
//   strings. A rule scoped to `finance` covers a `finance.crypto_trading` action.
//
//   CANONICAL EQUALITY (new, RESTRICTIVE effects only) — a rule scoped to `financial`
//   also covers a `finance` action, because the published vocabulary says they are one
//   domain. This path is DENIED to relaxing effects on purpose: an alias table can be
//   wrong, and a wrong alias must never hand an agent autonomy the subject did not
//   grant. It may only ever make a GUARDRAIL cover more. So the worst case for a bad
//   entry in that table is "an agent asks when it needn't" — never the reverse.
//
// Purely additive for restrictive rules: nothing that matches today stops matching, so
// no guardrail can be lost by adopting the vocabulary.
function domainCovers(rule, n) {
  if (!rule.domains.length) return true;
  const d = normalizeDomain(n.domain);
  if (!d) return false;
  if (rule.domains.some((k) => d.includes(k))) return true;
  if (RELAXING.has(rule.effect)) return false;          // grants never get the alias path
  // Compare canonical to canonical. An early draft guarded this with `c !== d`, on the
  // assumption that canonicalization only ever moves the ACTION — but the alias is just
  // as often on the RULE ("financial" rule, "finance" action), and that guard silently
  // disabled exactly the case the vocabulary exists for.
  const c = canonicalDomain(d);
  return !!c && rule.domainsCanonical.some((k) => k === c);
}

function ruleMatches(rule, n) {
  if (!domainCovers(rule, n)) return false;
  const mag = magRank(n.magnitude);
  if (rule.magMin != null && mag < rule.magMin) return false;
  if (rule.magMax != null && mag > rule.magMax) return false;
  if (rule.reversible != null && n.reversible !== rule.reversible) return false;
  // Numeric FLOOR (e.g. "over $5,000"): a rule with amount_gt only matches when
  // the action carries a numeric amount strictly above it. No amount on the action →
  // the threshold rule does not fire (cannot assert it's over the bar).
  if (rule.amountGt != null && !(typeof n.amount === 'number' && n.amount > rule.amountGt)) return false;
  // Numeric CEILING (e.g. "under $75"): the mirror, and it matters most on a relaxing
  // rule. Same no-amount handling ON PURPOSE — an unpriced action must NOT slip under
  // a ceiling nobody can check. Both gates fail closed when the amount is absent, which
  // means adding an amount bound can only ever narrow a rule, never widen it.
  if (rule.amountLt != null && !(typeof n.amount === 'number' && n.amount < rule.amountLt)) return false;
  return true;
}

// The first matching AUTHORIZATION (force rule) for a normalized request, or null.
// Authorizations are force effects only — bias rules are soft preferences, not
// authorizations, so they are ignored here. Deterministic: no inference, no model.
// This is the engine behind the lightweight `phaedo_check_authorization` pre-flight
// (brief M3) — an agent can ask "is this already decided by a standing rule?" without
// paying for a full consultation. voice_draft is exempt (a redirect, not a decision).
// A rule is ACTIVE only if it has not lapsed (§10.5 revocable authority). `expiresAt`
// is enforced; `agents` scoping is reserved (see normalizePolicies). Authority-narrowing
// only — an expired rule simply stops applying.
function ruleActive(rule, now) {
  return !(rule.expiresAt != null && now >= rule.expiresAt);
}

// A `require_binding` rule is INERT for an unbound request — but only when its
// effect would expand autonomy. See RELAXING above.
function bindingSatisfied(rule, n) {
  if (!rule.requireBinding || !RELAXING.has(rule.effect)) return true;
  return !!(n && n.bound);
}

// §10.5 `agents` — scoping authority to specific PAIRED CLIENTS.
//
// `clientId` is the serving MCP server's OWN `client_id`, read from its
// `pairing.json` by the transport layer — a phone-issued identifier established
// out-of-band over ECDH with a SAS the subject verified on a separate device. It is
// not presented by the caller and cannot be self-asserted, which is exactly why it
// can be gated on where `agent_id` cannot.
//
// Fail-safe, in the same direction as everything else in §10.5:
//   - unscoped rule (no `agents`)            → applies, unchanged
//   - restrictive effect                     → applies regardless of scope, or `agents`
//                                              would be a way to shed a guardrail by
//                                              running an unlisted client
//   - relaxing effect + unpaired/unknown id  → INERT ("does not apply"), never
//                                              broader, never an error
//
// A caller with no identity therefore has nothing to match, so scoped authority is
// simply not extended to it. Note there is deliberately NO analogue of
// `bindingSuppressed` here: telling an unlisted client that some rule would have
// relaxed for a *different* client leaks the shape of the subject's other grants,
// which §10.4 does not permit. Binding is a fixable omission worth reporting; being
// the wrong principal is not.
// Ordered so the RESTRICTIVE check comes first and nothing below it can throw: this
// function sits on the path of every consultation, and `normalizePolicies` promises
// the file never throws. A rule reaching here without a well-formed `agents` (a
// hand-built policy object bypassing normalization — the exported API allows it) must
// fail INERT for a relaxing effect, never with a TypeError that aborts the whole
// consultation. Same defensive posture as `bindingSatisfied`.
function agentScopeSatisfied(rule, clientId) {
  if (!RELAXING.has(rule.effect)) return true;             // restrictive → always applies
  const scope = rule.agents;
  if (scope == null) return true;                          // no scope authored → unscoped
  if (!Array.isArray(scope)) return false;                 // malformed → fail closed
  if (typeof clientId !== 'string' || !clientId) return false;
  return scope.includes(clientId);                         // [] matches nobody, by design
}

// Did a rule match on its own terms and get held back ONLY by the binding gate?
// Worth reporting: otherwise an agent whose standing auto-proceed rule silently
// stops firing has no way to learn that it needs to send an action_binding.
// Scope-inert rules are excluded FIRST, so a rule that does not apply to this client
// can't be reported as "held back only by the binding gate" — that would disclose it.
export function bindingSuppressed(n, policies, { now = Date.now(), clientId = null } = {}) {
  if (!policies || !policies.length || !n || n.type === 'voice_draft') return false;
  return policies.some((r) => ruleActive(r, now) && agentScopeSatisfied(r, clientId)
    && ruleMatches(r, n) && !bindingSatisfied(r, n));
}

export function matchAuthorization(n, policies, { now = Date.now(), clientId = null } = {}) {
  if (!policies || !policies.length || n.type === 'voice_draft') return null;
  const matched = policies.filter((r) => ruleActive(r, now) && agentScopeSatisfied(r, clientId)
    && ruleMatches(r, n) && bindingSatisfied(r, n));
  const force = matched.find((r) => r.effect in FORCE);
  if (!force) return null;
  return { rule: force, signal: FORCE[force.effect], note: force.note || FORCE_NOTES[force.effect] };
}

// Apply the first matching FORCE rule (escalate / decline / autoproceed) — the
// user's hard pre-decision, which overrides the inferred signal at high deference.
// Else apply the first matching BIAS rule (nudge one step on the ladder). Returns a
// NEW response (§10.3 shape preserved; provenance in rationale_hint). voice_draft is
// never policy-overridden (it's a redirect, not a decision).
export function applyPolicies(response, n, policies, { now = Date.now(), clientId = null } = {}) {
  if (!policies || !policies.length || n.type === 'voice_draft') return response;

  const auth = matchAuthorization(n, policies, { now, clientId });
  if (auth) {
    return {
      ...response,
      signal: auth.signal,
      confidence: 1.0,            // authored authorization: a deterministic, certain pre-decision
      deference_level: 'high',
      rationale_hint: `Per your standing rule: ${auth.note}.`.replace(/\s+/g, ' ').trim().slice(0, 280),
    };
  }

  const matched = policies.filter((r) => ruleActive(r, now) && agentScopeSatisfied(r, clientId)
    && ruleMatches(r, n) && bindingSatisfied(r, n));
  const bias = matched[0];
  // A relaxing rule that matched but was held back by the binding gate is worth
  // saying out loud — silence would look like a broken rule.
  const bindingNote = bindingSuppressed(n, policies, { now, clientId })
    ? ' (A standing rule that would have expanded autonomy here did not apply: this request is not bound to a concrete action.)'
    : '';
  if (!bias) {
    return bindingNote
      ? { ...response, rationale_hint: `${response.rationale_hint}${bindingNote}`.slice(0, 280) }
      : response;
  }
  const i = LADDER.indexOf(response.signal);
  if (i === -1) return response; // e.g. `decline` — not on the proceed↔escalate ladder
  const j = Math.max(0, Math.min(LADDER.length - 1, i + (bias.effect === 'bias_cautious' ? 1 : -1)));
  if (j === i) return response;
  // A disposition nudge says "per your preference"; a §5.7 commitment says what it
  // is, because "you are currently bound by something" is the whole reason the signal
  // moved and an agent that isn't told cannot act sensibly on it. The note is already
  // disclosure-filtered (opaque unless the subject marked the entry disclosable).
  const why = bias.ruleKind === 'commitment' && bias.note
    ? `(Nudged cautious — ${bias.note}.)`
    : `(Nudged ${bias.effect === 'bias_cautious' ? 'cautious' : 'bold'} per your preference.)`;
  return {
    ...response,
    signal: LADDER[j],
    rationale_hint: `${response.rationale_hint} ${why}${bindingNote}`.slice(0, 280),
  };
}
