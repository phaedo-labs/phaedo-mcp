#!/usr/bin/env node
// Stop capture hook (hooks/stop-capture.mjs) — captures a session that is still open,
// throttled per session; repeated captures of one session never double-count.
// Run: node test-stop-capture.mjs

import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runStopHook, isDue, intervalMs, defaultThrottlePath, DEFAULT_INTERVAL_MIN } from './hooks/stop-capture.mjs';
import { runCaptureHook } from './hooks/session-end.mjs';
import { loadState, cumulativeCounts } from '../capture/state.js';
import { deriveSourceDeviceId } from '../capture/source-id.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const HERE = dirname(fileURLToPath(import.meta.url));

delete process.env.PHAEDO_CAPTURE_MODEL;   // hermetic: no real local model call
const dir = mkdtempSync(join(tmpdir(), 'phaedo-stop-'));
process.env.PHAEDO_MCP_STATE_DIR = dir;

const MIN = 60 * 1000;
// Pinned clock — every time below is derived from this, never from Date.now(), so the
// suite reads the same under the +400-day future clock (scripts/lib/future-clock.cjs).
const T0 = Date.parse('2026-10-20T12:00:00Z');

console.log('\nthrottle: isDue / interval');
{
  const W = 15 * MIN;
  ok(isDue({}, 's1', T0, W), 'never captured → due');
  ok(!isDue({ s1: T0 - 5 * MIN }, 's1', T0, W), 'captured 5 min ago → not due');
  ok(isDue({ s1: T0 - 15 * MIN }, 's1', T0, W), 'window elapsed → due');
  ok(isDue({ s1: T0 - 5 * MIN }, 's2', T0, W), 'another session is independent');
  ok(isDue({ s1: T0 + 60 * MIN }, 's1', T0, W), 'stamp in the future (clock moved back) → due, never stuck');
  ok(isDue({ s1: 'garbage' }, 's1', T0, W), 'unreadable stamp → due');
  ok(intervalMs({}) === DEFAULT_INTERVAL_MIN * MIN, `default window ${DEFAULT_INTERVAL_MIN} min`);
  ok(intervalMs({ PHAEDO_CAPTURE_INTERVAL_MIN: '5' }) === 5 * MIN, 'PHAEDO_CAPTURE_INTERVAL_MIN overrides');
  ok(intervalMs({ PHAEDO_CAPTURE_INTERVAL_MIN: '0' }) === DEFAULT_INTERVAL_MIN * MIN, 'a 0 / nonsense override falls back (no capture-every-turn)');
  ok(defaultThrottlePath({ PHAEDO_MCP_STATE_DIR: '/x' }) === join('/x', 'capture-throttle.json'), 'throttle file lives in the state dir');
}

