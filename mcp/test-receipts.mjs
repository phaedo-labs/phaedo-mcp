#!/usr/bin/env node
// §10.6 consultation receipts (M4): encrypted, append-only, vault-held.
//   - buildReceipt shape (request descriptor + response signals only; user_action null)
//   - append → ciphertext-only file, 0600; survives "restart" (fresh re-read)
//   - one receipt per resolution incl. ABSTAIN
//   - user_action is the ONLY mutation; other fields byte-identical after update
//   - eviction at cap (oldest first); no delete-one API exists
//   - DOMAIN SEPARATION: receipts.enc is NOT decryptable with the raw root key
// Run: node test-receipts.mjs   (from mcp/)

import assert from 'assert';
import { mkdtemp, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  buildReceipt, appendReceipt, updateUserAction, readReceipts,
  resolveReceiptSelector, markOutcome,
  receiptsCapFromEnv, USER_ACTIONS, DEFAULT_CAP, RECEIPTS_CONTEXT,
} from './receipts.js';
import { getOrCreateCacheKey } from './cache.js';
import { Phaedo } from './lib/phaedo-crypto.js';
import { resolveConsultationCore } from './consult-core.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const tmp = () => mkdtemp(join(tmpdir(), 'phaedo-receipts-'));

const REQ = {
  consultation_type: 'action_approval',
  agent_id: 'vendor_agent_v2.4',
  action_descriptor: { domain: 'financial', reversible: false, magnitude: 'high', amount: 12000, summary: 'Approve $12k vendor payment.' },
};
const RESP = { signal: 'escalate', confidence: 0.78, deference_level: 'high' };

// ── buildReceipt (pure) ───────────────────────────────────────────────────────
console.log('\nbuildReceipt');
const r1 = buildReceipt({ via: 'phaedo_consult', agentId: REQ.agent_id, request: REQ, response: RESP, now: 1765000000000 });
ok(/^[0-9a-f-]{36}$/.test(r1.receipt_id), 'receipt_id is a uuid');
ok(r1.created_at === new Date(1765000000000).toISOString(), 'created_at from injected now');
ok(r1.agent_id === 'vendor_agent_v2.4' && r1.via === 'phaedo_consult', 'agent_id + via recorded');
ok(r1.request.consultation_type === 'action_approval' && r1.request.action_descriptor.amount === 12000, 'request descriptor captured');
ok(r1.response.signal === 'escalate' && r1.response.confidence === 0.78, 'response signal fields captured');
ok(r1.user_action === null, 'user_action null at write time');
ok(!('rationale_hint' in r1.response) && !JSON.stringify(r1).includes('layers'), 'receipt carries signals + descriptor only (no hint text, no layer content)');

// a receipt for an ABSTAIN resolution (from the real resolver)
const sparseVd = { phaedo_fingerprint: { persona_strength: 0.3, layers: {} } };
const abstain = resolveConsultationCore(sparseVd, { consultation_type: 'action_approval', action_descriptor: { domain: 'x' } });
const rAbstain = buildReceipt({ via: 'phaedo_consult', request: { consultation_type: 'action_approval', action_descriptor: { domain: 'x' } }, response: abstain });
ok(rAbstain.response.signal === 'insufficient_signal', 'abstain resolutions produce receipts too');

// ── encrypted store: append / read / restart / perms ──────────────────────────
console.log('\nencrypted store');
{
  const dir = await tmp();
  await appendReceipt(dir, r1);
  await appendReceipt(dir, rAbstain);
  const raw = await readFile(join(dir, 'receipts.enc'), 'utf8');
  ok(!/escalate|financial|vendor_agent|insufficient_signal|receipt_id/.test(raw), 'file on disk is ciphertext-only (no receipt content readable)');
  ok(JSON.parse(raw).envelope.alg === 'AES-256-GCM', 'standard §7.2 envelope');
  ok(JSON.parse(raw).envelope.metadata.artifact_kind === 'consultation_receipts', 'artifact_kind tags the store');
  const mode = (await stat(join(dir, 'receipts.enc'))).mode & 0o777;
  ok(mode === 0o600, `store is 0600 (got ${mode.toString(8)})`);

  // "restart": a fresh read from disk (no in-memory state) returns both, in order
  const back = await readReceipts(dir);
  ok(back.length === 2 && back[0].receipt_id === r1.receipt_id && back[1].response.signal === 'insufficient_signal', 'receipts survive restart, oldest first');

  // ── user_action: the one permitted mutation ─────────────────────────────────
  console.log('\nuser_action (only mutation)');
  const beforeUpdate = JSON.stringify((await readReceipts(dir))[0]);
  ok(await updateUserAction(dir, r1.receipt_id, 'rejected'), 'update by receipt_id → true');
  const after = (await readReceipts(dir))[0];
  ok(after.user_action === 'rejected', 'user_action set');
  ok(JSON.stringify({ ...after, user_action: null }) === beforeUpdate, 'EVERY other field byte-identical after the update');
  ok(!(await updateUserAction(dir, 'no-such-id', 'approved')), 'unknown receipt_id → false');
  let threw = null; try { await updateUserAction(dir, r1.receipt_id, 'shredded'); } catch (e) { threw = e; }
  ok(threw && /user_action must be one of/.test(threw.message), 'invalid action rejected');
  ok(USER_ACTIONS.join(',') === 'approved,rejected,modified,unknown', 'the four §10.6 user actions');

  // ── domain separation ───────────────────────────────────────────────────────
  console.log('\ndomain separation');
  const rootKey = await getOrCreateCacheKey(dir);
  const { envelope } = JSON.parse(await readFile(join(dir, 'receipts.enc'), 'utf8'));
  let rootDecrypts = true;
  try { await Phaedo.Envelope.unwrap(envelope, rootKey); } catch { rootDecrypts = false; }
  ok(!rootDecrypts, `raw root key cannot decrypt receipts.enc (distinct ${RECEIPTS_CONTEXT} key)`);
}

