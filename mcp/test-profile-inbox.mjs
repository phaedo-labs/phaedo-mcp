// The phone's pushed profile copy (profile-inbox.js): open it, keep only the newest, stamp it
// with the phone's time, and pick it up on both cache-read paths — end to end over a real HTTP
// relay stand-in, from a copy built by the phone's own module.
//
//   node mcp/test-profile-inbox.mjs

import assert from 'node:assert';
import http from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';
import { parseAgentProfileDeposit, acceptCopy, drainProfileCopy, maybeDrainProfileCopy, CHECK_GAP_MS, AGENT_PROFILE_KIND } from './profile-inbox.js';
import { readCache, writeCache, readCacheTime } from './cache.js';
import { buildReceiptsDeposit } from './receipts-sync.js';
import { ruleLeeway } from './lib/rule-leeway.js';

const { Kdf, Envelope } = Phaedo;
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const phone = require(resolve(HERE, '../mobile/src/lib/agentProfile.js'));
const { createFpMailbox } = require(resolve(HERE, '../relay/mailbox.js'));

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-02T12:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'phaedo-inbox-'));
const sample = JSON.parse(readFileSync(join(HERE, 'sample-fingerprint.json'), 'utf8'));

const pairKey = crypto.getRandomValues(new Uint8Array(32));
const PK = b64uEnc(pairKey);
const otherKey = b64uEnc(crypto.getRandomValues(new Uint8Array(32)));

// Seal the way the phone does (agentProfilePush.ts): fp_sync_key from the agent's pair key.
async function seal(inner, key = PK) {
  const k = await Kdf.deriveFpSyncKey(new Uint8Array(Buffer.from(key, 'base64url')));
  return Envelope.wrap(new TextEncoder().encode(JSON.stringify(inner)), k, {
    artifact_kind: 'fingerprint', fingerprint_id: sample.phaedo_fingerprint.fingerprint_id, created_at: inner.generated_at || new Date(NOW).toISOString(),
  });
}
const profileAt = (t, extra = {}) => phone.agentProfileInner(
  { data: sample.phaedo_fingerprint, metrics: { signals: {}, ling: {}, sessions: {} }, ...extra },
  new Date(t).toISOString(),
);

console.log('\nthe phone and the Mac agree on the lane and the shape');
{
  ok(phone.AGENT_PROFILE_KIND === AGENT_PROFILE_KIND, 'same kind tag on both sides');
  ok(phone.agentProfileLane('c_I3YRBTVjo8Q4EON2') === 'profile_to_agent/c_I3YRBTVjo8Q4EON2', 'per-agent lane');
  ok(createFpMailbox().isValidDir(phone.agentProfileLane('c_I3YRBTVjo8Q4EON2')), 'which the relay accepts');
  ok(phone.agentProfileLane('../x') === null && phone.agentProfileLane(null) === null, 'an id that cannot be a slot gets none');
  const clients = [
    { id: 'c_mcp', type: 'mcp', verified: true, pairKey: 'k' },
    { id: 'c_browser', type: 'browser_extension', verified: true, pairKey: 'k' },
    { id: 'c_unverified', type: 'mcp', verified: false, pairKey: 'k' },
    { id: 'c_nokey', type: 'mcp', verified: true },
    { id: 'c_unknown', type: 'unknown', verified: true, pairKey: 'k' },
    { id: 'bad/id', type: 'mcp', verified: true, pairKey: 'k' },
  ];
  ok(phone.agentRecipients(clients).map((c) => c.id).join() === 'c_mcp', 'only verified, keyed, mcp-type agents with a valid id get a copy');
  ok(phone.agentRecipients(null).length === 0, 'no clients → nobody');
  ok(phone.agentProfileInner({ metrics: {} }, 'x') === null, 'no fingerprint → nothing to send');
  ok(phone.foregroundDue(NaN, NOW) && phone.foregroundDue(NOW - phone.FOREGROUND_GAP_MS, NOW), 'first foreground, or after the gap → push');
  ok(!phone.foregroundDue(NOW - 60000, NOW), 'a quick app switch → no push');
  ok(phone.foregroundDue(NOW - 60000, NOW, true), 'a change always pushes');
  ok(phone.foregroundDue(NOW + 60000, NOW), 'a clock that went backwards does not block pushing');
}

