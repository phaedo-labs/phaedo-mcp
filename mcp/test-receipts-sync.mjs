// receipts-sync.js — the G1+G2 audit channel (MCP ↔ phone).
//
// Locks: buildReceiptsDeposit produces a §10.4-safe digest under fp_sync_key; the digest
// strips `drivers` (local provenance) but keeps the fields the phone needs to render;
// parseMarksDeposit round-trips a phone-deposited marks batch; the digest envelope is
// ciphertext on the wire; deposit/drain are best-effort (never throw on transport failure).

import assert from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';
import {
  buildReceiptsDeposit,
  parseMarksDeposit,
  depositReceiptsDigest,
  drainAndApplyMarks,
} from './receipts-sync.js';
import { appendReceipt, buildReceipt, readReceipts } from './receipts.js';

const { Kdf, Envelope } = Phaedo;
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const PAIR_KEY_B64 = b64uEnc(new Uint8Array(32).fill(7));   // deterministic per-run pair_key

// --- buildReceiptsDeposit: §10.4-safe digest sealed under fp_sync_key ---
console.log('\nbuildReceiptsDeposit (digest round-trip)');
{
  const r1 = buildReceipt({
    via: 'phaedo_consult', agentId: 'agent-A',
    request: { consultation_type: 'action_approval', action_descriptor: { domain: 'financial', reversible: false, magnitude: 'high', amount: 12000, summary: 'wire $12k' } },
    response: { signal: 'escalate', confidence: 0.78, deference_level: 'high' },
    drivers: [{ cue: 'irreversibleCaution', lean: 0.6, confidence: 0.8, basis: 'observed' }],
  });
  const r2 = buildReceipt({
    via: 'phaedo_escalate', agentId: 'agent-B',
    request: { consultation_type: 'action_approval', action_descriptor: { domain: 'writing', reversible: true, magnitude: 'low' } },
    response: { signal: 'proceed', confidence: 0.55, deference_level: 'medium' },
  });
  const { envelope } = await buildReceiptsDeposit(PAIR_KEY_B64, [r1, r2]);
  ok(envelope && envelope.ciphertext && envelope.iv, 'deposit produces an envelope with ciphertext + iv');
  ok(envelope.metadata?.artifact_kind === 'receipts_digest', 'envelope metadata carries the receipts_digest artifact_kind');
  // Ciphertext-only on the wire: serialize and confirm no plaintext fields leak.
  const wire = JSON.stringify(envelope);
  ok(!wire.includes('escalate') && !wire.includes('agent-A') && !wire.includes('wire $12k'), 'wire form is ciphertext only (no signal/agent/summary leaked)');

  // Decrypt with the SAME fp_sync_key the phone would derive, and confirm the digest
  // shape is §10.4-safe: includes the renderable fields, EXCLUDES drivers.
  const pairKey = new Uint8Array(32).fill(7);
  const fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  const plaintext = await Envelope.unwrap(envelope, fpSyncKey);
  const inner = JSON.parse(new TextDecoder().decode(plaintext));
  ok(inner.kind === 'receipts_digest', 'inner kind === receipts_digest');
  ok(Array.isArray(inner.data?.receipts) && inner.data.receipts.length === 2, 'digest carries both receipts');
  const d1 = inner.data.receipts.find((r) => r.receipt_id === r1.receipt_id);
  ok(d1, 'first receipt is present in digest');
  ok(d1.response?.signal === 'escalate' && d1.request?.action_descriptor?.summary === 'wire $12k', 'render fields preserved');
  ok(!('drivers' in d1), 'drivers (local provenance) stripped from digest — §10.4 boundary holds toward the phone');
  ok(d1.user_action === null, 'digest carries user_action so the phone can show already-marked entries');
}

// --- parseMarksDeposit: phone → MCP marks round-trip ---
console.log('\nparseMarksDeposit (marks payload round-trip)');
{
  const pairKey = new Uint8Array(32).fill(7);
  const fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  const marks = [
    { receipt_id: 'r-001', outcome: 'approved' },
    { receipt_id: 'r-002', outcome: 'rejected' },
    { receipt_id: 'r-003', outcome: 'modified' },
    { receipt_id: 'r-004', outcome: 'bogus' },        // ignored — not in USER_ACTIONS
    { receipt_id: '',      outcome: 'approved' },     // ignored — empty receipt_id
  ];
  const inner = { kind: 'receipt_marks', data: { marks } };
  const plaintext = new TextEncoder().encode(JSON.stringify(inner));
  const envelope = await Envelope.wrap(plaintext, fpSyncKey, { artifact_kind: 'receipt_marks', created_at: new Date().toISOString() });

  const parsed = await parseMarksDeposit(PAIR_KEY_B64, envelope);
  ok(parsed && Array.isArray(parsed.marks), 'parse returns a marks array');
  ok(parsed.marks.length === 3, 'invalid marks (bad outcome / missing id) filtered out');
  ok(parsed.marks.every((m) => m.receipt_id && m.outcome), 'every surviving mark has both fields');
  ok(parsed.marks.map((m) => m.outcome).sort().join(',') === 'approved,modified,rejected', 'all three valid outcomes preserved');

  // Wrong key (or wrong artifact_kind) → null, never throws.
  ok((await parseMarksDeposit(PAIR_KEY_B64, null)) === null, 'null envelope → null');
  // A receipts_digest envelope is NOT a marks payload: the inner kind check rejects it.
  const wrongInner = new TextEncoder().encode(JSON.stringify({ kind: 'receipts_digest', data: {} }));
  const wrongEnv = await Envelope.wrap(wrongInner, fpSyncKey, { artifact_kind: 'receipts_digest', created_at: new Date().toISOString() });
  ok((await parseMarksDeposit(PAIR_KEY_B64, wrongEnv)) === null, 'wrong inner.kind → null (not a marks payload)');
}

