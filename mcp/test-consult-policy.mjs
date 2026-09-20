#!/usr/bin/env node
// Self-tests for per-domain deference policies (consult-policy.js) + their
// integration into the consult engine. Run: node test-consult-policy.mjs
// (or npm run smoke:policy)

import assert from 'assert';
import { normalizePolicies, applyPolicies, matchAuthorization, bindingSuppressed, loadPolicies } from './consult-policy.js';
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

// ── §10.5 tombstones: a REVOKED rule must not resolve ─────────────────────────
console.log('\nrevoked rules (tombstones) never resolve');
{
  // normalizePolicies is the single ingest point for both homes, so the drop belongs here.
  // The merge already keeps revoked rules out of `rules`; this covers the copies it can't
  // reach — a restored backup, or a producer that doesn't implement tombstones.
  const live = { id: 'gr-live', match: { domains: ['legal'] }, effect: 'escalate' };
  const dead = { id: 'gr-dead', match: { domains: ['finance'] }, effect: 'autoproceed' };

  const kept = normalizePolicies({ version: '0.1', rules: [live, dead], revoked: [{ id: 'gr-dead' }] });
  ok(kept.length === 1 && kept[0].id === 'gr-live',
    `the tombstoned rule is dropped at ingest, the live one survives (got ${JSON.stringify(kept.map(r => r.id))})`);

  ok(normalizePolicies({ version: '0.1', rules: [live, dead] }).length === 2,
    'without a tombstone both rules ingest as before (no behavior change)');

  // End to end: a revoked autoproceed must not silence the guardrail it was overriding.
  const fp = { phaedo_fingerprint: { persona_strength: 0.6, consult_policies: {
    version: '0.1',
    rules: [{ id: 'gr-auto', match: { domains: ['finance'] }, effect: 'autoproceed' }],
    revoked: [{ id: 'gr-auto', at: '2026-07-24T12:00:00.000Z' }],
  }, layers: { decision_and_risk: { responses: [{ answer: 'Careful and deliberate' }] } } } };
  const r = buildConsultationResponse(fp, {
    consultation_type: 'action_approval',
    action_descriptor: { domain: 'finance', reversible: false, magnitude: 'high' },
  });
  ok(r.signal !== 'proceed',
    `a REVOKED autoproceed no longer forces proceed (got ${r.signal})`);
}

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
// Fixed clock so an expires_at assertion is deterministic.
const POPUP_NOW = Date.parse('2026-07-25T12:00:00Z');
function buildLikePopup({ domains = '', magmin = '', magmax = '', rev = '', effect = '', note = '',
                         expiresDays, requireBinding } = {}) {
  const match = {};
  const ds = domains.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ds.length) match.domains = ds;
  if (magmin) match.magnitude_min = magmin;
  if (magmax) match.magnitude_max = magmax;
  if (rev) match.reversible = rev === 'true';
  // No default effect. The form's effect select opens on a "— choose —" placeholder and
  // addGuardrail REFUSES an empty pick rather than substituting one: this control can grant
  // autonomy, and a rule authored by ignoring the dropdown is a rule nobody chose.
  if (!effect) return null;
  const rule = { id: 'rule-' + Date.now().toString(36), match, effect };
  if (note) rule.note = note;
  // §10.5 GRANT TERMS, written for authority-EXPANDING effects only. The form defaults to a
  // 30-day expiry and require_binding ON; both are narrowing and both are enforced for
  // expanding effects only, so attaching them to a restrictive rule would imply a limit the
  // resolver deliberately ignores.
  if (effect === 'autoproceed' || effect === 'bias_bold') {
    const days = expiresDays === undefined ? 30 : expiresDays;   // form default
    if (Number.isFinite(days) && days > 0) rule.expires_at = new Date(POPUP_NOW + days * 86400000).toISOString();
    if (requireBinding !== false) rule.require_binding = true;   // checkbox default ON
  }
  return rule;
}
ok(buildLikePopup({}) === null, 'no effect chosen → no rule is authored (the form refuses instead of defaulting)');
// §10.5 GRANT TERMS — the form could express NEITHER until 2026-07-25, so every
// hand-authored autoproceed was permanent and unbound, and §8.3 minted a payment credential
// with no expiration against one. Both are narrowing, and both are enforced for
// authority-EXPANDING effects only.
{
  const grant = buildLikePopup({ domains: 'finance', effect: 'autoproceed' });
  ok(typeof grant.expires_at === 'string', 'a granting rule gets an expiry BY DEFAULT (30 days)');
  ok(Date.parse(grant.expires_at) > POPUP_NOW, 'the default expiry is in the future');
  ok(grant.require_binding === true, 'require_binding defaults ON for a grant (spec §10.5 SHOULD)');

  // Unbounded is still expressible — it just has to be chosen.
  const forever = buildLikePopup({ effect: 'autoproceed', expiresDays: null });
  ok(!('expires_at' in forever), 'choosing "no expiry" omits the field rather than writing a sentinel');
  const unbound = buildLikePopup({ effect: 'autoproceed', requireBinding: false });
  ok(!('require_binding' in unbound), 'unticking binding omits the field (false IS the schema default)');

  // A restrictive rule must NOT carry terms the resolver deliberately ignores for it.
  for (const effect of ['escalate', 'decline', 'bias_cautious']) {
    const r = buildLikePopup({ effect });
    ok(!('expires_at' in r) && !('require_binding' in r),
      `a "${effect}" rule carries no grant terms — they are enforced for expanding effects only`);
  }
  ok('expires_at' in buildLikePopup({ effect: 'bias_bold' }), 'bias_bold is a grant too, so it gets terms');

  // …and the terms actually bite once the resolver sees them.
  const bound = normalizePolicies([buildLikePopup({ domains: 'finance', effect: 'autoproceed' })]);
  ok(bound[0].requireBinding === true, 'require_binding survives normalization');
  ok(bound[0].expiresAt != null, 'expires_at survives normalization');
  const lapsed = normalizePolicies([{ ...buildLikePopup({ domains: 'finance', effect: 'autoproceed' }), expires_at: new Date(POPUP_NOW - 86400000).toISOString() }]);
  ok(applyPolicies(base('escalate'), n({ domain: 'finance' }), lapsed, { now: POPUP_NOW }).signal === 'escalate',
    'a LAPSED grant no longer forces proceed — the expiry the form now writes is enforced');
}

