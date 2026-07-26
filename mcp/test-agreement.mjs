#!/usr/bin/env node
// M5 agreement-tracking foundation: fixture receipt store with KNOWN overrides →
// correct per-domain agreement rates (the brief's exit criterion). Plus window
// edges, non-directional exclusion, modified-as-disagreement, null-rate semantics,
// and integration with the real receipt store (append → updateUserAction → compute).
// Run: node test-agreement.mjs   (from mcp/)

import assert from 'assert';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { computeAgreement, agreementDigest, DECISIVE, DEFAULT_WINDOW_DAYS } from './agreement.js';
import { buildReceipt, appendReceipt, updateUserAction, readReceipts } from './receipts.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const NOW = Date.parse('2026-06-10T12:00:00Z');
const day = (n) => NOW - n * 24 * 60 * 60 * 1000;
const rcpt = (domain, signal, user_action, agoDays, extra = {}) => ({
  receipt_id: `r-${domain}-${signal}-${agoDays}-${Math.random().toString(36).slice(2, 6)}`,
  created_at: new Date(day(agoDays)).toISOString(),
  via: 'phaedo_consult',
  agent_id: 'fixture',
  request: { consultation_type: 'action_approval', action_descriptor: { domain, reversible: false, magnitude: 'high', amount: null, summary: null } },
  response: { signal, confidence: 0.7, deference_level: 'medium' },
  user_action,
  ...extra,
});

// ── Known-overrides fixture (the brief's exit criterion) ──────────────────────
console.log('\nper-domain rates from known overrides');
const fixture = [
  // financial: 3 scored → 2 agree (proceed/approved, decline/rejected), 1 disagree (proceed/rejected)
  rcpt('financial', 'proceed', 'approved', 1),
  rcpt('financial', 'decline', 'rejected', 2),
  rcpt('financial', 'proceed', 'rejected', 3),
  // financial: non-directional + awaiting — excluded from the rate
  rcpt('financial', 'escalate', 'approved', 1),
  rcpt('financial', 'proceed_with_note', null, 2),
  // writing: 2 scored → 2 agree (case-insensitive domain key)
  rcpt('Writing', 'proceed_with_note', 'approved', 1),
  rcpt('writing', 'proceed', 'approved', 4),
  // legal: 1 scored → 0 agree (modified counts as disagreement)
  rcpt('legal', 'proceed', 'modified', 1),
  // no domain → "(none)" bucket; unknown user_action excluded
  rcpt(null, 'decline', 'approved', 1),
  rcpt(null, 'proceed', 'unknown', 1),
  // outside the window — must not count anywhere
  rcpt('financial', 'proceed', 'rejected', 40),
];
const rep = computeAgreement(fixture, { windowDays: 30, now: NOW });

ok(rep.window.in_window === 10 && rep.window.total_receipts === 11, 'window: 10 of 11 in the last 30d');
const fin = rep.domains.financial;
ok(fin.scored === 3 && fin.agreements === 2 && fin.disagreements === 1, `financial: 2/3 agree (got ${fin.agreements}/${fin.scored})`);
ok(fin.rate === 0.667, `financial rate 0.667 (got ${fin.rate})`);
ok(fin.non_directional === 1 && fin.awaiting_user_action === 1, 'financial: escalate excluded as non-directional; null action awaiting');
ok(rep.domains.writing.scored === 2 && rep.domains.writing.rate === 1, 'writing: 2/2 agree, case-insensitive domain key');
ok(rep.domains.legal.rate === 0, 'legal: modified counts as DISAGREEMENT (rate 0)');
const none = rep.domains['(none)'];
ok(none.scored === 1 && none.agreements === 0 && none.awaiting_user_action === 1, '(none) bucket: decline/approved disagrees; unknown excluded');
ok(rep.overall.scored === 7 && rep.overall.agreements === 4 && rep.overall.rate === 0.571, `overall 4/7 = 0.571 (got ${rep.overall.agreements}/${rep.overall.scored} = ${rep.overall.rate})`);

// ── semantics edges ───────────────────────────────────────────────────────────
console.log('\nedges');
ok(computeAgreement([], { now: NOW }).overall.rate === null, 'no receipts → rate null (no data ≠ 0%)');
ok(computeAgreement([rcpt('x', 'escalate', 'approved', 1)], { now: NOW }).overall.rate === null, 'only non-directional → rate null');
ok(DECISIVE.join(',') === 'proceed,proceed_with_note,decline', 'decisive set is exactly the outcome-predicting signals');
const abstainRep = computeAgreement([rcpt('x', 'insufficient_signal', 'approved', 1)], { now: NOW });
ok(abstainRep.overall.non_directional === 1 && abstainRep.overall.scored === 0, 'insufficient_signal is non-directional (never scored)');
ok(computeAgreement([rcpt('x', 'proceed', 'approved', 0.5)], { windowDays: 1, now: NOW }).overall.scored === 1, 'windowDays honored (in)');
ok(computeAgreement([rcpt('x', 'proceed', 'approved', 2)], { windowDays: 1, now: NOW }).overall.scored === 0, 'windowDays honored (out)');
ok(computeAgreement('garbage', { now: NOW }).overall.scored === 0, 'non-array input → empty report, no throw');
ok(DEFAULT_WINDOW_DAYS === 30, 'default window 30d');

