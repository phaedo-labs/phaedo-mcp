// Phaedo Loop 2 extraction — fingerprint-update builder (signals → §4.2 layer docs).
//
// NOTE: distinct from the INJECTION projection (context-block.js renderContextBlock
// / mcp/projection.js), which renders the user-facing profile block. THIS step turns
// the mapper's flat signal list into the persistent fingerprint's §4.2 layer
// documents. (Renamed from extraction/projection.js to disambiguate "projection".)
//
// The extraction model emits signals[] + confidence ONLY; the human-readable
// `summary` is rendered downstream by this deterministic step (task-spec §4.2). It
// takes the flat signal list from the mapper and produces a partial fingerprint
// update: one protocol §4.2 layer document per layer that has signal —
//   { layer_version, last_updated, confidence, signals[], summary }
// where each signal is enriched to the full §5.1 object.
//
// No raw transcript text ever enters a layer doc — only derived structured
// values + provenance counts (§7 privacy constraint).

import { CATALOG } from './catalog.js';
import { resolveDimension, valKey } from './resolve.js';   // §4.7 deterministic resolution (Proposal 0006)

const LAYER_VERSION = '0.1';

// The §4.7 canonical layer-key rename has landed (migration.js canonicalizes on
// vault read; Path A + the questionnaire schema now use canonical ids), so
// extraction's canonical layer ids match the stored fingerprint directly — no
// down-mapping needed.

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Readable field labels for the rendered summary. Missing fields fall back to a
// humanized version of the field id.
const FIELD_LABELS = {
  response_length_pref: 'Response length', tone_register: 'Tone',
  formatting_prefs: 'Formatting', jargon_tolerance: 'Jargon', directness: 'Directness',
  pet_peeves: 'Pet peeves', iteration_style: 'Iteration', ambiguity_response: 'On ambiguity',
  detail_vs_principle: 'Detail vs principle', autonomy_pref: 'Autonomy',
  reasoning_visibility: 'Reasoning', scope_discipline: 'Scope', quality_word: 'Values quality',
  problem_solving_move: 'Problem-solving', mental_model_inventory: 'Mental models',
  primary_expertise: 'Expertise', domain_depth_pref: 'Depth', active_learning_areas: 'Learning',
  domain_vocabulary: 'Vocabulary', expertise_level: 'Level', early_project_mode: 'Early-project mode',
  urgency_baseline: 'Urgency', working_mode: 'Working mode', feedback_pref: 'Feedback',
  disagreement_style: 'Disagreement', audience_adaptation: 'Audience',
  options_vs_recommendation: 'Options vs recommendation', ambiguity_posture: 'Decisiveness',
  speed_vs_quality: 'Speed vs quality', evidence_threshold: 'Evidence bar',
  stable_principles: 'Principles', process_narration_pref: 'Process narration',
};

// Allowed enum values per field, derived from the catalog (the same source of
// truth the mapper resolves values against). Only fields that resolve to a fixed
// value set appear here; scalar and free-text fields (no `.values`) admit
// anything. Used to keep opaque/garbage values — e.g. a model emitting "s2_d"
// for tone_register — OUT of the rendered summary. The signal is retained in
// signals[] for provenance; it is simply never surfaced in the injected
// projection. Ingestion-time enum validation is the stricter v0.2 fix (schema
// tightening); this is the projection-layer guard.
const ALLOWED_VALUES = (() => {
  const m = {};
  for (const entry of CATALOG) {
    if (entry && entry.values && typeof entry.values === 'object')
      m[entry.field] = new Set(Object.keys(entry.values));
  }
  return m;
})();

// A value conforms if the field has no fixed set (scalar/free-text), or every
// token is in the set. Array fields are checked token-by-token.
function valueConforms(field, value) {
  const allowed = ALLOWED_VALUES[field];
  if (!allowed) return true;
  const tokens = Array.isArray(value) ? value : [value];
  return tokens.length > 0 && tokens.every(v => allowed.has(v));
}

// Drop non-conforming members from an enum array value; scalars/free-text pass
// through untouched (their conformance is decided by valueConforms).
function sanitizeValue(field, value) {
  const allowed = ALLOWED_VALUES[field];
  if (!allowed || !Array.isArray(value)) return value;
  return value.filter(v => allowed.has(v));
}

// §4.6 layer admission: behavioral layers carry persona patterns, never episodic
// content. Drop a signal whose value reads as an episodic fact (URL / email /
// domain — e.g. an extracted "principle" of "values getphaedo.com"). High-
// precision markers only. MUST match the conformance check EPISODIC_RE in
// spec/validate-fingerprint.mjs.
const EPISODIC_RE = /(https?:\/\/|\bwww\.)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b[a-z0-9][a-z0-9-]*\.(com|org|net|io|so|co|ai|app|xyz|info)\b/i;
function isEpisodic(value) {
  const text = Array.isArray(value) ? value.join(' ') : (value == null ? '' : String(value));
  return EPISODIC_RE.test(text);
}

function humanizeValue(value) {
  if (Array.isArray(value)) return value.map(humanizeValue).join(', ');
  if (typeof value === 'number') {
    if (value >= 0.7) return 'high';
    if (value <= 0.3) return 'low';
    return 'medium';
  }
  return String(value).replace(/_/g, ' ');
}

// One readable line per signal for the layer summary.
export function describeSignal(sig) {
  const label = FIELD_LABELS[sig.field] || sig.field.replace(/_/g, ' ');
  const val = humanizeValue(sig.value);
  return sig.polarity === 'negative' ? `${label}: avoids ${val}` : `${label}: ${val}`;
}

