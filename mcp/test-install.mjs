#!/usr/bin/env node
// Self-tests for the one-click installer (install.mjs). Drives the detection +
// merge + apply logic against TEMP dirs only — never reads or writes a real
// client config. Run: node test-install.mjs  (or npm run smoke:install)

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, win32 } from 'path';
import { tmpdir } from 'os';
import {
  detectClients, serverEntry, readConfig, mergeServerEntry, removeServerEntry, applyToClient,
  claudeSettingsPath, hookCommand, mergeSessionStartHook, removeSessionStartHook, applyCodeHook,
  buildConsultEnv, detectConsultModel,
} from './install.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } }
function section(name) { console.log(`\n${name}`); }

const tmp = mkdtempSync(join(tmpdir(), 'phaedo-install-'));
function tmpFile(name, contents) {
  const p = join(tmp, name);
  if (contents !== undefined) writeFileSync(p, contents);
  return p;
}

try {
  // ── detectClients: per-OS config paths ─────────────────────────────────────
  section('detectClients — per-OS paths');
  const mac = detectClients({ platform: 'darwin', home: '/Users/x', env: {} });
  ok(mac.find((c) => c.id === 'claude-desktop').configPath ===
     '/Users/x/Library/Application Support/Claude/claude_desktop_config.json', 'macOS Claude Desktop path');
  ok(mac.find((c) => c.id === 'cursor').configPath === '/Users/x/.cursor/mcp.json', 'macOS Cursor path');

  // detectClients uses node's path.join, which on a non-Windows host emits posix
  // separators — so build the expectation with the same join (the construction
  // logic is what we're asserting, not the host's separator). win32.join shows
  // the real on-Windows result for reference.
  const winAppData = 'C:\\Users\\x\\AppData\\Roaming';
  ok(detectClients({ platform: 'win32', home: 'C:\\Users\\x', env: { APPDATA: winAppData } })
     .find((c) => c.id === 'claude-desktop').configPath === join(winAppData, 'Claude', 'claude_desktop_config.json'),
     'Windows Claude Desktop path under %APPDATA%');
  ok(win32.join(winAppData, 'Claude', 'claude_desktop_config.json') ===
     'C:\\Users\\x\\AppData\\Roaming\\Claude\\claude_desktop_config.json', 'win32 separators (reference)');

  const lin = detectClients({ platform: 'linux', home: '/home/x', env: {} });
  ok(lin.find((c) => c.id === 'claude-desktop').configPath ===
     '/home/x/.config/Claude/claude_desktop_config.json', 'Linux Claude Desktop path (XDG default)');
  ok(detectClients({ platform: 'linux', home: '/home/x', env: { XDG_CONFIG_HOME: '/cfg' } })
     .find((c) => c.id === 'claude-desktop').configPath === '/cfg/Claude/claude_desktop_config.json',
     'Linux honors XDG_CONFIG_HOME');
  ok(mac.find((c) => c.id === 'claude-code').createIfMissing === false, 'Claude Code is not hand-created');

  // ── serverEntry: absolute node binary, no spurious env ─────────────────────
  section('serverEntry');
  const e = serverEntry({ nodePath: '/usr/local/bin/node', serverPath: '/p/server.js' });
  ok(e.command === '/usr/local/bin/node', 'uses absolute node path (GUI PATH gotcha)');
  ok(e.args[0] === '/p/server.js', 'points at server.js');
  ok(!('env' in e), 'no env block when none given (paired flow needs none)');
  ok('env' in serverEntry({ env: { PHAEDO_PAIRING: '/x' } }), 'env block included when provided');

  // ── mergeServerEntry: preserve siblings + other keys ───────────────────────
  section('mergeServerEntry — non-destructive');
  const existing = { mcpServers: { other: { command: 'foo' } }, someSetting: 42 };
  const merged = mergeServerEntry(existing, serverEntry({ nodePath: 'n', serverPath: 's' }));
  ok(merged.changed === true, 'reports changed on first add');
  ok(merged.config.mcpServers.other.command === 'foo', 'preserves a sibling MCP server');
  ok(merged.config.someSetting === 42, 'preserves unrelated top-level keys');
  ok(merged.config.mcpServers.phaedo.command === 'n', 'adds the phaedo entry');
  ok(existing.mcpServers.phaedo === undefined, 'does not mutate the input object');
  // idempotent: same entry again => no change
  ok(mergeServerEntry(merged.config, serverEntry({ nodePath: 'n', serverPath: 's' })).changed === false,
     'idempotent — re-merging identical entry reports no change');

  // ── removeServerEntry ──────────────────────────────────────────────────────
  section('removeServerEntry');
  const removed = removeServerEntry(merged.config);
  ok(removed.changed === true, 'reports changed when entry present');
  ok(removed.config.mcpServers.phaedo === undefined, 'phaedo entry gone');
  ok(removed.config.mcpServers.other.command === 'foo', 'sibling survives removal');
  ok(removeServerEntry({ mcpServers: {} }).changed === false, 'no-op when absent');

  // ── readConfig: malformed JSON must NOT be silently swallowed ──────────────-
  section('readConfig — safety');
  ok(readConfig(join(tmp, 'nope.json')).existed === false, 'missing file → existed:false');
  ok(readConfig(tmpFile('empty.json', '')).existed === true, 'empty file → existed:true, empty config');
  let threw = false;
  try { readConfig(tmpFile('bad.json', '{ not json')); } catch { threw = true; }
  ok(threw, 'malformed JSON throws (so we refuse to overwrite it)');

  // ── applyToClient: real temp files, full install/uninstall round-trip ──────-
  section('applyToClient — install/uninstall on temp files');
  const cfgPath = tmpFile('claude_desktop_config.json', JSON.stringify({ mcpServers: { other: { command: 'foo' } } }));
  const client = { id: 'claude-desktop', name: 'Claude Desktop', configPath: cfgPath, createIfMissing: true, restartHint: '' };
  const entry = serverEntry({ nodePath: 'node', serverPath: '/abs/server.js' });

  const dry = applyToClient(client, { action: 'install', entry, dryRun: true });
  ok(dry.status === 'would-write', 'dry-run reports would-write');
  ok(!JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers.phaedo, 'dry-run wrote nothing');

  const inst = applyToClient(client, { action: 'install', entry });
  ok(inst.status === 'configured', 'install reports configured');
  const after = JSON.parse(readFileSync(cfgPath, 'utf8'));
  ok(after.mcpServers.phaedo.args[0] === '/abs/server.js', 'phaedo entry written');
  ok(after.mcpServers.other.command === 'foo', 'existing server preserved on disk');
  ok(existsSync(cfgPath + '.phaedo.bak'), 'a backup was written before editing');

  ok(applyToClient(client, { action: 'install', entry }).status === 'unchanged', 'second install is unchanged');

  const uninst = applyToClient(client, { action: 'uninstall' });
  ok(uninst.status === 'removed', 'uninstall reports removed');
  ok(JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers.phaedo === undefined, 'entry removed from disk');
  ok(applyToClient(client, { action: 'uninstall' }).status === 'absent', 'second uninstall is a no-op');

  // createIfMissing:false client with no file → absent, nothing created
  const ccPath = join(tmp, 'no-claude.json');
  const cc = { id: 'claude-code', name: 'Claude Code', configPath: ccPath, createIfMissing: false, restartHint: '' };
  ok(applyToClient(cc, { action: 'install', entry }).status === 'absent', 'claude-code absent when file missing');
  ok(!existsSync(ccPath), 'did not hand-create the CLI-owned file');

  // malformed config → error, untouched
  const badPath = tmpFile('bad-cfg.json', '{ broken');
  const badClient = { ...client, configPath: badPath };
  ok(applyToClient(badClient, { action: 'install', entry }).status === 'error', 'malformed config → error');
  ok(readFileSync(badPath, 'utf8') === '{ broken', 'malformed config left untouched');

  // ── Consult model judge env (on by default) ────────────────────────────────
  section('buildConsultEnv');
  const ce = buildConsultEnv({ model: 'llama3.1:8b', url: 'http://localhost:11434' });
  ok(ce.PHAEDO_CONSULT_MODEL === 'llama3.1:8b' && ce.PHAEDO_CONSULT_MODEL_URL === 'http://localhost:11434', 'writes model + url env');
  ok(Object.keys(buildConsultEnv({ disabled: true })).length === 0, 'disabled → empty env');
  ok(buildConsultEnv().PHAEDO_CONSULT_MODEL === 'llama3.1:8b', 'sensible default model');
  // the env flows into the server entry written to client config
  ok('env' in serverEntry({ env: buildConsultEnv() }), 'consult env attaches to the server entry');

  section('detectConsultModel (mocked Ollama)');
  const tags = (models) => async () => ({ ok: true, json: async () => ({ models }) });
  let d = await detectConsultModel({ fetchImpl: tags([{ name: 'llama3.1:8b' }, { name: 'phaedo-comprehensive335' }]) });
  ok(d.reachable && d.model === 'llama3.1:8b' && d.picked, 'picks an installed general model, skips the phaedo fine-tune');
  d = await detectConsultModel({ fetchImpl: tags([{ name: 'phaedo-ext' }]) });
  ok(d.reachable && d.model === 'llama3.1:8b' && !d.picked, 'only phaedo models → falls back to default string');
  d = await detectConsultModel({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  ok(!d.reachable && d.model === 'llama3.1:8b', 'endpoint error → default + reachable:false');
  d = await detectConsultModel({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  ok(!d.reachable && d.model === 'llama3.1:8b', 'Ollama down → graceful default');

  // ── Claude Code SessionStart hook ──────────────────────────────────────────
  section('Claude Code hook — path + command');
  ok(claudeSettingsPath({ home: '/Users/x' }) === '/Users/x/.claude/settings.json', 'settings.json path');
  const cmd = hookCommand({ nodePath: '/usr/bin/node', hookPath: '/p/mcp/hooks/session-start.mjs' });
  ok(cmd === '"/usr/bin/node" "/p/mcp/hooks/session-start.mjs"', 'hook command quotes both paths');

  section('mergeSessionStartHook — non-destructive + idempotent');
  const s0 = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'other' }] }] }, theme: 'dark' };
  const m1 = mergeSessionStartHook(s0, cmd);
  ok(m1.changed === true, 'reports changed on first add');
  ok(m1.settings.hooks.PreToolUse[0].hooks[0].command === 'other', 'preserves other hook events');
  ok(m1.settings.theme === 'dark', 'preserves unrelated settings');
  ok(m1.settings.hooks.SessionStart[0].hooks[0].command === cmd, 'adds the SessionStart entry');
  ok(s0.hooks.SessionStart === undefined, 'does not mutate input');
  ok(mergeSessionStartHook(m1.settings, cmd).changed === false, 'idempotent — same command no change');
  // path refresh: a stale phaedo entry is replaced, not duplicated
  const m2 = mergeSessionStartHook(m1.settings, hookCommand({ nodePath: '/new/node', hookPath: '/p/mcp/hooks/session-start.mjs' }));
  ok(m2.settings.hooks.SessionStart.filter((e) => e.hooks.some((h) => h.command.includes('session-start.mjs'))).length === 1,
     'stale phaedo hook replaced, not duplicated');

  section('removeSessionStartHook');
  const r1 = removeSessionStartHook(m1.settings);
  ok(r1.changed === true, 'removes the phaedo hook');
  ok(r1.settings.hooks.PreToolUse[0].hooks[0].command === 'other', 'sibling hook event survives');
  ok(r1.settings.hooks.SessionStart === undefined, 'empty SessionStart pruned');
  ok(removeSessionStartHook({ theme: 'dark' }).changed === false, 'no-op when no hooks');
  // SessionStart with a non-phaedo entry keeps it
  const keep = removeSessionStartHook({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'theirs' }] }] } });
  ok(keep.changed === false, 'leaves a non-phaedo SessionStart entry alone');

  section('applyCodeHook — temp HOME round-trip');
  // Drive against a temp HOME so ~/.claude/settings.json is the tmp dir's.
  const hookHome = mkdtempSync(join(tmpdir(), 'phaedo-home-'));
  const di = applyCodeHook({ action: 'install', dryRun: true, home: hookHome });
  ok(di.status === 'would-write', 'dry-run reports would-write');
  ok(!existsSync(join(hookHome, '.claude', 'settings.json')), 'dry-run wrote nothing');
  const ci = applyCodeHook({ action: 'install', home: hookHome });
  ok(ci.status === 'configured', 'install configures the hook');
  const written = JSON.parse(readFileSync(join(hookHome, '.claude', 'settings.json'), 'utf8'));
  ok(written.hooks.SessionStart[0].hooks[0].command.includes('session-start.mjs'), 'hook command written');
  ok(applyCodeHook({ action: 'install', home: hookHome }).status === 'unchanged', 'second install unchanged');
  ok(applyCodeHook({ action: 'uninstall', home: hookHome }).status === 'removed', 'uninstall removes it');
  ok(applyCodeHook({ action: 'uninstall', home: hookHome }).status === 'absent', 'second uninstall is no-op');
  rmSync(hookHome, { recursive: true, force: true });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✓' : '✗'} install: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
