#!/usr/bin/env node
// Self-tests for the §10 consultation engine (consult.js) — hardened: realistic
// interview-text fixtures (keyword scan), relevance scoping, coverage→deference,
// validation, the §10.4 boundary, AND the model-judge path (mocked) + fallback.
// Run: node test-consult.mjs   (or npm run smoke:consult)

import assert from 'assert';
import { buildConsultationResponse, resolveConsultation, consultOptsFromEnv, CONSULTATION_TYPES, consultDrivers, deriveDelegationSignals, withDelegationSignals, buildDelegationPromotions, DELEGATION_PROMOTION_FLOOR, authoredDelegationSignals } from './consult.js';
import { PhaedoError } from './projection.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── Fixtures (interview-answer TEXT, the realistic shape — no clean dimension id) ─
const cautious = { phaedo_fingerprint: { persona_strength: 0.7, layers: {
  decision_and_risk: { responses: [
    { answer: 'Quality over speed' },
    { answer: 'Accuracy over speed; Thoroughness over simplicity' },
    { answer: 'For decisions I cannot undo I get much more cautious and seek more input' },
  ], summary: 'Evidence bar: high' },
  behavioral: { responses: [
    { answer: 'Make sure I have covered the main risks before committing' },
    { answer: 'Ask a clarifying question before doing anything' },
  ] },
} } };

const fast = { phaedo_fingerprint: { persona_strength: 0.6, layers: {
  decision_and_risk: { responses: [
    { answer: 'Speed over quality' },
    { answer: 'For decisions I cannot undo my style is consistent regardless' },
  ] },
  behavioral: { responses: [
    { answer: 'Act on the best signal available and adjust as I learn' },
    { answer: 'Make a reasonable assumption silently and proceed' },
  ] },
} } };

// Also prove the §4.2 signals[].field path (not just text scan).
const cautiousSignals = { phaedo_fingerprint: { persona_strength: 0.6, layers: {
  decision_and_risk: { signals: [
    { field: 'reversible_vs_irreversible', value: 'more_cautious', polarity: 'positive' },
    { field: 'speed_vs_quality', value: 'quality over speed', polarity: 'positive' },
  ] },
  behavioral: { signals: [{ field: 'decision_threshold', value: 'cover_risks', polarity: 'positive' }] },
} } };

const sparse = { phaedo_fingerprint: { persona_strength: 0.3, layers: { surface: { responses: [] } } } };

const RESPONSE_KEYS = ['phaedo_response_version', 'request_type', 'consultation_type', 'signal', 'confidence', 'rationale_hint', 'deference_level'].sort();
const SIGNALS = ['proceed', 'proceed_with_note', 'clarify', 'escalate', 'decline', 'insufficient_signal'];

function assertShape(r, type) {
  ok(Object.keys(r).sort().join(',') === RESPONSE_KEYS.join(','), `${type}: response keys are exactly §10.3 (got ${Object.keys(r).join(',')})`);
  ok(r.request_type === 'consultation' && r.consultation_type === type, `${type}: type echoed`);
  ok(SIGNALS.includes(r.signal), `${type}: signal in enum (${r.signal})`);
  ok(typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1, `${type}: confidence in [0,1]`);
  ok(['high', 'medium', 'low'].includes(r.deference_level), `${type}: deference in enum`);
  ok(typeof r.rationale_hint === 'string' && r.rationale_hint.length > 0 && r.rationale_hint.length <= 280, `${type}: rationale_hint short string`);
}

// ── Rule engine over realistic TEXT (the hardening) ───────────────────────────
console.log('\nkeyword-scan over interview text');
const irreversibleHighEv = { consultation_type: 'action_approval', action_descriptor: { domain: 'financial', reversible: false, magnitude: 'high' }, context: { evidence_provided: ['invoice', 'po_match'] } };
const r1 = buildConsultationResponse(cautious, irreversibleHighEv);
assertShape(r1, 'action_approval');
ok(r1.signal === 'escalate', `cautious(text) + irreversible/high + evidence → escalate (got ${r1.signal})`);
ok(r1.deference_level === 'high', `full coverage + strong persona → high deference (got ${r1.deference_level})`);
ok(buildConsultationResponse(cautious, { consultation_type: 'action_approval', action_descriptor: { reversible: false, magnitude: 'high' }, context: {} }).signal === 'clarify', 'cautious + irreversible/high + THIN evidence → clarify');
ok(buildConsultationResponse(fast, { consultation_type: 'action_approval', action_descriptor: { reversible: true, magnitude: 'low' } }).signal === 'proceed', 'fast(text) + reversible/low → proceed');
ok(buildConsultationResponse(cautious, { consultation_type: 'action_approval', action_descriptor: { reversible: true, magnitude: 'low' } }).signal === 'proceed_with_note', 'cautious + reversible/low → proceed_with_note');
ok(buildConsultationResponse(fast, irreversibleHighEv).signal === 'proceed_with_note', 'fast + irreversible/high → proceed_with_note (flag, not block)');

