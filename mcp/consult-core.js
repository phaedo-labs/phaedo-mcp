// Phaedo §10 Agent Consultation — the PURE resolver core.
//
// resolveConsultationCore(vd, request[, opts]) -> §10.3 response. PURE: no browser
// globals, no chrome, no fs, no network, no model, no process, no side effects —
// the same discipline that makes context-block.js reusable across runtimes. The
// OPTIONAL local model judge and all transport/config live in consult.js (the MCP
// wrapper). Keeping the deterministic shapes here and the model there makes the
// open-core line a file boundary (brief Invariant 7): this file is the publishable
// reference resolver; the judge is the proprietary-side upgrade that wraps it.
//
// Resolution order (deterministic → authored): (A) inferred Decision/Risk signal,
// confidence-gated; (B) abstain floor — if NO relevant cue was found, return
// `insufficient_signal` rather than a confidently-wrong guess (§10.3); (C) authored
// standing policies (§10.5) override either, so a hard guardrail wins even over an
// abstain. Signals out, never structure out (§10.4).

import { PhaedoError } from './errors.js';
import { loadPolicies, applyPolicies, matchAuthorization } from './consult-policy.js';

export const CONSULTATION_TYPES = [
  'action_approval',
  'voice_draft',
  'domain_risk_check',
  'escalation_default',
];

// §10.3 signal enum. `insufficient_signal` (abstain) is the producer declining to
// answer for lack of coverage — distinct from `clarify` (gather more) and from an
// error. Folded into the spec at v0.1.9 (proposal 0001).
export const SIGNALS = ['proceed', 'proceed_with_note', 'clarify', 'escalate', 'decline', 'insufficient_signal'];
const MAGNITUDES = ['low', 'medium', 'high'];

// NOTE: for UNTAGGED signals (all fingerprints today), coverage is fingerprint-WIDE —
// a rich fingerprint never abstains on an unfamiliar domain. As domain-TAGGED
// Decision&Risk signals accrue (extraction/domain-inference.js prototype), coverage
// becomes per-domain naturally: signals tagged for a different domain are skipped,
// so a fingerprint whose relevant signals are all wrong-domain abstains here.
const ABSTAIN_HINT =
  'The fingerprint has no decision/risk coverage to ground a signal, so the oracle ' +
  'abstains — fall back to your own default or escalate to the subject.';

// §4.7: distinct from "no coverage" — coverage EXISTS but the dimension(s) this action
// turns on are under an open conflict the subject hasn't settled, so the oracle withholds
// a signal (the consult-side mirror of injection suppression). Escalate, don't assume.
const CONTESTED_HINT =
  'The subject is actively reconciling a contradiction on the decision dimension this ' +
  'action turns on, so the oracle withholds a signal until they settle it — escalate to ' +
  'the subject rather than assume a default.';

// ── vd contract guard (brief M0.4) ────────────────────────────────────────────
// The consultation boundary's mirror of context-block.js validateVaultData (which
// cannot be imported here — it is a classic browser script; the two are kept in
// agreement by scripts/test_context_block_snapshots.mjs's cross-check). A breach
// throws a structured PhaedoError naming the violating field — a malformed vault
// payload is a producer bug and must never be resolved silently with partial data.
// A MISSING fingerprint stays `decryption_failed` (the source had nothing), and
// weird-but-conforming content (odd signal values, empty layers) still resolves
// defensively — this guard rejects only type breaches of the documented vd shape
// (spec/schemas/vault-data.schema.json).
const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export function validateVaultShape(vd) {
  const errors = [];
  if (!isPlainObject(vd)) return ['vault data must be a plain object'];
  const fp = vd.phaedo_fingerprint;
  if (fp !== undefined && fp !== null) {
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
  return errors;
}

function assertVaultUsable(vd) {
  if (!vd || !vd.phaedo_fingerprint) {
    throw new PhaedoError('decryption_failed', 'No fingerprint available from the configured source.');
  }
  const errors = validateVaultShape(vd);
  if (errors.length) {
    throw new PhaedoError('internal_error', `vault data malformed: ${errors.join('; ')}`);
  }
}

// ── Low-level fingerprint reads (defensive; never throw) ──────────────────────
function layer(vd, id) { return vd?.phaedo_fingerprint?.layers?.[id]; }

// Evidence basis of a signal, derived from its `source` (proposal 0002 vocabulary).
// Drives how much a cue's per-signal confidence is trusted (below): observed/
// corroborated learned signals > self-reported questionnaire answers > a bare
// keyword hit in free text.
function evidenceBasis(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('corrobor') || s.includes('reconcil')) return 'corroborated';
  if (s.includes('question') || s.includes('self') || s.includes('interview')) return 'self_reported';
  return 'observed'; // extraction/delta-sourced structured signals
}
const BASIS_WEIGHT = { observed: 1.0, corroborated: 1.0, self_reported: 0.9, text_scan: 0.75 };
// The act-as-me channel: a `delegation`-origin cue (how the subject wants work done FOR
// them) reads as MORE authoritative for a consult — an agent is about to act on their
// behalf — so it is boosted above a `self`-origin one. `self` is the neutral 1.0, so
// today's all-self fingerprints are unchanged; the per-cue product is clamped to 1.0.
const ORIGIN_WEIGHT = { delegation: 1.15, self: 1.0 };

// Does a signal's §4.2.7 domain tag pertain to the action's domain? Same
// case-insensitive substring convention as authored policies (either direction:
// signal "financial" matches action "financial services" and vice versa).
function domainMatches(sigDomain, actionDomain) {
  const a = String(sigDomain).toLowerCase(), b = String(actionDomain).toLowerCase();
  return a.includes(b) || b.includes(a);
}

