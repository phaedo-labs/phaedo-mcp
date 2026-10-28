// Phaedo Loop 2 extraction — field catalog (Stage-2 source of truth).
//
// Promoted verbatim from the proven prototype (scripts/local-model-eval/lib/
// mapper.mjs + embed-mapper.mjs). The architecture decision
// (docs/roadmap/extraction-engine-decision.md §6) explicitly DEPRIORITIZES
// further hand-tuning of this catalog — the real gains are in the v2 fine-tuned
// model, not more vocabulary. So this is a faithful copy, not a rewrite: the
// cross-persona F1 the eval established (~48% avg, ~70% peak) rides on these
// exact triggers/anchors. Touch only with a re-run of the eval harness.
//
// Maps to protocol §4.2 layers / extraction-task-spec §5.4 fields. Each catalog
// entry names the (layer, field) it produces and how to resolve its value +
// polarity once the field is matched (lexically here, or via embedding in
// mapper.js — both share resolveValueAndPolarity once the field is chosen).

export const NEG_CUES = [
  'dislike', 'hate', 'avoid', "doesn't", 'does not', "don't want", 'do not want',
  'stop ', 'no ', 'without', 'annoy', 'frustrat', 'pet peeve', 'bothered', 'against',
];

// Each entry: field, layer, default polarity, trigger phrases, and optional
// value resolver (cues → enum value, or a fixed scalar/array).
//
// `detectNeg: true` opts a field into polarity flipping on negation cues. Only
// fields whose negative form is a real, distinct signal (formatting "no
// bullets") use it. Enum/scalar fields encode direction in their VALUE, so a
// phrase like "don't dumb it down" (→ full_technical) must stay positive.
export const CATALOG = [
  // ── surface ──
  { field: 'response_length_pref', layer: 'surface', triggers: ['length', 'how long', 'thorough', 'concise', 'brief', 'short answer', 'detailed answer', 'verbose', 'quick version', 'short on time', 'too much detail', 'the short answer', 'full picture', 'complete picture', 'even if it', 'keep it short', 'long answer'],
    values: { short: ['short', 'brief', 'concise', 'tight', 'quick version', 'the short answer', 'too much detail', 'short on time', 'bottom line'], thorough: ['thorough', 'detailed', 'long', 'deep', 'comprehensive', 'full picture', 'complete picture', 'even if it', 'full pathway'], medium: ['medium', 'moderate'] } },
  { field: 'tone_register', layer: 'surface', triggers: ['tone', 'casual', 'formal', 'informal', 'conversational', 'professional', 'friendly', 'punchy', 'like a human', 'like a friend', 'corporate'],
    values: { casual: ['casual', 'informal', 'conversational', 'relaxed', 'friendly', 'punchy', 'like a human', 'like a friend', 'texting'], formal: ['formal', 'professional', 'corporate'], neutral: ['neutral'] } },
  { field: 'formatting_prefs', layer: 'surface', detectNeg: true, triggers: ['bullet', 'prose', 'paragraph', 'numbered', 'table', 'header', 'heading', 'code block', 'code', 'list', 'inline example', 'example', 'in order', 'steps', 'scan'],
    values: { prose: ['prose', 'paragraph'], bullets: ['bullet', 'list', 'scan'], numbered: ['numbered', 'in order', 'step'], tables: ['table'], headers: ['header', 'heading'], code_blocks: ['code block', 'code', 'just the code', 'give me the code'], inline_examples: ['inline example', 'example', 'use an example'] }, arrayValue: true },
  { field: 'jargon_tolerance', layer: 'surface', triggers: ['jargon', 'technical term', 'define', 'plain language', 'plain english', 'assume i know', 'not techy', 'not technical', 'lose the thread', 'what it means', 'cut the jargon', 'no jargon', 'simple', 'simpler'],
    scalar: t => /assume|already know|no need to define|skip the .*primer|skip the basics/.test(t) ? 0.85 : /define|explain.*term|plain|not techy|not technical|cut the jargon|no jargon|what it means|simpl/.test(t) ? 0.15 : 0.5 },
  { field: 'directness', layer: 'surface', triggers: ['get to the point', 'direct', 'bottom line', 'no preamble', 'skip the intro', 'cut to', 'cut to the chase', 'blunt', 'straight', 'no fluff', 'give it to me straight', 'just tell me'],
    scalar: () => 0.85 },
  { field: 'pet_peeves', layer: 'surface', forcePolarity: 'negative', triggers: ['dislike', 'annoy', 'pet peeve', 'bother', 'opener', 'great question', "don't like", 'frustrat', 'hate when', 'gets on'],
    arrayValueFromText: true },

  // ── behavioral ──
  { field: 'iteration_style', layer: 'behavioral', triggers: ['iterate', 'refine', 'keep going', 'revise', 'rework', 'passes', 'one shot', 'single pass', 'keep refining', 'until it', 'improve later'],
    values: { iterative_refine: ['iterate', 'refine', 'keep going', 'revise', 'keep refining', 'until it'], deep_rework: ['rework', 'rewrite', 'overhaul'], single_pass: ['one shot', 'single pass', 'one pass'] } },
  { field: 'ambiguity_response', layer: 'behavioral', triggers: ['ask first', 'clarify', 'clarifying question', 'ask before', 'state assumption', 'offer options'],
    values: { ask_first: ['ask first', 'clarify', 'clarifying', 'ask before'], assume_state_proceed: ['assume and proceed', 'state assumption'], offer_options: ['offer options'] } },
  { field: 'detail_vs_principle', layer: 'behavioral', triggers: ['principle', 'step by step', 'steps', 'big idea first', 'detail', 'in order', 'what do i actually do', 'understand why', 'why it works', 'concept first'],
    values: { principle_first: ['principle first', 'big idea first', 'understand why', 'why it works', 'concept first', 'principle.*then'], principle: ['principle'], steps: ['step by step', 'steps', 'in order', 'what do i actually do', 'what do i do'] } },
  { field: 'autonomy_pref', layer: 'behavioral', triggers: ['just do it', 'stop asking', 'confirm', 'check with me', 'act without', 'fewer questions', 'just go', 'without asking'],
    scalar: t => /just do|stop asking|fewer question|without asking|just go/.test(t) ? 0.85 : /confirm|check with|ask me/.test(t) ? 0.2 : 0.5 },
  { field: 'reasoning_visibility', layer: 'behavioral', triggers: ['show your reasoning', 'show your work', 'walk me through', 'skip the explanation', 'just the answer', 'no explanation', "i'll read it", 'just the code', 'without explanation', 'no need to explain'],
    values: { show: ['show your reasoning', 'show your work', 'walk me through'], skip: ['skip the explanation', 'just the answer', 'no explanation', "i'll read", 'just the code', 'without explanation', 'no need to explain'] } },
  { field: 'scope_discipline', layer: 'behavioral', triggers: ['stay scoped', 'just what i asked', 'be proactive', 'anticipate', "what i'm missing", 'what else'],
    values: { stay_scoped: ['stay scoped', 'just what i asked', 'only what'], wants_proactive: ['proactive', 'anticipate', 'what else', 'missing'] } },

  // ── creative ──
  { field: 'quality_word', layer: 'creative', triggers: ['elegant', 'rigorous', 'clear', 'surprising', 'useful', 'honest', 'beautiful', 'original', 'unexpected', 'practical', 'works', 'stands out', 'clean', 'simple'],
    values: { elegant: ['elegant', 'clean', 'simple', 'strip', 'less is more'], rigorous: ['rigorous', 'precise', 'exact'], clear: ['clear', 'clarity'], surprising: ['surprising', 'unexpected', 'original', 'different angle', 'stands out', 'nobody else', 'angle nobody'], useful: ['useful', 'practical', 'works', 'gets it done', 'fancy', 'something that works'], honest: ['honest'], beautiful: ['beautiful'] } },
  { field: 'problem_solving_move', layer: 'creative', triggers: ['decompose', 'break it down', 'analogy', 'analogous', 'map the system', 'systems', 'sketch', 'sit with', 'bottleneck', 'constraint', 'where the time goes', 'think of it as', 'hang together'],
    values: { decompose: ['decompose', 'break it down'], analogize: ['analogy', 'analogous', 'like a', 'think of it as'], map_system: ['map the system', 'systems', 'bottleneck', 'constraint', 'where the noise', 'where the time', 'hang together', 'as a system'], discuss: ['talk it through', 'discuss'], sketch: ['sketch', 'draw'], sit_with: ['sit with', 'let it sit'] } },
  { field: 'mental_model_inventory', layer: 'creative', triggers: ['first principles', 'systems thinking', 'theory of constraints', 'second order', 'second-order', 'tradeoff', 'trade-off', 'decomposition', 'scenario', 'analogical', 'downstream', 'cascade', 'ripple'],
    values: { first_principles: ['first principles'], systems_thinking: ['systems thinking', 'as a system', 'hang together'], theory_of_constraints: ['theory of constraints', 'constraint', 'bottleneck'], second_order_effects: ['second order', 'second-order', 'downstream', 'cascade', 'ripple', 'knock-on'], tradeoff_reasoning: ['tradeoff', 'trade-off'], analogical_reasoning: ['analogical', 'analogy'], decomposition: ['decomposition', 'decompose'], scenario_planning: ['scenario'] }, arrayValue: true },

  // ── domain_and_expertise ──
  { field: 'primary_expertise', layer: 'domain_and_expertise', triggers: ['expert in', 'expertise', 'works in', 'background in', 'professional', 'specializes', 'hr', 'immigration', 'engineer', 'designer', 'researcher', 'lawyer', 'distributed systems', 'molecular biology', 'marketing', 'design', 'business owner', 'i work in', 'i run a', 'years of'],
    stringFromText: true },
  { field: 'domain_depth_pref', layer: 'domain_and_expertise', triggers: ['go deep', 'technical depth', 'high level', 'surface level', 'match my question', "don't dumb", 'full picture', 'complete picture', "don't oversimplify", 'full pathway', 'no basics', 'just the concept', 'under the hood'],
    values: { full_technical: ['go deep', 'technical depth', 'under the hood', "don't dumb", 'no basics', 'full picture', 'complete picture', "don't oversimplify", 'full pathway', 'the full'], surface: ['high level', 'surface level', 'just the concept', 'too much detail'], match_my_question: ['match my question', 'follow my lead'] } },
  { field: 'active_learning_areas', layer: 'domain_and_expertise', triggers: ['learning', 'interested in', 'wants to learn', 'curious about'],
    arrayValueFromText: true },
  { field: 'domain_vocabulary', layer: 'domain_and_expertise', triggers: ['uses term', 'specialized vocab', 'jargon like', 'terms like', 'h-1b', 'lca', 'cap-exempt', 'raft', 'postgres', 'cassandra', 'kinase', 'mapk', 'technical vocabulary'],
    arrayValueFromText: true },
  { field: 'expertise_level', layer: 'domain_and_expertise', triggers: ['expert', 'power user', 'experienced', 'years of', 'years', 'novice', 'beginner', 'general user', 'not techy', 'not technical', "don't know enough", 'i work in this field', 'run this', "i've been", 'i run a'],
    values: { power: ['expert', 'power user', 'years', 'experienced', 'run this', 'work in this field', "i've been", 'i run a', 'seasoned'], technical: ['technical', 'some knowledge', 'comfortable with'], general: ['novice', 'beginner', 'general', 'not techy', 'not technical', "don't know enough", "don't know much"] } },

  // ── temporal_and_context ──
  { field: 'early_project_mode', layer: 'temporal_and_context', triggers: ['explore', 'wander', 'early stage', 'early on', 'not ready to commit', 'brainstorm', 'frame first', 'commit fast', 'just exploring', 'angles'],
    values: { explore_wide: ['explore', 'wander', 'brainstorm', 'angles', 'widely', 'just exploring', 'not ready to commit'], frame_then_explore: ['frame first', 'narrow then'], commit_fast: ['commit fast', 'decide quickly'] } },
  { field: 'urgency_baseline', layer: 'temporal_and_context', triggers: ['in a hurry', 'urgent', 'quick', 'no rush', 'take your time', 'asap', 'today', "don't have time", 'between job', 'short on time', 'time-pressured', 'need it now'],
    scalar: t => /hurry|urgent|asap|today|don.t have time|between job|short on time|need it now|need it today/.test(t) ? 0.85 : /no rush|take your time|have time|no hurry/.test(t) ? 0.15 : 0.5 },
  { field: 'working_mode', layer: 'temporal_and_context', triggers: ['exploring', 'build mode', 'ready to build', 'implementation', 'just thinking', 'still figuring'],
    values: { exploring: ['exploring', 'just thinking', 'early', 'still figuring'], build_mode: ['build mode', 'ready to build', 'implementation', 'ship'] } },

  // ── collaboration_and_relationship ──
  { field: 'feedback_pref', layer: 'collaboration_and_relationship', triggers: ['blunt', 'direct feedback', "don't soften", 'tell me what is wrong', 'diplomatic', 'gentle', 'be direct', "don't sugarcoat", 'honest but kind', 'real problems', 'tell me if', "don't be harsh", 'be honest'],
    values: { blunt: ['blunt', "don't soften", "don't sugarcoat", 'tell me what is wrong', 'be direct', 'real problems', 'tell me if', 'be honest', "don't hold back"], direct_balanced: ['direct but', 'balanced'], diplomatic: ['diplomatic', 'gentle', 'honest but kind', "don't be harsh", 'kind'] } },
  { field: 'disagreement_style', layer: 'collaboration_and_relationship', triggers: ['push back', 'disagree', 'challenge', 'ask questions to understand', 'revisit later', 'disagree and commit', 'challenged'],
    values: { push_back_now: ['push back', 'challenge', 'say it now', 'challenged'], ask_first: ['ask questions to understand', 'understand their reasoning'], revisit_later: ['revisit later'], disagree_commit: ['disagree and commit'] } },
  { field: 'audience_adaptation', layer: 'collaboration_and_relationship', triggers: ['for my audience', 'simplify for', 'non-technical audience', 'same level', 'pull up', 'going to', 'cut the jargon for', 'they would say', 'not marketers', 'small-business owners', 'the way they'],
    values: { simplify_aggressive: ['simplify for', 'dumb down', 'lay terms', 'cut the jargon', 'they would say', 'not marketers', 'small-business', 'the way they'], accuracy_slow: ['accurate', "don't oversimplify"], same_level: ['same level'], pull_up: ['pull up', 'level up'] } },

  // ── decision_and_risk ──
  { field: 'options_vs_recommendation', layer: 'decision_and_risk', triggers: ['recommend', 'which one', 'give me options', 'lay out choices', 'just decide', 'make the call', 'one recommendation', 'just pick', 'pick one', 'pick for me', 'what would you', 'three or four', 'several approaches', 'compare', 'different approaches', "don't just give me one", 'alternatives'],
    values: { single_recommendation: ['recommend', 'which one', 'make the call', 'just decide', 'one recommendation', 'just pick', 'pick one', 'pick for me', 'what would you go', 'go with'], option_set: ['give me options', 'lay out choices', 'show me options', 'alternatives', 'three or four', 'several approaches', 'different approaches', 'compare', "don't just give me one", "don't just give me"] } },
  { field: 'ambiguity_posture', layer: 'decision_and_risk', triggers: ['decisive', "don't hedge", 'stop hedging', 'be definitive', 'commit to a position', 'wrong and decisive', 'be confident'],
    values: { default: ['decisive', "don't hedge", 'stop hedging', 'definitive', 'wrong and decisive', 'commit', 'be confident'], ask: ['ask before deciding'], delay: ['wait', 'delay'] } },
  { field: 'speed_vs_quality', layer: 'decision_and_risk', triggers: ['speed over', 'quality over', 'accuracy over', 'thorough over', 'fast over', 'good enough', "don't need it perfect", "don't overthink", 'ship', 'speed matters', 'perfect on the first', 'a/b test'],
    scalar: t => /quality over|accuracy over|thorough over|cover the risk/.test(t) ? 0.8 : /speed over|fast over|quick over|good enough|don.t need it perfect|don.t overthink|ship|speed matters|improve later/.test(t) ? 0.15 : 0.5 },
  { field: 'evidence_threshold', layer: 'decision_and_risk', triggers: ['cover the risks', 'evidence', 'certainty', 'nail it down', 'need proof', 'ballpark is fine', 'cite', 'source', 'trace back', 'strength of the evidence', "don't state that as settled", 'contested', 'be careful', 'replicated'],
    scalar: t => /cover the risk|evidence|certainty|nail it down|proof|high bar|cite|source|trace back|strength of the evidence|don.t state|contested|be careful|replicated/.test(t) ? 0.8 : /ballpark|rough|good enough/.test(t) ? 0.2 : 0.5 },

  // ── big_picture ──
  { field: 'stable_principles', layer: 'big_picture', triggers: ['believes', 'principle', 'values', 'open to changing', 'pragmatic', 'idealist', 'always'],
    arrayValueFromText: true },
  { field: 'process_narration_pref', layer: 'big_picture', triggers: ['skip the meta', 'no commentary', 'show your thinking', 'think out loud', "don't narrate"],
    values: { skip_meta: ['skip the meta', 'no commentary', "don't narrate", 'no meta'], show_meta: ['show your thinking', 'think out loud', 'show your plan'] } },
];