console.log('\n§4.2 signals path');
ok(buildConsultationResponse(cautiousSignals, irreversibleHighEv).signal === 'escalate', 'cautious(signals) + irreversible/high + evidence → escalate');

// ── §4.7 open-conflict suppression (the consult-side mirror of injection) ──────
// A dimension under an OPEN conflict_record is withheld from the cue readers, just as
// injection withholds it from the layer summary. domain_risk_check weighs speedQuality
// + decisionThreshold + evidenceBar; this fixture has the first two as clean signals.
console.log('\n§4.7 open-conflict suppression');
const drBase = { persona_strength: 0.6, layers: {
  decision_and_risk: { signals: [{ field: 'speed_vs_quality', value: 'quality over speed', polarity: 'positive' }] },
  behavioral: { signals: [{ field: 'decision_threshold', value: 'cover_risks', polarity: 'positive' }] },
} };
const withConflicts = (recs) => ({ phaedo_fingerprint: { ...drBase, conflict_records: recs } });
const DRC = { consultation_type: 'domain_risk_check' };

// Baseline (no conflicts): both cautious cues fire → a real signal, not abstain.
const base = buildConsultationResponse({ phaedo_fingerprint: drBase }, DRC);
ok(base.signal !== 'insufficient_signal', `baseline resolves with coverage (got ${base.signal})`);

// Both relevant dimensions contested → coverage collapses to 0 → abstain, with the
// CONTESTED (not the generic no-coverage) hint so the agent escalates.
const bothOpen = buildConsultationResponse(withConflicts([
  { conflict_id: 'c1', layer: 'decision_and_risk', field: 'speed_vs_quality', status: 'open', candidates: [] },
  { conflict_id: 'c2', layer: 'behavioral', field: 'decision_threshold', status: 'open', candidates: [] },
]), DRC);
ok(bothOpen.signal === 'insufficient_signal', 'every relevant dimension contested → abstain');
ok(/reconciling a contradiction|withholds/i.test(bothOpen.rationale_hint), 'abstain hint says it is contested (not "no coverage")');
ok(!/no decision\/risk coverage/i.test(bothOpen.rationale_hint), 'the generic no-coverage hint is NOT used when the cause is a conflict');

// Partial: only one dimension contested → the other still grounds a signal (graduated,
// not all-or-nothing).
const oneOpen = buildConsultationResponse(withConflicts([
  { conflict_id: 'c1', layer: 'decision_and_risk', field: 'speed_vs_quality', status: 'open', candidates: [] },
]), DRC);
ok(oneOpen.signal !== 'insufficient_signal', 'one contested dimension still leaves coverage → no abstain');

// Only OPEN conflicts suppress — a resolved/dismissed record is settled, so it doesn't.
const settled = buildConsultationResponse(withConflicts([
  { conflict_id: 'c1', layer: 'decision_and_risk', field: 'speed_vs_quality', status: 'resolved', candidates: [] },
  { conflict_id: 'c2', layer: 'behavioral', field: 'decision_threshold', status: 'dismissed', candidates: [] },
]), DRC);
ok(settled.signal === base.signal, 'resolved/dismissed conflicts do not suppress (only open does)');

// Provenance receipt stays consistent — contested cues are withheld there too.
ok(consultDrivers(withConflicts([
  { conflict_id: 'c1', layer: 'decision_and_risk', field: 'speed_vs_quality', status: 'open', candidates: [] },
  { conflict_id: 'c2', layer: 'behavioral', field: 'decision_threshold', status: 'open', candidates: [] },
]), DRC).length === 0, 'consultDrivers withholds contested cues (receipt matches the answer)');

// §10.4 boundary holds for the contested-abstain hint (no field/layer content leaks).
ok(!/speed_vs_quality|decision_threshold|"layers"|persona_strength/.test(JSON.stringify(bothOpen)), 'contested abstain leaks no raw fingerprint content');

