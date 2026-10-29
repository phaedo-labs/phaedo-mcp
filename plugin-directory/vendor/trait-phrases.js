// Phaedo — TRAIT PHRASES: every learned trait, in words a person can read (2026-10-08).
//
// THE PROBLEM. The review cards ("Rules to review", "Conflicts to settle", "Phaedo learned this")
// built their sentences from a table that covered seven of the ~30 traits. Everything else fell
// through to a filler that pasted the internal names straight onto the screen:
//
//     "I have a consistent way I handle feedback_pref (blunt)."
//     "I have a consistent way I handle how I weigh speed against quality (0.85)."
//
// and the subject was asked to decide between two of those. Endorsing one also wrote that sentence
// into their standing rules, where it was injected into every chat. Randy, 2026-10-08: "they are
// unusable ... what do they even mean?"
//
// THE FIX, in one module so every surface says the same thing:
//   - `phrase(field, value)` — one written sentence for every trait and every value it can take,
//     from both vocabularies that produce them (the extraction catalog and the interview). Scale
//     traits (0..1) read as words: 0.15 on speed-vs-quality is "favor speed", never "0.15". A test
//     (scripts/test_trait_phrases.mjs) walks both vocabularies and fails on any gap, so the filler
//     cannot creep back.
//   - `isSubstantive(field, from, to)` — a change worth asking about. Two different words for the
//     same choice ("quality" / 0.8) are not a change; 0.75 → 0.85 on a scale is not a change.
//   - `reviewCards(fp)` — the one queue every review surface renders: a BEFORE and AFTER for each
//     change, a plain statement for each new pattern, only when the evidence is established
//     (FLOOR observations, the §4.7 resolution floor) and the change is substantive. Smaller
//     shifts still teach Phaedo; they just don't interrupt.
//   - `upgradeFillerRules(rules)` — rewrites rules already accepted in the old filler wording.
//
// Pure + dependency-free. UMD: a classic script in popup.html (globalThis.PhaedoTraitPhrases), a
// side-effect import in extraction/rule-promotion.js, `require` in Node. The phone runs a
// BYTE-IDENTICAL copy at mobile/src/lib/trait-phrases.js (Metro cannot import outside mobile/);
// the test asserts the two files are identical.

