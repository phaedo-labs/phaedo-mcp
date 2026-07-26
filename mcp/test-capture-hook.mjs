#!/usr/bin/env node
// SessionEnd capture hook (hooks/session-end.mjs) — transcript → detectors → state →
// lift → deposit, end to end with injected deps (no network, no real state dir).
// Run: node test-capture-hook.mjs

import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';
import { isMainModule } from './lib/is-main.js';
import { runCaptureHook, loadCapturePairing, CapturePairingError } from './hooks/session-end.mjs';
import { loadState } from '../capture/state.js';
import { deriveSourceDeviceId } from '../capture/source-id.js';

const { Kdf, Envelope } = Phaedo;
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// Hermeticity: a dev machine with a capture model configured must not make these
// tests call a real endpoint (the hook falls back to process.env when deps don't
// pin the model config) — clear the env AND pin the state dir so a real
// ~/.phaedo-mcp/capture-model.json can't switch the model on either.
delete process.env.PHAEDO_CAPTURE_MODEL;

const dir = mkdtempSync(join(tmpdir(), 'phaedo-hook-'));
process.env.PHAEDO_MCP_STATE_DIR = dir;
const statePath = join(dir, 'capture-state.json');
const pairKeyBytes = crypto.getRandomValues(new Uint8Array(32));
const pairing = { pair_key: b64uEnc(pairKeyBytes), relay_device_id: 'dev-XYZ', relay_device_secret: 's3' };

const L = (o) => JSON.stringify(o);
// 3 exchanges; two carry corrections (too_long ×2), one is neutral.
const transcript = [
  L({ type: 'user', uuid: 'u1', timestamp: '2026-07-19T10:00:00Z', sessionId: 'sess-9', message: { role: 'user', content: 'this is too long, cut it down' } }),
  L({ type: 'assistant', uuid: 'a1', sessionId: 'sess-9', message: { role: 'assistant', content: [{ type: 'text', text: 'shorter version' }] } }),
  L({ type: 'user', uuid: 'u2', timestamp: '2026-07-19T10:01:00Z', sessionId: 'sess-9', message: { role: 'user', content: 'thanks, now the tests' } }),
  L({ type: 'assistant', uuid: 'a2', sessionId: 'sess-9', message: { role: 'assistant', content: [{ type: 'text', text: 'running' }] } }),
  L({ type: 'user', uuid: 'u3', timestamp: '2026-07-19T10:02:00Z', sessionId: 'sess-9', message: { role: 'user', content: 'still too verbose, be concise' } }),
  L({ type: 'assistant', uuid: 'a3', sessionId: 'sess-9', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
].join('\n');
const tPath = join(dir, 'sess-9.jsonl');
writeFileSync(tPath, transcript, 'utf8');

const input = { session_id: 'sess-9', transcript_path: tPath, hook_event_name: 'SessionEnd' };

console.log('\nfull pass: transcript → detect → state → lift → deposit');
{
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const res = await runCaptureHook(input, { fetch, pairing, statePath, relayBase: 'https://relay.test', now: '2026-07-19T10:05:00Z' });
  ok(res.deposited === true && res.counted === 3, 'deposited; 3 exchanges counted');
  ok(calls[0].url.startsWith('https://relay.test/fp-mailbox/dev-XYZ/capture_to_owner/'),
     'targets the SUB-KEYED capture lane (capture_to_owner/<source_device_id>)');

  const { envelope } = JSON.parse(calls[0].opts.body);
  const inner = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(envelope, await Kdf.deriveFpSyncKey(pairKeyBytes))));
  ok(inner.kind === 'capture_delta' && inner.data.source_surface === 'claude-code', 'capture_delta payload from the claude-code surface');
  const tooLong = inner.data.delta.signals.find((s) => s.field === 'response_length_pref');
  ok(tooLong && tooLong.observation_count === 2 && tooLong.source === 'delta', 'too_long ×2 lifted as a source=delta signal with CUMULATIVE count');
  ok(inner.data.source_device_id === deriveSourceDeviceId(pairing, 'claude-code'), 'source id matches the derivation (stable)');
  ok(!JSON.stringify(inner).includes('too verbose'), 'NO transcript text in the deposit (discard-raw contract)');
  ok(loadState(statePath).surfaces[inner.data.source_device_id].sessions['sess-9'], 'state persisted per session');
}

console.log('\nresume-safety: same session re-fires → REPLACE, not double');
{
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  await runCaptureHook(input, { fetch, pairing, statePath, relayBase: 'https://relay.test', now: '2026-07-19T11:00:00Z' });
  const { envelope } = JSON.parse(calls[0].opts.body);
  const inner = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(envelope, await Kdf.deriveFpSyncKey(pairKeyBytes))));
  const tooLong = inner.data.delta.signals.find((s) => s.field === 'response_length_pref');
  ok(tooLong.observation_count === 2, 'cumulative count STILL 2 after re-processing the same session (no double-count)');
}

