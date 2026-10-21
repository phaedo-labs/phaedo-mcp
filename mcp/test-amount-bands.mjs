#!/usr/bin/env node
// Amount bands (precedent track G8 B1): the inferred path reads `amount`, banded by the
// subject's own authored thresholds (else a stated default), and may only RAISE caution.
// The property that matters most is the last-but-one section: across every combination,
// adding an amount never makes the answer more permissive.
// Run: node test-amount-bands.mjs   (from mcp/)

import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  amountEdges, amountFloor, DEFAULT_AMOUNT_EDGES,
  resolveConsultationCore, consultDrivers, normalizeRequest, ruleResponse,
} from './consult-core.js';
import { normalizePolicies } from './consult-policy.js';
import { buildReceipt } from './receipts.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const HERE = dirname(fileURLToPath(import.meta.url));

const pol = (rules) => normalizePolicies(rules);
const n = (ad) => normalizeRequest({ consultation_type: 'action_approval', action_descriptor: ad });

// ── Edges: the subject's numbers first, scoped before unscoped-elsewhere, else the default ─
{
  const none = amountEdges([], 'finance');
  ok(none.edges.join() === DEFAULT_AMOUNT_EDGES.join() && none.basis === null, 'no authored amounts → default edges, basis null');
  ok(DEFAULT_AMOUNT_EDGES.join() === '100,1000', 'the default is $100 / $1,000');

  const rules = pol([
    { effect: 'escalate', match: { domains: ['finance'], amount_gt: 5000 } },
    { effect: 'autoproceed', match: { domains: ['finance'], amount_lte: 50 } },
    { effect: 'escalate', match: { domains: ['shopping'], amount_gt: 300 } },
  ]);
  const fin = amountEdges(rules, 'finance');
  ok(fin.edges.join() === '50,5000' && fin.basis === 'self_reported', "finance → the subject's finance numbers (grant ceiling + prohibition floor)");
  ok(amountEdges(rules, 'financial').edges.join() === '50,5000', 'a vocabulary alias reaches the same rules (caution-only, so widening is safe)');
  ok(amountEdges(rules, 'shopping').edges.join() === '300,300', 'one authored number → both edges are it');
  ok(amountEdges(rules, 'travel').edges[0] === 50 && amountEdges(rules, 'travel').edges[1] === 5000, 'anywhere = min/max of all authored amounts');
  const unscoped = pol([{ effect: 'escalate', match: { amount_gt: 2000 } }, { effect: 'escalate', match: { domains: ['shopping'], amount_gt: 300 } }]);
  ok(amountEdges(unscoped, 'finance').edges.join() === '2000,2000', 'an unscoped rule speaks for every domain');
  ok(amountEdges(unscoped, 'shopping').edges.join() === '300,2000', 'scoped + unscoped both count');
  ok(amountEdges(pol([{ effect: 'bias_cautious', match: {} }, { effect: 'decline', match: { domains: ['crypto'] } }]), 'finance').basis === null,
    "rules without amounts (the dev Mac's two) → default");
  ok(amountEdges(pol([{ effect: 'escalate', match: { amount_gt: 0 } }, { effect: 'escalate', match: { amount_gt: -5 } }]), 'x').basis === null,
    'zero / negative bounds are not edges');
}

// ── Floor: above high → high, above low → medium, at an edge → nothing ────────
{
  const rules = pol([{ effect: 'escalate', match: { domains: ['finance'], amount_gt: 5000 } }, { effect: 'autoproceed', match: { domains: ['finance'], amount_lte: 50 } }]);
  ok(amountFloor(n({ domain: 'finance', amount: 12000 }), rules)?.band === 'high', '$12,000 > $5,000 → high');
  ok(amountFloor(n({ domain: 'finance', amount: 5000 }), rules)?.band === 'medium', 'exactly $5,000 is not above it → medium');
  ok(amountFloor(n({ domain: 'finance', amount: 200 }), rules)?.band === 'medium', '$200 → medium');
  ok(amountFloor(n({ domain: 'finance', amount: 50 }), rules) === null, 'exactly $50 → no floor');
  ok(amountFloor(n({ domain: 'finance', amount: 20 }), rules) === null, '$20 → no floor');
  ok(amountFloor(n({ domain: 'finance', amount: 12000 }), rules).basis === 'self_reported', 'basis names the subject as the source');
  ok(amountFloor(n({ domain: 'finance', amount: 12000 }), [])?.basis === null, 'default edges → basis null');
  ok(amountFloor(n({ domain: 'finance' }), rules) === null, 'no amount → no floor');
  ok(amountFloor(n({ domain: 'finance', amount: 0 }), rules) === null && amountFloor(n({ domain: 'finance', amount: -9000 }), rules) === null,
    'zero / negative amount → no floor');
  ok(amountFloor(null, rules) === null, 'no request → no floor');
}

