// §8.3 asymmetric signing — the verification half, server-side.
//
// The MCP server CANNOT sign: the subject's signing key is non-extractable inside the
// phone's Secure Enclave (spec §8.3, verified on hardware 2026-07-23). What the server
// does is (a) compute the exact bytes a signature covers, so the phone can be asked to
// sign them, and (b) VERIFY a signature once the phone returns one. Signing itself is a
// ceremony that belongs to the device holding the key, and deliberately stays there.
//
// PURE: no I/O, no globals. Crypto is node:crypto only — no third-party dependency is
// introduced into the verification path.

import { createPublicKey, verify as nodeVerify } from 'node:crypto';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ── RFC 8785 canonical JSON (spec §6) ────────────────────────────────────────
//
// ⚠️ A FAITHFUL PORT. This is the FOURTH copy in the repo — envelope.js (extension),
// mobile/src/lib/envelope.ts, the mirror in scripts/test_cross_compat.mjs, and now this
// one. It MUST stay byte-identical to those three: a signature is only verifiable if every
// implementation agrees on the bytes, so a divergence here silently produces signatures
// nobody else can check. Locked by the published TC-CANON vectors in
// mcp/test-signing.mjs — if this drifts, that suite fails.
//
// JSON.stringify already emits RFC 8785-conformant scalars in ECMAScript (shortest
// round-trip numbers, minimal string escaping). What it does NOT do is order keys
// recursively, and it silently turns non-finite numbers into null. Full RFC 8785 here =
// UTF-16 code-unit key sort + explicit REJECTION of values JSON cannot express.
const notJson = (v) => v === undefined || typeof v === 'function' || typeof v === 'symbol';

export function canonicalStringify(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('canonicalStringify: non-finite numbers are not expressible in RFC 8785 JSON');
  }
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(typeof value === 'string' ? value.normalize('NFC') : value);
    if (s === undefined) throw new Error('canonicalStringify: a ' + typeof value + ' is not expressible in JSON');
    return s;
  }
  if (Array.isArray(value)) {
    return '[' + value.map(v => (notJson(v) ? 'null' : canonicalStringify(v))).join(',') + ']';
  }
  // §6.2 NFC — "Implementations MUST normalize text to NFC before canonicalization to avoid
  // signature breakage from equivalent but byte different strings." It was implemented nowhere.
  // This is the VERIFIER: if the phone ever normalizes and this does not, every signature it
  // produces fails here, over text that looks identical in any log. KEYS too, and a post-NFC
  // collision is REJECTED rather than silently dropping one. Byte-identical to envelope.js and
  // mobile/src/lib/envelope.ts.
  const seen = new Map();
  for (const k of Object.keys(value)) {
    if (notJson(value[k])) continue;
    const nk = k.normalize('NFC');
    if (seen.has(nk)) throw new Error('canonicalStringify: keys collide under NFC: ' + JSON.stringify(k));
    seen.set(nk, value[k]);
  }
  const keys = [...seen.keys()].sort();   // UTF-16 code-unit order (RFC 8785 §3.2.3), post-NFC
  const parts = [];
  for (const k of keys) parts.push(JSON.stringify(k) + ':' + canonicalStringify(seen.get(k)));
  return '{' + parts.join(',') + '}';
}

// ── What a signature covers ──────────────────────────────────────────────────

/**
 * The exact bytes a §8.3 signature is computed over: the §6 canonical serialization of
 * the object with the signature field itself OMITTED. Omitting it is what makes the input
 * well defined no matter how many signatures are later appended — the same construction
 * §8.2 bootstrap mode uses for `digest`.
 *
 * @param {object} obj
 * @param {{ field?: string }} [opts] field to omit (default 'signatures'; AP2 uses 'signature')
 * @returns {Buffer} UTF-8 canonical bytes
 */