(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // node test / Metro
  if (typeof globalThis !== 'undefined') globalThis.PhaedoTraitPhrases = api;  // popup global
})(function () {
  'use strict';

  // Established evidence: the same bar §4.7 uses to let behaviour override what the subject said
  // (extraction/resolve.js RESOLUTION_FLOOR) and rule promotion uses to propose a rule.
  const FLOOR = 3;

  // Scale traits are stored 0..1. Three plain readings; the word, never the number, is shown.
  const LOW = 0.4, HIGH = 0.6, MIN_MOVE = 0.3;
  const bucket = (n) => (n < LOW ? 'low' : n > HIGH ? 'high' : 'mid');

  // field → { topic, values?, scale?, aliases?, list? }
  //   topic   — completes "Phaedo noticed a change in ___" / "About ___".
  //   values  — one sentence per value.
  //   aliases — another vocabulary's word for the same choice (interview vs catalog), or a word
  //             standing for a point on the scale.
  //   scale   — [low, mid, high] sentences for a 0..1 trait.
  //   list    — (items) => sentence, for traits that hold several values at once.
  const TRAITS = {
    // ── How answers look ──
    response_length_pref: {
      topic: 'how long you like answers',
      values: {
        short: 'Keep answers short and to the point.',
        medium: 'Keep answers medium length: a few paragraphs, with structure when it helps.',
        thorough: 'Give thorough answers that go deep and cover the edge cases.',
      },
    },
    tone_register: {
      topic: 'the tone you like',
      values: {
        casual: 'Use a casual, conversational tone.',
        formal: 'Use a formal, professional tone.',
        neutral: 'Use a plain, neutral tone.',
        warm_enthusiastic: 'Use a warm, upbeat tone.',
        direct_efficient: 'Use a direct, efficient tone.',
        formal_analytical: 'Use a formal, analytical tone.',
        casual_thinking_aloud: 'Use a casual tone, thinking out loud with me.',
      },
      aliases: { s2_a: 'warm_enthusiastic', s2_b: 'direct_efficient', s2_c: 'formal_analytical', s2_d: 'casual_thinking_aloud' },
    },
    formatting_prefs: {
      topic: 'how you like answers laid out',
      items: {
        prose: 'plain paragraphs', bullets: 'bullet lists', numbered: 'numbered steps', tables: 'tables',
        headers: 'headings', code_blocks: 'code blocks', code: 'code blocks',
        inline_examples: 'examples', examples: 'examples',
      },
      list: (xs) => `Use ${xs} when they help.`,
    },
    jargon_tolerance: {
      topic: 'how much technical language you want',
      scale: [
        'Explain technical terms in plain words.',
        'Use technical terms when needed, with a quick explanation.',
        "Use technical terms freely; I know them.",
      ],
    },
    directness: {
      topic: 'how direct answers should be',
      scale: [
        'Some context before the answer is fine.',
        'Be reasonably direct.',
        'Get straight to the point, with no warm up.',
      ],
    },
    pet_peeves: {
      topic: 'things that bother you',
      list: (xs) => `Avoid these: ${xs}.`,
    },

    // ── How you work ──
    iteration_style: {
      topic: 'how you work on drafts',
      values: {
        iterative_refine: 'Work in rounds: give me a draft, then we refine it together.',
        deep_rework: 'Expect big rewrites; the first draft is just to find the shape.',
        single_pass: 'Aim for one finished answer rather than rounds of drafts.',
        light_polish: 'My first drafts are strong; help me polish them, not rewrite them.',
        significant_revision: 'I revise drafts heavily, sometimes rewriting whole sections.',
      },
      aliases: { structural_rework: 'deep_rework' },
    },
    ambiguity_response: {
      topic: 'what to do when a request is unclear',
      values: {
        ask_first: 'When my request is unclear, ask me one question before starting.',
        assume_state_proceed: 'When my request is unclear, make a sensible guess, say what it is, and carry on.',
        offer_options: 'When my request is unclear, show me two readings and let me pick.',
        assume_silent: 'When my request is unclear, make a sensible guess and just carry on.',
      },
      aliases: { assume_state: 'assume_state_proceed', offer_two: 'offer_options' },
    },
    detail_vs_principle: {
      topic: 'whether you want steps or the big idea',
      values: {
        steps: 'Give me the specific steps to follow.',
        principle: 'Explain the underlying idea so I can adapt it myself.',
        principle_first: 'Start with the big idea, then give me the steps.',
      },
      aliases: { specific_steps: 'steps', underlying_principle: 'principle', both_principle_first: 'principle_first' },
    },
    autonomy_pref: {
      topic: 'how much the assistant should do without asking',
      scale: [
        'Check with me before acting.',
        'Use your judgment on small things; check with me on big ones.',
        "Just do it; don't stop to ask permission.",
      ],
    },
    reasoning_visibility: {
      topic: 'whether you want to see the reasoning',
      values: {
        show: 'Show me your reasoning.',
        skip: 'Skip the explanation; just give me the answer.',
      },
    },
    scope_discipline: {
      topic: 'whether to stick to what you asked',
      values: {
        stay_scoped: 'Stick to exactly what I asked.',
        wants_proactive: 'Point out things I might be missing, beyond what I asked.',
      },
    },

    // ── How you think ──
    quality_word: {
      topic: 'what good work means to you',
      values: {
        elegant: 'Good work is elegant: simple and clean.',
        rigorous: 'Good work is rigorous: precise and exact.',
        clear: 'Good work is clear above all.',
        surprising: 'Good work is surprising: an angle nobody else took.',
        useful: 'Good work is useful: practical and it gets the job done.',
        honest: 'Good work is honest.',
        beautiful: 'Good work is beautiful.',
      },
    },
    problem_solving_move: {
      topic: 'how you tackle hard problems',
      values: {
        decompose: 'When a problem is hard, I break it into smaller parts.',
        analogize: "When a problem is hard, I look for a similar problem I've solved.",
        map_system: 'When a problem is hard, I map out the system and how the parts connect.',
        discuss: 'When a problem is hard, I talk it through.',
        sketch: 'When a problem is hard, I sketch or write to find its shape.',
        sit_with: 'When a problem is hard, I sit with it until the structure shows up.',
      },
      aliases: { break_down: 'decompose', similar_problem: 'analogize', talk_through: 'discuss', sketch_write: 'sketch', sit_with_it: 'sit_with' },
    },
    mental_model_inventory: {
      topic: 'the ways you tend to think',
      items: {
        first_principles: 'first principles', systems_thinking: 'systems', theory_of_constraints: 'bottlenecks',
        second_order_effects: 'knock-on effects', tradeoff_reasoning: 'tradeoffs', analogical_reasoning: 'analogies',
        decomposition: 'breaking things down', scenario_planning: 'scenarios',
      },
      list: (xs) => `I tend to think in terms of ${xs}.`,
    },

    // ── What you know ──
    primary_expertise: { topic: 'your main work', list: (xs) => `My main work: ${xs}.` },
    domain_depth_pref: {
      topic: 'how deep to go in your own field',
      values: {
        surface: 'In my own field, keep it high level; I just need the answer.',
        full_technical: 'In my own field, give me the full technical detail.',
        match_my_question: 'In my own field, match the depth of my question.',
      },
      aliases: { full_detail: 'full_technical', match_signal: 'match_my_question' },
    },
    active_learning_areas: { topic: 'what you are learning', list: (xs) => `I'm currently learning: ${xs}.` },
    domain_vocabulary: { topic: 'the terms you use', list: (xs) => `Terms I use: ${xs}.` },
    expertise_level: {
      topic: 'how much you already know',
      values: {
        power: 'Treat me as an expert.',
        technical: "Assume I'm technical, but not a specialist.",
        general: "Don't assume technical knowledge.",
      },
    },
    learning_style: {
      topic: 'how you learn best',
      items: {
        reading: 'reading', watching: 'watching someone do it', doing_badly: 'doing it badly and improving',
        discussing: 'talking it through', examples: 'studying examples', building_small: 'building a small version',
      },
      list: (xs) => `I learn best by ${xs}.`,
    },

    // ── Pace and context ──
    early_project_mode: {
      topic: 'how you start new projects',
      values: {
        explore_wide: 'Early in a project, explore widely before narrowing down.',
        frame_then_explore: 'Early in a project, quickly frame the shape, then explore inside it.',
        commit_fast: 'Early in a project, find one good path and commit to it fast.',
      },
    },
    urgency_baseline: {
      topic: 'how much of a hurry you are usually in',
      scale: [
        'No rush; take the time to get it right.',
        'A normal pace is fine.',
        "I'm usually short on time; get me something usable fast.",
      ],
    },
    working_mode: {
      topic: 'whether you are exploring or building',
      values: {
        exploring: "I'm usually still exploring and thinking things through.",
        build_mode: "I'm usually in build mode, ready to make things.",
      },
    },
    pressure_response: {
      topic: 'what happens when you are under pressure',
      items: {
        terser: 'I get terser', cut_detail: 'I cut detail', lean_patterns: 'I lean on familiar patterns',
        decisive_fast: 'I make fast calls', more_collab: 'I pull others in', less_collab: 'I just execute',
        quality_slips: 'quality starts to slip',
      },
      list: (xs) => `Under pressure, ${xs}.`,
    },

    // ── Working with people ──
    audience_adaptation: {
      topic: 'how you explain things to people who know less',
      values: {
        simplify_aggressive: 'When writing for people who know less, simplify hard, even at some cost to accuracy.',
        accuracy_slow: 'When writing for people who know less, stay accurate but slow down and define terms.',
        same_level: 'When writing for people who know less, keep it at my level and trust them to ask.',
        pull_up: 'When writing for people who know less, meet them where they are and bring them up gradually.',
      },
      aliases: { simplify_hard: 'simplify_aggressive', match_pull_up: 'pull_up' },
    },
    disagreement_style: {
      topic: 'how to handle disagreement',
      values: {
        push_back_now: 'If you disagree, push back right away.',
        ask_first: 'If you disagree, first ask questions to understand my reasoning.',
        revisit_later: 'If you disagree, note it and raise it later.',
        disagree_commit: 'If you disagree, say so once, then go with my call.',
      },
      aliases: { note_revisit: 'revisit_later' },
    },
    feedback_pref: {
      topic: 'how you like feedback',
      values: {
        blunt: "Give blunt feedback: just tell me what's wrong.",
        direct_balanced: "Be direct with feedback, but include what's working.",
        diplomatic: 'Give feedback gently, framed as suggestions.',
        depends: 'Match feedback to the stakes: blunt when it matters, gentler when it does not.',
      },
    },

    // ── Decisions ──
    ambiguity_posture: {
      topic: 'how decisive to be when things are unclear',
      values: {
        default: 'When things are unclear, be decisive rather than hedging.',
        ask: 'When things are unclear, ask me before deciding.',
        delay: 'When things are unclear, wait rather than commit too early.',
      },
      // The request-level words (ambiguity_response) for "guess and carry on" mean be decisive here.
      aliases: { assume_state_proceed: 'default', assume_silent: 'default', assume_state: 'default' },
    },
    evidence_threshold: {
      topic: 'how sure you need to be before committing',
      scale: [
        "A rough estimate is fine; I don't need everything nailed down.",
        "Get the key facts right, but don't over research.",
        'Cover the main risks and nail down the key facts before I commit.',
      ],
      aliases: { high: 0.8, low: 0.2 },
    },
    options_vs_recommendation: {
      topic: 'whether you want options or one recommendation',
      values: {
        single_recommendation: 'Give me one clear recommendation, not a list of options.',
        option_set: 'Show me a few options and let me make the call.',
      },
    },
    speed_vs_quality: {
      topic: 'how you balance speed and quality',
      scale: [
        'Favor speed: good enough now beats perfect later.',
        'Balance speed and quality.',
        'Favor quality: getting it right matters more than being fast.',
      ],
      aliases: { speed: 0.15, quality: 0.8, accuracy: 0.8 },
    },
    reversible_vs_irreversible: {
      topic: "how you handle decisions you can't undo",
      values: {
        more_cautious: "On decisions I can't undo, I slow down and get more input.",
        consistent_style: 'I bring the same care to a decision whether or not it can be undone.',
        longer_think: "On decisions I can't undo, I think longer, but decide the same way.",
        fast_adjust: 'I decide quickly when I can fix it later.',
        careful_still: 'I think carefully even when a decision can be undone.',
        depends_stakes: 'How carefully I decide depends on the stakes.',
      },
    },

    // ── Big picture ──
    stable_principles: { topic: 'the principles you hold', list: (xs) => `Principles I hold: ${xs}.` },
    process_narration_pref: {
      topic: 'whether to narrate the work',
      values: {
        skip_meta: "Skip the commentary about what you're doing; just do it.",
        show_meta: 'Think out loud: tell me your plan as you go.',
      },
    },
  };
  // The interview's names for traits the catalog spells differently.
  const FIELD_ALIASES = { reversibility_sensitivity: 'reversible_vs_irreversible' };

  const traitOf = (field) => TRAITS[field] || TRAITS[FIELD_ALIASES[field]] || null;
  const words = (s) => String(s).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sentenceCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  function joinWords(xs) {
    if (xs.length <= 1) return xs.join('');
    return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  }

  /** Completes "About ___" / "a change in ___". Never an internal name. */
  function topic(field) {
    const t = traitOf(field);
    return t ? t.topic : words(field || 'this');
  }

  /** The canonical form of a value: an alias resolved, a numeric string read as a number. */
  function canonical(field, value) {
    const t = traitOf(field);
    let v = Array.isArray(value) && value.length === 1 ? value[0] : value;
    if (typeof v === 'string' && /^\s*-?\d*\.?\d+\s*$/.test(v)) v = Number(v);
    if (t && t.aliases && typeof v === 'string' && Object.prototype.hasOwnProperty.call(t.aliases, v)) v = t.aliases[v];
    return v;
  }

  /** One plain sentence for a (trait, value). Never shows an underscore, a field name or a 0..1 number. */
  function phrase(field, value) {
    const t = traitOf(field);
    const v = canonical(field, value);
    if (t) {
      if (t.scale && typeof v === 'number' && Number.isFinite(v)) {
        return t.scale[{ low: 0, mid: 1, high: 2 }[bucket(v)]];
      }
      if (t.values && typeof v === 'string' && t.values[v]) return t.values[v];
      if (t.list && (Array.isArray(v) || typeof v === 'string')) {
        const xs = (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '')
          .map((x) => (t.items && t.items[x]) || words(x));
        if (xs.length) return t.list(joinWords(xs));
      }
    }
    // Unknown trait or value: still a sentence a person can read.
    const about = sentenceCase(t ? t.topic : words(field || 'this'));
    if (typeof v === 'number' && Number.isFinite(v)) return `${about}: ${{ low: 'low', mid: 'in the middle', high: 'high' }[bucket(v)]}.`;
    if (v == null || typeof v === 'object') return `${about}.`;
    return `${about}: ${words(v)}.`;
  }

  /** Two values that name the same choice ("quality" and 0.8; "steps" and "specific_steps"). */
  function sameChoice(field, a, b) {
    const x = canonical(field, a), y = canonical(field, b);
    if (typeof x === 'number' && typeof y === 'number') return bucket(x) === bucket(y) || Math.abs(x - y) < MIN_MOVE;
    return JSON.stringify(x) === JSON.stringify(y);
  }

  /** A change worth putting in front of the subject: a different choice, not a nudge on a scale. */
  function isSubstantive(field, from, to) {
    if (from == null || to == null) return false;
    // List traits (formats, principles, …) add up rather than replace; they never conflict.
    const t = traitOf(field);
    if (Array.isArray(from) || Array.isArray(to) || (t && t.list)) return false;
    const x = canonical(field, from), y = canonical(field, to);
    if (Array.isArray(x) || Array.isArray(y) || typeof x === 'object' || typeof y === 'object') return false;
    if ((typeof x === 'number') !== (typeof y === 'number')) return true;
    return !sameChoice(field, x, y);
  }

  // ── The review queue every surface renders ──────────────────────────────────

  const countOf = (c) => (c && Number.isFinite(c.observation_count) ? c.observation_count : 0);

  /**
   * The decisions waiting for the subject, oldest kind first, as cards:
   *   { kind: 'change',  id, field, topic, before, after, count, source: 'override'|'conflict',
   *                      beforeValue, afterValue }
   *   { kind: 'pattern', id, field, topic, text, count }
   * Only established, substantive changes. `fp` is a fingerprint; anything else yields [].
   * Authorization suggestions (§10.7) are not trait wording and are left to their own card.
   */
  function reviewCards(fp, opts) {
    const floor = (opts && opts.floor) || FLOOR;
    const out = [];
    const records = Array.isArray(fp && fp.conflict_records) ? fp.conflict_records : [];
    for (const c of records) {
      if (!c || !c.field) continue;
      const cands = Array.isArray(c.candidates) ? c.candidates : [];
      const stated = cands.find((o) => o && o.evidence_basis === 'self_reported');
      if (c.status === 'resolved' && c.resolution && c.resolution.by === 'system') {
        // Behaviour already crossed the floor and overrode the interview answer.
        const before = c.resolution.prior_value, after = c.resolution.chosen_value;
        if (!isSubstantive(c.field, before, after)) continue;
        const seen = cands.filter((o) => o && o.evidence_basis !== 'self_reported').reduce((m, o) => Math.max(m, countOf(o)), 0);
        out.push({ kind: 'change', source: 'override', id: c.conflict_id, field: c.field, topic: topic(c.field),
          before: phrase(c.field, before), after: phrase(c.field, after), beforeValue: before, afterValue: after, count: seen });
      } else if (c.status === 'open' && stated) {
        // A thin contradiction is not shown: one chat is not a change. Only once the new
        // behaviour is established does it become a question.
        const observed = cands.filter((o) => o && o.evidence_basis !== 'self_reported' && o.value != null)
          .sort((a, b) => countOf(b) - countOf(a))[0];
        if (!observed || countOf(observed) < floor) continue;
        if (!isSubstantive(c.field, stated.value, observed.value)) continue;
        out.push({ kind: 'change', source: 'conflict', id: c.conflict_id, field: c.field, topic: topic(c.field),
          before: phrase(c.field, stated.value), after: phrase(c.field, observed.value),
          beforeValue: stated.value, afterValue: observed.value, count: countOf(observed) });
      }
    }
    const sugs = Array.isArray(fp && fp.suggested_rules) ? fp.suggested_rules : [];
    for (const s of sugs) {
      if (!s || s.status !== 'suggested' || s.kind === 'authorization') continue;
      const field = s.decision && s.decision.dimension;
      const ev = s.evidence || {};
      const text = field && ev.value != null ? phrase(field, ev.value) : upgradeFillerText(s.proposed_text, field) || String(s.proposed_text || '');
      if (!text) continue;
      out.push({ kind: 'pattern', id: s.suggestion_id, field, topic: topic(field), text, count: countOf(ev), value: ev.value });
    }
    return out;
  }

  // ── Rules already accepted in the old wording ────────────────────────────────

  const FILLER = /^I have a consistent way I handle (.+?)(?: \((.*)\))?\.?$/;

  /** The plain sentence for a rule written in the old filler wording, or null if it is not one. */
  function upgradeFillerText(text, field) {
    const m = FILLER.exec(String(text || '').trim());
    if (!m || !field || !traitOf(field) || m[2] == null || m[2] === '') return null;
    const out = phrase(field, m[2]);
    return out && !FILLER.test(out) ? out : null;
  }

  /** Same array when nothing needs rewording; a new array with plain sentences otherwise. */
  function upgradeFillerRules(rules) {
    if (!Array.isArray(rules)) return rules;
    let changed = false;
    const next = rules.map((r) => {
      const t = r && upgradeFillerText(r.text, r.decision && r.decision.dimension);
      if (!t) return r;
      changed = true;
      return { ...r, text: t };
    });
    return changed ? next : rules;
  }

  // ── "Why am I seeing this?" ──────────────────────────────────────────────────
  //
  // Two kinds of evidence, both safe to keep:
  //   - what the subject PICKED in the interview — the option's own label, read from the
  //     questionnaire schema the caller passes in (the popup's and the phone's copies are the same);
  //   - CUE PHRASES: catalog vocabulary ("keep it short", "don't sugarcoat") that appeared in the
  //     subject's own messages, collected by extraction/why-cues.js. Only words from Phaedo's fixed
  //     vocabulary are ever kept — never the surrounding sentence — because conversation text must
  //     never be written to disk (capture privacy §3.1) and a behavioural model must never carry
  //     episodic content (§4.6). Kept in the local vault only; never synced, injected or exported.

  // Interview question → trait, for the single-answer questions (migration.js FIELD_MAP; the
  // test asserts the two agree).
  const INTERVIEW_QUESTIONS = {
    s1: 'response_length_pref', s4: 'jargon_tolerance', b2: 'iteration_style', b3: 'ambiguity_response',
    b4: 'detail_vs_principle', cr1: 'quality_word', cr2: 'problem_solving_move', d2: 'domain_depth_pref',
    t1: 'early_project_mode', c1: 'audience_adaptation', c2: 'feedback_pref', c3: 'disagreement_style',
    r1: 'speed_vs_quality',
  };

  function findQuestion(schema, id) {
    let hit = null;
    (function walk(o) {
      if (hit || !o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o.id === id && o.type) { hit = o; return; }
      Object.values(o).forEach(walk);
    })(schema);
    return hit;
  }

  /** The interview option the subject picked for this (trait, value), in the interview's own words, or null. */
  function interviewAnswer(schema, field, value) {
    if (!schema || value == null) return null;
    for (const [qid, f] of Object.entries(INTERVIEW_QUESTIONS)) {
      if (f !== field && FIELD_ALIASES[f] !== field) continue;
      const q = findQuestion(schema, qid);
      if (!q) continue;
      if (Array.isArray(q.options)) {
        const o = q.options.find((x) => x && x.value != null && sameChoice(field, x.value, value));
        if (o && o.label) return o.label;
      }
      const v = canonical(field, value);
      if (q.type === 'slider' && typeof v === 'number') {
        const b = bucket(v);
        if (b === 'low' && q.anchor_left) return q.anchor_left;
        if (b === 'high' && q.anchor_right) return q.anchor_right;
        if (q.anchor_left && q.anchor_right) return `In between "${q.anchor_left}" and "${q.anchor_right}"`;
      }
    }
    return null;
  }

  const cueKey = (field, value) => {
    const v = canonical(field, value);
    return `${field}::${typeof v === 'number' ? bucket(v) : JSON.stringify(v)}`;
  };
  const quoteList = (xs) => joinWords(xs.map((x) => `"${x}"`));
  const timesText = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

  /**
   * One or two short sentences answering "Why am I seeing this?" for a review card.
   *   opts.schema — the interview questionnaire schema (for what the subject picked)
   *   opts.cues   — the local cue store: { "<field>::<value>": { cues: [...] } }
   */
  function whyText(card, opts) {
    const schema = opts && opts.schema;
    const store = (opts && opts.cues) || {};
    const cuesOf = (value) => {
      const e = store[cueKey(card.field, value)];
      return e && Array.isArray(e.cues) ? e.cues.slice(0, 3) : [];
    };
    const n = card.count || 0;
    if (card.kind === 'change') {
      const picked = interviewAnswer(schema, card.field, card.beforeValue);
      const cues = cuesOf(card.afterValue);
      const first = picked ? `In your interview you picked "${picked}".` : 'This is what you told Phaedo before.';
      const second = cues.length
        ? `Since then you've said things like ${quoteList(cues)}${n > 1 ? ` (${timesText(n)})` : ''}.`
        : n > 0 ? `Since then your conversations have pointed the other way ${timesText(n)}.` : '';
      return [first, second].filter(Boolean).join(' ');
    }
    const cues = cuesOf(card.value);
    if (cues.length) return `You've said things like ${quoteList(cues)}${n > 1 ? ` (${timesText(n)})` : ''}.`;
    return n > 0 ? `Phaedo has seen this ${timesText(n)} in your conversations.` : 'Phaedo has seen this in your conversations.';
  }

  // ── Reviewing the rules already in place ─────────────────────────────────────

  const normText = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const ruleId = (r) => (r && (r.instruction_id || r.id)) || null;

  /** Which choice a rule's sentence states, when it is one of the phrasebook's own sentences. */
  function ruleChoice(rule) {
    const field = rule && rule.decision && rule.decision.dimension;
    const t = traitOf(field);
    if (!t || !rule.text) return null;
    const text = String(rule.text).trim();
    if (t.scale) {
      const i = t.scale.indexOf(text);
      if (i >= 0) return [0.15, 0.5, 0.85][i];
    }
    if (t.values) for (const [v, sentence] of Object.entries(t.values)) if (sentence === text) return v;
    return null;
  }

  /**
   * Every authored instruction, grouped for a one-at-a-time review — the ones that need a look first:
   *   { type: 'disagree',  topic, rules }  — two or more rules on one trait that say different things
   *   { type: 'duplicate', rules }         — the same rule more than once (rules[0] is the one to keep)
   *   { type: 'unclear',   rules }         — still in the old filler wording, with nothing to recover
   *   { type: 'rule',      rules }         — everything else, one per card
   * `key` identifies the item so a "keep" can be remembered. §10.7 authorizations are not wording
   * and have their own surface, so they are left out.
   */
  function ruleReviewItems(rules) {
    const list = (Array.isArray(rules) ? rules : [])
      .filter((r) => r && r.kind !== 'authorization' && typeof r.text === 'string' && r.text.trim() && ruleId(r));
    const used = new Set();
    const items = [];
    const key = (type, rs) => `${type}:${rs.map(ruleId).sort().join(',')}`;

    // Same trait, different choices.
    const byField = new Map();
    for (const r of list) {
      const f = r.decision && r.decision.dimension;
      const c = ruleChoice(r);
      if (!f || c == null) continue;
      if (!byField.has(f)) byField.set(f, []);
      byField.get(f).push([r, c]);
    }
    for (const [f, rs] of byField) {
      const distinct = rs.filter(([, c], i) => rs.findIndex(([, d]) => sameChoice(f, c, d)) === i);
      if (distinct.length < 2) continue;
      const group = rs.map(([r]) => r);
      group.forEach((r) => used.add(ruleId(r)));
      items.push({ type: 'disagree', topic: topic(f), rules: group, key: key('disagree', group) });
    }
    // The same rule twice.
    const seen = new Map();
    for (const r of list) {
      if (used.has(ruleId(r))) continue;
      const k = `${(r.decision && r.decision.dimension) || ''}|${normText(r.text)}`;
      if (!seen.has(k)) { seen.set(k, [r]); continue; }
      seen.get(k).push(r);
    }
    for (const group of seen.values()) {
      if (group.length < 2) continue;
      group.forEach((r) => used.add(ruleId(r)));
      items.push({ type: 'duplicate', rules: group, key: key('duplicate', group) });
    }
    for (const r of list) {
      if (used.has(ruleId(r)) || !FILLER.test(String(r.text).trim())) continue;
      used.add(ruleId(r));
      items.push({ type: 'unclear', rules: [r], key: key('unclear', [r]) });
    }
    for (const r of list) {
      if (used.has(ruleId(r))) continue;
      items.push({ type: 'rule', rules: [r], key: key('rule', [r]) });
    }
    return items;
  }

  return { FLOOR, TRAITS, INTERVIEW_QUESTIONS, topic, phrase, canonical, sameChoice, isSubstantive, reviewCards,
           upgradeFillerText, upgradeFillerRules, interviewAnswer, cueKey, whyText, ruleChoice, ruleReviewItems };
});