console.log('\nrunStopHook: at most one capture per session per window');
{
  const throttlePath = join(dir, 'throttle-a.json');
  const spawned = [];
  const spawn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  // The transcript path deliberately does not exist: the Stop hook must never read it.
  const input = { session_id: 'sess-A', transcript_path: join(dir, 'never-read.jsonl'), hook_event_name: 'Stop' };
  const deps = { throttlePath, spawn, windowMs: 15 * MIN };

  const r1 = runStopHook(input, { ...deps, now: T0 });
  ok(r1.spawned && spawned.length === 1, 'first Stop → capture launched');
  const sp = spawned[0];
  ok(sp.args[0].endsWith('session-end.mjs'), 'launches the SessionEnd capture script');
  ok(sp.opts.detached === true && sp.opts.stdio === 'ignore', 'detached, no inherited stdio → the turn never waits on it');
  const handed = JSON.parse(sp.opts.env.PHAEDO_CAPTURE_INPUT);
  ok(handed.session_id === 'sess-A' && handed.transcript_path === input.transcript_path, 'input handed over via PHAEDO_CAPTURE_INPUT');
  ok(Object.keys(handed).sort().join() === 'hook_event_name,session_id,transcript_path', 'only ids + path cross over — nothing else from the hook input');

  ok(runStopHook(input, { ...deps, now: T0 + 1 * MIN }).reason === 'throttled', 'Stop 1 min later → throttled');
  ok(runStopHook(input, { ...deps, now: T0 + 14 * MIN }).reason === 'throttled', 'Stop 14 min later → throttled');
  ok(spawned.length === 1, 'still exactly one capture inside the window');
  ok(runStopHook({ ...input, session_id: 'sess-B' }, { ...deps, now: T0 + 2 * MIN }).spawned, 'a different open session captures on its own schedule');
  ok(runStopHook(input, { ...deps, now: T0 + 15 * MIN }).spawned, 'window elapsed → captures again');
  ok(spawned.length === 3, 'three captures total: A, B, A');

  const t = JSON.parse(readFileSync(throttlePath, 'utf8'));
  ok(t['sess-A'] === T0 + 15 * MIN && t['sess-B'] === T0 + 2 * MIN, 'throttle file holds the last capture per session');
  // Week-old stamps are pruned on the next write, so the file stays tiny.
  runStopHook({ ...input, session_id: 'sess-C' }, { ...deps, now: T0 + 8 * 86400 * 1000 });
  const t2 = JSON.parse(readFileSync(throttlePath, 'utf8'));
  ok(Object.keys(t2).join() === 'sess-C', 'stamps older than 7 days pruned');
}

console.log('\nrunStopHook: fail-safe');
{
  const spawn = () => { throw new Error('boom'); };
  const res = runStopHook({ session_id: 's', transcript_path: '/x' }, { throttlePath: join(dir, 'throttle-b.json'), spawn, now: T0 });
  ok(res.spawned === false && res.reason === 'error', 'spawn failure → no throw');
  ok(runStopHook({}, { now: T0 }).reason === 'no-session', 'no session id → no-op');
  ok(runStopHook(null, { now: T0 }).reason === 'no-session', 'null input → no-op');
  // A corrupt throttle file means "capture now", and is rewritten clean.
  const tp = join(dir, 'throttle-c.json');
  writeFileSync(tp, '{ not json');
  const spawned = [];
  const r = runStopHook({ session_id: 's', transcript_path: '/x' }, { throttlePath: tp, now: T0, spawn: () => { spawned.push(1); return {}; } });
  ok(r.spawned && JSON.parse(readFileSync(tp, 'utf8')).s === T0, 'corrupt throttle → captures and rewrites the file');
  // An unwritable throttle path must NOT fall through to capturing on every turn.
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'a file, so blocked/… cannot be a directory');
  const spawned2 = [];
  const r2 = runStopHook({ session_id: 's', transcript_path: '/x' }, { throttlePath: join(blocked, 't.json'), now: T0, spawn: () => { spawned2.push(1); return {}; } });
  ok(!r2.spawned && spawned2.length === 0, 'throttle cannot be claimed → no capture (never every-turn)');
}

