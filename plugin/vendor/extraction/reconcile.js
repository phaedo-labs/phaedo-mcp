// Phaedo Loop 2 extraction — reconciliation (update → fingerprint).
//
// Merges a partial fingerprint update (projection.buildFingerprintUpdate) into
// the stored fingerprint, per extraction-task-spec §6/§7 and §4.3:
//
//   - Signals are keyed by (field, polarity). A new pass either reinforces an
//     existing signal (same key → merge) or adds a new one.
//   - Reinforcement raises confidence (more consistent observations = more
//     likely a stable trait, §7), sums observation_count, unions session_refs,
//     advances last_observed.
//   - Anti-preference precedence (§4.3, §6): when a layer holds both a positive
//     and a negative signal for the same field, the negative (anti-preference)
//     is the effective one. Both are retained for provenance; effectiveSignals()
//     applies the precedence for downstream consumers.
//   - Non-destructive: questionnaire data on a layer (e.g. `responses[]`, the
//     cold-start shape in §2) is preserved. Extraction only writes the §4.2
//     signal-bearing fields. Authored User Configuration (§5) is a sibling
//     artifact extraction never touches.
//
// NUMERIC CALIBRATION IS DEFERRED (§7): the confidence-combine curve and
// contradiction handling below are honest placeholders to be tuned by the eval
// harness once a real model exists. They are monotone and bounded, not claimed
// to be calibrated.

import { renderLayerSummary } from './fingerprint-update.js';
import { resolveDimension, valKey, authoredGovernedKeys } from './resolve.js';
// Per-source ledgers (multi-browser): a classic UMD file, loaded for its side effect and read off
// globalThis so the same file serves the popup's classic scripts, this module and Node.
import '../signal-ledger.js';
const SL = globalThis.PhaedoSignalLedger;

const CONFIDENCE_CAP = 0.95;

// Noisy-OR: independent consistent observations push confidence up, never past
// the cap. Placeholder pending calibration; contradiction-driven *lowering*
// (§7, persona-algorithm "adversarial robustness") is a deferred refinement.
function combineConfidence(a, b) {
  return Math.min(CONFIDENCE_CAP, 1 - (1 - (a ?? 0)) * (1 - (b ?? 0)));
}

function unionArrays(a = [], b = []) {
  return Array.from(new Set([...a, ...b]));
}

// Merge two signal objects with the same (field, polarity) key.
//
// `attr` ({ sourceId, context }, optional): WHO produced this increment. When given, the evidence
// is recorded in the signal's per-source ledger (signal-ledger.js) and the totals are re-derived
// from it, so a second browser's learning ADDS to this one's at sync instead of replacing it.
// Without it (tests, the desktop fold) the behaviour is exactly the pre-ledger accumulate.
function mergeSignal(existing, incoming, now, attr) {
  // Delta signals carry Path A's CUMULATIVE count — a re-lift is a fresh
  // snapshot of the same counters, not new evidence. Replace wholesale so
  // re-running the lift every pass is idempotent (no count/confidence
  // inflation). Keep the stable signal_id.
  if (incoming.source === 'delta') {
    return { ...incoming, signal_id: existing.signal_id || incoming.signal_id };
  }
  if (attr && attr.sourceId && SL && SL.isLedgered(incoming)) {
    return SL.attribute(existing, incoming, attr.sourceId, { now, context: attr.context });
  }
  const observation_count = (existing.observation_count || 1) + (incoming.observation_count || 1);
  // Value merge: arrays union; scalar/enum/string keep the higher-confidence
  // value (a contradiction across passes resolves to the better-supported one).
  let value = existing.value;
  if (Array.isArray(existing.value) && Array.isArray(incoming.value)) {
    value = unionArrays(existing.value, incoming.value);
  } else if ((incoming.confidence ?? 0) > (existing.confidence ?? 0)) {
    value = incoming.value;
  }
  return {
    ...existing,
    // A questionnaire (self-reported) signal that observation now corroborates is
    // no longer "stated only" — adopt the observing source so it counts as
    // learned (and surfaces in the §5b summary). Pure self-report keeps
    // source 'questionnaire' and stays out of the summary.
    source: incoming.source || existing.source,
    value,
    confidence: Number(combineConfidence(existing.confidence, incoming.confidence).toFixed(3)),
    observation_count,
    session_refs: unionArrays(existing.session_refs, incoming.session_refs),
    last_observed: maxIso(existing.last_observed, incoming.last_observed) || now,
  };
}

function maxIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// Dedupe key. Domain-scoped Decision & Risk signals (§4.2.7 optional `domain`)
// reconcile per (field, polarity, domain) so "financial caution" and "writing
// boldness" coexist and reinforce independently; an untagged signal keeps the
// legacy key — fully backward-compatible.
const sigKey = s => `${s.field}::${s.polarity}${typeof s.domain === 'string' ? `::${s.domain}` : ''}`;

// Reconcile one incoming layer doc into an existing layer doc (or undefined).
// Returns a new layer object; does not mutate inputs. `suppress` (optional Set of
// "field"/"field::domain") withholds those dimensions from the rendered summary —
// the §4.7 injection-suppression of an open-conflict dimension. `attr` — see mergeSignal.
export function reconcileLayer(existingLayer, incomingLayer, now, suppress, attr) {
  const base = existingLayer ? { ...existingLayer } : {};
  const existingSignals = Array.isArray(base.signals) ? base.signals : [];
  const byKey = new Map(existingSignals.map(s => [sigKey(s), s]));
  const attributed = !!(attr && attr.sourceId && SL);

  for (const inc of incomingLayer.signals || []) {
    const k = sigKey(inc);
    if (byKey.has(k)) byKey.set(k, mergeSignal(byKey.get(k), inc, now, attr));
    // A NEW signal is attributed too, or the same signal first seen independently on two
    // browsers would carry no ledger on either and merge last-write-wins.
    else byKey.set(k, attributed && SL.isLedgered(inc) ? SL.attribute(null, inc, attr.sourceId, { now, context: attr.context }) : inc);
  }

  const mergedSignals = Array.from(byKey.values());
  return {
    ...base,                       // preserve questionnaire `responses`, `label`, etc.
    layer_version: incomingLayer.layer_version || base.layer_version || '0.1',
    last_updated: now,
    confidence: Number((mergedSignals.reduce((a, s) => a + (s.confidence || 0), 0) /
                        (mergedSignals.length || 1)).toFixed(3)),
    signals: mergedSignals,
    // §5b "Learned from your conversations" should reflect observation, not
    // restate the interview (§5 already renders questionnaire answers). Render
    // only observation-backed signals; pure self-report (source 'questionnaire',
    // never corroborated) stays in signals[] for provenance but is excluded here.
    summary: renderLayerSummary(effectiveSignals(mergedSignals).filter(s => s.source !== 'questionnaire'), suppress),
  };
}

// Apply §4.3/§6 anti-preference precedence: if a field has a negative signal,
// the positive one for that field is suppressed from the effective set (kept in
// storage for provenance, dropped from the rendered/consumed view).
export function effectiveSignals(signals) {
  const negFields = new Set(signals.filter(s => s.polarity === 'negative').map(s => s.field));
  return signals.filter(s => !(s.polarity === 'positive' && negFields.has(s.field)));
}

// ── Conflict records (the update gate's "contradict" outcome) ────────────────
//
// mergeSignal() above collapses same-(field,polarity,domain) signals by confidence,
// so a genuine contradiction — a new OBSERVED value that disagrees with the subject's
// SELF-REPORT while the observed evidence is still thin (< §4.7 floor) — would vanish
// silently. Detect it at the merge moment (both values still visible), classify it
// with the SHARED §4.7 resolver, and stage a durable, reviewable record. This is the
// producer-written `suggested_rules` pattern (Proposal 0007): never injected, never
// consulted — a queue the subject reviews. We do NOT change what is stored or injected
// here (that injection-suppression fix is a separate, behaviour-changing follow-up);
// this only makes the contradiction visible and keeps both sides' provenance.

const uuid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : 'cfl-' + Math.random().toString(36).slice(2, 10);

const conflictKey = (layer, field, domain) =>
  `${layer}::${field}${typeof domain === 'string' ? `::${domain}` : ''}`;