// Enrich a mapper signal to the full §5.1 object. sessionId/now provide
// provenance (session_refs, last_observed); raw text (`_from`/`_sim`) is dropped
// so no transcript leaks into the stored signal.
// Evidence basis of a signal, derived from its `source` (proposal 0002 vocabulary):
// how the signal was learned. Lets a consumer (e.g. the consultation resolver) weigh
// observed/corroborated signals above self-reported ones without re-deriving it.
function evidenceBasis(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('corrobor') || s.includes('reconcil')) return 'corroborated';
  if (s.includes('question') || s.includes('self') || s.includes('interview')) return 'self_reported';
  return 'observed'; // extraction/delta-sourced
}

function toSignalObject(sig, sessionId, now) {
  const source = sig.source || 'extraction';
  return {
    signal_id: uuid(),
    field: sig.field,
    dimension: sig.field,                  // proposal 0002: the decision/style axis (== field)
    // §4.2.7 optional domain (PROTOTYPE: set by extraction/domain-inference.js for
    // Decision & Risk signals when a session's domain is unambiguous; else absent).
    ...(typeof sig.domain === 'string' ? { domain: sig.domain } : {}),
    polarity: sig.polarity,
    value: sig.value,
    confidence: sig.confidence ?? 0.6,
    source,
    evidence_basis: evidenceBasis(source), // proposal 0002: observed | corroborated | self_reported
    observation_count: sig.observation_count ?? 1,
    // Preserve provenance the producer set (delta signals carry [] + their own
    // timestamp); fall back to this pass's session/time for extraction signals.
    session_refs: sig.session_refs ?? (sessionId ? [sessionId] : []),
    last_observed: sig.last_observed ?? now,
  };
}

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

// Group mapper signals by layer into a partial fingerprint update.
//   signals — flat array from mapObservations / mapObservationsEmbed
//   opts.sessionId — session id for provenance (session_refs)
//   opts.now — RFC 3339 timestamp (injected so the fn is pure/testable)
// Returns { [layerId]: { layer_version, last_updated, confidence, signals, summary } }.
export function buildFingerprintUpdate(signals, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const byLayer = {};
  for (const sig of signals) {
    (byLayer[sig.layer] ??= []).push(toSignalObject(sig, opts.sessionId, now));
  }
  const update = {};
  for (const [layerId, layerSignals] of Object.entries(byLayer)) {
    update[layerId] = {
      layer_version: LAYER_VERSION,
      last_updated: now,
      confidence: Number(mean(layerSignals.map(s => s.confidence)).toFixed(3)),
      signals: layerSignals,
      summary: renderLayerSummary(layerSignals),
    };
  }
  return update;
}

// Render a layer's signals into a short readable summary block.
//
// Four projection-quality guards (none mutate signals[] — provenance is kept):
//   1. Opaque-value drop — a signal whose enum value is not in the catalog's
//      value set for its field is skipped (e.g. a model emitting "s2_d" for
//      tone_register). Array values keep only their conforming members.
//   2. Same-dimension resolution — collapse to one line per (field, polarity,
//      domain) using the §4.7 / Proposal 0006 resolver (resolveDimension):
//      evidence-tier precedence → observation-count → recency — the SAME
//      deterministic rule every consumer applies, not raw confidence. So a
//      contradiction that survives upstream merge resolves to the authoritative
//      value, identically across implementations.
//   3. Unresolved-drop — when the resolver returns status:"unresolved" (a thin
//      inferred value contradicting a self-report, below the evidence floor) we
//      DON'T assert it: an injected summary stating a confident-but-contradicted
//      value is exactly the autonomy-class defect 0006 fixes. Omit the line.
//   4. Duplicate-line drop — an untagged and a domain-tagged signal that
//      humanize to the same text must not appear twice.
export function renderLayerSummary(signals, suppress) {
  const sup = suppress instanceof Set ? suppress : null;
  const groups = new Map();
  for (const s of signals || []) {
    // §4.7 injection-suppression: a dimension with an OPEN conflict (a contested
    // observed-vs-self-report value, below the evidence floor) is WITHHELD from the
    // projection until the subject settles it — the popup conflict dot gates what the
    // AI sees, rather than asserting a value we are not yet confident in.
    if (sup && sup.has(s.field + (typeof s.domain === 'string' ? `::${s.domain}` : ''))) continue;
    const value = sanitizeValue(s.field, s.value);           // array fields: strip bad members
    if (!valueConforms(s.field, value)) continue;            // (1) drop opaque/garbage (or now-empty array)
    if (isEpisodic(value)) continue;                         // §4.6: drop episodic content (URL/email/domain)
    const key = `${s.field}::${s.polarity}${typeof s.domain === 'string' ? `::${s.domain}` : ''}`;
    if (!groups.has(key)) groups.set(key, []);               // group the dimension; resolve below
    groups.get(key).push({ ...s, value });
  }
  const seen = new Set();
  const lines = [];
  for (const sigs of groups.values()) {
    const r = resolveDimension(sigs);                        // (2) §4.7 deterministic winner
    if (!r || r.status === 'unresolved') continue;           // (3) don't assert a contested value
    const winner = sigs.find(s => valKey(s.value) === valKey(r.value)) || sigs[0];
    const line = `- ${describeSignal(winner)}`;
    if (seen.has(line)) continue;                            // (4) dedupe identical display lines
    seen.add(line);
    lines.push(line);
  }
  return lines.join('\n');
}

export { uuid, LAYER_VERSION, FIELD_LABELS };
