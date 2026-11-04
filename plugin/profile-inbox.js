// The phone's pushed profile copy (relay lane `profile_to_agent/<client_id>`, 2026-11-02).
//
// The live read (phone-source.js) needs the phone's LAN server up and a Face ID tap, so on the
// reference Mac it almost never completed and the at-rest copy went days stale — past the 7 days
// a standing rule may run on (lib/rule-leeway.js). The phone now leaves a fresh copy for this
// agent whenever its app comes to the foreground or the profile changes (mobile
// agentProfile.js / agentProfilePush.ts), sealed under this agent's own fp_sync_key. Here we pick
// it up and make it the at-rest copy.
//
// What keeps this safe:
//   - It refreshes the CACHE only. A pushed copy is never "live" (sourceOf stays live:false), so
//     the stale-authority guard and the rule leeway treat it exactly as they treat any cache.
//   - Its age is the PHONE's `generated_at`, not when we drained it, so a copy that sat on the
//     relay for days is days old here too. A time in the future is clamped to now.
//   - Newest wins: a copy no newer than the one we hold is ignored, so the relay cannot roll the
//     profile back to before a rule was removed by replaying an older deposit.
//   - Sealed + tagged: only this agent's pair key opens it, and `kind: 'agent_profile'` stops
//     anything else sealed under that key (our own receipts digest) being read as a profile.
//
// Best-effort and throttled (CHECK_GAP_MS, shared across processes through a small state file,
// since the ship hook runs as a fresh process per tool call): a relay failure leaves the copy we
// have and never fails the read that asked.

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { Phaedo, b64uDec } from './lib/phaedo-crypto.js';
import { readCache, writeCache } from './cache.js';
import { toVaultPayload } from './phone-source.js';
import { relayBaseFromEnv } from './receipts-sync.js';

const { Kdf, Envelope } = Phaedo;
export const AGENT_PROFILE_KIND = 'agent_profile';
export const CHECK_GAP_MS = 10 * 60 * 1000;
const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,128}$/;   // relay/mailbox.js LANE_SUB_RE
const STATE_FILE = 'profile-inbox.json';
const TIMEOUT_MS = 3000;                         // on the ship hook's path: fail fast

/** Open a pushed copy → { vault, generatedAt } or null (wrong key, wrong kind, malformed). */
export async function parseAgentProfileDeposit(pairKeyB64u, envelope) {
  if (!envelope || !pairKeyB64u) return null;
  const pairKey = b64uDec(pairKeyB64u);
  let key;
  try { key = await Kdf.deriveFpSyncKey(pairKey); } finally { pairKey.fill(0); }
  try {
    const plaintext = await Envelope.unwrap(envelope, key);
    let inner;
    try { inner = JSON.parse(new TextDecoder().decode(plaintext)); } finally { if (plaintext.fill) plaintext.fill(0); }
    if (!inner || inner.kind !== AGENT_PROFILE_KIND || !inner.data || typeof inner.data !== 'object') return null;
    const generatedAt = Date.parse(inner.generated_at);
    if (!Number.isFinite(generatedAt)) return null;
    return { vault: toVaultPayload(inner), generatedAt };
  } catch {
    return null;
  } finally {
    if (key && key.fill) key.fill(0);
  }
}

/** Should a pushed copy replace the cache? Only a strictly newer one. Returns the time to stamp. */
export function acceptCopy(generatedAt, cachedAt, now = Date.now()) {
  if (!Number.isFinite(generatedAt)) return null;
  const at = Math.min(generatedAt, now);         // a phone clock ahead of ours cannot buy freshness
  if (Number.isFinite(cachedAt) && at <= cachedAt) return null;
  return at;
}

/**
 * Fetch this agent's pushed copy and, when it is newer than the cache, make it the cache.
 * → { updated: true, generatedAt } | { updated: false, reason }.
 */
export async function drainProfileCopy(pairing, stateDir, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const now = deps.now ? deps.now() : Date.now();
  if (!pairing || !pairing.pair_key) return { updated: false, reason: 'unpaired' };
  if (!pairing.relay_device_id) return { updated: false, reason: 'no-relay-device-id' };
  if (typeof pairing.client_id !== 'string' || !SEGMENT_RE.test(pairing.client_id)) return { updated: false, reason: 'no-client-id' };
  try {
    const url = `${deps.relayBase || relayBaseFromEnv()}/fp-mailbox/${encodeURIComponent(pairing.relay_device_id)}/profile_to_agent/${pairing.client_id}`;
    const authHeader = pairing.relay_device_secret
      ? { Authorization: `Bearer ${pairing.relay_device_id}:${pairing.relay_device_secret}` }
      : {};
    const res = await fetchFn(url, { method: 'GET', headers: authHeader, signal: AbortSignal.timeout(deps.timeoutMs || TIMEOUT_MS) });
    // 404 = nothing pushed yet; 400 = a relay that predates the lane.
    if (!res || !res.ok) return { updated: false, reason: `http-${res && res.status}` };
    const body = await res.json().catch(() => null);
    const copy = await parseAgentProfileDeposit(pairing.pair_key, body && body.envelope);
    if (!copy) return { updated: false, reason: 'unreadable' };
    const cached = await readCache(stateDir);
    const at = acceptCopy(copy.generatedAt, cached ? Number(cached.cachedAt) : NaN, now);
    if (at == null) return { updated: false, reason: 'not-newer' };
    await writeCache(stateDir, copy.vault, at);
    return { updated: true, generatedAt: at };
  } catch (e) {
    return { updated: false, reason: String(e && e.message || e) };
  }
}

/** Throttled `drainProfileCopy`: at most once per CHECK_GAP_MS across every process on this Mac. */
export async function maybeDrainProfileCopy(loadPairing, stateDir, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const path = join(stateDir, STATE_FILE);
  try {
    const last = Number(JSON.parse(await readFile(path, 'utf8'))?.checked_at);
    if (Number.isFinite(last) && now >= last && now - last < CHECK_GAP_MS) return { updated: false, reason: 'recent' };
  } catch { /* first check, or an unreadable file: check now */ }
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    // Claimed BEFORE the request, so the processes that start together do not all ask.
    await writeFile(path, JSON.stringify({ checked_at: now }), { mode: 0o600 });
  } catch { /* a read-only state dir still gets its check */ }
  let pairing = null;
  try { pairing = await loadPairing(); } catch { return { updated: false, reason: 'unpaired' }; }
  return drainProfileCopy(pairing, stateDir, deps);
}
