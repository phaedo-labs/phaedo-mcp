// Fingerprint source for the Phaedo MCP server. The server depends only on
// loadFingerprint()'s return shape, so the source swaps without touching the
// tool/resource code. Two modes, auto-selected:
//
//   Phase 1b (phone): if a pairing record is configured (PHAEDO_PAIRING or
//     mcp/pairing.json), authorize → pull /v1/profile → unwrap the §7.2 envelope
//     from the paired phone (phone-source.js). Spec-faithful; no plaintext at rest.
//   Phase 1a (local): otherwise read a local vault-payload JSON (or the shipped
//     sample) — the decoupled stand-in that runs out of the box.

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { hasPairingRecord, loadPairingRecord, loadFingerprintFromPhone, PhoneError } from './phone-source.js';
import { defaultStateDir, writeCache, readCache, clearCache } from './cache.js';

// §4.1 protocol-identity normalization (consumer defense-in-depth, 2026-06-16).
// A stored fingerprint from a producer that predates identity stamping (or whose
// phone copy was never re-persisted) can arrive missing the REQUIRED §4.1 fields
// — `npm run health` surfaced exactly this on a live fingerprint. The
// deterministic ones (phaedo_protocol_version, schema_revision) are safe for any
// consumer to ensure; subject_id falls back to the existing, stable, non-PII
// `fingerprint_id` when absent, rather than minting a value that would churn on
// every load. This makes the reference server serve §4.1-conformant fingerprints
// regardless of producer staleness. Source cleanup (re-persisting these on the
// phone) remains the producer's job. SEMANTIC hygiene (episodic/opaque content)
// is deliberately NOT masked here: health keeps surfacing it as an honest
// producer signal, and context-block's render guard protects the AI projection.
const IDENTITY_PROTOCOL_VERSION = '0.1';
const IDENTITY_SCHEMA_REVISION = 1;
function normalizeIdentity(vd) {
  const fp = vd && vd.phaedo_fingerprint;
  if (!fp || typeof fp !== 'object') return vd;
  const patch = {};
  if (fp.phaedo_protocol_version === undefined) patch.phaedo_protocol_version = IDENTITY_PROTOCOL_VERSION;
  if (fp.schema_revision === undefined) patch.schema_revision = IDENTITY_SCHEMA_REVISION;
  if (fp.subject_id === undefined && typeof fp.fingerprint_id === 'string' && fp.fingerprint_id) patch.subject_id = fp.fingerprint_id;
  if (!Object.keys(patch).length) return vd;
  return { ...vd, phaedo_fingerprint: { ...fp, ...patch } };
}

// Resolution order for the local fixture (1a):
//   1. PHAEDO_FINGERPRINT env var (absolute or cwd-relative path)
//   2. ./fingerprint.json next to the server
//   3. ./sample-fingerprint.json (shipped demo fixture)
function resolveSourcePath(baseDir) {
  if (process.env.PHAEDO_FINGERPRINT) return resolve(process.cwd(), process.env.PHAEDO_FINGERPRINT);
  return resolve(baseDir, 'fingerprint.json');
}

