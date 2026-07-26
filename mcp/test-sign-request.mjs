// §8.3 sign-request suite — the MCP half of the signing ceremony.
//
// Exercises the round-trip against an in-process fake relay + a node:crypto "phone" that
// signs exactly what the enclave would (ECDSA P-256/SHA-256, DER). Focus: the security
// properties, not just the happy path — sign-what-you-see, refusal ≠ timeout, and a
// mismatched signature never being reported as signed.

import crypto from 'node:crypto';
import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';
import {
  buildSignRequestDeposit,
  unwrapSignResponse,
  verifySignedMandate,
  mandateSigningInput,
  depositSignRequest,
  pollSignOnce,
} from './signing-request.js';

const { Kdf, Envelope } = Phaedo;

let checks = 0, failures = 0;
const ok = (label, cond) => { checks++; if (!cond) { failures++; console.error(`  ✗ ${label}`); } };

// A subject signing key, as the Secure Enclave would expose it.
const { publicKey: subjectPub, privateKey: subjectPriv } =
  crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rawPub = (pk) => {
  const jwk = pk.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
};
const signingPublicKey = rawPub(subjectPub).toString('base64');

const pairKey = crypto.getRandomValues(new Uint8Array(32));
const pairKeyB64u = b64uEnc(pairKey);
const pairing = { pair_key: pairKeyB64u, relay_device_id: 'dev-1', relay_device_secret: 's3cret' };

const MANDATE = { mandate_type: 'intent', amount: 500, currency: 'USD', domain: 'finance', signature: null };

// The phone: seal a sign_response under fp_sync_key, signing exactly the bytes the request
// implies (mandate with `signature` omitted).
async function phoneSign(mandate, { refuse = false, tamperBytes = null } = {}) {
  const fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  let inner;
  if (refuse) {
    inner = { kind: 'sign_response', data: { refused: true, reason: 'declined' } };
  } else {
    const toSign = tamperBytes || mandateSigningInput(mandate);
    const der = crypto.sign('sha256', toSign, subjectPriv);
    inner = { kind: 'sign_response', data: { signature: der.toString('base64'), encoding: 'der', signed_at: '2026-07-24T00:00:00Z' } };
  }
  const pt = new TextEncoder().encode(JSON.stringify(inner));
  const envelope = await Envelope.wrap(pt, fpSyncKey, { artifact_kind: 'sign_response', created_at: '2026-07-24T00:00:00Z' });
  return { envelope };
}

// A fake relay: one deposit slot, one response slot, keyed by request_id.
function fakeRelay() {
  const deposits = new Map();     // request_id -> deposit body
  let response = null;            // { request_id, body }
  const fetch = async (url, opts = {}) => {
    if (url.includes('/escalation/response/')) {
      const rid = decodeURIComponent(url.split('/escalation/response/')[1]);
      if (response && response.request_id === rid) return { ok: true, json: async () => response.body };
      return { ok: true, json: async () => null };
    }
    if (url.includes('/escalation/')) {
      const body = JSON.parse(opts.body);
      deposits.set(body.request_id, body);
      return { ok: true, json: async () => ({ expires_at: Date.now() + 300000, woke: true }) };
    }
    return { ok: false, status: 404 };
  };
  return { fetch, deposits, setResponse: (request_id, body) => { response = { request_id, body }; } };
}

console.log('\nsigning input omits the signature field (sign-what-you-see anchor)');
ok('signature field is not in the signed bytes',
  mandateSigningInput(MANDATE).toString('utf8') === '{"amount":500,"currency":"USD","domain":"finance","mandate_type":"intent"}');
ok('a null vs a filled signature produce identical signing input',
  mandateSigningInput({ ...MANDATE, signature: 'later' }).toString('utf8') === mandateSigningInput(MANDATE).toString('utf8'));

console.log('\ndeposit is encrypted, kind-tagged, and re-decryptable');
{
  const body = await buildSignRequestDeposit(pairKeyB64u, 'r1', MANDATE, { windowMs: 300000 });
  ok('deposit carries request_id + envelope + window', body.request_id === 'r1' && !!body.envelope && body.window_ms === 300000);
  const fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  const pt = await Envelope.unwrap(body.envelope, fpSyncKey);
  const inner = JSON.parse(new TextDecoder().decode(pt));
  ok('inner kind is sign_request (routes to the signing sheet, not escalation)', inner.kind === 'sign_request');
  ok('inner carries the mandate to render + sign', inner.data.mandate.amount === 500);
}