// ── The resolver: the case that motivated this, on a real-shaped profile ──────
const FP = { phaedo_fingerprint: { persona_strength: 0.6, layers: {
  decision_and_risk: { responses: [{ answer: 'Quality over speed' }, { answer: 'much more cautious and seek more input' }] },
  behavioral: { responses: [{ answer: 'covered the main risks' }, { answer: 'ask a clarifying question' }] },
} } };
const resolve = (vd, ad, opts) => resolveConsultationCore(vd, { consultation_type: 'action_approval', action_descriptor: ad }, opts);
const CAUTION = { proceed: 0, proceed_with_note: 1, clarify: 2, escalate: 2, decline: 3, insufficient_signal: -1 };
{
  // An agent that labels a $12k payment "low" no longer gets the low-stakes answer.
  const labelled = { domain: 'finance', reversible: true, magnitude: 'low' };
  const without = resolve(FP, labelled);
  const withAmt = resolve(FP, { ...labelled, amount: 12000 });
  ok(CAUTION[withAmt.signal] > CAUTION[without.signal], `$12k labelled low: ${without.signal} → ${withAmt.signal} (more cautious)`);
  // A small amount changes nothing.
  ok(resolve(FP, { ...labelled, amount: 20 }).signal === without.signal, '$20 labelled low: unchanged');
  // The subject's own number moves the edge: under a $50,000 rule, $12k is only medium.
  const fin = pol([{ effect: 'escalate', match: { domains: ['finance'], amount_gt: 50000 } }]);
  ok(amountFloor(n({ ...labelled, amount: 12000 }), fin) === null, "under the subject's single $50,000 line, $12k has no floor");
}

// ── CAUTION-ONLY, exhaustively: an amount never makes an answer more permissive ─
// Measured on the INFERRED step (ruleResponse) — the only thing B1 changes. Authored §10.5
// rules that bound amounts legitimately change matching (a "be bolder under $10" bias
// SHOULD fire on $1); that is the subject's own rule working, not the band.
{
  const policySets = [
    undefined,
    { version: '0.1', rules: [{ effect: 'escalate', match: { domains: ['finance'], amount_gt: 5000 } }] },
    { version: '0.1', rules: [{ effect: 'autoproceed', match: { domains: ['finance'], amount_lte: 50, magnitude_max: 'medium', reversible: true } }] },
    { version: '0.1', rules: [{ effect: 'bias_bold', match: { amount_lt: 10 } }] },
  ];
  const fps = [FP, { phaedo_fingerprint: { persona_strength: 0.6, layers: {
    decision_and_risk: { responses: [{ answer: 'Speed over quality' }, { answer: 'act fast and adjust' }] },
    behavioral: { responses: [{ answer: 'go with my gut' }, { answer: 'make a reasonable assumption' }] } } } }];
  let combos = 0;
  for (const vd of fps) for (const policies of policySets) for (const domain of ['finance', 'shopping', undefined])
    for (const reversible of [true, false, undefined]) for (const magnitude of ['low', 'medium', 'high', undefined])
      for (const amount of [1, 50, 99, 150, 999, 2500, 12000, 1e9]) {
        const ad = { domain, reversible, magnitude };
        const P = normalizePolicies(policies || []);
        const na = n(ad); na.amountBand = amountFloor(na, P);
        const nb = n({ ...ad, amount }); nb.amountBand = amountFloor(nb, P);
        const a = ruleResponse(vd, na);
        const b = ruleResponse(vd, nb);
        assert.ok(CAUTION[b.signal] >= CAUTION[a.signal],
          `amount ${amount} made it MORE permissive: ${a.signal} → ${b.signal} (${JSON.stringify(ad)}, policies ${policies ? 'set' : 'none'})`);
        combos++;
      }
  ok(combos > 1000, `caution-only holds across ${combos} inferred combinations`);
}