// The two-tier form's whole safety argument: the five refinements now live behind "More
// conditions", and leaving them alone must produce byte-for-byte what the flat form produced.
{
  const tier1Only = buildLikePopup({ domains: 'finance', effect: 'autoproceed' });
  const flatDefaults = buildLikePopup({ domains: 'finance', effect: 'autoproceed', magmin: '', magmax: '', rev: '', note: '' });
  ok(JSON.stringify({ ...tier1Only, id: 0 }) === JSON.stringify({ ...flatDefaults, id: 0 }),
    'a rule authored with Advanced untouched === the same rule with every Advanced field left blank');
  ok(!('magnitude_min' in tier1Only.match) && !('reversible' in tier1Only.match),
    'untouched Advanced fields stay ABSENT from match (blank never becomes a constraint)');
}
const authored = normalizePolicies([buildLikePopup({ domains: 'Financial, Legal', rev: 'false', effect: 'escalate', note: 'big irreversible' })]);
ok(authored.length === 1 && authored[0].domains.join(',') === 'financial,legal' && authored[0].reversible === false, 'popup-built rule normalizes (domains lowercased, reversible coerced)');
ok(applyPolicies(base('proceed'), n({ domain: 'financial', reversible: false, magnitude: 'high' }), authored).signal === 'escalate', 'popup-built escalate rule forces escalate end-to-end');
const anyDecline = normalizePolicies([buildLikePopup({ effect: 'decline' })]);
ok(applyPolicies(base('proceed'), n({ domain: 'whatever' }), anyDecline).signal === 'decline', 'an unconstrained popup rule applies to any action (the UI "blank = any" hint)');

// ── revocable authority — expires_at + agents (both ENFORCED) ────────────────
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

  // agents: parsed EXACTLY (opaque phone-issued ids — lowercasing could alias two
  // distinct clients, so the old RESERVED-era normalization is gone).
  const agRule = normalizePolicies([{ match: { domains: ['financial'] }, effect: 'decline', agents: ['c_AgentX'] }]);
  ok(agRule[0].agents.join(',') === 'c_AgentX', 'agents parsed case-exactly (opaque identifiers)');
}