console.log('\nfail-safe contract (never throws, precise reasons)');
{
  ok((await runCaptureHook({}, { statePath })).reason === 'no-transcript-path', 'missing transcript_path');
  ok((await runCaptureHook({ transcript_path: join(dir, 'nope.jsonl') }, { statePath })).reason === 'transcript-unreadable', 'unreadable transcript');
  const empty = join(dir, 'empty.jsonl'); writeFileSync(empty, '', 'utf8');
  ok((await runCaptureHook({ transcript_path: empty }, { statePath })).reason === 'no-exchanges', 'empty transcript');
  // Unpaired: state still accumulates (local tier can use it); deposit no-ops.
  const r = await runCaptureHook(input, { pairing: null, statePath: join(dir, 'unpaired.json'), now: '2026-07-19T12:00:00Z' });
  ok(r.deposited === false && r.reason === 'unpaired', 'unpaired → no deposit, no throw');
  ok(loadState(join(dir, 'unpaired.json')).surfaces[deriveSourceDeviceId(null, 'claude-code')], 'unpaired machine still accumulates local state');
  // Neutral transcript → counters but no mapped signal → no deposit.
  const neutral = join(dir, 'neutral.jsonl');
  writeFileSync(neutral, [
    L({ type: 'user', uuid: 'n1', sessionId: 'sess-n', message: { role: 'user', content: 'hello there' } }),
    L({ type: 'assistant', uuid: 'n2', sessionId: 'sess-n', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
  ].join('\n'), 'utf8');
  const rn = await runCaptureHook({ session_id: 'sess-n', transcript_path: neutral }, { pairing, statePath: join(dir, 'n.json') });
  ok(rn.deposited === false && rn.reason === 'no-signal', 'no mapped signal → no deposit (nothing garbage ever ships)');
}

console.log('\nloadCapturePairing: capture-specific pairing wins, broken pairing ABORTS (no wrong-key fallback)');
{
  const { mkdirSync } = await import('node:fs');
  const mcpDir = join(dir, 'mcp');
  const quiet = () => {};   // suppress the stderr warning in tests
  writeFileSync(join(dir, 'env-pairing.json'), JSON.stringify({ pair_key: 'ENVKEY', relay_device_id: 'dev-env', relay_device_secret: 's' }), { flag: 'w' });
  mkdirSync(mcpDir, { recursive: true });
  // No capture pairing anywhere → null (caller falls back to pairing.json).
  ok(loadCapturePairing(mcpDir, {}, quiet) === null, 'no capture pairing → null (fallback to the MCP pairing)');
  // pairing.capture.json is picked up and preferred.
  writeFileSync(join(mcpDir, 'pairing.capture.json'), JSON.stringify({ pair_key: 'EXTKEY', relay_device_id: 'dev-ext', relay_device_secret: 's' }));
  ok(loadCapturePairing(mcpDir, {}, quiet).pair_key === 'EXTKEY', 'pairing.capture.json is preferred');
  // Env path override wins over the file.
  ok(loadCapturePairing(mcpDir, { PHAEDO_CAPTURE_PAIRING: join(dir, 'env-pairing.json') }, quiet).pair_key === 'ENVKEY', 'PHAEDO_CAPTURE_PAIRING wins over pairing.capture.json');
  // A PRESENT but broken capture pairing THROWS (must not silently fall back to a different key).
  const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof CapturePairingError; } };
  writeFileSync(join(mcpDir, 'pairing.capture.json'), JSON.stringify({ pair_key: 'ONLYKEY' }));
  ok(throws(() => loadCapturePairing(mcpDir, {}, quiet)), 'missing relay_device_id → THROWS (no silent wrong-key fallback)');
  writeFileSync(join(mcpDir, 'pairing.capture.json'), '{ not valid json');
  ok(throws(() => loadCapturePairing(mcpDir, {}, quiet)), 'unparseable capture pairing → THROWS');
  ok(throws(() => loadCapturePairing(mcpDir, { PHAEDO_CAPTURE_PAIRING: join(dir, 'nope.json') }, quiet)), 'explicit env path missing → THROWS (never silently uses wrong key)');
  // A valid record lacking relay_device_secret is returned but WARNS (deposits will 401).
  let warned = '';
  writeFileSync(join(mcpDir, 'pairing.capture.json'), JSON.stringify({ pair_key: 'NOSEC', relay_device_id: 'dev-x' }));
  const rec = loadCapturePairing(mcpDir, {}, (m) => { warned = m; });
  ok(rec.pair_key === 'NOSEC' && /relay_device_secret/.test(warned), 'no relay_device_secret → returned but warned');
  // The hook, given a broken capture pairing, skips the deposit and still accumulates state.
  writeFileSync(join(mcpDir, 'pairing.capture.json'), '{ broken');
  const r = await runCaptureHook(input, { statePath: join(dir, 'brk.json'), mcpDir, now: '2026-07-19T14:00:00Z' });
  ok(r.deposited === false && r.reason === 'capture-pairing-invalid', 'broken capture pairing → deposit skipped (not encrypted under a wrong key)');
}

