#!/usr/bin/env node
// `phaedo-mcp pair` — pair this MCP server with the phone vault as its own
// SAS-approved, revocable client (plan: mcp-revocable-approval-plan.md, P3).
//
// Writes the server's long-term identity to identity.json (0600) and the
// resulting pairing record to pairing.json (0600) — the file phone-source.js
// reads. Run once; the server then authorizes autonomously.
//
//   node pair.js
//   PHAEDO_IDENTITY=/secure/id.json PHAEDO_PAIRING=/secure/pairing.json node pair.js

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { pair } from './pairing.js';

const BASE_DIR = dirname(fileURLToPath(import.meta.url));
const identityPath = process.env.PHAEDO_IDENTITY
  ? resolve(process.cwd(), process.env.PHAEDO_IDENTITY)
  : resolve(BASE_DIR, 'identity.json');
const pairingPath = process.env.PHAEDO_PAIRING
  ? resolve(process.cwd(), process.env.PHAEDO_PAIRING)
  : resolve(BASE_DIR, 'pairing.json');

pair({ identityPath, pairingPath, log: (m) => process.stdout.write(m + '\n') })
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`\n✗ Pairing failed: ${err.message}\n`);
    process.exit(1);
  });
