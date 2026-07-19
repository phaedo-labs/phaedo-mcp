// P3 pairing test: drive pairAtEndpoint against a mock phone that runs the SAME
// crypto, and assert the MITM-anchor invariants hold across both sides —
// pair_key (ECDH symmetry) and SAS match. No network/phone needed.

import http from 'http';
import { rmSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Phaedo, b64uEnc, b64uDec } from './lib/phaedo-crypto.js';
import { installNodeVault } from './lib/node-vault.js';
import { pairAtEndpoint } from './pairing.js';

const { Kdf } = Phaedo;
const BASE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  ✗', msg); } else console.log('  ✓', msg); };

// A mock phone: its own vault X25519 identity, answering /v1/pair (compute
// pair_key + SAS, return vault_pub) and /v1/pair-status (verified=true, i.e. the
// user tapped "Codes match").
async function startMockPhone() {
  const vaultKp  = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const vaultPub = new Uint8Array(await crypto.subtle.exportKey('raw', vaultKp.publicKey));
  let registered = null; // { client_id, client_secret, pairKey, sas }

  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', c => (buf += c));
    req.on('end', async () => {
      try {
        if (req.method === 'POST' && req.url === '/v1/pair') {
          const b = JSON.parse(buf);
          const extPub = b64uDec(b.ext_pub);
          const peerKey = await crypto.subtle.importKey('raw', extPub, { name: 'X25519' }, false, []);
          const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: peerKey }, vaultKp.privateKey, 256));
          const clientId = 'c_mock';
          const pairKey  = await Kdf.derivePairKey(shared, clientId);
          const sas      = Kdf.formatSAS(await Kdf.deriveSAS(extPub, vaultPub));
          registered = { client_id: clientId, client_secret: 's_mock', pairKey: b64uEnc(pairKey), sas, name: b.client_name, type: b.client_type };
          res.writeHead(200, { 'content-type': 'application/json' });
          // The phone returns its relay lane id AND per-device bearer secret in the pair
          // response (localServer.ts) — pairAtEndpoint must capture both so escalation /
          // fp-mailbox calls can authenticate against the relay (relay/auth.js).
          res.end(JSON.stringify({ client_id: clientId, client_secret: 's_mock', vault_pub: b64uEnc(vaultPub), relay_device_id: 'dev-mock-relay', relay_device_secret: 'sec-mock-relay' }));
        } else if (req.method === 'POST' && req.url === '/v1/pair-status') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ verified: !!registered }));   // user "approved"
        } else { res.writeHead(404); res.end(); }
      } catch (e) { res.writeHead(500); res.end(String((e && e.stack) || e)); }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { endpoint: `http://127.0.0.1:${port}`, vaultPub, getRegistered: () => registered, close: () => server.close() };
}

console.log('MCP self-pairing (pairAtEndpoint) against a mock phone:');

const idPath = resolve(BASE, 'identity.test.json');
if (existsSync(idPath)) rmSync(idPath);
installNodeVault(idPath);                       // fresh MCP identity in a temp keystore

const phone = await startMockPhone();
const rec = await pairAtEndpoint(phone.endpoint, { code: 'TESTCODE' });
const reg = phone.getRegistered();

ok(reg && reg.name === 'Phaedo MCP Server' && reg.type === 'mcp', 'phone registered the MCP client by name+type');
ok(rec.client_id === 'c_mock', 'record carries the phone-assigned client_id');
ok(rec.vault_pub === b64uEnc(phone.vaultPub), 'record carries vault_pub');
ok(rec.pair_key === reg.pairKey, 'pair_key matches across MCP and phone (ECDH symmetry)');
ok(rec.sas === reg.sas, 'SAS matches across MCP and phone (MITM anchor)');
ok(typeof rec.pair_key === 'string' && rec.pair_key.length > 0, 'pair_key present and non-empty');
ok(rec.relay_device_id === 'dev-mock-relay', 'LAN pairing captures the phone-supplied relay_device_id (escalation/fp-mailbox lane)');
ok(rec.relay_device_secret === 'sec-mock-relay', 'LAN pairing captures the phone-supplied relay_device_secret (per-device auth)');

phone.close();
rmSync(idPath, { force: true });
console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll pairing tests passed');
process.exit(failures ? 1 : 0);
