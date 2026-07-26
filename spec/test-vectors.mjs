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
import { validateVaultData, resolveDimension, resolveEffective } from './validate-fingerprint.mjs';

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
  // JSON cannot carry non-finite numbers, so error vectors mark them with string
  // sentinels the runner substitutes before canonicalizing.
  const inflate = (x) => x === '__INFINITY__' ? Infinity : x === '__NAN__' ? NaN
    : Array.isArray(x) ? x.map(inflate)
    : (x && typeof x === 'object') ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, inflate(v)]))
    : x;
  for (const v of vectors) {
    if (v.expect_error) {
      let threw = false;
      try { canonicalStringify(inflate(v.input)); } catch { threw = true; }
      ok(`${v.test_id}: rejects (throws)`, threw);
      continue;
    }
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
    // `inline` carries its own vault, so a vector can pin behaviour that depends on
    // AUTHORED content (standing_rules) without inventing a second shared fixture.
    const vd = v.vault === 'sample-fingerprint' ? sample
      : v.vault === 'inline' ? v.vault_data
      : emptyVd;
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
    if (v.effective) {
      // §4.7 effective resolution in context (OQ7): authored ⊕ inferred ladder.
      const r = resolveEffective(v.effective);
      ok(`${v.test_id}: basis == ${v.expect.basis}`, r && r.basis === v.expect.basis);
      if ('value' in v.expect) ok(`${v.test_id}: value`, r && JSON.stringify(r.value ?? null) === JSON.stringify(v.expect.value ?? null));
      if ('status' in v.expect) ok(`${v.test_id}: status == ${v.expect.status}`, r && r.status === v.expect.status);
      if ('rule_id' in v.expect) ok(`${v.test_id}: rule_id == ${v.expect.rule_id}`, r && r.rule_id === v.expect.rule_id);
      if ('polarity' in v.expect) ok(`${v.test_id}: polarity == ${v.expect.polarity}`, r && r.polarity === v.expect.polarity);
      continue;
    }
    const r = resolveDimension(v.signals);
    if ('value' in v.expect) ok(`${v.test_id}: value`, r && JSON.stringify(r.value) === JSON.stringify(v.expect.value));
    ok(`${v.test_id}: status == ${v.expect.status}`, r && r.status === v.expect.status);
    ok(`${v.test_id}: provenance retains all candidates`, r && Array.isArray(r.provenance) && r.provenance.length === v.signals.length);
  }
}

// ── TC-ENV ──────────────────────────────────────────────────────────────────
console.log('\nTC-ENV — encryption envelope (§7): unwrap + integrity');
{
  const { unwrap } = globalThis.Phaedo.Envelope;
  const hexBytes = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));
  const { vectors } = load('test-vectors/envelope.json');
  for (const v of vectors) {
    const key = hexBytes(v.key_hex);
    if (v.expect_error) {
      let threw = false;
      try { await unwrap(v.envelope, key); } catch { threw = true; }
      ok(`${v.test_id}: rejects (integrity failure)`, threw);
      continue;
    }
    const pt = new TextDecoder().decode(await unwrap(v.envelope, key));
    ok(`${v.test_id}: plaintext matches`, pt === v.expected_plaintext);
  }
}

// ── TC-EXPORT ───────────────────────────────────────────────────────────────
console.log('\nTC-EXPORT — portable bootstrap export digest (§8.2)');
{
  evalScript('export.js');
  const { buildBootstrapExport } = globalThis.Phaedo.Export;
  const hexBytes = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));
  const { vectors } = load('test-vectors/export.json');
  for (const v of vectors) {
    const built = await buildBootstrapExport({
      artifact: v.input.artifact,
      pairingToken: v.input.pairing_token,
      extPub: v.input.ext_pub_hex ? hexBytes(v.input.ext_pub_hex) : undefined,
    });
    if (v.expected_digest_mismatch_with) {
      ok(`${v.test_id}: tampered input does not reproduce the recorded digest`, built.digest !== v.expected_digest_mismatch_with);
      continue;
    }
    ok(`${v.test_id}: full export object reproduces byte-for-byte`, JSON.stringify(built) === JSON.stringify(v.expected));
  }
}

// ── TC-INJ ──────────────────────────────────────────────────────────────────
console.log('\nTC-INJ — injection request/response + §9.5 error codes');
{
  const { buildInjectionResponse, PhaedoError } = await import('../mcp/projection.js');
  const doc = load('test-vectors/injection.json');
  for (const v of doc.vectors) {
    const vault = 'vault_override' in v ? v.vault_override : doc.vault;
    if (v.expect.error) {
      let code = null;
      try { buildInjectionResponse(vault, v.request); } catch (e) { code = e instanceof PhaedoError ? e.code : 'NOT_A_PHAEDO_ERROR'; }
      ok(`${v.test_id}: §9.5 code == ${v.expect.error}`, code === v.expect.error);
      continue;
    }
    const r = buildInjectionResponse(vault, v.request, 0);
    const REQUIRED = ['phaedo_response_version', 'request_type', 'fingerprint_id', 'mode', 'projection', 'layers_included', 'persona_strength', 'expires_at'];
    ok(`${v.test_id}: §9.3 required fields present`, REQUIRED.every((k) => k in r));
    if (v.expect.layers_included) ok(`${v.test_id}: layers_included`, r.layers_included.sort().join(',') === v.expect.layers_included.slice().sort().join(','));
    if (v.expect.fingerprint_id) ok(`${v.test_id}: fingerprint_id`, r.fingerprint_id === v.expect.fingerprint_id);
    if (v.expect.mode) ok(`${v.test_id}: mode`, r.mode === v.expect.mode);
    ok(`${v.test_id}: projection is non-empty text`, typeof r.projection === 'string' && r.projection.length > 0);
  }
}

// ── TC-SIGN ───────────────────────────────────────────────────────────────────
// §8.3 ES256 verification. ECDSA signing is randomized, so — like TC-ENV — these are
// VERIFY-direction known-answer vectors: a conforming verifier MUST reproduce every
// expect_verify. Uses the reference verifier (mcp/signing.js) that the phone signs into.
console.log('\nTC-SIGN — asymmetric signing verification (§8.3)');
{
  const { verifyEs256 } = await import('../mcp/signing.js');
  const { vectors } = load('test-vectors/signing.json');
  for (const v of vectors) {
    const got = verifyEs256({
      payload: v.payload,
      signature: Buffer.from(v.signature_b64, 'base64'),
      publicKey: Buffer.from(v.public_key_b64, 'base64'),
      encoding: v.encoding || 'der',
      field: v.field || 'signature',
    });
    ok(`${v.test_id}: verify == ${v.expect_verify}`, got === v.expect_verify);
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} test vectors: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