// ── purity ────────────────────────────────────────────────────────────────────
console.log('\npurity');
{
  const frozen = JSON.stringify(fixture);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('agreement must not touch the network'); };
  try { computeAgreement(fixture, { now: NOW }); } finally { globalThis.fetch = savedFetch; }
  ok(JSON.stringify(fixture) === frozen, 'input receipts not mutated');
  pass++; // network-disabled compute completed
}

// ── integration with the real encrypted store ─────────────────────────────────
console.log('\nintegration (receipts store → agreement)');
{
  const dir = await mkdtemp(join(tmpdir(), 'phaedo-agreement-'));
  const a = buildReceipt({ via: 'phaedo_consult', request: { consultation_type: 'action_approval', action_descriptor: { domain: 'financial' } }, response: { signal: 'proceed', confidence: 0.7, deference_level: 'medium' } });
  const b = buildReceipt({ via: 'phaedo_consult', request: { consultation_type: 'action_approval', action_descriptor: { domain: 'financial' } }, response: { signal: 'decline', confidence: 0.8, deference_level: 'high' } });
  await appendReceipt(dir, a); await appendReceipt(dir, b);
  await updateUserAction(dir, a.receipt_id, 'approved');
  await updateUserAction(dir, b.receipt_id, 'rejected');
  const live = computeAgreement(await readReceipts(dir));
  // Keyed by the CANONICAL domain — buildReceipt resolves `financial` to `finance`
  // via the §10.2 vocabulary, so both spellings accumulate in ONE class.
  ok(live.domains.finance.scored === 2 && live.domains.finance.rate === 1, 'end-to-end: append → user_action → 2/2 agreement');
}

// ── agreementDigest: the bounded slice that rides the receipts digest ─────────
console.log('\nagreementDigest (transportable summary)');
{
  const d = agreementDigest(fixture, { now: NOW });
  ok(d.window_days === DEFAULT_WINDOW_DAYS, 'digest carries the window');
  ok(d.overall.rate === computeAgreement(fixture, { now: NOW }).overall.rate, 'digest overall rate matches the full report');

  // Slim shape: counts + rate only. No window object, no derived text, and nothing
  // that could carry layer content or rationale into the payload.
  ok(Object.keys(d).sort().join(',') === 'domains,overall,window_days', `digest top-level keys are bounded — got ${Object.keys(d).sort().join(',')}`);
  ok(Object.keys(d.overall).sort().join(',') === 'agreements,awaiting_user_action,disagreements,non_directional,rate,scored',
    `bucket keys are bounded — got ${Object.keys(d.overall).sort().join(',')}`);

  // A domain with nothing SCORED says nothing — spending payload on it is waste.
  const unscoredOnly = [rcpt('mystery', 'escalate', null, 1), rcpt('mystery', 'clarify', null, 2)];
  const u = agreementDigest(unscoredOnly, { now: NOW });
  ok(Object.keys(u.domains).length === 0, 'domains with zero scored receipts are dropped');
  ok(u.overall.non_directional === 2, 'but they still count in the overall bucket');

  // Bounded + deterministic: the digest is a last-write-wins payload, so an
  // unstable key order would make every deposit look like a change.
  const many = [];
  for (let i = 0; i < 20; i++) many.push(rcpt(`dom${String(i).padStart(2, '0')}`, 'proceed', 'approved', 1));
  const capped = agreementDigest(many, { now: NOW, domainCap: 3 });
  ok(Object.keys(capped.domains).length === 3, 'domain map is capped');
  ok(JSON.stringify(agreementDigest(many, { now: NOW })) === JSON.stringify(agreementDigest(many, { now: NOW })),
    'digest is deterministic for the same input');
  const tieOrder = Object.keys(capped.domains);
  ok(JSON.stringify(tieOrder) === JSON.stringify([...tieOrder].sort()), 'equal-scored domains break ties by name');

  // Ranked by evidence, not alphabetically — the busiest domains survive the cap.
  const ranked = agreementDigest(
    [rcpt('quiet', 'proceed', 'approved', 1), ...Array.from({ length: 5 }, () => rcpt('busy', 'proceed', 'approved', 1))],
    { now: NOW, domainCap: 1 },
  );
  ok(Object.keys(ranked.domains)[0] === 'busy', 'the cap keeps the best-evidenced domain');

  // Degenerate inputs must not throw — this runs inside a best-effort deposit.
  for (const bad of [null, undefined, [], 'nope', 42]) {
    const r = agreementDigest(bad, { now: NOW });
    ok(r && r.overall.scored === 0 && r.overall.rate === null, `agreementDigest(${JSON.stringify(bad)}) degrades to an empty summary`);
  }
  ok(agreementDigest(many, { now: NOW, domainCap: 0 }).domains && Object.keys(agreementDigest(many, { now: NOW, domainCap: 0 }).domains).length === 0, 'domainCap 0 → no domains, no throw');
}

console.log(`\n✓ agreement: ${pass} checks passed`);