// ── §10.5 `agents` — paired-client scoping, NARROWING-ONLY ───────────────────
// Matched against the SERVING client's own client_id (from the server's pairing.json),
// never the self-asserted agent_id. See docs/roadmap/paired-client-identity-2026-07-22.md.
console.log('\n§10.5 agents — paired-client scoping (narrowing-only)');
{
  const ME = 'c_ATFQrFdTjo';
  const OTHER = 'c_ZZZotherclient';
  const act = n({ domain: 'travel', reversible: true, magnitude: 'low' });

  // A RELAXING rule scoped to this client: applies to it, inert for everyone else.
  const scopedAuto = normalizePolicies([
    { id: 'auto-travel', match: { domains: ['travel'] }, effect: 'autoproceed', note: 'travel is pre-approved', agents: [ME] },
  ]);
  ok(matchAuthorization(act, scopedAuto, { clientId: ME })?.signal === 'proceed',
    'scoped autoproceed FIRES for the listed serving client');
  ok(matchAuthorization(act, scopedAuto, { clientId: OTHER }) === null,
    'scoped autoproceed is INERT for an unlisted client');
  ok(matchAuthorization(act, scopedAuto, { clientId: null }) === null,
    'scoped autoproceed is INERT when unpaired (no client_id)');
  ok(matchAuthorization(act, scopedAuto) === null,
    'scoped autoproceed is INERT when the caller supplies no context at all (fail-safe default)');

  // The whole reason scoping is narrowing-only: otherwise running an unlisted client
  // would be a way to SHED a guardrail.
  const scopedDecline = normalizePolicies([
    { id: 'no-wires', match: { domains: ['financial'] }, effect: 'decline', note: 'no autonomous wires', agents: [ME] },
  ]);
  const fin = n({ domain: 'financial', reversible: false });
  ok(matchAuthorization(fin, scopedDecline, { clientId: ME })?.signal === 'decline',
    'scoped RESTRICTIVE rule applies to the listed client');
  ok(matchAuthorization(fin, scopedDecline, { clientId: OTHER })?.signal === 'decline',
    'scoped RESTRICTIVE rule STILL applies to an unlisted client (scoping never sheds a guardrail)');
  ok(matchAuthorization(fin, scopedDecline, { clientId: null })?.signal === 'decline',
    'scoped RESTRICTIVE rule STILL applies when unpaired');

  // Unscoped rules are untouched — this is opt-in per rule.
  const unscoped = normalizePolicies([{ match: { domains: ['travel'] }, effect: 'autoproceed', note: 'x' }]);
  ok(matchAuthorization(act, unscoped, { clientId: null })?.signal === 'proceed',
    'an UNSCOPED autoproceed is unaffected by the absence of a client_id');

  // Exact comparison: an id differing only in case is a different principal.
  ok(matchAuthorization(act, scopedAuto, { clientId: ME.toLowerCase() }) === null,
    'client_id comparison is case-exact (a case variant is NOT the same client)');

  // bias_bold is relaxing too, so it takes the same gate; bias_cautious does not.
  const scopedBold = normalizePolicies([{ match: { domains: ['travel'] }, effect: 'bias_bold', agents: [ME] }]);
  ok(applyPolicies(base('clarify'), act, scopedBold, { clientId: ME }).signal === 'proceed_with_note',
    'scoped bias_bold nudges for the listed client');
  ok(applyPolicies(base('clarify'), act, scopedBold, { clientId: OTHER }).signal === 'clarify',
    'scoped bias_bold is inert for an unlisted client');
  const scopedCautious = normalizePolicies([{ match: { domains: ['travel'] }, effect: 'bias_cautious', agents: [ME] }]);
  ok(applyPolicies(base('proceed'), act, scopedCautious, { clientId: OTHER }).signal === 'proceed_with_note',
    'scoped bias_cautious STILL nudges an unlisted client (restrictive → narrowing-only)');

  // §10.4: an unlisted client must not learn that a relaxing rule exists for someone
  // else. The binding-suppressed note is the one channel that could leak it.
  const scopedBound = normalizePolicies([
    { match: { domains: ['travel'] }, effect: 'autoproceed', note: 'x', agents: [ME], require_binding: true },
  ]);
  ok(bindingSuppressed(act, scopedBound, { clientId: ME }) === true,
    'the listed client IS told its relaxing rule needs a binding');
  ok(bindingSuppressed(act, scopedBound, { clientId: OTHER }) === false,
    'an unlisted client is NOT told — scope-inert rules are excluded before the binding report (§10.4)');
  ok(!/did not apply/.test(applyPolicies(base('proceed'), act, scopedBound, { clientId: OTHER }).rationale_hint),
    'and the rationale_hint carries no trace of the other client\'s rule');
}

