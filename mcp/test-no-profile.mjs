// No profile is an answer, not a demo.
//
// Until 2026-10-20 an unpaired install with no fingerprint file fell back to the shipped
// sample-fingerprint.json, silently — so a stranger who ran `npx phaedo-mcp` had a made-up
// person's style injected into their assistant. This pins the three cases apart:
//   1. nothing configured        → a plain "no profile" error, never the sample
//   2. PHAEDO_FINGERPRINT=sample → the sample, because it was asked for by name
//   3. a NAMED path that's wrong → an error naming that path, never the sample
//
//   node mcp/test-no-profile.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

import { loadFingerprint, NO_PROFILE_MESSAGE } from './fingerprint-source.js';
import { PhaedoError } from './errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

// A base dir with no pairing.json and no fingerprint.json — what a fresh install looks like
// from the loader's point of view. The env vars that would route around it are cleared.
const empty = mkdtempSync(join(tmpdir(), 'phaedo-no-profile-'));
const saved = { fp: process.env.PHAEDO_FINGERPRINT, pairing: process.env.PHAEDO_PAIRING };
delete process.env.PHAEDO_FINGERPRINT;
delete process.env.PHAEDO_PAIRING;

try {
  let threw = null;
  try { await loadFingerprint(empty); } catch (e) { threw = e; }
  ok(threw instanceof PhaedoError, 'nothing configured → a PhaedoError, not a served fingerprint');
  ok(threw?.code === 'decryption_failed', 'nothing configured → §9.5 decryption_failed (no plaintext fingerprint to give)');
  ok(threw?.message === NO_PROFILE_MESSAGE, 'nothing configured → the plain "no profile" message');
  ok(/not changed how the assistant responds/.test(NO_PROFILE_MESSAGE), 'the message says what did NOT happen');
  ok(/PHAEDO_FINGERPRINT=sample/.test(NO_PROFILE_MESSAGE), 'the message says how to try the example profile');

  // The sample is still one word away — from any base dir, since it ships with the package.
  process.env.PHAEDO_FINGERPRINT = 'sample';
  const vd = await loadFingerprint(empty);
  ok(vd.phaedo_fingerprint.fingerprint_id.startsWith('sample-'), 'PHAEDO_FINGERPRINT=sample → the shipped sample');
  const fromPkg = await loadFingerprint(HERE);
  ok(fromPkg.phaedo_fingerprint.fingerprint_id === vd.phaedo_fingerprint.fingerprint_id, 'the keyword resolves next to the server, not the cwd');

  // A path the user named and got wrong is their mistake to see — it used to quietly serve
  // the sample, which is the worst answer: it looks like it worked.
  process.env.PHAEDO_FINGERPRINT = join(empty, 'typo-fingerprint.json');
  threw = null;
  try { await loadFingerprint(empty); } catch (e) { threw = e; }
  ok(threw instanceof PhaedoError && threw.message.includes('typo-fingerprint.json'), 'a wrong named path → an error naming it');
  ok(threw?.message !== NO_PROFILE_MESSAGE, 'a wrong named path is not reported as "no profile"');
} finally {
  if (saved.fp === undefined) delete process.env.PHAEDO_FINGERPRINT; else process.env.PHAEDO_FINGERPRINT = saved.fp;
  if (saved.pairing === undefined) delete process.env.PHAEDO_PAIRING; else process.env.PHAEDO_PAIRING = saved.pairing;
  rmSync(empty, { recursive: true, force: true });
}

console.log(`✓ test-no-profile: ${pass} checks passed`);
