// §10.6 receipts audit channel — MCP ↔ phone transport (G1+G2).
//
// Closes the act-as-me learning loop: today receipts written by `phaedo_consult` /
// `phaedo_escalate` sit at `user_action: null` until the subject runs `node receipts.js
// mark` — a dev CLI only. This module puts the audit on the subject's PHONE so they can
// mark outcomes in the flow, which then feeds delegation learning (consult-core.js
// `deriveDelegationSignals`).
//
// Two directions over the existing fp-mailbox transport (relay/mailbox.js):
//
//   agent_to_phone  — MCP deposits a digest of the latest UNMARKED receipts (a single
//                     payload with at most N entries, last-write-wins idempotent: the
//                     phone always sees the latest snapshot). §10.4-safe: only the
//                     fields the phone needs to render — receipt_id, created_at, via,
//                     agent_id, action_descriptor, response.signal — never `drivers`
//                     (local provenance) and never layer content.
//   phone_to_agent  — phone deposits a BATCH of `{ receipt_id, outcome }`; this module
//                     drains and calls `markOutcome` per mark. Idempotent on the MCP
//                     side (re-marking the same outcome is a no-op), so re-draining is
//                     safe and the phone need not track per-mark ACKs — the next
//                     receipts digest reflects applied marks (`user_action` set).
//
// Crypto: same fp_sync_key the delegation channel uses (the MCP shares the extension's
// pair_key, Option B); the relay only ever sees ciphertext. Best-effort and isolated:
// a deposit/drain failure must NEVER break the tool that triggered it.

import { Phaedo, b64uDec } from './lib/phaedo-crypto.js';
import { readReceipts, markOutcome, USER_ACTIONS } from './receipts.js';

const { Kdf, Envelope } = Phaedo;
const DEFAULT_RELAY = 'https://phaedo-relay.fly.dev';
const DIGEST_CAP    = 50;   // phone shows recent N — enough for the latest sittings, bounded payload

export function relayBaseFromEnv(env = process.env) {
  return env.PHAEDO_RELAY || DEFAULT_RELAY;
}

// Strip a receipt down to the §10.4-safe fields the phone renders. NEVER includes
// `drivers` (local provenance cues that would expose Decision&Risk reasoning to the
// subject device — fine on this device, but the audit UI doesn't need them and not
// shipping them keeps the digest small + the boundary tight).
function digestFields(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    receipt_id:  r.receipt_id,
    created_at:  r.created_at,
    via:         r.via,
    agent_id:    r.agent_id || null,
    request: {
      consultation_type: r?.request?.consultation_type || null,
      action_descriptor: {
        domain:     r?.request?.action_descriptor?.domain     ?? null,
        reversible: r?.request?.action_descriptor?.reversible ?? null,
        magnitude:  r?.request?.action_descriptor?.magnitude  ?? null,
        amount:     r?.request?.action_descriptor?.amount     ?? null,
        summary:    r?.request?.action_descriptor?.summary    ?? null,
      },
    },
    response: {
      signal:          r?.response?.signal          ?? null,
      deference_level: r?.response?.deference_level ?? null,
    },
    user_action: r.user_action ?? null,   // already-marked entries stay visible (phone shows status)
  };
}

// Pure-crypto: take the local receipts list, build a §10.4-safe digest of the most
// recent `cap` entries, and seal it under fp_sync_key. Returns `{ envelope }` — the
// same shape `agent_to_ext` (delegation-sync) uses, so the relay's mailbox accepts it.
export async function buildReceiptsDeposit(pairKeyB64u, receipts, { cap = DIGEST_CAP, now = () => new Date().toISOString() } = {}) {
  const list = Array.isArray(receipts) ? receipts : [];
  // Most-recent N (receipts are append-only, ordered by creation in the store).
  const head = list.slice(-cap).map(digestFields).filter(Boolean);
  const pairKey = b64uDec(pairKeyB64u);
  let fpSyncKey;
  try {
    fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  } finally {
    pairKey.fill(0);
  }
  try {
    const inner = { kind: 'receipts_digest', data: { receipts: head, generated_at: now() } };
    const plaintext = new TextEncoder().encode(JSON.stringify(inner));
    const envelope = await Envelope.wrap(plaintext, fpSyncKey, { artifact_kind: 'receipts_digest', created_at: now() });
    plaintext.fill(0);
    return { envelope };
  } finally {
    if (fpSyncKey && fpSyncKey.fill) fpSyncKey.fill(0);
  }
}