// ── §10.5 agents — adversarial pass (each of these was a real defect) ─────────
console.log('\n§10.5 agents — adversarial hardening');
{
  const ME = 'c_ATFQrFdTjo';
  const act = n({ domain: 'travel', reversible: true, magnitude: 'low' });

  // (1) ABSENT vs EMPTY. Collapsing them made an authoring UI that deselects every
  //     client silently grant UNIVERSAL autonomy — the inverse of the subject's intent.
  const unscoped = normalizePolicies([{ match: { domains: ['travel'] }, effect: 'autoproceed', note: 'x' }]);
  ok(unscoped[0].agents === null, 'absent agents parses to null (unscoped), not []');
  ok(matchAuthorization(act, unscoped, { clientId: null })?.signal === 'proceed', 'absent agents → applies to everyone');

  const emptyScope = normalizePolicies([{ match: { domains: ['travel'] }, effect: 'autoproceed', note: 'x', agents: [] }]);
  ok(Array.isArray(emptyScope[0].agents) && emptyScope[0].agents.length === 0, 'empty agents stays an empty ARRAY (a scope naming nobody)');
  ok(matchAuthorization(act, emptyScope, { clientId: ME }) === null, 'agents:[] matches NO client — not "everyone"');
  ok(matchAuthorization(act, emptyScope, { clientId: null }) === null, 'agents:[] is inert when unpaired too');

  // (2) A rule that never went through normalizePolicies must not THROW. The exported
  //     API allows a hand-built rule, and this sits on every consultation's path — a
  //     TypeError here aborts the whole consult instead of failing inert.
  const handBuilt = [{ effect: 'autoproceed', domains: ['travel'], magMin: null, magMax: null, reversible: null, amountGt: null, amountLt: null, expiresAt: null, requireBinding: false, note: 'x', id: 'r' }];
  let threw = false;
  let matched = null;
  try { matched = matchAuthorization(act, handBuilt, { clientId: ME }); } catch { threw = true; }
  ok(!threw, 'a rule with NO agents field does not throw (defensive, like bindingSatisfied)');
  ok(matched?.signal === 'proceed', 'and it is treated as unscoped, matching the absent-field semantics');

  // malformed (present but not an array) → fail CLOSED for a relaxing effect
  const malformed = [{ ...handBuilt[0], agents: 'c_ATFQrFdTjo' }];
  ok(matchAuthorization(act, malformed, { clientId: ME }) === null,
    'a non-array agents fails closed for a relaxing rule (never substring-matches a string scope)');
  const malformedRestrictive = [{ ...handBuilt[0], effect: 'decline', agents: 'junk' }];
  ok(matchAuthorization(act, malformedRestrictive, { clientId: ME })?.signal === 'decline',
    'a malformed scope still cannot disable a RESTRICTIVE rule');

  // (3) Non-string entries are DROPPED, not coerced. String() would turn [null] into a
  //     scope matching the literal "null", and [42] into one matching a client id "42".
  const junk = normalizePolicies([{ match: { domains: ['travel'] }, effect: 'autoproceed', note: 'x', agents: [null, 42, {}, [], true, ME] }]);
  ok(junk[0].agents.join(',') === ME, 'non-string agents entries are dropped, never coerced');
  ok(matchAuthorization(act, junk, { clientId: '42' }) === null, 'a client id of "42" does NOT match an agents entry of 42');
  ok(matchAuthorization(act, junk, { clientId: 'null' }) === null, 'a client id of "null" does NOT match an agents entry of null');
  ok(matchAuthorization(act, junk, { clientId: '[object Object]' }) === null, 'no [object Object] principal is invented');
  ok(matchAuthorization(act, junk, { clientId: ME })?.signal === 'proceed', 'the real entry still matches');

  // all-junk collapses to an empty scope — which matches NOBODY, not everybody
  const allJunk = normalizePolicies([{ match: { domains: ['travel'] }, effect: 'autoproceed', note: 'x', agents: [null, 42] }]);
  ok(matchAuthorization(act, allJunk, { clientId: ME }) === null, 'an agents list of pure junk scopes to nobody (never widens to everybody)');

  // (4) A scope-inert relaxing rule must not shadow a later RESTRICTIVE match.
  const mixed = normalizePolicies([
    { match: { domains: ['travel'] }, effect: 'autoproceed', note: 'auto', agents: ['c_other'] },
    { match: { domains: ['travel'] }, effect: 'escalate', note: 'esc' },
  ]);
  ok(matchAuthorization(act, mixed, { clientId: ME })?.signal === 'escalate',
    'an unlisted client falls through the inert autoproceed to the restrictive rule');
  ok(matchAuthorization(act, mixed, { clientId: 'c_other' })?.signal === 'proceed',
    'the listed client still gets its grant (precedence unchanged)');
}

