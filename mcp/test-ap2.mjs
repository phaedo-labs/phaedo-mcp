#!/usr/bin/env node
// Anamnesis ↔ AP2 profile (ap2.js). Run: node test-ap2.mjs   (from mcp/)
//
// The mapping's value is entirely in what it REFUSES to emit. A credential that
// overstates authority is worse than no credential, because a merchant acts on it.
// So most of this suite is about the cases that must produce nothing.

import assert from 'node:assert';
import { buildIntentMandatePayload, authorizationToIntentConstraints, buildRiskPayload } from './ap2.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const NOW = Date.parse('2026-07-22T12:00:00Z');
const iso = (days) => new Date(NOW + days * 86400000).toISOString();

const auth = (over = {}) => ({
  instruction_id: 'a1',
  kind: 'authorization',
  match: { domains: ['groceries'], reversible: true, magnitude_max: 'low' },
  effect: 'autoproceed',
  require_binding: true,
  expires_at: iso(30),
  ...over,
});

// ── only a GRANT becomes a mandate ────────────────────────────────────────────
console.log('\nonly autoproceed maps to a mandate');
{
  ok(authorizationToIntentConstraints(auth(), { now: NOW }) !== null, 'an autoproceed authorization maps');

  // The important refusals. "Ask me first" is the ABSENCE of a mandate; rendering it
  // as a credential would invert its meaning to a merchant.
  for (const effect of ['escalate', 'require_human', 'decline', 'bias_cautious', 'bias_bold']) {
    ok(authorizationToIntentConstraints(auth({ effect }), { now: NOW }) === null,
       `${effect} produces NO mandate — a restrictive rule is not a credential`);
  }
  ok(authorizationToIntentConstraints(auth({ kind: 'instruction' }), { now: NOW }) === null, 'an instruction is not a grant');
  ok(authorizationToIntentConstraints(auth({ expires_at: iso(-1) }), { now: NOW }) === null, 'a LAPSED authorization is never exported as live authority');
  for (const bad of [null, undefined, 'rule', 42, []]) {
    ok(authorizationToIntentConstraints(bad, { now: NOW }) === null, `degenerate rule ${JSON.stringify(bad)} → null`);
  }
}

// ── constraint translation ────────────────────────────────────────────────────
console.log('\nconstraints translate structurally');
{
  const g = authorizationToIntentConstraints(auth({ match: { domains: ['groceries', 'household'], reversible: true, magnitude_max: 'medium', amount_lt: 75 } }), { now: NOW });
  ok(JSON.stringify(g.constraints.categories) === JSON.stringify(['groceries', 'household']), 'domains → categories');
  ok(g.constraints.refundable_only === true, 'reversible → refundable_only');
  ok(g.constraints.max_amount === 75, 'amount_lt (a CEILING) → max_amount');
  ok(g.constraints.annotations.anamnesis_magnitude_max === 'medium',
     'magnitude has no commerce counterpart, so it rides as an annotation — never as a spend limit');

  // The bug amount_lt fixes. `amount_gt` is a FLOOR — "fires above N". Mapping it to
  // AP2's max_amount would tell a merchant the subject capped spending at exactly the
  // figure above which they wanted MORE scrutiny: an inversion, on a payment credential.
  const floorOnly = authorizationToIntentConstraints(auth({ match: { domains: ['spend'], reversible: true, amount_gt: 5000 } }), { now: NOW });
  ok(!('max_amount' in floorOnly.constraints), 'amount_gt must NOT become max_amount — it is a floor, not a cap');
  ok(floorOnly.constraints.annotations.anamnesis_amount_floor === 5000, 'the floor rides as an annotation instead');

  // Both together = a band; the ceiling is the cap, the floor is context.
  const band = authorizationToIntentConstraints(auth({ match: { domains: ['spend'], reversible: true, amount_gt: 10, amount_lt: 200 } }), { now: NOW });
  ok(band.constraints.max_amount === 200 && band.constraints.annotations.anamnesis_amount_floor === 10,
     'a band maps the ceiling to max_amount and keeps the floor as an annotation');
  // Both annotation writers must MERGE, not overwrite — the floor is written first
  // and magnitude second, so a plain assignment would silently drop the floor.
  const both = authorizationToIntentConstraints(auth({ match: { domains: ['spend'], reversible: true, amount_gt: 10, magnitude_max: 'medium' } }), { now: NOW });
  ok(both.constraints.annotations.anamnesis_amount_floor === 10 && both.constraints.annotations.anamnesis_magnitude_max === 'medium',
     'annotations merge rather than overwrite each other');
  ok(g.requires_action_binding === true, 'require_binding is carried so a verifier sees the subject demanded a bound action');

  const bare = authorizationToIntentConstraints(auth({ match: {} }), { now: NOW });
  ok(Object.keys(bare.constraints).length === 0, 'an unconstrained match produces no invented constraints');
}

