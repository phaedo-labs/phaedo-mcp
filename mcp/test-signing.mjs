// §8.3 signing-core suite.
//
// Two jobs. (1) Prove this canonicalizer — the FOURTH copy in the repo — is byte-identical
// to the other three, by running the published TC-CANON vectors against it. A signature is
// only verifiable if every implementation agrees on the bytes, so drift here would produce
// signatures nobody else can check. (2) Prove verification accepts genuine signatures and
// rejects everything else, using node:crypto P-256 keys, which produce exactly what the
// Secure Enclave produces (ECDSA-SHA256, DER).

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  canonicalStringify,
  signingInput,
  derToRawSignature,
  publicKeyFromRawPoint,
  verifyEs256,
} from './signing.js';

const here = dirname(fileURLToPath(import.meta.url));
let checks = 0;
let failures = 0;
function check(label, cond) {
  checks++;
  if (!cond) { failures++; console.error(`  ✗ ${label}`); }
}
function throws(label, fn) {
  checks++;
  try { fn(); failures++; console.error(`  ✗ ${label} (expected a throw)`); }
  catch { /* expected */ }
}

const rawPublicKey = (publicKey) => {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
};

console.log('\nTC-CANON parity — this canonicalizer vs the published vectors');
{
  const file = resolve(here, '..', 'spec', 'test-vectors', 'canonicalization.json');
  const { vectors } = JSON.parse(readFileSync(file, 'utf8'));
  check('vectors are present', Array.isArray(vectors) && vectors.length > 0);
  let matched = 0;
  for (const v of vectors) {
    if (v.expected_canonical === undefined || v.input === undefined) continue;
    const got = canonicalStringify(v.input);
    if (got === v.expected_canonical) {
      matched++;
    } else {
      failures++; checks++;
      console.error(`  ✗ ${v.test_id}: ${JSON.stringify(got)} !== ${JSON.stringify(v.expected_canonical)}`);
    }
    // The digest is what a signature actually commits to, so check it too.
    if (v.expected_sha256) {
      const sha = crypto.createHash('sha256').update(got, 'utf8').digest('hex');
      check(`${v.test_id} sha256`, sha === v.expected_sha256);
    }
  }
  check(`all applicable TC-CANON vectors matched (${matched})`, matched > 0);
}

console.log('\ncanonicalStringify rejects what RFC 8785 cannot express');
throws('NaN throws rather than becoming null', () => canonicalStringify({ a: NaN }));
throws('Infinity throws rather than becoming null', () => canonicalStringify({ a: Infinity }));
throws('top-level undefined throws', () => canonicalStringify(undefined));
check('undefined-valued property is omitted, not emitted as invalid JSON',
  canonicalStringify({ a: 1, b: undefined }) === '{"a":1}');
check('undefined inside an array becomes null (JSON.stringify semantics)',
  canonicalStringify([1, undefined, 2]) === '[1,null,2]');

console.log('\nsigningInput omits the signature field — that is what makes it well defined');
{
  const payload = { b: 2, a: 1, signatures: [{ junk: true }] };
  const withSig = signingInput(payload).toString('utf8');
  const without = signingInput({ b: 2, a: 1 }).toString('utf8');
  check('signatures field is excluded', withSig === without);
  check('and the result is canonical (sorted)', withSig === '{"a":1,"b":2}');

  // AP2 uses a singular `signature` field; the omission must follow the caller.
  const ap2 = { amount: 10, signature: 'xxx' };
  check('a custom omit field works',
    signingInput(ap2, { field: 'signature' }).toString('utf8') === '{"amount":10}');
  check('appending a signature does not change the input it commits to',
    signingInput({ ...ap2, signature: 'DIFFERENT' }, { field: 'signature' }).toString('utf8') === '{"amount":10}');
}

