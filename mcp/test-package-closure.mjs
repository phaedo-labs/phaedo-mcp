#!/usr/bin/env node
// The PUBLISHED tarball starts. Run: node mcp/test-package-closure.mjs
//
// Why this exists: phaedo-mcp 0.2.0, 0.2.1 and 0.2.2 were all dead on arrival.
// `server.js` imports ./delegation-sync.js, ./receipts-sync.js and ./escalation.js;
// none of the three were in package.json's hand-maintained `files` allowlist, so
// `npx phaedo-mcp` threw ERR_MODULE_NOT_FOUND before the transport opened. Three
// publishes over two months, every one of them broken, and nothing caught it:
//
//   - `npm pack --dry-run` (the CI "packaging sanity" step) proves the tarball
//     BUILDS, never that it RUNS.
//   - test-vendored-capture.mjs copies the whole of mcp/ to a rootless temp dir,
//     so it proves the vendor/ closure while silently supplying every file the
//     allowlist forgot.
//   - every other suite imports from the working tree, where all 38 modules exist.
//
// The gap is structural: `files` is an allowlist written by hand, and a new module
// is added to the import graph in one commit and to the allowlist in another, or
// never. So this test derives the truth twice, from two directions.
//
//   PART A (static, fast, names the file). Walk the real entry points — the `bin`
//   target, every non-test `node <file>` in `scripts`, and hooks/ — following
//   relative imports transitively. Every file reached MUST be covered by `files`.
//   A missing module fails here with its own name, not a stack trace.
//
//   PART B (real, slow, proves the claim). `npm pack`, extract the tarball into a
//   temp dir that has NO repo above it, and drive THAT server over stdio with the
//   MCP SDK client. Asserts it initializes and lists the full public tool surface.
//   Part A can only check what it can parse; Part B checks what npm actually ships.
//
// Deps come from a symlink to mcp/node_modules — the tarball never carries them
// and resolving real ones would need the network, which a test must not.

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, symlinkSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MCP = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(MCP, 'package.json'), 'utf8'));

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

// The public tool surface, as the binding documents it. Listed here rather than
// derived from server.js so that DROPPING a tool from the package is a test
// failure and not a quietly smaller API.
const PUBLIC_TOOLS = [
  'phaedo_request_injection',
  'phaedo_consult',
  'phaedo_check_authorization',
  'phaedo_record_outcome',
  'phaedo_escalate',
  'phaedo_escalation_status',
  'phaedo_sign_mandate',
  'phaedo_sign_status',
];

// Modules nothing imports, spawned as `node <file>` by something outside the
// package — so an import walk alone would call them unreachable and let their
// dependencies fall out of the allowlist.
const SPAWN_ENTRIES = [
  'capture-a11y.js',   // capture/a11y-macos: the Swift reader pipes turns to this spine
];

// ── Part A: the import closure is inside the allowlist ────────────────────────

