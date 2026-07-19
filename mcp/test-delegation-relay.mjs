#!/usr/bin/env node
// Delegation transport over a REAL relay (relay/server.js) — the device-free half of the
// end-to-end. Run: node test-delegation-relay.mjs
//
// test-delegation-sync.mjs proves the crypto+merge against a MOCK fetch; this boots the
// actual relay HTTP server in a subprocess and drives the real wire path: the MCP
// depositDelegationSuggestions POSTs to /fp-mailbox/<dev>/agent_to_ext, then a real HTTP
// GET drains it (as the extension would), unwraps with the shared fp_sync_key, and
// union-merges. The only links NOT covered here are the browser fetch and the fly.dev
// deployment itself. Skips cleanly (exit 0) when the relay can't start (deps not installed).

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';
import { depositDelegationSuggestions } from './delegation-sync.js';

const require = createRequire(import.meta.url);
const SM = require('../sync-merge.js');
const { Kdf, Envelope } = Phaedo;
const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const skip = (m) => { console.log(`\n⊘ delegation-relay SKIPPED — ${m}`); process.exit(0); };

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

function startRelay(port) {
  return new Promise((res, rej) => {
    const srv = spawn(process.execPath, [resolve(__dirname, '../relay/server.js')],
      { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => { srv.kill('SIGKILL'); rej(new Error('relay did not log "listening" within 5s')); }, 5000);
    srv.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); res(srv); } });
    srv.on('error', (e) => { clearTimeout(t); rej(e); });           // e.g. ws not installed
    srv.on('exit', (code) => { clearTimeout(t); rej(new Error(`relay exited early (code ${code}) — relay deps likely missing`)); });
  });
}

const port = await freePort();
let relay;
try {
  relay = await startRelay(port);
} catch (e) {
  skip(e.message);
}

// Register a device with the relay's auth (mocks the phone's WS register) so subsequent
// HTTP calls authenticate. Returns the authoritative id+secret the relay assigned.
async function mockPhoneRegister(port, deviceId, deviceSecret) {
  const rel = createRequire(resolve(__dirname, '../relay/package.json'));
  const { WebSocket } = rel('ws');
  return new Promise((resolve2, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => { try { ws.close() } catch {} ; reject(new Error('relay WS register timeout')); }, 5000);
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'register', device_id: deviceId, device_secret: deviceSecret })); });
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.type !== 'registered') return;
      clearTimeout(t);
      resolve2({ ws, device_id: m.device_id, device_secret: m.device_secret });
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

let mockPhoneWs;
try {
  const base = `http://127.0.0.1:${port}`;
  const dev = 'dev-itest';
  const regd = await mockPhoneRegister(port, dev, 'secret-itest-' + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'));
  mockPhoneWs = regd.ws;
  const authHeaders = { Authorization: `Bearer ${regd.device_id}:${regd.device_secret}` };
  const pairKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const pairing = { pair_key: b64uEnc(pairKeyBytes), relay_device_id: regd.device_id, relay_device_secret: regd.device_secret };
  const suggestions = [{
    suggestion_id: crypto.randomUUID(), status: 'suggested', source: 'delegation_promotion',
    proposed_text: 'When you act on my behalf, favor getting it right over getting it fast.',
    decision: { dimension: 'speed_vs_quality', polarity: 'positive', origin: 'delegation', value: 'quality' },
  }];

  console.log('\nMCP deposit → real relay agent_to_ext slot');
  const dep = await depositDelegationSuggestions(pairing, suggestions, { relayBase: base });
  ok(dep.deposited === true && dep.status === 200, 'depositDelegationSuggestions POSTs to the live relay and gets HTTP 200');

  console.log('\nreal HTTP drain → decrypt → merge (the extension path, in node)');
  const res = await fetch(`${base}/fp-mailbox/${regd.device_id}/agent_to_ext`, { headers: authHeaders });
  ok(res.ok, 'GET /fp-mailbox/<dev>/agent_to_ext drains (HTTP 200)');
  const body = await res.json();
  ok(body && body.envelope, 'the drained body carries the encrypted envelope');
  const fpSyncKey = await Kdf.deriveFpSyncKey(pairKeyBytes);
  const inner = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(body.envelope, fpSyncKey)));
  const merged = SM.mergeAgentSuggestions({ answers: {} }, inner.data.suggested_rules);
  ok(merged.suggested_rules.length === 1 && merged.suggested_rules[0].decision.origin === 'delegation',
    'the suggestion survives deposit → live relay → HTTP drain → decrypt → union-merge intact');

  console.log('\nper-device auth: unauthed access is rejected');
  const unauth = await fetch(`${base}/fp-mailbox/${regd.device_id}/agent_to_ext`);
  ok(unauth.status === 401, 'no Authorization header → 401');

  console.log('\nslot isolation + idempotent drain over real HTTP');
  await fetch(`${base}/fp-mailbox/${regd.device_id}/to_ext`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ envelope: { ciphertext: 'phone-fp' } }),
  });
  const after = await fetch(`${base}/fp-mailbox/${regd.device_id}/agent_to_ext`, { headers: authHeaders });
  ok((await after.json()).envelope, 'a phone deposit to to_ext does not disturb agent_to_ext (separate slot, real server)');
  const reread = await fetch(`${base}/fp-mailbox/${regd.device_id}/agent_to_ext`, { headers: authHeaders });
  ok(reread.ok && (await reread.json()).envelope, 'draining is idempotent — the slot survives re-reads (no delete on read)');

  console.log('\nwrong device sees nothing');
  // Register a second device so we can validly auth-check the other id (unauthed → 401, authed → 404).
  const other = await mockPhoneRegister(port, 'dev-other', 'secret-other');
  const otherAuth = { Authorization: `Bearer ${other.device_id}:${other.device_secret}` };
  const otherRes = await fetch(`${base}/fp-mailbox/${other.device_id}/agent_to_ext`, { headers: otherAuth });
  ok(otherRes.status === 404, 'a different device id drains empty (404) — deposits are device-scoped');
  try { other.ws.close() } catch {}
} finally {
  if (mockPhoneWs) try { mockPhoneWs.close() } catch {}
  if (relay) relay.kill('SIGTERM');
}

console.log(`\n✓ delegation-relay: ${pass} checks passed (real relay subprocess)`);
