// MCP Phase 1b — real key boundary.
//
// The pairing record may come from EITHER provenance: `pair.js`, which pairs this
// server as its own SAS-approved, revocable client (mcp-revocable-approval-plan.md,
// DONE + device-verified), or the older "Option B" export of the extension's
// `phaedo_local_pairing`. This path works under both — the phone's drains try each
// verified client's key — but the extension-facing `agent_to_ext` lane does NOT;
// see delegation-sync.js and docs/roadmap/paired-client-identity-2026-07-22.md.
//
// Given a pairing record holding `pair_key`, this runs the spec-faithful
// authorize → pull → decrypt flow — a
// direct port of popup.js reAuthorize (:745) + silentSync (:883):
//
//   authorize: fresh ephemeral X25519, HMAC-bound to pair_key, POST /v1/authorize,
//              verify the vault's reply MAC, ECDH → HKDF session_key
//   pull:      GET /v1/profile (Bearer session_token) → Envelope.unwrap → fingerprint
//
// No long-term private key and no phaedoVault are needed (pair_key suffices), so
// nothing browser-only is touched. The decrypted fingerprint is returned to the
// caller and never written to disk (the 1b at-rest cache is a later increment).
//
// Session is cached in memory and re-authorized on expiry — fully autonomous
// after the one-time pairing.

import { readFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Phaedo, b64uEnc, b64uDec } from './lib/phaedo-crypto.js';

const { Identity, Kdf, Envelope } = Phaedo;
const EXPIRY_SKEW_MS = 30 * 1000; // re-auth this early to avoid edge-of-expiry races

// TWO timeouts, because the two requests wait on completely different things.
//
// `/v1/profile` waits on a MACHINE: the phone either answers or it doesn't, so failing fast
// is right — an unreachable phone should fall back to the cache quickly.
//
// `/v1/authorize` waits on a PERSON: they must notice their phone, read the card, and pass
// a biometric gate. A single 5s budget covered both, which made every authorize a race the
// subject usually lost — the client aborted, the card vanished mid-tap, and an approval
// completed seconds later landed on a request nobody was listening for. Worse, the abort is
// a TRANSIENT failure, so it took the silent cache fallback: the agent then answered
// authorization questions from a stale fingerprint while sounding certain. Observed on
// device 2026-07-25 — the cache had not been refreshed for ~22 hours and a REVOKED payment
// grant was still being honoured, because no live pull had ever completed.
//
// Face ID on the first try can fit in 5s. A passcode fallback cannot, and neither can a
// phone that is face-down on a table. Two minutes is the human budget; the phone's own card
// expiry remains the real bound, this just stops the client giving up first.
const TIMEOUT_MS = 5000;             // reachability: /v1/profile
const APPROVE_TIMEOUT_MS = 120000;   // human-in-the-loop: /v1/authorize

// ── Pairing record (from `pair.js`, or the legacy extension export — see header)
// { endpoint, client_id, client_secret, pair_key (b64url 32B), vault_pub, ... }
export async function loadPairingRecord(baseDir) {
  const path = process.env.PHAEDO_PAIRING
    ? resolve(process.cwd(), process.env.PHAEDO_PAIRING)
    : resolve(baseDir, 'pairing.json');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    // No pairing file = UNPAIRED (a valid local-only state), not an error. Return
    // null so callers that pass the record to depositEscalation / pollEscalation /
    // the best-effort deposit channels get a graceful "unpaired" instead of an
    // ENOENT throw. (hasPairingRecord() gates the fingerprint-pull path, so it only
    // calls this when the file exists.)
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  const rec = JSON.parse(raw);
  for (const k of ['endpoint', 'client_id', 'client_secret', 'pair_key']) {
    if (!rec[k]) throw new Error(`Pairing record at ${path} is missing "${k}".`);
  }
  return rec;
}

// True iff a pairing record is configured (→ use the phone source over local JSON).
export function hasPairingRecord(baseDir) {
  if (process.env.PHAEDO_PAIRING) return true;
  return existsSync(resolve(baseDir, 'pairing.json'));
}