// Decrypt a phone-deposited marks payload. Returns `{ marks: [{receipt_id, outcome}, ...] }`
// or null on a malformed/wrong-key envelope. Pure (no I/O) so it's testable.
export async function parseMarksDeposit(pairKeyB64u, envelope) {
  if (!envelope) return null;
  const pairKey = b64uDec(pairKeyB64u);
  let fpSyncKey;
  try { fpSyncKey = await Kdf.deriveFpSyncKey(pairKey); }
  finally { pairKey.fill(0); }
  try {
    const plaintext = await Envelope.unwrap(envelope, fpSyncKey);
    let inner;
    try { inner = JSON.parse(new TextDecoder().decode(plaintext)); }
    finally { if (plaintext.fill) plaintext.fill(0); }
    if (!inner || inner.kind !== 'receipt_marks' || !inner.data) return null;
    const arr = Array.isArray(inner.data.marks) ? inner.data.marks : [];
    return {
      marks: arr
        .map((m) => ({
          receipt_id: typeof m?.receipt_id === 'string' ? m.receipt_id : null,
          outcome:    typeof m?.outcome    === 'string' ? m.outcome    : null,
        }))
        .filter((m) => m.receipt_id && USER_ACTIONS.includes(m.outcome)),
    };
  } catch {
    return null;
  } finally {
    if (fpSyncKey && fpSyncKey.fill) fpSyncKey.fill(0);
  }
}

// Deposit a receipts digest to the relay's agent_to_phone slot. Best-effort; mirrors
// `depositDelegationSuggestions` exactly (same auth, same timeout, same isolation —
// a failure NEVER throws out into the consult/escalate path that called us).
export async function depositReceiptsDigest(pairing, receipts, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const list = Array.isArray(receipts) ? receipts : [];
  if (!list.length) return { deposited: false, reason: 'no-receipts' };
  if (!pairing || !pairing.pair_key) return { deposited: false, reason: 'unpaired' };
  if (!pairing.relay_device_id) return { deposited: false, reason: 'no-relay-device-id' };
  try {
    const body = await buildReceiptsDeposit(pairing.pair_key, list, deps);
    const url = `${deps.relayBase || relayBaseFromEnv()}/fp-mailbox/${encodeURIComponent(pairing.relay_device_id)}/agent_to_phone`;
    const authHeader = pairing.relay_device_secret
      ? { Authorization: `Bearer ${pairing.relay_device_id}:${pairing.relay_device_secret}` }
      : {};
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs || 8000),
    });
    return { deposited: !!(res && res.ok), status: res && res.status, count: list.length };
  } catch (e) {
    return { deposited: false, reason: String(e && e.message || e) };
  }
}

// Drain phone-deposited outcome marks from the phone_to_agent slot and apply each via
// markOutcome (idempotent). Returns `{ applied, skipped }`. Best-effort; a transport
// failure returns `{ applied: 0, skipped: 0, reason }` instead of throwing.
export async function drainAndApplyMarks(pairing, stateDir, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  if (!pairing || !pairing.pair_key) return { applied: 0, skipped: 0, reason: 'unpaired' };
  if (!pairing.relay_device_id) return { applied: 0, skipped: 0, reason: 'no-relay-device-id' };
  try {
    const url = `${deps.relayBase || relayBaseFromEnv()}/fp-mailbox/${encodeURIComponent(pairing.relay_device_id)}/phone_to_agent`;
    const authHeader = pairing.relay_device_secret
      ? { Authorization: `Bearer ${pairing.relay_device_id}:${pairing.relay_device_secret}` }
      : {};
    const res = await fetchFn(url, {
      method: 'GET',
      headers: authHeader,
      signal: AbortSignal.timeout(deps.timeoutMs || 8000),
    });
    if (!res || !res.ok) return { applied: 0, skipped: 0, status: res && res.status };
    const body = await res.json().catch(() => null);
    const parsed = await parseMarksDeposit(pairing.pair_key, body && body.envelope);
    if (!parsed) return { applied: 0, skipped: 0, reason: 'no-marks' };
    let applied = 0, skipped = 0;
    for (const m of parsed.marks) {
      try {
        const r = await markOutcome(stateDir, m.receipt_id, m.outcome);
        if (r.matched) applied++; else skipped++;
      } catch { skipped++; }
    }
    return { applied, skipped, total: parsed.marks.length };
  } catch (e) {
    return { applied: 0, skipped: 0, reason: String(e && e.message || e) };
  }
}
