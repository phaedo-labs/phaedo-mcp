#!/usr/bin/env node
// Phaedo — Claude Code SessionEnd capture hook (Track A, option (a)).
//
// Claude Code runs this when a session ends, passing hook input on stdin
// ({ session_id, transcript_path, ... }). The hook:
//   1. reads the session transcript JSONL (local file, never leaves the machine),
//   2. parses it to an exchange_batch (capture/transcript.js),
//   3. runs the deterministic Path-A detectors over the user messages
//      (capture/detectors.js — the parity-tested mirror of the extension's tables),
//      optionally enriched by a LOCAL model classifying the regex-miss messages
//      against the same taxonomy (capture/model-detect.js, option (b) — opt-in
//      via PHAEDO_CAPTURE_MODEL, e.g. `llama3.1:8b` on Ollama; fail-safe),
//   4. folds this session's counts into the durable per-surface state, REPLACING
//      any prior contribution from the same session (capture/state.js — resume-safe),
//   5. lifts the CUMULATIVE counters into source='delta' §5.1 signals
//      (extraction/delta-lift.js — idempotent snapshot semantics), and
//   6. deposits the signal delta to the relay's capture_to_owner lane
//      (mcp/capture-sync.js — ciphertext under fp_sync_key, best-effort).
//
// The raw transcript is read, counted, and DISCARDED — nothing derived from it
// but signal names + integers is ever persisted or transmitted (the discard-raw
// contract). Wire it up with `npm run setup:code-hook` (installs SessionStart
// injection + this SessionEnd capture together), or by hand in
// ~/.claude/settings.json:
//   { "hooks": { "SessionEnd": [ { "hooks": [
//       { "type": "command", "command": "<node> <abs path to this file>" }
//   ] } ] } }
//
// FAIL-SAFE: any error (no transcript, unpaired, relay down, corrupt state)
// exits 0 with NO output — capture must never break or slow a session's end.
// Unpaired machines still accumulate local state; deposits begin once paired.
//
// Packaging note: the capture/extraction modules load via lib/capture-home.js —
// repo root in the dev clone, mcp/vendor/ in the published npm tarball
// (build-package.mjs vendors the whole closure; test-vendored-capture.mjs proves
// the rootless layout works).

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadCaptureModule } from '../lib/capture-home.js';
import { isMainModule } from '../lib/is-main.js';
import { loadPairingRecord } from '../phone-source.js';
import { buildCaptureDelta, depositCaptureDelta } from '../capture-sync.js';

// The capture stack loads through lib/capture-home.js so this hook runs BOTH
// from the dev clone (repo-root sources) and from the published npm tarball
// (build-package.mjs vendors them under mcp/vendor/). Top-level await: the
// install gate (install.mjs captureHookAvailable) guarantees these resolve
// wherever the hook is actually wired.
const [
  { transcriptToBatch },
  { accumulateBatchCounts },
  { captureModelOpts, enrichCountsWithModel },
  { deriveSourceDeviceId },
  { defaultStatePath, loadState, saveState, applySession, cumulativeCounts },
  { liftDeltaSignals },
] = await Promise.all([
  'capture/transcript.js',
  'capture/detectors.js',
  'capture/model-detect.js',
  'capture/source-id.js',
  'capture/state.js',
  'extraction/delta-lift.js',
].map(loadCaptureModule));

const MCP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACE = 'claude-code';
// Option (b): with a local capture model configured — env var OR the
// capture-model.json the installer writes — allow headroom for one
// classification call (its own 15s timeout) on top of the deterministic pass.
// Without one, the original tight budget stands.
const BUDGET_MS = captureModelOpts(process.env).model ? 30000 : 10000;
// Cap the transcript bytes we read+parse. The budget is a setTimeout race, which a
// setTimeout CANNOT preempt while the synchronous read/parse runs — so a huge transcript
// (long agentic sessions accumulate tool_result blobs) would block session-end past
// BUDGET_MS regardless. Recent behavior lives at the END of an append-only log, so on an
// oversized file we read only the last MAX_READ_BYTES and start parsing at the first
// whole line. 24 MB ≈ well under 100ms to parse — comfortably inside the budget.
const MAX_READ_BYTES = 24 * 1024 * 1024;

