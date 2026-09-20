// §10.5 precedence and the §10.7 spend ceiling — audit findings M3 and M7.
//
// Both were held back for an owner decision because both are SPEC changes, and both had a naive
// fix that the shipped suite proved wrong. Approved 2026-07-28.
//
//   M3  First-match precedence meant an earlier GRANT beat a later PROHIBITION — the only §10.5
//       ordering that resolved in the WIDENING direction. Every other asymmetry in the resolver
//       (expiry, require_binding, agents on relaxing effects, an unreadable magnitude_max)
//       narrows authority when something is unclear. This one granted it.
//
//   M7  §10.7 staged `amount_lt: <second-highest approved>`, so five $20 approvals minted a grant
//       matching `amount < 20` — one that excludes every purchase that earned it. Unfireable by
//       construction, and silent: it appeared in the subject's rules and read correctly in prose.
//
//   node mcp/test-precedence-and-ceiling.mjs

import assert from 'assert';
import { normalizePolicies, matchAuthorization } from './consult-policy.js';
import { buildAutonomyPromotions, spendCeiling } from './autonomy-promotion.js';
import { authorizationToIntentConstraints } from './ap2.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const act = (over) => ({ type: 'action', domain: 'shopping', reversible: true, magnitude: 'low', bound: true, ...over });
const sig = (req, rules, opts) => matchAuthorization(req, normalizePolicies(rules), opts)?.signal ?? null;
const which = (req, rules, opts) => matchAuthorization(req, normalizePolicies(rules), opts)?.rule?.id ?? null;

console.log('\nM3 — the MORE SPECIFIC rule governs, whatever the array order');
{
  const blanket   = { id: 'blanket', match: {}, effect: 'autoproceed', note: 'anything' };
  const bigTicket = { id: 'big', match: { amount_gt: 1000 }, effect: 'escalate', note: 'ask me about big ones' };

  for (const [label, rules] of [['grant first', [blanket, bigTicket]], ['prohibition first', [bigTicket, blanket]]]) {
    ok(which(act({ amount: 2500 }), rules) === 'big',
      `${label}: the $1,000 threshold governs a $2,500 purchase — a blanket autoproceed authored `
      + 'in January used to pre-empt it purely by position in the array');
  }
  ok(which(act({ amount: 20 }), [blanket, bigTicket]) === 'blanket',
    'and BELOW the threshold the blanket grant still applies — specificity decides which rule '
    + 'governs, it does not make the narrow rule win requests it does not match');
}

console.log('M3 — an agent-scoped EXEMPTION still works, which the naive fix destroyed');
{
  // "Restrictive always wins" makes every targeted exemption inert the moment any general
  // prohibition exists — and a scoped grant IS the subject naming one client they trust.
  const rules = [
    { id: 'grant', match: { domains: ['travel'] }, effect: 'autoproceed', note: 'auto', agents: ['c_trusted'] },
    { id: 'general', match: { domains: ['travel'] }, effect: 'escalate', note: 'esc' },
  ];
  const req = act({ domain: 'travel' });
  ok(which(req, rules, { clientId: 'c_trusted' }) === 'grant',
    'the named client gets its exemption — it narrowed on domain AND client, the prohibition only '
    + 'on domain');
  ok(which(req, rules, { clientId: 'c_other' }) === 'general',
    'and an unlisted client falls through to the prohibition');
}

console.log('M3 — a TIE goes to the restrictive effect');
{
  const rules = [
    { id: 'g', match: { domains: ['shopping'] }, effect: 'autoproceed', note: 'g' },
    { id: 'p', match: { domains: ['shopping'] }, effect: 'escalate', note: 'p' },
  ];
  ok(which(act(), rules) === 'p' && which(act(), [rules[1], rules[0]]) === 'p',
    'equally specific rules are equally considered, so the fail-safe direction decides — and it '
    + 'decides the same way in either order, which is what makes the resolver deterministic');

  const same = [
    { id: 'first', match: { domains: ['shopping'] }, effect: 'autoproceed', note: 'a' },
    { id: 'second', match: { domains: ['shopping'] }, effect: 'autoproceed', note: 'b' },
  ];
  ok(which(act(), same) === 'first',
    'and a full tie — same specificity, same class — keeps author order, so nothing became '
    + 'arbitrary');
}

console.log('M3 — a TIE between two RESTRICTIVE effects goes to the STRICTER one, in either order');
{
  // Both restrictive, equally specific. Before v0.1.69 this fell through to author order — and a sync
  // merge reorders the array, so the phone and the extension could disagree about whether the same
  // request was declined or escalated. Now `decline` governs regardless of position.
  const esc = { id: 'esc', match: { domains: ['shopping'] }, effect: 'escalate', note: 'e' };
  const dec = { id: 'dec', match: { domains: ['shopping'] }, effect: 'decline',  note: 'd' };
  ok(which(act(), [esc, dec]) === 'dec' && which(act(), [dec, esc]) === 'dec',
    'decline outranks escalate at equal specificity, whichever comes first — the outcome no longer '
    + 'depends on array order');
  ok(sig(act(), [esc, dec]) === 'decline' && sig(act(), [dec, esc]) === 'decline',
    'and the signal the agent receives is the same in both orders');
  // require_human is an alias for escalate; it must not outrank a decline either.
  const rh = { id: 'rh', match: { domains: ['shopping'] }, effect: 'require_human', note: 'h' };
  ok(which(act(), [rh, dec]) === 'dec', 'require_human (an escalate alias) still loses to decline');
  // Specificity still comes FIRST: a more specific escalate beats a blanket decline.
  const escSpecific = { id: 'escS', match: { domains: ['shopping'], amount_gt: 10 }, effect: 'escalate', note: 'e' };
  const decBlanket  = { id: 'decB', match: {}, effect: 'decline', note: 'd' };
  ok(which(act({ amount: 50 }), [decBlanket, escSpecific]) === 'escS',
    'strictness only breaks a TIE — a more specific escalate still governs over a blanket decline');
}