// Compare an incoming layer's signals against the existing ones BEFORE the merge
// collapses them. For each incoming signal that shares a (field,polarity,domain) key
// with an existing one but carries a DIFFERENT scalar/enum value, ask the §4.7 resolver:
//   - status "unresolved" (thin inferred value vs a self-report) → an OPEN conflict.
//   - status "resolved" (the inferred side crossed the floor, or observed-vs-observed) →
//     the dimension now settles; if a record was open for it, CLOSE it.
// Array-valued fields union (never conflict) and are skipped. Pure; no mutation.
export function detectConflicts(existingSignals, incomingSignals) {
  const byKey = new Map((Array.isArray(existingSignals) ? existingSignals : []).map((s) => [sigKey(s), s]));
  const open = [], settled = [], overrides = [];
  for (const inc of (Array.isArray(incomingSignals) ? incomingSignals : [])) {
    const ex = byKey.get(sigKey(inc));
    if (!ex) continue;                                                  // novel → not a conflict
    if (Array.isArray(ex.value) || Array.isArray(inc.value)) continue; // list fields union
    if (valKey(ex.value) === valKey(inc.value)) continue;              // agree → corroboration
    const r = resolveDimension([ex, inc]);
    const dim = { field: inc.field, domain: typeof inc.domain === 'string' ? inc.domain : undefined, candidates: r.provenance };
    if (r.status === 'unresolved') { open.push(dim); continue; }
    settled.push(dim);
    // OVERRIDE detection: inferred behavior crossed the §4.7 floor AND there was a
    // contradicting self_reported candidate → behavior just silently overrode what the
    // subject said in the interview. Stage it so the subject SEES it (the existing
    // "settled" path only closes already-open records; without this an override produces
    // zero visibility — the subject's stated preference vanishes silently). Read by
    // upsertConflictRecords to create a resolved record with resolution.by:'system'.
    const selfReport = (r.provenance || []).find(c => c && c.evidence_basis === 'self_reported');
    const winnerNotSelfReport = r.evidence_basis !== 'self_reported';
    if (selfReport && winnerNotSelfReport && valKey(r.value) !== valKey(selfReport.value)) {
      overrides.push({ ...dim, chosen_value: r.value, prior_value: selfReport.value });
    }
  }
  return { open, settled, overrides };
}

// Fold a layer's detected conflicts into the fingerprint-level records list. Open a
// new record (or refresh an existing open one); close an open record whose dimension
// now settles. A subject's `dismissed` is sticky — never auto-reopened or closed.
function upsertConflictRecords(records, layerId, detected, now) {
  const list = (Array.isArray(records) ? records : []).map((r) => ({ ...r }));
  const byKey = new Map(list.map((r) => [conflictKey(r.layer, r.field, r.domain), r]));
  for (const d of detected.open) {
    const k = conflictKey(layerId, d.field, d.domain);
    const ex = byKey.get(k);
    if (ex && ex.status === 'dismissed') continue;
    if (ex && ex.status === 'open') { ex.last_seen = now; ex.candidates = d.candidates; continue; }
    const rec = { conflict_id: uuid(), layer: layerId, field: d.field, status: 'open', detected_at: now, last_seen: now, candidates: d.candidates };
    if (d.domain) rec.domain = d.domain;
    byKey.set(k, rec);
  }
  for (const d of detected.settled) {
    const ex = byKey.get(conflictKey(layerId, d.field, d.domain));
    if (ex && ex.status === 'open') { ex.status = 'resolved'; ex.resolved_at = now; }
  }
  // Overrides: stage a `resolved` record marked as a system-auto-resolution against a
  // self-report, so the subject can see + acknowledge or revert. Dismissed records
  // stay sticky; an existing record gets refreshed last_seen + candidates instead of
  // duplicating. by:'system' is the cue conflict-review uses to surface for review.
  for (const d of (detected.overrides || [])) {
    const k = conflictKey(layerId, d.field, d.domain);
    const ex = byKey.get(k);
    if (ex && ex.status === 'dismissed') continue;
    if (ex) {
      ex.last_seen = now; ex.candidates = d.candidates;
      // Don't re-stamp an override the subject already acknowledged (by:'user').
      if (!ex.resolution || ex.resolution.by !== 'user') {
        ex.status = 'resolved'; ex.resolved_at = now;
        ex.resolution = { chosen_value: d.chosen_value, prior_value: d.prior_value, by: 'system' };
      }
      continue;
    }
    const rec = {
      conflict_id: uuid(), layer: layerId, field: d.field,
      status: 'resolved', detected_at: now, last_seen: now, resolved_at: now,
      candidates: d.candidates,
      resolution: { chosen_value: d.chosen_value, prior_value: d.prior_value, by: 'system' },
    };
    if (d.domain) rec.domain = d.domain;
    byKey.set(k, rec);
  }
  return Array.from(byKey.values());
}

