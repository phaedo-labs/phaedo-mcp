#!/usr/bin/env node
// Self-tests for per-domain deference policies (consult-policy.js) + their
// integration into the consult engine. Run: node test-consult-policy.mjs
// (or npm run smoke:policy)

import assert from 'assert';
import { normalizePolicies, applyPolicies, matchAuthorization, loadPolicies } from './consult-policy.js';
import { buildConsultationResponse, checkAuthorization } from './consult.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const base = (signal = 'proceed', deference = 'medium') => ({
  phaedo_response_version: '0.1', request_type: 'consultation', consultation_type: 'action_approval',
  signal, confidence: 0.5, rationale_hint: 'base hint', deference_level: deference,
});
const n = (over = {}) => ({ type: 'action_approval', domain: undefined, magnitude: 'medium', reversible: undefined, ...over });
const KEYS = ['phaedo_response_version', 'request_type', 'consultation_type', 'signal', 'confidence', 'rationale_hint', 'deference_level'].sort();

// ── normalizePolicies ─────────────────────────────────────────────────────────
console.log('\nnormalizePolicies');
const norm = normalizePolicies({ rules: [
  { id: 'a', match: { domains: ['Financial', 'LEGAL'], reversible: false }, effect: 'escalate', note: 'x' },
  { effect: 'bogus_effect' },                 // skipped (unknown effect)
  'not an object',                            // skipped
  { match: { magnitude_max: 'medium' }, effect: 'autoproceed' },
] });
ok(norm.length === 2, `skips malformed/unknown (got ${norm.length})`);
ok(norm[0].domains.join(',') === 'financial,legal', 'domains lowercased');
ok(norm[0].reversible === false, 'reversible parsed');
ok(norm[1].magMax === 1, 'magnitude_max → rank');
ok(normalizePolicies([{ match: {}, effect: 'decline' }]).length === 1, 'accepts array form');
ok(normalizePolicies(null).length === 0 && normalizePolicies('x').length === 0, 'garbage → []');

// ── applyPolicies: FORCE effects override the inferred signal ─────────────────
console.log('\napplyPolicies — force');
const escalateRule = normalizePolicies([{ match: { domains: ['financial', 'legal'], reversible: false }, effect: 'escalate', note: 'Always surface irreversible money/legal' }]);
let r = applyPolicies(base('proceed'), n({ domain: 'financial', magnitude: 'high', reversible: false }), escalateRule);
ok(r.signal === 'escalate' && r.deference_level === 'high', 'escalate rule forces escalate@high over inferred proceed');
ok(/standing rule/i.test(r.rationale_hint) && /money\/legal/.test(r.rationale_hint), 'rationale_hint carries policy provenance');
ok(Object.keys(r).sort().join(',') === KEYS.join(','), 'response keeps exactly the §10.3 shape (no leaked fields)');

const autoRule = normalizePolicies([{ match: { domains: ['writing', 'draft', 'email'], magnitude_max: 'medium', reversible: true }, effect: 'autoproceed' }]);
r = applyPolicies(base('clarify'), n({ domain: 'draft email', magnitude: 'low', reversible: true }), autoRule);
ok(r.signal === 'proceed' && r.deference_level === 'high', 'autoproceed forces proceed@high on low-stakes writing (even over a cautious base)');

const declineRule = normalizePolicies([{ match: { domains: ['crypto'] }, effect: 'decline', note: 'No speculative crypto' }]);
ok(applyPolicies(base('proceed'), n({ domain: 'crypto trade' }), declineRule).signal === 'decline', 'decline rule forces decline');

// authored authorization → confidence 1.0 (deterministic pre-decision)
ok(applyPolicies(base('proceed'), n({ domain: 'financial', magnitude: 'high', reversible: false }), escalateRule).confidence === 1.0, 'force effect sets confidence 1.0 (authored authorization)');

// ── numeric threshold (amount_gt) — "escalate spend over $5,000" ──────────────
console.log('\namount_gt (numeric authorization)');
const overFiveK = normalizePolicies([{ match: { domains: ['financial', 'spend'], reversible: false, amount_gt: 5000 }, effect: 'escalate', note: 'Big irreversible spend goes to a human' }]);
ok(normalizePolicies([{ match: { amount_gt: 5000 }, effect: 'escalate' }])[0].amountGt === 5000, 'amount_gt parsed onto the rule');
ok(applyPolicies(base('proceed'), n({ domain: 'financial', reversible: false, amount: 12000 }), overFiveK).signal === 'escalate', 'amount over threshold → escalate');
ok(applyPolicies(base('proceed'), n({ domain: 'financial', reversible: false, amount: 2000 }), overFiveK).signal === 'proceed', 'amount under threshold → no match (inferred stands)');
ok(applyPolicies(base('proceed'), n({ domain: 'financial', reversible: false }), overFiveK).signal === 'proceed', 'no amount on the action → threshold rule does not fire');
ok(applyPolicies(base('proceed'), n({ domain: 'financial', reversible: false, amount: 5000 }), overFiveK).signal === 'proceed', 'amount equal to threshold → not strictly greater → no match');