// ── act-as-me: delegation-origin signals dominate self-origin in consult ────────
// A consult IS an agent about to act on the subject's behalf (§10), so how they want
// work done FOR them (`origin:"delegation"`, learned from correcting a delegated action)
// overrides how they do it themselves (`origin:"self"`). Classic case: the subject is
// fast/bold in their own work but wants their AGENT cautious.
console.log('\nact-as-me — delegation-origin dominance');
const sigDR = (value, origin) => ({ field: 'speed_vs_quality', value, polarity: 'positive', origin, confidence: 0.7, evidence_basis: 'observed' });
const fpDR = (second) => ({ phaedo_fingerprint: { persona_strength: 0.6, layers: {
  decision_and_risk: { signals: [sigDR('speed over quality', 'self'), second] },
} } });
const DRC2 = { consultation_type: 'domain_risk_check' };

// Self says "go fast", delegation says "be careful" → the act-as-me (delegation) value wins.
const deleg = buildConsultationResponse(fpDR(sigDR('quality over speed', 'delegation')), DRC2);
// Control: identical values but the second signal is self-origin too → first-match (fast) drives it.
const ctrl  = buildConsultationResponse(fpDR(sigDR('quality over speed', 'self')), DRC2);
ok(ctrl.signal === 'proceed', `both self → the (first) fast signal drives → proceed (got ${ctrl.signal})`);
ok(deleg.signal !== 'proceed', `a delegation signal overrides the contradicting self one → cautious, not proceed (got ${deleg.signal})`);
ok(deleg.signal === 'clarify', `delegation cautious value drives domain_risk_check → clarify (got ${deleg.signal})`);

// Absent origin behaves as self (today's fingerprints unaffected).
const noOrigin = buildConsultationResponse({ phaedo_fingerprint: { persona_strength: 0.6, layers: {
  decision_and_risk: { signals: [{ field: 'speed_vs_quality', value: 'speed over quality', polarity: 'positive', confidence: 0.7, evidence_basis: 'observed' }] },
} } }, DRC2);
ok(noOrigin.signal === 'proceed', 'a signal with no origin field is treated as self (unchanged behavior)');

// Provenance: the local receipt driver records origin only when delegation drove it.
const dDrivers = consultDrivers(fpDR(sigDR('quality over speed', 'delegation')), DRC2);
const sQ = dDrivers.find((d) => d.cue === 'speedQuality');
ok(sQ && sQ.origin === 'delegation', 'consultDrivers tags the driving cue origin:"delegation" (local audit)');
const cDrivers = consultDrivers(fpDR(sigDR('quality over speed', 'self')), DRC2);
ok(cDrivers.every((d) => !('origin' in d)), 'a self-driven driver omits origin (receipts stay byte-identical for all-self)');

// §10.4 boundary: origin/delegation never crosses into the agent-facing response.
ok(!/origin|delegation/.test(JSON.stringify(deleg)), 'the consult response leaks no origin/delegation marker (§10.4)');

// ── delegation PRODUCER: learn act-as-me from the override history (receipts) ────
// A receipt of a consult the subject OVERRODE (user_action rejected/modified) teaches a
// delegation-origin signal: overriding a permissive signal → they wanted more caution;
// overriding a cautious one → less. Only overrides teach (the honesty rail).
console.log('\ndelegation producer — derive from override receipts');
const receipt = (signal, user_action, drivers, domain) => ({
  via: 'phaedo_consult', user_action,
  request: { consultation_type: 'domain_risk_check', action_descriptor: domain ? { domain } : {} },
  response: { signal }, drivers,
});
const drv = (cue, lean) => ({ cue, lean, confidence: 0.6, basis: 'observed' });

// Subject rejected a "proceed" → wants MORE caution on that dimension → a cautious
// delegation signal on speed_vs_quality.
const fromReject = deriveDelegationSignals([receipt('proceed', 'rejected', [drv('speedQuality', -1)])]);
ok(fromReject.length === 1, 'one override with one driver → one delegation signal');
ok(fromReject[0].origin === 'delegation' && fromReject[0].field === 'speed_vs_quality', 'signal is delegation-origin on the driven field');
ok(/quality/.test(fromReject[0].value), 'overriding a permissive signal yields a CAUTIOUS delegation value');

// Direction is read from the subject's action RELATIVE to the signal, not the signal
// class alone. Overriding a CAUTIOUS signal means PROCEEDING against it (approved) →
// they wanted to move faster → bold. AGREEING with a cautious signal (rejected = also
// didn't proceed) is NOT an override — it teaches nothing (this is the direction-fix).
ok(deriveDelegationSignals([receipt('escalate', 'rejected', [drv('speedQuality', 1)])]).length === 0,
   'agreeing with a cautious signal (rejected → also held) teaches nothing — not "be bolder"');
const fromApproveCautious = deriveDelegationSignals([receipt('escalate', 'approved', [drv('speedQuality', 1)])]);
ok(/speed|fast/.test(fromApproveCautious[0].value), 'PROCEEDING against a cautious signal (approved) yields a BOLD delegation value');

