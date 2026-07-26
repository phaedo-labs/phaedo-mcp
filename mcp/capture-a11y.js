#!/usr/bin/env node
// Phaedo — Track B a11y capture core (the Node side of the OS-accessibility helper).
//
// The native macOS helper (capture/spike-a11y-macos → the productized reader) observes a
// chat app's accessibility tree, reconstructs the visible transcript into {role, text}
// turns, and — on a response-complete SETTLE — pipes a JSON payload to THIS process on
// stdin. We convert the turns to the shared exchange_batch (capture/exchanges.js), fold
// them through the SAME spine the Claude Code hook uses (capture/capture-core.js →
// detectors → per-session state → delta lift), and deposit the signal delta to the
// relay's SUB-KEYED capture lane (mcp/capture-sync.js), encrypted under fp_sync_key.
//
// The native front-end does OS work; this owns the pairing + deposit, so the two tiers
// (a11y, later OCR) share one Node pipeline and differ only in how turns are obtained.
//
// DISCARD-RAW: the turns' text is counted and dropped — nothing but signal names +
// integers is persisted or transmitted (architecture/persona-vs-conversation-memory.md).
// FAIL-SAFE: any error exits 0 with no output; unpaired machines still accumulate local
// state (the mcp-local owner tier reads it), the deposit just no-ops.
//
// Payload (one settle = one invocation), stdin JSON:
//   { conversation_id: string,           // STABLE per chat → per-session REPLACE (idempotent)
//     source_surface?: string,           // default 'a11y-macos'
//     captured_at?: string,              // ISO; default now
//     turns: [ { role:'user'|'assistant', text:string, id?, timestamp? }, ... ] }

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadCaptureModule } from './lib/capture-home.js';
import { isMainModule } from './lib/is-main.js';
import { loadPairingRecord } from './phone-source.js';
import { loadCapturePairing, CapturePairingError } from './hooks/session-end.mjs';
import { buildCaptureDelta, depositCaptureDelta } from './capture-sync.js';

const [
  { turnsToBatch },
  { foldBatchToSignals },
  { deriveSourceDeviceId },
] = await Promise.all([
  'capture/exchanges.js',
  'capture/capture-core.js',
  'capture/source-id.js',
].map(loadCaptureModule));

const MCP_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SURFACE = 'a11y-macos';
const BUDGET_MS = 10000;

// Run one a11y capture payload → deposit. Dependency-injectable for tests.
//   payload — the native helper's stdin JSON (see header).
//   deps    — { pairing, statePath, fetch, relayBase, now, mcpDir, env, captureModel }.
// Returns a result record; never throws.
export async function runA11yCapture(payload, deps = {}) {
  const nowIso = deps.now || (payload && payload.captured_at) || new Date().toISOString();
  const surface = (payload && payload.source_surface) || DEFAULT_SURFACE;

  const turns = payload && Array.isArray(payload.turns) ? payload.turns : null;
  if (!turns) return { deposited: false, reason: 'no-turns' };
  const conversationId = (payload && (payload.conversation_id || payload.session_id)) || null;

  const batch = turnsToBatch(turns, { sessionId: conversationId, platform: surface });
  if (!batch.user_prompts.length) return { deposited: false, reason: 'no-exchanges' };

  // Resolve the pairing whose key the draining owner can decrypt (same order as the hook:
  // explicit override / legacy capture-pairing file / the MCP's own pairing.json). A
  // PRESENT-but-broken capture-pairing file must not silently fall back to a different key
  // — accumulate state locally and skip the deposit instead.
  let pairing = deps.pairing;
  if (pairing === undefined) {
    try {
      pairing = loadCapturePairing(deps.mcpDir || MCP_DIR, deps.env);
    } catch (e) {
      if (!(e instanceof CapturePairingError)) throw e;
      process.stderr.write(`[phaedo capture:a11y] ${e.message}\n`);
      const sid0 = deriveSourceDeviceId(null, surface);
      await foldBatchToSignals(batch, { sourceId: sid0, surface, statePath: deps.statePath, sessionLocalId: conversationId, now: nowIso, captureModel: deps.captureModel, env: deps.env });
      return { deposited: false, reason: 'capture-pairing-invalid', counted: batch.user_prompts.length };
    }
    if (!pairing) {
      try { pairing = await loadPairingRecord(deps.mcpDir || MCP_DIR); } catch { pairing = null; }
    }
  }
  const sourceId = deriveSourceDeviceId(pairing, surface);

  const { signals } = await foldBatchToSignals(batch, {
    sourceId, surface, statePath: deps.statePath, sessionLocalId: conversationId,
    now: nowIso, captureModel: deps.captureModel, env: deps.env,
  });
  if (!signals.length) return { deposited: false, reason: 'no-signal', counted: batch.user_prompts.length };

  const delta = buildCaptureDelta(signals, { sourceSurface: surface, sourceDeviceId: sourceId, capturedAt: nowIso });
  const res = await depositCaptureDelta(pairing, delta, { ...deps, now: () => nowIso });
  if (res && res.deposited === false && (res.status === 401 || (res.reason && /^http-/.test(String(res.reason))))) {
    process.stderr.write(`[phaedo capture:a11y] deposit rejected (${res.status || res.reason}) — re-pair so capture can sync.\n`);
  }
  return { ...res, counted: batch.user_prompts.length, signals: signals.length };
}

// ── script entry (the native helper spawns `node capture-a11y.js` and pipes JSON) ──────
const isMain = isMainModule(import.meta.url);   // symlink-safe — see lib/is-main.js
if (isMain) {
  const readStdin = () => new Promise((res) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(''));
  });
  const run = async () => {
    let payload = {};
    try { payload = JSON.parse(await readStdin()); } catch { /* no/bad input → no-op */ }
    await runA11yCapture(payload);
  };
  const timeout = new Promise((res) => setTimeout(res, BUDGET_MS));
  Promise.race([run().catch(() => {}), timeout])
    .then(() => process.exit(0))
    .catch(() => process.exit(0));   // capture must never break the helper
}