// ── §5 config home migration, part 2: the sibling artifact is CANONICAL ───────
console.log('\n§5 user-configuration canonical read (config home, part 2)');
{
  const auth = (id, effect) => ({ instruction_id: id, kind: 'authorization', match: { domains: ['legal'] }, effect });
  // Sibling present → its standing_instructions replace the fingerprint A-home
  // (dual-home lockstep — reading both would double every rule).
  // A REAL pair always carries fingerprint_id — §5.4 makes the pairing mandatory and
  // deriveUserConfiguration refuses without it. The fixture used to omit it on both sides, so
  // the pairing branch was unreachable and a mis-paired configuration would have sailed through.
  const both = { phaedo_fingerprint: { fingerprint_id: 'fp-1', subject_id: 's-1', standing_rules: [auth('fp-rule', 'decline')] },
                 phaedo_user_configuration: { configuration_id: 'c-1', fingerprint_id: 'fp-1', subject_id: 's-1', standing_instructions: [auth('cfg-rule', 'escalate')] } };
  const pols = loadPolicies(both);
  ok(pols.length === 1 && pols[0].id === 'cfg-rule' && pols[0].effect === 'escalate', 'config standing_instructions REPLACE the A-home (no doubling, config wins)');

  // §5.4 on the AUTHORIZATION path. These entries become authorizations, so a configuration
  // belonging to another identity — or to a fingerprint since replaced by a restore or a
  // cross-device merge — would decide what this agent may do without asking. Reachable without
  // any hostile actor: replace the fingerprint, leave the old configuration in the vault.
  const misPaired = { phaedo_fingerprint: { fingerprint_id: 'fp-1', subject_id: 's-1', standing_rules: [auth('fp-rule', 'decline')] },
                      phaedo_user_configuration: { configuration_id: 'c-1', fingerprint_id: 'fp-OTHER', subject_id: 's-1',
                                                   standing_instructions: [auth('cfg-rule', 'escalate')] } };
  const misIds = loadPolicies(misPaired).map(r => r.id);
  ok(!misIds.includes('cfg-rule'),
    'a configuration naming a DIFFERENT fingerprint does NOT supply authorizations (§5.4)');
  ok(misIds.includes('fp-rule'),
    '…and the A-home answers instead, so the subject keeps the guardrail rather than losing it');

  const wrongSubject = { phaedo_fingerprint: { fingerprint_id: 'fp-1', subject_id: 's-1', standing_rules: [auth('fp-rule', 'decline')] },
                         phaedo_user_configuration: { configuration_id: 'c-1', fingerprint_id: 'fp-1', subject_id: 's-OTHER',
                                                      standing_instructions: [auth('cfg-rule', 'escalate')] } };
  ok(!loadPolicies(wrongSubject).map(r => r.id).includes('cfg-rule'),
    'a contradicting subject_id is rejected on the authorization path too');
  // Sibling present with EMPTY instructions → authored read is empty (canonical means canonical)
  ok(loadPolicies({ phaedo_fingerprint: { fingerprint_id: 'fp-1', subject_id: 's-1', standing_rules: [auth('fp-rule', 'decline')] },
                    phaedo_user_configuration: { configuration_id: 'c-1', fingerprint_id: 'fp-1', subject_id: 's-1', standing_instructions: [] } }).length === 0,
     'an empty canonical config yields no authored policies (A-home not consulted)');
  // The distinction that matters, now that §5.4 can send a config to the fallback: an EMPTY
  // config that GOVERNS means "no authored policies", while a config that does NOT govern means
  // "no evidence" and the A-home answers. Same empty list, opposite meanings.
  ok(loadPolicies({ phaedo_fingerprint: { fingerprint_id: 'fp-1', subject_id: 's-1', standing_rules: [auth('fp-rule', 'decline')] },
                    phaedo_user_configuration: { configuration_id: 'c-1', fingerprint_id: 'fp-OTHER', subject_id: 's-1', standing_instructions: [] } })
       .map(r => r.id).includes('fp-rule'),
     'an empty config that does NOT govern is not a statement — the A-home still answers');
  // No sibling → the A-home still reads (back-compat until transport lands)
  ok(loadPolicies({ phaedo_fingerprint: { standing_rules: [auth('fp-rule', 'decline')] } })[0].id === 'fp-rule',
     'no sibling → A-home standing_rules still read');
  // Bound negative instructions read from the sibling too
  // Paired, because §5.4 requires a fingerprint to pair TO. A configuration with no fingerprint
  // present is not a state that occurs: the cutover removes standing_rules from the fingerprint,
  // not the fingerprint itself, so a profile always carries one.
  const cfgBias = loadPolicies({
    phaedo_fingerprint: { fingerprint_id: 'fp-1', subject_id: 's-1' },
    phaedo_user_configuration: { configuration_id: 'c-1', fingerprint_id: 'fp-1', subject_id: 's-1', standing_instructions: [
      { instruction_id: 'i1', kind: 'instruction', text: 'I confirm recurring costs.', decision: { dimension: 'evidence_threshold', polarity: 'negative', domain: 'finance' } },
    ] } });
  ok(cfgBias.length === 1 && cfgBias[0].effect === 'bias_cautious', 'bound negative instruction projects a bias from the sibling');
  // Deprecated read paths are NOT displaced by the sibling
  ok(loadPolicies({ phaedo_fingerprint: { fingerprint_id: 'fp-1', subject_id: 's-1' },
                    phaedo_user_configuration: { configuration_id: 'c-1', fingerprint_id: 'fp-1', subject_id: 's-1', standing_instructions: [] },
                    phaedo_consult_policies: { version: '0.1', rules: [{ match: { domains: ['x'] }, effect: 'decline' }] } }).length === 1,
     'deprecated top-level consult_policies still read alongside a canonical config');
}

