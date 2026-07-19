#!/usr/bin/env node
// Real-time escalation client — crypto round-trip, orchestrator (mock fetch), and a
// REAL-relay end-to-end. Run: node test-escalation.mjs
//
// Covers everything device-free: the §10.4-safe payload, the encrypt/deposit/poll/
// decrypt round-trip, the timeout safe-default, the decision→outcome mapping, and the
// full wire path against an actual relay/server.js subprocess (deposit → drain →
// respond → poll). The only links NOT exercised here are the APNs wake (needs Apple
// infra) and the phone UI (needs a device/build). Skips cleanly when relay deps absent.

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';
import {
  buildEscalationPayload, buildEscalationDeposit, unwrapEscalationResponse,
  requestEscalationDecision, shouldEscalate, isConsequential,
  mergeEscalationPolicy, loadEscalationPolicy, resolveClarifyMode,
} from './escalation.js';

const { Kdf, Envelope } = Phaedo;
const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const skip = (m) => { console.log(`\n⊘ escalation-relay SKIPPED — ${m}`); process.exit(0); };

// Seal a phone-side decision the way the phone would (under fp_sync_key) so the
// orchestrator's poll can decrypt it.
async function sealDecision(pairKeyBytes, decision, extra = {}) {
  const fpSyncKey = await Kdf.deriveFpSyncKey(pairKeyBytes);
  const inner = { kind: 'escalation_response', data: { decision, ...extra } };
  const envelope = await Envelope.wrap(new TextEncoder().encode(JSON.stringify(inner)), fpSyncKey, { artifact_kind: 'escalation_response', created_at: new Date().toISOString() });
  return { envelope };
}

const REQ = {
  consultation_type: 'action_approval',
  agent_id: 'agent-x',
  action_descriptor: { domain: 'financial', summary: 'wire $40k to a new vendor', magnitude: 'high', reversible: false, amount: 40000 },
};
const RESP = { signal: 'escalate', rationale_hint: 'On irreversible, high-magnitude actions, the subject favors caution and human review.' };

// ── 1. §10.4-safe payload ────────────────────────────────────────────────────
console.log('\npayload carries the action + signal, never layer content');
{
  const p = buildEscalationPayload(REQ, RESP);
  ok(p.action.summary === 'wire $40k to a new vendor' && p.action.amount === 40000, 'payload carries the agent\'s action descriptor');
  ok(p.signal === 'escalate' && p.rationale_hint.includes('caution'), 'payload carries the consult signal + rationale_hint');
  const flat = JSON.stringify(p);
  ok(!/layers|persona_strength|signals|standing_rules/.test(flat), 'payload has no fingerprint layer content (§10.4 holds)');
  ok(!shouldEscalate('proceed') && !shouldEscalate('proceed_with_note') && !shouldEscalate('decline') && !shouldEscalate('insufficient_signal'),
    'non-blocking signals never push');
}

// ── 1b. signal gating: escalate always; clarify only when consequential ──────
console.log('\nescalate always pushes; clarify pushes only on a consequential action');
{
  const consequential = { reversible: false, magnitude: 'medium' };
  const highMag = { reversible: true, magnitude: 'high' };
  const lowStakes = { reversible: true, magnitude: 'low' };
  // escalate is unconditional
  ok(shouldEscalate('escalate', lowStakes) && shouldEscalate('escalate', {}) && shouldEscalate('escalate', consequential),
    'escalate pushes regardless of stakes');
  // clarify is stakes-gated: irreversible OR high magnitude
  ok(isConsequential(consequential) && isConsequential(highMag), 'isConsequential = irreversible OR high magnitude');
  ok(!isConsequential(lowStakes) && !isConsequential({}), 'reversible+low (or unknown) stakes is not consequential');
  ok(shouldEscalate('clarify', consequential) && shouldEscalate('clarify', highMag), 'a consequential clarify pushes (irreversible / high)');
  ok(!shouldEscalate('clarify', lowStakes) && !shouldEscalate('clarify', {}), 'a low-stakes / unknown-stakes clarify does NOT push (agent resolves it itself)');
}

