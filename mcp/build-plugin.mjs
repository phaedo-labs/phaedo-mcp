#!/usr/bin/env node
// Builds the two packaged installs from the npm package, so all three ship the same code:
//
//   node build-plugin.mjs plugin <outDir>     a Claude plugin folder (Claude Code + Cowork)
//   node build-plugin.mjs mcpb <outFile>      a Claude Desktop bundle (.mcpb), one double-click
//
// Both start from `npm pack` — the exact files the npm package ships, vendored capture
// modules included — so the package-closure test that boots the tarball covers them too.
//
// PLUGIN. The pack contents, plus the plugin's own files from plugin-src/ (manifest, hooks,
// MCP config, skills, README), the lockfile (Claude Code installs the server's two
// dependencies from it when it caches the plugin, with scripts disabled), the icon and
// LICENSE. The installer and its launchers are left out: they edit client settings files,
// which a plugin has no business doing — the plugin system wires the hooks itself.
//
// MCPB. The pack contents, with the server's npm dependencies bundled into one file
// (lib/npm-deps.mjs, built by esbuild) so the bundle needs no install step and stays small,
// plus a manifest.json. Claude Desktop brings its own Node.
//
// Both write `install-layout.json`, which moves the subject's config (pairing, identity,
// policies) out of the package folder — replaced on every update — into ~/.phaedo-mcp.
// See lib/config-dir.js.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT_MARKER } from './lib/config-dir.js';

const MCP = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(MCP, '..');
const pkg = JSON.parse(readFileSync(join(MCP, 'package.json'), 'utf8'));

// Exact versions, so a build is reproducible and never pulls a fresh release.
const ESBUILD = 'esbuild@0.28.2';
const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';

