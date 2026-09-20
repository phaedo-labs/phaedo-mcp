#!/usr/bin/env node
// §10.7 fatigue-aware autonomy promotion (autonomy-promotion.js).
// Run: node test-autonomy-promotion.mjs   (from mcp/)
//
// This is the ONLY channel in the system that can propose LESS friction, so the
// tests are written around the ways it must refuse. Every gate gets a case that
// proves it blocks, and the happy path is asserted to be small: reversible only,
// magnitude-capped, binding-required, expiring.

import assert from 'node:assert';
import { buildAutonomyPromotions, batchFraction, spendCeiling, MIN_APPROVALS, MIN_DISTINCT_DAYS } from './autonomy-promotion.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const NOW = Date.parse('2026-07-22T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (t) => new Date(t).toISOString();

let seq = 0;
// One approved, promotable receipt `agoDays` back. Marked at the same instant by
// default (distinct per receipt) so batch detection doesn't fire accidentally.
const rcpt = (over = {}) => {
  const agoDays = over.agoDays ?? 1;
  const created = NOW - agoDays * DAY;
  return {
    receipt_id: `r-${seq++}`,
    created_at: iso(created),
    via: 'phaedo_consult',
    agent_id: 'agent-A',
    ...(over.client_id !== undefined ? { client_id: over.client_id } : {}),
    request: {
      consultation_type: 'action_approval',
      action_descriptor: {
        domain: over.domain ?? 'writing',
        reversible: over.reversible ?? true,
        magnitude: over.magnitude ?? 'low',
        ...(over.amount !== undefined ? { amount: over.amount } : {}),
        summary: 'Draft a reply.',
      },
    },
    response: { signal: over.signal ?? 'proceed', confidence: 0.6, deference_level: 'medium' },
    user_action: over.user_action ?? 'approved',
    user_action_at: over.user_action_at ?? iso(created + 60 * 60 * 1000 + seq * 5000),
  };
};

// A qualifying history: 6 approvals over 6 distinct days, all reversible+low.
const qualifying = () => Array.from({ length: 6 }, (_, i) => rcpt({ agoDays: i + 1 }));

// ── the happy path, and what it is allowed to propose ─────────────────────────
console.log('\nqualifying history → a bounded proposal');
{
  const out = buildAutonomyPromotions(qualifying(), {}, { now: NOW });
  ok(out.length === 1, `one suggestion for the qualifying class — got ${out.length}`);
  const s = out[0];
  ok(s.status === 'suggested', 'staged as a SUGGESTION — never an authored rule');
  ok(s.kind === 'authorization' && s.effect === 'autoproceed', 'proposes a §10.5 autoproceed authorization');
  ok(s.source === 'autonomy_promotion', 'carries its provenance');
  ok(s.require_binding === true, 'ALWAYS binding-gated — a fabricated descriptor must not unlock it');
  ok(typeof s.expires_at === 'string' && Date.parse(s.expires_at) > NOW, 'ALWAYS expires — autonomy is re-earned, not permanent');
  ok(s.match.reversible === true, 'scoped to reversible actions only');
  ok(s.match.magnitude_max === 'low', 'magnitude ceiling is what was OBSERVED, not what was allowed');
  ok(s.match.domains.length === 1 && s.match.domains[0] === 'writing', 'scoped to the observed domain — never a blank cheque');
  ok(s.evidence.observation_count === 6 && s.evidence.distinct_days === 6, 'evidence records volume AND spread');
  ok(typeof s.evidence.agreement_rate === 'number', 'evidence records the agreement rate it relied on');
  ok(!/\bhigh\b/.test(JSON.stringify(s.match)), 'never proposes a high-magnitude relaxation');
}

// The ceiling tracks observed magnitude, so a class seen at medium may propose medium.
{
  const mixed = qualifying().map((r, i) => (i < 2 ? rcpt({ agoDays: i + 1, magnitude: 'medium' }) : r));
  const out = buildAutonomyPromotions(mixed, {}, { now: NOW });
  ok(out[0].match.magnitude_max === 'medium', 'ceiling rises to the highest magnitude actually approved');
}