console.log('M7 — the staged ceiling INCLUDES the class that earned it');
{
  const NOW = Date.parse('2026-07-28T12:00:00.000Z');
  const rcpt = (agoDays, amount) => ({
    created_at: new Date(NOW - agoDays * 86400_000).toISOString(),
    user_action: 'approved',
    client_id: 'c_1',
    request: { consultation_type: 'action', action_descriptor: { domain: 'shopping', reversible: true, magnitude: 'low', amount } },
    response: { signal: 'proceed' },
  });
  // Six approvals, every one at exactly $20 — the shape that produced an unfireable grant.
  const receipts = Array.from({ length: 6 }, (_, i) => rcpt(i + 1, 20));
  ok(spendCeiling(receipts) === 20, 'the ceiling is $20 — the amount actually approved');

  const staged = buildAutonomyPromotions(receipts, {}, { now: NOW });
  ok(staged.length === 1, 'the class is promotable');
  ok(staged[0].match.amount_lte === 20, 'and it is staged as an INCLUSIVE ceiling');

  // THE PROPERTY THAT MATTERS: the rule fires at the price that earned it.
  //
  // `clientId` is required, and that is not incidental — §10.7 scopes a staged grant to the
  // clients that earned it, so the rule is INERT without one. A first version of this case omitted
  // it and failed for that reason instead, which would have read as "the ceiling fix didn't work".
  const rules = [{ ...staged[0], id: 'earned', effect: 'autoproceed' }];
  // `now` is pinned here too, and that is not incidental either. §10.7 stamps every staged grant
  // with `expires_at` = now + 30 days, and `matchAuthorization` checks expiry against the WALL
  // CLOCK unless told otherwise. This case pinned `now` for the promotion and not for the match,
  // so the grant it built expired on 2026-08-27 and the suite went red on 2026-08-28 with nobody
  // pushing — CI runs on push only, so nothing saw it until the next session opened a month later.
  // A test with a date in it must pin every clock it touches, or it is a timer, not a test.
  const sigAs = (req, at = NOW) => sig(req, rules, { clientId: 'c_1', now: at });
  ok(sigAs(act({ amount: 20 })) === 'proceed',
    'a $20 purchase — the exact class the subject approved six times — MATCHES. Under `amount_lt` '
    + 'it did not, so the grant could never fire for anything that earned it');
  ok(sigAs(act({ amount: 21 })) === null,
    'and $21 does not: the ceiling still bounds it, this is not "the bound stopped working"');
  // The property this test was silently exercising against the real clock, pinned on purpose:
  ok(sigAs(act({ amount: 20 }), NOW + 31 * 86400_000) === null,
    'and once the grant EXPIRES it stops firing — an autonomy grant is always time-bounded (§10.7)');
}

console.log('M7 — the exclusive form still behaves exactly as before');
{
  const excl = [{ id: 'x', match: { amount_lt: 20 }, effect: 'autoproceed', note: 'x' }];
  ok(sig(act({ amount: 19.99 }), excl) === 'proceed', '`amount_lt` is unchanged below the bound');
  ok(sig(act({ amount: 20 }), excl) === null, 'and still excludes the bound itself — no existing rule changed meaning');

  const both = [{ id: 'b', match: { amount_lt: 15, amount_lte: 20 }, effect: 'autoproceed', note: 'b' }];
  ok(sig(act({ amount: 14 }), both) === 'proceed', 'both present → both enforced');
  ok(sig(act({ amount: 17 }), both) === null,
    'so the LOWER bound governs — a rule carrying two ceilings is ambiguous authoring, and '
    + 'ambiguity on a grant fails closed');

  ok(sig(act({ amount: undefined }), [{ id: 'c', match: { amount_lte: 20 }, effect: 'autoproceed', note: 'c' }]) === null,
    'an UNPRICED request does not satisfy a priced ceiling — a rule the subject qualified by '
    + 'money must not fire on a request carrying no amount');
}

console.log('M7 — the AP2 mandate carries the ceiling, and never more headroom than the rule');
{
  // `max_amount` sits under `constraints` — reading it off the top level returns undefined, which
  // would have failed for the wrong reason and read as "the mapping is missing".
  const c1 = authorizationToIntentConstraints({ match: { domains: ['shopping'], amount_lte: 20 }, effect: 'autoproceed' });
  ok(c1?.constraints?.max_amount === 20, 'an inclusive ceiling reaches the Intent Mandate — omitting it would '
    + 'export an UNBOUNDED payment credential from a bounded grant');
  const c2 = authorizationToIntentConstraints({ match: { domains: ['shopping'], amount_lt: 15, amount_lte: 20 }, effect: 'autoproceed' });
  ok(c2?.constraints?.max_amount === 15,
    'and with both, the LOWER wins: AP2 has one field and no way to say "exclusive", so the '
    + 'credential must never assert more headroom than the rule grants');
}

console.log(`\n✓ §10.5 precedence + §10.7 ceiling: ${pass} checks passed\n`);