// ── Open-conflict suppression (§4.7, the consult-side mirror of injection) ──────
// When a dimension has an OPEN conflict_record (the subject's self-report and a fresh
// observation disagree, not yet settled), the injection projection withholds it from
// the layer summary (extraction/reconcile.js openConflictFieldKeys → renderLayerSummary
// suppress). Consult reads the raw signals, not the summary, so it must withhold the
// SAME contested dimensions itself — otherwise an agent gets a confident answer on a
// dimension the subject is still deciding. A withheld cue counts as "not found", so if
// every relevant cue is contested, coverage→0 and the resolver abstains (below). Field
// keys mirror reconcile.js: `field` (untagged → fingerprint-wide) or `field::domain`.
function openConflictKeys(vd) {
  const recs = vd?.phaedo_fingerprint?.conflict_records;
  const set = new Set();
  for (const r of (Array.isArray(recs) ? recs : [])) {
    if (r && r.status === 'open' && r.field) set.add(r.field + (typeof r.domain === 'string' ? `::${r.domain}` : ''));
  }
  return set;
}
// Is `field` contested for this action? An UNTAGGED open conflict suppresses it
// fingerprint-wide (matching untagged signals' fingerprint-wide reach); a domain-TAGGED
// conflict suppresses only when the action's domain matches.
function isFieldContested(suppressed, field, actionDomain) {
  if (!suppressed || !suppressed.size) return false;
  if (suppressed.has(field)) return true;
  if (actionDomain) {
    for (const key of suppressed) {
      const i = key.indexOf('::');
      if (i > 0 && key.slice(0, i) === field && domainMatches(key.slice(i + 2), actionDomain)) return true;
    }
  }
  return false;
}

// Resolve a relevant cue to { text, confidence, basis, origin }, preferring a structured
// §4.2 signal (which carries a real per-signal confidence + provenance) over a
// dimensioned questionnaire response. Returns undefined when neither is present
// (caller falls back to a free-text keyword scan). Positive/neutral polarity only.
//
// Domain preference (PROTOTYPE, §4.2.7 optional `domain`): when the action carries
// a domain, a signal TAGGED with a matching domain wins; an UNTAGGED signal is the
// fallback (today's fingerprint-wide behavior); a signal tagged with a DIFFERENT
// domain is skipped — financial caution must not drive a writing decision. When
// the action has no domain, tags are ignored (any field-matching signal serves).
//
// Origin preference (the act-as-me channel, §4.2 `origin`): a `delegation`-origin
// signal — learned from the subject CORRECTING an agent acting on their behalf —
// OUTRANKS a `self`-origin one for the same dimension. A consultation IS an agent
// about to act on the subject's behalf (§10), so how they want work done FOR them
// dominates how they do it themselves. Absent `origin` ⇒ `self`, so today's
// (all-self) fingerprints are unaffected — this only bites once delegation signals exist.
function signalCue(vd, layerId, fields, actionDomain) {
  const L = layer(vd, layerId);
  if (!L) return undefined;
  const want = new Set(fields);
  const asCue = (s) => {
    const confidence = typeof s.confidence === 'number' ? Math.max(0, Math.min(1, s.confidence)) : 0.6;
    // Prefer the producer-emitted evidence_basis (proposal 0002); else derive from source.
    const basis = typeof s.evidence_basis === 'string' ? s.evidence_basis : evidenceBasis(s.source);
    const origin = s.origin === 'delegation' ? 'delegation' : 'self';
    return { text: String(Array.isArray(s.value) ? s.value.join(' ') : s.value).toLowerCase(), confidence, basis, origin };
  };
  // Score each matching signal and keep the best. tier = domain relevance (a domain
  // match outranks an untagged fallback, as before); within a tier, `delegation`
  // outranks `self`. Ties keep document order (first wins) — so for today's all-self,
  // mostly-untagged fingerprints the selection is identical to the prior first-match.
  let best;
  for (const s of (L.signals || [])) {
    if (!(s && want.has(s.field) && (s.polarity ?? 'positive') !== 'negative' && s.value != null)) continue;
    let tier;
    if (typeof s.domain === 'string' && actionDomain) {
      if (!domainMatches(s.domain, actionDomain)) continue;             // wrong domain — skip
      tier = 2;                                                          // domain match
    } else if (typeof s.domain === 'string') {
      tier = 1;                                                          // tagged, action domain-free
    } else {
      tier = 0;                                                          // untagged fallback (today's norm)
    }
    const score = tier * 2 + (s.origin === 'delegation' ? 1 : 0);
    if (!best || score > best.score) best = { score, cue: asCue(s) };
  }
  if (best) return best.cue;
  for (const r of (L.responses || L.answers || [])) {
    const dim = r?.dimension || r?.field;
    const v = r?.value ?? r?.answer;
    if (dim && want.has(dim) && v != null) return { text: String(v).toLowerCase(), confidence: 0.7, basis: 'self_reported', origin: 'self' };
  }
  return undefined;
}

// All free-text the layer carries (interview answers + learned summary), lowercased
// — the fallback corpus for the keyword scan when a clean signal isn't present.
function layerText(vd, layerId) {
  const L = layer(vd, layerId);
  if (!L) return '';
  const parts = [];
  for (const r of (L.responses || [])) if (r?.answer) parts.push(String(r.answer));
  for (const r of (L.answers || []))   { const v = r?.answer ?? r?.value; if (v != null) parts.push(String(v)); }
  if (typeof L.summary === 'string') parts.push(L.summary);
  return parts.join('  \n  ').toLowerCase();
}

