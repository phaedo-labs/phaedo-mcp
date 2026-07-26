// Regression: delegation-promotion suggestions must bucket by CANONICAL domain, or one
// concept spelled several ways floods the "Rules to review" card with near-duplicates —
// the same fragmentation class that starved §10.7 (spec/domains.json exists to prevent it).
// Reported live: finance / financial each spawned their own delegation card.

import assert from 'assert';
import { buildDelegationPromotions } from './consult-core.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// A receipt where the subject OVERRODE the oracle on a hard-to-undo (irreversibleCaution)
// decision — the shape buildDelegationPromotions promotes. `domain` is the only thing that
// varies across these, and only its SPELLING.
const receipt = (domain) => ({
  request: { action_descriptor: { domain } },
  response: { signal: 'proceed' },            // oracle said proceed…
  user_action: 'rejected',                    // …subject rejected → a delegation lesson
  drivers: [{ cue: 'irreversibleCaution' }],
});

// Enough overrides to clear the promotion floor, split across THREE spellings of one domain.
const receipts = [
  receipt('finance'), receipt('finance'),
  receipt('financial'), receipt('financial'),
  receipt('Finance'),
];

console.log('\none concept spelled three ways must yield ONE delegation suggestion, not three');
{
  const out = buildDelegationPromotions(receipts, {}, { floor: 3 });
  const domains = out.map((s) => s.decision.domain);
  ok(out.length === 1, `finance/financial/Finance collapse to a single card (got ${out.length}: ${JSON.stringify(domains)})`);
  ok(out[0].decision.domain === 'finance', `the surviving card is keyed to the canonical term (got ${out[0].decision.domain})`);
  ok(/finance/.test(out[0].proposed_text) && !/financial/.test(out[0].proposed_text),
    'the card text uses the canonical domain, not a raw spelling');
}

console.log('\ngenuinely different domains still produce separate cards (no over-collapse)');
{
  const mixed = [
    receipt('finance'), receipt('finance'), receipt('finance'),
    receipt('legal'), receipt('legal'), receipt('legal'),
  ];
  const out = buildDelegationPromotions(mixed, {}, { floor: 3 });
  const doms = out.map((s) => s.decision.domain).sort();
  ok(out.length === 2 && doms[0] === 'finance' && doms[1] === 'legal',
    `finance and legal stay distinct (got ${JSON.stringify(doms)})`);
}

console.log('\nno-nag survives canonicalization: an authored canonical rule suppresses a raw re-propose');
{
  // The subject already endorsed the finance delegation rule (authored, canonical domain).
  const fp = { standing_rules: [{ kind: 'instruction', decision: { origin: 'delegation', dimension: 'reversible_vs_irreversible', domain: 'finance' } }] };
  // New receipts arrive spelled "financial" — must NOT re-propose, because canonicalized it
  // is the same authorization the subject already settled.
  const out = buildDelegationPromotions([receipt('financial'), receipt('financial'), receipt('financial')], fp, { floor: 3 });
  ok(out.length === 0, `a raw "financial" override does not re-nag an authored canonical "finance" rule (got ${out.length})`);
}

console.log('\nan already-staged canonical suggestion is not re-proposed for a raw spelling');
{
  const fp = { suggested_rules: [{ source: 'delegation_promotion', status: 'suggested', decision: { origin: 'delegation', dimension: 'reversible_vs_irreversible', domain: 'finance' } }] };
  const out = buildDelegationPromotions([receipt('Financial'), receipt('Financial'), receipt('Financial')], fp, { floor: 3 });
  ok(out.length === 0, 'a staged canonical suggestion suppresses a raw re-propose');
}

console.log(`\n✓ delegation domain fragmentation: ${pass} checks passed\n`);
