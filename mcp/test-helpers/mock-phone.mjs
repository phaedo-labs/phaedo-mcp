// Shared test helper: a mock Phaedo phone (real localhost HTTP) speaking
// /v1/authorize + /v1/profile with the SAME crypto modules. Used by the 1b-i
// boundary test and the 1b-iii cache test so the mock lives in one place.

import http from 'http';
import { Phaedo, b64uEnc, b64uDec } from '../lib/phaedo-crypto.js';

const { Identity, Kdf, Envelope } = Phaedo;

// startMockPhone({ pairKey, sampleFp, metrics }) → { rec, state, close }
//   rec    — pairing record pointing at the mock (endpoint/client_id/secret/pair_key)
//   state  — { authorizeCount, sessions, sampleFp, metrics } (mutable/observable)
//   close  — stop the server
export async function startMockPhone({ pairKey, sampleFp, metrics }) {
  const sessions = new Map(); // token -> sessionKey
  // revoked: flip true to simulate the user revoking this client on the phone —
  // /v1/authorize then returns 401 invalid_credentials (as localServer does when
  // findClient → null).
  const state = { authorizeCount: 0, sessions, sampleFp, metrics, revoked: false };

  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', async () => {
      try {
        if (req.method === 'POST' && req.url === '/v1/authorize') {
          if (state.revoked) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_credentials' })); return;
          }
          state.authorizeCount++;
          const b = JSON.parse(buf);
          const extPub = b64uDec(b.eph_ext_pub);
          if (!(await Kdf.verifyAuthEphemeral(pairKey, 'ext', extPub, b64uDec(b.eph_mac)))) {
            res.writeHead(403); res.end(JSON.stringify({ error: 'eph_mac_invalid' })); return;
          }
          const eph = await Identity.generateEphemeral();
          const shared = await Identity.deriveEphemeralShared(eph.privateKey, extPub);
          const token = 'tok-' + state.authorizeCount;
          sessions.set(token, await Kdf.deriveSessionKey(shared, token));
          const ephMac = await Kdf.authEphemeral(pairKey, 'vault', eph.publicKey);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            session_token: token,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            eph_vault_pub: b64uEnc(eph.publicKey),
            eph_mac: b64uEnc(ephMac),
          }));
        } else if (req.method === 'GET' && req.url === '/v1/profile') {
          const auth = req.headers['authorization'] || '';
          const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
          const sessionKey = sessions.get(token);
          if (!sessionKey) { res.writeHead(401); res.end(JSON.stringify({ error: 'invalid_token' })); return; }
          const plaintext = new TextEncoder().encode(JSON.stringify({ data: state.sampleFp, metrics: state.metrics, scopes: ['profile:full'] }));
          const envelope = await Envelope.wrap(plaintext, sessionKey, {
            artifact_kind: 'fingerprint', fingerprint_id: state.sampleFp.fingerprint_id, created_at: new Date().toISOString(),
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version: '1', envelope, issued_at: Date.now() }));
        } else {
          res.writeHead(404); res.end();
        }
      } catch (e) {
        res.writeHead(500); res.end(String((e && e.stack) || e));
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const rec = {
    endpoint: `http://127.0.0.1:${port}`,
    client_id: 'ext-test', client_secret: 'secret-test',
    pair_key: b64uEnc(pairKey),
  };
  return { rec, state, close: () => server.close() };
}

export const SAMPLE_FP = {
  fingerprint_id: 'fp-boundary-1',
  updated_at: '2026-06-01T00:00:00.000Z',
  layers: {
    surface: {
      label: 'Communication style',
      responses: [{ label: 'Response Length', question: 'len', answer: 'Thorough — go deep and cover edge cases.' }],
      summary: 'Prefers concise, direct answers.',
    },
  },
};
export const SAMPLE_METRICS = { signals: { surface: { too_long: 2 } }, ling: { messageCount: 40 }, sessions: { sessionCount: 4 } };
