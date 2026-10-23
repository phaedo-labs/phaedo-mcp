// No profile is an answer, not a demo — and a starter profile is the user's own, never borrowed.
//
// Until 2026-10-20 an unpaired install with no fingerprint file fell back to the shipped
// sample-fingerprint.json, silently — so a stranger who ran `npx phaedo-mcp` had a made-up
// person's style injected into their assistant. This pins the cases apart:
//   1. nothing configured, nothing captured → a plain "no profile" error, never the sample
//   2. nothing configured, Claude Code capture on → a STARTER profile made only of what this
//      computer captured, labelled as such (never the sample's traits)
//   3. PHAEDO_FINGERPRINT=sample             → the sample, because it was asked for by name
//   4. a NAMED path that's wrong             → an error naming that path, never the sample
// plus the one-line startup note (profileStatusLine) for each.
//
//   node mcp/test-no-profile.mjs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

import { loadFingerprint, sourceOf, profileStatusLine, summarizeStarter, NO_PROFILE_MESSAGE, STARTER_FINGERPRINT_ID } from './fingerprint-source.js';
import { buildInjectionResponse } from './projection.js';
import { PhaedoError } from './errors.js';
import { emptyState, applySession, saveState, defaultStatePath } from '../capture/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };
const NOW = '2026-10-20T12:00:00Z';

// A base dir with no pairing.json and no fingerprint.json, and an EMPTY capture state dir — what
// a fresh install looks like. The env vars that would route around it are cleared; the state dir
// is pinned so a dev machine's real capture history can't turn case 1 into case 2.
const empty = mkdtempSync(join(tmpdir(), 'phaedo-no-profile-'));
const stateDir = mkdtempSync(join(tmpdir(), 'phaedo-no-profile-state-'));
const saved = { fp: process.env.PHAEDO_FINGERPRINT, pairing: process.env.PHAEDO_PAIRING, state: process.env.PHAEDO_MCP_STATE_DIR };
delete process.env.PHAEDO_FINGERPRINT;
delete process.env.PHAEDO_PAIRING;
process.env.PHAEDO_MCP_STATE_DIR = stateDir;