// ── 1c. subject-configurable push policy (the standing knob) ─────────────────
console.log('\nthe clarify push policy is subject-configurable, globally + per-domain');
{
  const lowFin = { domain: 'financial', reversible: true, magnitude: 'low' };
  const lowWriting = { domain: 'writing', reversible: true, magnitude: 'low' };
  const irreversibleWriting = { domain: 'writing', reversible: false, magnitude: 'high' };

  // default override: "always" pushes even a low-stakes clarify
  const always = mergeEscalationPolicy({ clarify: { default: 'always' } });
  ok(shouldEscalate('clarify', lowWriting, always), 'clarify default "always" pushes a low-stakes clarify');
  // default override: "never" suppresses even a consequential clarify
  const never = mergeEscalationPolicy({ clarify: { default: 'never' } });
  ok(!shouldEscalate('clarify', irreversibleWriting, never), 'clarify default "never" suppresses even a consequential clarify');
  ok(shouldEscalate('escalate', irreversibleWriting, never), 'escalate STILL pushes under "never" — it is not configurable (safety invariant)');

  // per-domain override beats the default
  const perDomain = mergeEscalationPolicy({ clarify: { default: 'consequential', by_domain: { financial: 'always', writing: 'never' } } });
  ok(resolveClarifyMode(lowFin, perDomain) === 'always' && shouldEscalate('clarify', lowFin, perDomain), 'a low-stakes FINANCIAL clarify pushes (by_domain: always)');
  ok(resolveClarifyMode(irreversibleWriting, perDomain) === 'never' && !shouldEscalate('clarify', irreversibleWriting, perDomain), 'an irreversible WRITING clarify is suppressed (by_domain: never)');
  ok(resolveClarifyMode({ domain: 'medical', reversible: false }, perDomain) === 'consequential', 'an unlisted domain falls back to the default (consequential)');

  // sources: vault policy merged UNDER the local-file override
  const vd = { phaedo_fingerprint: { escalation_policy: { clarify: { default: 'never' } } } };
  ok(resolveClarifyMode(lowWriting, loadEscalationPolicy(vd)) === 'never', 'a vault-embedded escalation_policy applies (portable)');
  ok(resolveClarifyMode(lowWriting, loadEscalationPolicy(vd, { escalationPolicy: { clarify: { default: 'always' } } })) === 'always',
    'the local file overrides the vault policy');
  // malformed / unknown modes are ignored (fall back to the built-in default)
  ok(resolveClarifyMode(lowWriting, mergeEscalationPolicy({ clarify: { default: 'bogus' } })) === 'consequential', 'an unknown mode is ignored (falls back to consequential)');
  ok(resolveClarifyMode(lowWriting, loadEscalationPolicy({})) === 'consequential', 'no policy anywhere → the built-in stakes-gated default');
}

// ── 2. crypto round-trip (deposit body ↔ decrypt) ────────────────────────────
console.log('\nencrypt → (relay holds ciphertext) → decrypt round-trips');
{
  const pk = crypto.getRandomValues(new Uint8Array(32));
  const pkB64 = b64uEnc(pk);
  const body = await buildEscalationDeposit(pkB64, 'rid-1', buildEscalationPayload(REQ, RESP), { windowMs: 60000 });
  ok(body.request_id === 'rid-1' && body.envelope && body.window_ms === 60000, 'deposit body = { request_id, envelope, window_ms }');
  ok(!JSON.stringify(body.envelope).includes('40k') && !JSON.stringify(body.envelope).includes('vendor'), 'the envelope is ciphertext — plaintext action text is not present');
  // a decision sealed by the phone decrypts back
  const sealed = await sealDecision(pk, 'approve', { note: 'ok, vendor is vetted' });
  const data = await unwrapEscalationResponse(pkB64, sealed);
  ok(data && data.decision === 'approve' && data.note === 'ok, vendor is vetted', 'a phone decision decrypts back under the shared key');
  const wrongKey = b64uEnc(crypto.getRandomValues(new Uint8Array(32)));
  ok((await unwrapEscalationResponse(wrongKey, sealed)) === null, 'a wrong key yields null (no crash, no leak)');
}