const hit = (text, needles) => needles.some(n => text.includes(n));

// ── Cue catalog ───────────────────────────────────────────────────────────────
// Each cue resolves a lean from a signal field if present, else from a keyword
// scan of its layers' text. lean: +1 = cautious/high-bar, -1 = bold/fast, 0 = unknown.
// Keywords are DIRECTIONAL phrases, not bare words — "quality over speed" must
// read as cautious even though it contains "speed".
const CUES = {
  irreversibleCaution: {
    layers: ['decision_and_risk'],
    fields: ['reversible_vs_irreversible', 'irreversible_style'],
    cautious: ['more_cautious', 'more cautious', 'seek more input', 'careful_still', 'think longer', 'longer_think'],
    bold: ['consistent_style', 'consistent regardless', 'style is consistent', 'fast_adjust', 'decide fast'],
  },
  decisionThreshold: {
    layers: ['behavioral', 'decision_and_risk'],
    fields: ['decision_threshold'],
    cautious: ['cover_risks', 'covered the main risks', 'cover the main risks', 'main risks before', 'depends_reversibility'],
    bold: ['act_adjust', 'act on the best', 'adjust as i learn', 'best signal available'],
  },
  evidenceBar: {
    layers: ['decision_and_risk'],
    fields: ['evidence_bar', 'value_tradeoffs', 'evidence_threshold'],
    cautious: ['accuracy over', 'thoroughness over', 'thoroughness', 'high evidence', 'evidence bar: high', 'consistency over'],
    bold: ['speed over', 'simplicity over', 'adaptability over', 'good enough'],
  },
  speedQuality: {
    layers: ['decision_and_risk'],
    fields: ['speed_vs_quality'],
    cautious: ['quality over', 'accuracy over'],
    bold: ['speed over', 'fast over'],
  },
};

// Ambiguity has a distinct axis (ask-first vs proceed), resolved separately.
const AMBIGUITY = {
  layers: ['behavioral', 'decision_and_risk'],
  fields: ['handling_ambiguity', 'ambiguity_response', 'ambiguity_posture'],
  askFirst: ['ask_first', 'clarifying question', 'ask a clarifying', 'ask before doing'],
  proceed: ['assume_silent', 'assume_state', 'reasonable assumption', 'offer_two', 'offer two interpretations'],
};

function readCue(vd, spec, actionDomain, suppressed) {
  // §4.7: if any of this cue's fields is under an open conflict, withhold the whole cue
  // (its field-aliases name the same contested dimension). `withheld` lets the resolver
  // tell "abstaining because contested" apart from "abstaining for no coverage".
  if (suppressed && spec.fields.some((f) => isFieldContested(suppressed, f, actionDomain))) {
    return { found: false, lean: 0, confidence: 0, basis: null, withheld: true };
  }
  let cue;
  for (const lid of spec.layers) { cue = signalCue(vd, lid, spec.fields, actionDomain); if (cue) break; } // a structured §4.2 signal wins
  const text = cue ? cue.text : spec.layers.map(lid => layerText(vd, lid)).join('  ');       // else scan answers/summary
  if (!text) return { found: false, lean: 0, confidence: 0, basis: null };
  const c = hit(text, spec.cautious), b = hit(text, spec.bold);
  const found = c || b;
  const lean = (c && !b) ? 1 : (b && !c) ? -1 : 0; // both/neither → present but neutral
  // per-cue confidence + basis + origin: a structured signal carries its own; a keyword
  // hit in free text is the weakest evidence (text_scan), always self-origin.
  return {
    found, lean,
    confidence: found ? (cue ? cue.confidence : 0.6) : 0,
    basis: found ? (cue ? cue.basis : 'text_scan') : null,
    origin: found ? (cue ? cue.origin : 'self') : null,
  };
}

function readAmbiguity(vd, actionDomain, suppressed) {
  if (suppressed && AMBIGUITY.fields.some((f) => isFieldContested(suppressed, f, actionDomain))) {
    return { found: false, value: null, confidence: 0, basis: null, withheld: true };
  }
  let cue;
  for (const lid of AMBIGUITY.layers) { cue = signalCue(vd, lid, AMBIGUITY.fields, actionDomain); if (cue) break; }
  const text = cue ? cue.text : AMBIGUITY.layers.map(lid => layerText(vd, lid)).join('  ');
  const confidence = cue ? cue.confidence : 0.6;
  const basis = cue ? cue.basis : 'text_scan';
  const origin = cue ? cue.origin : 'self';
  if (hit(text, AMBIGUITY.askFirst)) return { found: true, value: 'ask_first', confidence, basis, origin };
  if (hit(text, AMBIGUITY.proceed))  return { found: true, value: 'proceed', confidence, basis, origin };
  return { found: false, value: null, confidence: 0, basis: null };
}

function personaStrength(vd) {
  const v = vd?.phaedo_fingerprint?.persona_strength;
  return typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 0.4;
}

