// Proposal 0007 §E — delta promotion (the steady-state path).
//
// When the extraction engine's INFERRED Decision & Risk signals show a pattern that
// has recurred enough to be established (evidence_basis observed/corroborated,
// observation_count ≥ floor) and the subject has NOT already turned it into an
// authored rule, propose a `suggested` standing rule into a STAGING queue
// (`phaedo_fingerprint.suggested_rules`). This is the one rule-shaped object the
// producer writes — and it is explicitly a *proposal*: never injected, never
// consulted. Only the subject's endorsement (rule-review.js) turns a suggestion into
// an authored `standing_rules` entry. So the authored-only invariant on standing_rules
// holds: the producer stages, the user authors.
//
// Pure + deterministic, zero-dep — the house style. The review UI lets the subject
// edit the proposed text before endorsing, so `proposed_text` only needs to be a
// reasonable starting sentence.

export const PROMOTION_FLOOR = 3;                       // §4.7 RESOLUTION_FLOOR — same "established" bar
const PROMOTABLE_TIERS = new Set(['observed', 'corroborated']); // never promote a self_reported guess
const DR_LAYER = 'decision_and_risk';

const uuid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : 'sug-' + Math.random().toString(36).slice(2, 10);

const keyOf = (dim, val) => `${dim}::${JSON.stringify(val ?? null)}`;

// (dimension, value) → a first-person candidate. Unknown pairs fall back to a
// generic sentence; the subject edits before endorsing either way.
const TEMPLATES = {
  evidence_threshold: { high: 'I want the main risks covered and the key facts nailed down before I commit.' },
  ambiguity_posture:  { ask: 'When a request is ambiguous, I ask one clarifying question before acting.',
                        default: 'When things are ambiguous I stay decisive and commit rather than hedge.',
                        delay: 'When things are ambiguous I would rather wait than commit prematurely.' },
  speed_vs_quality:   { quality: 'I trade speed for accuracy on work that matters.',
                        accuracy: 'I trade speed for accuracy on work that matters.',
                        speed: 'I favor moving fast and accept rough edges when speed matters.' },
  reversible_vs_irreversible: { more_cautious: "On decisions I can't easily undo, I slow down and seek more input.",
                        consistent_style: 'I bring the same care to a decision whether or not it can be undone.' },
  options_vs_recommendation: { single_recommendation: 'Give me a single clear recommendation, not a menu of options.',
                        option_set: 'I prefer to see a set of options and make the call myself.' },
  // Surface (response/style) — the dimensions auto-overrides surface against.
  response_length_pref: { short: 'Default to concise — keep responses tight.',
                        thorough: 'Default to thorough responses; go deep and cover the edge cases.',
                        medium: 'Default to medium-length responses — neither terse nor exhaustive.' },
  tone_register:       { casual: 'Default to a casual, conversational tone.',
                        formal: 'Default to a formal, professional tone.' },
};
const DIM_LABEL = {
  evidence_threshold: 'how much evidence I need before committing',
  ambiguity_posture: 'how I handle ambiguity',
  speed_vs_quality: 'how I weigh speed against quality',
  reversible_vs_irreversible: 'how I treat irreversible decisions',
  options_vs_recommendation: 'whether I want options or a single call',
  response_length_pref: 'response length',
  tone_register: 'tone',
  directness: 'directness',
  jargon_tolerance: 'jargon level',
  formatting_prefs: 'formatting',
  autonomy_pref: 'how much autonomy I give the assistant',
  reasoning_visibility: 'whether I want the reasoning shown',
};
export function proposeText(dimension, value) {
  const v = Array.isArray(value) ? value[0] : value;
  const byDim = TEMPLATES[dimension];
  if (byDim && v != null && byDim[v]) return byDim[v];
  const label = DIM_LABEL[dimension] || dimension;
  return v != null ? `I have a consistent way I handle ${label} (${v}).` : `I have a consistent way I handle ${label}.`;
}

function endorsedDimensions(fp) {
  const rules = Array.isArray(fp?.standing_rules) ? fp.standing_rules : [];
  return new Set(rules.map((r) => r?.decision?.dimension).filter(Boolean));
}
function stagedKeys(fp) {
  const sug = Array.isArray(fp?.suggested_rules) ? fp.suggested_rules : [];
  return new Set(sug.map((s) => keyOf(s?.decision?.dimension, s?.evidence?.value)));
}

// Inspect a fingerprint's Decision & Risk signals and return suggested-rule
// candidates (does NOT mutate the fingerprint). A candidate is produced for an
// established, not-yet-authored, not-yet-staged/dismissed (dimension,value).
export function detectPromotions(fp, { floor = PROMOTION_FLOOR, now = new Date().toISOString() } = {}) {
  const dr = fp?.layers?.[DR_LAYER];
  const signals = Array.isArray(dr?.signals) ? dr.signals : [];
  const covered = endorsedDimensions(fp);
  const seen = stagedKeys(fp);                // already suggested OR dismissed → skip
  const local = new Set();
  const out = [];
  for (const s of signals) {
    if (!s || typeof s !== 'object') continue;
    const dim = s.dimension || s.field;
    if (!dim) continue;
    if (!PROMOTABLE_TIERS.has(s.evidence_basis)) continue;
    if ((s.observation_count || 0) < floor) continue;
    if (covered.has(dim)) continue;            // already an authored rule on this dimension
    const k = keyOf(dim, s.value);
    if (seen.has(k) || local.has(k)) continue;
    local.add(k);
    out.push({
      suggestion_id: uuid(),
      status: 'suggested',
      source: 'delta_promotion',
      proposed_text: proposeText(dim, s.value),
      decision: { dimension: dim, polarity: s.polarity === 'negative' ? 'negative' : 'positive', ...(s.domain ? { domain: s.domain } : {}) },
      evidence: {
        observation_count: s.observation_count || 0,
        last_observed: s.last_observed || null,
        evidence_basis: s.evidence_basis,
        value: s.value,
        ...(s.signal_id ? { signal_id: s.signal_id } : {}),
      },
      created: now,
    });
  }
  return out;
}

// Merge new suggestions into the staging queue (dedup by dimension+value). Writes
// ONLY suggested_rules — never standing_rules. Returns a new fingerprint.
export function stageSuggestions(fp, suggestions) {
  if (!Array.isArray(suggestions) || !suggestions.length) return fp;
  const existing = Array.isArray(fp?.suggested_rules) ? fp.suggested_rules : [];
  const seen = stagedKeys(fp);
  const add = suggestions.filter((s) => {
    const k = keyOf(s?.decision?.dimension, s?.evidence?.value);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!add.length) return fp;
  return { ...fp, suggested_rules: [...existing, ...add] };
}

// Producer convenience: detect + stage in one pass.
export function promoteRules(fp, opts) {
  return stageSuggestions(fp, detectPromotions(fp, opts));
}
