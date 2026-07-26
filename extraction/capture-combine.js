// Phaedo capture — cross-surface delta combination (the owner-side merge core).
//
// A capture surface (the Claude Code hook, later the a11y helper) deposits its
// CUMULATIVE Path-A counters as lifted source='delta' signals. The owner must
// fold those in so that counts ACCUMULATE ACROSS SURFACES — web too_long ×11 +
// claude-code too_long ×2 must merge to ×13 — but reconcile's delta semantics
// are replace-by-key (a delta signal is a snapshot, mergeSignal replaces it
// wholesale). Feeding a surface's signals straight into reconcile would therefore
// CLOBBER the web-accumulated counts with the (smaller) surface counts.
//
// The fix is to combine BEFORE reconcile, from first-party inputs only:
//   - the extension's OWN lift (from its raw phaedo_behavioral_signals counters —
//     never from counts already stored in the fingerprint, which are themselves
//     combined and would double-count on re-merge), plus
//   - each capture source's latest snapshot (vault `phaedo_capture_sources`,
//     replaced per source_device_id on drain — idempotent).
// The combined signal (summed observation_count, confidence recomputed from the
// total) then flows through the existing replace-by-key reconcile unchanged, so
// stored shape, rendering, and §4.7 resolution are untouched.
//
// Every delta-writing merge path MUST pass captureSources (background.js does,
// for both the extract path and the drain path) — a path that skips it would
// replace the combined count with an own-only count on its next write.

import { countConfidence } from './delta-lift.js';
import { buildFingerprintUpdate } from './fingerprint-update.js';
import { valKey } from './resolve.js';

// Identity of one underlying counter across surfaces. Same counter name → same
// (layer, field, polarity, value[, domain]) via SIGNAL_MAP on every surface, so
// value is part of the key (too_long/'short' vs too_short/'thorough' share
// field+polarity but are different counters and must NOT merge).
const combineKey = (s) =>
  `${s.layer}::${s.field}::${s.polarity}::${valKey(s.value)}${typeof s.domain === 'string' ? `::${s.domain}` : ''}`;

// The dimension key WITHOUT the value — this is exactly reconcile.js sigKey. Two delta
// signals that share it but differ in value (too_long/'short' vs too_short/'thorough',
// same field+positive polarity) are OPPOSING counters that reconcile would collapse
// (mergeSignal's delta branch replaces wholesale on key match), keeping whichever is
// enumerated last. See the majority-resolution pass in combineDeltaSignals.
const dimKey = (s) =>
  `${s.layer}::${s.field}::${s.polarity}${typeof s.domain === 'string' ? `::${s.domain}` : ''}`;

// Combine the extension's own lifted delta signals with capture-source snapshots.
// Returns one delta signal per RECONCILE DIMENSION (field, polarity[, domain]) with
// observation_count = Σ of that value's counters across surfaces, and — when opposing
// values collide on a dimension — only the MAJORITY value survives. Non-delta signals
// must not be passed here (callers strip; applyCaptureSources below does it).
export function combineDeltaSignals(ownSignals, sources, now) {
  // Pass 1: sum each distinct counter (value included) across surfaces.
  const byKey = new Map();
  const fold = (sig) => {
    if (!sig || sig.source !== 'delta') return;
    const k = combineKey(sig);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...sig, session_refs: [] }); return; }
    const total = (prev.observation_count || 0) + (sig.observation_count || 0);
    byKey.set(k, {
      ...prev,
      observation_count: total,
      confidence: countConfidence(total),
      last_observed: [prev.last_observed, sig.last_observed].filter(Boolean).sort().pop() || now,
    });
  };
  for (const sig of ownSignals || []) fold(sig);
  for (const src of sources || []) for (const sig of (src && src.signals) || []) fold(sig);

  // Pass 2: resolve opposing values on the same reconcile dimension to the MAJORITY
  // (highest observation_count) — WITHOUT this, reconcile silently keeps the
  // last-enumerated value (deterministically the capture source's minority signal),
  // inverting the fingerprint (web too_long×11 'short' lost to hook too_short×2
  // 'thorough'). Ties and array-valued fields (which reconcile UNIONS, not replaces —
  // formatting_prefs etc.) keep every entry: a tie leaves no majority to assert, and
  // union fields don't collide. Deterministic: higher count wins, then valKey order.
  const byDim = new Map();
  for (const s of byKey.values()) {
    if (Array.isArray(s.value)) { byDim.set(combineKey(s), [s]); continue; } // union field — never collapse
    const dk = dimKey(s);
    const arr = byDim.get(dk) || [];
    arr.push(s);
    byDim.set(dk, arr);
  }
  const out = [];
  for (const arr of byDim.values()) {
    if (arr.length === 1) { out.push(arr[0]); continue; }
    const scalars = arr.filter((s) => !Array.isArray(s.value));
    if (scalars.length <= 1) { out.push(...arr); continue; }
    const max = Math.max(...scalars.map((s) => s.observation_count || 0));
    const top = scalars.filter((s) => (s.observation_count || 0) === max);
    if (top.length > 1) { out.push(...arr); continue; }        // genuine tie → let reconcile keep both (no false majority)
    out.push(top[0]);                                          // majority wins; minority opposing counters dropped from the update
  }
  return out;
}

