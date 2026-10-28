// The packaged installs (build-plugin.mjs): the Claude plugin folder and the Claude Desktop
// bundle, plus the config-dir rule that lets both survive an update (lib/config-dir.js).
//
// Builds the plugin from `npm pack` exactly as the public export does, checks it against the
// directory's published limits, then runs it the way Claude Code does — the MCP server and the
// SessionStart hook from the built folder, with CLAUDE_PLUGIN_ROOT set — in an isolated state
// dir. The .mcpb is not built here (that fetches esbuild and the mcpb CLI); the one brittle
// input to it, the exact npm imports in server.js, is checked instead.
//
//   node mcp/test-plugin.mjs

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildPlugin, marketplaceManifest, mcpbManifest } from './build-plugin.mjs';
import { configDir, LAYOUT_MARKER } from './lib/config-dir.js';
import { SHIP_HOOK_EVENTS } from './install.mjs';

const MCP = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(MCP, 'package.json'), 'utf8'));
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const tmp = mkdtempSync(join(tmpdir(), 'phaedo-plugin-test-'));
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]);

try {
  console.log('\nconfig dir: unchanged for a clone, the state dir for a packaged install');
  {
    ok(configDir(MCP, {}) === MCP, 'a clone keeps its config beside server.js, as before');
    const fake = join(tmp, 'fake-install');
    spawnSync('mkdir', ['-p', fake]);
    writeFileSync(join(fake, LAYOUT_MARKER), JSON.stringify({ config: 'state-dir' }));
    ok(configDir(fake, { PHAEDO_MCP_STATE_DIR: '/state' }) === '/state', 'a packaged install keeps it in the state dir');
    ok(configDir(fake, { PHAEDO_CONFIG_DIR: '/explicit' }) === '/explicit', 'PHAEDO_CONFIG_DIR overrides both');
    const broken = join(tmp, 'broken-install');
    spawnSync('mkdir', ['-p', broken]);
    writeFileSync(join(broken, LAYOUT_MARKER), '{not json');
    ok(configDir(broken, {}) === broken, 'an unreadable marker falls back to the old layout');
  }

  console.log('\nthe plugin folder');
  const out = buildPlugin(join(tmp, 'plugin'));
  const files = walk(out);
  const rel = files.map((f) => relative(out, f));
  {
    const manifest = JSON.parse(readFileSync(join(out, '.claude-plugin', 'plugin.json'), 'utf8'));
    ok(manifest.name === 'phaedo' && /^[a-z0-9-]+$/.test(manifest.name), 'plugin name is "phaedo", lowercase');
    ok(manifest.version === pkg.version, `plugin version follows the package (${pkg.version}), so a release updates users`);
    ok(manifest.description && manifest.author?.name && manifest.license === 'Apache-2.0', 'description, author and license are set');
    ok(existsSync(join(out, manifest.icon)), 'the icon the listing names exists');

    const mcpCfg = JSON.parse(readFileSync(join(out, '.mcp.json'), 'utf8')).mcpServers.phaedo;
    ok(mcpCfg.command === 'node' && mcpCfg.args.length === 1, 'the MCP server starts as `node <file>`, no shell or launcher');
    ok(existsSync(mcpCfg.args[0].replace('${CLAUDE_PLUGIN_ROOT}', out)), 'the MCP server file exists in the plugin');

    const hooks = JSON.parse(readFileSync(join(out, 'hooks', 'hooks.json'), 'utf8')).hooks;
    const events = Object.keys(hooks).sort();
    ok(JSON.stringify(events) === JSON.stringify(['SessionEnd', 'SessionStart', 'Stop', ...SHIP_HOOK_EVENTS].sort()),
      'the plugin wires the same hook events the installer does');
    for (const ev of SHIP_HOOK_EVENTS) ok(hooks[ev][0].matcher === 'Bash', `${ev}: the merge check only looks at Bash commands`);
    for (const h of Object.values(hooks).flat().flatMap((g) => g.hooks)) {
      ok(h.command === 'node' && h.args[0].startsWith('${CLAUDE_PLUGIN_ROOT}/'), `exec-form hook, path from the plugin root: ${h.args[0]}`);
      ok(existsSync(h.args[0].replace('${CLAUDE_PLUGIN_ROOT}', out)), `hook script exists: ${h.args[0]}`);
    }

    for (const skill of ['pair', 'status']) {
      const md = readFileSync(join(out, 'skills', skill, 'SKILL.md'), 'utf8');
      ok(/^---\ndescription: .+\n[\s\S]*?---\n/.test(md), `/phaedo:${skill} has front matter with a description`);
    }

    // The directory's published limits (claude.com/docs/plugins/pre-submission-checklist).
    const words = readFileSync(join(out, 'README.md'), 'utf8').replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean).length;
    ok(words >= 40, `README has at least 40 words (${words})`);
    ok(existsSync(join(out, 'LICENSE')), 'LICENSE is in the plugin folder');
    ok(files.length <= 512, `at most 512 files (${files.length})`);
    const big = files.filter((f) => !/\.(png|jpe?g|gif|webp)$/.test(f) && statSync(f).size > 256 * 1024);
    ok(big.length === 0, `no non-image file over 256 KiB (${big.map((f) => relative(out, f)).join(', ') || 'none'})`);
    ok(!rel.some((r) => /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)$/.test(r)), 'no system files');
    ok(!rel.some((r) => /\.(mcpb|dxt|zip|ico|pdf)$/.test(r)), 'no binary bundles');
    ok(!rel.includes('install.mjs') && !rel.some((r) => r.startsWith('installers/')), 'the settings-editing installer is left out');
    ok(!rel.some((r) => /(^|\/)\.npmrc$/.test(r)), 'no package-manager config that could redirect the install');

    // Claude Code installs dependencies only from a lockfile that matches package.json.
    const lock = JSON.parse(readFileSync(join(out, 'package-lock.json'), 'utf8'));
    ok(lock.lockfileVersion >= 2, 'lockfile is npm 7+ format');
    ok(JSON.stringify(lock.packages[''].dependencies) === JSON.stringify(pkg.dependencies), 'lockfile and package.json list the same dependencies');
    ok(!Object.values(lock.packages).some((p) => p.resolved && !p.resolved.startsWith('https://')), 'every locked package downloads over https');
    ok(JSON.parse(readFileSync(join(out, LAYOUT_MARKER), 'utf8')).config === 'state-dir', 'the plugin keeps its config in the state dir');

    const mkt = marketplaceManifest();
    ok(mkt.name === 'phaedo' && mkt.plugins[0].source === './plugin', 'the marketplace lists ./plugin');
  }

  console.log('\nthe built plugin runs as Claude Code runs it');
  {
    symlinkSync(join(MCP, 'node_modules'), join(out, 'node_modules'), 'dir');   // what Claude Code's install provides
    const stateDir = join(tmp, 'state');
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: out, PHAEDO_MCP_STATE_DIR: stateDir };
    delete env.PHAEDO_PAIRING; delete env.PHAEDO_FINGERPRINT; delete env.PHAEDO_CONFIG_DIR;

    const transport = new StdioClientTransport({ command: process.execPath, args: [join(out, 'server.js')], env, stderr: 'pipe' });
    let log = '';
    transport.stderr.on('data', (d) => { log += d; });
    const client = new Client({ name: 'phaedo-plugin-test', version: '0.0.0' });
    await client.connect(transport);
    ok((await client.listTools()).tools.length === 8, 'the plugin\'s server lists its 8 tools');
    const r = await client.callTool({ name: 'phaedo_request_injection', arguments: {} });
    ok(r.isError && /starts one from your own Claude Code sessions/.test(r.content[0].text),
      'unconfigured, it says no profile yet in the plugin\'s own words');
    ok(!/install the Claude Code hook/.test(r.content[0].text), 'and doesn\'t tell a plugin user to install a hook they already have');
    const t0 = Date.now();
    while (!/no profile yet/.test(log) && Date.now() - t0 < 5000) await new Promise((res) => setTimeout(res, 50));
    ok(/\[phaedo-mcp\] no profile yet/.test(log), 'its startup line uses the plugin wording too');
    await client.close();

    const hook = spawnSync(process.execPath, [join(out, 'hooks', 'session-start.mjs')], {
      input: JSON.stringify({ session_id: 't', hook_event_name: 'SessionStart', source: 'startup', cwd: tmp }), env, encoding: 'utf8',
    });
    ok(hook.status === 0 && hook.stdout === '', 'SessionStart with no profile: exit 0, injects nothing');
    ok(!existsSync(join(out, 'pairing.json')), 'nothing was written into the plugin folder');
  }

  console.log('\nthe Desktop bundle');
  {
    const server = readFileSync(join(MCP, 'server.js'), 'utf8');
    for (const line of [
      "import { z } from 'zod';",
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
    ]) ok(server.includes(line), `server.js still imports exactly: ${line} (the bundle build rewrites it)`);
    const m = mcpbManifest();
    ok(m.version === pkg.version && m.server.entry_point === 'server.js', 'bundle manifest: version and entry point');
    ok(m.server.mcp_config.args[0] === '${__dirname}/server.js', 'bundle runs server.js from its own folder');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n✓ test-plugin: ${pass} checks passed`);