// Honesty rail: AGREEMENT teaches nothing. A rubber-stamp `approved` on a PERMISSIVE
// signal (agent proceeded as told) is agreement — the anti-obedience rail still holds.
ok(deriveDelegationSignals([receipt('proceed', 'approved', [drv('speedQuality', -1)])]).length === 0, 'approved on a permissive signal is agreement → teaches nothing (no agent-obedience corruption)');
ok(deriveDelegationSignals([receipt('proceed', null, [drv('speedQuality', -1)])]).length === 0, 'an unmarked receipt teaches nothing');
ok(deriveDelegationSignals([receipt('insufficient_signal', 'rejected', [drv('speedQuality', -1)])]).length === 0, 'overriding an abstain has no direction → no signal');

// A single `modified` is a half-weight nudge — below the floor on its own; two cross it.
ok(deriveDelegationSignals([receipt('proceed', 'modified', [drv('speedQuality', -1)])]).length === 0, 'one modified (0.5) is below the floor → no signal yet');
ok(deriveDelegationSignals([receipt('proceed', 'modified', [drv('speedQuality', -1)]), receipt('proceed', 'modified', [drv('speedQuality', -1)])]).length === 1, 'two modifications aggregate past the floor');

// Conflicting overrides on the same dimension net out — a genuine tie is skipped.
ok(deriveDelegationSignals([receipt('proceed', 'rejected', [drv('speedQuality', -1)]), receipt('escalate', 'approved', [drv('speedQuality', 1)])]).length === 0, 'opposing corrections cancel — caution (reject a proceed) vs bold (approve an escalate) → no signal');

// Domain scoping: a financial override is tagged to that domain.
ok(deriveDelegationSignals([receipt('proceed', 'rejected', [drv('speedQuality', -1)], 'financial')])[0].domain === 'financial', 'a delegated correction is scoped to the action domain');

// End-to-end: the override reshapes a real consult. Subject is fast in their OWN work,
// but rejected a delegated "proceed" → consult now leans cautious (act-as-me).
console.log('\ndelegation producer — closes the loop into resolution');
const ownFast = { phaedo_fingerprint: { persona_strength: 0.6, layers: {
  decision_and_risk: { signals: [{ field: 'speed_vs_quality', value: 'speed over quality', polarity: 'positive', origin: 'self', confidence: 0.7, evidence_basis: 'observed' }] },
} } };
const before = buildConsultationResponse(ownFast, { consultation_type: 'domain_risk_check' });
ok(before.signal === 'proceed', 'baseline: their own fast pattern → proceed');
const learned = withDelegationSignals(ownFast, deriveDelegationSignals([receipt('proceed', 'rejected', [drv('speedQuality', -1)])]));
const after = buildConsultationResponse(learned, { consultation_type: 'domain_risk_check' });
ok(after.signal === 'clarify', 'after a delegated rejection, the same consult leans cautious → clarify (act-as-me overrides act-for-me)');
ok(JSON.parse(JSON.stringify(ownFast)).phaedo_fingerprint.layers.decision_and_risk.signals.length === 1, 'withDelegationSignals never mutates the input vd');

// ── delegation PROMOTION: established overrides → a reviewable, portable suggestion ─
// When an override pattern is established (|net| ≥ floor), stage a suggested_rules
// candidate (the §E review shape) so the subject can endorse it into a portable
// delegation-origin standing rule. No-nag; honesty rail inherited.
console.log('\ndelegation promotion — established overrides → reviewable suggestion');
ok(DELEGATION_PROMOTION_FLOOR === 3, 'promotion floor is 3 (matches §4.7 / §E)');
const overrides = (n, sig = 'proceed', lean = -1, dom, action = 'rejected') => Array.from({ length: n }, () => receipt(sig, action, [drv('speedQuality', lean)], dom));
ok(buildDelegationPromotions(overrides(2), {}).length === 0, 'below the floor → no promotion');
const promos = buildDelegationPromotions(overrides(3), {});
ok(promos.length === 1, 'an established override pattern → one promotion suggestion');
const p = promos[0];
ok(p.status === 'suggested' && p.source === 'delegation_promotion', 'suggestion is status:suggested, source:delegation_promotion');
ok(p.decision.dimension === 'speed_vs_quality' && p.decision.origin === 'delegation', 'binds the canonical dimension as act-as-me (decision.origin:delegation)');
ok(p.decision.value === 'quality', 'overriding permissive signals → a CAUTIOUS catalog value');
ok(typeof p.suggestion_id === 'string' && /behalf/i.test(p.proposed_text), 'carries an endorsable id + a first-person delegation sentence');
ok(p.evidence.observation_count === 3, 'records the override cluster size');

