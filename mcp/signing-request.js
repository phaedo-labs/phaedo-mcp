// §8.3 signing ceremony — the MCP (server) half of the round-trip.
//
// The server holds the mandate; the phone holds the only key that can sign it. This module
// deposits a SIGN REQUEST for the subject, polls for the signed result, and VERIFIES it —
// reusing the escalation transport (relay lane, envelope crypto, first-answer-wins,
// push-to-wake) but NOT its semantics. An escalation answer is approve/deny/modify — a
// decision internal to the subject's system. A signature is a credential asserted to a
// third party. Conflating them is the §10.2 action_binding failure mode one layer up, so
// the request carries a distinct `kind` and the response is a signature or an explicit
// refusal, never a decision verb.
//
// SIGN WHAT YOU SEE. The request carries the mandate OBJECT, not pre-computed bytes. The
// phone renders that object AND derives the signing input from it, so it cannot be shown
// one thing and made to sign another. The server re-derives the same bytes here and
// verifies against them, which independently confirms the phone signed the mandate the
// server actually built.

import { Phaedo, b64uDec } from './lib/phaedo-crypto.js';
import { signingInput, verifyEs256 } from './signing.js';

const { Kdf, Envelope } = Phaedo;
const DEFAULT_RELAY = 'https://phaedo-relay.fly.dev';

const SIGN_REQUEST_KIND = 'sign_request';
const SIGN_RESPONSE_KIND = 'sign_response';
// AP2 mandates omit `signature` from the signing input (the field the signature fills).
const AP2_SIGNATURE_FIELD = 'signature';

export function relayBaseFromEnv(env = process.env) {
  // PHAEDO_RELAY is the name every other lane reads (escalation, receipts, capture, delegation).
  // This one read PHAEDO_RELAY_URL alone, so a self-hosted relay silently did NOT cover the §8.3
  // signing ceremony — sign requests kept going to the default host. The old name is still
  // honoured so an existing setup does not break.
  return env.PHAEDO_RELAY || env.PHAEDO_RELAY_URL || DEFAULT_RELAY;
}

function relayAuthHeader(pairing) {
  const id = pairing && pairing.relay_device_id;
  const secret = pairing && pairing.relay_device_secret;
  return id && secret ? { authorization: `Bearer ${id}:${secret}` } : {};
}

function genRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build the encrypted SIGN REQUEST deposit body. Sealed under fp_sync_key, exactly like an
 * escalation request, and posted to the same relay lane — the phone routes on `kind`.
 * `mandate` is the object to be signed (unsigned; the `signature` field stays null/absent).
 */
export async function buildSignRequestDeposit(pairKeyB64u, requestId, mandate, { windowMs, now = () => new Date().toISOString() } = {}) {
  const pairKey = b64uDec(pairKeyB64u);
  let fpSyncKey;
  try {
    fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  } finally {
    pairKey.fill(0);
  }
  try {
    const inner = { kind: SIGN_REQUEST_KIND, request_id: requestId, data: { mandate } };
    const plaintext = new TextEncoder().encode(JSON.stringify(inner));
    const envelope = await Envelope.wrap(plaintext, fpSyncKey, { artifact_kind: SIGN_REQUEST_KIND, created_at: now() });
    plaintext.fill(0);
    return { request_id: requestId, envelope, ...(windowMs ? { window_ms: windowMs } : {}) };
  } finally {
    if (fpSyncKey && fpSyncKey.fill) fpSyncKey.fill(0);
  }
}

/**
 * Decrypt the phone's SIGN RESPONSE. Returns the inner data — either
 * `{ signature, encoding, signed_at }` or `{ refused: true, reason? }` — or null on any
 * failure. A malformed or forged response must never crash the agent's resume path.
 */
export async function unwrapSignResponse(pairKeyB64u, body) {
  if (!body || !body.envelope) return null;
  const pairKey = b64uDec(pairKeyB64u);
  let fpSyncKey;
  try {
    fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  } catch { pairKey.fill(0); return null; }
  pairKey.fill(0);
  try {
    const plaintext = await Envelope.unwrap(body.envelope, fpSyncKey);
    const inner = JSON.parse(new TextDecoder().decode(plaintext));
    if (inner && inner.kind === SIGN_RESPONSE_KIND && inner.data) return inner.data;
    return null;
  } catch {
    return null;
  } finally {
    if (fpSyncKey && fpSyncKey.fill) fpSyncKey.fill(0);
  }
}

/**
 * Verify a signed mandate. The mandate is re-canonicalized here (signature field omitted)
 * and checked against the subject's published signing key — so a valid result means BOTH
 * that the signature is genuine AND that the phone signed the exact mandate the server
 * built. Returns { verified, reason? }.
 *
 * `signingPublicKey` is the base64 X9.63 point from `phaedo_signing_public_key` (published
 * over the trusted pairing, §8.3 step 2). If it is missing, verification cannot proceed —
 * that is distinct from a bad signature and is reported as such.
 */