// Build a scoped caution profile from ONLY the cues relevant to this consultation
// type (§10 relevance scoping). Returns the caution score (0..1), the coverage
// (found / relevant), the raw `found` count (0 = no relevant cue → abstain), and
// the ambiguity verdict.
function profile(vd, relevantCues, includeAmbiguity, actionDomain, suppressed) {
  let score = 0.5, found = 0, withheld = 0, total = relevantCues.length + (includeAmbiguity ? 1 : 0);
  const effConfs = []; // per-cue confidence × evidence-basis × origin weight, for the cues used
  const eff = (r) => Math.min(1, r.confidence * (BASIS_WEIGHT[r.basis] ?? 0.75) * (ORIGIN_WEIGHT[r.origin] ?? 1.0));
  for (const key of relevantCues) {
    const r = readCue(vd, CUES[key], actionDomain, suppressed);
    if (r.found) { found++; score += r.lean * 0.13; effConfs.push(eff(r)); }
    else if (r.withheld) withheld++;
  }
  let ambiguity = { found: false, value: null };
  if (includeAmbiguity) {
    ambiguity = readAmbiguity(vd, actionDomain, suppressed);
    if (ambiguity.found) { found++; if (ambiguity.value === 'ask_first') score += 0.13; effConfs.push(eff(ambiguity)); }
    else if (ambiguity.withheld) withheld++;
  }
  return {
    score: Math.max(0, Math.min(1, score)),
    coverage: total ? found / total : 0,
    found,
    withheld,
    signalConfidence: effConfs.length ? effConfs.reduce((a, b) => a + b, 0) / effConfs.length : 0,
    ambiguity,
  };
}

// Confidence + deference for a resolved consultation.
//   deference_level — breadth: RELEVANT cue coverage × persona strength (unchanged).
//   confidence — now blends that breadth with `signalConfidence`: the mean per-signal
//     confidence (evidence-basis weighted) of the cues actually used. So confidence
//     VARIES with how strong/observed the underlying Decision&Risk signals are, rather
//     than sitting flat across every action on one fingerprint (the fix for the pinned-
//     confidence critique). A fingerprint of strong observed signals reads confident; a
//     thin/keyword-only one reads low. `signalConfidence` 0 (no usable cues — e.g. the
//     abstain floor's calibrate(vd,0)) → the breadth model alone, so abstain is unchanged.
function calibrate(vd, coverage, signalConfidence = 0) {
  const ps = personaStrength(vd);
  const breadth = 0.3 + 0.4 * coverage * ps + 0.2 * ps;
  const confidence = signalConfidence > 0
    ? 0.45 * breadth + 0.55 * signalConfidence * (0.6 + 0.4 * ps)
    : breadth;
  const deference_level = (coverage >= 0.66 && ps >= 0.5) ? 'high'
                        : (coverage >= 0.33 && ps >= 0.3) ? 'medium'
                        : 'low';
  return { confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100, deference_level };
}

const magnitudeRank = (m) => ({ low: 0, medium: 1, high: 2 }[m] ?? 1);

// ── Request validation/normalization (§10.2) ──────────────────────────────────
export function normalizeRequest(request) {
  const type = request.consultation_type;
  if (!CONSULTATION_TYPES.includes(type)) {
    throw new PhaedoError('request_malformed', `Unknown consultation_type: ${type}. One of: ${CONSULTATION_TYPES.join(', ')}.`);
  }
  const ad = (request.action_descriptor && typeof request.action_descriptor === 'object') ? request.action_descriptor : {};
  let magnitude = typeof ad.magnitude === 'string' ? ad.magnitude.toLowerCase() : undefined;
  if (magnitude && !MAGNITUDES.includes(magnitude)) {
    throw new PhaedoError('request_malformed', `magnitude must be one of: ${MAGNITUDES.join(', ')}.`);
  }
  const ctx = (request.context && typeof request.context === 'object') ? request.context : {};
  const ev = ctx.evidence_provided;
  return {
    type,
    domain: typeof ad.domain === 'string' ? ad.domain : undefined,
    reversible: typeof ad.reversible === 'boolean' ? ad.reversible : undefined,
    magnitude: magnitude || 'medium',
    amount: typeof ad.amount === 'number' && isFinite(ad.amount) ? ad.amount : undefined,
    summary: typeof ad.summary === 'string' ? ad.summary : undefined,
    evidenceProvided: Array.isArray(ev) ? ev : (ev != null ? [ev] : []),
  };
}

// The Decision&Risk cues each consultation type weighs (single source of truth —
// the resolvers AND the provenance reader consultDrivers() read from here, so the
// recorded "what drove this" can never drift from what actually drove it).
const RELEVANT_CUES = {
  action_approval:    ['irreversibleCaution', 'decisionThreshold', 'evidenceBar'],
  domain_risk_check:  ['evidenceBar', 'speedQuality', 'decisionThreshold'],
  escalation_default: ['decisionThreshold', 'irreversibleCaution'],
};
const USES_AMBIGUITY = new Set(['action_approval', 'escalation_default']);

// ── Per-type resolvers → { signal, hint, coverage, found } ────────────────────
function resolveActionApproval(vd, n, suppressed) {
  const p = profile(vd, RELEVANT_CUES.action_approval, true, n.domain, suppressed);
  const irreversible = n.reversible === false;
  const mag = magnitudeRank(n.magnitude);
  const thinEvidence = n.evidenceProvided.length === 0;

  let signal;
  if (irreversible && mag >= 2) {
    signal = p.score >= 0.55 ? (thinEvidence ? 'clarify' : 'escalate')
           : p.score >= 0.4  ? 'escalate'
           : 'proceed_with_note';
  } else if (irreversible || mag >= 2) {
    signal = p.score >= 0.6 ? 'escalate'
           : (thinEvidence && p.score >= 0.45) ? 'clarify'
           : 'proceed_with_note';
  } else {
    signal = p.score >= 0.7 ? 'proceed_with_note' : 'proceed';
  }
  const domain = n.domain ? ` in the ${n.domain} domain` : '';
  const posture = p.score >= 0.55 ? 'favors caution and human review'
                : p.score <= 0.4  ? 'favors acting and adjusting'
                : 'weighs the main risks before committing';
  const hint = irreversible
    ? `On irreversible${mag >= 2 ? ', high-magnitude' : ''} actions${domain}, the subject ${posture}.`
    : `On reversible actions${domain}, the subject ${posture}.`;
  return { signal, hint, coverage: p.coverage, found: p.found, withheld: p.withheld, signalConfidence: p.signalConfidence };
}

