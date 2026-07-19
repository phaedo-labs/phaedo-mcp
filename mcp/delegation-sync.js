// Delegation-promotion transport (MCP → relay → extension).
//
// Deposits act-as-me delegation SUGGESTIONS (built by consult-core.js
// buildDelegationPromotions from the consult override history) into the relay's
// `agent_to_ext` mailbox slot, encrypted under fp_sync_key. The MCP server shares the
// extension's pairing (Option B — pair_key exported from the extension), so it derives
// the SAME fp_sync_key the extension uses to drain + decrypt; the extension union-merges
// the suggestions (sync-merge.js mergeAgentSuggestions) into suggested_rules, where the
// existing popup review card surfaces them for endorsement.
//
// Trust posture: the MCP only ever proposes SUGGESTIONS — never an authored rule. The
// subject still endorses (the authored-only invariant holds). Best-effort and isolated:
// a deposit failure never affects the consultation that triggered it. The relay only
// ever holds ciphertext (the agent_to_ext slot is separate from the phone's to_ext, so
// a deposit can neither clobber nor be clobbered by the phone's fingerprint sync).

import { Phaedo, b64uDec } from './lib/phaedo-crypto.js';

const { Kdf, Envelope } = Phaedo;
const DEFAULT_RELAY = 'https://phaedo-relay.fly.dev';

export function relayBaseFromEnv(env = process.env) {
  return env.PHAEDO_RELAY || DEFAULT_RELAY;
}

// Wrap delegation suggestions into the same envelope shape the extension's fp-mailbox
// drain expects: ciphertext over `{ data: { suggested_rules: [...] } }`. Returns the
// deposit body `{ envelope }`. Pure crypto (no network) so the round-trip is testable.
export async function buildDelegationDeposit(pairKeyB64u, suggestions, { now = () => new Date().toISOString() } = {}) {
  const pairKey = b64uDec(pairKeyB64u);
  let fpSyncKey;
  try {
    fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  } finally {
    pairKey.fill(0);
  }
  try {
    const inner = { kind: 'delegation_suggestions', data: { suggested_rules: suggestions } };
    const plaintext = new TextEncoder().encode(JSON.stringify(inner));
    const envelope = await Envelope.wrap(plaintext, fpSyncKey, { artifact_kind: 'delegation_suggestions', created_at: now() });
    plaintext.fill(0);
    return { envelope };
  } finally {
    if (fpSyncKey && fpSyncKey.fill) fpSyncKey.fill(0);
  }
}

// Deposit the suggestions to the relay's agent_to_ext slot. Best-effort: returns
// { deposited, ... } and never throws (a transport failure must not break the consult).
// `deps.fetch` is injectable for tests.
export async function depositDelegationSuggestions(pairing, suggestions, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const list = Array.isArray(suggestions) ? suggestions : [];
  // Precise reasons so the caller can surface WHY a deposit didn't happen (a missing
  // relay_device_id means a local-only pairing — the deposit silently no-ops otherwise).
  if (!list.length) return { deposited: false, reason: 'no-suggestions' };
  if (!pairing || !pairing.pair_key) return { deposited: false, reason: 'unpaired' };
  if (!pairing.relay_device_id) return { deposited: false, reason: 'no-relay-device-id' };
  try {
    const body = await buildDelegationDeposit(pairing.pair_key, list, deps);
    const base = `${deps.relayBase || relayBaseFromEnv()}/fp-mailbox/${encodeURIComponent(pairing.relay_device_id)}/agent_to_ext`;
    // Per-device auth header (relay/auth.js). Without it the relay 401s. A pairing.json
    // from an older mobile build that predates the auth layer won't have relay_device_secret
    // → no header → 401 → the deposit no-ops, which is the correct failure mode (user re-pairs).
    const authHeader = pairing.relay_device_secret
      ? { Authorization: `Bearer ${pairing.relay_device_id}:${pairing.relay_device_secret}` }
      : {};
    const res = await fetchFn(base, {
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