export function signingInput(obj, { field = 'signatures' } = {}) {
  if (!isObj(obj)) throw new Error('signingInput: expected an object');
  const rest = {};
  for (const k of Object.keys(obj)) {
    if (k !== field) rest[k] = obj[k];
  }
  return Buffer.from(canonicalStringify(rest), 'utf8');
}

// ── Key + signature encodings ────────────────────────────────────────────────

/**
 * Convert an X9.63 uncompressed EC point (0x04 || X || Y, 65 bytes) — what the Secure
 * Enclave exports — into a node:crypto public key.
 */
export function publicKeyFromRawPoint(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('publicKeyFromRawPoint: expected a 65-byte uncompressed P-256 point (0x04 || X || Y)');
  }
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: bytes.subarray(1, 33).toString('base64url'),
      y: bytes.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

/**
 * Convert a DER (X9.62) ECDSA signature — what SecKeyCreateSignature emits — into the raw
 * r||s form (64 bytes) that JOSE ES256 and the W3C VC suites use.
 *
 * This conversion is the boundary the spec deferred: the enclave speaks DER, interoperable
 * verifiers expect raw, and something has to translate. Doing it here means the wire form
 * is the interoperable one while the device keeps using its native output.
 */
export function derToRawSignature(der) {
  const b = Buffer.isBuffer(der) ? der : Buffer.from(der);
  let i = 0;
  if (b[i++] !== 0x30) throw new Error('derToRawSignature: not a DER SEQUENCE');
  let seqLen = b[i++];
  if (seqLen & 0x80) {                       // long form length
    const n = seqLen & 0x7f;
    if (n < 1 || n > 2) throw new Error('derToRawSignature: unsupported DER length');
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | b[i++];
  }
  if (i + seqLen !== b.length) throw new Error('derToRawSignature: DER length mismatch');

  const readInt = () => {
    if (b[i++] !== 0x02) throw new Error('derToRawSignature: expected DER INTEGER');
    const len = b[i++];
    if (len & 0x80) throw new Error('derToRawSignature: unsupported INTEGER length');
    let v = b.subarray(i, i + len);
    i += len;
    // DER integers are signed and minimally encoded: strip leading zero padding, then
    // left-pad to the 32-byte field width the raw form requires.
    while (v.length > 1 && v[0] === 0x00) v = v.subarray(1);
    if (v.length > 32) throw new Error('derToRawSignature: integer wider than P-256 field');
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };

  const r = readInt();
  const s = readInt();
  if (i !== b.length) throw new Error('derToRawSignature: trailing bytes after signature');
  return Buffer.concat([r, s]);
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify a §8.3 ES256 signature over an object.
 *
 * Never throws on a bad signature — returns false. A malformed key or an unusable
 * encoding still throws, because that is a caller bug rather than a failed verification,
 * and the two must not be conflated (silently returning false for a broken key would
 * report "not the subject's signature" when the truth is "we could not check").
 *
 * @param {object}  args.payload    the signed object (signature field may be present; it is omitted)
 * @param {Buffer|Uint8Array} args.signature
 * @param {Buffer|Uint8Array} args.publicKey  X9.63 uncompressed point (65 bytes)
 * @param {'der'|'raw'} [args.encoding='raw']
 * @param {string} [args.field='signatures']  which field to omit from the signing input
 * @returns {boolean}
 */
export function verifyEs256({ payload, signature, publicKey, encoding = 'raw', field = 'signatures' }) {
  if (encoding !== 'der' && encoding !== 'raw') {
    throw new Error(`verifyEs256: unknown signature encoding '${encoding}'`);
  }
  const key = publicKeyFromRawPoint(publicKey);      // throws on a malformed key — deliberate
  const data = signingInput(payload, { field });
  const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  try {
    return nodeVerify('sha256', data, { key, dsaEncoding: encoding === 'der' ? 'der' : 'ieee-p1363' }, sig);
  } catch {
    // node throws on structurally invalid signature bytes; that is a failed verification,
    // not a caller error.
    return false;
  }
}
