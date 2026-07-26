// §8.3 signing audit — "what did I sign, and when."
//
// A signed mandate is a CREDENTIAL asserted to a third party, so minting one is at least as
// audit-worthy as a consultation. But it is NOT a §10.6 consultation receipt: it has no
// signal, no deference level, and it must not feed the act-as-me learning loop or the
// agreement-rate metric (which would corrupt both). So this is its OWN small append-only,
// encrypted-at-rest log — the same atomic-write + domain-separated-key discipline as
// receipts.js, but a separate artifact.
//
// It records a DIGEST of what was signed plus coarse metadata (grant count, expiry,
// requesting client) — never the full mandate, never the signature bytes. The digest is the
// stable reference: given the mandate later, an auditor recomputes it and confirms it is the
// object that was signed.

import { mkdir, writeFile, readFile, rename, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';
import { Phaedo } from './lib/phaedo-crypto.js';
import { getOrCreateCacheKey } from './cache.js';
import { signingInput } from './signing.js';

const { Envelope } = Phaedo;

export const SIGNING_AUDIT_CONTEXT = 'phaedo:signing-audit:enc:v0.1';
export const DEFAULT_CAP = 5000;
const FILE = 'signing-audit.enc';

function auditPath(stateDir) { return join(stateDir, FILE); }

async function deriveKey(stateDir) {
  const root = await getOrCreateCacheKey(stateDir);
  const ikm = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(SIGNING_AUDIT_CONTEXT) },
    ikm, 32 * 8,
  );
  return new Uint8Array(bits);
}

async function readStore(stateDir) {
  const p = auditPath(stateDir);
  if (!existsSync(p)) return { records: [] };
  const key = await deriveKey(stateDir);
  const { envelope } = JSON.parse(await readFile(p, 'utf8'));
  const plaintext = await Envelope.unwrap(envelope, key);
  try {
    const store = JSON.parse(new TextDecoder().decode(plaintext));
    return Array.isArray(store?.records) ? store : { records: [] };
  } finally {
    plaintext.fill(0);
  }
}

async function writeStore(stateDir, store, now) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const key = await deriveKey(stateDir);
  const plaintext = new TextEncoder().encode(JSON.stringify(store));
  const envelope = await Envelope.wrap(plaintext, key, {
    artifact_kind: 'signing_audit',
    count: store.records.length,
    created_at: new Date(now).toISOString(),
  });
  plaintext.fill(0);
  const p = auditPath(stateDir);
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify({ envelope }), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, p);   // atomic on POSIX
}

/**
 * Build a signing-audit record from a signed mandate. Records the digest of the SIGNED bytes
 * (§6 canonical form, `signature` omitted) — not the mandate content and not the signature.
 */
export function buildSigningAuditRecord({ requestId, mandate, clientId, agentId, now = Date.now() }) {
  const digest = createHash('sha256').update(signingInput(mandate, { field: 'signature' })).digest('base64url');
  const grants = Array.isArray(mandate?.grants) ? mandate.grants.length : 0;
  return {
    audit_id: randomUUID(),
    signed_at: typeof mandate?.signed_at === 'string' ? mandate.signed_at : new Date(now).toISOString(),
    request_id: typeof requestId === 'string' ? requestId : null,
    // WHO the credential was minted for: the paired client that served the ceremony.
    client_id: typeof clientId === 'string' && clientId ? clientId : null,
    // WHO claimed to ask (self-asserted, audit label only — mirrors §10.6).
    agent_id: typeof agentId === 'string' && agentId ? agentId : null,
    mandate_digest: digest,
    grant_count: grants,
    mandate_expires_at: typeof mandate?.expires_at === 'string' ? mandate.expires_at : null,
  };
}

let _chain = Promise.resolve();
/**
 * Append a signing-audit record. Serialized per process (like receipts) so two concurrent
 * signs can't clobber the store. Best-effort by contract at the call site: a failed audit
 * write must never make a real signature look unsigned — the caller logs and continues.
 */
export async function appendSigningAudit(stateDir, record, { cap = DEFAULT_CAP, now = Date.now() } = {}) {
  _chain = _chain.then(async () => {
    const store = await readStore(stateDir).catch(() => ({ records: [] }));
    store.records.push(record);
    if (store.records.length > cap) store.records = store.records.slice(-cap);
    await writeStore(stateDir, store, now);
  });
  return _chain;
}

export async function readSigningAudit(stateDir) {
  return (await readStore(stateDir).catch(() => ({ records: [] }))).records;
}