// Read the whole file, or just its tail when it exceeds MAX_READ_BYTES (dropping the
// leading partial line). Returns '' on any IO error (caller treats as unreadable).
function readTranscriptCapped(path) {
  let size;
  try { size = statSync(path).size; } catch { return readFileSync(path, 'utf8'); }
  if (size <= MAX_READ_BYTES) return readFileSync(path, 'utf8');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(MAX_READ_BYTES);
    readSync(fd, buf, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : text;   // drop the partial first line
  } finally { closeSync(fd); }
}

// ── Capture pairing (whose key encrypts the deposit) ─────────────────────────
// The capture_to_owner envelope must be decryptable by the DRAINING owner. The
// PHONE is the tier-1 owner and its drain is BUILT (fpSync.drainCapture): it
// holds every client's pair_key and tries each until one decrypts, so the plain
// <mcp>/pairing.json — whatever pairing this machine rides — is the right
// default. The pairing.capture.json export (the extension's phaedo_local_pairing,
// copied by hand so the EXTENSION could decrypt) is RETIRED as a requirement:
// it remains a supported override for a phone app that predates the drain, or
// to pin the key explicitly. Resolution order:
//   1. PHAEDO_CAPTURE_PAIRING (explicit path)
//   2. <mcp>/pairing.capture.json — legacy/override (gitignored); delete it once
//      the phone build with drainCapture is installed
//   3. <mcp>/pairing.json — the default
// Needs pair_key + relay_device_id (+ relay_device_secret for relay auth).
export class CapturePairingError extends Error {}