// ── Per-source snapshot validity + merge (shared by every owner tier) ────────
// A stored snapshot is { surface, captured_at, signals[] } keyed by
// source_device_id. Deposits carry the surface's CUMULATIVE counts, so between
// two snapshots of the same source the newer captured_at strictly supersedes the
// older — replace, never sum. Mirrored on the phone in
// mobile/src/lib/captureSources.js (keep in lockstep — the phone can't import
// this ES module through Metro).

// A snapshot is usable only if it carries at least one source='delta' signal —
// the only kind the combine folds (a future extraction-backend deposit is
// rejected at the drain, background.js mergeCaptureDelta).
export function isValidSnapshot(snap) {
  return !!(snap && typeof snap === 'object' && Array.isArray(snap.signals)
    && snap.signals.some((s) => s && s.source === 'delta'));
}

// Merge an incoming per-source snapshot map (e.g. forwarded by the phone owner in
// its to_ext deposit) into the locally stored one. Per source: missing → take;
// newer captured_at → replace; older/equal-but-different → keep local (cumulative
// counts only grow, so the newer stamp is always the superset). Returns
// { changed, sources } without mutating either input.
export function mergeSourceSnapshots(prior, incoming) {
  const out = { ...(prior || {}) };
  let changed = false;
  for (const [sourceId, snap] of Object.entries(incoming || {})) {
    if (!sourceId || !isValidSnapshot(snap)) continue;
    const cur = out[sourceId];
    if (cur && JSON.stringify(cur) === JSON.stringify(snap)) continue;   // idempotent re-forward
    const curAt = cur && cur.captured_at ? String(cur.captured_at) : '';
    const inAt = snap.captured_at ? String(snap.captured_at) : '';
    if (cur && curAt >= inAt) continue;                                  // stale forward — keep the newer local copy
    out[sourceId] = snap;
    changed = true;
  }
  return { changed, sources: out };
}

// Rewrite an extraction `update` so its delta signals become the cross-surface
// combined set. Pure: strips source='delta' signals out of each layer doc, combines
// them with the capture sources, and folds the combined set back in (as layer docs
// via the same builder the lift path uses). Extraction (non-delta) signals pass
// through untouched. reconcileLayer recomputes per-layer confidence/summary at
// merge time, so concatenating signals into the layer doc is sufficient here.
export function applyCaptureSources(update, sources, now) {
  const own = [];
  const stripped = {};
  for (const [layerId, doc] of Object.entries(update || {})) {
    const signals = Array.isArray(doc.signals) ? doc.signals : [];
    // Signals embedded in a layer doc have no `layer` field (the doc key IS the
    // layer) — re-attach it, or the combine key would never match a source's.
    own.push(...signals.filter((s) => s && s.source === 'delta').map((s) => ({ ...s, layer: s.layer || layerId })));
    stripped[layerId] = { ...doc, signals: signals.filter((s) => !s || s.source !== 'delta') };
  }
  const combined = combineDeltaSignals(own, sources, now);
  if (!combined.length) return stripped;
  const deltaUpdate = buildFingerprintUpdate(combined, { now });
  const out = { ...stripped };
  for (const [layerId, doc] of Object.entries(deltaUpdate)) {
    const base = out[layerId];
    out[layerId] = base
      ? { ...base, signals: [...(base.signals || []), ...(doc.signals || [])] }
      : doc;
  }
  return out;
}