// ── the payload ───────────────────────────────────────────────────────────────
console.log('\nmandate payload');
{
  const fp = { standing_rules: [auth(), auth({ instruction_id: 'a2', match: { domains: ['transit'] }, expires_at: iso(7) })] };
  const m = buildIntentMandatePayload(fp, { now: NOW, agentId: 'shopper-v2', promptPlayback: 'Reorder the usual groceries under $75.' });
  ok(m.mandate_type === 'intent', 'mandate_type is intent');
  ok(m.grants.length === 2, 'every live grant is carried');
  ok(m.expires_at === iso(7), 'the mandate expires with the FIRST grant to lapse (never outlives the narrowest authority)');
  ok(m.prompt_playback === 'Reorder the usual groceries under $75.', 'prompt playback carried');
  ok(m.signature === null, 'UNSIGNED by construction — the subject key lives in the phone enclave');
  ok(m.anamnesis_profile === '0.1', 'the profile version is stamped (AP2 moves on its own cadence)');

  // The empty case is the dangerous one: an empty credential reads as "authorized,
  // no constraints". It must be null, not a mandate with an empty grants array.
  ok(buildIntentMandatePayload({}, { now: NOW }) === null, 'no authorizations → NO mandate (never an empty one)');
  ok(buildIntentMandatePayload({ standing_rules: [auth({ effect: 'escalate' })] }, { now: NOW }) === null, 'only restrictive rules → no mandate');
  ok(buildIntentMandatePayload({ standing_rules: [auth({ expires_at: iso(-1) })] }, { now: NOW }) === null, 'only lapsed rules → no mandate');
  ok(buildIntentMandatePayload(null, { now: NOW }) === null, 'no fingerprint → no mandate');
}

// ── consult_policies is the OTHER home for a standing authorization (§10.5) ────
// The extension's Decision-guardrails form writes autoproceed rules HERE, not into
// standing_rules; a mandate that ignored this home was empty for a real subject.
console.log('\nconsult_policies authorizations feed the mandate too');
{
  // An autoproceed guardrail (consult_policies shape: {id, match, effect}, no `kind`).
  const policy = (over = {}) => ({ id: 'gr-1', match: { domains: ['finance'], amount_lt: 500 }, effect: 'autoproceed', expires_at: iso(10), ...over });

  const only = buildIntentMandatePayload({ consult_policies: { version: '0.1', rules: [policy()] } }, { now: NOW });
  ok(only && only.grants.length === 1, 'an autoproceed consult_policies rule alone produces a mandate');
  ok(only.grants[0].constraints.max_amount === 500, 'its amount_lt maps to the AP2 spend cap');

  const both = buildIntentMandatePayload(
    { standing_rules: [auth()], consult_policies: { version: '0.1', rules: [policy()] } }, { now: NOW });
  ok(both.grants.length === 2, 'grants from BOTH homes are carried');

  // The same per-rule guards apply in the new home: restrictive, lapsed, and client-scoped
  // consult_policies rules must NOT become grants.
  ok(buildIntentMandatePayload({ consult_policies: { version: '0.1', rules: [policy({ effect: 'decline' })] } }, { now: NOW }) === null,
    'a restrictive consult_policies rule is not a grant');
  ok(buildIntentMandatePayload({ consult_policies: { version: '0.1', rules: [policy({ expires_at: iso(-1) })] } }, { now: NOW }) === null,
    'a lapsed consult_policies rule is not a grant');
  ok(buildIntentMandatePayload({ consult_policies: { version: '0.1', rules: [policy({ agents: ['c_x'] })] } }, { now: NOW }) === null,
    'a client-scoped consult_policies rule is withheld, same as in standing_rules');

  // §10.5 TOMBSTONES — a REVOKED grant must never be minted into a mandate. The sync merge
  // already drops it from `rules`, but a restored backup or a producer without tombstone
  // support can still hand us the dead rule beside its own tombstone; signing a payment
  // credential against authority the subject took back is the worst failure this file has.
  ok(buildIntentMandatePayload(
    { consult_policies: { version: '0.1', rules: [policy()], revoked: [{ id: 'gr-1', at: iso(-1) }] } }, { now: NOW }) === null,
    'a REVOKED consult_policies grant produces no mandate');
  {
    const mixed = buildIntentMandatePayload({
      consult_policies: {
        version: '0.1',
        rules: [policy(), policy({ id: 'gr-live' })],
        revoked: [{ id: 'gr-1', at: iso(-1) }],
      },
    }, { now: NOW });
    ok(mixed && mixed.grants.length === 1 && mixed.grants[0].source_rule_id === 'gr-live',
      'the tombstone kills only the revoked grant; a live one beside it still mints');
  }
  ok(buildIntentMandatePayload(
    { standing_rules: [auth({ instruction_id: 'sr-1' })], consult_policies: { version: '0.1', rules: [], revoked: [{ id: 'sr-1', at: iso(-1) }] } },
    { now: NOW }) === null,
    'a tombstone also revokes a standing_rules authorization carrying that id');

  // The same rule id in both homes must not double-count.
  const dup = buildIntentMandatePayload(
    { standing_rules: [auth({ instruction_id: 'shared' })], consult_policies: { version: '0.1', rules: [policy({ id: 'shared' })] } },
    { now: NOW });
  ok(dup.grants.length === 1, 'the same authorization in both homes yields ONE grant, not two');

  ok(buildIntentMandatePayload({ consult_policies: { version: '0.1', rules: 'junk' } }, { now: NOW }) === null,
    'a malformed consult_policies never throws — just no grants from it');
}