// Returns the vault payload:
//   { phaedo_fingerprint, phaedo_behavioral_signals, phaedo_linguistic_profile,
//     phaedo_session_metrics }
// Throws on unreadable/invalid source — the tool layer maps that to
// decryption_failed (the §9.5 "couldn't obtain plaintext fingerprint" case).
export async function loadFingerprint(baseDir) {
  // Explicit local source wins over phone pairing: if PHAEDO_FINGERPRINT names a
  // file, honor it and skip the phone entirely. Pointing at a concrete fingerprint
  // is an unambiguous "use THIS" — it lets a user force a local file and makes the
  // server hermetic for tests on a phone-paired dev machine (where pairing.json +
  // an isolated state dir would otherwise pull from an unreachable phone with no
  // cache to fall back to).
  if (!process.env.PHAEDO_FINGERPRINT && hasPairingRecord(baseDir)) {
    // Phase 1b: a configured pairing record means pull the live fingerprint from
    // the paired phone over the encrypted boundary (no plaintext at rest). On
    // success, refresh the encrypted at-rest cache; if the phone is unreachable,
    // serve the cache so the server still works phone-absent (frictionless default).
    const rec = await loadPairingRecord(baseDir);
    const stateDir = defaultStateDir();
    try {
      const vd = await loadFingerprintFromPhone(rec);
      await writeCache(stateDir, vd);
      return normalizeIdentity(vd);
    } catch (err) {
      // A 4xx means the phone REACHED us and rejected this client (revoked /
      // invalid credentials / failed handshake). Revocation must be effective:
      // purge the at-rest cache and fail, so a revoked agent can't keep serving a
      // cached copy. Only a transient/unreachable failure (network, timeout, 5xx)
      // falls back to the cache — the phone-absent design (1b-iii).
      if (err instanceof PhoneError && err.status >= 400 && err.status < 500) {
        await clearCache(stateDir);
        throw err;
      }
      const cached = await readCache(stateDir);
      if (cached) return normalizeIdentity(cached.vault); // phone unreachable → encrypted cache (may be stale)
      throw err;                        // no phone + no cache → cannot serve
    }
  }

  const path = resolveSourcePath(baseDir);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // Fall back to the shipped sample so a fresh checkout runs out of the box.
    raw = await readFile(resolve(baseDir, 'sample-fingerprint.json'), 'utf8');
  }
  const vd = JSON.parse(raw);
  if (!vd || typeof vd !== 'object' || !vd.phaedo_fingerprint) {
    throw new Error(`Fingerprint source at ${path} is missing phaedo_fingerprint.`);
  }
  return normalizeIdentity(vd);
}

// Like loadFingerprint, but PREFERS the at-rest encrypted cache over a live phone pull.
// Used by the escalation path so reading the fingerprint (to compute the consult signal)
// doesn't trigger a SECOND prompt — the fingerprint-read AUTHORIZE — on top of the
// escalation decision card the subject already answers. One prompt per escalation, not two.
//
// The cache is seeded + refreshed by the normal live-pull consults, so it stays current; a
// consult SIGNAL tolerates a slightly-stale fingerprint (it doesn't change minute to minute).
// Falls back to a live pull only when no cache exists yet (first run on this machine), which
// seeds it. Revocation safety is unaffected: a revoked MCP's escalation can't be decrypted by
// the phone anyway (its client entry is gone), so it never reaches the subject regardless of
// what the MCP read locally.
// Like loadFingerprint, but PREFERS the at-rest encrypted cache over a live phone pull.
// Used by the escalation path so reading the fingerprint (to compute the consult signal)
// NEVER triggers an interactive fingerprint-read AUTHORIZE on top of the escalation
// decision card. One prompt per escalation — the decision — not two, and critically no
// authorize modal racing the decision modal on the phone (that double-present crashed iOS).
//
// Uses ANY decryptable cache regardless of age. Revocation is enforced PHONE-SIDE for the
// escalation path: a revoked agent's escalation can't be decrypted by the phone (its client
// registry entry is gone), so reading a stale cache here yields nothing the agent can
// actually deliver to the subject. (The normal consult path — loadFingerprint — still does
// the live pull with its 4xx-purge revocation, so a revoked agent stops getting fresh reads
// there.) Falls through to a live pull ONLY when no cache exists at all (first run on this
// machine), which seeds it; run one phaedo_consult after pairing to seed without an
// escalation in flight.
export async function loadFingerprintPreferCache(baseDir) {
  if (!process.env.PHAEDO_FINGERPRINT && hasPairingRecord(baseDir)) {
    const cached = await readCache(defaultStateDir());
    if (cached) return normalizeIdentity(cached.vault);
  }
  return loadFingerprint(baseDir);
}