// Human-readable anchor per field: a short natural sentence describing what the
// field captures. Embedded once and cached by the embedding mapper. Falls back
// to joining the field's triggers if no explicit anchor is given.
export const FIELD_ANCHORS = {
  response_length_pref: 'how long or short the user wants answers to be',
  tone_register: 'how casual or formal the user wants the tone',
  formatting_prefs: 'whether the user prefers prose, bullets, tables, headers, or code blocks',
  jargon_tolerance: 'whether to define technical terms or assume the user knows them',
  directness: 'the user wants the answer to get to the point with no preamble',
  pet_peeves: 'things the AI does that annoy or bother the user',
  iteration_style: 'whether the user iterates and refines or wants one final answer',
  ambiguity_response: 'whether the user wants clarifying questions or wants the AI to proceed',
  detail_vs_principle: 'whether the user wants step-by-step detail or the principle first',
  autonomy_pref: 'whether the user wants the AI to just act or to confirm before acting',
  reasoning_visibility: 'whether the user wants to see the reasoning or just the answer',
  scope_discipline: 'whether the user wants the AI to stay scoped or be proactive',
  quality_word: 'the quality the user values most, like elegant, useful, or surprising',
  problem_solving_move: 'how the user approaches problems, like decomposing or mapping the system',
  mental_model_inventory: 'mental models the user reasons with, like first principles or theory of constraints',
  primary_expertise: 'the field the user is an expert in or works in professionally',
  domain_depth_pref: 'whether the user wants deep technical depth or a high-level overview',
  active_learning_areas: 'topics the user is currently learning or curious about',
  domain_vocabulary: 'specialized terms or jargon the user uses',
  expertise_level: 'whether the user is an expert, technical, or general user',
  early_project_mode: 'whether the user explores widely or commits fast early in a project',
  urgency_baseline: 'whether the user is in a hurry or has no rush',
  working_mode: 'whether the user is exploring or in build mode',
  feedback_pref: 'whether the user wants blunt or diplomatic feedback',
  disagreement_style: 'how the user handles disagreement, like pushing back or asking questions first',
  audience_adaptation: 'how the user adapts communication for different audiences',
  options_vs_recommendation: 'whether the user wants a single recommendation or a set of options',
  ambiguity_posture: 'whether the user wants the AI to be decisive or to hedge',
  speed_vs_quality: 'whether the user values speed or quality more',
  evidence_threshold: 'how much evidence the user needs before committing',
  stable_principles: 'enduring principles or values the user holds',
  process_narration_pref: 'whether the user wants the AI to narrate its process or skip the meta',
};

