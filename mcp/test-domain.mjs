#!/usr/bin/env node
// §10.2 `action_descriptor.domain` canonicalization (mcp/lib/domain.js).
//
// The point of this suite is as much what canonicalDomain MUST NOT do as what it does.
// Two "obvious" extensions were considered and rejected because both WIDEN AUTHORITY,
// and the rejections are pinned here so a later session cannot helpfully re-add them.
//
// Run: node test-domain.mjs   (from mcp/)

import assert from 'assert';
import { canonicalDomain, normalizeDomain, isVocabularyTerm, VOCABULARY_TERMS, VOCABULARY_MAP } from './lib/domain.js';
import { readFileSync } from 'node:fs';
import { normalizeRequest } from './consult-core.js';
import { buildReceipt } from './receipts.js';
import { normalizePolicies, matchAuthorization, applyPolicies } from './consult-policy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

console.log('\ncanonicalDomain — presentation differences only');
ok(canonicalDomain('Finance') === 'finance', 'lowercased');
ok(canonicalDomain('  finance  ') === 'finance', 'trimmed');
ok(normalizeDomain('outbound   email') === 'outbound email', 'internal whitespace collapsed');
ok(canonicalDomain('outbound   email') === 'communication', 'and the collapsed form then resolves through its alias');
ok(canonicalDomain('\tFinance\n') === 'finance', 'tabs/newlines handled');
ok(canonicalDomain(canonicalDomain('  FiNaNcE ')) === canonicalDomain('  FiNaNcE '), 'idempotent');
for (const bad of [undefined, null, 42, {}, [], true]) ok(canonicalDomain(bad) === '', `non-string ${JSON.stringify(bad) ?? 'undefined'} → ''`);

console.log('\nthe two things it deliberately does NOT do');
// 1. Dotted-suffix stripping WIDENS: matching is substring-based, so a restrictive rule
//    scoped to the child stops firing once the child is collapsed into the parent.
ok(canonicalDomain('finance.crypto_trading') === 'finance.crypto_trading', 'a dotted domain is NOT collapsed to its parent');
{
  const guard = normalizePolicies([{ match: { domains: ['crypto_trading'] }, effect: 'decline', note: 'no autonomous crypto' }]);
  const act = (d) => ({ type: 'action_approval', domain: d, reversible: false, magnitude: 'high' });
  ok(matchAuthorization(act('finance.crypto_trading'), guard)?.signal === 'decline',
    'the crypto guard still fires on finance.crypto_trading (this is what suffix-stripping would break)');
  ok(matchAuthorization(act('finance'), guard) === null,
    'and would NOT fire on a bare `finance` — proving the strip turns a decline into no match');
}
// 2. Synonyms are not mechanically separable from false merges.
ok(normalizeDomain('financial') !== normalizeDomain('finance'), 'normalizeDomain alone still keeps them distinct — it makes no semantic claim');
ok(!'financial'.includes('finance'), 'and no substring rule would merge them — they diverge at financ-i-al / financ-e, which is why a VOCABULARY was needed');
ok('paralegal'.includes('legal') && 'healthcare'.includes('care'),
  'while the loose rules DO merge genuinely different domains — why a stem/substring synonym rule was rejected');

console.log('\nthreaded through the request boundary');
{
  const n = normalizeRequest({ consultation_type: 'action_approval', action_descriptor: { domain: '  Finance  ' } });
  ok(n.domain === 'finance', 'normalizeRequest canonicalizes the domain');
  const blank = normalizeRequest({ consultation_type: 'action_approval', action_descriptor: { domain: '   ' } });
  ok(blank.domain === undefined, 'a whitespace-only domain becomes undefined (not "")— matches the no-domain path');
  const none = normalizeRequest({ consultation_type: 'action_approval', action_descriptor: {} });
  ok(none.domain === undefined, 'an absent domain stays undefined');
}

console.log('\nthreaded through the receipt boundary (the evidence store)');
{
  const r = buildReceipt({
    via: 'phaedo_consult',
    request: { consultation_type: 'action_approval', action_descriptor: { domain: ' FINANCE ' } },
    response: { signal: 'escalate', confidence: 0.5, deference_level: 'high' },
  });
  ok(r.request.action_descriptor.domain === 'finance', 'the receipt records the canonical domain');
  const r2 = buildReceipt({
    via: 'phaedo_consult',
    request: { consultation_type: 'action_approval', action_descriptor: { domain: 'Finance' } },
    response: { signal: 'escalate', confidence: 0.5, deference_level: 'high' },
  });
  ok(r.request.action_descriptor.domain === r2.request.action_descriptor.domain,
    'two case variants land in ONE evidence class (the whole point — promotion tallies key on this)');
  const r3 = buildReceipt({
    via: 'phaedo_consult',
    request: { consultation_type: 'action_approval', action_descriptor: {} },
    response: { signal: 'escalate', confidence: 0.5, deference_level: 'high' },
  });
  ok(r3.request.action_descriptor.domain === null, 'an absent domain is still null on the receipt');
}

console.log('\nno rule changes behaviour (matching already lowercased both sides)');
{
  const pol = normalizePolicies([{ match: { domains: ['Financial'] }, effect: 'escalate', note: 'x' }]);
  const n = normalizeRequest({ consultation_type: 'action_approval', action_descriptor: { domain: 'FINANCIAL SERVICES' } });
  ok(matchAuthorization(n, pol)?.signal === 'escalate', 'a mixed-case rule still matches a mixed-case action');
}