// ── amount_lt — the missing CEILING (§10.5) ───────────────────────────────────
// amount_gt is a floor ("fires above N"). Without a ceiling an autoproceed rule
// could not express "up to $75" at all, which is why §10.7 refused to propose
// autonomy for any priced class and why the AP2 mapping had no honest max_amount.
console.log('\namount_lt (numeric ceiling)');
{
  const ceil = normalizePolicies({ rules: [
    { id: 'small', match: { domains: ['groceries'], amount_lt: 75 }, effect: 'autoproceed', note: 'small orders' },
  ] });
  ok(ceil[0].amountLt === 75, 'amount_lt parsed onto the rule');
  ok(matchAuthorization(n({ domain: 'groceries', amount: 40 }), ceil)?.signal === 'proceed', 'under the ceiling → fires');
  ok(matchAuthorization(n({ domain: 'groceries', amount: 200 }), ceil) === null, 'over the ceiling → does not fire');
  ok(matchAuthorization(n({ domain: 'groceries', amount: 75 }), ceil) === null,
     'EXACTLY at the ceiling does not fire — strictly-less mirrors amount_gt, and the miss falls back to a full consult (fail-safe direction)');

  // The property that makes an amount bound safe to add to any rule.
  ok(matchAuthorization(n({ domain: 'groceries' }), ceil) === null,
     'an action with NO amount does NOT slip under a ceiling nobody can check');
  ok(matchAuthorization(n({ domain: 'groceries', amount: 'cheap' }), ceil) === null, 'a non-numeric amount does not satisfy the ceiling');

  // Floor + ceiling = a band; both must hold.
  const band = normalizePolicies({ rules: [
    { id: 'mid', match: { domains: ['spend'], amount_gt: 100, amount_lt: 1000 }, effect: 'escalate', note: 'mid-size spend' },
  ] });
  ok(matchAuthorization(n({ domain: 'spend', amount: 500 }), band)?.signal === 'escalate', 'inside the band → fires');
  ok(matchAuthorization(n({ domain: 'spend', amount: 50 }), band) === null, 'below the band → no');
  ok(matchAuthorization(n({ domain: 'spend', amount: 5000 }), band) === null, 'above the band → no');

  // Existing amount_gt behaviour is untouched.
  const floor = normalizePolicies({ rules: [{ id: 'big', match: { amount_gt: 5000 }, effect: 'escalate' }] });
  ok(matchAuthorization(n({ amount: 9000 }), floor)?.signal === 'escalate', 'amount_gt still fires above the floor');
  ok(matchAuthorization(n({ amount: 10 }), floor) === null, 'amount_gt still ignores small amounts');

  for (const bad of ['75', null, NaN, Infinity, {}]) {
    ok(normalizePolicies({ rules: [{ effect: 'escalate', match: { amount_lt: bad } }] })[0].amountLt === null,
       `non-finite amount_lt ${JSON.stringify(bad)} is ignored, not coerced`);
  }
}