// ── the §10.4 boundary holds on the new transport ─────────────────────────────
console.log('\nno persona crosses');
{
  const fp = {
    persona_strength: 0.82,
    layers: { decision_and_risk: { signals: [{ field: 'evidence_threshold', value: 'high', confidence: 0.9 }] },
              big_picture: { signals: [{ field: 'stable_principles', value: 'I am a pragmatic idealist' }] } },
    commitments: [{ commitment_id: 'c1', statement: 'I told ACME no', effect: 'escalate', expires_at: iso(9), source: 'subject' }],
    standing_rules: [auth()],
  };
  const wire = JSON.stringify(buildIntentMandatePayload(fp, { now: NOW }));
  ok(!/pragmatic idealist/.test(wire), 'no layer content crosses to a payments credential');
  ok(!/evidence_threshold/.test(wire), 'no inferred signals cross');
  ok(!/persona_strength/.test(wire) && !/0\.82/.test(wire), 'no persona strength crosses');
  ok(!/ACME/.test(wire), 'no commitment text crosses');
  ok(/groceries/.test(wire), 'only the subject-authored authorization bounds cross');
}

// ── risk payload ──────────────────────────────────────────────────────────────
console.log('\nrisk payload');
{
  ok(buildRiskPayload({}).anamnesis_consulted === false, 'no consultation → consulted:false');
  const r = buildRiskPayload({ consultSignal: 'proceed' });
  ok(r.anamnesis_consulted === true && r.anamnesis_signal === 'proceed', 'a signal rides the open risk payload');
  ok(Object.keys(r).length === 2, 'and nothing else does — the §10.4 currency is a signal, not a persona');
  const m = buildIntentMandatePayload({ standing_rules: [auth()] }, { now: NOW, consultSignal: 'proceed_with_note' });
  ok(m.risk_payload.anamnesis_signal === 'proceed_with_note', 'the mandate carries it through');
}

// ── §10.5 `agents`: a CLIENT-SCOPED grant is not exportable ───────────────────
// AP2 has no vocabulary for "this specific paired client". Exporting a scoped grant
// unscoped would tell a merchant the subject granted unconditionally what they
// granted to exactly one client — the same inversion this module already refuses for
// restrictive rules, except it crosses to a third party where it is least correctable.
{
  console.log('\nclient-scoped grants are withheld, not flattened');
  ok(authorizationToIntentConstraints(auth({ agents: ['c_ATFQrFdTjo'] }), { now: NOW }) === null,
    'an agents-scoped autoproceed is NOT exported as an unconditional mandate');
  ok(authorizationToIntentConstraints(auth({ agents: [] }), { now: NOW }) === null,
    'an empty scope (names nobody) is withheld too');
  ok(authorizationToIntentConstraints(auth(), { now: NOW }) !== null,
    'an UNSCOPED autoproceed still exports normally (absent agents = unscoped)');

  // and it must not leak in through the batch builder either
  const scoped = buildIntentMandatePayload({ standing_rules: [auth({ agents: ['c_ATFQrFdTjo'] })] }, { now: NOW });
  const grants = scoped?.grants ?? scoped?.intent_constraints ?? [];
  ok(Array.isArray(grants) ? grants.length === 0 : scoped === null,
    'the mandate builder emits no grant for a client-scoped rule');
  ok(!JSON.stringify(scoped ?? {}).includes('c_ATFQrFdTjo'),
    'and the client_id never appears in an outbound mandate payload');
}

console.log(`\n✓ ap2 profile: ${pass} checks passed`);