// ── 3. orchestrator with a MOCK fetch: decision + outcome mapping ─────────────
console.log('\norchestrator: a phone approve resolves + maps to an outcome');
{
  const pk = crypto.getRandomValues(new Uint8Array(32));
  const pairing = { pair_key: b64uEnc(pk), relay_device_id: 'dev-1' };
  const responseBody = await sealDecision(pk, 'modify', { note: 'cap at $10k', modified: { amount: 10000 } });
  let polls = 0;
  const fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') return { ok: true, status: 200, json: async () => ({ queued: true }) };
    polls++;
    if (polls < 2) return { ok: false, status: 404, json: async () => ({ error: 'pending' }) };  // pending first
    return { ok: true, status: 200, json: async () => responseBody };
  };
  const r = await requestEscalationDecision(pairing, REQ, RESP, { fetch, sleep: async () => {}, pollMs: 1, windowMs: 60000 });
  ok(r.resolved && r.decision === 'modify' && r.proceed === true, 'a modify decision resolves and proceeds');
  ok(r.outcome === 'modified', 'modify maps to the §10.6 user_action "modified" (feeds override learning)');
  ok(r.modified && r.modified.amount === 10000, 'the modified parameters survive the round-trip');
}

console.log('\norchestrator: a deny resolves to do-not-proceed + "rejected"');
{
  const pk = crypto.getRandomValues(new Uint8Array(32));
  const pairing = { pair_key: b64uEnc(pk), relay_device_id: 'dev-1' };
  const responseBody = await sealDecision(pk, 'deny');
  const fetch = async (url, opts) => opts && opts.method === 'POST'
    ? { ok: true, status: 200, json: async () => ({ queued: true }) }
    : { ok: true, status: 200, json: async () => responseBody };
  const r = await requestEscalationDecision(pairing, REQ, RESP, { fetch, sleep: async () => {}, pollMs: 1, windowMs: 60000 });
  ok(r.resolved && r.decision === 'deny' && r.proceed === false, 'a deny resolves to do-not-proceed');
  ok(r.outcome === 'rejected', 'deny maps to "rejected" — the strongest act-as-me signal');
}

// ── 4. timeout → safe-default (hold, no learning) ────────────────────────────
console.log('\ntimeout: window lapses → safe-default hold, teaches nothing');
{
  const pk = crypto.getRandomValues(new Uint8Array(32));
  const pairing = { pair_key: b64uEnc(pk), relay_device_id: 'dev-1' };
  let t = 0;
  const fetch = async (url, opts) => opts && opts.method === 'POST'
    ? { ok: true, status: 200, json: async () => ({ queued: true }) }
    : { ok: false, status: 404, json: async () => ({ error: 'pending' }) };   // never answered
  const r = await requestEscalationDecision(pairing, REQ, RESP, {
    fetch, sleep: async () => {}, pollMs: 5, windowMs: 20, now: () => (t += 8),  // clock outruns the window quickly
  });
  ok(!r.resolved && r.decision === 'hold' && r.proceed === false, 'no answer ⇒ hold (do-not-proceed is the safe default for escalate)');
  ok(r.outcome === 'unknown' && r.reason === 'timeout', 'a timeout is not an override — outcome "unknown", teaches nothing');
}

console.log('\nunpaired / no relay lane → safe-default, never throws');
{
  const r1 = await requestEscalationDecision(null, REQ, RESP, {});
  ok(!r1.resolved && r1.reason === 'unpaired' && r1.proceed === false, 'unpaired pairing safe-defaults to hold');
  const r2 = await requestEscalationDecision({ pair_key: 'x' }, REQ, RESP, {});
  ok(!r2.resolved && r2.reason === 'no-relay-device-id', 'a local-only pairing (no relay lane) safe-defaults to hold');
}

// ── 5. REAL relay end-to-end ─────────────────────────────────────────────────
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

// Open a WS to the relay and register a chosen device_id+secret so subsequent HTTP calls
// (escalation, push-token) authenticate. Resolves with what the relay considers authoritative
// (it may mint fresh on first connect if the secret we sent didn't match its store).
async function mockPhoneRegister(port, deviceId, deviceSecret) {
  const rel = createRequire(resolve(__dirname, '../relay/package.json'));
  const { WebSocket } = rel('ws');
  return new Promise((resolve2, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => { try { ws.close() } catch {} ; reject(new Error('relay WS register timeout')); }, 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', device_id: deviceId, device_secret: deviceSecret }));
    });
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type !== 'registered') return;
      clearTimeout(t);
      resolve2({ ws, device_id: msg.device_id, device_secret: msg.device_secret });
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
function startRelay(port) {
  return new Promise((res, rej) => {
    const srv = spawn(process.execPath, [resolve(__dirname, '../relay/server.js')],
      { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => { srv.kill('SIGKILL'); rej(new Error('relay did not log "listening" within 5s')); }, 5000);
    srv.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); res(srv); } });
    srv.on('error', (e) => { clearTimeout(t); rej(e); });
    srv.on('exit', (code) => { clearTimeout(t); rej(new Error(`relay exited early (code ${code}) — relay deps likely missing`)); });
  });
}