// ── matching constraints ──────────────────────────────────────────────────────
console.log('\nmatching');
ok(applyPolicies(base('proceed'), n({ domain: 'cooking' }), escalateRule).signal === 'proceed', 'no domain match → passthrough');
ok(applyPolicies(base('proceed'), n({ domain: 'financial', reversible: true }), escalateRule).signal === 'proceed', 'reversible mismatch → no match');
ok(applyPolicies(base('proceed'), n({ domain: 'writing', magnitude: 'high', reversible: true }), autoRule).signal === 'proceed', 'magnitude_max excludes high → no match (base unchanged)');
ok(applyPolicies(base('proceed'), n({ domain: 'writing', magnitude: 'high', reversible: true }), autoRule).signal === 'proceed', 'over-magnitude writing not auto-proceeded');

// ── bias (nudge one step) ─────────────────────────────────────────────────────
console.log('\nbias');
const biasC = normalizePolicies([{ match: { domains: ['email'] }, effect: 'bias_cautious' }]);
ok(applyPolicies(base('proceed'), n({ domain: 'email' }), biasC).signal === 'proceed_with_note', 'bias_cautious nudges proceed → proceed_with_note');
const biasB = normalizePolicies([{ match: { domains: ['email'] }, effect: 'bias_bold' }]);
ok(applyPolicies(base('escalate'), n({ domain: 'email' }), biasB).signal === 'clarify', 'bias_bold nudges escalate → clarify');
ok(applyPolicies(base('decline'), n({ domain: 'email' }), biasC).signal === 'decline', 'bias does not move decline (off-ladder)');

// ── voice_draft never overridden ──────────────────────────────────────────────
console.log('\nvoice_draft guard');
ok(applyPolicies(base('clarify'), n({ type: 'voice_draft', domain: 'financial', reversible: false }), escalateRule).signal === 'clarify', 'voice_draft never policy-overridden');

// ── empty / no policies ───────────────────────────────────────────────────────
ok(applyPolicies(base('proceed'), n({ domain: 'financial', reversible: false }), []).signal === 'proceed', 'no policies → passthrough');

// ── integration: portable vault policies via buildConsultationResponse ────────
console.log('\nintegration (portable vault policies)');
// A "fast" fingerprint that would infer proceed on a reversible/low action…
const fastFp = { phaedo_fingerprint: { persona_strength: 0.6, layers: {
  decision_and_risk: { responses: [{ answer: 'Speed over quality' }] },
  behavioral: { responses: [{ answer: 'Act on the best signal available and adjust as I learn' }] },
} } };
// …but a portable standing rule forces escalate on irreversible spend.
fastFp.phaedo_consult_policies = { version: '0.1', rules: [
  { id: 'spend', match: { domains: ['spend', 'payment', 'financial'], reversible: false }, effect: 'escalate', note: 'Surface irreversible spend' },
] };
const ir = buildConsultationResponse(fastFp, { consultation_type: 'action_approval', action_descriptor: { domain: 'payment', reversible: false, magnitude: 'high' } });
ok(ir.signal === 'escalate', `vault policy overrides inferred signal end-to-end (got ${ir.signal})`);
ok(/standing rule/i.test(ir.rationale_hint), 'integration hint shows policy provenance');
// without the matching domain, the inferred (fast → proceed) stands
const rev = buildConsultationResponse(fastFp, { consultation_type: 'action_approval', action_descriptor: { domain: 'cooking', reversible: true, magnitude: 'low' } });
ok(rev.signal === 'proceed', 'non-matching action keeps the inferred signal');

// portability: policies INSIDE the fingerprint (phaedo_fingerprint.consult_policies)
// ride inner.data on the phone pull → reach the MCP server with no mobile change.
const inFp = { phaedo_fingerprint: { persona_strength: 0.6, consult_policies: { version: '0.1', rules: [
  { id: 'in-fp', match: { domains: ['legal'], reversible: false }, effect: 'escalate', note: 'irreversible legal → human' },
] }, layers: { decision_and_risk: { responses: [{ answer: 'Speed over quality' }] } } } };
const inFpR = buildConsultationResponse(inFp, { consultation_type: 'action_approval', action_descriptor: { domain: 'legal', reversible: false, magnitude: 'high' } });
ok(inFpR.signal === 'escalate', 'policy carried INSIDE the fingerprint applies (portable, no mobile change)');

