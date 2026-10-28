// MCP server self-pairing (P3, plan: mcp-revocable-approval-plan.md).
//
// The server is a real, independent client: its own long-term X25519 identity,
// its own SAS-confirmed pairing with the phone vault, listed + revocable on the
// phone (spec §8.4 v0.1.6 multi-client). This obviates the manual pairing-record
// export — `phaedo-mcp pair` produces `pairing.json` itself.
//
// Direct port of the extension's popup.js autoPair: LAN auto-discovery first
// (same Wi-Fi → no code typing, just the SAS confirm on the phone), else the
// relay typed-code rendezvous (D3: LAN + relay). The artifact is never touched
// here — only the pairing handshake; the fingerprint is pulled later by
// phone-source.js using the record this writes.

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { networkInterfaces } from 'os';
import { Phaedo, b64uEnc, b64uDec } from './lib/phaedo-crypto.js';
import { installNodeVault } from './lib/node-vault.js';

const { Identity, Kdf, Protocol } = Phaedo;
const RELAY_BASE = 'https://phaedo-relay.fly.dev';
const API_PORT   = 7432;
const PUBKEY_SIZE = Protocol.SIZES.X25519_PUBKEY;
// Crockford base32 (no I/L/O/U — unambiguous when typed), matching the extension.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generatePairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] & 31];
  return s;
}

export function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function localSubnets() {
  const out = new Set();
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.add(ni.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...out];
}

// Scan the local /24(s) for a phone answering /v1/health on :7432.
export async function discoverPhone() {
  for (const subnet of localSubnets()) {
    const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
    try {
      return await Promise.any(ips.map(ip =>
        fetch(`http://${ip}:${API_PORT}/v1/health`, { signal: AbortSignal.timeout(800) })
          .then(r => (r.ok ? ip : Promise.reject(new Error('no'))))
          .catch(() => Promise.reject(new Error('no')))
      ));
    } catch { /* no phone on this subnet — try the next */ }
  }
  return null;
}

async function fetchRelayOffer(code, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${RELAY_BASE}/pair-offer/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const b = await res.json().catch(() => ({}));
        if (b.relay_device_id) return b;
      }
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

async function pollPairVerification(endpoint, client_id, client_secret, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/v1/pair-status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id, client_secret }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.status === 401) return 'denied';
      if (res.ok) {
        const b = await res.json().catch(() => ({}));
        if (b.denied) return 'denied';
        if (b.verified) return 'verified';
      }
    } catch { /* phone briefly unreachable — keep polling */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  return 'timeout';
}

// Core handshake against a resolved endpoint. Returns the pairing record (the
// caller persists it). Exported so tests can drive it against a mock phone.
export async function pairAtEndpoint(endpoint, { code, relayDeviceId = null, log = () => {} } = {}) {
  const extPub     = await Identity.getPublicKey();
  const extPubB64u = b64uEnc(extPub);

  const res = await fetch(`${endpoint}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairing_token: code,
      client_name:   'Phaedo MCP Server',
      client_type:   'mcp',
      ext_pub:       extPubB64u,
    }),
    signal: AbortSignal.timeout(32000),
  });
  if (!res.ok) throw new Error(`pair request failed (HTTP ${res.status})`);
  const body = await res.json();
  if (!body.vault_pub) throw new Error('pair response missing vault_pub');

  const vaultPub = b64uDec(body.vault_pub);
  if (vaultPub.length !== PUBKEY_SIZE) throw new Error(`vault_pub wrong size (${vaultPub.length})`);

  // Long-term ECDH → pair_key; SAS (the MITM anchor) over both pubkeys.
  const shared  = await Identity.deriveSharedWithPeer(vaultPub);
  const pairKey = await Kdf.derivePairKey(shared, body.client_id);
  shared.fill(0);   // raw ECDH secret consumed — zero it (matches phone-source.js key hygiene)
  const sas     = Kdf.formatSAS(await Kdf.deriveSAS(extPub, vaultPub));

  log('');
  log('  Compare this code with the one on your phone:');
  log('');
  log(`        ${sas}`);
  log('');
  log('  If they match, tap "Codes match" on your phone.');

  const outcome = await pollPairVerification(endpoint, body.client_id, body.client_secret);
  if (outcome === 'denied')  throw new Error('pairing was denied on the phone');
  if (outcome === 'timeout') throw new Error('timed out waiting for phone confirmation');

  // The relay lane id: prefer the one resolved during a relay rendezvous, but a LAN
  // pairing ALSO needs it (the escalation channel + fp-mailbox deposit to the relay by
  // this id). The phone returns its current relay_device_id in the /v1/pair response
  // (localServer.ts), so capture it whichever rendezvous we used — without it, a LAN
  // pairing has no relay lane and phaedo_escalate fails with "no-relay-device-id".
  const relayId = relayDeviceId || body.relay_device_id || null;
  // Per-device bearer (relay/auth.js): the phone shares the secret it minted with paired
  // clients so they can authenticate to the relay AS this device. Without it,
  // escalation/fp-mailbox deposits get 401.
  const relaySecret = body.relay_device_secret || null;

  const pairKeyEnc = b64uEnc(pairKey);
  pairKey.fill(0);   // persisted as base64url below — zero the long-lived key buffer

  return {
    endpoint,
    client_id:     body.client_id,
    client_secret: body.client_secret,
    pair_key:      pairKeyEnc,
    vault_pub:     body.vault_pub,
    sas,
    ...(relayId ? { relay_device_id: relayId } : {}),
    ...(relaySecret ? { relay_device_secret: relaySecret } : {}),
  };
}

// Full flow: ensure identity → resolve endpoint (LAN → relay) → pair → persist.
export async function pair({ identityPath, pairingPath, log = console.log } = {}) {
  installNodeVault(identityPath);
  const code = generatePairingCode();

  log('Looking for your phone on the local network…');
  const ip = await discoverPhone();

  let record;
  if (ip) {
    log(`Found your phone at ${ip}. Approve "Phaedo MCP Server" on your phone.`);
    record = await pairAtEndpoint(`http://${ip}:${API_PORT}`, { code, log });
  } else {
    log('');
    log("Couldn't find your phone on this network — pairing over the relay.");
    log('');
    log(`  On your phone:  Pair with code  →   ${formatCode(code)}`);
    log('');
    log('Waiting for you to enter the code on your phone…');
    const offer = await fetchRelayOffer(code);
    if (!offer) throw new Error('timed out waiting for the phone to enter the code');
    record = await pairAtEndpoint(`${RELAY_BASE}/relay/${offer.relay_device_id}`, {
      code, relayDeviceId: offer.relay_device_id, log,
    });
  }

  // sas is display-only (the MITM compare already happened) — phone-source.js
  // doesn't need it; persist the record fields it reads.
  const { sas, ...persist } = record;
  writeFileSync(resolve(pairingPath), JSON.stringify(persist, null, 2), { mode: 0o600 });
  log('');
  log(`✓ Paired. Wrote ${pairingPath}`);
  return record;
}