console.log('\nDER → raw r||s conversion (the enclave speaks DER, JOSE expects raw)');
{
  // NOTE: ECDSA is randomized — signing the same message twice yields different bytes — so
  // the conversion cannot be checked by comparing against a second signature. The property
  // that actually matters is that the CONVERTED form still verifies as the same signature.
  // Many rounds because r/s only sometimes carry a leading zero byte (the pad/strip path).
  let converted = 0;
  for (let i = 0; i < 200; i++) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const msg = Buffer.from(`m${i}`);
    const der = crypto.sign('sha256', msg, privateKey);
    const raw = derToRawSignature(der);
    const stillValid = crypto.verify(
      'sha256', msg, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw,
    );
    if (raw.length === 64 && stillValid) converted++;
  }
  check(`all 200 DER signatures converted to a valid 64-byte raw form (${converted})`, converted === 200);
  throws('non-DER input throws', () => derToRawSignature(Buffer.from([0x01, 0x02])));
  throws('truncated DER throws', () => derToRawSignature(Buffer.from([0x30, 0x40, 0x02, 0x01, 0x01])));
}

console.log('\npublic key import');
{
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  check('a 65-byte uncompressed point imports', !!publicKeyFromRawPoint(rawPublicKey(publicKey)));
  throws('a wrong-length point throws', () => publicKeyFromRawPoint(Buffer.alloc(64)));
  throws('a compressed point (0x02 prefix) throws', () => {
    const p = rawPublicKey(publicKey); p[0] = 0x02; publicKeyFromRawPoint(p);
  });
}

console.log('\nverifyEs256 — genuine signatures verify, in both encodings');
{
  let ok = 0;
  for (let i = 0; i < 100; i++) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const payload = { amount: i, currency: 'USD', domain: 'finance' };
    const data = signingInput(payload, { field: 'signature' });
    const der = crypto.sign('sha256', data, privateKey);
    const pub = rawPublicKey(publicKey);

    const derOk = verifyEs256({ payload, signature: der, publicKey: pub, encoding: 'der', field: 'signature' });
    const rawOk = verifyEs256({
      payload, signature: derToRawSignature(der), publicKey: pub, encoding: 'raw', field: 'signature',
    });
    // A signature must still verify once it is attached to the object it signs.
    const attached = verifyEs256({
      payload: { ...payload, signature: der.toString('base64url') },
      signature: der, publicKey: pub, encoding: 'der', field: 'signature',
    });
    if (derOk && rawOk && attached) ok++;
  }
  check(`all 100 round-trips verified in der + raw, attached and detached (${ok})`, ok === 100);
}

console.log('\nverifyEs256 — everything else is rejected');
{
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const payload = { amount: 100, currency: 'USD' };
  const der = crypto.sign('sha256', signingInput(payload, { field: 'signature' }), privateKey);
  const pub = rawPublicKey(publicKey);
  const v = (over, sig = der) => verifyEs256({
    payload: over, signature: sig, publicKey: pub, encoding: 'der', field: 'signature',
  });

  check('a tampered amount does not verify', v({ amount: 1_000_000, currency: 'USD' }) === false);
  check('an added field does not verify', v({ amount: 100, currency: 'USD', extra: 1 }) === false);
  check('a removed field does not verify', v({ amount: 100 }) === false);

  const flipped = Buffer.from(der); flipped[flipped.length - 1] ^= 0x01;
  check('a corrupted signature does not verify', v(payload, flipped) === false);
  check('garbage signature bytes are rejected, not thrown', v(payload, Buffer.from([1, 2, 3])) === false);

  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  check('another key does not verify', verifyEs256({
    payload, signature: der, publicKey: rawPublicKey(other.publicKey), encoding: 'der', field: 'signature',
  }) === false);

  // A malformed KEY is a caller bug, not a failed verification — the two must not collapse
  // into the same answer, or "we could not check" reads as "not the subject's signature".
  throws('a malformed public key throws rather than returning false', () => verifyEs256({
    payload, signature: der, publicKey: Buffer.alloc(10), encoding: 'der', field: 'signature',
  }));
  throws('an unknown encoding throws', () => verifyEs256({
    payload, signature: der, publicKey: pub, encoding: 'pem', field: 'signature',
  }));
}

if (failures) {
  console.error(`\n✗ signing: ${failures} of ${checks} checks failed\n`);
  process.exit(1);
}
console.log(`\n✓ signing: ${checks} checks passed\n`);
