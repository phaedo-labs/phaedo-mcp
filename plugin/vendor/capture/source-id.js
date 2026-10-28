// Phaedo capture — stable per-surface, per-MACHINE source device id.
//
// Resolves open question Q2 of docs/roadmap/desktop-capture-deposit.md. Every capture
// surface tags its deposits with a `source_device_id`; the merge owner's per-source
// idempotent reconcile (replace-that-source's-snapshot, never sum) depends on this id
// being (a) STABLE across process restarts AND pairing changes, and (b) UNIQUE per
// (machine, surface).
//
// The id is derived from a persistent random MACHINE id — NOT the pairing — for two
// reasons the review surfaced:
//   1. Pairing-derived ids CHANGE when the user pairs/re-pairs (or fixes a
//      pairing.capture.json), so everything captured before that transition would be
//      stranded under an orphaned key (unpaired→paired stranding).
//   2. Two machines that export the SAME extension pairing (desktop + laptop, per the
//      runbook) would derive the IDENTICAL pairing-based id and clobber each other's
//      cumulative snapshots on the owner (replace-per-source under-counts).
// A per-machine uuid persisted once in the state dir is stable across both, and
// distinct per machine — so each machine's snapshot accumulates as its own source.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

function defaultMachineIdPath(env = process.env) {
  const dir = env.PHAEDO_MCP_STATE_DIR || join(homedir(), '.phaedo-mcp');
  return join(dir, 'machine-id');
}

// Read (or first-time create) the persistent per-machine id. Best-effort: if the
// state dir is unwritable we fall back to a process-stable in-memory id (capture still
// works for the session; only cross-restart stability is lost on a read-only FS).
let _memMachineId = null;
export function machineId(env = process.env) {
  const path = defaultMachineIdPath(env);
  try {
    return readFileSync(path, 'utf8').trim() || createAndStore(path);
  } catch {
    return createAndStore(path);
  }
}
function createAndStore(path) {
  const id = randomUUID();
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, id + '\n', 'utf8'); }
  catch { if (!_memMachineId) _memMachineId = randomUUID(); return _memMachineId; }
  return id;
}

// surface — a stable string naming the capture surface, e.g. 'claude-code' or 'a11y-macos'.
// The `pairing` param is kept for signature compatibility with callers but is NO LONGER
// used to derive the id (see the header): the id is per-machine + per-surface.
export function deriveSourceDeviceId(_pairing, surface, env = process.env) {
  const tag = String(surface || 'unknown');
  const digest = createHash('sha256').update(`${machineId(env)} ${tag}`).digest('base64url');
  return `cap_${tag}_${digest.slice(0, 16)}`;
}