export function verifySignedMandate({ mandate, signature, encoding = 'der', signingPublicKey }) {
  if (!signingPublicKey) return { verified: false, reason: 'no-published-signing-key' };
  if (typeof signature !== 'string' || !signature) return { verified: false, reason: 'no-signature' };
  let sigBytes, keyBytes;
  try {
    sigBytes = Buffer.from(signature, 'base64');
    keyBytes = Buffer.from(signingPublicKey, 'base64');
  } catch {
    return { verified: false, reason: 'undecodable' };
  }
  try {
    const verified = verifyEs256({
      payload: mandate,
      signature: sigBytes,
      publicKey: keyBytes,
      encoding,
      field: AP2_SIGNATURE_FIELD,
    });
    return verified ? { verified: true } : { verified: false, reason: 'signature-mismatch' };
  } catch (e) {
    // A malformed KEY (not a bad signature) throws in the core; surface it as its own
    // reason rather than reporting "not the subject's signature".
    return { verified: false, reason: `key-error:${String(e && e.message || e)}` };
  }
}

/** The exact bytes the phone is asked to sign — exported so a caller/test can assert the
 *  server and phone agree on them. */
export function mandateSigningInput(mandate) {
  return signingInput(mandate, { field: AP2_SIGNATURE_FIELD });
}

/**
 * Deposit a SIGN REQUEST and wake the device. Returns
 * { deposited, request_id, window_ms, expires_at } or { deposited:false, reason }.
 */
export async function depositSignRequest(pairing, mandate, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  if (!pairing || !pairing.pair_key) return { deposited: false, reason: 'unpaired' };
  if (!pairing.relay_device_id) return { deposited: false, reason: 'no-relay-device-id' };
  if (!mandate || typeof mandate !== 'object') return { deposited: false, reason: 'no-mandate' };
  // A mandate that already carries a signature must not be re-sent for signing.
  if (mandate.signature != null) return { deposited: false, reason: 'already-signed' };

  const windowMs = Math.max(1000, Number(deps.windowMs) || 5 * 60 * 1000);
  const relayBase = deps.relayBase || relayBaseFromEnv();
  const requestId = deps.requestId || genRequestId();
  try {
    const body = await buildSignRequestDeposit(pairing.pair_key, requestId, mandate, { windowMs });
    const res = await fetchFn(`${relayBase}/escalation/${encodeURIComponent(pairing.relay_device_id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...relayAuthHeader(pairing) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.depositTimeoutMs || 8000),
    });
    if (!res || !res.ok) return { deposited: false, reason: `deposit-failed-${res && res.status}`, request_id: requestId };
    let info = {};
    try { info = await res.json(); } catch { /* body optional */ }
    return { deposited: true, request_id: requestId, window_ms: windowMs, expires_at: info.expires_at, woke: info.woke };
  } catch (e) {
    return { deposited: false, reason: `deposit-error:${String(e && e.message || e)}`, request_id: requestId };
  }
}

/**
 * Poll ONCE for a signed mandate. Returns:
 *   { resolved:true, signed:true, mandate }             — signature verified; mandate now carries it
 *   { resolved:true, signed:false, reason:'refused' }   — the subject declined to sign
 *   { resolved:true, signed:false, reason:'verify-failed', detail } — a response arrived but did not verify
 *   { resolved:false, status:'pending' | 'expired' }
 * Never throws. A verify failure is resolved-but-unsigned, never silently treated as signed.
 */
export async function pollSignOnce(pairing, requestId, mandate, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  if (!pairing || !pairing.pair_key || !requestId) return { resolved: false, status: 'expired', reason: 'bad-args' };
  if (deps.expiresAt && (deps.now ? deps.now() : Date.now()) > deps.expiresAt) return { resolved: false, status: 'expired' };
  const relayBase = deps.relayBase || relayBaseFromEnv();
  let body = null;
  try {
    const res = await fetchFn(`${relayBase}/escalation/response/${encodeURIComponent(requestId)}`, {
      headers: relayAuthHeader(pairing),
      signal: AbortSignal.timeout(deps.pollTimeoutMs || 8000),
    });
    if (res && res.ok) body = await res.json();
  } catch { /* transient */ }
  if (!body) return { resolved: false, status: 'pending' };

  const data = await unwrapSignResponse(pairing.pair_key, body);
  if (!data) return { resolved: false, status: 'pending' };   // undecryptable → keep waiting, don't crash

  if (data.refused === true) {
    return { resolved: true, signed: false, reason: 'refused', request_id: requestId };
  }

  const check = verifySignedMandate({
    mandate,
    signature: data.signature,
    encoding: data.encoding || 'der',
    signingPublicKey: deps.signingPublicKey,
  });
  if (!check.verified) {
    return { resolved: true, signed: false, reason: 'verify-failed', detail: check.reason, request_id: requestId };
  }
  return {
    resolved: true,
    signed: true,
    request_id: requestId,
    mandate: { ...mandate, signature: data.signature, signature_encoding: data.encoding || 'der',
               signed_at: typeof data.signed_at === 'string' ? data.signed_at : undefined },
  };
}
