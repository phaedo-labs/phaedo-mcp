// 1b-i smoke test: the server's authorize → pull → decrypt path end to end,
// against a mock phone (shared helper) speaking the real protocol — no device.
//
// Run: node test-phone-boundary.mjs   (from mcp/)

import assert from 'assert';
import { b64uEnc } from './lib/phaedo-crypto.js';
import { loadFingerprintFromPhone, toVaultPayload, _clearSessions } from './phone-source.js';
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

// 6. §5 sibling mapping (config home migration, part 3): a phone serving
// user_configuration lands it at phaedo_user_configuration; a pre-part-3 phone
// (no field) leaves the key absent so consumers fall back to the A-home.
{
  const cfg = { configuration_id: 'c1', fingerprint_id: 'fp-boundary-1', standing_instructions: [] };
  const withCfg = toVaultPayload({ data: { fingerprint_id: 'fp-boundary-1' }, user_configuration: cfg, metrics: {} });
  ok(withCfg.phaedo_user_configuration === cfg, 'profile user_configuration maps to phaedo_user_configuration');
  const without = toVaultPayload({ data: { fingerprint_id: 'fp-boundary-1' }, metrics: {} });
  ok(!('phaedo_user_configuration' in without), 'absent sibling → key absent (A-home fallback preserved)');
  ok(!('phaedo_user_configuration' in toVaultPayload({ data: {}, user_configuration: 'junk', metrics: {} })), 'non-object sibling is dropped, not forwarded');
}

// ── §8.3 signing public key: a sibling, carried through, never trusted from `data` ────
{
  const key = 'BFj7q2exampleX963pointbase64';
  const withKey = toVaultPayload({ data: { fingerprint_id: 'fp-1' }, signing_public_key: key, metrics: {} });
  ok(withKey.phaedo_signing_public_key === key, 'signing_public_key maps to phaedo_signing_public_key');

  const without = toVaultPayload({ data: { fingerprint_id: 'fp-1' }, metrics: {} });
  ok(!('phaedo_signing_public_key' in without), 'absent key → field absent (pre-§8.3 phone unaffected)');

  ok(!('phaedo_signing_public_key' in toVaultPayload({ data: {}, signing_public_key: 42, metrics: {} })),
    'non-string key is dropped, not coerced');
  ok(!('phaedo_signing_public_key' in toVaultPayload({ data: {}, signing_public_key: '', metrics: {} })),
    'empty-string key is dropped');
  // The key must come from the trusted SIBLING, never from inside the fingerprint the
  // phone could have received from anywhere — a signing_public_key hidden in `data` must
  // not be promoted to the field a verifier trusts.
  ok(!('phaedo_signing_public_key' in toVaultPayload({ data: { signing_public_key: 'attacker' }, metrics: {} })),
    'a key inside data is NOT promoted — only the sibling is trusted');
}

// ── readServingClientId: the §10.5 `agents` identity, read at startup ─────────
// Every failure mode must yield null, because null makes an `agents`-scoped RELAXING
// rule INERT. A broken read can therefore only withhold authority, never grant it —
// which is the whole reason this reader is allowed to be this forgiving.
{
  const { readServingClientId } = await import('./phone-source.js');
  const { mkdtemp, writeFile } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = await mkdtemp(join(tmpdir(), 'phaedo-clientid-'));
  const prevEnv = process.env.PHAEDO_PAIRING;
  delete process.env.PHAEDO_PAIRING;

  ok(readServingClientId(dir) === null, 'no pairing file → null (unpaired, scoped relaxing rules inert)');

  await writeFile(join(dir, 'pairing.json'), JSON.stringify({ endpoint: 'x', client_id: 'c_ATFQrFdTjo', client_secret: 's', pair_key: 'k' }));
  ok(readServingClientId(dir) === 'c_ATFQrFdTjo', 'client_id read from the pairing record');

  await writeFile(join(dir, 'pairing.json'), JSON.stringify({ client_id: '  c_Padded  ' }));
  ok(readServingClientId(dir) === 'c_Padded', 'client_id is trimmed');

  await writeFile(join(dir, 'pairing.json'), '{ not json');
  ok(readServingClientId(dir) === null, 'malformed pairing file → null, never throws');

  await writeFile(join(dir, 'pairing.json'), JSON.stringify({ endpoint: 'x' }));
  ok(readServingClientId(dir) === null, 'pairing record with no client_id → null');

  await writeFile(join(dir, 'pairing.json'), JSON.stringify({ client_id: 12345 }));
  ok(readServingClientId(dir) === null, 'non-string client_id → null, never coerced');

  await writeFile(join(dir, 'pairing.json'), JSON.stringify({ client_id: '   ' }));
  ok(readServingClientId(dir) === null, 'whitespace-only client_id → null');

  if (prevEnv === undefined) delete process.env.PHAEDO_PAIRING; else process.env.PHAEDO_PAIRING = prevEnv;
}

close();
console.log(`\nALL GREEN — ${pass} checks passed (mock-phone authorize → pull → decrypt → project)`);
