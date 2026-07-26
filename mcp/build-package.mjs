#!/usr/bin/env node
// Make the npm package self-contained. The MCP server reaches three sets of files
// at the repo root (one source of truth, shared with the extension): the injection
// renderer (context-block.js, via projection.js), the classic crypto modules
// (protocol/envelope/kdf/identity.js, via lib/phaedo-crypto.js), and the capture
// stack — capture/* for the SessionEnd hook plus the extraction modules the hook
// and the mcp-local tier-3 fold need (loaded via lib/capture-home.js). The
// published package ships only mcp/, so this copies those root modules into
// mcp/vendor/ (capture/extraction keep their subdirectories — their imports are
// intra-directory relative, so the copies resolve each other unchanged); the
// consumers prefer the location per their own doc-comments. Runs as `prepack`
// (npm pack / publish), `pretest`, and `npm run build`. Idempotent; mcp/vendor/
// is gitignored (a build artifact).

import { copyFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ROOT_FILES, CAPTURE_FILES, EXTRACTION_FILES } from './vendored-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VENDOR = join(HERE, 'vendor');
// Single source of truth, shared with scripts/export-public-repo.mjs (they drifted once).
const FILES = ROOT_FILES;
// The capture hook + tier-3 fold closure. Keep in lockstep with what
// lib/capture-home.js consumers actually import — test-vendored-capture.mjs
// exercises the whole set from a rootless copy, so a missing module fails CI.



mkdirSync(VENDOR, { recursive: true });
for (const f of FILES) copyFileSync(resolve(ROOT, f), join(VENDOR, f));
mkdirSync(join(VENDOR, 'capture'), { recursive: true });
for (const f of CAPTURE_FILES) copyFileSync(resolve(ROOT, 'capture', f), join(VENDOR, 'capture', f));
mkdirSync(join(VENDOR, 'extraction'), { recursive: true });
for (const f of EXTRACTION_FILES) copyFileSync(resolve(ROOT, 'extraction', f), join(VENDOR, 'extraction', f));
process.stdout.write(`[phaedo-mcp] bundled ${FILES.length} root + ${CAPTURE_FILES.length} capture + ${EXTRACTION_FILES.length} extraction modules → mcp/vendor/\n`);