// Entry points a CONSUMER can reach: the bin target plus every `node <file>` in
// scripts, minus the test suites (not shipped, and their fixtures would drag in
// test-helpers/). hooks/ are spawned by Claude Code, never imported, so they are
// roots of their own and would otherwise look unreachable.
function entryPoints() {
  const entries = new Set(Object.values(pkg.bin || {}).map((p) => p.replace(/^\.\//, '')));
  for (const body of Object.values(pkg.scripts || {})) {
    for (const m of body.matchAll(/node\s+((?:\.\/)?[\w./-]+\.m?js)/g)) {
      const rel = m[1].replace(/^\.\//, '');
      if (rel.startsWith('..')) continue;          // ../spec/* — dev-only, outside the package
      if (rel.startsWith('test-')) continue;       // suites are not published
      if (existsSync(join(MCP, rel))) entries.add(rel);
    }
  }
  for (const h of readdirSync(join(MCP, 'hooks'))) if (h.endsWith('.mjs')) entries.add(join('hooks', h));
  for (const s of SPAWN_ENTRIES) entries.add(s);
  return entries;
}

// Relative specifiers only. A bare specifier is a dependency (npm resolves it);
// a specifier escaping mcp/ is a repo-root module that build-package.mjs vendors
// into vendor/, which test-vendored-capture.mjs already keeps honest.
const IMPORT_PATTERNS = [
  /(?:^|[^\w.])(?:import|export)[\s\S]{0,200}?from\s+['"](\.[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  /^\s*import\s+['"](\.[^'"]+)['"]/gm,
];

function closure(entries) {
  const seen = new Set();
  const unresolved = [];
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const abs = join(MCP, rel);
    if (!existsSync(abs)) { unresolved.push(rel); return; }
    const src = readFileSync(abs, 'utf8');
    for (const re of IMPORT_PATTERNS) {
      for (const m of src.matchAll(re)) {
        const target = relative(MCP, resolve(dirname(abs), m[1]));
        if (!target.startsWith('..')) walk(target);
      }
    }
  };
  for (const e of entries) walk(e);
  return { files: [...seen].sort(), unresolved };
}

// `files` entries are either an exact path or a directory prefix ending in '/'.
const covered = (f) => (pkg.files || []).some((a) => (a.endsWith('/') ? f.startsWith(a) : f === a));

const { files: reachable, unresolved } = closure(entryPoints());
ok(unresolved.length === 0, `every relative import resolves in the working tree (dangling: ${unresolved.join(', ') || 'none'})`);
ok(reachable.length > 20, `closure walked a real graph, not an empty one (${reachable.length} modules)`);

const orphans = reachable.filter((f) => !covered(f));
ok(orphans.length === 0,
   `every module the entry points import is in package.json "files" — MISSING: ${orphans.join(', ')}`);

// Three files carry the version, and all three have drifted at least once: server.js
// advertised '0.2.2' in the MCP handshake for two months after package.json moved on,
// and the publish workflow keys the npm release off package.json while the registry
// entry comes from server.json. A mismatch is not cosmetic — it is what the client
// reports and what the registry lists.
const srv = JSON.parse(readFileSync(join(MCP, 'server.json'), 'utf8'));
ok(srv.version === pkg.version, `server.json version matches package.json (${srv.version} vs ${pkg.version})`);
for (const p of srv.packages || []) {
  ok(p.version === pkg.version, `server.json packages[${p.identifier}].version matches package.json (${p.version})`);
}

// server.json is validated by the MCP REGISTRY, not by anything here — so a field
// that violates its schema fails at publish time, after npm has already accepted
// the release. That is exactly what happened to 0.3.0: a description of 110
// characters against a 100-character limit left the package live on npm and the
// registry entry missing, a split state the idempotent workflow then had to be
// re-run to heal. These mirror the constraints of the schema server.json names in
// `$schema` (2025-12-11); they are asserted here so the limit fails on a laptop
// in milliseconds instead of in a release job.
const REGISTRY_LIMITS = {
  description: { max: 100, min: 1 },
  title: { max: 100, min: 1 },          // optional; checked only when present
  version: { max: 255, min: 1 },
  name: { max: 200, min: 3, pattern: /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/ },
};
for (const [field, lim] of Object.entries(REGISTRY_LIMITS)) {
  const v = srv[field];
  if (v === undefined) continue;
  ok(v.length <= lim.max && v.length >= lim.min,
     `server.json "${field}" is ${lim.min}-${lim.max} chars for the MCP registry (got ${v.length})`);
  if (lim.pattern) ok(lim.pattern.test(v), `server.json "${field}" matches the registry's pattern`);
}

console.log(`part A: ${pass} checks passed (${reachable.length} modules in the runtime closure)`);

// ── Part B: pack it, unpack it somewhere with no repo above it, and boot it ───

const tmp = mkdtempSync(join(tmpdir(), 'phaedo-pack-'));
let installed;
try {
  // `npm pack` runs prepack (build-package.mjs), so vendor/ is fresh — exactly the
  // artifact `npm publish` would upload.
  const packed = execFileSync('npm', ['pack', '--pack-destination', tmp], { cwd: MCP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim().split('\n').pop().trim();
  const tarball = join(tmp, packed);
  ok(existsSync(tarball), `npm pack produced ${packed}`);

  execFileSync('tar', ['xzf', tarball, '-C', tmp]);
  installed = join(tmp, 'package');
  ok(existsSync(join(installed, 'server.js')), 'tarball extracts with server.js at its root');
  ok(!existsSync(join(tmp, 'capture')) && !existsSync(join(tmp, '..', 'spec')),
     'extracted package sits outside the repo — no root modules to fall back on');

  // Dependencies only. Everything the package imports of its OWN must already be
  // in the tarball; that is the whole point of the assertion below.
  symlinkSync(join(MCP, 'node_modules'), join(installed, 'node_modules'), 'dir');

  const stateDir = join(tmp, 'state');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(installed, 'server.js')],
    env: {
      ...process.env,
      PHAEDO_MCP_STATE_DIR: stateDir,
      // Hermetic, for the same reason test-smoke.mjs pins these: a paired dev box
      // would otherwise send this test's traffic to the owner's real phone.
      PHAEDO_FINGERPRINT: join(installed, 'sample-fingerprint.json'),
      PHAEDO_PAIRING: join(stateDir, 'pairing.json'),
    },
  });
  const client = new Client({ name: 'phaedo-package-closure', version: '0.0.0' });

  // THE assertion. 0.2.0–0.2.2 threw ERR_MODULE_NOT_FOUND here, before a single
  // byte of MCP traffic.
  await client.connect(transport);
  ok(true, 'the packed server boots and completes the MCP initialize handshake');

  const advertised = client.getServerVersion();
  ok(advertised?.version === pkg.version,
     `the handshake advertises the package version (got ${advertised?.version}, expected ${pkg.version})`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const absent = PUBLIC_TOOLS.filter((t) => !names.includes(t));
  ok(absent.length === 0, `packed server lists the full public tool surface (missing: ${absent.join(', ') || 'none'})`);

  // One real call, so "boots" means "serves" and not merely "registered handlers".
  const call = await client.callTool({
    name: 'phaedo_request_injection',
    arguments: { session_context: { platform: 'claude_desktop' }, requested_layers: ['all'], consumer_id: 'phaedo-package-closure' },
  });
  ok(!call.isError, 'packed server answers phaedo_request_injection');
  const payload = call.structuredContent || JSON.parse(call.content[0].text);
  ok(payload.projection.startsWith('<phaedo_user_profile>'), 'packed server returns a real projection block');

  await client.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`test-package-closure: ${pass} checks passed`);
