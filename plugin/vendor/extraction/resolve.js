// §4.7 Conflict Resolution (Proposal 0006, Route A) — pure, deterministic, no I/O.
//
// Single source of truth for resolving multiple signals on ONE dimension (field)
// into a single value + provenance. Evidence-tier precedence (corroborated >
// observed > self_reported), observation-count then recency tiebreak, with a
// minimum-evidence FLOOR: thin observed evidence does NOT confidently override a
// self-reported (interview) value — below the floor a genuine conflict resolves to
// status:"unresolved", which consumers treat conservatively (assert nothing / an
// agent escalates rather than proceeds).
//
// Lives here (browser-safe ESM, packaged with the extension's extraction engine so
// the producer can render FROM it) and is re-exported by spec/validate-fingerprint.mjs
// so the spec test-vectors and mcp/health use the exact same resolver. Pure: any
// conformant implementation computes the same result from the same evidence log, so
// the fingerprint stays the raw signal log and provenance is derived (no wire change).

const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

export const RESOLUTION_FLOOR = 3;            // observed/corroborated needs ≥ this to override self_reported
const EV_TIER = { corroborated: 3, observed: 2, self_reported: 1 };
const tierOf = (s) => EV_TIER[s && s.evidence_basis] || 1;   // unknown basis → weakest
const obsOf  = (s) => (typeof s.observation_count === 'number' && s.observation_count > 0) ? s.observation_count : 1;
const isoOf  = (s) => typeof s.last_observed === 'string' ? s.last_observed : '';
export const valKey = (v) => JSON.stringify(v ?? null);

// Strict total order: tier, then observation_count, then recency, then value
// string — fully deterministic, no ties.
function moreAuthoritative(a, b) {
  if (tierOf(a) !== tierOf(b)) return tierOf(a) - tierOf(b);
  if (obsOf(a)  !== obsOf(b))  return obsOf(a) - obsOf(b);
  if (isoOf(a)  !== isoOf(b))  return isoOf(a) < isoOf(b) ? -1 : 1;
  const va = valKey(a.value), vb = valKey(b.value);
  return va < vb ? -1 : va > vb ? 1 : 0;
}

export function resolveDimension(signals) {
  const cand = (signals || []).filter(isObj);
  if (!cand.length) return null;
  const winner = cand.reduce((best, s) => moreAuthoritative(s, best) > 0 ? s : best);
  const distinct = new Set(cand.map((s) => valKey(s.value)));
  let status = 'resolved';
  if (distinct.size > 1) {                                   // a genuine value conflict
    const inferredWinner = tierOf(winner) >= EV_TIER.observed;
    const contradictingSelfReport = cand.some(
      (s) => tierOf(s) === EV_TIER.self_reported && valKey(s.value) !== valKey(winner.value));
    if (inferredWinner && contradictingSelfReport && obsOf(winner) < RESOLUTION_FLOOR) status = 'unresolved';
  }
  return {
    field: winner.field,
    value: winner.value,
    evidence_basis: winner.evidence_basis,
    confidence: winner.confidence,
    status,                                                   // "resolved" | "unresolved"
    provenance: cand.map((s) => ({
      value: s.value, source: s.source, evidence_basis: s.evidence_basis,
      confidence: s.confidence, observation_count: s.observation_count, last_observed: s.last_observed,
    })),
  };
}

// Resolve a whole layer's signals → { field: resolution }. Groups by field, then
// resolveDimension per field. (Polarity precedence per §4.3 is applied upstream by
// the producer's effectiveSignals(); this resolves VALUE conflicts.)
export function resolveLayer(signals) {
  const byField = new Map();
  for (const s of (signals || [])) {
    if (!isObj(s) || s.field == null) continue;
    if (!byField.has(s.field)) byField.set(s.field, []);
    byField.get(s.field).push(s);
  }
  const out = {};
  for (const [field, sigs] of byField) out[field] = resolveDimension(sigs);
  return out;
}

