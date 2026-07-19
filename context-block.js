// ─── Phaedo Context Block ─────────────────────────────────────────────────────
//
// The single source of truth for the injected <phaedo_user_profile> block.
// Lifted out of content.js (Fork A, validation-harness Phase 1) so the exact
// same renderer is shared by:
//   - content.js  — builds the block and injects it into AI sessions
//   - harness.js  — shows the user "what the AI sees" (must be byte-identical)
//
// Classic script (no ES modules — loaded via manifest content_scripts before
// content.js, and via <script src> on harness.html). Exposes one namespace,
// `globalThis.PhaedoContext`, matching the `globalThis.Phaedo` / `window.phaedo*`
// convention used elsewhere. These functions are pure (no DOM/storage/window):
// `renderContextBlock(vaultData)` returns the exact injected string.

(function () {

// ─── Signal labels (human-readable, injected into context block) ─────────────

const SIGNAL_LABELS = {
  // Surface
  too_long:                 'responses have been too long — prefers concise',
  too_short:                'responses have been too short — prefers more detail',
  avoid_bullets:            'prefers prose over bullet points',
  prefer_bullets:           'prefers bullet-point formatting',
  no_headers:               'prefers no section headers',
  use_headers:              'prefers section headers for organization',
  use_table:                'prefers tabular format when comparing',
  use_code_block:           'prefers code wrapped in code blocks',
  prefers_casual:           'prefers casual, conversational tone',
  prefers_formal:           'prefers formal, professional tone',
  more_direct:              'prefers direct, bottom-line-first communication',
  no_preamble:              'prefers no intro or preamble — dive straight in',
  no_examples:              'prefers no illustrative examples',
  wants_examples:           'prefers concrete examples to illustrate concepts',
  plainer_language:         'prefers plain language over jargon',
  // Behavioral
  fewer_questions:          'prefers AI to act without asking for confirmation',
  wants_confirmation:       'prefers AI to check before acting',
  show_reasoning:           'prefers AI to show its reasoning and approach',
  skip_reasoning:           'prefers just the answer without explanation',
  fewer_options:            'prefers a single recommendation over multiple options',
  wants_options:            'prefers to see options and choose',
  wants_proactive:          'prefers proactive suggestions beyond the question asked',
  stay_scoped:              'prefers AI to answer exactly what was asked, nothing more',
  iterate_more:             'prefers iterative refinement over single-shot answers',
  // Domain
  overexplaining:           'AI over-explained — user knows more than assumed',
  too_technical:            'explanations were too technical for the context',
  wants_depth:              'wants deeper technical detail and implementation specifics',
  wants_sources:            'prefers cited sources and references',
  conceptual_only:          'wants conceptual understanding, not implementation',
  wants_implementation:     'wants concrete code and implementation steps',
  too_broad:                'responses have been too broad — prefers focused scope',
  // Temporal
  urgent:                   'frequently time-constrained — prefers brevity',
  no_rush:                  'prefers thoroughness over speed',
  exploring_phase:          'often in exploratory mode — prefers high-level',
  build_mode:               'often in build mode — prefers concrete and specific',
  big_picture:              'prefers to start with strategy before details',
  detail_mode:              'prefers to get into granular details',
  // Collaboration
  non_technical_audience:   'often writing for non-technical audiences',
  technical_audience:       'often writing for technical audiences',
  match_voice:              'wants AI to match their personal voice and style',
  external_audience:        'often producing external or client-facing content',
  too_jargony_for_audience: 'AI used jargon that was too complex for their audience',
  // Decision
  wants_decisiveness:       'prefers direct recommendations over hedged options',
  wants_options_decision:   'prefers to see choices rather than a single recommendation',
  wants_nuance:             'prefers responses that surface tradeoffs and risks',
  wants_bold_call:          'prefers bold, definitive recommendations',
  wants_conservative:       'prefers conservative, low-risk recommendations',
  needs_certainty:          'prefers definitive answers over probabilistic ones',
  rough_estimate_ok:        'comfortable with approximate answers and estimates',
  // Creative
  wants_creative:           'prefers unexpected, creative approaches',
  wants_elegance:           'prefers elegant, simple solutions over complex ones',
  wants_conventional:       'prefers conventional, straightforward approaches',
  wants_originality:        'explicitly wants non-obvious angles',
  // Meta
  skip_meta:                'prefers AI not to narrate its own process',
  show_meta:                'prefers AI to think out loud and show its approach',
  wants_transparency:       'prefers AI to surface assumptions and reasoning',
  less_second_guessing:     'prefers confident, committed responses',
};

// ─── Synthesis: derive cognitive dimensions from accumulated data ─────────────

function synthesizeCognitiveProfile(lp, sm) {
  if (!lp || (lp.messageCount || 0) < 8) return null;

  const n       = lp.messageCount;
  const profile = {};

  // Communication stance: directive vs collaborative
  // Pennebaker: high imperative + low collaborative = directive
  if (n >= 10) {
    const directiveScore = (lp.imperativeRate || 0) - (lp.collaborativeRate || 0) * 2;
    if (directiveScore > 0.12)
      profile.communicationStance = 'Directive — frames requests as clear tasks, prefers the AI to execute without dialogue';
    else if (directiveScore < -0.04)
      profile.communicationStance = 'Collaborative — thinks through problems in dialogue, values the exchange not just the output';
    else
      profile.communicationStance = 'Adaptive — shifts between directing and collaborating depending on task type';
  }

  // Processing style: analytical vs exploratory (Kahneman System 2 vs System 1 proxy)
  // High causal reasoning + high certainty = analytical; high hedging + high questions = exploratory
  if (n >= 12) {
    const analyticalScore  = (lp.causalRate || 0) * 3 + (lp.certaintyRate || 0);
    const exploratoryScore = (lp.hedgeRate  || 0) * 2 + Math.min((lp.avgQuestionCount || 0) / 4, 0.3);
    if (analyticalScore > exploratoryScore * 1.4)
      profile.processingStyle = 'Analytical — reasons causally, seeks mechanism and explanation before accepting output';
    else if (exploratoryScore > analyticalScore * 1.4)
      profile.processingStyle = 'Exploratory — thinks in questions, comfortable with open threads, iterates toward clarity';
    else
      profile.processingStyle = 'Pragmatic — shifts between analytical rigor and intuitive exploration based on stakes';
  }

  // Abstraction level: principles vs implementation (Construal Level Theory)
  // Dominant question type: why = abstract, how = concrete, what-if = strategic
  const qt = lp.questionTypes || {};
  const qtTotal = (qt.what || 0) + (qt.how || 0) + (qt.why || 0) + (qt.whatIf || 0);
  if (qtTotal >= 6) {
    const whyRatio   = (qt.why    || 0) / qtTotal;
    const howRatio   = (qt.how    || 0) / qtTotal;
    const whatIfRatio = (qt.whatIf || 0) / qtTotal;
    if (whyRatio > 0.35)
      profile.abstractionLevel = 'Principles-first — asks why before how; needs conceptual understanding before implementation';
    else if (howRatio > 0.45)
      profile.abstractionLevel = 'Implementation-first — focused on mechanics and execution; concepts are a means to an end';
    else if (whatIfRatio > 0.25)
      profile.abstractionLevel = 'Strategic — thinks in scenarios and possibilities; naturally operates at the system level';
    else
      profile.abstractionLevel = 'Fluid — moves comfortably between conceptual and implementation levels';
  }

  // Depth preference: from message length
  // Short messages (< 18 words avg) = compressed communicator; long (> 55) = context-provider
  if (n >= 10) {
    const wc = lp.avgWordCount || 0;
    if (wc > 55)
      profile.depthPreference = 'Context-provider — writes long, richly contextualised messages; processes detailed responses well';
    else if (wc < 18)
      profile.depthPreference = 'Compressed — communicates in terse, high-density messages; prefers responses that match';
    else
      profile.depthPreference = 'Calibrated — message length tracks task complexity; adapts naturally';
  }

  // Self-reference ratio → perspective frame (Pennebaker I-word research)
  // High self-ref = personal/individual framing; low = systems/external framing
  if (n >= 15) {
    const sr = lp.selfReferenceRatio ?? 0.5;
    if (sr > 0.72)
      profile.perspectiveFrame = 'Personal frame — thinks and communicates in first-person terms; I-centric problem framing';
    else if (sr < 0.35)
      profile.perspectiveFrame = 'Systems frame — thinks in external terms and structures; we/it-centric problem framing';
    else
      profile.perspectiveFrame = 'Mixed frame — shifts between personal ownership and systemic thinking';
  }

  // Certainty tolerance: hedge rate vs number density (precision orientation)
  if (n >= 15) {
    const hedge  = lp.hedgeRate    || 0;
    const number = lp.numberDensity || 0;
    if (hedge < 0.04 && number > 0.025)
      profile.certaintyTolerance = 'Precision-oriented — low hedging, quantitative framing; prefers definitive answers over probabilistic ones';
    else if (hedge > 0.14)
      profile.certaintyTolerance = 'Ambiguity-tolerant — comfortable with estimates and nuance; suspicious of false certainty';
    else
      profile.certaintyTolerance = 'Context-dependent — precise when stakes are high, approximate when speed matters';
  }

  // Vocabulary sophistication: avg word length proxy for expertise signal
  // (Mairesse et al.: longer avg word = higher Openness, often correlates with expertise)
  if (n >= 12) {
    const awl = lp.avgWordLength || 0;
    if (awl > 5.4)
      profile.vocabularySophistication = 'High — uses long, precise, domain-specific vocabulary; calibrate explanations accordingly';
    else if (awl < 4.2)
      profile.vocabularySophistication = 'Accessible — favours common, direct words; prefers plain explanations';
    else
      profile.vocabularySophistication = 'Mixed — vocabulary varies with context and domain';
  }

  // Working pattern: from session metrics (only if enough sessions)
  if (sm && (sm.sessionCount || 0) >= 3) {
    const avgMsgs = sm.avgMessagesPerSession || 0;
    const avgDur  = sm.avgSessionDuration   || 0;
    const corrRate = sm.avgCorrectionRate   || 0;
    if (avgMsgs > 10 || avgDur > 720000)
      profile.workingPattern = 'Deep-collaborator — long sessions, high message density; works problems through with the AI';
    else if (avgMsgs < 4 && avgDur < 180000)
      profile.workingPattern = 'Quick-lookup — short, targeted sessions; extracts specific information efficiently';
    else if (corrRate > 0.2)
      profile.workingPattern = 'Iterative-refiner — moderate sessions, frequent corrections; reaches quality through revision';
    else
      profile.workingPattern = 'Task-driven — sessions organized around discrete outcomes; moves on when done';

    // Satisfaction signal: high positive rate = fingerprint is working
    const posRate = sm.avgPositiveRate || 0;
    if (posRate > 0.15)
      profile.satisfactionSignal = 'Frequently confirms when output lands correctly — positive feedback rate is high';
    else if ((sm.avgCorrectionRate || 0) > 0.25)
      profile.satisfactionSignal = 'Frequent corrections — fingerprint should be weighted heavily to close the gap';
  }

  // Dominant question type as cognitive orientation
  if (qtTotal >= 8) {
    const dominant = Object.entries(qt).sort((a, b) => b[1] - a[1])[0];
    const orientations = {
      what:   'Knowledge-seeker — asks what-questions; builds mental models through facts and definitions',
      how:    'Process-thinker — asks how-questions; learns through mechanisms and procedural understanding',
      why:    'Causal-reasoner — asks why-questions; needs the reasoning chain before accepting conclusions',
      whatIf: 'Scenario-planner — asks what-if questions; thinks in contingencies and strategic possibilities',
    };
    if (orientations[dominant[0]])
      profile.questioningOrientation = orientations[dominant[0]];
  }

  return Object.keys(profile).length > 0 ? profile : null;
}

// Turn accumulated mental-model markers into a named-framework inventory.
// Returns one descriptive string for the context block, or null when there is
// not yet enough signal. Gated on message volume: a single message's markers
// are coarse — the reliability is in aggregation across the user's history.
function synthesizeMentalModels(lp) {
  const markers = lp && lp.mentalModelMarkers;
  const n       = (lp && lp.messageCount) || 0;
  if (!markers || n < 20) return null;

  const FRAMEWORK_LABELS = {
    first_principles:      'first-principles reasoning',
    systems_thinking:      'systems thinking',
    theory_of_constraints: 'constraint and bottleneck framing',
    second_order_effects:  'second-order thinking',
    tradeoff_reasoning:    'explicit trade-off analysis',
    analogical_reasoning:  'reasoning by analogy',
    decomposition:         'problem decomposition',
    scenario_planning:     'scenario and contingency planning',
  };

  // Rank frameworks by occurrence; require a floor of 3 hits so one stray
  // match does not surface a framework. Top 3 become the inventory.
  const ranked = Object.entries(markers)
    .filter(([fw, count]) => FRAMEWORK_LABELS[fw] && count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  if (!ranked.length) return null;

  const phrased = ranked.map(([fw, count]) => {
    const rate     = count / n;
    const strength = rate >= 0.10 ? 'strongly' : rate >= 0.04 ? 'consistently' : 'occasionally';
    return `${FRAMEWORK_LABELS[fw]} (${strength})`;
  });

  return `Reaches for: ${phrased.join(', ')} — frame analysis and recommendations through these lenses.`;
}

// ─── Profile synthesis helpers ────────────────────────────────────────────────

function scoreAnswerQuality(text) {
  const t = (text || '').trim();
  if (!t) return 'empty';
  const words = (t.match(/\b[a-z']+\b/gi) || []).length;
  if (words < 5) return 'sparse';
  const hasPersonal = /\bI (\w+ed|was|had|found|learned|realized|struggled|built|chose|spent|tried)\b/i.test(t);
  const hasSpecific = /\b\d+\b|\bfor example\b|\bhowever\b|\bbut\b|\bI think\b|\bI believe\b/i.test(t);
  const hasInsight  = /\b(learned that|in hindsight|looking back|I now|what changed|I realized)\b/i.test(t);
  const signals = (hasPersonal ? 1 : 0) + (hasSpecific ? 1 : 0) + (hasInsight ? 1 : 0);
  if (words >= 40 && signals >= 2) return 'rich';
  if (words >= 15 && signals >= 1) return 'moderate';
  return 'sparse';
}

function detectTechnicalProfile(fingerprint) {
  const allText = Object.values(fingerprint.layers || {})
    .flatMap(l => l.responses || [])
    .map(r => r.answer || '')
    .join(' ');
  const TECH_RE = /\b(javascript|typescript|python|react|node\.?js|sql|postgres|mysql|mongodb|docker|kubernetes|aws|gcp|azure|git|graphql|rest|api|golang|rust|swift|kotlin|java|ruby|rails|django|vue|angular|next\.?js|terraform|webpack|vite|linux|bash|html|css|frontend|backend|fullstack|devops|microservices|serverless|machine learning|llm|algorithm|data structure)\b/gi;
  const matches = allText.match(TECH_RE) || [];
  const unique  = new Set(matches.map(m => m.toLowerCase())).size;
  const techs   = [...new Set(matches.map(m => m.toLowerCase()))].slice(0, 10);
  return { level: unique >= 5 ? 'power' : unique >= 2 ? 'technical' : 'general', techs };
}

function extractValueSignals(fingerprint) {
  let hasValues = false, valueCount = 0, futureOriented = false, growthMinded = false;
  for (const layer of Object.values(fingerprint.layers || {})) {
    for (const { answer } of layer.responses || []) {
      const t = (answer || '').trim();
      if (!t) continue;
      if (/\b(what matters (most )?(to me|for me)|I believe in|at my core|my (core )?(principle|value|belief)|I care (deeply|strongly )?(about|for)|what I (value|stand for)|fundamentally I|it('s| is) important to me|I('m| am) committed to)\b/i.test(t)) {
        hasValues = true; valueCount++;
      }
      if (/\bI (want|hope|plan|aim|aspire) to\b|\bmy (goal|aim|ambition) is\b|\bI('m| am) working toward\b|\bI see myself\b/i.test(t))
        futureOriented = true;
      if (/\bI (struggled|failed|was wrong|made a mistake)\b|\b(in hindsight|looking back|the hardest part for me|where I went wrong)\b/i.test(t))
        growthMinded = true;
    }
  }
  return { hasValues, valueCount, futureOriented, growthMinded };
}

function buildLayerConfidence(fingerprint) {
  return Object.values(fingerprint.layers || {}).map(layer => {
    // A layer may be signals-only (extraction-built, no questionnaire responses).
    const responses = Array.isArray(layer.responses) ? layer.responses : [];
    const total    = responses.length;
    const answered = responses.filter(r => r && typeof r.answer === 'string' && r.answer.trim());
    const qualities = answered.map(r => scoreAnswerQuality(r.answer));
    const rich     = qualities.filter(q => q === 'rich').length;
    const moderate = qualities.filter(q => q === 'moderate').length;
    let quality;
    if (answered.length === 0)                            quality = 'empty';
    else if (rich >= answered.length * 0.5)               quality = 'rich';
    else if ((rich + moderate) >= answered.length * 0.4)  quality = 'moderate';
    else                                                   quality = 'sparse';
    return { label: layer.label, answered: answered.length, total, quality };
  });
}

// Mutually-exclusive behavioral signal pairs. When both fire, injecting both
// produces a self-contradicting instruction (e.g. "Act without checking" AND
// "Confirm before acting" under Autonomy). Resolve to the dominant side by
// observation count; on an exact tie neither is a reliable directive, so drop
// both rather than inject a contradiction.
const OPPOSING_SIGNALS = [
  ['fewer_questions', 'wants_confirmation'],
  ['fewer_options', 'wants_options'],
  ['prefers_casual', 'prefers_formal'],
  ['avoid_bullets', 'prefer_bullets'],
  ['no_headers', 'use_headers'],
  ['skip_reasoning', 'show_reasoning'],
  ['conceptual_only', 'wants_implementation'],
  ['too_long', 'too_short'],
  ['no_examples', 'wants_examples'],
  ['stay_scoped', 'wants_proactive'],
  ['skip_meta', 'show_meta'],
];

function resolveOpposingSignals(flat) {
  const out = { ...flat };
  for (const [a, b] of OPPOSING_SIGNALS) {
    const av = out[a] || 0, bv = out[b] || 0;
    if (av > 0 && bv > 0) {
      if (av > bv)      delete out[b];
      else if (bv > av) delete out[a];
      else { delete out[a]; delete out[b]; }   // tie → omit both
    }
  }
  return out;
}

function synthesizeResponseInstructions(behavioralSignals, cognitiveProfile) {
  const raw = {};
  for (const layer of Object.values(behavioralSignals))
    for (const [k, v] of Object.entries(layer)) raw[k] = (raw[k] || 0) + v;
  const flat = resolveOpposingSignals(raw);

  const inst = { format: [], tone: [], depth: [], autonomy: [], decisions: [], pace: [] };

  // Format
  if (flat.too_long     >= 2) inst.format.push(`Concise — corrected for length ${flat.too_long}×; keep tight`);
  if (flat.too_short    >= 2) inst.format.push(`Expansive — asked for more detail ${flat.too_short}×`);
  if (flat.prefer_bullets)    inst.format.push('Bullet points preferred for multi-part answers');
  if (flat.avoid_bullets)     inst.format.push('Prose preferred — user pushes back on bullets');
  if (flat.use_headers)       inst.format.push('Section headers preferred for long-form responses');
  if (flat.no_headers)        inst.format.push('No section headers');
  if (flat.use_table)         inst.format.push('Tables preferred for comparisons');
  if (flat.use_code_block)    inst.format.push('Always wrap code in code blocks');
  if (flat.more_direct)       inst.format.push(`Bottom-line-first — corrected for roundaboutness ${flat.more_direct}×`);
  if (flat.no_preamble)       inst.format.push('No intro or preamble — dive straight in');
  if (!inst.format.length) {
    if (cognitiveProfile?.depthPreference?.startsWith('Compressed'))
      inst.format.push('Compressed communicator — keep responses tight and high-density');
    else if (cognitiveProfile?.depthPreference?.startsWith('Context-provider'))
      inst.format.push('Context-provider — can handle thorough, detailed responses');
  }

  // Tone
  if (flat.prefers_casual)   inst.tone.push('Casual, conversational register');
  if (flat.prefers_formal)   inst.tone.push('Formal, professional register');
  if (flat.plainer_language) inst.tone.push('Plain language — minimize jargon');
  if (flat.wants_examples)   inst.tone.push(`Include concrete examples (explicitly requested ${flat.wants_examples}×)`);
  if (flat.no_examples)      inst.tone.push('Skip illustrative examples');
  if (flat.match_voice)      inst.tone.push('Match this user\'s voice and style when writing on their behalf');
  if (flat.non_technical_audience) inst.tone.push('Often writing for non-technical audiences — adjust register accordingly');
  if (flat.technical_audience)     inst.tone.push('Often writing for technical audiences');

  // Depth
  if (flat.skip_reasoning)        inst.depth.push(`Lead with the answer — reasoning has been skipped ${flat.skip_reasoning}×`);
  if (flat.show_reasoning)        inst.depth.push('Show your reasoning — user follows and values the logic chain');
  if (flat.wants_depth)           inst.depth.push(`Technical depth requested ${flat.wants_depth}× — go deep`);
  if (flat.overexplaining)        inst.depth.push('Skip fundamentals — user already knows them');
  if (flat.too_technical)         inst.depth.push('Simplify — was too technical for the context');
  if (flat.conceptual_only)       inst.depth.push('Stay conceptual — skip implementation detail');
  if (flat.wants_implementation)  inst.depth.push('Provide concrete code and implementation steps');
  if (flat.wants_sources)         inst.depth.push('Cite sources and references');

  // Autonomy
  if (flat.fewer_questions)    inst.autonomy.push(`Act without checking — flagged over-confirmation ${flat.fewer_questions}×`);
  if (flat.wants_confirmation) inst.autonomy.push('Confirm before acting — user prefers to verify assumptions');
  if (flat.stay_scoped)        inst.autonomy.push(`Answer exactly what was asked, nothing more (corrected ${flat.stay_scoped}×)`);
  if (flat.wants_proactive)    inst.autonomy.push('Proactively surface related considerations');
  if (flat.iterate_more)       inst.autonomy.push('Iterative mode — expect refinement, not single-shot completion');
  if (flat.fewer_options)      inst.autonomy.push('Single recommendation — user dislikes option overload');
  if (flat.wants_options)      inst.autonomy.push('Present options — user wants to choose');
  if (flat.skip_meta)          inst.autonomy.push("Don't narrate your process — just do it");
  if (flat.show_meta)          inst.autonomy.push('Think out loud — show your approach before executing');
  if (flat.wants_transparency) inst.autonomy.push('Surface assumptions and rationale explicitly');

  // Decisions
  if (flat.wants_decisiveness || flat.wants_bold_call || flat.less_second_guessing)
    inst.decisions.push('Be definitive — user has pushed back on hedging; commit to recommendations');
  if (flat.wants_nuance)        inst.decisions.push('Surface tradeoffs and risks — user wants the full picture');
  if (flat.wants_conservative)  inst.decisions.push('Conservative options preferred');
  if (flat.needs_certainty)     inst.decisions.push('Definitive answers over probabilistic ones');
  if (flat.rough_estimate_ok)   inst.decisions.push('Approximations are acceptable');
  if (flat.wants_creative)      inst.decisions.push('Unexpected, creative approaches welcome');
  if (flat.wants_elegance)      inst.decisions.push('Elegant, simple solutions over complex ones');
  if (flat.wants_conventional)  inst.decisions.push('Conventional, proven approaches preferred');

  // Pace
  if (flat.urgent >= 2)    inst.pace.push(`Often time-constrained (flagged ${flat.urgent}×) — lead with essentials`);
  if (flat.no_rush)        inst.pace.push('Thoroughness over speed — complete answers preferred');
  if (flat.big_picture)    inst.pace.push('Strategy before detail — start at the macro level');
  if (flat.detail_mode)    inst.pace.push('Detail mode — user wants granular, specific output');
  if (flat.too_broad)      inst.pace.push(`Too broad — narrow scope and focus (corrected ${flat.too_broad}×)`);

  return inst;
}

// ─── Operating rules (Proposal 0007: authored standing_rules → §9 injection) ──
// Authored, user-confirmed rules render VERBATIM (§5.2 — never summarized) at the
// TOP of the profile, above inferred style, so a confirmed rule wins when it
// conflicts with an inferred habit (§4.3 conflict-priority). Sources every
// `standing_rules` entry carrying `text` (a kind:"instruction", or a
// kind:"authorization" that also chose to surface its rule). Ordered by §5.2
// `priority` (lower first), capped so rules never crowd out the rest of the persona.
// Raised 8 → 16 once free-form authoring shipped: a subject with the interview's
// decision rules (priorities 10–40) plus a few hand-authored rules exceeds 8, and
// the highest-priority-number (newest hand-authored) rule was being silently
// dropped from the injected block even though the vault + popup kept it.
const OPERATING_RULES_BUDGET = 16;
// A delta-promotion injects as a hard constraint only when its evidence-weighted
// priority (set by rule-review.js deltaPriority) is at/below this — i.e. strongly
// backed. Legacy flat-50 endorsements sit above it and stay out of injection.
const DELTA_INJECT_THRESHOLD = 45;
// Known-safe sources for injection (allow-list). Was a deny-list ("anything not
// delta_promotion"), which let any unknown / future / typo'd source through silently.
// New sources must be added here deliberately. `undefined` source is also allowed
// (legacy test fixtures + kind:'authorization' rules that don't stamp source — the
// existing behavior we don't want to regress); delta_promotion is conditional on the
// evidence-weighted priority gate above. Keep in sync with the source values
// producers actually write (see grep -E "source:\s*['\"]\w+['\"]"); adding a new
// producer source without listing it here = the rule silently won't inject.
const INJECT_SOURCE_ALLOW = new Set([
  'interview',             // popup.js addOperatingRule + edited questionnaire decision rules
  'interview_template',    // chip-picked-unedited questionnaire rule
  'conflict_resolution',   // conflict-review.js resolveConflict + revertOverride
  'delegation_promotion',  // act-as-me, §9 normative
]);
// Newlines/tabs collapse to a single space — the Operating Rules block is a
// one-line-per-rule block. Without scrub, a user-typed rule containing "\n" (or a
// future producer that emits multi-line text) would silently break out of its line
// and inject as extra bullets / pseudo-headings, derailing the block's structure.
// Render-time chokepoint catches every writer (popup, conflict-review, mobile,
// historical data already on disk) without chasing each call site.
function sanitizeRuleLine(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function renderOperatingRules(fingerprint) {
  const rules = Array.isArray(fingerprint && fingerprint.standing_rules) ? fingerprint.standing_rules : [];
  const seen = new Set();
  const chosen = rules
    .filter(r => r && typeof r.text === 'string' && r.text.trim())
    // Curation: the Operating-rules block is for DELIBERATE hard constraints —
    // authored rules + interview-elicited decision rules + act-as-me (delegation) are
    // ALWAYS injected. Auto-promoted style signals (source:'delta_promotion') inject
    // ONLY when strongly evidenced — rule-review.js stamps them an evidence-weighted
    // priority (lower = stronger), so a well-backed endorsement (≤ threshold) earns a
    // slot while thin/legacy flat-50 ones stay out. Excluded promotions remain on the
    // fingerprint and still drive §10 consult; they just don't dilute injection (the
    // binding constraint is instruction-following fidelity, not tokens).
    .filter(r => {
      if (r.source == null) return true;                              // legacy / no-source — defensive
      if (r.source === 'delta_promotion') {                           // priority-gated
        return (Number.isFinite(r.priority) ? r.priority : 1e9) <= DELTA_INJECT_THRESHOLD;
      }
      return INJECT_SOURCE_ALLOW.has(r.source);                       // explicit allow-list
    })
    // Dedup by normalized text — defensive against near-duplicate authored rules.
    .filter(r => { const k = r.text.trim().toLowerCase().replace(/\s+/g, ' '); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (Number.isFinite(a.priority) ? a.priority : 1e9) - (Number.isFinite(b.priority) ? b.priority : 1e9))
    .slice(0, OPERATING_RULES_BUDGET);
  if (!chosen.length) return [];
  const lines = [
    '\n## Operating rules (user-confirmed)',
    'Explicit rules this person has endorsed. Treat them as hard constraints on decisions',
    'and recommendations, higher priority than inferred style. Apply them silently; do not',
    'restate them or open replies with "as someone who...".',
  ];
  for (const r of chosen) {
    const exc = typeof r.exception === 'string' && r.exception.trim() ? ` (Exception: ${sanitizeRuleLine(r.exception)})` : '';
    lines.push(`- ${sanitizeRuleLine(r.text)}${exc}`);
  }
  return lines;
}

// ─── Context block assembly ───────────────────────────────────────────────────

function buildContextBlock(fingerprint, behavioralSignals = {}, linguisticProfile = {}, cognitiveProfile = null, sessionMetrics = {}, mentalModels = null) {
  const lines = ['<phaedo_user_profile>'];

  // ── Framing (2026-07-04): declares the block as background about the subject,
  // not conversational history. Closes the confabulation defect surfaced by the
  // persona-eval cross-judge (see docs/persona-extraction/persona-effectiveness-eval.md
  // §7.4 Category A) where the model was writing "you mentioned…" attributing
  // fingerprint content to prior turns the user never spoke.
  lines.push(
    'This is a persona model of the subject — background about how they',
    'communicate and decide, learned across prior sessions. It is NOT part of',
    'this conversation; the subject has NOT said any of what follows in this',
    'session. Use it to calibrate tone, depth, format, and how decisions are',
    'framed. Do NOT attribute anything below to the subject as if they said it',
    'here (never "you mentioned…", "as you noted…", or "given your focus on X"',
    'citing content from this profile) — those attributions would be fabrications.',
  );

  // ── 0. Operating rules (authored, user-confirmed — highest priority) ─────────
  lines.push(...renderOperatingRules(fingerprint));

  // ── 1. Response instructions (derived from observed behavioral corrections) ──
  const inst = synthesizeResponseInstructions(behavioralSignals, cognitiveProfile);
  const hasInst = Object.values(inst).some(a => a.length > 0);
  if (hasInst) {
    lines.push('\n## How to respond to this user');
    if (inst.format.length)    { lines.push('Format:');       inst.format.forEach(i    => lines.push(`  - ${i}`)); }
    if (inst.tone.length)      { lines.push('Tone:');         inst.tone.forEach(i      => lines.push(`  - ${i}`)); }
    if (inst.depth.length)     { lines.push('Depth:');        inst.depth.forEach(i     => lines.push(`  - ${i}`)); }
    if (inst.autonomy.length)  { lines.push('Autonomy:');     inst.autonomy.forEach(i  => lines.push(`  - ${i}`)); }
    if (inst.decisions.length) { lines.push('Decisions:');    inst.decisions.forEach(i => lines.push(`  - ${i}`)); }
    if (inst.pace.length)      { lines.push('Pace/scope:');   inst.pace.forEach(i      => lines.push(`  - ${i}`)); }
  }

  // ── 2. Cognitive model (inferred from linguistic patterns) ────────────────
  if ((cognitiveProfile && Object.keys(cognitiveProfile).length > 0) || mentalModels) {
    lines.push('\n## How this user thinks');
    if (cognitiveProfile) for (const desc of Object.values(cognitiveProfile)) lines.push(`- ${desc}`);
    if (mentalModels) lines.push(`- ${mentalModels}`);
    const dist = linguisticProfile.platformDistribution;
    if (dist) {
      const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
      const total  = sorted.reduce((s, [, n]) => s + n, 0);
      if (sorted.length && total > 0) {
        const [top, count] = sorted[0];
        lines.push(`- Primarily uses ${top} (${Math.round((count / total) * 100)}% of observed sessions)`);
      }
    }
  }

  // ── 3. Technical profile (detected from interview answers) ────────────────
  const tech = detectTechnicalProfile(fingerprint);
  if (tech.level !== 'general') {
    lines.push('\n## Technical profile');
    lines.push(tech.level === 'power'
      ? '- Power user — skip basics, assume domain knowledge, provide code-level specificity'
      : '- Technical — comfortable with technical content; some domain knowledge assumed');
    if (tech.techs.length > 0)
      lines.push(`- Technologies mentioned: ${tech.techs.join(', ')}`);
  }

  // ── 4. Values and motivations (extracted from interview answers) ──────────
  const values = extractValueSignals(fingerprint);
  if (values.hasValues || values.futureOriented || values.growthMinded) {
    lines.push('\n## Values and motivations');
    if (values.hasValues)
      lines.push(`- Expresses held principles in their answers (${values.valueCount} instance${values.valueCount !== 1 ? 's' : ''}) — engage with what matters to them`);
    if (values.futureOriented)
      lines.push('- Future-oriented — references goals and where they are headed; connect responses to their direction');
    if (values.growthMinded)
      lines.push('- Growth-minded — acknowledges failure and reflects honestly; does not need false positivity');
  }

  // ── 5. Interview answers (supporting evidence) ────────────────────────────
  const layerConf = buildLayerConfidence(fingerprint);
  if (layerConf.some(l => l.answered > 0)) {
    lines.push('\n## Interview answers');
    for (const [layerId, layer] of Object.entries(fingerprint.layers)) {
      // A layer may be extraction-only (added by Loop 2 reconcile) with no
      // questionnaire responses — guard before filtering.
      const answered = (layer.responses || []).filter(r => r.answer.trim());
      if (!answered.length) continue;
      lines.push(`\n### ${layer.label}`);
      // A2 residual fix (2026-07-05): content-side softening of the
      // Domain-and-expertise section. The persona-eval §7.4 residual
      // showed the block front-loading a persona domain (e.g. immigration)
      // on prompts that didn't name or invite it. A previous framing-
      // directive iteration at the block-top level (A2, PR #115) net-
      // regressed by making the model over-hedgy on unrelated prompts.
      // This localized directive is scoped ONLY to the Domain-and-expertise
      // section — the specific place where domain content actually gets
      // read as topical steering. Concrete: for Randy this section says
      // "Primary Expertise: Building operational frameworks... business
      // immigration matters...", which the model was reading as "front-
      // load immigration on any HR-adjacent prompt." The framing tells
      // it to treat those answers as BACKGROUND about the subject rather
      // than topics to steer generic prompts toward.
      if (layerId === 'domain_and_expertise') {
        lines.push('*Use as background context about who the subject is — do not steer general prompts toward these topics unless the prompt names them.*');
      }
      for (const { label, question, answer } of answered)
        lines.push(`${label || question}: ${answer.trim()}`);
      const layerSigs = behavioralSignals[layerId];
      if (layerSigs) {
        const observed = Object.entries(layerSigs)
          .map(([sig, count]) => { const lbl = SIGNAL_LABELS[sig]; return lbl ? (count > 1 ? `${lbl} (×${count})` : lbl) : null; })
          .filter(Boolean);
        if (observed.length) lines.push(`Observed: ${observed.join('; ')}`);
      }
      const quals    = answered.map(r => scoreAnswerQuality(r.answer));
      const richN    = quals.filter(q => q === 'rich').length;
      const modN     = quals.filter(q => q === 'moderate').length;
      const layerQ   = richN >= answered.length * 0.5              ? 'high'
                     : (richN + modN) >= answered.length * 0.4     ? 'moderate'
                     : 'sparse';
      lines.push(`Confidence: ${layerQ}`);
    }
  }

  // ── 5b. Learned from observed conversations (Loop 2 extraction) ───────────
  // Each layer's `summary` is rendered by the extraction projection/reconcile
  // step (anti-preference precedence already applied). Inject it as-is — no
  // module import needed, the text is precomputed and stored on the layer.
  const learnedLines = [];
  for (const [layerId, layer] of Object.entries(fingerprint.layers)) {
    if (layer && typeof layer.summary === 'string' && layer.summary.trim()) {
      const clean = sanitizeSummary(layer.summary);            // P0 hygiene: drop episodic/opaque/dup lines
      if (clean) {
        learnedLines.push(`\n### ${layer.label || layerId.replace(/_/g, ' ')}`);
        learnedLines.push(clean);
      }
    }
  }
  if (learnedLines.length) {
    lines.push('\n## Learned from your conversations');
    lines.push(...learnedLines);
  }

  // ── 6. Confidence summary ─────────────────────────────────────────────────
  lines.push('\n## Fingerprint confidence');
  const msgCount  = linguisticProfile.messageCount || 0;
  const sessCount = sessionMetrics.sessionCount    || 0;
  const totalAns  = layerConf.reduce((s, l) => s + l.answered, 0);
  const totalQ    = layerConf.reduce((s, l) => s + l.total, 0);
  const richCount = layerConf.filter(l => l.quality === 'rich').length;
  const modCount  = layerConf.filter(l => l.quality === 'moderate').length;

  lines.push(`- Interview: ${totalAns}/${totalQ} answered · ${richCount} rich layer${richCount !== 1 ? 's' : ''}, ${modCount} moderate`);
  if (sessCount > 0 || msgCount > 0)
    lines.push(`- Behavioral: ${sessCount} session${sessCount !== 1 ? 's' : ''} · ${msgCount.toLocaleString()} messages observed`);

  const confidence =
    msgCount > 300 && richCount >= 3 ? 'high'     :
    msgCount > 80  || richCount >= 2 ? 'medium'   :
    totalAns > 0   || msgCount > 0   ? 'building' : 'minimal';

  const guidance = {
    high:     'weight behavioral profile heavily; interview confirms and anchors it',
    medium:   'blend interview and behavioral signals equally',
    building: 'rely primarily on interview answers; behavioral data still accumulating',
    minimal:  'minimal data — treat all signals as preliminary',
  }[confidence];

  lines.push(`- Overall: ${confidence} — ${guidance}`);
  lines.push('\n</phaedo_user_profile>');
  return lines.join('\n');
}

// ─── Glue: vault payload → injected string ────────────────────────────────────
// The canonical derivation (mirrors the old content.js rebuildContext): read the
// four vault keys, synthesize the derived cognitive profile + mental models, and
// render the block. Returns '' when there is no fingerprint yet. Pure — the
// Gemini documentElement side-effect stays in content.js.
// ── Input contract ────────────────────────────────────────────────────────────
// The vault-data object renderContextBlock consumes. A producer feeding a
// malformed shape used to silently yield an empty/degraded block; validate it so
// the failure is loud (or throwable) instead of silent.
function isPlainObject(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function ctxWarn(msg) { try { if (typeof console !== 'undefined' && console.warn) console.warn('[PhaedoContext] ' + msg); } catch (_) {} }

// Returns { ok, empty, errors }. `empty` (no fingerprint) is a LEGITIMATE
// nothing-to-render case (e.g. a fresh user), not a violation. `ok:false` means a
// real contract breach (wrong types) — the caller should treat that as a bug.
function validateVaultData(vd) {
  if (!isPlainObject(vd)) return { ok: false, empty: false, errors: ['vault data must be a plain object'] };
  const errors = [];
  const fp = vd.phaedo_fingerprint;
  const empty = fp === undefined || fp === null;
  if (!empty) {
    if (!isPlainObject(fp)) errors.push('phaedo_fingerprint must be an object');
    else {
      if (!isPlainObject(fp.layers)) errors.push('phaedo_fingerprint.layers must be an object');
      else for (const [id, L] of Object.entries(fp.layers)) if (!isPlainObject(L)) errors.push(`layer "${id}" must be an object`);
      if (fp.persona_strength !== undefined && (typeof fp.persona_strength !== 'number' || fp.persona_strength < 0 || fp.persona_strength > 1))
        errors.push('persona_strength must be a number in [0,1]');
      if (fp.fingerprint_id !== undefined && fp.fingerprint_id !== null && typeof fp.fingerprint_id !== 'string')
        errors.push('fingerprint_id must be a string');
    }
  }
  for (const k of ['phaedo_behavioral_signals', 'phaedo_linguistic_profile', 'phaedo_session_metrics'])
    if (vd[k] !== undefined && vd[k] !== null && !isPlainObject(vd[k])) errors.push(`${k} must be an object`);
  return { ok: errors.length === 0, empty, errors };
}

// Projection hygiene (P0, 2026-06-16): defense-in-depth on the injected summary.
// The producer's renderLayerSummary guards at generation, but a stale or
// third-party producer could store a violating summary; drop episodic + opaque
// value lines and dedupe repeated dimensions so the AI never sees them. Regexes
// MUST stay in sync with checkSummary() in spec/validate-fingerprint.mjs.
var SUMMARY_EPISODIC_RE = /(https?:\/\/|\bwww\.)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b[a-z0-9][a-z0-9-]*\.(com|org|net|io|so|co|ai|app|xyz|info)\b/i;
var SUMMARY_DIM_RE = /^[-*\s]*([^:]{1,60}):\s*(.+)$/;
var SUMMARY_OPAQUE_RE = /^[a-z]\d(?:[ _][a-z0-9]+)*$/i;
function sanitizeSummary(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text).split('\n')) {
    const t = raw.trim();
    if (!t) { out.push(raw); continue; }
    if (SUMMARY_EPISODIC_RE.test(t)) continue;                 // drop episodic (§4.6)
    const m = t.match(SUMMARY_DIM_RE);
    if (m) {
      const dim = m[1].trim().toLowerCase();
      if (seen.has(dim)) continue;                             // drop duplicate dimension
      if (SUMMARY_OPAQUE_RE.test(m[2].trim())) continue;       // drop opaque value
      seen.add(dim);
    }
    out.push(raw);
  }
  return out.join('\n').trim();
}

function renderContextBlock(vd, opts) {
  const v = validateVaultData(vd);
  if (!v.ok) {
    const msg = 'renderContextBlock got invalid vault data: ' + v.errors.join('; ');
    if (opts && opts.strict) throw new Error('[PhaedoContext] ' + msg);
    ctxWarn(msg);              // loud, not silent — a malformed producer is a bug
    return '';                 // …but still degrade gracefully (don't crash the page)
  }
  const fingerprint = vd.phaedo_fingerprint;
  if (!fingerprint) return ''; // v.empty — legitimately nothing to render
  const behavioralSignals = vd.phaedo_behavioral_signals || {};
  const linguisticProfile = vd.phaedo_linguistic_profile || {};
  const sessionMetrics    = vd.phaedo_session_metrics    || {};
  const cognitiveProfile  = synthesizeCognitiveProfile(linguisticProfile, sessionMetrics);
  const mentalModels      = synthesizeMentalModels(linguisticProfile);
  return buildContextBlock(fingerprint, behavioralSignals, linguisticProfile, cognitiveProfile, sessionMetrics, mentalModels);
}

globalThis.PhaedoContext = {
  buildContextBlock,
  synthesizeCognitiveProfile,
  synthesizeMentalModels,
  renderContextBlock,
  validateVaultData,
  SIGNAL_LABELS,
};

})();