// --- depositReceiptsDigest: best-effort, no-throw on missing pairing/relay ---
console.log('\ndepositReceiptsDigest (best-effort isolation)');
{
  ok((await depositReceiptsDigest(null, [])).deposited === false, 'no pairing → not deposited (does not throw)');
  ok((await depositReceiptsDigest({ pair_key: PAIR_KEY_B64 }, [])).reason === 'no-receipts', 'no receipts → not deposited');
  ok((await depositReceiptsDigest({ pair_key: PAIR_KEY_B64 }, [{ receipt_id: 'x' }])).reason === 'no-relay-device-id', 'no relay device id → not deposited');

  // Stubbed fetch: confirm the URL targets the agent_to_phone slot and carries the envelope.
  let captured = null;
  const fakeFetch = async (url, init) => { captured = { url, init }; return { ok: true, status: 200 }; };
  const res = await depositReceiptsDigest(
    { pair_key: PAIR_KEY_B64, relay_device_id: 'devX', relay_device_secret: 's3cret' },
    [{ receipt_id: 'r1', created_at: '2026-06-25T00:00:00Z', via: 'phaedo_consult', request: {}, response: { signal: 'proceed' } }],
    { fetch: fakeFetch, relayBase: 'https://relay.example' },
  );
  ok(res.deposited === true, 'success path returns deposited:true');
  ok(captured.url.endsWith('/fp-mailbox/devX/agent_to_phone'), 'POST targets the agent_to_phone slot');
  ok(captured.init.headers.Authorization === 'Bearer devX:s3cret', 'carries the per-device auth header');
  const body = JSON.parse(captured.init.body);
  ok(body.envelope && body.envelope.ciphertext && body.envelope.iv, 'request body is the ciphertext envelope');
}

// --- drainAndApplyMarks: end-to-end (encrypted marks → markOutcome → receipt updated) ---
console.log('\ndrainAndApplyMarks (apply phone-deposited marks)');
{
  const stateDir = await mkdtemp(join(tmpdir(), 'phaedo-rs-test-'));
  // Seed two real receipts so markOutcome has something to match.
  const r1 = buildReceipt({ via: 'phaedo_consult', agentId: 'a', request: { consultation_type: 'action_approval' }, response: { signal: 'proceed', confidence: 0.5, deference_level: 'low' } });
  const r2 = buildReceipt({ via: 'phaedo_consult', agentId: 'a', request: { consultation_type: 'action_approval' }, response: { signal: 'escalate', confidence: 0.8, deference_level: 'high' } });
  await appendReceipt(stateDir, r1);
  await appendReceipt(stateDir, r2);

  // Phone-side: seal a marks batch under fp_sync_key.
  const pairKey = new Uint8Array(32).fill(7);
  const fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  const inner = { kind: 'receipt_marks', data: { marks: [
    { receipt_id: r1.receipt_id, outcome: 'approved' },
    { receipt_id: r2.receipt_id, outcome: 'rejected' },
    { receipt_id: 'unknown',     outcome: 'approved' },     // matched=false → skipped
  ] } };
  const plaintext = new TextEncoder().encode(JSON.stringify(inner));
  const envelope = await Envelope.wrap(plaintext, fpSyncKey, { artifact_kind: 'receipt_marks', created_at: new Date().toISOString() });

  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ envelope }) });
  const res = await drainAndApplyMarks(
    { pair_key: PAIR_KEY_B64, relay_device_id: 'devX', relay_device_secret: 's3cret' },
    stateDir,
    { fetch: fakeFetch, relayBase: 'https://relay.example' },
  );
  ok(res.applied === 2 && res.skipped === 1, 'two marks applied, one (unknown id) skipped');

  const after = await readReceipts(stateDir);
  const after1 = after.find((r) => r.receipt_id === r1.receipt_id);
  const after2 = after.find((r) => r.receipt_id === r2.receipt_id);
  ok(after1.user_action === 'approved', 'mark applied to r1');
  ok(after2.user_action === 'rejected', 'mark applied to r2');

  // Re-draining the same envelope is idempotent (markOutcome on same value is a no-op).
  const again = await drainAndApplyMarks(
    { pair_key: PAIR_KEY_B64, relay_device_id: 'devX', relay_device_secret: 's3cret' },
    stateDir,
    { fetch: fakeFetch, relayBase: 'https://relay.example' },
  );
  ok(again.applied === 2 && again.skipped === 1, 're-drain produces the same result (idempotent)');
}

// --- isolation: a transport failure NEVER throws into the caller ---
console.log('\ndrainAndApplyMarks (transport failure isolation)');
{
  const stateDir = await mkdtemp(join(tmpdir(), 'phaedo-rs-test-iso-'));
  const errFetch = async () => { throw new Error('econn-reset'); };
  const res = await drainAndApplyMarks(
    { pair_key: PAIR_KEY_B64, relay_device_id: 'devX', relay_device_secret: 's3cret' },
    stateDir,
    { fetch: errFetch, relayBase: 'https://relay.example' },
  );
  ok(res.applied === 0 && typeof res.reason === 'string', 'transport throw caught — applied:0, reason set');
}

console.log(`\n✓ receipts-sync: ${pass} checks passed`);
