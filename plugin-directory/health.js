#!/usr/bin/env node
// Projection health report (P2) — `npm run health`, run during dogfooding.
//
// Loads the LIVE decrypted fingerprint (phone pairing / at-rest cache / local
// file, via the normal source resolution) and runs the §4.6/§4.7 + projection-
// hygiene checks over it, printing a MEASURED report: conformance + summary-
// hygiene errors (Proposal P0) and §4.7 unresolved dimensions (Proposal 0006).
// This is the "projection cleanliness" number for the end-of-window eval
// (docs/roadmap/dogfooding-eval-2026-06.md). Read-only — no network writes.
//
// Exit: 0 = clean · 1 = hygiene errors · 2 = could not load a fingerprint.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFingerprint } from './fingerprint-source.js';
import { validateFingerprint, resolveLayer } from '../spec/validate-fingerprint.mjs';

const baseDir = dirname(fileURLToPath(import.meta.url));

let vd;
try { vd = await loadFingerprint(baseDir); }
catch (e) { console.error(`Could not load a fingerprint: ${e.message}`); process.exit(2); }

const fp = vd && vd.phaedo_fingerprint;
if (!fp) { console.log('No fingerprint yet (empty vault) — nothing to check.'); process.exit(0); }

const layers = fp.layers || {};
const errs = validateFingerprint(fp);                 // structural + §4.6 + summary hygiene (P0)

// §4.7 (Proposal 0006): count dimensions and flag the ones a thin/conflicting
// evidence set leaves unresolved (which a consumer must treat conservatively).
let dimCount = 0;
const unresolved = [];
for (const [lid, L] of Object.entries(layers)) {
  const res = resolveLayer(L.signals || []);
  for (const [field, r] of Object.entries(res)) {
    if (!r) continue;
    dimCount++;
    if (r.status === 'unresolved') unresolved.push(`${lid}.${field}`);
  }
}
const sigCount = Object.values(layers).reduce((n, L) => n + ((L.signals || []).length), 0);

console.log(`\nPhaedo projection health — fingerprint ${fp.fingerprint_id || '(no id)'}`);
console.log(`  layers ${Object.keys(layers).length} · signals ${sigCount} · resolved dimensions ${dimCount}`);
console.log(`  conformance + projection-hygiene errors: ${errs.length}`);
for (const e of errs) console.log(`    ✗ ${e}`);
console.log(`  §4.7 unresolved dimensions (conflicting + thin evidence): ${unresolved.length}`);
for (const u of unresolved) console.log(`    ⚠ ${u}`);

const clean = errs.length === 0;
console.log(`\n${clean ? '✓ projection clean' : `✗ ${errs.length} hygiene issue(s)`}` +
  `${unresolved.length ? ` · ${unresolved.length} unresolved dimension(s)` : ''}\n`);
process.exit(clean ? 0 : 1);
