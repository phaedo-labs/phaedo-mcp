// Phaedo capture — Path A detectors (shared mirror of the extension's tables).
//
// Track A option (a): the Claude Code / Cowork capture hook produces REAL signal by
// running the SAME deterministic Path-A detectors the Chrome extension runs in
// content.js — the correction patterns (whose counters delta-lift turns into §5.1
// signals), the positive-reinforcement patterns, and the mental-model markers.
//
// MIRROR, not import: content.js is a plain (non-module) content script, so it
// cannot be imported here and this module cannot be loaded there without an MV3
// module-loading change. Following the repo's vendored-copy precedent
// (context-block.js), the three tables below are a byte-exact mirror of
// content.js, and drift is impossible in practice because
// scripts/test_capture_detectors.mjs extracts the tables from content.js source
// and compares every pattern (source + flags + layer/signal/framework) 1:1 —
// any edit to either side without the other fails CI.
//
// The detect functions are PURE ports (no globals, no accumulation): the
// extension's detectCorrection mutates memSignals; here the caller accumulates.
// Matching semantics are identical: corrections are FIRST-match-only per message,
// mental models at most once per framework per message.

// ─── Correction patterns (all 8 layers) — mirror of content.js ───────────────

export const CORRECTION_PATTERNS = [
  // Surface — depth
  { pattern: /\b(too long|too verbose|be (more )?concise|shorter|brief(er)?|summarize that|less words|too wordy|cut it down)\b/i,        layer: 'surface',        signal: 'too_long' },
  { pattern: /\b(too short|more detail|elaborate|expand on|be more thorough|not enough|flesh it out|missing context)\b/i,                 layer: 'surface',        signal: 'too_short' },
  // Surface — formatting
  { pattern: /\bdon'?t use bullets?\b|\bno bullets?\b|\buse (prose|paragraphs?)\b|\bno lists?\b/i,                                        layer: 'surface',        signal: 'avoid_bullets' },
  { pattern: /\buse (bullet|numbered) (points?|lists?)\b|\blist (it|them|that) out\b|\bbullet (format|points?)\b/i,                       layer: 'surface',        signal: 'prefer_bullets' },
  { pattern: /\b(no headers?|no sections?|no headings?|don'?t section|remove (the )?headers?)\b/i,                                        layer: 'surface',        signal: 'no_headers' },
  { pattern: /\b(add headers?|use headers?|section it|organize with|with headings?)\b/i,                                                  layer: 'surface',        signal: 'use_headers' },
  { pattern: /\b(table format|in a table|tabular|use a table|as a table)\b/i,                                                             layer: 'surface',        signal: 'use_table' },
  { pattern: /\b(code block|in code|formatted code|wrap (that|it) in code)\b/i,                                                           layer: 'surface',        signal: 'use_code_block' },
  // Surface — tone
  { pattern: /\b(too formal|less formal|more casual|relax the tone|conversational(ly)?|informal)\b/i,                                     layer: 'surface',        signal: 'prefers_casual' },
  { pattern: /\b(too casual|more formal|professional(ly)?|keep it formal)\b/i,                                                            layer: 'surface',        signal: 'prefers_formal' },
  { pattern: /\b(too roundabout|get to the point|be direct|skip the preamble|lead with|bottom.?line (up )?front)\b/i,                    layer: 'surface',        signal: 'more_direct' },
  { pattern: /\b(no (intro|preamble|opener)|skip the intro|don'?t start with|cut the opener|dive right in)\b/i,                          layer: 'surface',        signal: 'no_preamble' },
  { pattern: /\b(no examples?|skip the examples?|I don'?t need examples?|without examples?)\b/i,                                         layer: 'surface',        signal: 'no_examples' },
  { pattern: /\b(give me an example|show me an example|illustrate|for example|can you show|concrete example)\b/i,                         layer: 'surface',        signal: 'wants_examples' },
  { pattern: /\b(simpler words?|plain(er)? (language|english)|avoid jargon|less jargon|plain terms?)\b/i,                                layer: 'surface',        signal: 'plainer_language' },

  // Behavioral — autonomy and initiative
  { pattern: /\b(just do it|stop asking|don'?t (ask|check)|fewer questions?|just (go|start|write|build|do)|no need to ask)\b/i,          layer: 'behavioral',     signal: 'fewer_questions' },
  { pattern: /\b(ask (me )?first|confirm before|check (with me|before)|get my (input|approval)|don'?t assume)\b/i,                        layer: 'behavioral',     signal: 'wants_confirmation' },
  { pattern: /\b(show your (work|reasoning)|explain your reasoning|walk me through|how (did you|do you) (get|arrive))\b/i,                layer: 'behavioral',     signal: 'show_reasoning' },
  { pattern: /\b(just (give me|the) (answer|result)|skip the explanation|don'?t explain (how|why)|bottom line only)\b/i,                 layer: 'behavioral',     signal: 'skip_reasoning' },
  { pattern: /\b(just pick (one|it)|make (a|the) decision|too many options?|don'?t give me options?|choose for me)\b/i,                  layer: 'behavioral',     signal: 'fewer_options' },
  { pattern: /\b(give me (options?|alternatives?|choices?)|what are my (options?|choices?)|several approaches?|show alternatives?)\b/i,   layer: 'behavioral',     signal: 'wants_options' },
  { pattern: /\b(what else (should I|am I missing)|be proactive|anticipate|what haven'?t I|what am I missing)\b/i,                       layer: 'behavioral',     signal: 'wants_proactive' },
  { pattern: /\b(just (what I asked|the question)|don'?t add (extra|more|additional)|stick to (the question|what I said)|only what I asked)\b/i, layer: 'behavioral', signal: 'stay_scoped' },
  { pattern: /\b(let'?s (refine|iterate|keep going)|more (passes?|iterations?)|continue (from|where)|iterate on this)\b/i,               layer: 'behavioral',     signal: 'iterate_more' },

  // Domain — expertise calibration
  { pattern: /\b(I (already )?know (that|this)|skip the basics?|assume I know|don'?t explain (that|this)|over.?explaining)\b/i,          layer: 'domain_and_expertise',         signal: 'overexplaining' },
  { pattern: /\b(too technical|simpler( terms?| language)?|(plain|plain.?english)|explain like (I'?m|a)|non.?technical)\b/i,              layer: 'domain_and_expertise',         signal: 'too_technical' },
  { pattern: /\b(go deeper|more technical|implementation detail|under the hood|technical depth?|deeper dive|specifics?)\b/i,              layer: 'domain_and_expertise',         signal: 'wants_depth' },
  { pattern: /\b(cite (your )?sources?|where (does this|did you)|source for that|reference for this|where did you get)\b/i,              layer: 'domain_and_expertise',         signal: 'wants_sources' },
  { pattern: /\b(just the concept|high.?level( only)?|conceptual (understanding|overview)|the idea not the code)\b/i,                    layer: 'domain_and_expertise',         signal: 'conceptual_only' },
  { pattern: /\b(show (me )?(the )?code|implementation|how (to implement|do I build)|concrete (example|code|steps?))\b/i,                layer: 'domain_and_expertise',         signal: 'wants_implementation' },
  { pattern: /\b(too broad|narrow it( down)?|focus on .{1,40}? specifically|more focused|scope (it )?down)\b/i,                         layer: 'domain_and_expertise',         signal: 'too_broad' },

  // Temporal — urgency and project phase
  { pattern: /\b(quick (version|answer|summary)|TL;?DR|key points? only|brief (version|summary)|in a hurry|short on time|fast (answer|version))\b/i, layer: 'temporal_and_context', signal: 'urgent' },
  { pattern: /\b(thorough(ly)?( is fine)?|take (the )?space|I have time|no hurry|comprehensive (is fine|please))\b/i,                    layer: 'temporal_and_context',       signal: 'no_rush' },
  { pattern: /\b(just exploring|early (stage|days)|high.?level for now|don'?t go too deep (yet)?|preliminary)\b/i,                      layer: 'temporal_and_context',       signal: 'exploring_phase' },
  { pattern: /\b(ready to build|implementation mode|let'?s get specific|concrete now|production.?ready|ship it)\b/i,                     layer: 'temporal_and_context',       signal: 'build_mode' },
  { pattern: /\b(big (picture|view)|strategy (level|only)|not the details|30[,.]?000.?foot|overview first|macro)\b/i,                    layer: 'temporal_and_context',       signal: 'big_picture' },
  { pattern: /\b(get (granular|specific|detailed)|deep in the details|implementation specifics?|micro.?level)\b/i,                        layer: 'temporal_and_context',       signal: 'detail_mode' },

  // Collaboration — audience and voice
  { pattern: /\b(write for (a )?non.?technical|simplify for (my )?audience|they don'?t know|lay(man'?s?) terms?|accessible)\b/i,         layer: 'collaboration_and_relationship',  signal: 'non_technical_audience' },
  { pattern: /\b(this is for (engineers?|developers?|technical)|technical audience|assume (they know|technical knowledge))\b/i,           layer: 'collaboration_and_relationship',  signal: 'technical_audience' },
  { pattern: /\b(write in my (voice|style)|sound like me|match my (voice|tone|style)|in my (words|style))\b/i,                           layer: 'collaboration_and_relationship',  signal: 'match_voice' },
  { pattern: /\b(for a client|external (audience|use|doc)|this is (public|external|client.?facing)|publishing this)\b/i,                 layer: 'collaboration_and_relationship',  signal: 'external_audience' },
  { pattern: /\b(too jargon.?y for them|they won'?t understand|simpler for (this|my) audience|dumb (it )?down for)\b/i,                  layer: 'collaboration_and_relationship',  signal: 'too_jargony_for_audience' },

  // Decision — risk and certainty
  { pattern: /\b(just (decide|pick|choose)|make (a|the) call|stop hedging|give me a recommendation|be decisive|commit to)\b/i,           layer: 'decision_and_risk',       signal: 'wants_decisiveness' },
  { pattern: /\b(show (me )?(my )?options?|I want to choose|don'?t decide for me|lay out (the )?choices?|what are (my )?options?)\b/i,  layer: 'decision_and_risk',       signal: 'wants_options_decision' },
  { pattern: /\b(what are the (trade.?offs?|risks?)|pros and cons|caveats?|what could go wrong|downsides?|what'?s the catch)\b/i,        layer: 'decision_and_risk',       signal: 'wants_nuance' },
  { pattern: /\b(be (bold|more decisive|stronger)|strong(er)? recommendation|which is better|don'?t hedge|be definitive)\b/i,           layer: 'decision_and_risk',       signal: 'wants_bold_call' },
  { pattern: /\b(conservative (approach|option|choice)|safer (option|path|choice)|low.?risk|cautious)\b/i,                               layer: 'decision_and_risk',       signal: 'wants_conservative' },
  { pattern: /\b(I need certainty|nail it down|definitive (answer|yes|no)|how confident|is this certain)\b/i,                            layer: 'decision_and_risk',       signal: 'needs_certainty' },
  { pattern: /\b(ballpark (is fine|estimate|answer)|rough estimate|in the ballpark|order of magnitude|approximate(ly)?( is fine)?)\b/i,  layer: 'decision_and_risk',       signal: 'rough_estimate_ok' },

  // Creative — style and originality
  { pattern: /\b(too conventional|be (more )?creative|unexpected (approach|angle|idea)|think (differently|outside)|original)\b/i,        layer: 'creative',       signal: 'wants_creative' },
  { pattern: /\b(simpler|more elegant|too complex|less is more|strip (it )?down|over.?engineered|over.?complicated)\b/i,                 layer: 'creative',       signal: 'wants_elegance' },
  { pattern: /\b(standard (approach|solution)|conventional|don'?t overthink|keep it (simple|straightforward|standard))\b/i,              layer: 'creative',       signal: 'wants_conventional' },
  { pattern: /\b(more original|surprise me|not the obvious|unconventional|different (angle|approach|way)|unexpected)\b/i,                layer: 'creative',       signal: 'wants_originality' },

  // Meta — transparency and self-awareness
  { pattern: /\b(don'?t explain what you'?re doing|just do it|skip the (meta|commentary|preamble)|no meta)\b/i,                          layer: 'big_picture',           signal: 'skip_meta' },
  { pattern: /\b(show your reasoning|think out loud|walk me through your (logic|thinking|approach)|what'?s your (plan|approach|thinking))\b/i, layer: 'big_picture',    signal: 'show_meta' },
  { pattern: /\b(what (assumptions?|are you assuming)|be transparent|tell me your reasoning|what'?s your (basis|rationale))\b/i,         layer: 'big_picture',           signal: 'wants_transparency' },
  { pattern: /\b(commit|stop second.?guessing|be confident|don'?t hedge|pick and go|just (pick|commit|decide))\b/i,                      layer: 'big_picture',           signal: 'less_second_guessing' },
];

// Positive reinforcement — mirror of content.js
export const POSITIVE_PATTERNS = [
  /\b(perfect(ly)?( (done|answer|response|format|length|tone))?)\b/i,
  /\b(exactly (right|what I (wanted|needed|meant|was looking for)))\b/i,
  /\byes[,!]?\s+(that'?s?|exactly|perfect|right|nailed|spot on)\b/i,
  /\b(love (this|it|that|the (way|approach|style|format|tone)))\b/i,
  /\b(great (call|choice|approach|idea|response|answer|format|depth))\b/i,
  /\bnailed (it|the (tone|format|depth|length))\b/i,
  /\b(keep (doing|this|that) (up|like this|way))\b/i,
  /\bspot on\b/i,
  /\b(this is (great|perfect|exactly (right|what I needed)))\b/i,
  /\b(much better( now)?)\b/i,
  /\b(that (works|worked) (perfectly|great|well))\b/i,
  /\b(good (call|instinct|judgment|read|approach))\b/i,
  /\bright (level|tone|depth|format|approach|amount|length)\b/i,
  /\b(sounds like me|matched my (voice|style|tone))\b/i,
  /\b(exactly the (right|level|depth|amount|tone) I (needed|wanted))\b/i,
];

// Mental-model markers — mirror of content.js
export const MENTAL_MODEL_PATTERNS = [
  // First-principles reasoning — reasons up from fundamentals
  { pattern: /\bfirst principles?\b/i,                                                       framework: 'first_principles' },
  { pattern: /\b(root cause|underlying (reason|cause|mechanism|principle))\b/i,               framework: 'first_principles' },
  { pattern: /\bfrom (the ground up|scratch)\b/i,                                            framework: 'first_principles' },
  { pattern: /\b(core|base|underlying) assumptions?\b/i,                                      framework: 'first_principles' },
  { pattern: /\bwhy does (that|this|it) (actually |even |really )?work\b/i,                  framework: 'first_principles' },
  { pattern: /\bbreak (it|this|that) down to (the )?(basics|fundamentals)\b/i,                framework: 'first_principles' },
  { pattern: /\bfundamental(ly)? (question|issue|problem|reason|why)\b/i,                     framework: 'first_principles' },
  { pattern: /\bwhat'?s really (going on|happening|behind)\b/i,                               framework: 'first_principles' },

  // Systems thinking — feedback loops, interconnection, the whole system
  { pattern: /\bfeedback loops?\b/i,                                                          framework: 'systems_thinking' },
  { pattern: /\bthe (whole|entire|broader|bigger) (system|picture)\b|\bsystem.?(wide|level)\b/i, framework: 'systems_thinking' },
  { pattern: /\binterdependen|interconnect|interrelat/i,                                      framework: 'systems_thinking' },
  { pattern: /\bemergent\b/i,                                                                 framework: 'systems_thinking' },
  { pattern: /\bholistic(ally)?\b/i,                                                          framework: 'systems_thinking' },
  { pattern: /\bmoving parts\b/i,                                                             framework: 'systems_thinking' },
  { pattern: /\b(vicious|virtuous) (cycle|circle)\b/i,                                        framework: 'systems_thinking' },
  { pattern: /\bcause and effect\b/i,                                                         framework: 'systems_thinking' },
  { pattern: /\bsystem(ic|s) (dynamics?|behaviou?r)\b/i,                                      framework: 'systems_thinking' },

  // Theory of constraints — bottleneck / limiting-factor framing
  { pattern: /\bbottleneck/i,                                                                 framework: 'theory_of_constraints' },
  { pattern: /\b(the|a|key|main|real) constraint\b/i,                                         framework: 'theory_of_constraints' },
  { pattern: /\blimiting factor\b/i,                                                          framework: 'theory_of_constraints' },
  { pattern: /\bwhat'?s (blocking|slowing|the blocker)\b|\bholding .{1,20} back\b/i,          framework: 'theory_of_constraints' },
  { pattern: /\bcritical path\b/i,                                                            framework: 'theory_of_constraints' },
  { pattern: /\brate.?limiting\b/i,                                                           framework: 'theory_of_constraints' },
  { pattern: /\bchoke ?point\b/i,                                                             framework: 'theory_of_constraints' },
  { pattern: /\bgating (factor|item|step|issue)\b/i,                                          framework: 'theory_of_constraints' },
  { pattern: /\bweakest link\b/i,                                                             framework: 'theory_of_constraints' },

  // Second-order effects — consequences of consequences
  { pattern: /\bsecond.?order\b/i,                                                            framework: 'second_order_effects' },
  { pattern: /\bdownstream (effects?|consequences?|impacts?)\b/i,                             framework: 'second_order_effects' },
  { pattern: /\bknock.?on (effects?|consequences?|impacts?)\b/i,                              framework: 'second_order_effects' },
  { pattern: /\bripple (effects?|through|across)\b/i,                                         framework: 'second_order_effects' },
  { pattern: /\bunintended consequences?\b/i,                                                 framework: 'second_order_effects' },
  { pattern: /\b(and )?then what happens\b/i,                                                 framework: 'second_order_effects' },
  { pattern: /\bcascad(e|es)\b/i,                                                             framework: 'second_order_effects' },
  { pattern: /\bdown the (line|road)\b/i,                                                     framework: 'second_order_effects' },
  { pattern: /\b(long|longer).?term (effects?|consequences?|impacts?)\b/i,                    framework: 'second_order_effects' },
  { pattern: /\bwhat (does|will) (that|this|it) lead to\b/i,                                  framework: 'second_order_effects' },

  // Trade-off reasoning — explicit cost/benefit weighing
  { pattern: /\btrade.?offs?\b/i,                                                             framework: 'tradeoff_reasoning' },
  { pattern: /\bat the (cost|expense) of\b/i,                                                 framework: 'tradeoff_reasoning' },
  { pattern: /\bin exchange for\b/i,                                                          framework: 'tradeoff_reasoning' },
  { pattern: /\bpros and cons\b/i,                                                            framework: 'tradeoff_reasoning' },
  { pattern: /\bwhat (do|would) (we|i) (lose|give up|sacrifice)\b/i,                          framework: 'tradeoff_reasoning' },
  { pattern: /\bcost.?benefit\b|\bnet (gain|benefit|positive|negative)\b/i,                   framework: 'tradeoff_reasoning' },
  { pattern: /\bupsides? and downsides?\b/i,                                                  framework: 'tradeoff_reasoning' },
  { pattern: /\bworth the (cost|trade.?off|effort|risk)\b/i,                                  framework: 'tradeoff_reasoning' },
  { pattern: /\bzero.?sum\b/i,                                                                framework: 'tradeoff_reasoning' },

  // Analogical reasoning — reasoning from similar cases
  { pattern: /\b(similar to|analogous to)\b/i,                                                framework: 'analogical_reasoning' },
  { pattern: /\breminds me of\b/i,                                                            framework: 'analogical_reasoning' },
  { pattern: /\bsame (idea|pattern|principle|concept) as\b/i,                                 framework: 'analogical_reasoning' },
  { pattern: /\b(by analogy|analog(y|ous))\b/i,                                               framework: 'analogical_reasoning' },
  { pattern: /\bthe .{1,30} equivalent of\b/i,                                                framework: 'analogical_reasoning' },
  { pattern: /\bthink of (it|this) (like|as)\b/i,                                             framework: 'analogical_reasoning' },
  { pattern: /\bkind of like\b/i,                                                             framework: 'analogical_reasoning' },
  { pattern: /\bparallels? (to|with|between)\b/i,                                             framework: 'analogical_reasoning' },

  // Decomposition — break a problem into parts
  { pattern: /\bbreak (it|this|that|the problem|things?) (down|up|apart|into)\b/i,            framework: 'decomposition' },
  { pattern: /\bstep.?by.?step\b/i,                                                           framework: 'decomposition' },
  { pattern: /\bsmaller (parts|pieces|chunks|problems?|steps?|tasks?)\b/i,                    framework: 'decomposition' },
  { pattern: /\bdecompos/i,                                                                   framework: 'decomposition' },
  { pattern: /\bsub.?(problems?|tasks?|components?)\b/i,                                       framework: 'decomposition' },
  { pattern: /\b(one|each) (piece|part|step|chunk|thing) at a time\b/i,                       framework: 'decomposition' },
  { pattern: /\b(piece by piece|bit by bit)\b/i,                                              framework: 'decomposition' },
  { pattern: /\bdivide and conquer\b/i,                                                       framework: 'decomposition' },
  { pattern: /\bchunk (it|this|that) (up|out|down)\b/i,                                        framework: 'decomposition' },

  // Scenario planning — contingencies, worst/best case
  { pattern: /\bworst.?case\b/i,                                                              framework: 'scenario_planning' },
  { pattern: /\bbest.?case\b/i,                                                               framework: 'scenario_planning' },
  { pattern: /\bcontingenc/i,                                                                 framework: 'scenario_planning' },
  { pattern: /\b(edge|corner) cases?\b/i,                                                     framework: 'scenario_planning' },
  { pattern: /\bplan for (the )?(failure|downside|worst)\b/i,                                 framework: 'scenario_planning' },
  { pattern: /\bif .{1,30} (fails?|breaks?|goes wrong)\b/i,                                   framework: 'scenario_planning' },
  { pattern: /\bwhat'?s the worst that\b/i,                                                   framework: 'scenario_planning' },
  { pattern: /\b(fall.?back plan|plan b)\b/i,                                                 framework: 'scenario_planning' },
  { pattern: /\bdownside (risk|scenario|case)\b/i,                                            framework: 'scenario_planning' },
];

// ─── Pure detect functions (extension semantics, caller accumulates) ─────────

// A correction/positive/framework cue is a short phrase; nobody types a 200 KB
// correction. Detect over only the first slice of a message — this both bounds
// worst-case regex cost (defense-in-depth against a pathological paste on top of
// the bounded patterns) and keeps semantics identical for real prompts. 8 KB is
// far longer than any genuine steering message.
const MAX_DETECT_CHARS = 8192;
const clip = (text) => { const s = String(text || ''); return s.length > MAX_DETECT_CHARS ? s.slice(0, MAX_DETECT_CHARS) : s; };

// First-match-only per message, same as content.js detectCorrection.
export function detectCorrection(text) {
  const s = clip(text);
  for (const { pattern, layer, signal } of CORRECTION_PATTERNS) {
    if (pattern.test(s)) return { layer, signal };
  }
  return null;
}

export function detectPositive(text) {
  const s = clip(text);
  return POSITIVE_PATTERNS.some((pattern) => pattern.test(s));
}

// At most once per framework per message, same as content.js detectMentalModels.
export function detectMentalModels(text) {
  const s = clip(text);
  const seen = new Set();
  for (const { pattern, framework } of MENTAL_MODEL_PATTERNS) {
    if (seen.has(framework)) continue;
    if (pattern.test(s)) seen.add(framework);
  }
  return [...seen];
}

// Run all three detectors over a batch's user messages (transcript.js
// recordsToBatch output) and return the SESSION's counts in the shapes the rest
// of the pipeline expects. Also fills each exchange's delta_annotations in place
// (the Loop-2 per-exchange annotation shape), so a future model backend (option
// (b)) consumes the identical batch the web path produces.
//   → { behavioral_signals: { layer: { signal: n } },   // phaedo_behavioral_signals shape
//       positive_count, mental_models: { framework: n }, message_count }
export function accumulateBatchCounts(batch) {
  const exchanges = (batch && batch.exchanges) || [];
  // Path-A counts come from EVERY sent user prompt (the web path counts at send time),
  // so an interrupted / unanswered correction still counts. Fall back to the exchanges'
  // user_msg when user_prompts is absent (hand-built batches in older tests).
  const prompts = (batch && Array.isArray(batch.user_prompts))
    ? batch.user_prompts
    : exchanges.map((e) => e.user_msg);
  const behavioral = {};
  const mental = {};
  let positive = 0;
  for (const text of prompts) {
    const corr = detectCorrection(text);
    if (corr) {
      if (!behavioral[corr.layer]) behavioral[corr.layer] = {};
      behavioral[corr.layer][corr.signal] = (behavioral[corr.layer][corr.signal] || 0) + 1;
    }
    if (detectPositive(text)) positive++;
    for (const fw of detectMentalModels(text)) mental[fw] = (mental[fw] || 0) + 1;
  }
  // Per-exchange annotations (for the future model/Loop-2 backend) stay keyed to complete exchanges.
  for (const ex of exchanges) {
    const corr = detectCorrection(ex.user_msg);
    ex.delta_annotations = {
      corrections: corr ? [corr] : [],
      positive: detectPositive(ex.user_msg),
      mental_models: detectMentalModels(ex.user_msg),
    };
  }
  return {
    behavioral_signals: behavioral,
    positive_count: positive,
    mental_models: mental,
    message_count: prompts.length,
  };
}
