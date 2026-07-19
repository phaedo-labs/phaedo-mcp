// 1b-i smoke test: the server's authorize → pull → decrypt path end to end,
// against a mock phone (shared helper) speaking the real protocol — no device.
//
// Run: node test-phone-boundary.mjs   (from mcp/)

import assert from 'assert';
import { b64uEnc } from './lib/phaedo-crypto.js';
import { loadFingerprintFromPhone, _clearSessions } from './phone-source.js';
import { buildInjectionResponse } from './projection.js';
import { startMockPhone, SAMPLE_FP, SAMPLE_METRICS } from './test-helpers/mock-phone.mjs';

const pairKey = crypto.getRandomValues(new Uint8Array(32));
const { rec, state, close } = await startMockPhone({ pairKey, sampleFp: SAMPLE_FP, metrics: SAMPLE_METRICS });

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
_clearSessions();

// 1. Full authorize → pull → decrypt → map
const vd = await loadFingerprintFromPhone(rec);
ok(vd.phaedo_fingerprint.fingerprint_id === 'fp-boundary-1', 'fingerprint decrypted from envelope');
ok(vd.phaedo_fingerprint.layers.surface.label === 'Communication style', 'layers present');
ok(vd.phaedo_behavioral_signals.surface.too_long === 2, 'metrics.signals → behavioral_signals');
ok(vd.phaedo_linguistic_profile.messageCount === 40, 'metrics.ling → linguistic_profile');
ok(vd.phaedo_session_metrics.sessionCount === 4, 'metrics.sessions → session_metrics');
ok(state.authorizeCount === 1, 'authorized once');

// 2. Session reuse — second pull does NOT re-authorize
await loadFingerprintFromPhone(rec);
ok(state.authorizeCount === 1, 'cached session reused (no re-auth)');

// 3. Projection renders from the phone-decrypted fingerprint (MCP === web injection)
const resp = buildInjectionResponse(vd, { requested_layers: ['all'] });
ok(resp.projection.startsWith('<phaedo_user_profile>'), 'projection renders from phone fingerprint');
ok(resp.projection.includes('Thorough'), 'projection contains the decrypted interview answer');

// 4. Stale session (phone restarted) → re-authorize exactly once
state.sessions.clear();
const vd2 = await loadFingerprintFromPhone(rec);
ok(vd2.phaedo_fingerprint.fingerprint_id === 'fp-boundary-1', 'recovered after stale session');
ok(state.authorizeCount === 2, 're-authorized once on 401');

// 5. Tamper detection — a wrong pair_key must not authorize
_clearSessions();
let tampered = null;
try {
  await loadFingerprintFromPhone({ ...rec, pair_key: b64uEnc(crypto.getRandomValues(new Uint8Array(32))) });
} catch (e) { tampered = e; }
ok(tampered !== null, 'wrong pair_key is rejected (authorize fails)');

close();
console.log(`\nALL GREEN — ${pass} checks passed (mock-phone authorize → pull → decrypt → project)`);
