// The mcp-local merge-owner tier (desktop-capture-deposit.md §4 tier 3).
//
// The phone-less, browser-less desktop/CLI user — the Claude Code developer, the
// audience desktop capture was built FOR — has nobody to drain what their capture
// hook accumulates: no phone to own the capture_to_owner lane, no extension to
// materialize it. But the hook and this server share a machine AND a state dir:
// the hook accumulates cumulative Path-A counters in capture/state.js
// (~/.phaedo-mcp/capture-state.json) even when unpaired. This module folds that
// local state into the fingerprint the server SERVES, at read time:
//
//   - READ-TIME OVERLAY, no persistence. The lift is a cumulative snapshot
//     (delta-lift's idempotency contract), so re-folding on every load converges
//     to the same result — there is nothing to store and no race to manage.
//     The local fingerprint.json is never rewritten; discard-raw holds.
//   - OWNER-GATED. Only when this server is the merge owner per the presence
//     precedence (capture/owner.js): a configured pairing record means a phone
//     owns the lane (its merged fingerprint arrives through the normal pull),
//     so folding again here would double-count the same signal. The caller
//     (fingerprint-source.js) applies this tier only in local, unpaired mode.
//   - WORKS IN THE PUBLISHED PACKAGE. The capture/extraction modules load via
//     lib/capture-home.js (repo root in dev, mcp/vendor/ in the tarball —
//     build-package.mjs vendors the closure). Loading stays dynamic and any
//     import/IO failure still returns the payload unchanged — the fold is an
//     enrichment, never a gate on serving.
//
// Re-broadcast (§5): none needed here. If a phone is paired later, the hook's
// normal capture_to_owner deposits carry the CUMULATIVE counts, so the phone
// inherits this machine's full history on its first drain — and this tier stops
// applying (owner-gated), so nothing forks.

import { loadCaptureModule } from './lib/capture-home.js';

// Build per-source snapshots from the hook's local capture state. Loading stays
// try-wrapped so a broken layout (neither repo root nor vendor/) degrades to
// "no snapshots" instead of failing the serve.
async function localSnapshots(now) {
  let stateMod, liftMod;
  try {
    stateMod = await loadCaptureModule('capture/state.js');
    liftMod = await loadCaptureModule('extraction/delta-lift.js');
  } catch {
    return [];                                   // no capture home in this layout
  }
  const state = stateMod.loadState(stateMod.defaultStatePath());
  const out = [];
  for (const sourceId of Object.keys(state.surfaces || {})) {
    const counts = stateMod.cumulativeCounts(state, sourceId);
    const signals = liftMod.liftDeltaSignals(counts.behavioral_signals, now);
    if (!signals.length) continue;
    const updatedAt = state.surfaces[sourceId] && state.surfaces[sourceId].updated_at;
    out.push({ surface: sourceId, captured_at: updatedAt || now, signals });
  }
  return out;
}

// How many captured sessions the local state holds, across every surface: the live ones plus
// those evicted into the baseline (their counts are still in it). For the starter-profile
// readout only; 0 on any failure — it describes, it never gates.
export async function localCaptureSessionCount() {
  try {
    const stateMod = await loadCaptureModule('capture/state.js');
    const state = stateMod.loadState(stateMod.defaultStatePath());
    let n = 0;
    for (const s of Object.values(state.surfaces || {})) {
      n += Object.keys((s && s.sessions) || {}).length + (Array.isArray(s && s.evicted) ? s.evicted.length : 0);
    }
    return n;
  } catch {
    return 0;
  }
}

// Fold the local capture state into a vault payload's fingerprint and return the
// folded payload (or the input unchanged when there is nothing to fold / the
// modules are unavailable). Pure with respect to the input object.
export async function foldLocalCapture(vaultPayload, { now = new Date().toISOString() } = {}) {
  if (!vaultPayload || typeof vaultPayload !== 'object' || !vaultPayload.phaedo_fingerprint) return vaultPayload;
  try {
    const sources = await localSnapshots(now);
    if (!sources.length) return vaultPayload;
    const { mergeExtractionInto } = await loadCaptureModule('extraction/persist.js');
    // Empty own-update: the server has no counters of its own; the combine builds
    // the delta update entirely from the source snapshots, then the standard
    // reconcile folds it into the fingerprint (creating layers as needed).
    const fp = mergeExtractionInto(vaultPayload.phaedo_fingerprint, {}, now, sources);
    return { ...vaultPayload, phaedo_fingerprint: fp };
  } catch {
    return vaultPayload;                         // enrichment only — never break serving
  }
}

// Is this server the capture merge owner? Thin wrapper over capture/owner.js so
// the precedence lives in exactly one place; an unloadable module (broken
// layout) → not owner (the fold simply doesn't apply).
export async function isLocalCaptureOwner(phonePaired) {
  try {
    const { isOwner } = await loadCaptureModule('capture/owner.js');
    return isOwner('mcp-local', { phonePaired: !!phonePaired, extensionPresent: false });
  } catch {
    return false;
  }
}
