#!/usr/bin/env node
// Self-tests for the calibration reliability curve (calibration.js).
// Run: node test-calibration.mjs  (or npm run smoke:calibration)
//
// Locks: decisive predictions bucket by confidence band; a band's realized agreement
// rate vs its mean predicted confidence yields the gap; ECE weights |gap| by band
// volume; non-directional / awaiting / out-of-window receipts are excluded; empty →
// null (no data ≠ perfectly calibrated).

import assert from 'assert';
import { computeCalibration } from './calibration.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const NOW = Date.parse('2026-06-19T00:00:00Z');
const ago = (days) => new Date(NOW - days * 86400_000).toISOString();
const rcpt = (confidence, signal, user_action, o = {}) => ({
  created_at: o.created_at || ago(1),
  response: { signal, confidence, deference_level: 'medium' },
  request: { action_descriptor: { domain: o.domain || 'financial' } },
  user_action,
});
const rep = (receipts, opts = {}) => computeCalibration(receipts, { now: NOW, ...opts });

console.log('\nbucketing + a well-calibrated band');
{
  // 10 predictions at 0.9; 9 hold (approved↔proceed), 1 doesn't → realized 0.9 ≈ predicted 0.9
  const rs = [...Array(9)].map(() => rcpt(0.9, 'proceed', 'approved'))
    .concat([rcpt(0.9, 'proceed', 'rejected')]);
  const r = rep(rs);
  const top = r.bins[4]; // 0.8–1.0
  ok(r.bins.length === 5 && top.lo === 0.8 && top.hi === 1.0, 'default 5 equal-width bands; 0.9 lands in 0.8–1.0');
  ok(top.scored === 10 && top.agreements === 9, 'band counts all decisive scored + its agreements');
  ok(top.predicted_mean === 0.9 && top.realized_rate === 0.9 && top.gap === 0, 'predicted ≈ realized → zero gap');
  ok(r.ece === 0, 'a perfectly-calibrated set has ECE 0');
}

console.log('\noverconfidence shows as a positive gap');
{
  // 10 predictions at 0.9 but only 5 hold → realized 0.5, gap +0.4
  const rs = [...Array(5)].map(() => rcpt(0.9, 'proceed', 'approved'))
    .concat([...Array(5)].map(() => rcpt(0.9, 'proceed', 'modified')));
  const r = rep(rs);
  const top = r.bins[4];
  ok(top.predicted_mean === 0.9 && top.realized_rate === 0.5, 'realized rate well below predicted');
  ok(top.gap === 0.4, 'positive gap = overconfident');
  ok(r.ece === 0.4, 'ECE reflects the single populated band');
}

console.log('\nexclusions (non-directional / awaiting / out-of-window)');
{
  const r = rep([
    rcpt(0.9, 'proceed', 'approved'),     // scored
    rcpt(0.5, 'escalate', 'approved'),    // non-directional → excluded
    rcpt(0.9, 'proceed', null),           // awaiting user_action → excluded
    rcpt(0.9, 'proceed', 'approved', { created_at: ago(99) }), // out of 30d window
  ]);
  ok(r.scored === 1, 'only the in-window decisive, scored receipt counts');
  ok(r.window.in_window === 3, 'window count excludes the 99-day-old receipt');
}

console.log('\nempty / no data');
{
  const r = rep([]);
  ok(r.scored === 0 && r.ece === null, 'no scored receipts → ECE null (not 0)');
  ok(r.bins.every((b) => b.realized_rate === null && b.gap === null), 'every band reads null with no data');
}

console.log('\ndecline path + custom bin count');
{
  // decline↔rejected agrees; spread across 10 bins
  const r = rep([rcpt(0.05, 'decline', 'rejected'), rcpt(0.05, 'decline', 'approved')], { bins: 10 });
  ok(r.bins.length === 10 && r.bins[0].scored === 2 && r.bins[0].agreements === 1, 'custom bin count; decline scored against rejected/approved');
}

console.log(`\n✓ calibration: ${pass} checks passed`);
