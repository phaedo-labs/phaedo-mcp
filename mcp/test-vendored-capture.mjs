#!/usr/bin/env node
// The vendored capture stack — the published-tarball layout actually runs.
// Run: node mcp/test-vendored-capture.mjs
//
// Simulates an npm install: builds vendor/ (build-package.mjs), copies mcp/ to a
// temp directory whose parent has NO repo-root capture/ or extraction/, then
// proves from that rootless copy that
//   1. the SessionEnd hook runs end to end (spawned exactly as Claude Code
//      spawns it: node <hook> with JSON on stdin) and accumulates state, and
//   2. the tier-3 fold (capture-local.js) folds that state into a served
//      fingerprint, and
//   3. install.mjs's captureHookAvailable() gate says YES there (and still NO
//      for a layout with neither home).
// This is what keeps build-package.mjs's CAPTURE/EXTRACTION file lists honest —
// a module missing from the vendor closure fails here, not on a user's machine.

import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const MCP = dirname(fileURLToPath(import.meta.url));

// 1. Fresh vendor build, then a rootless copy of mcp/ (skip node_modules — the
// hook and the fold use only node builtins + intra-package + vendored modules).
execFileSync(process.execPath, [join(MCP, 'build-package.mjs')], { stdio: 'pipe' });
const tmp = mkdtempSync(join(tmpdir(), 'phaedo-vendored-'));
const pkg = join(tmp, 'phaedo-mcp');
cpSync(MCP, pkg, {
  recursive: true,
  filter: (src) => !src.includes('node_modules') && !src.endsWith('pairing.json') && !src.endsWith('pairing.capture.json'),
});
ok(!existsSync(join(tmp, 'capture')) && existsSync(join(pkg, 'vendor', 'capture', 'transcript.js')),
   'rootless layout: no repo-root capture/, vendored copies present');

// 2. The hook, spawned as Claude Code spawns it, from the rootless copy.
const stateDir = join(tmp, 'state');
const L = (o) => JSON.stringify(o);
const transcript = [
  L({ type: 'user', uuid: 'u1', timestamp: '2026-07-20T10:00:00Z', sessionId: 'vend-1', message: { role: 'user', content: 'this is too long, cut it down' } }),
  L({ type: 'assistant', uuid: 'a1', sessionId: 'vend-1', message: { role: 'assistant', content: [{ type: 'text', text: 'shorter' }] } }),
].join('\n');
const tPath = join(tmp, 'vend-1.jsonl');
writeFileSync(tPath, transcript, 'utf8');

const hook = spawnSync(process.execPath, [join(pkg, 'hooks', 'session-end.mjs')], {
  input: JSON.stringify({ session_id: 'vend-1', transcript_path: tPath, hook_event_name: 'SessionEnd' }),
  env: { ...process.env, PHAEDO_MCP_STATE_DIR: stateDir, PHAEDO_CAPTURE_MODEL: '', PHAEDO_CAPTURE_PAIRING: '' },
  encoding: 'utf8',
  timeout: 30000,
});
ok(hook.status === 0, `hook exits 0 from the rootless copy (stderr: ${String(hook.stderr).slice(0, 120) || 'none'})`);
const statePath = join(stateDir, 'capture-state.json');
ok(existsSync(statePath), 'hook accumulated local state (imports resolved via vendor/)');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const surface = Object.values(state.surfaces)[0];
ok(surface && surface.sessions['vend-1'].counts.behavioral_signals.surface.too_long === 1,
   'vendored detectors counted the correction (too_long ×1)');

// 2b. §5.7 commitments resolve from the rootless copy too. consult-policy.js reaches a
// REPO-ROOT classic script, which the published tarball does not ship — and because
// mcp/package.json is `type: module`, a vendored `.js` required the obvious way parses
// as ESM and yields an empty object. loadPolicies is defensive, so that failure is
// SILENT: every commitment would quietly stop gating on an npm install while the dev
// clone stayed green. Pin it here, where a missing vendor entry already fails CI.
{
  const { loadPolicies } = await import(pathToFileURL(join(pkg, 'consult-policy.js')).href);
  const vd = { phaedo_fingerprint: { commitments: [{
    commitment_id: 'c1', statement: 'already declined this vendor', domains: ['procurement'],
    effect: 'escalate', expires_at: '2099-01-01T00:00:00Z', source: 'subject',
  }] } };
  const pols = loadPolicies(vd, { now: Date.parse('2026-07-22T12:00:00Z') });
  ok(pols.length === 1 && pols[0].effect === 'escalate',
     `commitments gate from the rootless copy (vendored commitments.js resolved) — got ${JSON.stringify(pols)}`);
  ok(pols[0].note && !/already declined/.test(pols[0].note),
     'and the undisclosed statement is still withheld in the published layout');
}

// 3. The tier-3 fold from the same rootless copy (unpaired local serve).
process.env.PHAEDO_MCP_STATE_DIR = stateDir;
delete process.env.PHAEDO_FINGERPRINT;
delete process.env.PHAEDO_PAIRING;
const { foldLocalCapture, isLocalCaptureOwner } = await import(pathToFileURL(join(pkg, 'capture-local.js')).href);
ok(await isLocalCaptureOwner(false) === true, 'rootless copy: unpaired server owns the capture lane (owner.js loaded from vendor/)');
const folded = await foldLocalCapture(
  { phaedo_fingerprint: { fingerprint_id: 'fp-vend', updated_at: '2026-07-20T10:05:00Z', layers: {} } },
  { now: '2026-07-20T10:05:00Z' },
);
const sig = Object.values(folded.phaedo_fingerprint.layers)
  .flatMap((d) => d.signals || [])
  .find((s) => s.source === 'delta' && s.field === 'response_length_pref');
ok(sig && sig.observation_count === 1, 'tier-3 fold works rootless (persist/reconcile chain loaded from vendor/)');

// 4. The install gate, evaluated against both layouts.
const { captureHookAvailable } = await import(pathToFileURL(join(pkg, 'install.mjs')).href);
ok(captureHookAvailable(join(pkg, 'hooks', 'session-end.mjs')) === true, 'gate: vendored (published) layout wires the capture hook');
const bare = join(tmp, 'bare', 'hooks');
ok(captureHookAvailable(join(bare, 'session-end.mjs')) === false, 'gate: a layout with neither home stays injection-only');

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ vendored capture stack: ${pass} checks passed`);
