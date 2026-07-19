// Revocation must invalidate the at-rest cache (1b-iii). Regression test for the
// gap Randy hit: after a successful pull caches the fingerprint, revoking the
// client on the phone (authorize → 401) must purge the cache and FAIL — not keep
// serving the cached copy. A genuinely-unreachable phone (network error) still
// falls back to the cache (the phone-absent design).

import { rmSync, mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startMockPhone, SAMPLE_FP, SAMPLE_METRICS } from './test-helpers/mock-phone.mjs';
import { loadFingerprint } from './fingerprint-source.js';
import { _clearSessions } from './phone-source.js';

const BASE = dirname(fileURLToPath(import.meta.url));
const cacheFile = (dir) => join(dir, 'cache.enc');

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  ✗', msg); } else console.log('  ✓', msg); };

const stateDir = mkdtempSync(join(tmpdir(), 'phaedo-mcp-revoke-'));
const pairingPath = join(stateDir, 'pairing.json');
process.env.PHAEDO_PAIRING = pairingPath;
process.env.PHAEDO_MCP_STATE_DIR = stateDir;

const pairKey = crypto.getRandomValues(new Uint8Array(32));

console.log('Revocation invalidates the at-rest cache:');

// 1. Live pull succeeds → cache written.
const phone1 = await startMockPhone({ pairKey, sampleFp: SAMPLE_FP, metrics: SAMPLE_METRICS });
writeFileSync(pairingPath, JSON.stringify(phone1.rec));
const vd1 = await loadFingerprint(BASE);
ok(vd1?.phaedo_fingerprint?.fingerprint_id === SAMPLE_FP.fingerprint_id, 'live pull succeeds');
ok(existsSync(cacheFile(stateDir)), 'at-rest cache written');

// 2. Phone unreachable (closed) → cache fallback still serves (phone-absent design).
_clearSessions();
phone1.close();
const vd2 = await loadFingerprint(BASE);
ok(vd2?.phaedo_fingerprint?.fingerprint_id === SAMPLE_FP.fingerprint_id, 'phone unreachable → served from cache');
ok(existsSync(cacheFile(stateDir)), 'cache retained while merely unreachable');

// 3. Phone reachable but REVOKED (401) → purge cache + throw (no cache fallback).
const phone2 = await startMockPhone({ pairKey, sampleFp: SAMPLE_FP, metrics: SAMPLE_METRICS });
phone2.state.revoked = true;
writeFileSync(pairingPath, JSON.stringify(phone2.rec));   // new port
_clearSessions();
let threw = false;
try { await loadFingerprint(BASE); } catch { threw = true; }
ok(threw, 'revoked (401) → loadFingerprint throws (does NOT serve the cache)');
ok(!existsSync(cacheFile(stateDir)), 'at-rest cache PURGED on revocation');

phone2.close();
rmSync(stateDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll revocation tests passed');
process.exit(failures ? 1 : 0);