// ── §10.5 require_binding — the descriptor is untrusted input ─────────────────
// The whole point: an authored autoproceed rule matches on fields the AGENT wrote.
// require_binding says "don't relax anything unless the request is tied to a
// concrete call." Enforced in the authority-NARROWING direction only.
console.log('\nrequire_binding (§10.5 binding gate)');
{
  const relaxing = normalizePolicies({ rules: [
    { id: 'auto', match: { domains: ['writing'] }, effect: 'autoproceed', require_binding: true, note: 'pre-approved writing' },
  ] });
  ok(relaxing[0].requireBinding === true, 'require_binding parsed onto the rule');
  ok(normalizePolicies({ rules: [{ effect: 'autoproceed' }] })[0].requireBinding === false,
     'require_binding defaults FALSE — existing authorizations are unchanged');
  for (const bad of [1, 'true', 'yes', null]) {
    ok(normalizePolicies({ rules: [{ effect: 'autoproceed', require_binding: bad }] })[0].requireBinding === false,
       `require_binding: ${JSON.stringify(bad)} is not true → treated as false (strict boolean)`);
  }

  const unbound = n({ domain: 'writing', bound: false });
  const bound   = n({ domain: 'writing', bound: true });

  ok(matchAuthorization(unbound, relaxing) === null, 'unbound request: the autoproceed rule does NOT fire');
  ok(matchAuthorization(bound, relaxing)?.signal === 'proceed', 'bound request: the autoproceed rule fires normally');

  // The whole safety argument: gating must never make the oracle MORE permissive.
  const restrictive = normalizePolicies({ rules: [
    { id: 'esc', match: { domains: ['financial'] }, effect: 'escalate', require_binding: true, note: 'money goes to a human' },
    { id: 'dec', match: { domains: ['legal'] }, effect: 'decline', require_binding: true, note: 'never sign' },
  ] });
  ok(matchAuthorization(n({ domain: 'financial', bound: false }), restrictive)?.signal === 'escalate',
     'require_binding does NOT disable an escalate rule on an unbound request (guardrails cannot be shed by omitting a field)');
  ok(matchAuthorization(n({ domain: 'legal', bound: false }), restrictive)?.signal === 'decline',
     'require_binding does NOT disable a decline rule on an unbound request');

  // bias_bold is relaxing too; bias_cautious is not.
  const biases = normalizePolicies({ rules: [
    { id: 'bold', match: { domains: ['writing'] }, effect: 'bias_bold', require_binding: true },
  ] });
  ok(applyPolicies(base('clarify'), unbound, biases).signal === 'clarify', 'unbound: a require_binding bias_bold does not nudge');
  ok(applyPolicies(base('clarify'), bound, biases).signal === 'proceed_with_note', 'bound: bias_bold nudges as usual');
  const cautious = normalizePolicies({ rules: [
    { id: 'careful', match: { domains: ['writing'] }, effect: 'bias_cautious', require_binding: true },
  ] });
  ok(applyPolicies(base('proceed'), unbound, cautious).signal === 'proceed_with_note',
     'unbound: a require_binding bias_CAUTIOUS still nudges (narrowing direction is never gated)');

  // A silently-non-firing rule is a support nightmare — say why.
  const explained = applyPolicies(base('proceed'), unbound, relaxing);
  ok(/not bound to a concrete action/i.test(explained.rationale_hint),
     `the response explains why the rule was withheld — got "${explained.rationale_hint}"`);
  ok(explained.rationale_hint.length <= 280, 'rationale_hint stays within the §10.3 bound');
  ok(!/not bound to a concrete action/i.test(applyPolicies(base('proceed'), bound, relaxing).rationale_hint),
     'no binding note when the rule actually fired');
  ok(!/not bound to a concrete action/i.test(applyPolicies(base('proceed'), n({ domain: 'cooking' }), relaxing).rationale_hint),
     'no binding note when no rule matched at all (only reports rules held back BY the gate)');

  // The §10.3 shape is unchanged either way.
  ok(Object.keys(explained).sort().join() === KEYS.join(), 'binding note does not change the response shape');

  // REGRESSION: the gate has to survive the trip through the AUTHORED home. Testing
  // normalizePolicies alone passes while `require_binding` is silently dropped by
  // authorizationsFromStandingRules — which is where every real authorization lives,
  // so the flag would be declared-but-inert for every rule a subject actually wrote.
  const authored = loadPolicies({ phaedo_fingerprint: { standing_rules: [
    { instruction_id: 'a1', kind: 'authorization', match: { domains: ['writing'] }, effect: 'autoproceed', require_binding: true, note: 'pre-approved' },
  ] } });
  ok(authored[0].requireBinding === true, 'require_binding survives standing_rules → policy projection (A-home)');
  ok(matchAuthorization(n({ domain: 'writing', bound: false }), authored) === null,
     'an AUTHORED require_binding autoproceed does not fire unbound');
  ok(matchAuthorization(n({ domain: 'writing', bound: true }), authored)?.signal === 'proceed',
     'an AUTHORED require_binding autoproceed fires when bound');

  // Same for the §5 canonical config home.
  const cfgAuthored = loadPolicies({
    phaedo_fingerprint: { fingerprint_id: 'fp-1', subject_id: 's-1' },
    phaedo_user_configuration: { configuration_id: 'c-1', fingerprint_id: 'fp-1', subject_id: 's-1', standing_instructions: [
      { instruction_id: 'c1', kind: 'authorization', match: { domains: ['writing'] }, effect: 'autoproceed', require_binding: true, note: 'pre-approved' },
    ] } });
  ok(cfgAuthored[0].requireBinding === true, 'require_binding survives the §5 config home too');
}

