// Phaedo capture — the tier-agnostic spine: exchange_batch → signal delta.
//
// Every capture surface (the Claude Code JSONL hook, the Track B a11y helper, a future
// OCR tier) converges here once it has an exchange_batch (capture/transcript.js or
// capture/exchanges.js). This module runs the shared tail — deterministic Path-A
// detectors (+ optional local-model enrichment) → per-session state fold (resume-safe
// REPLACE) → cumulative delta lift — and returns the source='delta' signals. It does NOT
// touch the network: building + depositing the envelope is the transport layer's job
// (mcp/capture-sync.js), which keeps capture/ deposit-free and lets each surface own its
// pairing resolution. So a new front-end is a batch producer, not a new pipeline.
//
// Pure except the injected state file I/O (capture/state.js), exactly like the hook.

import { accumulateBatchCounts } from './detectors.js';
import { captureModelOpts, enrichCountsWithModel } from './model-detect.js';
import { loadState, saveState, applySession, cumulativeCounts, defaultStatePath } from './state.js';
import { liftDeltaSignals } from '../extraction/delta-lift.js';

// Fold one batch into this surface's cumulative signal delta.
//   batch — an exchange_batch ({ exchanges, user_prompts, session_local_id }).
//   opts:
//     sourceId       — the per-machine+surface source_device_id (capture/source-id.js).
//     surface        — surface tag echoed into the result (e.g. 'a11y-macos').
//     statePath      — durable per-surface state file (default: state.js defaultStatePath).
//     sessionLocalId — STABLE per-conversation id → per-session REPLACE (idempotent re-reads).
//     now            — ISO timestamp (fixed for deterministic tests).
//     captureModel   — option (b) model opts, or undefined to auto-resolve from env; falsy = off.
//     env            — process.env (for captureModelOpts auto-resolution).
// Returns { signals, counts, modelAdded, sourceId, surface } — never throws on a bad
// batch (empty → zero signals); state I/O failures are swallowed (counters just restart).
export async function foldBatchToSignals(batch, opts = {}) {
  const statePath = opts.statePath || defaultStatePath();
  const nowIso = opts.now || new Date().toISOString();
  const sourceId = opts.sourceId || null;
  const sessionLocalId = opts.sessionLocalId || (batch && batch.session_local_id) || null;

  const exchanges = (batch && batch.exchanges) || [];
  const prompts = (batch && Array.isArray(batch.user_prompts)) ? batch.user_prompts : exchanges;
  if (!prompts.length) return { signals: [], counts: null, modelAdded: 0, sourceId, surface: opts.surface || null };

  let counts = accumulateBatchCounts(batch);

  // Option (b): fold local-model classifications of the regex-MISS user messages into
  // this session's counts BEFORE the state apply, so re-reads stay resume-safe and the
  // deposit stays pure delta. Opt-in + fail-safe (any error leaves regex counts intact).
  let modelAdded = 0;
  const modelOpts = opts.captureModel !== undefined ? opts.captureModel : captureModelOpts(opts.env);
  if (modelOpts && modelOpts.model) {
    try {
      const enriched = await enrichCountsWithModel(batch, counts, modelOpts);
      counts = enriched.counts;
      modelAdded = enriched.added;
    } catch { /* model down/slow/garbage → regex-only, unchanged */ }
  }

  let state;
  try {
    state = applySession(loadState(statePath), sourceId, sessionLocalId, counts, { now: nowIso });
    try { saveState(statePath, state); } catch { /* state loss just restarts counters — never fatal */ }
  } catch {
    // A corrupt state file must never break capture: fold against an empty baseline.
    state = applySession(null, sourceId, sessionLocalId, counts, { now: nowIso });
  }

  const signals = liftDeltaSignals(cumulativeCounts(state, sourceId).behavioral_signals, nowIso);
  return { signals, counts, modelAdded, sourceId, surface: opts.surface || null };
}