try {
  console.log('\n1. nothing configured, nothing captured → no profile');
  {
    let threw = null;
    try { await loadFingerprint(empty); } catch (e) { threw = e; }
    ok(threw instanceof PhaedoError, 'a PhaedoError, not a served fingerprint');
    ok(threw?.code === 'decryption_failed', '§9.5 decryption_failed (no plaintext fingerprint to give)');
    ok(threw?.message === NO_PROFILE_MESSAGE, 'the plain "no profile" message');
    ok(/not changed how the assistant responds/.test(NO_PROFILE_MESSAGE), 'the message says what did NOT happen');
    ok(/Claude Code hook/.test(NO_PROFILE_MESSAGE), 'the message names the phone-less way to start one');
    ok(/PHAEDO_FINGERPRINT=sample/.test(NO_PROFILE_MESSAGE), 'the message says how to try the example profile');
    const line = await profileStatusLine(empty);
    ok(/^no profile is set up on this computer/.test(line || ''), 'startup note: says there is no profile');
    ok(!/\n/.test(line || ''), 'startup note: one line');
  }

  console.log('\n2. Claude Code capture on → a starter profile of the user\'s own signals');
  {
    // What the capture hook leaves behind after a few sessions: "too long" corrections.
    const counts = { behavioral_signals: { surface: { too_long: 4 } }, positive_count: 0, mental_models: {}, message_count: 12 };
    saveState(defaultStatePath(), applySession(emptyState(), 'cap_claude-code_test1234', 'session-1', counts, { now: NOW }));

    const vd = await loadFingerprint(empty);
    const fp = vd.phaedo_fingerprint;
    ok(fp.fingerprint_id === STARTER_FINGERPRINT_ID, 'served under the starter id');
    ok(sourceOf(vd).starter === true && sourceOf(vd).live === true, 'provenance says starter (so pull.js won\'t claim "from the phone")');
    const signals = Object.values(fp.layers).flatMap((l) => l.signals || []);
    ok(signals.length > 0 && signals.every((s) => s.source === 'delta'), 'every signal is one this computer captured — nothing else');
    ok(signals.some((s) => s.field === 'response_length_pref' && s.value === 'short'), 'the captured preference is there ("short")');
    ok(fp.phaedo_protocol_version && fp.subject_id === STARTER_FINGERPRINT_ID, '§4.1 identity is normalized like any other source');

    const r = buildInjectionResponse(vd, { requested_layers: ['all'], mode: 'standard' });
    ok(r.projection.includes('Response length: short'), 'the injection carries the captured preference');
    ok(/preliminary/.test(r.projection), 'the injection labels it preliminary — thin by construction, and says so');

    const line = await profileStatusLine(empty);
    ok(/using a starter profile from your own sessions/.test(line || ''), 'startup note: says a starter profile is in use');
    ok(/1 thing learned across 1 area from 1 session — just getting started/.test(line || ''),
       'startup note: says how much it has learned, and that it is early (one trait, one session)');
    ok(!/\n/.test(line || ''), 'startup note: still one line');

    // It grows: more traits and sessions move it along, and only a solid start points to the phone.
    let st = emptyState();
    const many = { behavioral_signals: { surface: { too_long: 4, no_headers: 3, too_formal: 2 }, behavioral: { wants_options: 2 } }, positive_count: 0, mental_models: {}, message_count: 20 };
    for (let i = 1; i <= 3; i++) st = applySession(st, 'cap_claude-code_test1234', `s${i}`, many, { now: NOW });
    saveState(defaultStatePath(), st);
    const grown = await summarizeStarter(await loadFingerprint(empty));
    ok(grown.sessions === 3, 'the summary counts captured sessions');
    ok(grown.learned >= 1 && grown.areas >= 1, `the summary counts traits and areas (${grown.learned} in ${grown.areas})`);
    const fake = (n) => ({ phaedo_fingerprint: { layers: { surface: { signals: Array.from({ length: n }, (_, i) => ({ field: `f${i}`, source: 'delta' })) } } } });
    ok((await summarizeStarter(fake(2))).stage.startsWith('just getting started'), '< 3 traits → just getting started');
    ok((await summarizeStarter(fake(5))).stage.startsWith('taking shape'), '3–7 traits → taking shape');
    const solid = await summarizeStarter(fake(8));
    ok(solid.stage.startsWith('a solid start') && /phone app/.test(solid.stage), '8+ traits → a solid start, and only then the phone app');
    ok(!/phone app/.test((await summarizeStarter(fake(5))).stage), 'before that, it does not push the phone app');
    const dup = { phaedo_fingerprint: { layers: { surface: { signals: [{ field: 'a' }, { field: 'a' }, { field: 'b' }] } } } };
    ok((await summarizeStarter(dup)).learned === 2, 'repeat observations of one trait count once');
    saveState(defaultStatePath(), applySession(emptyState(), 'cap_claude-code_test1234', 'session-1', counts, { now: NOW }));

    // A real fingerprint.json still wins over the starter (it is a profile the user put there).
    writeFileSync(join(empty, 'fingerprint.json'), JSON.stringify({ phaedo_fingerprint: { fingerprint_id: 'fp-file', updated_at: NOW, layers: {} } }));
    ok((await loadFingerprint(empty)).phaedo_fingerprint.fingerprint_id === 'fp-file', 'a fingerprint.json beats the starter');
    ok(await profileStatusLine(empty) === null, 'startup note: silent when a profile file is configured');
    rmSync(join(empty, 'fingerprint.json'));

    // A pairing record means a phone owns this: no starter, and no startup pull either.
    process.env.PHAEDO_PAIRING = join(stateDir, 'pairing.json');
    ok(await profileStatusLine(empty) === null, 'startup note: silent when paired (never pulls at startup)');
    delete process.env.PHAEDO_PAIRING;

    saveState(defaultStatePath(), emptyState());
  }

  console.log('\n3. PHAEDO_FINGERPRINT=sample → the sample');
  {
    process.env.PHAEDO_FINGERPRINT = 'sample';
    const vd = await loadFingerprint(empty);
    ok(vd.phaedo_fingerprint.fingerprint_id.startsWith('sample-'), 'the shipped sample');
    const fromPkg = await loadFingerprint(HERE);
    ok(fromPkg.phaedo_fingerprint.fingerprint_id === vd.phaedo_fingerprint.fingerprint_id, 'the keyword resolves next to the server, not the cwd');
    ok(/made-up example profile/.test(await profileStatusLine(empty) || ''), 'startup note: says the example is in use');
  }

  console.log('\n4. a wrong named path → an error naming it');
  {
    // It used to quietly serve the sample, which is the worst answer: it looks like it worked.
    process.env.PHAEDO_FINGERPRINT = join(empty, 'typo-fingerprint.json');
    let threw = null;
    try { await loadFingerprint(empty); } catch (e) { threw = e; }
    ok(threw instanceof PhaedoError && threw.message.includes('typo-fingerprint.json'), 'an error naming the path');
    ok(threw?.message !== NO_PROFILE_MESSAGE, 'not reported as "no profile"');
  }
} finally {
  for (const [k, v] of [['PHAEDO_FINGERPRINT', saved.fp], ['PHAEDO_PAIRING', saved.pairing], ['PHAEDO_MCP_STATE_DIR', saved.state]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(empty, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(`\n✓ test-no-profile: ${pass} checks passed`);
