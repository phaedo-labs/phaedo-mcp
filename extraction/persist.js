// Phaedo Loop 2 extraction — fingerprint persist merge (the CAS-safe contract).
//
// The offscreen pass produces a raw per-layer `update` delta. Merging that delta
// INTO the persistent fingerprint is a read-modify-write, and it MUST run against
// the freshest fingerprint under a lock — otherwise a pass that read the
// fingerprint before it ran will blind-overwrite anything authored in between:
// a subject-endorsed standing_rule, another tab's accumulated signals, or a
// just-dismissed conflict (the extension-CAS lost-update finding).
//
// This module is the PURE core of that merge: reconcile the delta, stage any
// newly-promotable suggested rules, stamp updated_at. The service worker
// (background.js `mergeExtraction`) wraps it in `withVaultLock` against a fresh
// `readVault`, so the whole read → merge → write is atomic. Keeping the merge
// pure makes the race-safety contract node-testable without chrome.

import { reconcileFingerprint } from './reconcile.js';
import { promoteRules } from './rule-promotion.js';
import { applyCaptureSources } from './capture-combine.js';

// Reconcile `update` into `fingerprint` and return the next fingerprint. Never
// mutates the input. reconcile merges layer signals accumulatively and upserts
// conflict_records (dismissals stay sticky); promoteRules stages suggested_rules
// for established, not-yet-authored D&R patterns (skipping dimensions the subject
// already authored). Because both are pure and merge — rather than replace — the
// current fingerprint, running them on a FRESH read is the whole lost-update fix.
//
// `captureSources` (optional): the vault's per-surface capture snapshots
// (phaedo_capture_sources values). When present, the update's delta signals are
// replaced by the CROSS-SURFACE combined set before reconcile (capture-combine.js)
// — otherwise a delta write from one surface would clobber the accumulated counts
// of the others (delta reconcile is replace-by-key). Callers that hold a vault
// with capture sources MUST pass them on every delta-writing merge.
export function mergeExtractionInto(fingerprint, update, now = new Date().toISOString(), captureSources = null) {
  const effective = (Array.isArray(captureSources) && captureSources.length)
    ? applyCaptureSources(update, captureSources, now)
    : update;
  const merged = promoteRules(reconcileFingerprint(fingerprint || {}, effective, { now }), { now });
  merged.updated_at = now;    // bump for sync last-write-wins
  return merged;
}