export function anchorFor(entry) {
  return FIELD_ANCHORS[entry.field] || entry.triggers.join(', ');
}

export function hasNeg(text) {
  const t = text.toLowerCase();
  return NEG_CUES.some(c => t.includes(c));
}

// Cues that are short, common substrings of unrelated words
// (table↔comfortable, code↔decode, list↔realistic, scan↔scandal,
// prose↔prosecutor). Match THESE at word boundaries; everything else stays
// substring, to preserve intended stem matches ("frustrat"→frustrated,
// "annoy"→annoying). Used for both trigger and value-cue matching.
const WHOLE_WORD_CUES = new Set(['table', 'tables', 'code', 'list', 'scan', 'prose']);
export function cueHit(text, cue) {
  if (WHOLE_WORD_CUES.has(cue)) return new RegExp(`\\b${cue}\\b`).test(text);
  return text.includes(cue);
}

// Decide a single value's polarity by PROXIMITY to a negation cue: a value is
// negative only when a negation cue ("no", "stop", "don't", "avoid", "without",
// …) sits just before one of its cue words. So "stop using bullets, just write
// prose" splits into bullets→negative + prose→positive, instead of the old
// blanket flip that wrongly marked prose negative too. Window-based, so a
// negation distributed across a clause ("avoid bullets and headers") can miss
// the second item — the embedding mapper is the fuller fix.
const NEG_WINDOW = 16;
function valuePolarity(t, cues) {
  for (const c of cues) {
    let idx = t.indexOf(c);
    while (idx !== -1) {
      const before = t.slice(Math.max(0, idx - NEG_WINDOW), idx);
      if (NEG_CUES.some(n => before.includes(n.trim()))) return 'negative';
      idx = t.indexOf(c, idx + c.length);
    }
  }
  return 'positive';
}