function resolveDomainRiskCheck(vd, n, suppressed) {
  const p = profile(vd, RELEVANT_CUES.domain_risk_check, false, n.domain, suppressed);
  const high = p.score >= 0.55;
  const signal = high ? 'clarify' : p.score <= 0.4 ? 'proceed' : 'proceed_with_note';
  const where = n.domain ? ` in ${n.domain}` : '';
  const posture = high ? 'holds a high evidence bar and prefers thoroughness'
                : p.score <= 0.4 ? 'is comfortable moving on the best available signal'
                : 'balances evidence against speed';
  return { signal, hint: `Risk posture${where}: the subject ${posture}.`, coverage: p.coverage, found: p.found, withheld: p.withheld, signalConfidence: p.signalConfidence };
}

function resolveEscalationDefault(vd, n, suppressed) {
  const p = profile(vd, RELEVANT_CUES.escalation_default, true, n.domain, suppressed);
  let signal;
  if (p.ambiguity.value === 'ask_first') signal = 'clarify';
  else if (p.ambiguity.value === 'proceed') signal = 'proceed_with_note';
  else signal = p.score >= 0.55 ? 'escalate' : 'clarify';
  const hint = signal === 'clarify'
    ? 'When uncertain, the subject defaults to asking a clarifying question before acting.'
    : signal === 'escalate'
      ? 'When uncertain on consequential calls, the subject defaults to surfacing for a live decision.'
      : 'When uncertain on low-stakes calls, the subject defaults to a reasonable assumption, stated openly.';
  return { signal, hint, coverage: p.coverage, found: p.found, withheld: p.withheld, signalConfidence: p.signalConfidence };
}

// voice_draft: v0 does not generate text. Voice == style == the injection
// projection, so point the agent there (§10.4: content goes through injection).
function resolveVoiceDraft() {
  return {
    signal: 'clarify',
    hint: 'Drafting in the subject’s voice is served by the injection projection — call phaedo_request_injection and write in that style. (Generation is out of scope for consultation v0.)',
    coverage: null,
    found: null,
  };
}

// ── Provenance (local audit only — NOT the §10.3 response) ────────────────────
// The Decision&Risk cues that actually drove a consultation, for the §10.6 receipt:
// "I returned this because cues A,B,C fired at these confidences/bases." Reuses the
// resolver's exact relevance lists + readCue, so it can't drift from what drove the
// answer. Carries lean/value + confidence + evidence basis — NOT the raw layer text,
// and it lives ONLY in the local encrypted receipt, never in the response the agent
// sees (§10.4 holds: provenance is for the subject's audit/calibration, not the agent).
// Pure + defensive: bad/redirect/abstain inputs → []. Takes the raw request; normalizes
// internally so callers pass exactly what they passed to the consult.
export function consultDrivers(vd, request) {
  let n;
  try { n = normalizeRequest(request || {}); } catch { return []; }
  const keys = RELEVANT_CUES[n.type];
  if (!keys) return [];                                   // voice_draft / unknown → no inferred basis
  const suppressed = openConflictKeys(vd);                // §4.7: withhold contested cues here too,
  const drivers = [];                                     // so the receipt matches what actually drove it
  // A driver records `origin` only when it's `delegation` — the act-as-me case worth
  // flagging in the audit; omitting it for `self` keeps today's receipts byte-identical.
  const withOrigin = (d, origin) => (origin === 'delegation' ? { ...d, origin } : d);
  for (const key of keys) {
    const r = readCue(vd, CUES[key], n.domain, suppressed);
    if (r.found) drivers.push(withOrigin({ cue: key, lean: r.lean, confidence: r.confidence, basis: r.basis }, r.origin));
  }
  if (USES_AMBIGUITY.has(n.type)) {
    const a = readAmbiguity(vd, n.domain, suppressed);
    if (a.found) drivers.push(withOrigin({ cue: 'ambiguityPosture', value: a.value, confidence: a.confidence, basis: a.basis }, a.origin));
  }
  return drivers;
}

// ── Delegation producer (the act-as-me SOURCE) ────────────────────────────────
// Derive `delegation`-origin signals from the consult OVERRIDE history (§10.6 receipts)
// — the act-as-me learning half that pairs with origin-aware resolution above.
//
// Honesty rail (docs/roadmap/in-claude-outcome-marking.md): ONLY an override teaches —
// `user_action` `rejected` or `modified`, the subject correcting the agent. `approved`
// (exactly what a rubber-stamping autonomous agent would self-report) teaches NOTHING,
// so the channel can't silently collapse into "agent obedience". The corrected DIRECTION
// is read from the oracle's own signal: overriding a PERMISSIVE signal (proceed*) means
// the subject wanted MORE caution on delegated work; overriding a CAUTIOUS one
// (escalate/decline/clarify) means LESS. Each driving cue of the overridden consult is
// nudged in that direction, aggregated across receipts (net direction wins; a tie is
// genuinely ambiguous → skipped). Pure; reuses the CUES catalog so the synthesized value
// reads back through the same keyword path. A delegated correction is scoped to the
// action's domain when it had one, so a financial override never reshapes writing.
const PERMISSIVE_SIGNAL = new Set(['proceed', 'proceed_with_note']);
const CAUTIOUS_SIGNAL   = new Set(['escalate', 'decline', 'clarify']);

