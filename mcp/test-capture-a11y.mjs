#!/usr/bin/env node
// Track B a11y capture core (capture-a11y.js) — reconstructed turns → shared spine →
// sub-keyed deposit, end to end with injected deps (no network, no real state dir).
// Proves the a11y front-end rides the SAME pipeline as the Claude Code hook and lands in
// the SAME sub-keyed lane, encrypted, with the a11y-macos surface tag. Run: node test-capture-a11y.mjs

import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';
import { runA11yCapture } from './capture-a11y.js';

const { Kdf, Envelope } = Phaedo;
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// Hermeticity: no real capture model, pinned state dir (mirrors the hook test).
delete process.env.PHAEDO_CAPTURE_MODEL;
const dir = mkdtempSync(join(tmpdir(), 'phaedo-a11y-'));
process.env.PHAEDO_MCP_STATE_DIR = dir;
const statePath = join(dir, 'capture-state.json');
const pairKeyBytes = crypto.getRandomValues(new Uint8Array(32));
const pairing = { pair_key: b64uEnc(pairKeyBytes), relay_device_id: 'dev-XYZ', relay_device_secret: 's3' };

// A reconstructed Claude-Desktop chat: two user turns carry the same correction (too_long ×2).
const payload = {
  conversation_id: 'chat-abc',
  source_surface: 'a11y-macos',
  captured_at: '2026-07-21T05:00:00Z',
  turns: [
    { role: 'user', text: 'this is too long, cut it down' },
    { role: 'assistant', text: 'shorter version' },
    { role: 'user', text: 'still too long, be more concise' },
    { role: 'assistant', text: 'ok, trimmed' },
    { role: 'user', text: 'thanks, that works' },
    { role: 'assistant', text: 'glad it helped' },
  ],
};

console.log('\nfull pass: turns → detect → state → lift → SUB-KEYED deposit');
let firstSignals = 0;
{
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const res = await runA11yCapture(payload, { fetch, pairing, statePath, relayBase: 'https://relay.test', captureModel: false });
  ok(res.deposited === true, 'deposited');
  ok(res.counted === 3, '3 user prompts counted (Path-A per sent turn)');
  ok(res.signals >= 1, 'at least one delta signal lifted');
  firstSignals = res.signals;
  ok(calls.length === 1 && calls[0].opts.method === 'POST', 'one POST');
  ok(/\/fp-mailbox\/dev-XYZ\/capture_to_owner\/[A-Za-z0-9_.-]+$/.test(calls[0].url),
     'targets the SUB-KEYED capture lane (capture_to_owner/<source_device_id>)');
  ok(/Bearer dev-XYZ:s3/.test(calls[0].opts.headers.Authorization), 'per-device relay auth header sent');

  const { envelope } = JSON.parse(calls[0].opts.body);
  ok(envelope && !JSON.parse(calls[0].opts.body).data, 'ciphertext only — never plaintext signals');
  const inner = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(envelope, await Kdf.deriveFpSyncKey(pairKeyBytes))));
  ok(inner.kind === 'capture_delta', 'payload is a capture_delta');
  ok(inner.data.source_surface === 'a11y-macos', 'tagged with the a11y-macos surface');
  const tooLong = inner.data.delta.signals.find((s) => s.field === 'response_length_pref' || s.layer === 'communication_style');
  ok(tooLong && tooLong.observation_count >= 2, 'the repeated too-long correction accumulated (count ≥ 2)');
}

console.log('\nidempotent re-read: same conversation_id REPLACES its session (no double-count)');
{
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const res = await runA11yCapture(payload, { fetch, pairing, statePath, relayBase: 'https://relay.test', captureModel: false });
  ok(res.signals === firstSignals, 're-reading the same chat yields the SAME signal count (per-session replace, not additive)');
  const { envelope } = JSON.parse(calls[0].opts.body);
  const inner = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(envelope, await Kdf.deriveFpSyncKey(pairKeyBytes))));
  const tooLong = inner.data.delta.signals.find((s) => s.field === 'response_length_pref' || s.layer === 'communication_style');
  ok(tooLong && tooLong.observation_count === 2, 'still exactly 2 — the second read did not inflate the counter');
}

console.log('\ngrowth: a NEW conversation adds to the cumulative total');
{
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const p2 = { ...payload, conversation_id: 'chat-def', turns: [
    { role: 'user', text: 'too long again, shorten please' },
    { role: 'assistant', text: 'done' },
  ] };
  await runA11yCapture(p2, { fetch, pairing, statePath, relayBase: 'https://relay.test', captureModel: false });
  const { envelope } = JSON.parse(calls[0].opts.body);
  const inner = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(envelope, await Kdf.deriveFpSyncKey(pairKeyBytes))));
  const tooLong = inner.data.delta.signals.find((s) => s.field === 'response_length_pref' || s.layer === 'communication_style');
  ok(tooLong && tooLong.observation_count === 3, 'a distinct conversation accumulates (2 + 1 = 3)');
}

console.log('\nno-op reasons + fail-safe');
{
  const fetch = async () => ({ ok: true, status: 200 });
  ok((await runA11yCapture({}, { fetch, pairing, statePath, captureModel: false })).reason === 'no-turns', 'missing turns → no-turns');
  ok((await runA11yCapture({ turns: [] }, { fetch, pairing, statePath, captureModel: false })).reason === 'no-exchanges', 'empty turns → no-exchanges');
  const onlyAssistant = { conversation_id: 'x', turns: [{ role: 'assistant', text: 'hi' }] };
  ok((await runA11yCapture(onlyAssistant, { fetch, pairing, statePath, captureModel: false })).reason === 'no-exchanges', 'a leading assistant-only turn → no-exchanges');
  // Unpaired: no pairing, no deposit — but never throws.
  const rUnpaired = await runA11yCapture(payload, { fetch, pairing: null, statePath, captureModel: false });
  ok(rUnpaired.deposited === false, 'unpaired → no deposit (still folds state locally, never throws)');
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ capture a11y core: ${pass} checks passed`);