console.log('\nopening a copy');
{
  const inner = profileAt(NOW - DAY);
  const got = await parseAgentProfileDeposit(PK, await seal(inner));
  ok(got && got.generatedAt === NOW - DAY, 'opens, with the phone\'s generated_at');
  ok(got.vault.phaedo_fingerprint.fingerprint_id === sample.phaedo_fingerprint.fingerprint_id, 'into the vault shape a live read gives (toVaultPayload)');
  const withCfg = await parseAgentProfileDeposit(PK, await seal(profileAt(NOW, { user_configuration: { a: 1 } })));
  ok(withCfg.vault.phaedo_user_configuration && withCfg.vault.phaedo_user_configuration.a === 1, 'the §5 sibling rides along as phaedo_user_configuration');
  ok(await parseAgentProfileDeposit(otherKey, await seal(inner)) === null, 'another agent\'s key cannot open it');
  ok(await parseAgentProfileDeposit(PK, await seal({ kind: 'receipts_digest', data: { receipts: [] }, generated_at: inner.generated_at })) === null,
    'something else sealed under the same key (our own receipts digest) is not a profile');
  ok(await parseAgentProfileDeposit(PK, await seal({ ...inner, generated_at: 'whenever' })) === null, 'no usable time → refused (its age would be unknown)');
  ok(await parseAgentProfileDeposit(PK, await seal({ ...inner, data: null })) === null, 'no fingerprint → refused');
  ok(await parseAgentProfileDeposit(PK, null) === null && await parseAgentProfileDeposit(PK, { garbage: 1 }) === null, 'malformed → null, never throws');
}

console.log('\nnewest wins, aged by the phone');
{
  ok(acceptCopy(NOW - DAY, NOW - 2 * DAY, NOW) === NOW - DAY, 'newer than the cache → taken, stamped with the phone\'s time');
  ok(acceptCopy(NOW - 3 * DAY, NOW - 2 * DAY, NOW) === null, 'older than the cache (a replay) → ignored');
  ok(acceptCopy(NOW - DAY, NOW - DAY, NOW) === null, 'the same copy again → ignored');
  ok(acceptCopy(NOW + 5 * DAY, NOW - DAY, NOW) === NOW, 'a phone clock ahead of ours is clamped to now');
  ok(acceptCopy(NOW - DAY, NaN, NOW) === NOW - DAY, 'no cache yet → taken');
  ok(acceptCopy(NaN, NaN, NOW) === null, 'no time → refused');
}