// A delegated correction's signed weight — direction read from the subject's action
// RELATIVE to the oracle's signal, NOT the signal class alone. This is the fix for a
// direction inversion: a lesson requires DISAGREEMENT between signal and action.
//   permissive + rejected  → +1  said go, subject didn't proceed  → wants CAUTION
//   cautious   + approved  → -1  said hold, subject proceeded     → wants BOLD
//   modified               → ±0.5 (ambiguous change; signal-relative, half weight)
//   permissive + approved  →  0  AGREEMENT (both proceed) — teaches nothing
//   cautious   + rejected  →  0  AGREEMENT (both hold)    — teaches nothing
// This keeps the anti-obedience rail intact (a rubber-stamp `approved` on a `proceed`
// signal is agreement, not a "be bolder" lesson) while no longer misreading the
// subject AGREEING with a cautious signal as a demand to be bolder — which was
// eroding the very guardrails the subject was upholding (agreement.js counts
// decline+rejected as agreement; this now matches).
function delegationCorrection(signal, userAction) {
  const permissive = PERMISSIVE_SIGNAL.has(signal);
  const cautious   = CAUTIOUS_SIGNAL.has(signal);
  if (!permissive && !cautious) return 0;                     // abstain / unknown signal
  if (userAction === 'modified') return permissive ? 0.5 : -0.5;
  if (permissive && userAction === 'rejected') return 1;      // override toward caution
  if (cautious   && userAction === 'approved') return -1;     // override toward bold (proceeded anyway)
  return 0;                                                   // agreement / unknown → no lesson
}

export function deriveDelegationSignals(receipts, { now = new Date().toISOString(), floor = 1 } = {}) {
  const tally = new Map(); // `${cue}|${domain}` → { cue, domain, sum, n }
  for (const r of (Array.isArray(receipts) ? receipts : [])) {
    const sig = r?.response?.signal;
    const contribution = delegationCorrection(sig, r && r.user_action); // signed; 0 = agreement/no lesson
    if (!contribution) continue;
    const domain = (typeof r?.request?.action_descriptor?.domain === 'string') ? r.request.action_descriptor.domain : '';
    for (const d of (Array.isArray(r.drivers) ? r.drivers : [])) {
      if (!CUES[d && d.cue]) continue;                             // scalar caution cues only (ambiguity later)
      const k = `${d.cue}|${domain}`;
      const t = tally.get(k) || { cue: d.cue, domain, sum: 0, n: 0 };
      t.sum += contribution; t.n += 1;
      tally.set(k, t);
    }
  }
  const out = [];
  for (const { cue, domain, sum, n } of tally.values()) {
    if (n < 1 || Math.abs(sum) < floor) continue;                 // need a clear, sufficient net correction
    const dir = sum > 0 ? 'cautious' : 'bold';
    out.push({
      layer: CUES[cue].layers[0],
      field: CUES[cue].fields[0],
      value: CUES[cue][dir][0],                                    // a keyword the resolver reads as this direction
      polarity: 'positive',
      origin: 'delegation',
      evidence_basis: 'observed',
      source: 'delegation_override',
      confidence: Math.min(0.9, 0.55 + 0.1 * n),
      observation_count: n,
      last_observed: now,
      ...(domain ? { domain } : {}),
    });
  }
  return out;
}

// Merge derived delegation signals into a COPY of vd's layers so the origin-aware
// resolver sees them (delegation outranks self per dimension). Pure; clones only the
// layers it touches; never mutates the input vd or its arrays. The derived signals live
// only in this per-consult in-memory vd — never persisted to the fingerprint, never
// across §10.4 (they shape the SIGNAL, they don't cross as content).
export function withDelegationSignals(vd, signals) {
  if (!Array.isArray(signals) || !signals.length || !vd || !vd.phaedo_fingerprint) return vd;
  const fp = vd.phaedo_fingerprint;
  const layers = { ...(fp.layers || {}) };
  for (const s of signals) {
    const lid = s.layer || 'decision_and_risk';
    const L = layers[lid] ? { ...layers[lid] } : {};
    const { layer, ...sig } = s;                                  // drop the routing key from the stored signal
    L.signals = [...(Array.isArray(L.signals) ? L.signals : []), sig];
    layers[lid] = L;
  }
  return { ...vd, phaedo_fingerprint: { ...fp, layers } };
}

// ── Delegation PROMOTION (the reviewable, portable act-as-me step) ────────────
// `deriveDelegationSignals` above feeds the live resolver an in-memory overlay from
// EVERY override. Promotion is the durable, reviewable step: when an override pattern is
// ESTABLISHED (|net corrections| ≥ floor on a dimension) and not already authored, stage
// a `suggested_rules` candidate — the SAME shape the §E delta-promotion review uses
// (Proposal 0007), so it rides the existing popup card + endorse path. Endorsing it
// authors a portable, delegation-origin `standing_rules` entry (syncs, shapes injection
// + consult). Pure; honesty rail inherited (only overrides count). No-nag: skip a
// dimension already authored as a delegation rule, or already staged/dismissed.
export const DELEGATION_PROMOTION_FLOOR = 3; // matches §4.7 RESOLUTION_FLOOR / §E PROMOTION_FLOOR