ok(buildDelegationPromotions(overrides(3), { standing_rules: [{ kind: 'instruction', decision: { dimension: 'speed_vs_quality', origin: 'delegation' } }] }).length === 0, 'no-nag: a dimension already authored as a delegation rule is not re-proposed');
ok(buildDelegationPromotions(overrides(3), { suggested_rules: [{ status: 'suggested', source: 'delegation_promotion', decision: { dimension: 'speed_vs_quality' } }] }).length === 0, 'no-nag: an already-staged delegation suggestion is not duplicated');
ok(buildDelegationPromotions([...overrides(2), receipt('proceed', 'approved', [drv('speedQuality', -1)])], {}).length === 0, 'honesty rail: approved outcomes never count toward the floor');
ok(buildDelegationPromotions(overrides(3, 'escalate', 1, undefined, 'approved'), {})[0].decision.value === 'speed', 'PROCEEDING against cautious signals (approved) promotes a BOLD delegation rule');
ok(buildDelegationPromotions(overrides(3, 'escalate', 1), {}).length === 0, 'agreeing with cautious signals (rejected) does NOT promote a bold rule (direction-fix)');
ok(buildDelegationPromotions(overrides(3, 'proceed', -1, 'financial'), {})[0].decision.domain === 'financial', 'promotion is scoped to the action domain');

// ── an ENDORSED (authored, portable) delegation rule shapes consult too ─────────
// After the subject endorses, the rule lives in standing_rules (decision.origin:delegation)
// — it already renders in §9 injection; authoredDelegationSignals lets it also drive consult.
console.log('\nauthored delegation rule → shapes consult (act-as-me, portable)');
const dRule = (dimension, value) => ({ kind: 'instruction', text: 'When you act on my behalf…', decision: { dimension, polarity: 'positive', origin: 'delegation', value } });
const aSig = authoredDelegationSignals({ standing_rules: [dRule('speed_vs_quality', 'quality')] });
ok(aSig.length === 1 && aSig[0].origin === 'delegation' && aSig[0].field === 'speed_vs_quality', 'an authored delegation rule yields a delegation-origin signal on its dimension');
ok(/quality/.test(aSig[0].value), 'the catalog value token maps to the cautious keyword the resolver reads');
ok(authoredDelegationSignals({ standing_rules: [{ kind: 'instruction', decision: { dimension: 'speed_vs_quality' } }] }).length === 0, 'a non-delegation (self) standing rule yields no delegation signal');

// end-to-end: subject is fast in their own work, but endorsed a "be careful for me" rule
const ownFast2 = { phaedo_fingerprint: { persona_strength: 0.6,
  layers: { decision_and_risk: { signals: [{ field: 'speed_vs_quality', value: 'speed over quality', polarity: 'positive', origin: 'self', confidence: 0.7, evidence_basis: 'observed' }] } },
  standing_rules: [dRule('speed_vs_quality', 'quality')] } };
const beforeRule = buildConsultationResponse(ownFast2, { consultation_type: 'domain_risk_check' });
ok(beforeRule.signal === 'proceed', 'baseline (rule not yet applied to signals): own fast pattern → proceed');
const withRule = withDelegationSignals(ownFast2, authoredDelegationSignals(ownFast2.phaedo_fingerprint));
ok(buildConsultationResponse(withRule, { consultation_type: 'domain_risk_check' }).signal === 'clarify', 'the authored delegation rule makes the same consult lean cautious → clarify (act-as-me, portable)');

console.log('\nother types');
const dr = buildConsultationResponse(cautious, { consultation_type: 'domain_risk_check', action_descriptor: { domain: 'immigration' } });
assertShape(dr, 'domain_risk_check');
ok(dr.signal === 'clarify' && /immigration/.test(dr.rationale_hint), 'domain_risk_check: high-bar → clarify, names domain');
ok(buildConsultationResponse(fast, { consultation_type: 'domain_risk_check' }).signal === 'proceed', 'domain_risk_check: fast → proceed');
const ed = buildConsultationResponse(cautious, { consultation_type: 'escalation_default' });
assertShape(ed, 'escalation_default');
ok(ed.signal === 'clarify', 'escalation_default: ask_first → clarify');

console.log('\nvoice_draft (redirect)');
const vdr = buildConsultationResponse(cautious, { consultation_type: 'voice_draft' });
assertShape(vdr, 'voice_draft');
ok(vdr.signal === 'clarify' && vdr.deference_level === 'low' && /phaedo_request_injection/.test(vdr.rationale_hint), 'voice_draft → low-conf redirect to injection');

