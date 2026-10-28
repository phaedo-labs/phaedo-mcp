#!/usr/bin/env node
// Phaedo — Claude Code Stop hook: capture a session that is still OPEN.
//
// The SessionEnd hook (session-end.mjs) only runs when a session ends, and the
// Claude desktop app keeps sessions open for days — measured 2026-10-20, no Claude
// Code session had been captured since 2026-09-20 although ~39 had happened. Stop
// fires at the end of every assistant turn, so this hook re-runs the SAME capture on
// the live transcript, at most once per session per CAPTURE_INTERVAL_MIN.
//
// That is safe to repeat: capture/state.js applySession REPLACES a session's counts
// (never adds), so capturing a session at turn 10, turn 40 and again at SessionEnd
// leaves exactly one contribution — the latest. The relay deposit is a cumulative
// snapshot (delta-lift), so a later deposit supersedes an earlier one.
//
// Cost on the common path (inside the window): read one small JSON file, exit. No
// transcript read, no capture modules loaded. When a capture IS due, the window is
// claimed first and the capture runs in a DETACHED child (session-end.mjs, input via
// PHAEDO_CAPTURE_INPUT) — the turn never waits for the transcript parse or the relay.
//
// FAIL-SAFE: any error exits 0 with NO output. Stop hooks can block a turn from
// ending by printing a decision — this one never prints anything.
//
// Wired by `npm run setup:code-hook` beside SessionStart/SessionEnd, or by hand in
// ~/.claude/settings.json:
//   { "hooks": { "Stop": [ { "hooks": [
//       { "type": "command", "command": "<node> <abs path to this file>" }
//   ] } ] } }

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main.js';

const CAPTURE_HOOK_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'session-end.mjs');
export const DEFAULT_INTERVAL_MIN = 15;
// Throttle entries older than this are dropped on write, so the file stays a few lines.
const KEEP_MS = 7 * 86400 * 1000;
// The whole hook is a file read + maybe a spawn; never hold a turn longer than this.
const BUDGET_MS = 2000;

// Same directory capture/state.js uses (defaultStatePath) — inlined so the common
// path loads nothing from the capture stack.
export function defaultThrottlePath(env = process.env) {
  return join(env.PHAEDO_MCP_STATE_DIR || join(homedir(), '.phaedo-mcp'), 'capture-throttle.json');
}

export function intervalMs(env = process.env) {
  const min = Number(env.PHAEDO_CAPTURE_INTERVAL_MIN);
  return (Number.isFinite(min) && min >= 1 ? min : DEFAULT_INTERVAL_MIN) * 60 * 1000;
}

// Missing or corrupt → {} (a broken throttle file means "capture now", never "never").
function loadThrottle(path) {
  try {
    const t = JSON.parse(readFileSync(path, 'utf8'));
    return t && typeof t === 'object' && !Array.isArray(t) ? t : {};
  } catch { return {}; }
}

// Due unless this session was captured within the window. A stamp in the FUTURE
// (clock moved back) counts as due — a bad clock must not silence capture.
export function isDue(throttle, sessionId, nowMs, windowMs) {
  const last = Number(throttle[sessionId]);
  if (!Number.isFinite(last)) return true;
  return !(last <= nowMs && nowMs - last < windowMs);
}

// Two sessions stopping at the same instant can each overwrite the other's stamp;
// the loser just captures again on its next Stop (harmless — capture is idempotent).
function saveThrottle(path, throttle, sessionId, nowMs) {
  const next = {};
  for (const [id, at] of Object.entries(throttle)) {
    if (Number.isFinite(Number(at)) && nowMs - Number(at) < KEEP_MS && Number(at) <= nowMs) next[id] = Number(at);
  }
  next[sessionId] = nowMs;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next) + '\n', 'utf8');
  renameSync(tmp, path);
}

// Launch session-end.mjs detached, so it outlives this hook and the turn ends now.
function spawnCapture(input, { spawn = nodeSpawn, hookPath = CAPTURE_HOOK_PATH, env = process.env } = {}) {
  const child = spawn(process.execPath, [hookPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...env, PHAEDO_CAPTURE_INPUT: JSON.stringify(input) },
  });
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (child && typeof child.unref === 'function') child.unref();
}

// The Stop pass, dependency-injectable for tests.
//   input — the hook's stdin JSON ({ session_id, transcript_path, ... }).
//   deps  — { now (ms), throttlePath, windowMs, spawn, hookPath, env }.
// Returns { spawned, reason } (never throws).
export function runStopHook(input, deps = {}) {
  try {
    const env = deps.env || process.env;
    const sessionId = input && input.session_id;
    const transcriptPath = input && input.transcript_path;
    if (!sessionId || !transcriptPath) return { spawned: false, reason: 'no-session' };
    const nowMs = deps.now !== undefined ? deps.now : Date.now();
    const path = deps.throttlePath || defaultThrottlePath(env);
    const windowMs = deps.windowMs || intervalMs(env);
    const throttle = loadThrottle(path);
    if (!isDue(throttle, sessionId, nowMs, windowMs)) return { spawned: false, reason: 'throttled' };
    // Claim the window BEFORE spawning: a second Stop a moment later must not start a
    // second capture. If the claim can't be written, don't capture either — otherwise
    // an unwritable state dir would mean a full capture on every turn.
    saveThrottle(path, throttle, sessionId, nowMs);
    spawnCapture({ session_id: sessionId, transcript_path: transcriptPath, hook_event_name: 'Stop' },
      { spawn: deps.spawn, hookPath: deps.hookPath, env });
    return { spawned: true, reason: 'due' };
  } catch {
    return { spawned: false, reason: 'error' };
  }
}

// ── script entry (Claude Code invokes this file directly) ────────────────────
if (isMainModule(import.meta.url)) {
  const readStdin = () => new Promise((res) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(''));
  });
  const run = async () => {
    let input = {};
    try { input = JSON.parse(await readStdin()); } catch { /* no/bad input → no-op */ }
    runStopHook(input);
  };
  const timeout = new Promise((res) => setTimeout(res, BUDGET_MS));
  Promise.race([run().catch(() => {}), timeout])
    .then(() => process.exit(0))
    .catch(() => process.exit(0)); // a hook must never break the session
}