// A relay stand-in: serves whatever is in `slots`, records requests.
function relay() {
  const slots = new Map(); const log = [];
  const server = http.createServer((req, res) => {
    log.push({ method: req.method, url: req.url, auth: req.headers.authorization || null });
    const m = req.url.match(/^\/fp-mailbox\/([^/]+)\/(.+)$/);
    const body = m && slots.get(`${m[1]}:${m[2]}`);
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body || { error: 'empty' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ slots, log, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
const pairing = { endpoint: 'http://127.0.0.1:9', client_id: 'c_mac', client_secret: 's', pair_key: PK, relay_device_id: 'dev1', relay_device_secret: 'sec' };

console.log('\ndraining');
{
  const r = await relay();
  const dir = tmp();
  const deps = { relayBase: r.base, now: () => NOW };
  ok((await drainProfileCopy(pairing, dir, deps)).reason === 'http-404', 'nothing pushed yet → no change');
  ok(r.log[0].url === '/fp-mailbox/dev1/profile_to_agent/c_mac' && r.log[0].auth === 'Bearer dev1:sec', 'asks for its own slot, with the relay bearer');
  r.slots.set('dev1:profile_to_agent/c_mac', { envelope: await seal(profileAt(NOW - 2 * 3600000)) });
  const d1 = await drainProfileCopy(pairing, dir, deps);
  const c1 = await readCache(dir);
  ok(d1.updated && c1 && c1.cachedAt === NOW - 2 * 3600000, 'a pushed copy becomes the cache, aged from when the phone made it');
  ok(c1.vault.phaedo_fingerprint.fingerprint_id === sample.phaedo_fingerprint.fingerprint_id, 'with the profile in it');
  r.slots.set('dev1:profile_to_agent/c_mac', { envelope: await seal(profileAt(NOW - 3 * DAY)) });
  ok((await drainProfileCopy(pairing, dir, deps)).reason === 'not-newer' && (await readCache(dir)).cachedAt === NOW - 2 * 3600000,
    'an older copy served again (a rollback) does not replace a newer one');
  r.slots.set('dev1:profile_to_agent/c_mac', { envelope: await seal(profileAt(NOW - 3600000), otherKey) });
  ok((await drainProfileCopy(pairing, dir, deps)).reason === 'unreadable', 'a copy sealed for someone else is ignored');
  ok((await drainProfileCopy({ ...pairing, client_id: undefined }, dir, deps)).reason === 'no-client-id', 'no client id → no slot to read');
  ok((await drainProfileCopy({ ...pairing, relay_device_id: undefined }, dir, deps)).reason === 'no-relay-device-id', 'no relay id → nothing to do');
  ok((await drainProfileCopy(pairing, dir, { relayBase: 'http://127.0.0.1:9', timeoutMs: 500 })).updated === false, 'relay down → no change, no throw');
  r.close();
}

console.log('\nthrottled across processes');
{
  const r = await relay();
  const dir = tmp();
  r.slots.set('dev1:profile_to_agent/c_mac', { envelope: await seal(profileAt(NOW - 3600000)) });
  let t = NOW;
  const deps = { relayBase: r.base, now: () => t };
  const load = async () => pairing;
  ok((await maybeDrainProfileCopy(load, dir, deps)).updated === true, 'first check runs');
  ok(existsSync(join(dir, 'profile-inbox.json')), 'and leaves its time where the next process can see it');
  t += CHECK_GAP_MS - 1000;
  ok((await maybeDrainProfileCopy(load, dir, deps)).reason === 'recent' && r.log.length === 1, 'within 10 minutes → no request');
  t += 2000;
  await maybeDrainProfileCopy(load, dir, deps);
  ok(r.log.length === 2, 'after 10 minutes → checks again');
  ok((await maybeDrainProfileCopy(async () => { throw new Error('no pairing'); }, tmp(), deps)).reason === 'unpaired', 'no pairing → nothing, no throw');
  r.close();
}

console.log('\nend to end: the hook\'s cache read picks it up, and the rule leeway sees its true age');
{
  const r = await relay();
  const dir = tmp();
  const cfgDir = tmp();
  writeFileSync(join(cfgDir, 'pairing.json'), JSON.stringify(pairing));
  // An 11-day-old copy, as on the reference Mac, then a push from the phone an hour ago.
  await writeCache(dir, { phaedo_fingerprint: sample.phaedo_fingerprint }, Date.now() - 11 * DAY);
  r.slots.set('dev1:profile_to_agent/c_mac', { envelope: await seal(profileAt(Date.now() - 3600000)) });
  process.env.PHAEDO_MCP_STATE_DIR = dir;
  process.env.PHAEDO_PAIRING = join(cfgDir, 'pairing.json');
  process.env.PHAEDO_RELAY = r.base;
  delete process.env.PHAEDO_FINGERPRINT;
  const { loadFingerprintPreferCache, sourceOf } = await import('./fingerprint-source.js');
  const vd = await loadFingerprintPreferCache(HERE);
  const src = sourceOf(vd);
  ok(src.live === false, 'still a copy, never "live" — the stale guard treats it like any cache');
  ok(src.ageMs >= 3600000 - 5000 && src.ageMs < 3600000 + 60000, `aged an hour, not 11 days (${Math.round(src.ageMs / 60000)} min)`);
  const merge = { reversible: true, magnitude: 'medium', domain: 'engineering' };
  ok(ruleLeeway({ source: src, descriptor: merge, receipts: [], now: Date.now() }).ok === true, 'so a standing rule applies again to a routine merge');
  ok(ruleLeeway({ source: { live: false, ageMs: 11 * DAY }, descriptor: merge, receipts: [], now: Date.now() }).why === 'stale', '(it would not from the 11-day copy)');
  ok(r.log.some((x) => x.url === '/fp-mailbox/dev1/profile_to_agent/c_mac'), 'by asking the relay for its own slot');
  r.close();
}

console.log('\nthe phone shows how fresh the Mac\'s copy is');
{
  const MIN = 60000, HOUR = 60 * MIN;
  ok(phone.copyAgeLine(NOW - 30 * 1000, NOW) === "Your Mac's copy of your profile was updated just now.", 'seconds old → just now');
  ok(phone.copyAgeLine(NOW - 25 * MIN, NOW) === "Your Mac's copy of your profile was updated 25 minutes ago.", 'minutes');
  ok(phone.copyAgeLine(NOW - 90 * MIN, NOW) === "Your Mac's copy of your profile was updated an hour ago.", 'an hour');
  ok(phone.copyAgeLine(NOW - 5 * HOUR, NOW) === "Your Mac's copy of your profile was updated 5 hours ago.", 'hours');
  ok(phone.copyAgeLine(NOW - 3 * DAY, NOW) === "Your Mac's copy of your profile was updated 3 days ago.", 'days');
  ok(phone.copyAgeLine(NOW - 7 * DAY, NOW).includes('7 days ago'), 'exactly 7 days still counts as fresh, as the leeway does');
  ok(phone.copyAgeLine(NOW - 11 * DAY, NOW) === "Your Mac's copy of your profile is 11 days old, so your rules wait until it updates.",
    'past 7 days it says what that means');
  ok(phone.copyAgeLine(NOW + HOUR, NOW).includes('just now'), 'a clock ahead of the phone never reads as negative');
  ok(phone.copyAgeLine(null, NOW) === null && phone.copyAgeLine(NaN, NOW) === null && phone.copyAgeLine(0, NOW) === null, 'no time → no line');

  // The Mac reads the time without the key, and carries it in the digest it already sends.
  const dir = tmp();
  ok(await readCacheTime(dir) === null, 'no copy → no time');
  await writeCache(dir, { phaedo_fingerprint: sample.phaedo_fingerprint }, NOW - 2 * HOUR);
  ok(await readCacheTime(dir) === NOW - 2 * HOUR, 'the copy time is read without decrypting');
  const receipts = [{ receipt_id: 'r1', created_at: new Date(NOW).toISOString(), request: {}, response: { signal: 'proceed' } }];
  const open = async (env) => {
    const k = await Kdf.deriveFpSyncKey(new Uint8Array(pairKey));
    return JSON.parse(new TextDecoder().decode(await Envelope.unwrap(env, k)));
  };
  const nowIso = () => new Date(NOW).toISOString();
  const withCopy = await open((await buildReceiptsDeposit(PK, receipts, { now: nowIso, copyAt: NOW - 2 * HOUR })).envelope);
  ok(withCopy.data.copy_at === new Date(NOW - 2 * HOUR).toISOString(), 'the digest carries the copy time');
  const ahead = await open((await buildReceiptsDeposit(PK, receipts, { now: nowIso, copyAt: NOW + DAY })).envelope);
  ok(ahead.data.copy_at === nowIso(), 'a copy time ahead of the digest is clamped to it');
  const none = await open((await buildReceiptsDeposit(PK, receipts, { now: nowIso })).envelope);
  ok(!('copy_at' in none.data), 'no copy → the field is left out (an older phone ignores it either way)');
  const line = phone.copyAgeLine(Date.parse(withCopy.data.copy_at), NOW);
  ok(line === "Your Mac's copy of your profile was updated 2 hours ago.", 'and the phone turns it into one plain line');

  const server = readFileSync(join(HERE, 'server.js'), 'utf8');
  ok(/const copyAt = await readCacheTime\(defaultStateDir\(\)\);[\s\S]{0,200}\|\$\{copyAt\}`[\s\S]{0,200}depositReceiptsDigest\([\s\S]{0,80}\{ copyAt \}\)/.test(server),
    'the server sends it, and a fresher copy alone is worth a new digest');
}

console.log('\nremoving an agent clears its copy');
{
  let list = phone.queueClears([], ['c_mac', 'bad/id', 'c_mac'], NOW);
  ok(list.length === 1 && list[0].id === 'c_mac' && list[0].at === NOW, 'one entry per removed agent; an id that cannot be a slot is skipped');
  list = phone.queueClears(list, ['c_laptop'], NOW + 1000);
  ok(list.map((c) => c.id).join() === 'c_mac,c_laptop', 'a second removal adds to the list');
  ok(phone.pendingClears(list, NOW + 1000 + phone.CLEAR_KEEP_MS).length === 0, 'once the relay TTL has passed there is nothing left to clear');
  ok(phone.pendingClears([{ id: 'c_x' }, null, { id: 7, at: NOW }], NOW).length === 0, 'malformed entries are dropped');
  const queuedDuring = phone.queueClears(list, ['c_new'], NOW + 2000);
  ok(phone.settleClears(queuedDuring, ['c_mac'], NOW + 3000).map((c) => c.id).join() === 'c_laptop,c_new',
    'a round drops only what the relay confirmed, and keeps a removal queued while it ran');

  // Against the relay itself: the cleared slot is gone, so a removed Mac's drain finds nothing.
  const mb = createFpMailbox();
  mb.put('dev1', 'profile_to_agent/c_mac', { envelope: await seal(profileAt(NOW)) });
  ok(mb.isRemovableDir(phone.agentProfileLane('c_mac')), "the phone's lane is one the relay lets it clear");
  mb.remove('dev1', phone.agentProfileLane('c_mac'));
  ok(mb.get('dev1', 'profile_to_agent/c_mac') == null, 'after the clear the removed Mac has nothing to fetch');

  const registry = readFileSync(resolve(HERE, '../mobile/src/lib/clientRegistry.ts'), 'utf8');
  ok(/export async function revokeClient[\s\S]{0,200}await forgetCopies\(/.test(registry)
    && /export async function revokeAllClients[\s\S]{0,300}await forgetCopies\(clients\)/.test(registry),
    'both removal paths (one agent, and deleting the profile) clear the copies');
  ok(/c\.type === 'mcp'/.test(registry.slice(registry.indexOf('async function forgetCopies'))), 'only agents had a copy to clear');
  const push = readFileSync(resolve(HERE, '../mobile/src/lib/agentProfilePush.ts'), 'utf8');
  ok(/method: 'DELETE'/.test(push) && /if \(_inFlight\)[\s\S]{0,80}await flushClears\(\)/.test(push),
    'the phone sends the clear after any push already under way');
  ok(/export async function pushProfileToAgents[\s\S]{0,200}void flushClears\(\)/.test(push), 'and retries a failed clear on every foreground');
}

console.log(`\n✓ profile inbox: ${pass} checks passed`);
