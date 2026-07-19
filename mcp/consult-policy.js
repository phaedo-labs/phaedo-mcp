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

const magRank = (m) => MAG[String(m || '').toLowerCase()] ?? 1;

// Normalize a raw policy doc (array, or { rules: [...] }) → usable rules. Defensive:
// silently skips malformed/unknown-effect rules. Never throws.
export function normalizePolicies(raw) {
  const rules = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.rules) ? raw.rules : []);
  const out = [];
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    const effect = String(r.effect || '').toLowerCase();
    if (!(effect in FORCE) && effect !== 'bias_cautious' && effect !== 'bias_bold') continue;
    const m = (r.match && typeof r.match === 'object') ? r.match : {};
    out.push({
      id: r.id || null,
      domains: (Array.isArray(m.domains) ? m.domains : []).map((d) => String(d).toLowerCase()).filter(Boolean),
      magMin: m.magnitude_min != null ? magRank(m.magnitude_min) : null,
      magMax: m.magnitude_max != null ? magRank(m.magnitude_max) : null,
      reversible: typeof m.reversible === 'boolean' ? m.reversible : null,
      amountGt: typeof m.amount_gt === 'number' && isFinite(m.amount_gt) ? m.amount_gt : null,
      // Conditional + revocable authority (§10.5). `expiresAt` is ENFORCED: a lapsed
      // authorization stops firing (time-bound = revocable, no identity needed; the
      // direction is always authority-NARROWING, so it's fail-safe). `agents` is
      // RESERVED (parsed, not yet enforced): scoping authority to specific agents needs
      // an AUTHENTICATED agent identity — a self-asserted agent_id would be false
      // security — so enforcement waits for that (build-later).
      expiresAt: typeof r.expires_at === 'string' && Number.isFinite(Date.parse(r.expires_at)) ? Date.parse(r.expires_at) : null,
      agents: Array.isArray(r.agents) ? r.agents.map((a) => String(a).toLowerCase()).filter(Boolean) : [],
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
    .map((r) => ({ id: r.instruction_id || null, match: r.match || {}, effect: r.effect, note: r.note || r.text || null, expires_at: r.expires_at, agents: r.agents }));
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
//   1. `phaedo_fingerprint.standing_rules` — the Proposal 0007 authored home:
//      kind:authorization → a deterministic gate; kind:instruction bound negative →
//      a cautious bias (§D). Rides `inner.data` on the phone pull, travels everywhere
//      the fingerprint does (extension ↔ phone ↔ MCP) with NO profile-schema change.
//   2. `phaedo_fingerprint.consult_policies` — DEPRECATED (0007) back-compat read path.
//   3. a top-level vault sibling (`phaedo_consult_policies`) — DEPRECATED, local/extension use.
//   4. opts.policies — a loaded local file (server: mcp/consult-policies.json).
// Force rules (authorizations) always take precedence over bias rules in applyPolicies,
// so ordering within the list only affects which same-class rule wins (first match).
// Defensive — never throws.
export function loadPolicies(vd, opts = {}) {
  let list = [];
  try { list = list.concat(normalizePolicies(authorizationsFromStandingRules(vd?.phaedo_fingerprint))); } catch { /* ignore */ }
  try { list = list.concat(normalizePolicies(biasesFromStandingRules(vd?.phaedo_fingerprint))); } catch { /* ignore */ }
  try { list = list.concat(normalizePolicies(vd?.phaedo_fingerprint?.consult_policies)); } catch { /* ignore */ }
  try { list = list.concat(normalizePolicies(vd?.phaedo_consult_policies)); } catch { /* ignore */ }
  try { if (opts.policies) list = list.concat(normalizePolicies(opts.policies)); } catch { /* ignore */ }
  return list;
}

function ruleMatches(rule, n) {
  if (rule.domains.length) {
    const d = String(n.domain || '').toLowerCase();
    if (!d || !rule.domains.some((k) => d.includes(k))) return false;
  }
  const mag = magRank(n.magnitude);
  if (rule.magMin != null && mag < rule.magMin) return false;
  if (rule.magMax != null && mag > rule.magMax) return false;
  if (rule.reversible != null && n.reversible !== rule.reversible) return false;
  // Numeric threshold (e.g. "over $5,000"): a rule with amount_gt only matches when
  // the action carries a numeric amount strictly above it. No amount on the action →
  // the threshold rule does not fire (cannot assert it's over the bar).
  if (rule.amountGt != null && !(typeof n.amount === 'number' && n.amount > rule.amountGt)) return false;
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

export function matchAuthorization(n, policies, { now = Date.now() } = {}) {
  if (!policies || !policies.length || n.type === 'voice_draft') return null;
  const matched = policies.filter((r) => ruleActive(r, now) && ruleMatches(r, n));
  const force = matched.find((r) => r.effect in FORCE);
  if (!force) return null;
  return { rule: force, signal: FORCE[force.effect], note: force.note || FORCE_NOTES[force.effect] };
}

// Apply the first matching FORCE rule (escalate / decline / autoproceed) — the
// user's hard pre-decision, which overrides the inferred signal at high deference.
// Else apply the first matching BIAS rule (nudge one step on the ladder). Returns a
// NEW response (§10.3 shape preserved; provenance in rationale_hint). voice_draft is
// never policy-overridden (it's a redirect, not a decision).
export function applyPolicies(response, n, policies, { now = Date.now() } = {}) {
  if (!policies || !policies.length || n.type === 'voice_draft') return response;

  const auth = matchAuthorization(n, policies, { now });
  if (auth) {
    return {
      ...response,
      signal: auth.signal,
      confidence: 1.0,            // authored authorization: a deterministic, certain pre-decision
      deference_level: 'high',
      rationale_hint: `Per your standing rule: ${auth.note}.`.replace(/\s+/g, ' ').trim().slice(0, 280),
    };
  }

  const matched = policies.filter((r) => ruleActive(r, now) && ruleMatches(r, n));
  const bias = matched[0];
  if (!bias) return response;
  const i = LADDER.indexOf(response.signal);
  if (i === -1) return response; // e.g. `decline` — not on the proceed↔escalate ladder
  const j = Math.max(0, Math.min(LADDER.length - 1, i + (bias.effect === 'bias_cautious' ? 1 : -1)));
  if (j === i) return response;
  return {
    ...response,
    signal: LADDER[j],
    rationale_hint: `${response.rationale_hint} (Nudged ${bias.effect === 'bias_cautious' ? 'cautious' : 'bold'} per your preference.)`.slice(0, 280),
  };
}