// ── Proposal 0007: standing_rules (kind:authorization) parity with consult_policies ──
console.log('\nstanding_rules authorization (Proposal 0007)');
const act = { consultation_type: 'action_approval', action_descriptor: { domain: 'legal', reversible: false, magnitude: 'high' } };
// the SAME gate, authored as a standing_rules entry instead of a consult_policies rule…
const srFp = { phaedo_fingerprint: { persona_strength: 0.6, standing_rules: [
  { instruction_id: 'in-fp', kind: 'authorization', match: { domains: ['legal'], reversible: false }, effect: 'escalate', text: 'Irreversible legal goes to a human.' },
], layers: { decision_and_risk: { responses: [{ answer: 'Speed over quality' }] } } } };
const srR = buildConsultationResponse(srFp, act);
ok(srR.signal === inFpR.signal && srR.signal === 'escalate', 'standing_rules authorization drives the resolver identically to the equivalent consult_policies rule');
ok(/standing rule/i.test(srR.rationale_hint), 'standing_rules authorization carries policy provenance (note ← text fallback)');
// an INSTRUCTION-kind entry is a verbatim injection rule, NOT a gate — the resolver ignores it
const instrFp = { phaedo_fingerprint: { persona_strength: 0.6, standing_rules: [
  { instruction_id: 'i1', kind: 'instruction', text: 'I confirm recurring costs in writing.', decision: { dimension: 'evidence_threshold', polarity: 'negative' } },
], layers: { decision_and_risk: { responses: [{ answer: 'Speed over quality' }], signals: [{ field: 'speed_vs_quality', polarity: 'positive', value: 'speed', confidence: 0.6 }] } } } };
ok(matchAuthorization({ type: 'action_approval', domain: 'finance', reversible: false, magnitude: 'high' }, loadPolicies(instrFp)) === null, 'a kind:instruction standing_rule is not an authorization (resolver never force-overrides from an instruction)');

// §D: a NEGATIVE-polarity bound instruction projects to a cautious BIAS (one step),
// scoped to its decision.domain. An UNBOUND or POSITIVE instruction projects nothing.
const negBound = { phaedo_fingerprint: { standing_rules: [
  { instruction_id: 'i1', kind: 'instruction', text: 'I confirm recurring costs in writing.', decision: { dimension: 'evidence_threshold', polarity: 'negative', domain: 'finance' } },
] } };
const negPols = loadPolicies(negBound);
ok(negPols.length === 1 && negPols[0].effect === 'bias_cautious', 'negative bound instruction → one bias_cautious policy');
ok(applyPolicies(base('proceed'), n({ domain: 'finance', magnitude: 'low' }), negPols).signal === 'proceed_with_note', 'bound instruction nudges a matching-domain consultation one step cautious');
ok(applyPolicies(base('proceed'), n({ domain: 'cooking' }), negPols).signal === 'proceed', 'out-of-domain action is not nudged');
ok(matchAuthorization(n({ domain: 'finance' }), negPols) === null, 'a bound instruction is a bias, never a force/authorization');
// positive polarity and unbound instructions project nothing in v0.1 (inject-only)
ok(loadPolicies({ phaedo_fingerprint: { standing_rules: [
  { kind: 'instruction', text: 'I move fast on reversible calls.', decision: { dimension: 'speed_vs_quality', polarity: 'positive' } },
  { kind: 'instruction', text: 'Refer to me as Randy.' },
] } }).length === 0, 'positive-polarity and unbound instructions project no consultation policy (v0.1: inject-only, no autonomy expansion)');

// ── checkAuthorization: deterministic-only pre-flight (M3) ────────────────────
console.log('\ncheckAuthorization (deterministic pre-flight)');
const AC_KEYS = ['phaedo_response_version', 'request_type', 'consultation_type', 'authorization_matched', 'signal', 'rule_id', 'rationale_hint'].sort();
const acReq = (over = {}) => ({ consultation_type: 'action_approval', action_descriptor: over });
// a fingerprint with policies inside it + a CAUTIOUS pattern (would infer escalate)
const acFp = (rules) => ({ phaedo_fingerprint: { persona_strength: 0.7, consult_policies: { version: '0.1', rules },
  layers: { decision_and_risk: { responses: [{ answer: 'For decisions I cannot undo I get much more cautious and seek more input' }, { answer: 'Accuracy over speed; Thoroughness over simplicity' }] } } } });

