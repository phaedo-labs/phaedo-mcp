#!/usr/bin/env node
// Make the npm package self-contained. The MCP server reaches two sets of files at
// the repo root (one source of truth, shared with the extension): the injection
// renderer (context-block.js, via projection.js) and the classic crypto modules
// (protocol/envelope/kdf/identity.js, via lib/phaedo-crypto.js). The published
// package ships only mcp/, so this copies those root modules into mcp/vendor/;
// projection.js and lib/phaedo-crypto.js prefer the vendored copies when present
// and fall back to the repo root in dev. Runs as `prepack` (npm pack / publish)
// and `npm run build`. Idempotent; mcp/vendor/ is gitignored (a build artifact).

import { copyFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VENDOR = join(HERE, 'vendor');
const FILES = ['context-block.js', 'protocol.js', 'envelope.js', 'kdf.js', 'identity.js'];

mkdirSync(VENDOR, { recursive: true });
for (const f of FILES) copyFileSync(resolve(ROOT, f), join(VENDOR, f));
process.stdout.write(`[phaedo-mcp] bundled ${FILES.length} root modules → mcp/vendor/\n`);