// Reconcile a full update ({ layerId: layerDoc }) into a fingerprint.
// Fingerprint shape: { layers: { layerId: layerDoc }, ... }. Returns a new
// fingerprint object (shallow-cloned down to touched layers). Also stages
// `conflict_records[]` for genuine self-report↔observed contradictions (above).
export function reconcileFingerprint(fingerprint, update, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const fp = { ...(fingerprint || {}) };
  fp.layers = { ...(fp.layers || {}) };
  let conflicts = Array.isArray(fp.conflict_records) ? fp.conflict_records : null;
  for (const [layerId, incomingLayer] of Object.entries(update || {})) {
    const prev = fp.layers[layerId];
    const detected = detectConflicts(prev && prev.signals, incomingLayer.signals);
    if (detected.open.length || detected.settled.length || (detected.overrides && detected.overrides.length) || (conflicts && conflicts.length)) {
      conflicts = upsertConflictRecords(conflicts || [], layerId, detected, now);
    }
    // Build the summary AFTER the conflict set is finalized, withholding from the
    // projection (§4.7): (a) any dimension with an OPEN conflict, and (b) any dimension an
    // AUTHORED bound rule governs — the authored value is canonical for the projection, so
    // the inferred summary must not restate/contradict it (resolveEffective decides; the
    // rule is injected separately via renderOperatingRules). authoredGovernedKeys runs over
    // both the existing and incoming signals so every field that could render is covered.
    const rules = Array.isArray(fp.standing_rules) ? fp.standing_rules : [];
    const suppress = new Set([
      ...openConflictFieldKeys(conflicts, layerId),
      ...authoredGovernedKeys([...((prev && prev.signals) || []), ...(incomingLayer.signals || [])], rules, opts.domain || null),
    ]);
    fp.layers[layerId] = reconcileLayer(prev, incomingLayer, now, suppress, opts.sourceId ? { sourceId: opts.sourceId, context: opts.context } : null);
  }
  if (conflicts && conflicts.length) fp.conflict_records = conflicts;
  return fp;
}

// Re-render every layer's `summary` from its CURRENT signals, with the same suppression
// reconcileFingerprint applies (open conflicts + dimensions an authored rule governs).
//
// A cross-browser sync merges signals without running a pass (signal-ledger.js mergeLayers), and
// the injected context reads `summary`, not signals — so without this, evidence that just arrived
// from another browser would sit in storage and never reach a prompt until this browser's next
// extraction pass. Returns the same object when no summary changes.
export function rerenderSummaries(fingerprint, opts = {}) {
  if (!fingerprint || !fingerprint.layers) return fingerprint;
  const rules = Array.isArray(fingerprint.standing_rules) ? fingerprint.standing_rules : [];
  let out = null;
  for (const [layerId, layer] of Object.entries(fingerprint.layers)) {
    if (!layer || !Array.isArray(layer.signals) || !layer.signals.length) continue;
    const suppress = new Set([
      ...openConflictFieldKeys(fingerprint.conflict_records, layerId),
      ...authoredGovernedKeys(layer.signals, rules, opts.domain || null),
    ]);
    const summary = renderLayerSummary(effectiveSignals(layer.signals).filter(s => s.source !== 'questionnaire'), suppress);
    if (summary === layer.summary) continue;
    out = out || { ...fingerprint, layers: { ...fingerprint.layers } };
    out.layers[layerId] = { ...layer, summary };
  }
  return out || fingerprint;
}

// The (field / field::domain) keys of the OPEN conflicts on a layer — the dimensions
// the projection withholds (renderLayerSummary skips them).
function openConflictFieldKeys(records, layerId) {
  const out = new Set();
  for (const r of (Array.isArray(records) ? records : [])) {
    if (r && r.layer === layerId && r.status === 'open') {
      out.add(r.field + (typeof r.domain === 'string' ? `::${r.domain}` : ''));
    }
  }
  return out;
}

export { combineConfidence, sigKey };