const spendRule = [{ id: 'spend5k', match: { domains: ['financial', 'spend'], reversible: false, amount_gt: 5000 }, effect: 'escalate', note: 'Big irreversible spend goes to me' }];
let ac = checkAuthorization(acFp(spendRule), acReq({ domain: 'financial', reversible: false, amount: 12000 }));
ok(Object.keys(ac).sort().join(',') === AC_KEYS.join(','), 'auth-check has exactly its fixed shape (no leaked fields)');
ok(ac.request_type === 'authorization_check', 'auth-check request_type');
ok(ac.authorization_matched === true && ac.signal === 'escalate' && ac.rule_id === 'spend5k', 'matched authorization → escalate + rule_id');
ok(/standing rule/i.test(ac.rationale_hint), 'matched → provenance hint');

// DETERMINISTIC: same cautious fingerprint, NO policies → no authorization (it does
// NOT run inference, even though a full consult on this fingerprint would escalate).
ac = checkAuthorization(acFp([]), acReq({ domain: 'financial', reversible: false, amount: 12000 }));
ok(ac.authorization_matched === false && ac.signal === null && ac.rule_id === null, 'no policy → no authorization (skips inference)');
ok(/phaedo_consult/.test(ac.rationale_hint), 'no match → tells the agent to fall back to a full consult');
// prove the contrast: a full consult on that SAME fingerprint DOES infer escalate
// (with evidence provided) — so check_authorization returning no-match proves it skipped inference.
ok(buildConsultationResponse(acFp([]), { consultation_type: 'action_approval', action_descriptor: { domain: 'financial', reversible: false, amount: 12000, magnitude: 'high' }, context: { evidence_provided: ['x'] } }).signal === 'escalate', 'control: full consult infers escalate on the same fingerprint (so check_authorization truly skipped inference)');

// amount threshold respected (under → no match)
ok(checkAuthorization(acFp(spendRule), acReq({ domain: 'financial', reversible: false, amount: 2000 })).authorization_matched === false, 'under amount_gt → no authorization');
// bias rules are NOT authorizations
ok(checkAuthorization(acFp([{ match: { domains: ['financial'] }, effect: 'bias_cautious' }]), acReq({ domain: 'financial' })).authorization_matched === false, 'a bias rule is not an authorization');
// decline authorization
ok(checkAuthorization(acFp([{ id: 'no-email', match: { domains: ['email'] }, effect: 'decline', note: 'no autonomous email' }]), acReq({ domain: 'outbound email' })).signal === 'decline', 'decline authorization → signal decline');
// voice_draft is exempt
ok(checkAuthorization(acFp(spendRule), { consultation_type: 'voice_draft', action_descriptor: { domain: 'financial', reversible: false, amount: 12000 } }).authorization_matched === false, 'voice_draft is exempt from authorizations');
// §10.4 boundary: no layer/fingerprint content in the auth-check response
ok(!/"layers"|persona_strength|phaedo_fingerprint|cautious and seek/.test(JSON.stringify(ac)), 'auth-check leaks no layer content');
// matchAuthorization unit: returns the force rule (ignores bias precedence)
const ma = matchAuthorization({ type: 'action_approval', domain: 'financial', reversible: false, magnitude: 'high', amount: 9000 }, normalizePolicies(spendRule));
ok(ma && ma.signal === 'escalate' && ma.rule.id === 'spend5k', 'matchAuthorization returns the matched force rule');

// ── magnitude_min + range matching (the popup exposes a "mag min" selector; the
//    magMin path was previously untested — every prior case used magnitude_max) ──
console.log('\nmagnitude_min + [min,max] band');
const highOnly = normalizePolicies([{ match: { domains: ['financial'], magnitude_min: 'high' }, effect: 'escalate' }]);
ok(highOnly[0].magMin === 2, 'magnitude_min → rank');
ok(applyPolicies(base('proceed'), n({ domain: 'financial', magnitude: 'high' }), highOnly).signal === 'escalate', 'magnitude at the min fires');
ok(applyPolicies(base('proceed'), n({ domain: 'financial', magnitude: 'low' }), highOnly).signal === 'proceed', 'below magnitude_min → no match');
const medBand = normalizePolicies([{ match: { domains: ['ops'], magnitude_min: 'medium', magnitude_max: 'medium' }, effect: 'decline' }]);
ok(applyPolicies(base('proceed'), n({ domain: 'ops', magnitude: 'medium' }), medBand).signal === 'decline', 'inside the [min,max] band → match');
ok(applyPolicies(base('proceed'), n({ domain: 'ops', magnitude: 'high' }), medBand).signal === 'proceed', 'above the band → no match');
ok(applyPolicies(base('proceed'), n({ domain: 'ops', magnitude: 'low' }), medBand).signal === 'proceed', 'below the band → no match');