// Field-level base polarity for non-split fields: forced (pet_peeves) >
// whole-observation negation for opted-in fields > positive. Enum/scalar fields
// encode direction in their VALUE, so "don't dumb it down" stays positive.
function basePolarity(entry, t) {
  if (entry.forcePolarity) return entry.forcePolarity;
  if (entry.detectNeg && hasNeg(t)) return 'negative';
  return 'positive';
}

// Resolve a matched catalog entry to ZERO OR MORE {value, polarity} signal
// groups. Most fields yield one group; a detectNeg ranked_list
// (formatting_prefs) can yield two — a positive subset and a negative subset —
// when one observation expresses both a wanted and an unwanted format.
// Shared by the lexical and embedding mappers once the FIELD is chosen.
export function resolveSignalGroups(entry, obs) {
  const t = obs.toLowerCase().replace(/^[-*•]\s*/, '').trim();

  if (entry.values && entry.arrayValue) {
    const pos = [], neg = [];
    for (const [val, cues] of Object.entries(entry.values)) {
      if (!cues.some(c => cueHit(t, c))) continue;
      const pol = entry.detectNeg ? valuePolarity(t, cues) : 'positive';
      (pol === 'negative' ? neg : pos).push(val);
    }
    const out = [];
    if (pos.length) out.push({ value: pos, polarity: 'positive' });
    if (neg.length) out.push({ value: neg, polarity: 'negative' });
    return out;
  }
  if (entry.values) {
    for (const [val, cues] of Object.entries(entry.values))
      if (cues.some(c => cueHit(t, c))) return [{ value: val, polarity: basePolarity(entry, t) }];
    return [];
  }
  if (entry.scalar)             return [{ value: entry.scalar(t), polarity: basePolarity(entry, t) }];
  if (entry.arrayValueFromText) return [{ value: [obs.replace(/^[-*•]\s*/, '').trim()], polarity: basePolarity(entry, t) }];
  if (entry.stringFromText)     return [{ value: obs.replace(/^[-*•]\s*/, '').trim(), polarity: basePolarity(entry, t) }];
  return [];
}

// Back-compat shim: first group only (or a null value when nothing matched).
export function resolveValueAndPolarity(entry, obs) {
  const groups = resolveSignalGroups(entry, obs);
  return groups.length ? groups[0] : { value: null, polarity: 'positive' };
}