// ── every gate, one refusal each ──────────────────────────────────────────────
console.log('\nrefusals');
const refuses = (receipts, why, opts = {}) =>
  ok(buildAutonomyPromotions(receipts, {}, { now: NOW, ...opts }).length === 0, why);

refuses(qualifying().slice(0, MIN_APPROVALS - 1), 'too few approvals');
refuses(Array.from({ length: 8 }, () => rcpt({ agoDays: 1 })), 'volume in a SINGLE day is not deliberation');
refuses(Array.from({ length: 8 }, (_, i) => rcpt({ agoDays: i < 7 ? 1 : 2 })), `fewer than ${MIN_DISTINCT_DAYS} distinct days`);
refuses([...qualifying(), rcpt({ agoDays: 1, user_action: 'rejected', signal: 'proceed' })], 'ONE rejection in the class disqualifies it');
refuses([...qualifying(), rcpt({ agoDays: 1, user_action: 'modified', signal: 'proceed' })], 'ONE modification in the class disqualifies it');
refuses(qualifying().map((r, i) => rcpt({ agoDays: i + 1, reversible: false })), 'irreversible actions are never proposed');
refuses(qualifying().map((r, i) => rcpt({ agoDays: i + 1, magnitude: 'high' })), 'high-magnitude actions are never proposed');
refuses(qualifying().map((r, i) => rcpt({ agoDays: i + 1, amount: -5 })), 'a malformed (negative) amount is not evidence of anything');
refuses(qualifying().map((r, i) => rcpt({ agoDays: i + 1, domain: '' })), 'an undomained class is never proposed');
refuses(qualifying().map((r, i) => rcpt({ agoDays: i + 1, signal: 'escalate' })), 'approvals of a non-decisive signal do not count as agreement');
refuses(qualifying().map((r, i) => rcpt({ agoDays: i + 1, agoDays2: 0, ...{} })).map((r) => ({ ...r, created_at: iso(NOW - 400 * DAY) })), 'evidence outside the window does not count');

// Batch-marking: the fatigue signal. Same six approvals, all stamped together.
{
  const batched = qualifying().map((r) => ({ ...r, user_action_at: iso(NOW - 3000) }));
  refuses(batched, 'approvals marked in one burst are bookkeeping, not consent');
  ok(batchFraction(batched) === 1, 'batchFraction sees the whole set in one window');
  ok(batchFraction(qualifying()) < 0.5, 'a spread-out history is not batched');
  // Absence of the timestamp must not be READ as batching — older stores lack it.
  const noStamps = qualifying().map(({ user_action_at, ...r }) => r);
  ok(batchFraction(noStamps) === 0, 'receipts with no mark timestamp are not treated as batched');
  ok(buildAutonomyPromotions(noStamps, {}, { now: NOW }).length === 1, 'a pre-field history can still qualify on the other gates');
}