// ── §10.4 boundary ────────────────────────────────────────────────────────────
console.log('\nboundary (§10.4)');
for (const type of CONSULTATION_TYPES) {
  const blob = JSON.stringify(buildConsultationResponse(cautious, { consultation_type: type, action_descriptor: { reversible: false, magnitude: 'high' } }));
  ok(!/"layers"|"signals"|phaedo_fingerprint|persona_strength|"polarity"|covered the main risks|much more cautious/.test(blob), `${type}: no raw layer/fingerprint content`);
}

// ── calibration / scoping ─────────────────────────────────────────────────────
console.log('\ncalibration (relevant coverage → deference)');
const cov = buildConsultationResponse(cautious, { consultation_type: 'action_approval', action_descriptor: { reversible: true, magnitude: 'low' } });
ok(cov.deference_level !== undefined && cov.signal === 'proceed_with_note', 'covered fingerprint → real signal (not abstain)');

// ── abstain floor (§10.3 insufficient_signal, proposal 0001) ──────────────────
console.log('\nabstain floor (insufficient_signal)');
const sp = buildConsultationResponse(sparse, { consultation_type: 'action_approval', action_descriptor: { reversible: true, magnitude: 'low' } });
assertShape(sp, 'action_approval');
ok(sp.signal === 'insufficient_signal' && sp.deference_level === 'low', 'zero-coverage fingerprint → insufficient_signal @ low deference');
// abstain even when the action is structurally risky — structural safety is an
// authored-policy concern, not a fabricated pattern (the next test proves policy wins).
const spRisky = buildConsultationResponse(sparse, { consultation_type: 'action_approval', action_descriptor: { domain: 'financial', reversible: false, magnitude: 'high' }, context: { evidence_provided: ['x'] } });
ok(spRisky.signal === 'insufficient_signal', 'no coverage + irreversible/high → abstains (does not fabricate escalate)');
// fingerprint present but no decision/risk layer → abstain (empty-layers case)
const emptyLayers = { phaedo_fingerprint: { persona_strength: 0.5, layers: {} } };
ok(buildConsultationResponse(emptyLayers, { consultation_type: 'domain_risk_check', action_descriptor: { domain: 'legal' } }).signal === 'insufficient_signal', 'empty layers → domain_risk_check abstains');
// voice_draft never abstains (it is a redirect, not a decision)
ok(buildConsultationResponse(sparse, { consultation_type: 'voice_draft' }).signal === 'clarify', 'voice_draft never abstains (redirect)');
// authored policy overrides an abstain — a standing guardrail wins even with no signal
const forceEscalate = [{ id: 'irrev-spend', match: { domains: ['financial'], reversible: false }, effect: 'escalate', note: 'Irreversible money goes to a human' }];
const ov = buildConsultationResponse({ phaedo_fingerprint: { ...sparse.phaedo_fingerprint, consult_policies: forceEscalate } }, { consultation_type: 'action_approval', action_descriptor: { domain: 'financial', reversible: false, magnitude: 'high' } });
ok(ov.signal === 'escalate' && ov.deference_level === 'high' && /standing rule/i.test(ov.rationale_hint), 'authored policy overrides abstain → escalate @ high');
// the abstain response leaks no layer/fingerprint content (§10.4)
ok(!/"layers"|persona_strength|phaedo_fingerprint/.test(JSON.stringify(sp)), 'abstain response leaks no layer content');