// ── the published vocabulary (§10.2) ─────────────────────────────────────────
console.log('\nvocabulary — aliases resolve, free text survives');
{
  ok(canonicalDomain('financial') === 'finance', 'financial -> finance (the case that started this)');
  ok(canonicalDomain('  FINANCES ') === 'finance', 'normalization runs before the alias lookup');
  ok(canonicalDomain('email') === 'communication' && canonicalDomain('outbound email') === 'communication',
    'multi-word aliases resolve');
  ok(canonicalDomain('finance') === 'finance', 'a canonical term maps to itself');
  ok(canonicalDomain('veterinary') === 'veterinary', 'an UNRECOGNIZED domain survives unchanged — free text stays legal');
  ok(canonicalDomain('') === '' && canonicalDomain(null) === '', 'degenerate input still yields empty');
  ok(isVocabularyTerm('financial') && isVocabularyTerm('finance'), 'alias and canonical both report as vocabulary');
  ok(!isVocabularyTerm('veterinary'), 'and an unrecognized domain does not');

  // ALIASES ARE SYNONYMS, NEVER GENERALIZATIONS. A child->parent entry would let a
  // grant for the general class cover a narrower, riskier one — the same defect that
  // made dotted-suffix stripping unsafe.
  ok(canonicalDomain('crypto_trading') === 'crypto_trading', 'crypto_trading is NOT aliased into finance (it would inherit a finance grant)');
  ok(canonicalDomain('investing') === 'investing' && canonicalDomain('trading') === 'investing',
    'investing is its OWN term, not a finance alias — a spending guardrail is not a trading guardrail');
  ok(canonicalDomain('paralegal') === 'paralegal', 'paralegal is NOT aliased into legal');
  for (const [term, aliases] of Object.entries(VOCABULARY_MAP)) {
    for (const a of aliases) {
      ok(!VOCABULARY_TERMS.includes(a), `alias "${a}" is not itself a canonical term (would be ambiguous)`);
      ok(canonicalDomain(a) === term, `"${a}" -> ${term}`);
    }
  }
}

console.log('\nTHE SAFETY PROPERTY — an alias may widen a GUARDRAIL, never a GRANT');
{
  const act = (d) => ({ type: 'action_approval', domain: normalizeDomain(d), reversible: true, magnitude: 'low', bound: true });

  const guard = normalizePolicies([{ match: { domains: ['financial'] }, effect: 'decline', note: 'no autonomous money' }]);
  ok(matchAuthorization(act('financial'), guard)?.signal === 'decline', 'guardrail still covers its literal domain');
  ok(matchAuthorization(act('finance'), guard)?.signal === 'decline', 'and NOW covers the alias — a guardrail reaching further is the safe direction');

  const grant = normalizePolicies([{ match: { domains: ['financial'] }, effect: 'autoproceed', note: 'x' }]);
  ok(matchAuthorization(act('financial'), grant)?.signal === 'proceed', 'a grant still applies to its literal domain');
  ok(matchAuthorization(act('finance'), grant) === null,
    'but does NOT reach the alias — a wrong alias entry can never hand out autonomy');

  const bold = normalizePolicies([{ match: { domains: ['financial'] }, effect: 'bias_bold', note: 'x' }]);
  const base = { signal: 'clarify', confidence: 0.5, deference_level: 'medium', rationale_hint: 'x' };
  ok(applyPolicies(base, act('finance'), bold).signal === 'clarify', 'bias_bold does not reach an alias either');
  const cautious = normalizePolicies([{ match: { domains: ['financial'] }, effect: 'bias_cautious', note: 'x' }]);
  ok(applyPolicies({ ...base, signal: 'proceed' }, act('finance'), cautious).signal === 'proceed_with_note',
    'bias_cautious DOES reach the alias — restrictive, so it may widen');

  const sub = normalizePolicies([{ match: { domains: ['finance'] }, effect: 'decline', note: 'x' }]);
  ok(matchAuthorization(act('finance.crypto_trading'), sub)?.signal === 'decline',
    'the pre-existing substring path is untouched — no guardrail is lost by adopting the vocabulary');
}

console.log('\nspec/domains.json <-> the embedded copy (drift fails here)');
{
  const published = JSON.parse(readFileSync(new URL('../spec/domains.json', import.meta.url), 'utf8')).domains;
  const pubTerms = Object.keys(published).sort();
  ok(pubTerms.join(',') === VOCABULARY_TERMS.join(','), 'canonical term sets are identical');
  for (const t of pubTerms) {
    ok(published[t].aliases.join(',') === (VOCABULARY_MAP[t] || []).join(','), `aliases for "${t}" are identical`);
  }
  const seen = new Map();
  for (const [t, def] of Object.entries(published)) {
    for (const a of def.aliases) {
      ok(!seen.has(a), `alias "${a}" is claimed by only one term (also on "${seen.get(a)}")`);
      seen.set(a, t);
    }
  }
}

if (fail) { console.error(`\n✗ domain: ${fail} failed, ${pass} passed`); process.exit(1); }
console.log(`\n✓ domain canonicalization: ${pass} checks passed`);