// ── priced classes: bounded by a ceiling, set by the SECOND-highest ───────────
// Before amount_lt existed this whole category was refused, because §10.5 had a
// floor and no ceiling. The bar for a money rule is now "the ceiling was
// demonstrated twice" — one outlier must never set it.
console.log('\nspend ceiling');
{
  const priced = (amounts) => amounts.map((a, i) => rcpt({ agoDays: i + 1, amount: a }));

  ok(spendCeiling(priced([])) === null, 'an unpriced class needs no ceiling');
  ok(spendCeiling(priced([40])) === undefined, 'ONE priced approval cannot justify a bound');
  ok(spendCeiling(priced([20, 20, 20])) === 20, 'a consistent class takes that amount');
  ok(spendCeiling(priced([20, 20, 20, 20, 20, 500])) === 20,
     'a single $500 outlier does NOT raise the ceiling — the second-highest sets it');
  ok(spendCeiling(priced([10, 90])) === 10, 'two amounts → the lower one');

  const out = buildAutonomyPromotions(priced([20, 25, 30, 22, 28, 900]), {}, { now: NOW });
  ok(out.length === 1, 'a priced class IS now promotable');
  // `amount_lte`, not `amount_lt` (M7). The ceiling is the second-highest amount APPROVED, so an
  // exclusive bound excludes the purchases that earned the grant — five $20 approvals minted a
  // rule matching `amount < 20`, unfireable by construction and silently so.
  ok(out[0].match.amount_lte === 30, `ceiling is the second-highest (30), not the 900 outlier — got ${out[0].match.amount_lte}`);
  ok(out[0].match.amount_lt === undefined, 'and the exclusive form is not staged alongside it');
  ok(/up to 30/.test(out[0].proposed_text),
     'the ceiling appears in the sentence the subject reads, and says "up to" — the bound is '
     + 'INCLUSIVE now (M7), and prose reading "under 30" for a rule that fires AT 30 misdescribes '
     + 'the authority on the one screen where accuracy is consent');

  // A class with exactly one priced approval among unpriced ones still can't justify one.
  const mixed = [rcpt({ agoDays: 1, amount: 50 }), ...Array.from({ length: 5 }, (_, i) => rcpt({ agoDays: i + 2 }))];
  ok(buildAutonomyPromotions(mixed, {}, { now: NOW }).length === 0,
     'a class with a single priced approval is refused rather than proposed unbounded');

  // Unpriced classes still propose with no amount bound at all.
  const unpriced = buildAutonomyPromotions(qualifying(), {}, { now: NOW });
  ok(!('amount_lt' in unpriced[0].match), 'an unpriced class carries no amount bound');

  // A zero ceiling can never match, so proposing it would be a dead rule.
  ok(buildAutonomyPromotions(priced([0, 0, 0, 0, 0, 0]), {}, { now: NOW }).length === 0, 'an all-zero class is not proposed');
}

// The interlock: the oracle must already be tracking this subject in this domain.
console.log('\nagreement interlock');
{
  // Disagreements in ANOTHER domain must not block this one...
  const other = [...qualifying(), ...Array.from({ length: 4 }, (_, i) =>
    rcpt({ agoDays: i + 1, domain: 'financial', user_action: 'rejected', signal: 'proceed' }))];
  ok(buildAutonomyPromotions(other, {}, { now: NOW }).length === 1, 'a bad rate in another domain does not block this one');

  // The case the interlock exists for, and the reason it is NOT redundant with the
  // "any rejection disqualifies" gate: the oracle said DECLINE and the subject went
  // ahead anyway. `user_action` is 'approved', so that is not contrary evidence about
  // the action — but it is the oracle being wrong about this person in this domain,
  // and it drags the domain agreement rate down. Handing autonomy to an oracle that
  // misreads you here is exactly backwards.
  const oracleWrong = [
    ...qualifying(),
    ...Array.from({ length: 6 }, (_, i) => rcpt({ agoDays: i + 1, signal: 'decline', user_action: 'approved' })),
  ];
  refuses(oracleWrong, 'a domain where the oracle keeps being overruled is refused, even with no rejections');
  ok(buildAutonomyPromotions(oracleWrong, {}, { now: NOW, minAgreement: 0.4 }).length === 1,
     'and it is exactly the agreement floor doing that work (lower the floor, it passes)');

  refuses(qualifying(), 'too few SCORED decisions blocks promotion', { minAgreementScored: 99 });
}

// ── no-nag ────────────────────────────────────────────────────────────────────
console.log('\nno-nag');
{
  const authored = { standing_rules: [{ kind: 'authorization', effect: 'autoproceed', match: { domains: ['Writing'] } }] };
  ok(buildAutonomyPromotions(qualifying(), authored, { now: NOW }).length === 0,
     'already authored for the domain → not re-proposed (case-insensitive)');
  const staged = { suggested_rules: [{ source: 'autonomy_promotion', match: { domains: ['writing'] } }] };
  ok(buildAutonomyPromotions(qualifying(), staged, { now: NOW }).length === 0, 'already staged → not re-proposed');
  // An unrelated authored rule must not suppress it.
  const unrelated = { standing_rules: [{ kind: 'authorization', effect: 'escalate', match: { domains: ['writing'] } }] };
  ok(buildAutonomyPromotions(qualifying(), unrelated, { now: NOW }).length === 1,
     'an authored ESCALATE rule does not suppress an autonomy proposal (different question)');
}