// ── idempotence: an open session captured repeatedly counts ONCE ─────────────
const L = (o) => JSON.stringify(o);
const turn = (i, text) => [
  L({ type: 'user', uuid: `u${i}`, timestamp: `2026-10-20T10:0${i}:00Z`, sessionId: 'sess-open', message: { role: 'user', content: text } }),
  L({ type: 'assistant', uuid: `a${i}`, sessionId: 'sess-open', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
];
const tooLong = (state) => {
  const c = cumulativeCounts(state, deriveSourceDeviceId(null, 'claude-code'));
  return { msgs: c.message_count, n: Object.values(c.behavioral_signals).reduce((a, l) => a + Object.values(l).reduce((x, y) => x + y, 0), 0) };
};

console.log('\nidempotence: Stop, Stop, SessionEnd on one session = one contribution');
{
  const statePath = join(dir, 'idem-state.json');
  const tPath = join(dir, 'sess-open.jsonl');
  const capture = (now) => runCaptureHook({ session_id: 'sess-open', transcript_path: tPath }, { statePath, pairing: null, now });

  writeFileSync(tPath, [...turn(1, 'this is too long, cut it down'), ...turn(2, 'thanks, now the tests')].join('\n'));
  await capture('2026-10-20T10:03:00Z');
  const first = tooLong(loadState(statePath));
  await capture('2026-10-20T10:20:00Z');   // a second Stop, same transcript
  const again = tooLong(loadState(statePath));
  ok(first.msgs === 2 && first.n === 1, 'first capture: 2 messages, 1 correction');
  ok(again.msgs === first.msgs && again.n === first.n, 're-capturing the same transcript changes nothing (no double count)');

  // The session keeps going; the next capture REPLACES, it does not add.
  writeFileSync(tPath, [...turn(1, 'this is too long, cut it down'), ...turn(2, 'thanks, now the tests'), ...turn(3, 'still too verbose, be concise')].join('\n'));
  await capture('2026-10-20T10:40:00Z');
  const grown = tooLong(loadState(statePath));
  ok(grown.msgs === 3 && grown.n === 2, 'grown transcript: totals are the session as it now stands (3 msgs, 2 corrections), not 2+3');
  await capture('2026-10-20T11:00:00Z');   // SessionEnd at last
  const ended = tooLong(loadState(statePath));
  ok(ended.msgs === 3 && ended.n === 2, 'SessionEnd after Stops → still one contribution');
  const surf = loadState(statePath).surfaces[deriveSourceDeviceId(null, 'claude-code')];
  ok(Object.keys(surf.sessions).length === 1, 'one session entry in the state');
}

// ── end to end: the real script, spawned the way Claude Code runs it ─────────
console.log('\nend to end: Stop hook → detached capture → capture-state.json');
{
  const e2e = mkdtempSync(join(tmpdir(), 'phaedo-stop-e2e-'));
  const tPath = join(e2e, 'sess-e2e.jsonl');
  writeFileSync(tPath, [...turn(1, 'this is too long, cut it down'), ...turn(2, 'thanks')].join('\n'));
  // PHAEDO_CAPTURE_PAIRING at a missing file → the capture saves state but never deposits,
  // so this test can't reach a real relay even on a paired dev machine.
  const env = { ...process.env, PHAEDO_MCP_STATE_DIR: e2e, PHAEDO_CAPTURE_PAIRING: join(e2e, 'no-pairing.json') };
  delete env.PHAEDO_CAPTURE_INPUT;
  const stdin = JSON.stringify({ session_id: 'sess-e2e', transcript_path: tPath, hook_event_name: 'Stop', stop_hook_active: false });
  const hook = join(HERE, 'hooks', 'stop-capture.mjs');
  const started = Date.now();
  const r = spawnSync(process.execPath, [hook], { input: stdin, env, encoding: 'utf8', timeout: 10000 });
  const took = Date.now() - started;
  ok(r.status === 0 && r.stdout === '', 'exits 0 with NO stdout (a Stop hook that prints can block the turn)');
  ok(took < 1500, `the hook returns without waiting for the capture (${took} ms)`);

  const statePath = join(e2e, 'capture-state.json');
  const deadline = Date.now() + 10000;
  while (!existsSync(statePath) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  ok(existsSync(statePath), 'the detached capture wrote capture-state.json');
  const st = loadState(statePath);
  const surf = Object.entries(st.surfaces).find(([id]) => id.startsWith('cap_claude-code'));
  ok(surf && surf[1].sessions['sess-e2e']?.counts?.message_count === 2, 'the open session is recorded under claude-code');

  // Second Stop inside the window: throttled — no new capture.
  const before = readFileSync(statePath, 'utf8');
  const r2 = spawnSync(process.execPath, [hook], { input: stdin, env, encoding: 'utf8', timeout: 10000 });
  await new Promise((res) => setTimeout(res, 300));
  ok(r2.status === 0 && readFileSync(statePath, 'utf8') === before, 'second Stop inside the window → nothing rewritten');
  rmSync(e2e, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ stop capture hook: ${pass} checks passed`);