// ── §10.5 is untouched: matching reads the DECLARED magnitude, not the floor ────
{
  // A grant capped at `low` magnitude with its own amount ceiling: it fires on what the
  // subject wrote (amount ≤ 50), exactly as before.
  const grant = { version: '0.1', rules: [{ id: 'g1', effect: 'autoproceed', match: { domains: ['shopping'], magnitude_max: 'low', amount_lte: 50 } }] };
  const r = resolve(FP, { domain: 'shopping', reversible: true, magnitude: 'low', amount: 40 }, { policies: grant });
  ok(r.signal === 'proceed' && /Per your standing rule/.test(r.rationale_hint), 'a grant with its own amount ceiling fires as authored');
  // Declared `low` + a large amount: the band raises the INFERRED answer, but the grant's
  // own ceiling (≤ $50) is what keeps it from firing — §10.5 matching is unchanged.
  const big = resolve(FP, { domain: 'shopping', reversible: true, magnitude: 'low', amount: 12000 }, { policies: grant });
  ok(!/Per your standing rule/.test(big.rationale_hint), "the grant does not fire above its own ceiling");
  // A prohibition floor at $5,000 fires on the amount, as before — the band does not replace it.
  const floor = { version: '0.1', rules: [{ id: 'p1', effect: 'escalate', match: { domains: ['finance'], amount_gt: 5000 } }] };
  ok(resolve(FP, { domain: 'finance', reversible: true, magnitude: 'low', amount: 12000 }, { policies: floor }).signal === 'escalate',
    'an authored floor still decides on its own');
}

// ── Provenance: the band is on the receipt, and the receipt still fits the schema ─
{
  const opts = { policies: { version: '0.1', rules: [{ effect: 'escalate', match: { domains: ['finance'], amount_gt: 5000 } }] } };
  const req = { consultation_type: 'action_approval', action_descriptor: { domain: 'finance', reversible: true, magnitude: 'low', amount: 12000 } };
  const d = consultDrivers(FP, req, opts).find((x) => x.cue === 'amountBand');
  ok(d && d.value === 'high' && d.basis === 'self_reported' && d.confidence === 1, 'driver: amountBand high, from the subject');
  const dDef = consultDrivers(FP, { ...req, action_descriptor: { ...req.action_descriptor } }).find((x) => x.cue === 'amountBand');
  ok(dDef && dDef.basis === null, 'driver without policies: default edges, basis null');
  ok(!consultDrivers(FP, { ...req, action_descriptor: { domain: 'finance', amount: 20 } }, opts).some((x) => x.cue === 'amountBand'), 'no band → no driver');
  ok(!consultDrivers(FP, { consultation_type: 'domain_risk_check', action_descriptor: { domain: 'finance', amount: 12000 } }, opts).some((x) => x.cue === 'amountBand'),
    'only action_approval reads the band');

  const schema = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'schemas', 'consultation-receipt.schema.json'), 'utf8'));
  const receipt = buildReceipt({ via: 'phaedo_consult', agentId: 't', request: req, response: { signal: 'clarify', confidence: 0.5, deference_level: 'medium' }, drivers: consultDrivers(FP, req, opts) });
  const items = schema.properties.drivers.items;
  ok(receipt.drivers.some((x) => x.cue === 'amountBand'), 'band driver survives buildReceipt');
  ok(receipt.drivers.every((x) => items.required.every((k) => k in x) && Object.keys(x).every((k) => items.properties[k])), 'every driver fits the receipt schema');
  ok(!JSON.stringify(receipt.drivers).includes('5000'), "the subject's threshold value is never written into provenance");
}

console.log(`✓ test-amount-bands: ${pass} checks passed`);
