// §4.1 identity normalization (2026-06-16) — the reference server must serve a
// fingerprint carrying the REQUIRED protocol-identity fields even when the
// stored source (a producer predating identity stamping) lacks them. Guards the
// fix prompted by `npm run health` on a live fingerprint missing all three.

import { writeFile, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadFingerprint } from './fingerprint-source.js';
import { validateFingerprint } from '../spec/validate-fingerprint.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}`); } };

const dir = await mkdtemp(join(tmpdir(), 'phaedo-identity-'));
const file = join(dir, 'fingerprint.json');

// A stale fingerprint: has fingerprint_id, missing the three §4.1 identity fields.
await writeFile(file, JSON.stringify({
  phaedo_fingerprint: { fingerprint_id: 'fp-stable-123', layers: { surface: { summary: '- Tone: warm' } } },
}));
process.env.PHAEDO_FINGERPRINT = file;

const fp = (await loadFingerprint(dir)).phaedo_fingerprint;
ok('stamps phaedo_protocol_version', fp.phaedo_protocol_version === '0.1');
ok('stamps schema_revision', fp.schema_revision === 1);
ok('subject_id falls back to the stable fingerprint_id', fp.subject_id === 'fp-stable-123');
ok('no §4.1 "missing required" errors remain', !validateFingerprint(fp).some((e) => /missing required/.test(e)));

// A producer that already minted its own identity must be left untouched.
await writeFile(file, JSON.stringify({
  phaedo_fingerprint: { phaedo_protocol_version: '0.1', subject_id: 'producer-subj', schema_revision: 2, layers: {} },
}));
const fp2 = (await loadFingerprint(dir)).phaedo_fingerprint;
ok('does not clobber a producer-supplied subject_id', fp2.subject_id === 'producer-subj');
ok('does not clobber a producer-supplied schema_revision', fp2.schema_revision === 2);

console.log(`\n${fail === 0 ? '✓' : '✗'} identity normalization: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