// ── §4.7 effective resolution in context (v0.1.43, resolves OQ7) ──────────────
//
// Composes AUTHORED configuration (§5.2 decision-bound standing instructions)
// with the INFERRED evidence log above, per dimension, in an optional domain
// context — the exact rules for "a standing instruction that contradicts a
// high-confidence fingerprint signal in only one domain". The specificity
// ladder (a lower tier is consulted only when every higher tier is empty):
//
//   1. authored_domain — a decision-bound instruction whose decision.domain
//      matches the context domain (resolver substring namespace: the context
//      domain string CONTAINS the rule's domain, case-insensitive). A
//      domain-bound rule NEVER governs outside its domain: with a
//      non-matching or unknown context it is skipped entirely, so the
//      inferred signal keeps governing everywhere else — that is the OQ7
//      one-domain-override semantics.
//   2. authored_global — a decision-bound instruction with no domain binding.
//      Authored beats inferred regardless of the signal's confidence or
//      evidence tier (§4.7 authored-canonical, unchanged — now stated at
//      dimension granularity).
//   3. inferred_domain — §4.2.7 domain-tagged signals matching the context
//      domain, resolved among themselves by resolveDimension. An
//      "unresolved" here does NOT fall through to tier 4: a contested
//      domain-specific dimension stays contested (assert nothing).
//   4. inferred_global — untagged signals, resolved by resolveDimension.
//      Signals tagged with a DIFFERENT domain are excluded when a context
//      domain is known (they describe another context); with no context
//      domain, all signals resolve together (pre-v0.1.43 behavior).
//
// Within an authored tier, ties break §5.2-style: lowest priority number,
// then created_at, then instruction_id — fully deterministic.
//
// Pure; same conformance surface as resolveDimension (TC-RESOLVE vectors).
const prioOf = (r) => (typeof r.priority === 'number' && Number.isFinite(r.priority)) ? r.priority : Infinity;
const cmpStr = (a, b) => { const x = String(a ?? ''), y = String(b ?? ''); return x < y ? -1 : x > y ? 1 : 0; };

export function resolveEffective({ field, signals = [], rules = [], domain = null } = {}) {
  if (field == null) return null;
  const d = (typeof domain === 'string' && domain) ? domain.toLowerCase() : null;

  const bound = (rules || []).filter((r) => isObj(r) && r.kind === 'instruction'
    && isObj(r.decision) && r.decision.dimension === field);
  const ruleDomain = (r) => (typeof r.decision.domain === 'string' && r.decision.domain)
    ? r.decision.domain.toLowerCase() : null;
  const tier1 = d ? bound.filter((r) => { const rd = ruleDomain(r); return rd && d.includes(rd); }) : [];
  const tier2 = bound.filter((r) => !ruleDomain(r));
  const pickRule = (arr) => arr.slice().sort((a, b) =>
    (prioOf(a) - prioOf(b)) || cmpStr(a.created_at, b.created_at) || cmpStr(a.instruction_id, b.instruction_id))[0];

  const authoredTier = tier1.length ? 'authored_domain' : tier2.length ? 'authored_global' : null;
  if (authoredTier) {
    const rule = pickRule(tier1.length ? tier1 : tier2);
    return {
      field,
      status: 'resolved',
      basis: authoredTier,
      authored: true,
      // A bound rule may carry a precise catalog value (template-sourced) or
      // none — a valueless negative binding is a cautious bias, which §10
      // consumers already map (consult-policy.js). Surface both faithfully.
      value: rule.decision.value ?? null,
      polarity: rule.decision.polarity || 'positive',
      rule_id: rule.instruction_id || null,
    };
  }

  const sigs = (signals || []).filter(isObj);
  const sigDomain = (s) => (typeof s.domain === 'string' && s.domain) ? s.domain.toLowerCase() : null;
  const tagged = d ? sigs.filter((s) => { const sd = sigDomain(s); return sd && d.includes(sd); }) : [];
  const pool = tagged.length ? tagged
    : d ? sigs.filter((s) => !sigDomain(s))     // other-domain-tagged excluded in a known context
        : sigs;                                  // no context → all signals (back-compat)
  const resolved = resolveDimension(pool);
  if (!resolved) return null;
  return { ...resolved, basis: tagged.length ? 'inferred_domain' : 'inferred_global', authored: false };
}

// The (field / field::domain) suppress keys for a layer's INFERRED summary that an
// AUTHORED bound rule already governs. §4.7 makes a bound rule authored-canonical for
// its dimension in the projection, so the summary must not ALSO assert a (possibly
// contradictory) inferred line for that dimension — the authored rule is already injected
// verbatim (context-block.js renderOperatingRules, higher priority than inferred style).
// This routes the decision through resolveEffective: a field whose resolution is authored
// (`authored:true`) has all its rendered-signal keys suppressed. `domain` is optional —
// null at extraction time, where only authored_GLOBAL rules govern; domain-scoped rules
// defer to injection-time rendering, which carries the session domain. Pure.
export function authoredGovernedKeys(signals, rules, domain = null) {
  const out = new Set();
  const list = (Array.isArray(signals) ? signals : []).filter(isObj);
  if (!list.length || !Array.isArray(rules) || !rules.length) return out;
  const byField = new Map();
  for (const s of list) {
    if (typeof s.field !== 'string') continue;
    if (!byField.has(s.field)) byField.set(s.field, []);
    byField.get(s.field).push(s);
  }
  for (const [field, sigs] of byField) {
    const r = resolveEffective({ field, signals: sigs, rules, domain });
    if (r && r.authored) {
      for (const s of sigs) out.add(s.field + (typeof s.domain === 'string' ? `::${s.domain}` : ''));
    }
  }
  return out;
}