// This server's OWN paired-client identifier — the identity §10.5 `agents` scoping
// matches on (`docs/roadmap/paired-client-identity-2026-07-22.md`).
//
// Read SYNCHRONOUSLY at startup, beside the policy file, because it is process-wide
// configuration rather than per-call state: one MCP server process serves exactly one
// paired client, so this cannot change between calls without a restart. That is also
// what makes the whole design work — the server never has to ask a caller who it is.
//
// Fail-safe by construction: any failure (no pairing, unreadable, malformed, missing
// or non-string `client_id`) yields null, and null makes every `agents`-scoped
// RELAXING rule inert. A broken read can therefore only ever withhold authority, never
// grant it. Never throws.
export function readServingClientId(baseDir) {
  const path = process.env.PHAEDO_PAIRING
    ? resolve(process.cwd(), process.env.PHAEDO_PAIRING)
    : resolve(baseDir, 'pairing.json');
  try {
    const id = JSON.parse(readFileSync(path, 'utf8'))?.client_id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

// In-memory session cache, keyed by endpoint. Holds session_key (never persisted).
const _sessions = new Map();

async function authorize(rec, deps) {
  const { fetch, now } = deps;
  const pairKey = b64uDec(rec.pair_key);

  const eph = await Identity.generateEphemeral();                 // {publicKey, privateKey}
  const extMac = await Kdf.authEphemeral(pairKey, 'ext', eph.publicKey);

  const res = await fetch(`${rec.endpoint}/v1/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: rec.client_id,
      client_secret: rec.client_secret,
      scopes: ['profile:full'],
      eph_ext_pub: b64uEnc(eph.publicKey),
      eph_mac: b64uEnc(extMac),
    }),
    signal: AbortSignal.timeout(APPROVE_TIMEOUT_MS),   // waits on a human, not a machine
  });
  if (!res.ok) throw new PhoneError(`authorize failed (${res.status})`, res.status);
  const body = await res.json();

  const ephVaultPub = b64uDec(body.eph_vault_pub);
  const macOk = await Kdf.verifyAuthEphemeral(pairKey, 'vault', ephVaultPub, b64uDec(body.eph_mac));
  if (!macOk) throw new PhoneError('vault eph_mac verification failed (possible MITM)', 0);

  const shared = await Identity.deriveEphemeralShared(eph.privateKey, ephVaultPub);
  const sessionKey = await Kdf.deriveSessionKey(shared, body.session_token);
  shared.fill(0);

  const session = { token: body.session_token, sessionKey, expiresAt: Date.parse(body.expires_at) || (now() + 3600000) };
  _sessions.set(rec.endpoint, session);
  return session;
}

async function getSession(rec, deps) {
  const cached = _sessions.get(rec.endpoint);
  if (cached && deps.now() < cached.expiresAt - EXPIRY_SKEW_MS) return cached;
  return authorize(rec, deps);
}

// Map the §9-profile inner plaintext to the vault payload shape the projection
// expects. Profile inner is { data: <fingerprint>, user_configuration?, metrics:
// {signals, ling, sessions}, scopes } (mobile localServer handleProfile + popup
// restoreMetrics). The optional §5 sibling (config home migration, part 3) maps
// to phaedo_user_configuration, activating the canonical authored read
// (consult-policy loadPolicies / context-block renderContextBlock); absent —
// pre-part-3 phone — consumers fall back to the fingerprint A-home unchanged.
export function toVaultPayload(inner) {
  const m = inner.metrics || {};
  return {
    phaedo_fingerprint: inner.data,
    ...(inner.user_configuration && typeof inner.user_configuration === 'object'
      ? { phaedo_user_configuration: inner.user_configuration } : {}),
    // §8.3 signing public key — a sibling of the fingerprint, carried through so a
    // consumer can VERIFY a signature the phone produced (e.g. an AP2 mandate) against a
    // key learned over the trusted pairing channel, not one asserted in the signed object
    // itself. A plain non-empty string or nothing; never trusted from inside `data`.
    ...(typeof inner.signing_public_key === 'string' && inner.signing_public_key
      ? { phaedo_signing_public_key: inner.signing_public_key } : {}),
    phaedo_behavioral_signals: m.signals || {},
    phaedo_linguistic_profile: m.ling || {},
    phaedo_session_metrics: m.sessions || {},
  };
}

async function pull(rec, session, deps) {
  const res = await deps.fetch(`${rec.endpoint}/v1/profile`, {
    headers: { authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new PhoneError('session rejected', 401);
  if (!res.ok) throw new PhoneError(`profile failed (${res.status})`, res.status);
  const body = await res.json();
  const plaintext = await Envelope.unwrap(body.envelope, session.sessionKey);
  const inner = JSON.parse(new TextDecoder().decode(plaintext));
  plaintext.fill(0);
  if (!inner || !inner.data) throw new PhoneError('profile envelope missing data', 0);
  return toVaultPayload(inner);
}

export class PhoneError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Pull + decrypt the live fingerprint from the phone. Re-authorizes once if the
// cached session is rejected (e.g. the phone restarted). `deps` is injectable for
// tests: { fetch, now }.
export async function loadFingerprintFromPhone(rec, deps = {}) {
  const d = { fetch: deps.fetch || globalThis.fetch, now: deps.now || Date.now };
  let session = await getSession(rec, d);
  try {
    return await pull(rec, session, d);
  } catch (err) {
    if (err instanceof PhoneError && err.status === 401) {
      _sessions.delete(rec.endpoint);          // stale session → re-authorize once
      session = await authorize(rec, d);
      return pull(rec, session, d);
    }
    throw err;
  }
}

// test/maintenance helper
export function _clearSessions() { _sessions.clear(); }
