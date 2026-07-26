// Capture-delta transport (capture surface → relay → merge owner).
//
// Track A of the desktop-capture plan. The Claude Code / Cowork capture hook reads the
// local session transcript, runs the surface-agnostic extraction engine, and deposits
// the resulting SIGNAL DELTA (never a whole fingerprint) into the relay's
// `capture_to_owner` mailbox lane, encrypted under fp_sync_key. Exactly one merge owner
// (phone → extension → mcp-local, capture/owner.js) drains and reconciles it per-source
// (capture/source-id.js), so concurrent capture on multiple surfaces accumulates instead
// of clobbering — docs/roadmap/desktop-capture-deposit.md.
//
// Mirrors delegation-sync.js in trust posture, but NOT in key sensitivity: this lane is
// drained by the PHONE, which tries each verified client's key until one decrypts, so an
// independently-paired MCP works fine here (unlike agent_to_ext — see delegation-sync.js).
// The relay only ever holds ciphertext; and the deposit is best-effort and
// isolated — a transport failure never breaks the session that produced the capture.
//
// The lane carries a DELTA, so a deposit can never overwrite signal the owner captured
// on its own; and per-source idempotency (source_device_id) means a re-deposit or a
// transient two-owner overlap is a no-op, not a double-count.

import { Phaedo, b64uDec } from './lib/phaedo-crypto.js';

const { Kdf, Envelope } = Phaedo;
const DEFAULT_RELAY = 'https://phaedo-relay.fly.dev';

export function relayBaseFromEnv(env = process.env) {
  return env.PHAEDO_RELAY || DEFAULT_RELAY;
}

// Build the canonical capture-delta payload from lifted signals (Q1: lift on the
// surface — the hook runs extraction and ships §5.4 signals, not raw counters).
//   signals — the extraction engine's signal list (source-tagged; 'delta' snapshots
//             are idempotent on re-lift).
export function buildCaptureDelta(signals, { sourceSurface, sourceDeviceId, capturedAt } = {}) {
  return {
    capture_delta_version: 'v0.1',
    source_surface: sourceSurface || 'unknown',
    source_device_id: sourceDeviceId || null,
    captured_at: capturedAt || null,
    delta: { signals: Array.isArray(signals) ? signals : [] },
  };
}

// Wrap a capture-delta into the same envelope shape the owner's fp-mailbox drain
// expects: ciphertext over `{ kind:'capture_delta', data: <captureDelta> }`. Returns the
// deposit body `{ envelope }`. Pure crypto (no network) so the round-trip is testable.
export async function buildCaptureDeposit(pairKeyB64u, captureDelta, { now = () => new Date().toISOString() } = {}) {
  const pairKey = b64uDec(pairKeyB64u);
  let fpSyncKey;
  try {
    fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  } finally {
    pairKey.fill(0);
  }
  try {
    const inner = { kind: 'capture_delta', data: captureDelta };
    const plaintext = new TextEncoder().encode(JSON.stringify(inner));
    const envelope = await Envelope.wrap(plaintext, fpSyncKey, { artifact_kind: 'capture_delta', created_at: now() });
    plaintext.fill(0);
    return { envelope };
  } finally {
    if (fpSyncKey && fpSyncKey.fill) fpSyncKey.fill(0);
  }
}

// Deposit a capture-delta to the relay's capture_to_owner slot. Best-effort: returns
// { deposited, ... } and never throws. `deps.fetch` is injectable for tests.
export async function depositCaptureDelta(pairing, captureDelta, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const signals = captureDelta && captureDelta.delta && Array.isArray(captureDelta.delta.signals)
    ? captureDelta.delta.signals : [];
  // Precise reasons so the caller can log WHY a deposit didn't happen.
  if (!signals.length) return { deposited: false, reason: 'no-signal' };
  if (!pairing || !pairing.pair_key) return { deposited: false, reason: 'unpaired' };
  if (!pairing.relay_device_id) return { deposited: false, reason: 'no-relay-device-id' };
  try {
    const body = await buildCaptureDeposit(pairing.pair_key, captureDelta, deps);
    // Sub-key the lane per source so a second surface on this device doesn't clobber the
    // hook's deposit before the owner drains (desktop-capture-deposit.md). Falls back to
    // the flat lane only if the delta somehow lacks a source id (pre-source-id builds).
    const src = captureDelta && captureDelta.source_device_id;
    const lane = src ? `capture_to_owner/${encodeURIComponent(src)}` : 'capture_to_owner';
    const base = `${deps.relayBase || relayBaseFromEnv()}/fp-mailbox/${encodeURIComponent(pairing.relay_device_id)}/${lane}`;
    // Per-device auth header (relay/auth.js). Without it the relay 401s → deposit no-ops
    // (correct failure mode: the user re-pairs to capture the relay_device_secret).
    const authHeader = pairing.relay_device_secret
      ? { Authorization: `Bearer ${pairing.relay_device_id}:${pairing.relay_device_secret}` }
      : {};
    const res = await fetchFn(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs || 8000),
    });
    return { deposited: !!(res && res.ok), status: res && res.status, count: signals.length };
  } catch (e) {
    return { deposited: false, reason: String(e && e.message || e) };
  }
}