const port = await freePort();
let relay;
try { relay = await startRelay(port); } catch (e) { skip(e.message); }

let mockPhoneWs;
try {
  const base = `http://127.0.0.1:${port}`;
  const dev = 'dev-esc';
  const devSecret = 'secret-for-dev-esc-' + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  // Register the device with the relay's auth (via the WS path the phone uses) so its
  // device_id is bound to this secret. Without this every HTTP call below would 401.
  const regd = await mockPhoneRegister(port, dev, devSecret);
  mockPhoneWs = regd.ws;
  const authHeaders = { Authorization: `Bearer ${regd.device_id}:${regd.device_secret}` };
  const pk = crypto.getRandomValues(new Uint8Array(32));
  const pairing = { pair_key: b64uEnc(pk), relay_device_id: regd.device_id, relay_device_secret: regd.device_secret };

  console.log('\nagent deposits → real relay → device drains the pending request');
  // A foregrounded phone holds an open WS; the relay must NUDGE it on deposit so it drains
  // without a background→foreground bounce (the open-app counterpart to an APNs push). Arm a
  // one-shot capture of the {type:'escalation'} nudge BEFORE depositing.
  const nudgeP = new Promise((res) => {
    const onMsg = (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'escalation') { mockPhoneWs.off('message', onMsg); res(m); }
    };
    mockPhoneWs.on('message', onMsg);
    setTimeout(() => { mockPhoneWs.off('message', onMsg); res(null); }, 4000);
  });

  // Kick off the orchestrator; a "phone" answers it out of band against the same relay.
  const decisionP = requestEscalationDecision(pairing, REQ, RESP, { relayBase: base, pollMs: 50, windowMs: 8000 });

  const nudge = await nudgeP;
  ok(nudge && nudge.type === 'escalation' && typeof nudge.request_id === 'string',
    'the relay nudges the connected device socket on deposit (content-free wake → foreground drain)');

  // Poll the relay as the phone would until the request shows up, then answer it.
  let drained = null;
  for (let i = 0; i < 100 && !drained; i++) {
    const list = await (await fetch(`${base}/escalation/${regd.device_id}`, { headers: authHeaders })).json();
    if (list.requests && list.requests.length) drained = list.requests[0];
    else await new Promise((r) => setTimeout(r, 20));
  }
  ok(drained && drained.envelope && drained.request_id, 'the device drains the pending decision request (with its ciphertext) from the real relay');
  // the drained request decrypts to the §10.4-safe payload
  const reqData = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(drained.envelope, await Kdf.deriveFpSyncKey(pk))));
  ok(reqData.kind === 'escalation_request' && reqData.data.action.summary.includes('wire'), 'the drained request decrypts to the action under question');

  // ── per-device auth: HTTP routes 401 without a valid bearer ────────────────
  const unauth = await fetch(`${base}/escalation/${regd.device_id}`);
  ok(unauth.status === 401, 'GET /escalation/:deviceId without Authorization → 401');
  const wrongAuth = await fetch(`${base}/escalation/${regd.device_id}`, { headers: { Authorization: `Bearer ${regd.device_id}:wrong-secret` } });
  ok(wrongAuth.status === 401, 'wrong-secret bearer → 401');
  const fakeAuth = await fetch(`${base}/escalation/${regd.device_id}`, { headers: { Authorization: `Bearer unknown-device:${regd.device_secret}` } });
  ok(fakeAuth.status === 401, 'unknown deviceId in bearer → 401');

  // phone posts the subject's decision
  const sealed = await sealDecision(pk, 'approve', { note: 'vendor vetted' });
  const postRes = await fetch(`${base}/escalation/${regd.device_id}/${drained.request_id}/response`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify(sealed),
  });
  ok(postRes.status === 200, 'the device posts the decision (HTTP 200)');

  const decision = await decisionP;
  ok(decision.resolved && decision.decision === 'approve' && decision.proceed === true, 'the agent\'s poll resolves to the subject\'s real decision over the live relay');
  ok(decision.outcome === 'approved', 'an approve maps to the "approved" outcome');

  console.log('\nfirst answer wins (multi-device dedup)');
  // a second response to the same request is rejected (409 already_responded)
  const dup = await fetch(`${base}/escalation/${regd.device_id}/${drained.request_id}/response`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify(sealed),
  });
  ok(dup.status === 409, 'a second device answering the same request is told it lost (409 already_responded)');
  // and the answered request no longer drains as pending
  const after = await (await fetch(`${base}/escalation/${regd.device_id}`, { headers: authHeaders })).json();
  ok(!after.requests.some((r) => r.request_id === drained.request_id), 'an answered request drops out of the pending drain list');

  console.log('\npush-token registration endpoint');
  const tok = await fetch(`${base}/push-token/${regd.device_id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify({ token: 'apns-abc', platform: 'ios' }),
  });
  ok(tok.status === 200 && (await tok.json()).registered === true, 'a device can register its APNs push token with the relay');

  // ── Delivery paths (PR #79): a deposit must reach an OPEN socket as a nudge, and a
  // deposit made while the socket is CLOSED must still be drainable on reconnect ──────
  const payload = buildEscalationPayload(REQ, RESP);

  console.log('\nopen socket → deposit nudges it (foregrounded-app path)');
  {
    // Arm a fresh capture on device-1's still-open socket, then raw-deposit a NEW request.
    const rid = crypto.randomUUID();
    const nudge2P = new Promise((res) => {
      const onMsg = (data) => {
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.type === 'escalation' && m.request_id === rid) { mockPhoneWs.off('message', onMsg); res(m); }
      };
      mockPhoneWs.on('message', onMsg);
      setTimeout(() => { mockPhoneWs.off('message', onMsg); res(null); }, 4000);
    });
    const dep = await buildEscalationDeposit(b64uEnc(pk), rid, payload, { windowMs: 8000 });
    const depRes = await fetch(`${base}/escalation/${regd.device_id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify(dep),
    });
    const depBody = await depRes.json();
    ok(depRes.status === 200 && depBody.nudged === true, 'deposit to a device with an OPEN socket reports nudged:true');
    const got = await nudge2P;
    ok(got && got.request_id === rid, 'the nudge carries the request_id and reaches the open socket');
    // tidy up: answer it so it doesn't linger as pending
    await fetch(`${base}/escalation/${regd.device_id}/${rid}/response`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify(await sealDecision(pk, 'deny')),
    });
  }

  console.log('\nclosed socket → deposit is NOT lost, still drains on reconnect (missed-nudge safety)');
  {
    // A second device registers (mints its bearer + opens a socket), then GOES OFFLINE.
    const dev2 = 'dev-esc-offline';
    const reg2 = await mockPhoneRegister(port, dev2, 'sec2-' + Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url'));
    const auth2 = { Authorization: `Bearer ${reg2.device_id}:${reg2.device_secret}` };
    await new Promise((r) => { reg2.ws.on('close', r); reg2.ws.close(); });   // socket closed; bearer persists
    await new Promise((r) => setTimeout(r, 150));                              // let the relay see the close

    const rid = crypto.randomUUID();
    const dep = await buildEscalationDeposit(b64uEnc(pk), rid, payload, { windowMs: 8000 });
    const depRes = await fetch(`${base}/escalation/${reg2.device_id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth2 }, body: JSON.stringify(dep),
    });
    const depBody = await depRes.json();
    ok(depRes.status === 200 && depBody.nudged === false, 'deposit to an OFFLINE device reports nudged:false (no socket to wake)');
    // The request is NOT lost: it stays pending and drains once the device reconnects + re-drains.
    const reg2b = await mockPhoneRegister(port, reg2.device_id, reg2.device_secret);
    const drainedOffline = await (await fetch(`${base}/escalation/${reg2.device_id}`, { headers: auth2 })).json();
    ok(drainedOffline.requests?.some((r) => r.request_id === rid),
      'a deposit made while offline is still pending and drains after the device reconnects (missed nudge never loses the escalation)');
    try { reg2b.ws.close(); } catch {}
  }
} finally {
  if (mockPhoneWs) try { mockPhoneWs.close() } catch {}
  if (relay) relay.kill('SIGTERM');
}

console.log(`\n✓ escalation: ${pass} checks passed (payload + crypto + orchestrator + real relay)`);