console.log('\nhappy path: deposit → phone signs → poll verifies → mandate carries the signature');
{
  const relay = fakeRelay();
  const dep = await depositSignRequest(pairing, MANDATE, { fetch: relay.fetch, requestId: 'r2', windowMs: 300000 });
  ok('deposited', dep.deposited && dep.request_id === 'r2');
  relay.setResponse('r2', await phoneSign(MANDATE));
  const res = await pollSignOnce(pairing, 'r2', MANDATE, { fetch: relay.fetch, signingPublicKey });
  ok('resolved + signed', res.resolved && res.signed === true);
  ok('mandate now carries the signature', typeof res.mandate.signature === 'string' && res.mandate.signature.length > 0);
  ok('and the signed_at it reported', res.mandate.signed_at === '2026-07-24T00:00:00Z');
  // independent re-verification
  const v = verifySignedMandate({ mandate: MANDATE, signature: res.mandate.signature, encoding: 'der', signingPublicKey });
  ok('the attached signature verifies against the published key', v.verified === true);
}

console.log('\nSIGN-WHAT-YOU-SEE: a signature over DIFFERENT terms does not verify for this mandate');
{
  const relay = fakeRelay();
  await depositSignRequest(pairing, MANDATE, { fetch: relay.fetch, requestId: 'r3' });
  // The phone signs a mandate with a bigger amount than the one the server sent.
  const evilMandate = { ...MANDATE, amount: 5_000_000 };
  relay.setResponse('r3', await phoneSign(evilMandate));
  const res = await pollSignOnce(pairing, 'r3', MANDATE, { fetch: relay.fetch, signingPublicKey });
  ok('resolved but NOT signed', res.resolved && res.signed === false);
  ok('reason is verify-failed (server-intended terms were not what got signed)', res.reason === 'verify-failed');
}

console.log('\nrefusal is first-class and distinct from a timeout');
{
  const relay = fakeRelay();
  await depositSignRequest(pairing, MANDATE, { fetch: relay.fetch, requestId: 'r4' });
  relay.setResponse('r4', await phoneSign(MANDATE, { refuse: true }));
  const refused = await pollSignOnce(pairing, 'r4', MANDATE, { fetch: relay.fetch, signingPublicKey });
  ok('refusal resolves as unsigned with reason refused', refused.resolved && refused.signed === false && refused.reason === 'refused');

  // No response at all → pending (not refused, not signed). The two must not collapse.
  const pending = await pollSignOnce(pairing, 'r-none', MANDATE, { fetch: relay.fetch, signingPublicKey });
  ok('no answer → pending, not refused', pending.resolved === false && pending.status === 'pending');

  const expired = await pollSignOnce(pairing, 'r4', MANDATE, { fetch: relay.fetch, signingPublicKey, expiresAt: 1, now: () => 2 });
  ok('past the deadline → expired', expired.resolved === false && expired.status === 'expired');
}

console.log('\nverifySignedMandate reason codes are precise');
{
  const good = await phoneSign(MANDATE);
  const data = await unwrapSignResponse(pairKeyB64u, good);
  ok('a genuine response unwraps to a signature', typeof data.signature === 'string');

  ok('missing published key is its own reason, not a mismatch',
    verifySignedMandate({ mandate: MANDATE, signature: data.signature, signingPublicKey: null }).reason === 'no-published-signing-key');
  ok('a malformed key is a key-error, not a signature mismatch',
    verifySignedMandate({ mandate: MANDATE, signature: data.signature, signingPublicKey: Buffer.from('short').toString('base64') }).reason?.startsWith('key-error'));
  ok('a wrong-key signature is a clean mismatch',
    verifySignedMandate({ mandate: MANDATE, signature: data.signature, signingPublicKey: rawPub(crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey).toString('base64') }).reason === 'signature-mismatch');
}

console.log('\nguards: an already-signed mandate is not re-sent; junk is refused');
{
  const relay = fakeRelay();
  const signed = await depositSignRequest(pairing, { ...MANDATE, signature: 'already' }, { fetch: relay.fetch });
  ok('an already-signed mandate is not deposited', signed.deposited === false && signed.reason === 'already-signed');
  const noMandate = await depositSignRequest(pairing, null, { fetch: relay.fetch });
  ok('a null mandate is refused', noMandate.deposited === false && noMandate.reason === 'no-mandate');
  const unpaired = await depositSignRequest({}, MANDATE, { fetch: relay.fetch });
  ok('unpaired is refused', unpaired.deposited === false && unpaired.reason === 'unpaired');
}

if (failures) {
  console.error(`\n✗ sign-request: ${failures} of ${checks} checks failed\n`);
  process.exit(1);
}
console.log(`\n✓ sign-request: ${checks} checks passed\n`);
