// Phaedo capture — cumulative per-surface counter state.
//
// delta-lift's idempotency contract requires that a deposited signal's
// observation_count be the surface's CUMULATIVE total (reconcile REPLACES a
// source='delta' signal on key match rather than summing). A hook run is
// per-session, so the hook needs durable local state that accumulates counts
// across sessions — this module is that state.
//
// Resume-safety: Claude Code fires SessionEnd more than once for the same
// session (clear / resume / logout), and each firing re-processes the FULL
// transcript. Counts are therefore stored PER SESSION and REPLACED on
// re-processing (never added), so a resumed session can only update its own
// contribution — no double-count. The cumulative total = baseline + Σ sessions;
// old sessions are evicted into the baseline beyond a cap so the file stays small.
//
// Contains COUNTS ONLY — signal names and integers, never conversation text
// (the discard-raw contract). Plaintext JSON is acceptable at this sensitivity
// (same class as the extension's phaedo_behavioral_signals counters); the state
// file lives in the MCP state dir (default ~/.phaedo-mcp/, 0600-style dir the
// server already uses for its key + cache).

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const VERSION = 1;
const DEFAULT_MAX_SESSIONS = 200;

export function defaultStatePath(env = process.env) {
  const dir = env.PHAEDO_MCP_STATE_DIR || join(homedir(), '.phaedo-mcp');
  return join(dir, 'capture-state.json');
}

export function emptyState() {
  return { version: VERSION, surfaces: {} };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

function emptyCounts() {
  return { behavioral_signals: {}, positive_count: 0, mental_models: {}, message_count: 0 };
}

// counts + counts → counts. Robust to a malformed source (null, wrong shape, string
// counters): a hand-edited or partially-written state file must never throw here — the
// throw happens AFTER saveState in the hook, so it would re-persist the bad entry and
// silently kill capture forever. Non-object sources are skipped; counters are coerced
// to finite numbers (a stray string '7' can't corrupt the sum into '07').
const num = (v) => (Number.isFinite(v) ? v : (Number.isFinite(Number(v)) ? Number(v) : 0));
export function mergeCounts(a, b) {
  const out = emptyCounts();
  for (const src of [a, b]) {
    if (!src || typeof src !== 'object') continue;
    for (const [layer, sigs] of Object.entries(src.behavioral_signals || {})) {
      if (!sigs || typeof sigs !== 'object') continue;
      if (!out.behavioral_signals[layer]) out.behavioral_signals[layer] = {};
      for (const [sig, n] of Object.entries(sigs)) {
        out.behavioral_signals[layer][sig] = (out.behavioral_signals[layer][sig] || 0) + num(n);
      }
    }
    for (const [fw, n] of Object.entries(src.mental_models || {})) {
      out.mental_models[fw] = (out.mental_models[fw] || 0) + num(n);
    }
    out.positive_count += num(src.positive_count);
    out.message_count += num(src.message_count);
  }
  return out;
}

// Record a session's counts for a surface, REPLACING any prior contribution from
// the same sessionId (resume-safe). Evicts oldest sessions into the baseline
// beyond maxSessions. Pure — returns a new state.
//
// Once a session is evicted its counts are frozen into the opaque baseline sum, which
// can't be decomposed — so if that SAME session re-fires (SessionEnd on clear/resume of
// a long-lived session outliving 200 others), re-adding it would DOUBLE-count it
// permanently. We track evicted ids and skip a re-fire of one: its counts stay as
// frozen in baseline (bounded staleness) rather than doubling. The evicted-id list is
// itself capped; an id that ages out of it is doubly-rare to re-fire.
export function applySession(state, sourceId, sessionId, counts, { now, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
  const stamp = now || new Date().toISOString();
  const prev = (state && state.surfaces) || {};
  const surface = prev[sourceId] || { baseline: emptyCounts(), sessions: {}, evicted: [] };
  const sid = String(sessionId || 'unknown');
  const evicted = Array.isArray(surface.evicted) ? surface.evicted.slice() : [];
  // Drop any malformed (null / non-object) session entry from a hand-edited file so the
  // eviction sort below (sessions[x].updated_at) can't throw.
  const priorSessions = {};
  for (const [k, v] of Object.entries(surface.sessions || {})) if (v && typeof v === 'object') priorSessions[k] = v;

  // A re-fire of an already-evicted session: don't re-add (its counts are in baseline).
  if (evicted.includes(sid) && !priorSessions[sid]) {
    return { version: VERSION, surfaces: { ...prev, [sourceId]: { ...surface, sessions: priorSessions, evicted, updated_at: stamp } } };
  }

  const sessions = { ...priorSessions, [sid]: { counts, updated_at: stamp } };

  // Evict oldest (by updated_at) into baseline beyond the cap.
  let baseline = surface.baseline || emptyCounts();
  const ids = Object.keys(sessions);
  if (ids.length > maxSessions) {
    ids.sort((x, y) => String(sessions[x].updated_at).localeCompare(String(sessions[y].updated_at)));
    for (const id of ids.slice(0, ids.length - maxSessions)) {
      baseline = mergeCounts(baseline, sessions[id].counts);
      delete sessions[id];
      if (!evicted.includes(id)) evicted.push(id);
    }
  }
  while (evicted.length > maxSessions) evicted.shift();   // bound the evicted-id list

  return {
    version: VERSION,
    surfaces: { ...prev, [sourceId]: { baseline, sessions, evicted, updated_at: stamp } },
  };
}

// The cumulative counts for a surface: baseline + Σ sessions. This is what the
// hook lifts (observation_count = cumulative total, per delta-lift's contract).
export function cumulativeCounts(state, sourceId) {
  const surface = state && state.surfaces && state.surfaces[sourceId];
  if (!surface) return emptyCounts();
  // Run the baseline through mergeCounts too, so a malformed/hand-edited baseline (null,
  // string counters) is sanitized rather than returned raw. A null/malformed session
  // entry is skipped (mergeCounts ignores a non-object src; guard the `.counts` access).
  let out = mergeCounts(emptyCounts(), surface.baseline);
  for (const s of Object.values(surface.sessions || {})) out = mergeCounts(out, s && s.counts);
  return out;
}

// ── IO (sync — the hook is a short-lived script) ─────────────────────────────

// Missing or corrupt file → empty state (a broken state file must never break a
// session or a capture; it just restarts the counters).
export function loadState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && parsed.version === VERSION && parsed.surfaces) return parsed;
  } catch { /* fall through */ }
  return emptyState();
}

// Atomic: temp file + rename (same pattern as the receipts/auth stores).
export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), 'utf8');
  renameSync(tmp, path);
}
