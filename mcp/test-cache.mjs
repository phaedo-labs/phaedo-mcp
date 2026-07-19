// 1b-iii test: the encrypted at-rest cache + phone-absent fallback.
//
//   - writeCache/readCache round-trip; cache file is ciphertext-only; 0600 perms
//   - undecryptable cache → null (recoverable from the phone)
//   - loadFingerprint: phone unreachable → serves the encrypted cache
//   - loadFingerprint: phone unreachable + no cache → throws
//   - loadFingerprint: phone reachable → pulls fresh AND refreshes the cache
//
// Run: node test-cache.mjs   (from mcp/)

import assert from 'assert';
import { mkdtemp, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { writeCache, readCache } from './cache.js';
import { loadFingerprint, loadFingerprintPreferCache } from './fingerprint-source.js';
import { _clearSessions } from './phone-source.js';
import { startMockPhone, SAMPLE_FP, SAMPLE_METRICS } from './test-helpers/mock-phone.mjs';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const tmp = (p) => mkdtemp(join(tmpdir(), p));
const b64uKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

const payload = {
  phaedo_fingerprint: SAMPLE_FP,
  phaedo_behavioral_signals: { surface: { too_long: 2 } },
  phaedo_linguistic_profile: { messageCount: 40 },
  phaedo_session_metrics: { sessionCount: 4 },
};

// ── Part 1: round-trip + ciphertext-only + perms ─────────────────────────────
const s1 = await tmp('phaedo-mcp-s1-');
await writeCache(s1, payload);
const back = await readCache(s1);
ok(back && back.vault.phaedo_fingerprint.fingerprint_id === 'fp-boundary-1', 'cache round-trips');
ok(back.vault.phaedo_linguistic_profile.messageCount === 40, 'cache preserves metrics');

const raw = await readFile(join(s1, 'cache.enc'), 'utf8');
ok(!raw.includes('Thorough'), 'cache file holds NO plaintext answer (ciphertext only)');
ok(!raw.includes('Communication style'), 'cache file holds no plaintext layer labels');
ok((( await stat(join(s1, 'cache.key'))).mode & 0o777) === 0o600, 'key file is 0600');
ok((( await stat(join(s1, 'cache.enc'))).mode & 0o777) === 0o600, 'cache file is 0600');

// wrong key → undecryptable → null
const s2 = await tmp('phaedo-mcp-s2-');
await writeCache(s2, payload);
await writeFile(join(s2, 'cache.key'), b64uKey(), { mode: 0o600 });
ok((await readCache(s2)) === null, 'undecryptable cache → null (recoverable from phone)');

// ── Part 2: phone-absent fallback via loadFingerprint ────────────────────────
const baseAbsent = await tmp('phaedo-mcp-base1-');
const stateAbsent = await tmp('phaedo-mcp-cache1-');
process.env.PHAEDO_MCP_STATE_DIR = stateAbsent;
await writeFile(join(baseAbsent, 'pairing.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:1', client_id: 'x', client_secret: 'y', pair_key: b64uKey() }));
await writeCache(stateAbsent, payload); // as if a prior pull succeeded
_clearSessions();
const served = await loadFingerprint(baseAbsent);
ok(served.phaedo_fingerprint.fingerprint_id === 'fp-boundary-1', 'phone unreachable → serves encrypted cache');

// no cache + no phone → throws
const baseNo = await tmp('phaedo-mcp-base2-');
const stateNo = await tmp('phaedo-mcp-cache2-');
process.env.PHAEDO_MCP_STATE_DIR = stateNo;
await writeFile(join(baseNo, 'pairing.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:1', client_id: 'x', client_secret: 'y', pair_key: b64uKey() }));
_clearSessions();
let threw = null;
try { await loadFingerprint(baseNo); } catch (e) { threw = e; }
ok(threw !== null, 'phone unreachable + no cache → throws');

// ── Part 3: phone reachable → pulls fresh AND refreshes the cache ────────────
const pairKey = crypto.getRandomValues(new Uint8Array(32));
const { rec, close } = await startMockPhone({ pairKey, sampleFp: SAMPLE_FP, metrics: SAMPLE_METRICS });
const baseLive = await tmp('phaedo-mcp-base3-');
const stateLive = await tmp('phaedo-mcp-cache3-');
process.env.PHAEDO_MCP_STATE_DIR = stateLive;
await writeFile(join(baseLive, 'pairing.json'), JSON.stringify(rec));
_clearSessions();
const fresh = await loadFingerprint(baseLive);
ok(fresh.phaedo_fingerprint.fingerprint_id === 'fp-boundary-1', 'phone reachable → pulls fresh');
const after = await readCache(stateLive);
ok(after && after.vault.phaedo_fingerprint.fingerprint_id === 'fp-boundary-1', 'successful pull refreshes the cache');

// ── Part 4: loadFingerprintPreferCache (escalation) reads cache, no live pull ──
// Mark the cache distinctly; the phone is still reachable and would serve 'fp-boundary-1'.
// preferCache must return the MARKED cache → it never pulled → no fingerprint-read authorize.
const marked = JSON.parse(JSON.stringify(fresh));
marked.phaedo_fingerprint.fingerprint_id = 'fp-from-cache';
await writeCache(stateLive, marked);
_clearSessions();
const cachedRead = await loadFingerprintPreferCache(baseLive);
ok(cachedRead.phaedo_fingerprint.fingerprint_id === 'fp-from-cache', 'preferCache reads the at-rest cache even when the phone is reachable (no extra authorize prompt)');

// preferCache uses ANY decryptable cache regardless of age — it must NEVER trigger an
// interactive live authorize during an escalation (that authorize modal racing the
// decision modal crashed iOS). Revocation for the escalation path is enforced phone-side
// (a revoked agent's escalation can't be decrypted by the phone), so a stale cache here is
// safe. Even with the mock phone reachable + a long-aged cache, preferCache returns the cache.
const stale = JSON.parse(JSON.stringify(marked));
stale.phaedo_fingerprint.fingerprint_id = 'fp-stale-cache';
await writeCache(stateLive, stale, Date.now() - 365 * 24 * 60 * 60 * 1000); // a year old
_clearSessions();
const staleRead = await loadFingerprintPreferCache(baseLive);
ok(staleRead.phaedo_fingerprint.fingerprint_id === 'fp-stale-cache', 'preferCache uses an OLD cache (no live pull → no authorize prompt); escalation revocation is phone-side');
close();

delete process.env.PHAEDO_MCP_STATE_DIR;
console.log(`\nALL GREEN — ${pass} checks passed (encrypted at-rest cache + phone-absent fallback)`);