// ── §5.7 commitments reach the resolver through loadPolicies ─────────────────
// The projection is what makes the feature small — precedence, expiry and the
// deterministic pre-flight all work unchanged because a commitment IS a rule by
// the time the engine sees it. These lock that it actually arrives.
console.log('\ncommitments (§5.7 decision state)');
{
  const NOW = Date.parse('2026-07-22T12:00:00Z');
  const iso = (days) => new Date(NOW + days * 86400000).toISOString();
  const vd = { phaedo_fingerprint: { commitments: [
    { commitment_id: 'c1', statement: 'I already told ACME we are not renewing.', domains: ['procurement'], effect: 'escalate', expires_at: iso(30), source: 'subject' },
    { commitment_id: 'c2', statement: 'On leave until the 4th.', effect: 'bias_cautious', disclose: true, expires_at: iso(10), source: 'subject' },
    { commitment_id: 'c3', statement: 'lapsed', effect: 'decline', domains: ['procurement'], expires_at: iso(-1), source: 'subject' },
  ] } };
  const pols = loadPolicies(vd, { now: NOW });
  ok(pols.length === 2, `active commitments load as policies, lapsed dropped — got ${pols.length}`);

  const proc = n({ domain: 'procurement' });
  const auth = matchAuthorization(proc, pols, { now: NOW });
  ok(auth && auth.signal === 'escalate', 'a matching commitment forces escalate through the normal authorization path');
  ok(!/ACME/.test(applyPolicies(base('proceed'), proc, pols, { now: NOW }).rationale_hint),
     'the undisclosed statement does NOT reach the agent in rationale_hint');
  ok(/standing commitment/i.test(applyPolicies(base('proceed'), proc, pols, { now: NOW }).rationale_hint),
     'but the agent is told a commitment covers it (so the escalate is not unexplained)');

  // An unscoped commitment biases everything — deliberate, and it is only cautious.
  ok(applyPolicies(base('proceed'), n({ domain: 'writing' }), pols, { now: NOW }).signal === 'proceed_with_note',
     'an unscoped commitment nudges other domains cautious');
  ok(/On leave until the 4th/.test(applyPolicies(base('proceed'), n({ domain: 'writing' }), pols, { now: NOW }).rationale_hint),
     'a disclosable commitment does carry its statement');

  // Time alone retires it — no write required.
  const later = loadPolicies(vd, { now: NOW + 40 * 86400000 });
  ok(later.length === 0, 'every commitment lapses with time, with no write and no cleanup job');
  ok(matchAuthorization(proc, later, { now: NOW + 40 * 86400000 }) === null, 'a lapsed commitment stops gating');

  // A commitment can never be the thing that GRANTS autonomy.
  const relaxing = loadPolicies({ phaedo_fingerprint: { commitments: [
    { commitment_id: 'x', statement: 'go wild', domains: ['writing'], effect: 'autoproceed', expires_at: iso(5), source: 'subject' },
  ] } }, { now: NOW });
  ok(relaxing.length === 0, 'a commitment carrying autoproceed never becomes a policy');

  // And a fingerprint with no commitments behaves exactly as before.
  ok(loadPolicies({ phaedo_fingerprint: { standing_rules: [] } }, { now: NOW }).length === 0, 'no commitments → no change');
}

console.log('\nan UNSTATED magnitude satisfies no magnitude bound on a RELAXING rule (v0.1.68)');
{
  // The agent decides whether to state magnitude. It used to default to `medium` — on the wire and
  // in the matcher — so a grant the subject capped at `medium` fired for an action whose stakes were
  // never stated. `amount` already fails closed on omission; this makes magnitude do the same, for
  // the rules that expand authority. Restrictive rules are unchanged, so no guardrail is lost.
  const T0 = Date.parse('2026-09-14T12:00:00Z');
  const m = (req, rules) => matchAuthorization(req, normalizePolicies(rules), { now: T0 });
  const noMag = { type: 'action', domain: 'shopping', reversible: true, amount: 5, bound: true };
  const capped   = [{ id: 'cap', effect: 'autoproceed', note: 'cap', match: { domains: ['shopping'], magnitude_max: 'high' } }];
  const floored  = [{ id: 'flr', effect: 'autoproceed', note: 'flr', match: { domains: ['shopping'], magnitude_min: 'low' } }];
  const uncapped = [{ id: 'any', effect: 'autoproceed', note: 'any', match: { domains: ['shopping'] } }];
  const guard    = [{ id: 'esc', effect: 'escalate',    note: 'esc', match: { domains: ['shopping'], magnitude_min: 'medium' } }];

  ok(m(noMag, capped) === null,
    'a grant capped at `high` does NOT fire on a request with no magnitude — the cap ranked the '
    + 'unknown as medium and let it through');
  ok(m(noMag, floored) === null,
    'nor does a grant with a magnitude FLOOR — neither bound is satisfied by an unstated value');
  ok(m({ ...noMag, magnitude: 'medium' }, capped)?.signal === 'proceed',
    'state the magnitude and the same grant fires — this is about omission, not about the cap');
  ok(m(noMag, uncapped)?.signal === 'proceed',
    'a grant with NO magnitude bound is untouched — only rules the subject qualified by magnitude change');
  ok(m(noMag, guard)?.signal === 'escalate',
    'a RESTRICTIVE rule still reads an unknown as medium, so a guardrail at `medium` keeps biting');

  const { normalizeRequest } = await import('./consult-core.js');
  const n = normalizeRequest({ consultation_type: 'action_approval', action_descriptor: { domain: 'shopping' } });
  ok(n.magnitude === undefined,
    'and the wire path no longer manufactures `medium` — the resolver can now tell "said medium" '
    + 'from "said nothing", and the receipt records what was actually sent');
}

console.log(`\n✓ consult-policy: ${pass} checks passed`);
