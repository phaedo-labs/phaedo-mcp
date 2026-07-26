#!/usr/bin/env node
// The mcp-local capture tier (capture-local.js + the fingerprint-source.js gate).
// Run: node mcp/test-capture-local.mjs
//
// Locks the tier-3 contract (desktop-capture-deposit.md §4): an UNPAIRED server —
// the phone-less, browser-less Claude Code dev — folds the capture hook's local
// cumulative state into the fingerprint it serves, at read time, idempotently;
// a paired setup or an explicit PHAEDO_FINGERPRINT never folds.

import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, applySession, saveState, defaultStatePath } from '../capture/state.js';
import { loadFingerprint } from './fingerprint-source.js';
import { foldLocalCapture, isLocalCaptureOwner } from './capture-local.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const NOW = '2026-07-20T12:00:00Z';
const SOURCE_ID = 'cap_claude-code_test1234';

const counts = (n) => ({
  behavioral_signals: { surface: { too_long: n } },
  positive_count: 0, mental_models: {}, message_count: n,
});

// Hermetic sandbox: state dir + base dir under tmp; no pairing, no override.
const stateDir = mkdtempSync(join(tmpdir(), 'phaedo-capture-local-state-'));
const baseDir = mkdtempSync(join(tmpdir(), 'phaedo-capture-local-base-'));
process.env.PHAEDO_MCP_STATE_DIR = stateDir;
delete process.env.PHAEDO_FINGERPRINT;
delete process.env.PHAEDO_PAIRING;

const bareFp = () => ({
  phaedo_fingerprint: { fingerprint_id: 'fp-local-test', updated_at: NOW, layers: {} },
});
writeFileSync(join(baseDir, 'fingerprint.json'), JSON.stringify(bareFp()));

const findDelta = (vd) => {
  const layers = (vd.phaedo_fingerprint && vd.phaedo_fingerprint.layers) || {};
  for (const doc of Object.values(layers)) {
    const hit = (doc.signals || []).find((s) => s.source === 'delta' && s.field === 'response_length_pref');
    if (hit) return hit;
  }
  return null;
};

console.log('\nowner gate: unpaired owns, paired yields');
{
  ok(await isLocalCaptureOwner(false) === true, 'unpaired → mcp-local is the owner');
  ok(await isLocalCaptureOwner(true) === false, 'phone paired → mcp-local yields (fold must not apply)');
}

console.log('\nempty state: served verbatim');
{
  const vd = await loadFingerprint(baseDir);
  ok(!findDelta(vd), 'no capture state → no delta signals appear');
  ok(vd.phaedo_fingerprint.fingerprint_id === 'fp-local-test', 'local fingerprint served');
}

console.log('\naccumulated state: folded into the served fingerprint at read time');
{
  const st = applySession(emptyState(), SOURCE_ID, 'session-1', counts(3), { now: NOW });
  saveState(defaultStatePath(), st);
  const vd = await loadFingerprint(baseDir);
  const sig = findDelta(vd);
  ok(sig && sig.observation_count === 3 && sig.value === 'short', 'hook counters surface as a source=delta signal (×3, "short")');
  // Idempotent: a second load re-folds the same cumulative snapshot to the same count.
  const again = findDelta(await loadFingerprint(baseDir));
  ok(again && again.observation_count === 3, 'second read folds to the SAME count — read-time overlay never compounds');
  // The on-disk source file is never rewritten (discard-raw + no persistence).
  const raw = JSON.parse((await import('node:fs')).readFileSync(join(baseDir, 'fingerprint.json'), 'utf8'));
  ok(!findDelta(raw) && Object.keys(raw.phaedo_fingerprint.layers).length === 0, 'fingerprint.json on disk stays untouched');
}

console.log('\nstate advances: the served count follows the cumulative total');
{
  let st = applySession(emptyState(), SOURCE_ID, 'session-1', counts(3), { now: NOW });
  st = applySession(st, SOURCE_ID, 'session-2', counts(2), { now: NOW });
  saveState(defaultStatePath(), st);
  const sig = findDelta(await loadFingerprint(baseDir));
  ok(sig && sig.observation_count === 5, 'two sessions → cumulative 3 + 2 = 5 served');
}

console.log('\nPHAEDO_FINGERPRINT override: verbatim, never folded (hermetic-test escape hatch)');
{
  const overridePath = join(baseDir, 'override.json');
  writeFileSync(overridePath, JSON.stringify(bareFp()));
  process.env.PHAEDO_FINGERPRINT = overridePath;
  const vd = await loadFingerprint(baseDir);
  ok(!findDelta(vd), 'explicit fingerprint file served without the capture fold');
  delete process.env.PHAEDO_FINGERPRINT;
}

console.log('\nfoldLocalCapture edges');
{
  ok(await foldLocalCapture(null) === null, 'null payload → unchanged');
  const noFp = { phaedo_behavioral_signals: {} };
  ok(await foldLocalCapture(noFp) === noFp, 'payload without a fingerprint → unchanged');
  // Input purity: folding never mutates the caller's object.
  const input = bareFp();
  const folded = await foldLocalCapture(input, { now: NOW });
  ok(Object.keys(input.phaedo_fingerprint.layers).length === 0, 'input payload not mutated');
  ok(findDelta(folded), 'returned payload carries the folded signal');
}

rmSync(stateDir, { recursive: true, force: true });
rmSync(baseDir, { recursive: true, force: true });
console.log(`\n✓ capture local tier: ${pass} checks passed`);