// ── eviction at cap ───────────────────────────────────────────────────────────
console.log('\neviction');
{
  const dir = await tmp();
  for (let i = 0; i < 7; i++) {
    await appendReceipt(dir, buildReceipt({ via: 'phaedo_consult', request: { consultation_type: 'action_approval', action_descriptor: { domain: `d${i}` } }, response: RESP }), { cap: 5 });
  }
  const rs = await readReceipts(dir);
  ok(rs.length === 5, `cap enforced (got ${rs.length})`);
  ok(rs[0].request.action_descriptor.domain === 'd2' && rs[4].request.action_descriptor.domain === 'd6', 'OLDEST evicted first');
}

// ── append-only API surface ───────────────────────────────────────────────────
console.log('\nappend-only surface');
const api = await import('./receipts.js');
ok(!Object.keys(api).some((k) => /delete|remove|clear|prune/i.test(k)), 'no delete/remove API is exported (append-only by construction)');

// ── cap config ────────────────────────────────────────────────────────────────
ok(receiptsCapFromEnv({}) === DEFAULT_CAP, `default cap ${DEFAULT_CAP}`);
ok(receiptsCapFromEnv({ PHAEDO_RECEIPTS_CAP: '100' }) === 100, 'PHAEDO_RECEIPTS_CAP overrides');
ok(receiptsCapFromEnv({ PHAEDO_RECEIPTS_CAP: 'junk' }) === DEFAULT_CAP, 'garbage cap → default');

// ── selector resolution (pure) ────────────────────────────────────────────────
console.log('\nresolveReceiptSelector');
const sel = [
  { receipt_id: 'aaaa1111-0000-4000-8000-000000000001' },
  { receipt_id: 'aaaa2222-0000-4000-8000-000000000002' },
  { receipt_id: 'bbbb3333-0000-4000-8000-000000000003' },
];
ok(resolveReceiptSelector(sel, 'latest').id === sel[2].receipt_id, "'latest' → most recent");
ok(resolveReceiptSelector(sel, undefined).id === sel[2].receipt_id, 'empty selector → most recent');
ok(resolveReceiptSelector(sel, sel[0].receipt_id).id === sel[0].receipt_id, 'full id → exact');
ok(resolveReceiptSelector(sel, 'bbbb3333').id === sel[2].receipt_id, 'unique prefix → match');
ok(!resolveReceiptSelector(sel, 'aaaa').ok && /matches 2/.test(resolveReceiptSelector(sel, 'aaaa').reason), 'ambiguous prefix → no match, helpful reason');
ok(!resolveReceiptSelector(sel, 'zzzz').ok, 'no match → ok:false');
ok(!resolveReceiptSelector([], 'latest').ok, 'empty store → ok:false');

// ── markOutcome → agreement goes LIVE ─────────────────────────────────────────
console.log('\nmarkOutcome (makes agreement live)');
{
  const dir = await tmp();
  const a = buildReceipt({ via: 'phaedo_consult', request: { consultation_type: 'action_approval', action_descriptor: { domain: 'financial' } }, response: { signal: 'proceed', confidence: 0.6, deference_level: 'medium' } });
  const b = buildReceipt({ via: 'phaedo_consult', request: { consultation_type: 'action_approval', action_descriptor: { domain: 'financial' } }, response: { signal: 'decline', confidence: 0.7, deference_level: 'high' } });
  await appendReceipt(dir, a); await appendReceipt(dir, b);

  const m1 = await markOutcome(dir, 'latest', 'rejected');
  ok(m1.matched && m1.receipt_id === b.receipt_id && m1.user_action === 'rejected', "mark 'latest' → newest receipt");
  const m2 = await markOutcome(dir, a.receipt_id.slice(0, 8), 'approved');
  ok(m2.matched && m2.receipt_id === a.receipt_id, 'mark by short id prefix');
  const back = await readReceipts(dir);
  ok(back.find((r) => r.receipt_id === a.receipt_id).user_action === 'approved' && back.find((r) => r.receipt_id === b.receipt_id).user_action === 'rejected', 'both user_actions persisted');

  let threw = null; try { await markOutcome(dir, 'latest', 'banana'); } catch (e) { threw = e; }
  ok(threw && /user_action must be one of/.test(threw.message), 'invalid action rejected');
  ok(!(await markOutcome(dir, 'zzzzzzzz', 'approved')).matched, 'no-match selector → matched:false (no throw)');

  // the payoff: agreement is now live for this store (proceed↔approved ✓, decline↔rejected ✓)
  const { computeAgreement } = await import('./agreement.js');
  const rep = computeAgreement(back);
  ok(rep.domains.financial.scored === 2 && rep.domains.financial.rate === 1, 'agreement now LIVE: 2 scored, both agree → rate 1.0 (was awaiting_user_action before marking)');
}

console.log(`\n✓ receipts: ${pass} checks passed`);
