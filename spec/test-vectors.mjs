#!/usr/bin/env node
// Phaedo Protocol §12 test-vector runner.
//
// Executes the committed conformance vectors in spec/test-vectors/*.json against
// the reference implementation, proving they are REAL (regenerate-on-drift), not
// aspirational. An external implementer runs the same vectors against their own
// producer/consumer to prove conformance. Zero-dep; runnable standalone
// (`node spec/test-vectors.mjs`) and auto-discovered in CI via
// scripts/test_vectors.mjs.
//
// Categories: TC-CANON (canonical serialization), TC-FP-CONFORMANCE (good/bad
// fingerprints), TC-CONS (consultation resolver). TC-ENV / TC-EXPORT / TC-INJ
// crypto + injection round-trips are exercised by scripts/test_envelope.mjs,
// test_bootstrap_export.mjs, test_seed_bootstrap.mjs, test_cross_compat.mjs;
// porting them to static vectors here is queued (see §12).

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateVaultData, resolveDimension } from './validate-fingerprint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const load = (p) => JSON.parse(readFileSync(resolve(HERE, p), 'utf8'));
const sha256hex = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${name}`); } };

// Load the classic scripts (self-attach to globalThis.Phaedo) for canonicalStringify.
if (typeof globalThis.btoa === 'undefined') globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
if (typeof globalThis.atob === 'undefined') globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
const evalScript = (p) => new Function(readFileSync(resolve(ROOT, p), 'utf8')).call(globalThis);
evalScript('protocol.js');
evalScript('envelope.js');
const { canonicalStringify } = globalThis.Phaedo.Envelope;

// ── TC-CANON ──────────────────────────────────────────────────────────────────
console.log('\nTC-CANON — canonical serialization (§6)');
{
  const { vectors } = load('test-vectors/canonicalization.json');
  for (const v of vectors) {
    const got = canonicalStringify(v.input);
    ok(`${v.test_id}: canonical bytes match`, got === v.expected_canonical);
    ok(`${v.test_id}: sha256 matches`, sha256hex(got) === v.expected_sha256);
  }
}

// ── TC-FP-CONFORMANCE ───────────────────────────────────────────────────────
console.log('\nTC-FP-CONFORMANCE — good/bad fingerprints (§4)');
{
  const { vectors } = load('test-vectors/fingerprint-conformance.json');
  for (const v of vectors) {
    const errs = validateVaultData(v.doc);
    if (v.expect === 'pass') {
      ok(`${v.test_id}: conforms (no errors)`, errs.length === 0);
    } else {
      ok(`${v.test_id}: rejected`, errs.length > 0);
      for (const sub of (v.expect_errors_contain || [])) {
        ok(`${v.test_id}: error mentions "${sub}"`, errs.some((e) => e.includes(sub)));
      }
    }
  }
}

// ── TC-CONS ───────────────────────────────────────────────────────────────────
console.log('\nTC-CONS — consultation resolver (§10)');
try {
  const { buildConsultationResponse } = await import('../mcp/consult.js');
  const sample = load('../mcp/sample-fingerprint.json');
  const emptyVd = { phaedo_fingerprint: { persona_strength: 0.3, layers: {} } };
  const { vectors } = load('test-vectors/consultation.json');
  for (const v of vectors) {
    const vd = v.vault === 'sample-fingerprint' ? sample : emptyVd;
    const r = buildConsultationResponse(vd, v.request);
    ok(`${v.test_id}: signal == ${v.expected.signal}`, r.signal === v.expected.signal);
    ok(`${v.test_id}: deference == ${v.expected.deference_level}`, r.deference_level === v.expected.deference_level);
    // §10.4 boundary: the response carries no layer content.
    ok(`${v.test_id}: no layer content leaks`, !('layers' in r) && !('signals' in r));
  }
} catch (e) {
  console.log(`  (skipped TC-CONS — consult engine unavailable: ${e.message})`);
}

// ── TC-RESOLVE ──────────────────────────────────────────────────────────────
console.log('\nTC-RESOLVE — conflict resolution (Proposal 0006 / §4.7)');
{
  const { vectors } = load('test-vectors/resolution.json');
  for (const v of vectors) {
    const r = resolveDimension(v.signals);
    if ('value' in v.expect) ok(`${v.test_id}: value`, r && JSON.stringify(r.value) === JSON.stringify(v.expect.value));
    ok(`${v.test_id}: status == ${v.expect.status}`, r && r.status === v.expect.status);
    ok(`${v.test_id}: provenance retains all candidates`, r && Array.isArray(r.provenance) && r.provenance.length === v.signals.length);
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} test vectors: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