// ── per-signal confidence (track b): confidence VARIES with signal strength ───
console.log('\nper-signal confidence (signal strength → confidence)');
const mkDR = (sigs, behav) => ({ phaedo_fingerprint: { persona_strength: 0.7, layers: {
  decision_and_risk: sigs, behavioral: behav,
} } });
const strongObs = mkDR(
  { signals: [
    { field: 'reversible_vs_irreversible', value: 'more_cautious', polarity: 'positive', confidence: 0.9, source: 'extraction' },
    { field: 'evidence_bar', value: 'accuracy over speed', polarity: 'positive', confidence: 0.88, source: 'extraction' },
  ] },
  { signals: [{ field: 'decision_threshold', value: 'cover_risks', polarity: 'positive', confidence: 0.85, source: 'extraction' }] },
);
const weakObs = mkDR(
  { signals: [
    { field: 'reversible_vs_irreversible', value: 'more_cautious', polarity: 'positive', confidence: 0.32, source: 'extraction' },
    { field: 'evidence_bar', value: 'accuracy over speed', polarity: 'positive', confidence: 0.3, source: 'extraction' },
  ] },
  { signals: [{ field: 'decision_threshold', value: 'cover_risks', polarity: 'positive', confidence: 0.3, source: 'extraction' }] },
);
const textOnly = mkDR(
  { responses: [{ answer: 'For decisions I cannot undo I get much more cautious and seek more input' }, { answer: 'Accuracy over speed; Thoroughness over simplicity' }] },
  { responses: [{ answer: 'Make sure I have covered the main risks before committing' }] },
);
const cStrong = buildConsultationResponse(strongObs, irreversibleHighEv);
const cWeak = buildConsultationResponse(weakObs, irreversibleHighEv);
const cText = buildConsultationResponse(textOnly, irreversibleHighEv);
ok(cStrong.signal === 'escalate' && cWeak.signal === 'escalate' && cText.signal === 'escalate', 'same signal across the three (only confidence should differ)');
ok(cStrong.confidence > cText.confidence, `strong observed > text-only (${cStrong.confidence} > ${cText.confidence})`);
ok(cText.confidence > cWeak.confidence, `text-only > weak observed (${cText.confidence} > ${cWeak.confidence})`);
ok(cStrong.confidence > cWeak.confidence + 0.15, 'strong vs weak signals move confidence materially (not pinned)');
ok(cStrong.deference_level === cWeak.deference_level, 'deference_level stays breadth-driven (unchanged by per-signal confidence)');

// ── purity: the core does no network/IO (call it with fetch removed) ──────────
console.log('\npurity (core is synchronous, no network)');
{
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('core must not touch the network'); };
  try {
    const pr = buildConsultationResponse(cautious, irreversibleHighEv);
    ok(pr.signal === 'escalate', 'resolveConsultationCore resolves with global fetch disabled (pure)');
  } finally { globalThis.fetch = savedFetch; }
}

// ── validation / normalization (§10.2) ────────────────────────────────────────
console.log('\nvalidation / normalization');
ok(buildConsultationResponse(cautious, { consultation_type: 'action_approval', action_descriptor: { reversible: false, magnitude: 'HIGH' }, context: { evidence_provided: ['x'] } }).signal === 'escalate', 'magnitude is case-insensitive');
let threw = null; try { buildConsultationResponse(cautious, { consultation_type: 'action_approval', action_descriptor: { magnitude: 'huge' } }); } catch (e) { threw = e; }
ok(threw instanceof PhaedoError && threw.code === 'request_malformed', 'bad magnitude → request_malformed');
ok(buildConsultationResponse(cautious, { consultation_type: 'action_approval' }).signal !== undefined, 'missing action_descriptor still resolves');
threw = null; try { buildConsultationResponse(cautious, { consultation_type: 'nope' }); } catch (e) { threw = e; }
ok(threw instanceof PhaedoError && threw.code === 'request_malformed', 'unknown type → request_malformed');
threw = null; try { buildConsultationResponse({}, { consultation_type: 'action_approval' }); } catch (e) { threw = e; }
ok(threw instanceof PhaedoError && threw.code === 'decryption_failed', 'no fingerprint → decryption_failed');

// ── vd contract guard (M0.4): breach → structured error; weird-but-valid → resolves ─
console.log('\nvd contract guard (M0.4)');
// Type BREACHES of the documented vd shape are producer bugs → a structured
// PhaedoError naming the field, never a silent partial resolution (brief M0.3/0.4).
for (const [breach, field] of [
  [{ phaedo_fingerprint: { layers: null } }, 'layers'],
  [{ phaedo_fingerprint: { persona_strength: 'nan', layers: {} } }, 'persona_strength'],
  [{ phaedo_fingerprint: { layers: { surface: 'nope' } } }, 'layer "surface"'],
  [{ phaedo_fingerprint: { layers: {} }, phaedo_session_metrics: 5 }, 'phaedo_session_metrics'],
]) {
  let e = null; try { buildConsultationResponse(breach, { consultation_type: 'action_approval' }); } catch (x) { e = x; }
  ok(e instanceof PhaedoError && e.code === 'internal_error' && e.message.includes(field), `vd breach → internal_error naming "${field}"`);
}
// Weird-but-CONFORMING content (odd signal values, empty objects) still resolves —
// the guard rejects type breaches of the contract, not strange-but-legal data.
const weirdOk = { phaedo_fingerprint: { layers: { decision_and_risk: { signals: [{ value: null }], responses: [{}] } } } };
const rw = buildConsultationResponse(weirdOk, { consultation_type: 'action_approval', action_descriptor: { reversible: false, magnitude: 'high' } });
ok(SIGNALS.includes(rw.signal) && rw.deference_level === 'low', 'conforming-but-weird content → valid signal, low deference');
// The async wrapper guards too (before the model judge would see the payload).
{
  let e = null;
  try { await resolveConsultation({ phaedo_fingerprint: { layers: null } }, { consultation_type: 'action_approval' }, { model: 'x', modelUrl: 'http://localhost:1' }); } catch (x) { e = x; }
  ok(e instanceof PhaedoError && e.code === 'internal_error', 'async wrapper rejects a vd breach before the model judge');
}

