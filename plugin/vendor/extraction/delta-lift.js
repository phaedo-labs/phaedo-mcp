// Phaedo Loop 2 extraction — Path A signal lift (ported from the parallel impl).
//
// Turns the long-running phaedo_behavioral_signals counter map (Path A's
// regex-correction hits, accumulated for months) into §5.1 signals tagged
// source='delta'. Path A produces the bulk of Phaedo's real signal, but the
// projection layer otherwise only sees questionnaire + extraction signals; this
// lift surfaces "things the user actively pushed back on" into the same §4.2
// fingerprint, with provenance that lets the receiving AI weight them highly.
//
// Pure: counters in → signals out. The orchestrator concats these with the
// extraction signals so they reconcile in one merge. Emits CANONICAL layer ids
// (projection.LAYER_ID_MAP maps them to the questionnaire's ids, same as
// extraction signals).
//
// IDEMPOTENCY: a delta signal's observation_count is Path A's CUMULATIVE total,
// not new evidence — so reconcile REPLACES a delta signal on key match rather
// than summing (reconcile.js treats source==='delta' as a snapshot). Re-lifting
// the same counters every pass is therefore a no-op, not inflation.

// Path A signal name → (canonical layer, field, polarity, value). Values match
// the enums/scalars projection renders, so its PHRASING table picks them up.
// Unmapped Path A signals are simply skipped.
export const SIGNAL_MAP = {
  // ── surface ──
  too_long:         { layer: 'surface', field: 'response_length_pref', polarity: 'positive', value: 'short' },
  too_short:        { layer: 'surface', field: 'response_length_pref', polarity: 'positive', value: 'thorough' },
  avoid_bullets:    { layer: 'surface', field: 'formatting_prefs',     polarity: 'negative', value: ['bullets'] },
  prefer_bullets:   { layer: 'surface', field: 'formatting_prefs',     polarity: 'positive', value: ['bullets'] },
  no_headers:       { layer: 'surface', field: 'formatting_prefs',     polarity: 'negative', value: ['headers'] },
  use_headers:      { layer: 'surface', field: 'formatting_prefs',     polarity: 'positive', value: ['headers'] },
  use_table:        { layer: 'surface', field: 'formatting_prefs',     polarity: 'positive', value: ['tables'] },
  use_code_block:   { layer: 'surface', field: 'formatting_prefs',     polarity: 'positive', value: ['code_blocks'] },
  no_examples:      { layer: 'surface', field: 'formatting_prefs',     polarity: 'negative', value: ['inline_examples'] },
  wants_examples:   { layer: 'surface', field: 'formatting_prefs',     polarity: 'positive', value: ['inline_examples'] },
  prefers_casual:   { layer: 'surface', field: 'tone_register',        polarity: 'positive', value: 'casual' },
  prefers_formal:   { layer: 'surface', field: 'tone_register',        polarity: 'positive', value: 'formal' },
  more_direct:      { layer: 'surface', field: 'directness',           polarity: 'positive', value: 0.85 },
  no_preamble:      { layer: 'surface', field: 'directness',           polarity: 'positive', value: 0.85 },
  plainer_language: { layer: 'surface', field: 'jargon_tolerance',     polarity: 'positive', value: 0.15 },

  // ── behavioral ──
  fewer_questions:    { layer: 'behavioral', field: 'autonomy_pref',        polarity: 'positive', value: 0.85 },
  wants_confirmation: { layer: 'behavioral', field: 'autonomy_pref',        polarity: 'positive', value: 0.15 },
  show_reasoning:     { layer: 'behavioral', field: 'reasoning_visibility', polarity: 'positive', value: 'show' },
  skip_reasoning:     { layer: 'behavioral', field: 'reasoning_visibility', polarity: 'positive', value: 'skip' },
  iterate_more:       { layer: 'behavioral', field: 'iteration_style',      polarity: 'positive', value: 'iterative_refine' },

  // ── domain_and_expertise (legacy Path A layer 'domain') ──
  overexplaining:   { layer: 'domain_and_expertise', field: 'expertise_level',   polarity: 'positive', value: 'power' },
  too_technical:    { layer: 'domain_and_expertise', field: 'expertise_level',   polarity: 'positive', value: 'general' },
  wants_depth:      { layer: 'domain_and_expertise', field: 'domain_depth_pref', polarity: 'positive', value: 'full_technical' },
  conceptual_only:  { layer: 'domain_and_expertise', field: 'domain_depth_pref', polarity: 'positive', value: 'surface' },

  // ── temporal_and_context ──
  urgent:           { layer: 'temporal_and_context', field: 'urgency_baseline',   polarity: 'positive', value: 0.85 },
  no_rush:          { layer: 'temporal_and_context', field: 'urgency_baseline',   polarity: 'positive', value: 0.15 },
  exploring_phase:  { layer: 'temporal_and_context', field: 'early_project_mode', polarity: 'positive', value: 'explore_wide' },
  build_mode:       { layer: 'temporal_and_context', field: 'working_mode',       polarity: 'positive', value: 'build_mode' },

  // ── decision_and_risk ──
  wants_decisiveness:     { layer: 'decision_and_risk', field: 'ambiguity_posture',         polarity: 'positive', value: 'default' },
  wants_bold_call:        { layer: 'decision_and_risk', field: 'ambiguity_posture',         polarity: 'positive', value: 'default' },
  fewer_options:          { layer: 'decision_and_risk', field: 'options_vs_recommendation', polarity: 'positive', value: 'single_recommendation' },
  wants_options:          { layer: 'decision_and_risk', field: 'options_vs_recommendation', polarity: 'positive', value: 'option_set' },
  wants_options_decision: { layer: 'decision_and_risk', field: 'options_vs_recommendation', polarity: 'positive', value: 'option_set' },
};

// Confidence as a stepped function of corrective hit count: one hit is
// suggestive (0.4); five is solid (0.75); ten+ is strong (0.85).
export function countConfidence(n) {
  if (!n || n <= 0) return 0;
  if (n >= 10) return 0.85;
  if (n >= 5)  return 0.75;
  if (n >= 3)  return 0.65;
  if (n >= 2)  return 0.55;
  return 0.4;
}

// liftDeltaSignals(behavioralSignals, now?) → mapper-shaped signals tagged
// source='delta'. behavioralSignals is the { layer: { signalName: count } } map
// (phaedo_behavioral_signals); the outer layer key is ignored — SIGNAL_MAP
// determines the canonical layer/field from the signal name. `now` is injected
// for deterministic timestamps. Empty/missing input → [].
export function liftDeltaSignals(behavioralSignals, now) {
  if (!behavioralSignals || typeof behavioralSignals !== 'object') return [];
  const stamp = now || new Date().toISOString();
  const out = [];
  for (const signalCounts of Object.values(behavioralSignals)) {
    if (!signalCounts || typeof signalCounts !== 'object') continue;
    for (const [signalName, count] of Object.entries(signalCounts)) {
      const mapping = SIGNAL_MAP[signalName];
      if (!mapping) continue;
      const confidence = countConfidence(count);
      if (confidence <= 0) continue;
      out.push({
        layer: mapping.layer,
        field: mapping.field,
        polarity: mapping.polarity,
        value: mapping.value,
        confidence,
        source: 'delta',
        observation_count: count,
        session_refs: [],
        last_observed: stamp,
      });
    }
  }
  return out;
}
