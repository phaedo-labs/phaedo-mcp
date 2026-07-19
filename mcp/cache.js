// MCP Phase 1b-iii — encrypted at-rest fingerprint cache.
//
// So the server can serve injections when the phone is ABSENT (the frictionless
// default — desktop/CLI use where the phone often isn't reachable). Mirrors the
// extension's Option C: the fingerprint is cached as CIPHERTEXT under a
// server-held key. Defense-in-depth for a DERIVED cache only — NOT phone-gated,
// NOT forensic-grade: the device can decrypt itself, and the cache is always
// recoverable from the phone (re-pull) on loss.
//
// Key storage (v1): a 32-byte AES key in a 0600 file. Weaker than the extension's
// non-extractable WebCrypto key (the raw bytes are on disk), because Node has no
// IndexedDB-style non-extractable-key store that survives restarts. OS-keychain
// storage is the hardening follow-up. The cache file holds only ciphertext.

import { mkdir, readFile, writeFile, chmod, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Phaedo, b64uEnc, b64uDec } from './lib/phaedo-crypto.js';

const { Envelope } = Phaedo;

export function defaultStateDir() {
  return process.env.PHAEDO_MCP_STATE_DIR || join(homedir(), '.phaedo-mcp');
}

async function ensureDir(dir) { await mkdir(dir, { recursive: true, mode: 0o700 }); }

export async function getOrCreateCacheKey(stateDir) {
  await ensureDir(stateDir);
  const keyPath = join(stateDir, 'cache.key');
  if (existsSync(keyPath)) return b64uDec((await readFile(keyPath, 'utf8')).trim());
  const key = crypto.getRandomValues(new Uint8Array(32));
  await writeFile(keyPath, b64uEnc(key), { mode: 0o600 });
  await chmod(keyPath, 0o600);
  return key;
}

// Encrypt + persist the vault payload. `now` injectable for tests.
export async function writeCache(stateDir, vaultPayload, now = Date.now()) {
  const key = await getOrCreateCacheKey(stateDir);
  const plaintext = new TextEncoder().encode(JSON.stringify(vaultPayload));
  const envelope = await Envelope.wrap(plaintext, key, {
    artifact_kind: 'fingerprint',
    fingerprint_id: vaultPayload?.phaedo_fingerprint?.fingerprint_id || null,
    created_at: new Date(now).toISOString(),
  });
  plaintext.fill(0);
  const cachePath = join(stateDir, 'cache.enc');
  await writeFile(cachePath, JSON.stringify({ envelope, cached_at: now }), { mode: 0o600 });
  await chmod(cachePath, 0o600);
}

// Remove the at-rest cache. Used on revocation: a cached profile must not
// outlive authorization, so once the phone rejects this client the ciphertext
// copy is deleted (the cache is always re-pullable after a fresh pairing).
export async function clearCache(stateDir) {
  try { await rm(join(stateDir, 'cache.enc'), { force: true }); } catch { /* nothing to clear */ }
}

// Decrypt the cache → { vault, cachedAt } or null (absent/corrupt/undecryptable
// → treated as no cache, since it's recoverable from the phone).
export async function readCache(stateDir) {
  const cachePath = join(stateDir, 'cache.enc');
  if (!existsSync(cachePath)) return null;
  try {
    const key = await getOrCreateCacheKey(stateDir);
    const { envelope, cached_at } = JSON.parse(await readFile(cachePath, 'utf8'));
    const plaintext = await Envelope.unwrap(envelope, key);
    const vault = JSON.parse(new TextDecoder().decode(plaintext));
    plaintext.fill(0);
    return { vault, cachedAt: cached_at };
  } catch {
    return null;
  }
}