// Each scalar caution cue → its canonical §4.2 Decision&Risk dimension + the catalog
// value token for each corrective direction, and a first-person *delegation* sentence
// (act-as-me framing — "when you act on my behalf"). Ambiguity is excluded (its driver
// carries a value, not a lean — handled when promotion grows past the scalar cues).
const CUE_DIMENSION = {
  irreversibleCaution: 'reversible_vs_irreversible',
  decisionThreshold:   'evidence_threshold',
  evidenceBar:         'evidence_threshold',
  speedQuality:        'speed_vs_quality',
};
const DIRECTION_VALUE = {
  reversible_vs_irreversible: { cautious: 'more_cautious', bold: 'consistent_style' },
  evidence_threshold:         { cautious: 'high',          bold: 'low' },
  speed_vs_quality:           { cautious: 'quality',       bold: 'speed' },
};
const DELEGATION_TEXT = {
  reversible_vs_irreversible: { cautious: 'When you act on my behalf, slow down and check with me on decisions that are hard to undo.',
                                bold: "When acting on my behalf, treat hard-to-undo decisions like any other — don't over-escalate them." },
  evidence_threshold:         { cautious: 'When acting on my behalf, make sure the main risks are covered before you commit.',
                                bold: "When acting on my behalf, act on the best available signal — don't over-gather evidence." },
  speed_vs_quality:           { cautious: 'When acting on my behalf, favor getting it right over getting it fast.',
                                bold: 'When acting on my behalf, favor moving fast over polishing.' },
};
function delegationText(dimension, dir, domain) {
  const base = (DELEGATION_TEXT[dimension] && DELEGATION_TEXT[dimension][dir]) || `When acting on my behalf, handle ${dimension} as I've corrected you to.`;
  return domain ? base.replace(/\.$/, ` — especially on ${domain} decisions.`) : base;
}

export function buildDelegationPromotions(receipts, fp, { now = new Date().toISOString(), floor = DELEGATION_PROMOTION_FLOOR } = {}) {
  // Aggregate overrides per CANONICAL (dimension, domain): signed weight + count. Same
  // signal-relative direction rule as deriveDelegationSignals — a lesson requires the
  // subject's action to DISAGREE with the oracle's signal; agreement teaches nothing.
  const tally = new Map(); // `${dimension}|${domain}` → { dimension, domain, sum, n }
  for (const r of (Array.isArray(receipts) ? receipts : [])) {
    const sig = r?.response?.signal;
    const contribution = delegationCorrection(sig, r && r.user_action);
    if (!contribution) continue;
    const domain = (typeof r?.request?.action_descriptor?.domain === 'string') ? r.request.action_descriptor.domain : '';
    for (const d of (Array.isArray(r.drivers) ? r.drivers : [])) {
      const dim = CUE_DIMENSION[d && d.cue];
      if (!dim) continue;
      const k = `${dim}|${domain}`;
      const t = tally.get(k) || { dimension: dim, domain, sum: 0, n: 0 };
      t.sum += contribution; t.n += 1; tally.set(k, t);
    }
  }
  const keyOf = (dim, domain) => `${dim}|${domain || ''}`;
  const authored = new Set((Array.isArray(fp?.standing_rules) ? fp.standing_rules : [])
    .filter((r) => r?.decision?.origin === 'delegation' && r?.decision?.dimension)
    .map((r) => keyOf(r.decision.dimension, r.decision.domain)));
  const staged = new Set((Array.isArray(fp?.suggested_rules) ? fp.suggested_rules : [])
    .filter((s) => s?.source === 'delegation_promotion' && s?.decision?.dimension)
    .map((s) => keyOf(s.decision.dimension, s.decision.domain)));
  const out = [];
  for (const { dimension, domain, sum, n } of tally.values()) {
    if (Math.abs(sum) < floor) continue;                       // not yet established
    if (authored.has(keyOf(dimension, domain)) || staged.has(keyOf(dimension, domain))) continue; // no-nag
    const dir = sum > 0 ? 'cautious' : 'bold';
    out.push({
      suggestion_id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `dlg-${Math.random().toString(36).slice(2, 10)}`,
      status: 'suggested',
      source: 'delegation_promotion',
      proposed_text: delegationText(dimension, dir, domain),
      decision: { dimension, polarity: 'positive', origin: 'delegation', value: DIRECTION_VALUE[dimension]?.[dir], ...(domain ? { domain } : {}) },
      evidence: { observation_count: n, evidence_basis: 'observed' },
      created: now,
    });
  }
  return out;
}

// ── Honoring an AUTHORED delegation rule (the portable act-as-me preference) ──
// Once the subject ENDORSES a delegation suggestion (rule-review.js), it becomes a
// `standing_rules` instruction with `decision.origin:"delegation"` — portable: it syncs
// across devices and renders in the §9 injection "Operating rules" block verbatim. To
// also shape CONSULT, convert each such rule into a `delegation`-origin signal the
// origin-aware resolver already honors (it then OUTRANKS the subject's self pattern, and
// — authored — reads at full strength). The catalog `decision.value` token fixes the
// direction; mapped to the keyword the cue readers recognize. Pure.
const VALUE_DIRECTION = {
  more_cautious: 'cautious', consistent_style: 'bold',
  high: 'cautious', low: 'bold',
  quality: 'cautious', accuracy: 'cautious', speed: 'bold',
};
const DIMENSION_KEYWORD = {
  reversible_vs_irreversible: { cautious: 'more_cautious', bold: 'consistent_style' },
  evidence_threshold:         { cautious: 'high evidence', bold: 'good enough' },
  speed_vs_quality:           { cautious: 'quality over',  bold: 'speed over' },
};
export function authoredDelegationSignals(fp) {
  const rules = Array.isArray(fp && fp.standing_rules) ? fp.standing_rules : [];
  const out = [];
  for (const r of rules) {
    const d = r && r.decision;
    if (!d || d.origin !== 'delegation' || !d.dimension) continue;
    const dir = VALUE_DIRECTION[d.value];
    const kw = dir && DIMENSION_KEYWORD[d.dimension] && DIMENSION_KEYWORD[d.dimension][dir];
    if (!kw) continue;                                            // unmapped value → can't honor in-consult (still injects verbatim)
    out.push({
      layer: 'decision_and_risk',
      field: d.dimension, value: kw, polarity: 'positive',
      origin: 'delegation', evidence_basis: 'corroborated', source: 'authored_delegation',
      confidence: 0.9, observation_count: 3,
      ...(typeof d.domain === 'string' ? { domain: d.domain } : {}),
    });
  }
  return out;
}