// Not shipped in a packaged install (see header). Paths relative to the package root.
const LEAVE_OUT = ['install.mjs', 'installers', 'build-package.mjs', 'build-plugin.mjs'];

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// `npm pack` into a temp dir and return the extracted package/ folder.
function packContents() {
  const tmp = mkdtempSync(join(tmpdir(), 'phaedo-pack-'));
  const out = execFileSync(npm, ['pack', '--json', '--pack-destination', tmp], { cwd: MCP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  // The prepack script (build-package.mjs) prints a line before npm's JSON on the same stdout.
  const tarball = join(tmp, JSON.parse(out.slice(out.indexOf('\n['))).at(0).filename);
  execFileSync('tar', ['-xzf', tarball, '-C', tmp]);
  const dir = join(tmp, 'package');
  for (const p of LEAVE_OUT) rmSync(join(dir, p), { recursive: true, force: true });
  writeFileSync(join(dir, LAYOUT_MARKER), JSON.stringify({ config: 'state-dir' }, null, 2) + '\n');
  return { dir, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

function clean(dir) {
  // The directory rejects macOS / Windows system files in a plugin folder.
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (['.DS_Store', 'Thumbs.db', 'desktop.ini', '__MACOSX'].includes(e.name)) rmSync(p, { recursive: true, force: true });
    else if (e.isDirectory()) clean(p);
  }
}

export function buildPlugin(outDir) {
  const { dir, cleanup } = packContents();
  try {
    rmSync(outDir, { recursive: true, force: true });
    cpSync(dir, outDir, { recursive: true });
    cpSync(join(MCP, 'plugin-src'), outDir, { recursive: true });       // hooks.json, .mcp.json, skills, README
    cpSync(join(MCP, 'package-lock.json'), join(outDir, 'package-lock.json'));
    cpSync(join(MCP, 'LICENSE'), join(outDir, 'LICENSE'));
    cpSync(join(ROOT, 'icons', 'phaedo_icon128.png'), join(outDir, 'icon.png'));
    mkdirSync(join(outDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify(pluginManifest(), null, 2) + '\n');
    clean(outDir);
  } finally { cleanup(); }
  return outDir;
}

export function pluginManifest() {
  return {
    name: 'phaedo',
    displayName: 'Phaedo',
    version: pkg.version,
    description:
      'Claude answers your way and checks with you before acting: loads your Phaedo profile at session start, ' +
      'asks before merges and deploys, sends decisions to your phone, and learns from your sessions.',
    author: { name: 'Phaedo Labs', email: 'hello@phaedo.so', url: 'https://phaedo.so' },
    homepage: 'https://phaedo.so',
    repository: 'https://github.com/phaedo-labs/phaedo-mcp',
    license: 'Apache-2.0',
    keywords: ['personalization', 'preferences', 'approvals', 'human-in-the-loop', 'guardrails', 'mcp'],
    icon: './icon.png',
    documentationUrl: 'https://github.com/phaedo-labs/phaedo-mcp/tree/main/plugin#readme',
    supportUrl: 'https://github.com/phaedo-labs/phaedo-mcp/issues',
  };
}

// The marketplace file for the public repo's root, so `/plugin marketplace add
// phaedo-labs/phaedo-mcp` finds the plugin in ./plugin.
export function marketplaceManifest() {
  return {
    name: 'phaedo',
    owner: { name: 'Phaedo Labs', email: 'hello@phaedo.so', url: 'https://phaedo.so' },
    description: 'Phaedo: Claude answers your way and checks with you before acting.',
    plugins: [{ name: 'phaedo', source: './plugin', category: 'productivity' }],
  };
}

export function mcpbManifest() {
  return {
    manifest_version: '0.3',
    name: 'phaedo',
    display_name: 'Phaedo',
    version: pkg.version,
    description: 'Claude answers your way and checks with you before acting.',
    long_description:
      'Loads your Phaedo profile so Claude answers in your style, and lets Claude check with you before a ' +
      'consequential action, with approvals on your phone when the Phaedo app is paired. Your profile stays on ' +
      'your devices; without a paired phone, Phaedo sends nothing.',
    author: { name: 'Phaedo Labs', email: 'hello@phaedo.so', url: 'https://phaedo.so' },
    homepage: 'https://phaedo.so',
    repository: { type: 'git', url: 'https://github.com/phaedo-labs/phaedo-mcp' },
    support: 'https://github.com/phaedo-labs/phaedo-mcp/issues',
    license: 'Apache-2.0',
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: 'server.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server.js'] },
    },
    tools: [
      { name: 'phaedo_request_injection', description: 'Your profile, to load at the start of a chat.' },
      { name: 'phaedo_consult', description: 'Would you want this action done? Asked before acting.' },
      { name: 'phaedo_check_authorization', description: 'Does one of your standing rules already decide this?' },
      { name: 'phaedo_record_outcome', description: 'Records what you decided about an action.' },
      { name: 'phaedo_escalate', description: 'Sends a decision to your phone to approve or deny.' },
      { name: 'phaedo_escalation_status', description: 'Checks whether you answered on your phone.' },
      { name: 'phaedo_sign_mandate', description: 'Asks you to sign a spending approval with Face ID.' },
      { name: 'phaedo_sign_status', description: 'Checks whether you signed it.' },
    ],
    prompts: [{ name: 'phaedo', description: 'Load my Phaedo profile', text: 'Load my Phaedo profile.' }],
    keywords: ['personalization', 'preferences', 'approvals'],
    compatibility: { platforms: ['darwin', 'win32'], runtimes: { node: '>=18.0.0' } },
  };
}

// server.js imports three things from npm. In the bundle they come from one esbuild-built file
// instead, so the bundle carries ~no node_modules. The rewrite is exact or it fails the build.
const NPM_IMPORTS = [
  "import { z } from 'zod';",
  "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
  "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
];

export function buildMcpb(outFile) {
  const { dir, cleanup } = packContents();
  try {
    // The entry has to sit where `zod` and the SDK resolve — beside mcp/node_modules.
    const entry = join(MCP, `.npm-deps-entry-${process.pid}.mjs`);
    writeFileSync(entry, NPM_IMPORTS.map((l) => l.replace(/^import/, 'export')).join('\n') + '\n');
    try {
      execFileSync(npx, ['-y', ESBUILD, entry, '--bundle', '--platform=node', '--format=esm', '--target=node18',
        `--outfile=${join(dir, 'lib', 'npm-deps.mjs')}`, '--log-level=warning'],
        { cwd: MCP, stdio: ['ignore', 'inherit', 'inherit'] });
    } finally { rmSync(entry, { force: true }); }
    const serverPath = join(dir, 'server.js');
    let server = readFileSync(serverPath, 'utf8');
    for (const [i, line] of NPM_IMPORTS.entries()) {
      if (!server.includes(line)) throw new Error(`build-plugin: server.js no longer contains: ${line}`);
      server = server.replace(line, i === 0 ? "import { z, McpServer, StdioServerTransport } from './lib/npm-deps.mjs';" : '');
    }
    writeFileSync(serverPath, server);
    cpSync(join(ROOT, 'icons', 'phaedo_icon512.png'), join(dir, 'icon.png'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(mcpbManifest(), null, 2) + '\n');
    clean(dir);
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    execFileSync(npx, ['-y', MCPB_CLI, 'pack', dir, resolve(outFile)], { cwd: MCP, stdio: ['ignore', 'pipe', 'inherit'] });
  } finally { cleanup(); }
  return outFile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [kind, out] = process.argv.slice(2);
  if (kind === 'plugin' && out) console.log(`✓ plugin → ${buildPlugin(resolve(out))}`);
  else if (kind === 'mcpb' && out) console.log(`✓ mcpb → ${buildMcpb(out)}`);
  else { console.error('usage: node build-plugin.mjs plugin <outDir> | mcpb <outFile>'); process.exit(2); }
}