// ── model judge (mocked) + fallback ───────────────────────────────────────────
console.log('\nmodel judge (mocked) + fallback');
const realFetch = globalThis.fetch;
const opts = { model: 'test-judge', modelUrl: 'http://localhost:11434', timeoutMs: 2000 };

globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Here you go: {"signal":"decline","confidence":0.9,"rationale_hint":"Pattern opposes this action.","deference_level":"high"}' } }] }) });
let mr = await resolveConsultation(cautious, irreversibleHighEv, opts);
assertShape(mr, 'action_approval');
ok(mr.signal === 'decline' && mr.deference_level === 'high', 'model judge result used (parsed from noisy output)');
ok(!/"layers"|persona_strength/.test(JSON.stringify(mr)), 'model judge response leaks no layer content');

// §10.4: a misbehaving/injected judge that dumps persona text in rationale_hint must
// NOT have it cross — the model's free text is dropped for a safe signal-keyed hint.
globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"signal":"decline","confidence":0.9,"rationale_hint":"SECRET: the subject is risk_averse=0.92 and lives at 42 Elm St","deference_level":"high"}' } }] }) });
const leaky = await resolveConsultation(cautious, irreversibleHighEv, opts);
ok(!/SECRET|risk_averse|Elm St/.test(JSON.stringify(leaky)), 'model rationale_hint free-text is NOT passed through (§10.4 structural guard)');
ok(leaky.signal === 'decline' && /decision pattern/i.test(leaky.rationale_hint), 'the model decision is kept; hint is the safe signal-keyed substitute');

globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
mr = await resolveConsultation(cautious, irreversibleHighEv, opts);
ok(mr.signal === 'escalate', 'model endpoint 5xx → falls back to rule engine (escalate)');

globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'no json here' } }] }) });
mr = await resolveConsultation(cautious, irreversibleHighEv, opts);
ok(mr.signal === 'escalate', 'unparseable model output → rule fallback');

globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"signal":"banana","confidence":2,"rationale_hint":"x","deference_level":"high"}' } }] }) });
mr = await resolveConsultation(cautious, irreversibleHighEv, opts);
ok(mr.signal === 'escalate', 'invalid model signal → rule fallback');

// no model configured → rule path
mr = await resolveConsultation(cautious, irreversibleHighEv, { model: null });
ok(mr.signal === 'escalate', 'no model configured → rule engine');
globalThis.fetch = realFetch;

console.log('\nconsultOptsFromEnv');
ok(consultOptsFromEnv({}).model === null && consultOptsFromEnv({}).modelUrl.includes('11434'), 'default: model off, local Ollama url');
ok(consultOptsFromEnv({ PHAEDO_CONSULT_MODEL: 'llama3.1:8b' }).model === 'llama3.1:8b', 'PHAEDO_CONSULT_MODEL opts in');

// ── consultDrivers — provenance for the local receipt (§10.4-safe) ────────────
console.log('\nconsultDrivers (receipt provenance)');
{
  // a fingerprint with observed Decision&Risk signals → drivers carry the fired cues
  const dr = consultDrivers(cautiousSignals, { consultation_type: 'action_approval', action_descriptor: { reversible: false, magnitude: 'high' } });
  ok(Array.isArray(dr) && dr.length > 0, 'an inferred consult yields ≥1 driver');
  ok(dr.every((d) => typeof d.cue === 'string' && typeof d.confidence === 'number' && 'basis' in d), 'each driver has cue + confidence + basis');
  ok(dr.some((d) => d.basis === 'observed'), 'evidence basis is carried through from the signal');
  ok(!JSON.stringify(dr).includes('responses') && !dr.some((d) => 'text' in d), 'drivers carry no raw layer text');

  ok(consultDrivers(sparse, { consultation_type: 'action_approval', action_descriptor: {} }).length === 0, 'no relevant cues → no drivers (matches the abstain floor)');
  ok(consultDrivers(cautious, { consultation_type: 'voice_draft' }).length === 0, 'voice_draft is a redirect → no inferred drivers');
  ok(consultDrivers(cautious, { consultation_type: 'bogus' }).length === 0, 'malformed request → [] (never throws)');
}

console.log(`\n✓ consult: ${pass} checks passed`);