console.log('\noption (b) wiring: model enrichment lands in the deposit, failure never blocks it');
{
  // Transcript has too_long ×2 (regex) + one neutral message the fake model flags
  // as overexplaining — the deposit must carry BOTH, folded through one state apply.
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const captureModel = {
    model: 'fake', modelUrl: 'http://x', timeoutMs: 100,
    call: async (_s, user) => (user.includes('thanks, now the tests')
      ? '{"hits":[{"m":1,"signal":"overexplaining"}]}' : '{"hits":[]}'),
  };
  const res = await runCaptureHook(input, { fetch, pairing, statePath: join(dir, 'model.json'), captureModel, relayBase: 'https://relay.test', now: '2026-07-19T15:00:00Z' });
  ok(res.deposited === true && res.model_added === 1, 'hook reports the model-added hit');
  const { envelope } = JSON.parse(calls[0].opts.body);
  const inner = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(envelope, await Kdf.deriveFpSyncKey(pairKeyBytes))));
  const sigs = inner.data.delta.signals;
  ok(sigs.find((s) => s.field === 'response_length_pref')?.observation_count === 2, 'regex counts intact beside the model hit');
  ok(sigs.find((s) => s.field === 'expertise_level')?.observation_count === 1, 'model-only hit lifted into the deposit');

  // A model that dies mid-call must not cost the deterministic deposit.
  const calls2 = [];
  const fetch2 = async (url, opts) => { calls2.push({ url, opts }); return { ok: true, status: 200 }; };
  const broken = { ...captureModel, call: async () => { throw new Error('endpoint down'); } };
  const res2 = await runCaptureHook(input, { fetch: fetch2, pairing, statePath: join(dir, 'model2.json'), captureModel: broken, relayBase: 'https://relay.test', now: '2026-07-19T15:01:00Z' });
  ok(res2.deposited === true && !res2.model_added, 'model failure → regex-only deposit still lands');
}

// ── isMainModule: the hook must still recognise itself through a symlink ──────
// Regression: the naive `import.meta.url === pathToFileURL(resolve(argv[1])).href`
// idiom returns FALSE whenever the entry path crosses a symlink, because Node
// resolves import.meta.url through links and resolve() does not. On macOS
// os.tmpdir() is exactly such a link (/var/folders → /private/var/folders), which
// made the spawned hook a silent no-op: exit 0, no output, session lost.
console.log('\nisMainModule (symlink-safe script entry)');
{
  const self = fileURLToPath(new URL('./lib/is-main.js', import.meta.url));

  ok(isMainModule(pathToFileURL(self).href, ['node', self]), 'direct path → main');
  ok(isMainModule(pathToFileURL(self).href, ['node', join(dirname(self), '.', 'is-main.js')]), 'unnormalized path → main');
  ok(!isMainModule(pathToFileURL(self).href, ['node', join(dirname(self), 'capture-home.js')]), 'a different file → not main');
  ok(!isMainModule(pathToFileURL(self).href, ['node']), 'no entry point → not main');
  ok(!isMainModule(null, ['node', self]), 'no module url → not main');

  // The real shape of the bug: reach the SAME file through a symlinked directory.
  const linkBase = mkdtempSync(join(tmpdir(), 'phaedo-ismain-'));
  const link = join(linkBase, 'linked');
  symlinkSync(dirname(self), link, 'dir');
  const viaLink = join(link, 'is-main.js');
  ok(realpathSync(viaLink) === realpathSync(self), 'fixture: the symlink really does reach the same file');
  ok(isMainModule(pathToFileURL(self).href, ['node', viaLink]),
     'entry reached through a symlink is STILL recognised as main (the macOS tmpdir regression)');
  // And the naive idiom this replaced would have failed that case — pin the contrast
  // so nobody "simplifies" it back.
  ok(pathToFileURL(resolve(viaLink)).href !== pathToFileURL(self).href,
     'the naive URL comparison would have said not-main here');
  rmSync(linkBase, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ capture hook: ${pass} checks passed`);
