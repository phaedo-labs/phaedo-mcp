// Loads the repo-root Phaedo crypto modules into Node and exposes them.
//
// They're classic scripts that set globalThis.Phaedo.* and (verified) load in
// Node with zero shims — Node has global crypto.subtle / TextEncoder / btoa.
// Load order matters: protocol → envelope → kdf → identity (envelope.js and
// kdf.js read Phaedo.Protocol at load).
//
// Option B (1b-i) uses only the STATELESS path: Kdf.* + Identity.generateEphemeral
// / deriveEphemeralShared + Envelope.unwrap. The vault-backed Identity functions
// (getOrCreate/getPublicKey) are NOT called here, so no phaedoVault shim is needed.

import { createRequire } from 'module';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url)); // mcp/lib
const VENDOR = resolve(HERE, '..', 'vendor');         // mcp/vendor — bundled (npm package)
const ROOT = resolve(HERE, '..', '..');               // repo root — dev

// Prefer the bundled copies (self-contained package) over the repo root (dev).
// Load order matters: protocol → envelope → kdf → identity.
for (const f of ['protocol.js', 'envelope.js', 'kdf.js', 'identity.js', 'capabilities.js', 'authored-source.js']) {
  const vf = resolve(VENDOR, f);
  require(existsSync(vf) ? vf : resolve(ROOT, f));
}

export const Phaedo = globalThis.Phaedo;
if (!Phaedo?.Envelope || !Phaedo?.Kdf || !Phaedo?.Identity || !Phaedo?.Protocol) {
  throw new Error('Phaedo crypto modules did not load (Protocol/Envelope/Kdf/Identity).');
}

// The §5 step-3 upgrade gate's vocabulary. The agent READS authored content, so it has to be
// able to say what it can do — otherwise the gate stays shut on its silence forever, which is
// correct but useless. Loaded here rather than imported directly so the published package picks
// up the vendored copy exactly like the crypto modules do.
export const Capabilities = globalThis.PhaedoCapabilities;
if (!Capabilities?.advertise) {
  throw new Error('Phaedo capabilities module did not load.');
}

// The step-3 read path's §5.4 rule. Used at the vd boundary so every authored-content reader
// downstream is §5-canonical without threading the configuration through its signature.
export const AuthoredSource = globalThis.PhaedoAuthoredSource;
if (!AuthoredSource?.configGoverns) {
  throw new Error('Phaedo authored-source module did not load.');
}

// base64url <-> Uint8Array (Node-native), matching the extension's wire encoding.
export const b64uEnc = (u8) => Buffer.from(u8).toString('base64url');
export const b64uDec = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