// ── determinism + degenerate input ────────────────────────────────────────────
console.log('\ndeterminism + robustness');
{
  const many = [...qualifying(), ...Array.from({ length: 6 }, (_, i) => rcpt({ agoDays: i + 1, domain: 'research' }))];
  const a = buildAutonomyPromotions(many, {}, { now: NOW });
  const b = buildAutonomyPromotions(many, {}, { now: NOW });
  ok(a.length === 2, 'two qualifying classes → two suggestions');
  ok(a.map((s) => s.match.domains[0]).join() === 'research,writing', 'output is domain-sorted (deposit is last-write-wins)');
  ok(JSON.stringify(a.map((s) => s.match)) === JSON.stringify(b.map((s) => s.match)), 'stable across calls');

  for (const bad of [null, undefined, 'nope', 42, [null, {}, { request: null }]]) {
    ok(buildAutonomyPromotions(bad, null, { now: NOW }).length === 0, `degenerate input ${JSON.stringify(bad)} → no suggestions, no throw`);
  }
}


// ── §10.5 scoping (step 5): the grant is limited to the clients that EARNED it ──
// Only meaningful now that `agents` is enforced (v0.1.53) and authorable (#197).
// Every assertion here is about the NARROWING direction, plus the one edge that
// would break the feature outright: absent vs empty.
console.log('\n§10.5 scoping — the grant names the client that earned it');
{
  const ME = 'c_aaaaaaaaaaaaaaaa';
  const OTHER = 'c_bbbbbbbbbbbbbbbb';
  const spread = (over = {}) => [1, 2, 3, 4, 5].map((d) => rcpt({ agoDays: d, ...over }));

  // All evidence from one client → scoped to that client.
  const one = buildAutonomyPromotions(spread({ client_id: ME }), null, { now: NOW });
  ok(one.length === 1, 'a clean single-client class still promotes');
  ok(Array.isArray(one[0].agents) && one[0].agents.join(',') === ME, 'the proposal is SCOPED to the earning client');
  ok(one[0].evidence.client_count === 1, 'evidence records how many clients contributed');
  ok(one[0].evidence.unattributed === false, 'and that none of it was unattributed');
  ok(/limited to the agent that earned it/.test(one[0].note), 'the note says the grant is limited (without printing an opaque id)');

  // Two clients both contributed → both listed, sorted for determinism.
  const mixed = [...spread({ client_id: ME }), rcpt({ agoDays: 6, client_id: OTHER })];
  const two = buildAutonomyPromotions(mixed, null, { now: NOW });
  ok(two[0].agents.length === 2 && two[0].agents[0] === ME && two[0].agents[1] === OTHER,
    'both contributing clients are listed, sorted (deterministic — this rides a last-write-wins deposit)');

  // THE EDGE THAT MATTERS. Pre-v0.1.53 receipts carry no client_id. The field must be
  // OMITTED (unscoped, today's behaviour), never written as [] — which now means
  // "nobody" and would stage a grant that can never fire.
  const legacy = buildAutonomyPromotions(spread(), null, { now: NOW });
  ok(legacy.length === 1, 'a class of pre-attribution receipts still promotes');
  ok(!('agents' in legacy[0]), 'agents is OMITTED when nothing can be attributed — NOT written as []');
  ok(legacy[0].evidence.client_count === 0 && legacy[0].evidence.unattributed === true, 'evidence flags the unattributed history');
  ok(!/limited to the agent/.test(legacy[0].note), 'and the note does not claim a limit it is not applying');

  // Partial attribution narrows to what is known — the unattributed client keeps asking.
  const partial = [...spread({ client_id: ME }).slice(0, 4), rcpt({ agoDays: 5 })];
  const p = buildAutonomyPromotions(partial, null, { now: NOW });
  ok(p[0].agents.join(',') === ME, 'partial attribution scopes to the KNOWN client only (fail-safe: the rest keep asking)');
  ok(p[0].evidence.unattributed === true, 'and evidence still flags that some of it was unattributed');

  // The scope must survive the structural guard the extension applies on arrival.
  ok(p[0].kind === 'authorization' && p[0].effect === 'autoproceed' && p[0].require_binding === true && !!p[0].expires_at,
    'scoping does not disturb the non-negotiables (kind/effect/require_binding/expires_at)');
}

console.log(`\n✓ autonomy promotion: ${pass} checks passed`);