// Returns a valid capture pairing record, or null when NO capture pairing is
// configured (caller may fall back to mcp/pairing.json). THROWS CapturePairingError
// when a capture-pairing file is PRESENT but broken (unparseable, or missing
// pair_key/relay_device_id): silently falling back to a DIFFERENT pairing would
// encrypt every deposit under the wrong key to the wrong relay slot — the exact
// live-test failure the override exists to prevent, reinstated by a typo. The caller
// must skip the deposit instead. A record lacking relay_device_secret is returned but
// warned about (its deposits will 401 until the user re-pairs).
export function loadCapturePairing(mcpDir, env = process.env, warn = (m) => process.stderr.write(`[phaedo capture] ${m}\n`)) {
  const candidates = [
    { path: env.PHAEDO_CAPTURE_PAIRING && resolve(process.cwd(), env.PHAEDO_CAPTURE_PAIRING), explicit: true },
    { path: resolve(mcpDir, 'pairing.capture.json'), explicit: false },
  ].filter((c) => c.path);
  for (const { path, explicit } of candidates) {
    if (!existsSync(path)) {
      if (explicit) throw new CapturePairingError(`PHAEDO_CAPTURE_PAIRING points at a missing file: ${path} — not depositing (would use the wrong key).`);
      continue;
    }
    let rec;
    try { rec = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { throw new CapturePairingError(`capture pairing ${path} is not valid JSON (${e.message}) — not depositing (would use the wrong key). Re-export the extension's pairing.`); }
    if (!rec || !rec.pair_key || !rec.relay_device_id) {
      throw new CapturePairingError(`capture pairing ${path} is missing pair_key/relay_device_id — not depositing (would use the wrong key). Re-export the extension's pairing.`);
    }
    if (!rec.relay_device_secret) warn(`capture pairing ${path} has no relay_device_secret — deposits will 401 until you re-pair the extension.`);
    return rec;
  }
  return null;
}

// The full capture pass, dependency-injectable for tests.
//   input — the hook's stdin JSON ({ session_id, transcript_path, ... }).
//   deps  — { readFile, statePath, pairing, fetch, relayBase, now, mcpDir }.
// Returns a result record (never throws).
export async function runCaptureHook(input, deps = {}) {
  const read = deps.readFile || readTranscriptCapped;
  const statePath = deps.statePath || defaultStatePath();
  const nowIso = deps.now || new Date().toISOString();

  const transcriptPath = input && input.transcript_path;
  if (!transcriptPath) return { deposited: false, reason: 'no-transcript-path' };
  let text;
  try { text = read(transcriptPath); } catch { return { deposited: false, reason: 'transcript-unreadable' }; }

  const batch = transcriptToBatch(text, { sessionId: input.session_id });
  if (!batch.exchanges.length) return { deposited: false, reason: 'no-exchanges' };
  let counts = accumulateBatchCounts(batch);

  // Option (b) — model-backed detector enrichment (capture/model-detect.js):
  // classify the regex-MISS messages against the same correction taxonomy and
  // fold the hits into this session's counts BEFORE the per-session-replace
  // state apply, so re-fires stay resume-safe and the deposit stays pure delta.
  // Opt-in (PHAEDO_CAPTURE_MODEL env, or the installer-written
  // capture-model.json); any failure leaves the regex counts intact.
  let modelAdded = 0;
  const modelOpts = deps.captureModel !== undefined ? deps.captureModel : captureModelOpts(deps.env);
  if (modelOpts && modelOpts.model) {
    const enriched = await enrichCountsWithModel(batch, counts, modelOpts);
    counts = enriched.counts;
    modelAdded = enriched.added;
  }

  // Pairing is optional: without one we still accumulate state locally (the
  // mcp-local owner tier can read it); the deposit just no-ops as 'unpaired'.
  // A capture-specific pairing (the extension's, exported) wins over the MCP's
  // own pairing.json so the draining owner can actually decrypt the deposit.
  let pairing = deps.pairing;
  if (pairing === undefined) {
    try {
      pairing = loadCapturePairing(deps.mcpDir || MCP_DIR, deps.env);
    } catch (e) {
      // A capture-pairing file exists but is broken: do NOT fall back to a different
      // key (that silently deposits to the wrong slot). Accumulate state, skip deposit.
      if (!(e instanceof CapturePairingError)) throw e;
      process.stderr.write(`[phaedo capture] ${e.message}\n`);
      const sourceId0 = deriveSourceDeviceId(null, SURFACE);
      const st = applySession(loadState(statePath), sourceId0, batch.session_local_id || input.session_id, counts, { now: nowIso });
      try { saveState(statePath, st); } catch { /* non-fatal */ }
      return { deposited: false, reason: 'capture-pairing-invalid', counted: counts.message_count };
    }
    if (!pairing) {
      try { pairing = await loadPairingRecord(deps.mcpDir || MCP_DIR); } catch { pairing = null; }
    }
  }
  const sourceId = deriveSourceDeviceId(pairing, SURFACE);

  const state = applySession(loadState(statePath), sourceId, batch.session_local_id || input.session_id, counts, { now: nowIso });
  try { saveState(statePath, state); } catch { /* state loss just restarts counters — never fatal */ }

  const signals = liftDeltaSignals(cumulativeCounts(state, sourceId).behavioral_signals, nowIso);
  if (!signals.length) return { deposited: false, reason: 'no-signal', counted: counts.message_count };

  const delta = buildCaptureDelta(signals, { sourceSurface: SURFACE, sourceDeviceId: sourceId, capturedAt: nowIso });
  // capture-sync's `now` dep is a FUNCTION (envelope created_at); ours is an ISO string.
  const res = await depositCaptureDelta(pairing, delta, { ...deps, now: () => nowIso });
  // Surface a deposit that FAILED for a fixable reason (a 401 = the pairing lost its
  // relay_device_secret; re-pair). 'unpaired'/'no-relay-device-id' are expected
  // local-only states, not worth a warning. Goes to stderr — Claude Code parses only
  // stdout, so this never disturbs the session, but it appears in the hook's error log.
  if (res && res.deposited === false && (res.status === 401 || (res.reason && /^http-/.test(String(res.reason))))) {
    process.stderr.write(`[phaedo capture] deposit rejected (${res.status || res.reason}) — re-pair the extension so capture can sync.\n`);
  }
  return { ...res, counted: counts.message_count, signals: signals.length, ...(modelAdded ? { model_added: modelAdded } : {}) };
}

// ── script entry (Claude Code invokes this file directly) ────────────────────
// Symlink-safe (lib/is-main.js): the naive URL comparison silently returns false
// whenever the hook is reached through a link, turning this hook into a no-op that
// exits 0 and loses the session.
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const readStdin = () => new Promise((res) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(''));
  });
  const run = async () => {
    let input = {};
    try { input = JSON.parse(await readStdin()); } catch { /* no/bad input → no-op */ }
    await runCaptureHook(input);
  };
  const timeout = new Promise((res) => setTimeout(res, BUDGET_MS));
  Promise.race([run().catch(() => {}), timeout])
    .then(() => process.exit(0))
    .catch(() => process.exit(0)); // a hook must never break the session
}