// ── popup-authored shape → enforcement contract ───────────────────────────────
// Locks that the exact rule object popup.js `addGuardrail` builds is consumed and
// enforced by this engine. `buildLikePopup` mirrors addGuardrail's field handling
// 1:1 (CSV domains → trim/lowercase/filter; reversible 'true'/'false' → boolean;
// effect defaults to 'escalate'; blank match-keys omitted). If addGuardrail's output
// drifts from this, an authored guardrail silently stops gating — this is the canary.
// (popup.js carries a comment pointing here so the two stay in lockstep.)
console.log('\npopup-authored guardrail shape → enforcement');
function buildLikePopup({ domains = '', magmin = '', magmax = '', rev = '', effect = '', note = '' }) {
  const match = {};
  const ds = domains.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ds.length) match.domains = ds;
  if (magmin) match.magnitude_min = magmin;
  if (magmax) match.magnitude_max = magmax;
  if (rev) match.reversible = rev === 'true';
  const rule = { id: 'rule-' + Date.now().toString(36), match, effect: effect || 'escalate' };
  if (note) rule.note = note;
  return rule;
}
ok(buildLikePopup({}).effect === 'escalate', 'effect defaults to escalate when the dropdown is empty');
const authored = normalizePolicies([buildLikePopup({ domains: 'Financial, Legal', rev: 'false', effect: 'escalate', note: 'big irreversible' })]);
ok(authored.length === 1 && authored[0].domains.join(',') === 'financial,legal' && authored[0].reversible === false, 'popup-built rule normalizes (domains lowercased, reversible coerced)');
ok(applyPolicies(base('proceed'), n({ domain: 'financial', reversible: false, magnitude: 'high' }), authored).signal === 'escalate', 'popup-built escalate rule forces escalate end-to-end');
const anyDecline = normalizePolicies([buildLikePopup({ effect: 'decline' })]);
ok(applyPolicies(base('proceed'), n({ domain: 'whatever' }), anyDecline).signal === 'decline', 'an unconstrained popup rule applies to any action (the UI "blank = any" hint)');

// ── revocable authority — expires_at (enforced) + agents (reserved) ───────────
console.log('\nrevocable authority — expires_at + agents');
{
  const T0 = Date.parse('2026-06-19T00:00:00Z');
  const after = Date.parse('2026-06-21T00:00:00Z');
  const expRule = normalizePolicies([{ match: { domains: ['financial'], reversible: false }, effect: 'escalate', note: 'x', expires_at: '2026-06-20T00:00:00Z' }]);
  ok(expRule[0].expiresAt === Date.parse('2026-06-20T00:00:00Z'), 'expires_at parsed onto the rule');
  ok(applyPolicies(base('proceed'), n({ domain: 'financial', reversible: false }), expRule, { now: T0 }).signal === 'escalate', 'before expiry → authorization fires');
  ok(applyPolicies(base('proceed'), n({ domain: 'financial', reversible: false }), expRule, { now: after }).signal === 'proceed', 'after expiry → authorization lapses (inferred stands)');
  ok(matchAuthorization(n({ domain: 'financial', reversible: false }), expRule, { now: after }) === null, 'matchAuthorization: a lapsed rule does not match');

  // a lapsed BIAS rule also stops nudging
  const expBias = normalizePolicies([{ match: { domains: ['email'] }, effect: 'bias_cautious', expires_at: '2026-06-18T00:00:00Z' }]);
  ok(applyPolicies(base('proceed'), n({ domain: 'email' }), expBias, { now: T0 }).signal === 'proceed', 'a lapsed bias rule no longer nudges');

  // agents: parsed + lowercased, but RESERVED (not enforced) → still applies today
  const agRule = normalizePolicies([{ match: { domains: ['financial'] }, effect: 'decline', agents: ['Agent-X'] }]);
  ok(agRule[0].agents.join(',') === 'agent-x', 'agents parsed + lowercased (reserved)');
  ok(applyPolicies(base('proceed'), n({ domain: 'financial' }), agRule).signal === 'decline', 'agents is reserved (not yet enforced) — the rule still applies');
}

console.log(`\n✓ consult-policy: ${pass} checks passed`);
