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

import { computeAgreement, DECISIVE, DEFAULT_WINDOW_DAYS } from './agreement.js';
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
  ok(live.domains.financial.scored === 2 && live.domains.financial.rate === 1, 'end-to-end: append → user_action → 2/2 agreement');
}

console.log(`\n✓ agreement: ${pass} checks passed`);
