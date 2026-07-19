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
