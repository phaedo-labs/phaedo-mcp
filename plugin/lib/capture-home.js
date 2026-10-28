// Where the capture stack lives — repo root (dev) or mcp/vendor/ (published).
//
// The SessionEnd hook and the mcp-local tier-3 fold import capture/* and a
// slice of extraction/* . In the dev clone those live at the repo root (the
// single source of truth, shared with the extension and parity-tested); in the
// published npm tarball build-package.mjs vendors them under mcp/vendor/.
//
// Unlike lib/phaedo-crypto.js (which prefers the vendored copies), this
// resolver PREFERS THE REPO ROOT when it exists: the hook runs headless on
// every session end, and a stale vendor/ left behind by an earlier `npm test`
// build on a dev clone would silently shadow freshly-pulled, parity-tested
// sources. A published install has no repo root two levels up, so it always
// lands on vendor/ there; the vendored copies are exercised by
// test-vendored-capture.mjs (a rootless layout), so they can't rot unnoticed.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // mcp/lib
const ROOT = resolve(HERE, '..', '..');               // repo root — dev
const VENDOR = resolve(HERE, '..', 'vendor');         // mcp/vendor — bundled (npm package)

// Absolute path for a capture-stack module, e.g. 'capture/state.js' or
// 'extraction/delta-lift.js' — or null when it exists in neither home.
export function captureModulePath(subpath) {
  const dev = resolve(ROOT, subpath);
  if (existsSync(dev)) return dev;
  const vendored = resolve(VENDOR, subpath);
  return existsSync(vendored) ? vendored : null;
}

// True when the whole capture stack is loadable from this install location
// (the install.mjs gate for wiring the SessionEnd hook).
export function captureStackAvailable() {
  return !!(captureModulePath('capture/transcript.js') && captureModulePath('extraction/delta-lift.js'));
}

// Dynamic-import a capture-stack module from whichever home resolves. Throws
// ERR_MODULE_NOT_FOUND-equivalent when neither does (callers that must degrade
// gracefully — capture-local.js — catch it).
export function loadCaptureModule(subpath) {
  const path = captureModulePath(subpath);
  if (!path) throw new Error(`capture module not found in repo root or vendor/: ${subpath}`);
  return import(pathToFileURL(path).href);
}
