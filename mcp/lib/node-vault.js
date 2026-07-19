// Minimal `globalThis.phaedoVault` shim for Node, so the repo-root identity.js
// (which reads/writes globalThis.phaedoVault) can persist the MCP server's
// long-term X25519 identity outside a browser.
//
// D2 (signed off 2026-06-05): a restricted-perms (0600) JSON file. The
// `privateKeyJwk` it holds is a long-term secret — same class as `pair_key` in
// pairing.json. OS keychain is the documented upgrade path.
//
// identity.js treats a falsy read() as "vault locked" and throws; this shim
// always returns a truthy object (empty {} when the file doesn't exist yet), so
// getOrCreate() generates a fresh identity and update()s it on first use.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { resolve } from 'path';

export function installNodeVault(filePath) {
  const path = resolve(filePath);

  const read = () => {
    if (!existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
  };

  globalThis.phaedoVault = {
    async read() { return read(); },
    async update(patch) {
      const next = { ...read(), ...patch };
      writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
      try { chmodSync(path, 0o600); } catch {}   // enforce perms if the file pre-existed
    },
  };

  return path;
}
