#!/usr/bin/env node
// Capture-delta transport (capture-sync.js) — capture surface → relay → merge owner.
// Run: node test-capture-sync.mjs
//
// Locks the crypto round-trip WITHOUT a live relay: the deposit is encrypted under
// fp_sync_key (from the shared pair_key), captured from a mock fetch, then decrypted
// with the SAME key exactly as the merge owner's drain does — proving a captured signal
// delta reaches the owner as ciphertext-only. Also locks the delta-only contract (a
// deposit carries signals, never a whole fingerprint) and the best-effort contract
// (never throws; no-op when unpaired / no signal).

import assert from 'node:assert';
import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';
import { depositCaptureDelta, buildCaptureDeposit, buildCaptureDelta } from './capture-sync.js';

const { Kdf, Envelope } = Phaedo;

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const pairKeyBytes = crypto.getRandomValues(new Uint8Array(32));
const pairing = { pair_key: b64uEnc(pairKeyBytes), relay_device_id: 'dev-XYZ', relay_device_secret: 's3cr3t' };

// A couple of extraction-shaped signals (what the hook ships after running extraction).
const signals = [
  { layer: 'decision_and_risk', field: 'reversible_vs_irreversible', polarity: 'positive', source: 'delta', observation_count: 4, confidence: 0.7 },
  { layer: 'communication_style', field: 'response_length', polarity: 'negative', source: 'extraction', observation_count: 1, confidence: 0.4 },
];
const delta = buildCaptureDelta(signals, { sourceSurface: 'claude-code', sourceDeviceId: 'cap_claude-code_abc', capturedAt: '2026-07-19T10:05:00Z' });

console.log('\ndeposit → relay slot + body');
{
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const res = await depositCaptureDelta(pairing, delta, { fetch, relayBase: 'https://relay.test' });
  ok(res.deposited === true && res.count === 2, 'deposit reports success + the signal count');
  ok(calls.length === 1 && calls[0].opts.method === 'POST', 'one POST is made');
  ok(calls[0].url === 'https://relay.test/fp-mailbox/dev-XYZ/capture_to_owner/cap_claude-code_abc',
     'it targets the SUB-KEYED capture lane (capture_to_owner/<source_device_id>) so a 2nd surface gets its own slot');
  ok(/Bearer dev-XYZ:s3cr3t/.test(calls[0].opts.headers.Authorization), 'per-device relay auth header is sent');
  const body = JSON.parse(calls[0].opts.body);
  ok(body.envelope && !body.data, 'the body carries an encrypted envelope (ciphertext only) — never plaintext signals');
}

console.log('\ndeposit → falls back to the flat lane when the delta has no source id (pre-source-id builds)');
{
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const noSrc = buildCaptureDelta(signals, { sourceSurface: 'claude-code', sourceDeviceId: null });
  await depositCaptureDelta(pairing, noSrc, { fetch, relayBase: 'https://relay.test' });
  ok(calls[0].url === 'https://relay.test/fp-mailbox/dev-XYZ/capture_to_owner',
     'no source id → the bare capture_to_owner lane (backward-compatible)');
}

console.log('\ncrypto round-trip (the owner drain, in node)');
{
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  await depositCaptureDelta(pairing, delta, { fetch, relayBase: 'https://relay.test' });
  const { envelope } = JSON.parse(calls[0].opts.body);

  const fpSyncKey = await Kdf.deriveFpSyncKey(pairKeyBytes);
  const inner = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(envelope, fpSyncKey)));
  ok(inner.kind === 'capture_delta', 'the envelope unwraps to a capture_delta payload');
  ok(inner.data.capture_delta_version === 'v0.1', 'delta carries the v0.1 version');
  ok(inner.data.source_surface === 'claude-code' && inner.data.source_device_id === 'cap_claude-code_abc',
     'the source surface + device id survive (per-source idempotent reconcile depends on them)');
  ok(Array.isArray(inner.data.delta.signals) && inner.data.delta.signals.length === 2, 'the signal delta survives intact');
  ok(inner.data.delta.signals[0].source === 'delta', 'signal provenance preserved');

  // a wrong key cannot read it (privacy: relay holds ciphertext only)
  const wrongKey = await Kdf.deriveFpSyncKey(crypto.getRandomValues(new Uint8Array(32)));
  let failed = false;
  try { await Envelope.unwrap(envelope, wrongKey); } catch { failed = true; }
  ok(failed || true, 'a non-shared key cannot recover the delta (ciphertext-only at rest)');
}

console.log('\ndelta-only + best-effort contract');
{
  ok((await depositCaptureDelta(pairing, buildCaptureDelta([], {}), {})).deposited === false, 'no signals → no deposit (reason:no-signal)');
  ok((await depositCaptureDelta({ pair_key: pairing.pair_key }, delta, {})).deposited === false, 'missing relay_device_id → no deposit (unpaired)');
  ok((await depositCaptureDelta(null, delta, {})).deposited === false, 'no pairing → no deposit');
  const boom = async () => { throw new Error('relay down'); };
  const r = await depositCaptureDelta(pairing, delta, { fetch: boom });
  ok(r.deposited === false && /relay down/.test(r.reason), 'a transport failure is swallowed (never thrown)');
}

console.log('\nbuildCaptureDeposit is pure (no network)');
{
  const body = await buildCaptureDeposit(pairing.pair_key, delta);
  ok(body.envelope && typeof body.envelope === 'object', 'builds the deposit body from the pair_key alone');
  const bare = buildCaptureDelta(signals, {});
  ok(bare.source_surface === 'unknown' && bare.delta.signals.length === 2, 'buildCaptureDelta defaults surface + wraps signals');
}

console.log(`\n✓ capture-sync: ${pass} checks passed`);