// §10.3 response shape — the ONLY fields that cross the boundary (§10.4).
export function shape(type, signal, confidence, rationale_hint, deference_level) {
  return {
    phaedo_response_version: '0.1',
    request_type: 'consultation',
    consultation_type: type,
    signal: SIGNALS.includes(signal) ? signal : 'clarify',
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    rationale_hint: String(rationale_hint || '').replace(/\s+/g, ' ').trim().slice(0, 280),
    deference_level: ['high', 'medium', 'low'].includes(deference_level) ? deference_level : 'medium',
  };
}

// ── Rule resolver (deterministic, local, always available — the floor) ─────────
export function ruleResponse(vd, n) {
  // §4.7 contested dimensions are withheld from the cue readers (the consult-side mirror
  // of injection suppression). Built once per consult and threaded into every resolver.
  const suppressed = openConflictKeys(vd);
  let resolved;
  switch (n.type) {
    case 'action_approval':    resolved = resolveActionApproval(vd, n, suppressed); break;
    case 'domain_risk_check':  resolved = resolveDomainRiskCheck(vd, n, suppressed); break;
    case 'escalation_default': resolved = resolveEscalationDefault(vd, n, suppressed); break;
    case 'voice_draft':        resolved = resolveVoiceDraft(); break;
  }
  // Abstain floor (§10.3 `insufficient_signal`): a real decision type with ZERO
  // relevant cues has no pattern basis. Say so rather than emit a signal derived
  // only from the action's structure — a confidently-wrong answer is the worst
  // output (brief principle 2). Structural safety belongs in authored policy (step
  // C below), which still overrides this abstain. voice_draft never abstains (it's
  // a redirect). An authored policy can still force a decision on top of this.
  if (n.type !== 'voice_draft' && resolved.found === 0) {
    // Distinguish "no coverage" from "coverage exists but is contested": if every
    // relevant cue was WITHHELD by an open conflict, tell the agent it is under review
    // (so it escalates to the subject rather than treating the subject as a blank slate).
    const contested = resolved.withheld > 0;
    return shape(n.type, 'insufficient_signal', calibrate(vd, 0).confidence,
      contested ? CONTESTED_HINT : ABSTAIN_HINT, 'low');
  }
  const cal = n.type === 'voice_draft'
    ? { confidence: 0.2, deference_level: 'low' }
    : calibrate(vd, resolved.coverage, resolved.signalConfidence);
  return shape(n.type, resolved.signal, cal.confidence, resolved.hint, cal.deference_level);
}

// ── Public pure entry ─────────────────────────────────────────────────────────
// (vd, request[, opts]) -> §10.3 response. Deterministic; applies authored §10.5
// policies last so a standing guardrail wins (even over an abstain). `opts.policies`
// (a loaded local-config policy doc, passed in by the server) is data, not I/O —
// the file read happens in the transport layer, so this stays pure.
export function resolveConsultationCore(vd, request = {}, opts = {}) {
  assertVaultUsable(vd);
  const n = normalizeRequest(request);
  return applyPolicies(ruleResponse(vd, n), n, loadPolicies(vd, opts));
}

// Back-compat alias: the prior public name of the sync rule entry. Kept so existing
// importers (tests, spec/test-schemas.mjs) are unchanged.
export const buildConsultationResponse = resolveConsultationCore;

// ── Deterministic-only authorization check (brief M3) ─────────────────────────
// (vd, request[, opts]) -> a small, fixed-shape result. Checks ONLY standing
// authorizations (§10.5 force rules) — it does NOT run inferred evaluation, so it is
// a fast pre-flight an agent can call before a full consultation: "is this already
// decided by one of my standing rules?". A matched authorization is the subject's
// deterministic pre-decision (confidence 1.0, deference high, by definition). Honors
// §10.4 (no layer content crosses — only the rule's decision + provenance note).
export function checkAuthorization(vd, request = {}, opts = {}) {
  assertVaultUsable(vd);
  const n = normalizeRequest(request);
  const auth = matchAuthorization(n, loadPolicies(vd, opts));
  return {
    phaedo_response_version: '0.1',
    request_type: 'authorization_check',
    consultation_type: n.type,
    authorization_matched: !!auth,
    signal: auth ? auth.signal : null,
    rule_id: auth ? (auth.rule.id || null) : null,
    rationale_hint: auth
      ? `Per your standing rule: ${auth.note}.`.replace(/\s+/g, ' ').trim().slice(0, 280)
      : 'No standing authorization matches this action; run phaedo_consult for a full signal, or apply your own default.',
  };
}
