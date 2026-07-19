#!/usr/bin/env node
// `phaedo-mcp` one-click installer — wires the Phaedo MCP server into the MCP
// clients you already have (Claude Desktop, Cursor, Claude Code), so injection
// "just works" without hand-editing JSON.
//
// What it does:
//   1. Find each MCP client's config file for this OS.
//   2. Merge a `phaedo` server entry into its `mcpServers` map (never clobbering
//      your other servers or settings — the file is backed up first).
//   3. Point that entry at THIS checkout's server.js, run by THIS node binary
//      (absolute path — a GUI-launched client often has no `node` on PATH).
//   4. Optionally run the one-time pairing (`--pair`) and print next steps.
//
// Pure Node builtins — runs before `npm install`. (Pairing/serving need the deps;
// the platform launchers in installers/ run `npm install` first.)
//
// Usage:
//   node install.mjs                 configure every detected client
//   node install.mjs --pair          configure, then run the pairing flow
//   node install.mjs --uninstall     remove the phaedo entry from every client
//   node install.mjs --dry-run       show what would change, write nothing
//   node install.mjs --only cursor   restrict to one client id
//   node install.mjs --help

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const BASE_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(BASE_DIR, 'server.js');
const HOOK_PATH = join(BASE_DIR, 'hooks', 'session-start.mjs');
const ENTRY_KEY = 'phaedo';
const HOOK_MARKER = 'hooks/session-start.mjs'; // identifies our SessionStart entry

// ── Client registry ──────────────────────────────────────────────────────────
// Every supported client stores MCP servers as a top-level `mcpServers` object,
// so one merge shape covers them all. `configPath` is resolved per-OS from an
// injectable env (so tests can drive every platform without touching real files).
export function detectClients({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const macSupport = join(home, 'Library', 'Application Support');
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config');

  const claudeDesktop = {
    win32: join(appData, 'Claude', 'claude_desktop_config.json'),
    darwin: join(macSupport, 'Claude', 'claude_desktop_config.json'),
    linux: join(xdgConfig, 'Claude', 'claude_desktop_config.json'),
  }[platform];

  const clients = [
    { id: 'claude-desktop', name: 'Claude Desktop', configPath: claudeDesktop, createIfMissing: true,
      restartHint: 'Quit and reopen Claude Desktop.' },
    // Cursor: global MCP config in ~/.cursor/mcp.json.
    { id: 'cursor', name: 'Cursor', configPath: join(home, '.cursor', 'mcp.json'), createIfMissing: true,
      restartHint: 'Restart Cursor (or toggle the MCP server in Settings → MCP).' },
    // Claude Code: the CLI manages ~/.claude.json. We only merge into it when it
    // already exists — never hand-create that large, CLI-owned file.
    { id: 'claude-code', name: 'Claude Code', configPath: join(home, '.claude.json'), createIfMissing: false,
      restartHint: 'Start a new Claude Code session (or run `/mcp` to confirm).' },
  ];
  return clients.filter((c) => Boolean(c.configPath));
}

// The server entry written into a client's mcpServers map. Uses the absolute
// node binary (process.execPath) because GUI-launched clients often lack a PATH
// that resolves bare `node`. `nodePath`/`serverPath`/`env` injectable for tests.
export function serverEntry({ nodePath = process.execPath, serverPath = SERVER_PATH, env } = {}) {
  const entry = { command: nodePath, args: [serverPath] };
  if (env && Object.keys(env).length) entry.env = env;
  return entry;
}

// ── Consult model judge config (on by default) ────────────────────────────────
// The MCP server runs the consult model judge when PHAEDO_CONSULT_MODEL is set;
// it falls back to the local rule engine if the model/Ollama isn't there, so
// defaulting it ON is safe. We write a LOCAL endpoint only (privacy-clean); a
// frontier (off-device) judge is intentionally not wired here.
const DEFAULT_CONSULT_MODEL = 'llama3.1:8b';
const DEFAULT_CONSULT_URL = 'http://localhost:11434';

export function buildConsultEnv({ model = DEFAULT_CONSULT_MODEL, url = DEFAULT_CONSULT_URL, disabled = false } = {}) {
  if (disabled) return {};
  return { PHAEDO_CONSULT_MODEL: model, PHAEDO_CONSULT_MODEL_URL: url };
}

// Probe local Ollama so "on by default" works with whatever model the user has.
// Picks the first installed general-purpose model (skips the phaedo extraction
// fine-tune). Falls back to the default string + reachable:false on any failure.
export async function detectConsultModel({ url = DEFAULT_CONSULT_URL, fallback = DEFAULT_CONSULT_MODEL, fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { model: fallback, reachable: false, hadModels: false };
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
    const general = names.find((n) => !/phaedo|extract/i.test(n));
    return { model: general || fallback, reachable: true, hadModels: names.length > 0, picked: !!general };
  } catch {
    return { model: fallback, reachable: false, hadModels: false };
  }
}

export function readConfig(path) {
  // Returns { config, existed }. Throws on malformed JSON so the caller can
  // refuse to overwrite a file it can't safely parse (never destroy hand-edits).
  if (!existsSync(path)) return { config: {}, existed: false };
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') return { config: {}, existed: true };
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('top-level value is not a JSON object');
    }
    return { config, existed: true };
  } catch (err) {
    throw new Error(`malformed JSON (${err.message})`);
  }
}

// Merge our entry under mcpServers.phaedo, preserving every other server and
// every other top-level key. Returns { config, changed }.
export function mergeServerEntry(config, entry, key = ENTRY_KEY) {
  const next = { ...config, mcpServers: { ...(config.mcpServers || {}) } };
  const before = JSON.stringify(next.mcpServers[key] || null);
  next.mcpServers[key] = entry;
  return { config: next, changed: JSON.stringify(entry) !== before };
}

// Remove our entry. Returns { config, changed }.
export function removeServerEntry(config, key = ENTRY_KEY) {
  if (!config.mcpServers || !(key in config.mcpServers)) return { config, changed: false };
  const servers = { ...config.mcpServers };
  delete servers[key];
  return { config: { ...config, mcpServers: servers }, changed: true };
}

// ── Claude Code SessionStart hook (--code-hook) ───────────────────────────────
// True auto-injection for Claude Code: ~/.claude/settings.json runs our hook
// script at every session start. Merged non-destructively into settings.hooks.
export function claudeSettingsPath({ home = homedir() } = {}) {
  return join(home, '.claude', 'settings.json');
}

export function hookCommand({ nodePath = process.execPath, hookPath = HOOK_PATH } = {}) {
  // Quote both — node path / checkout path may contain spaces; the hook runs in a shell.
  return `"${nodePath}" "${hookPath}"`;
}

const isPhaedoHookEntry = (e) =>
  e && Array.isArray(e.hooks) &&
  e.hooks.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER));

export function mergeSessionStartHook(settings, command) {
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
  const prior = Array.isArray(next.hooks.SessionStart) ? next.hooks.SessionStart : [];
  const others = prior.filter((e) => !isPhaedoHookEntry(e)); // drop a stale phaedo entry (path refresh)
  const existing = prior.find(isPhaedoHookEntry);
  const already = !!existing && existing.hooks.some((h) => h.command === command);
  next.hooks.SessionStart = [...others, { hooks: [{ type: 'command', command }] }];
  return { settings: next, changed: !already };
}

export function removeSessionStartHook(settings) {
  if (!settings.hooks || !Array.isArray(settings.hooks.SessionStart)) return { settings, changed: false };
  const prior = settings.hooks.SessionStart;
  const others = prior.filter((e) => !isPhaedoHookEntry(e));
  if (others.length === prior.length) return { settings, changed: false };
  const hooks = { ...settings.hooks };
  if (others.length) hooks.SessionStart = others; else delete hooks.SessionStart;
  const next = { ...settings, hooks };
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, changed: true };
}

// action: 'install' | 'uninstall'. Returns a result record. settings.json is a
// small, safe-to-create file (unlike the CLI-owned ~/.claude.json).
export function applyCodeHook({ action, dryRun = false, home = homedir() } = {}) {
  const path = claudeSettingsPath({ home });
  const name = 'Claude Code hook';
  let read;
  try {
    read = readConfig(path);
  } catch (err) {
    return { name, status: 'error', detail: `skipped — ${err.message}; not touched` };
  }
  if (action === 'uninstall') {
    if (!read.existed) return { name, status: 'absent', detail: 'no settings.json' };
    const { settings, changed } = removeSessionStartHook(read.config);
    if (!changed) return { name, status: 'absent', detail: 'no phaedo hook to remove' };
    if (!dryRun) { backup(path); writeConfig(path, settings); }
    return { name, status: dryRun ? 'would-remove' : 'removed', detail: path };
  }
  const { settings, changed } = mergeSessionStartHook(read.config, hookCommand());
  if (!changed) return { name, status: 'unchanged', detail: 'already configured' };
  if (!dryRun) { if (read.existed) backup(path); writeConfig(path, settings); }
  return { name, status: dryRun ? 'would-write' : 'configured', detail: path };
}

function backup(path) {
  const bak = `${path}.phaedo.bak`;
  copyFileSync(path, bak);
  return bak;
}

function writeConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// ── Per-client apply ───────────────────────────────────────────────────────-
// action: 'install' | 'uninstall'. Returns a result record for reporting.
export function applyToClient(client, { action, entry, dryRun = false } = {}) {
  const { configPath } = client;
  let read;
  try {
    read = readConfig(configPath);
  } catch (err) {
    return { ...client, status: 'error', detail: `skipped — ${err.message}; not touched` };
  }

  if (action === 'uninstall') {
    if (!read.existed) return { ...client, status: 'absent', detail: 'no config file' };
    const { config, changed } = removeServerEntry(read.config);
    if (!changed) return { ...client, status: 'absent', detail: 'no phaedo entry to remove' };
    if (!dryRun) { backup(configPath); writeConfig(configPath, config); }
    return { ...client, status: dryRun ? 'would-remove' : 'removed', detail: configPath };
  }

  // install
  if (!read.existed && !client.createIfMissing) {
    return { ...client, status: 'absent', detail: 'not installed (config file not found)' };
  }
  const { config, changed } = mergeServerEntry(read.config, entry);
  if (!changed) return { ...client, status: 'unchanged', detail: 'already configured' };
  if (!dryRun) {
    if (read.existed) backup(configPath);
    writeConfig(configPath, config);
  }
  return { ...client, status: dryRun ? 'would-write' : 'configured', detail: configPath };
}

function parseArgs(argv) {
  const opts = { pair: false, uninstall: false, dryRun: false, only: null, codeHook: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pair') opts.pair = true;
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--code-hook') opts.codeHook = true;
    else if (a === '--consult-model') opts.consultModel = argv[++i];
    else if (a === '--consult-url') opts.consultUrl = argv[++i];
    else if (a === '--no-model-judge') opts.noModelJudge = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

const HELP = `Phaedo MCP installer

  node install.mjs                 configure every detected MCP client
  node install.mjs --pair          configure, then run the one-time pairing
  node install.mjs --code-hook     also add the Claude Code SessionStart hook
                                   (true auto-injection; ~/.claude/settings.json)
  node install.mjs --uninstall     remove the phaedo entry (and hook) everywhere
  node install.mjs --dry-run       preview changes, write nothing
  node install.mjs --only <id>     one client only: claude-desktop | cursor | claude-code

  Consult model judge (ON by default, local Ollama, falls back to the rule engine):
  node install.mjs --consult-model <id>   pin the model (e.g. llama3.1:8b)
  node install.mjs --consult-url <url>    endpoint (default http://localhost:11434)
  node install.mjs --no-model-judge       rule engine only (no model env)
`;

function runPairing() {
  if (!existsSync(join(BASE_DIR, 'node_modules'))) {
    console.log('\n⚠  Dependencies not installed — run `npm install` in this folder first,');
    console.log('   then `npm run pair`. (The platform launcher does this for you.)');
    return 1;
  }
  console.log('\n— Pairing with your phone (one time) —\n');
  const r = spawnSync(process.execPath, [join(BASE_DIR, 'pair.js')], { stdio: 'inherit' });
  return r.status ?? 1;
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (err) { console.error(err.message + '\n\n' + HELP); return 2; }
  if (opts.help) { console.log(HELP); return 0; }

  let clients = detectClients();
  if (opts.only) {
    clients = clients.filter((c) => c.id === opts.only);
    if (!clients.length) { console.error(`No such client id: ${opts.only}`); return 2; }
  }

  const action = opts.uninstall ? 'uninstall' : 'install';

  // Consult model judge: ON by default. Pin it if --consult-model is given,
  // otherwise probe local Ollama and pick an installed general model. Off with
  // --no-model-judge. Always falls back to the rule engine at runtime, so a
  // missing model never breaks consultation.
  let env = {}, consultNote = '';
  if (action === 'install' && !opts.noModelJudge) {
    const url = opts.consultUrl || DEFAULT_CONSULT_URL;
    if (opts.consultModel) {
      env = buildConsultEnv({ model: opts.consultModel, url });
      consultNote = `model judge ON → ${opts.consultModel} @ ${url} (pinned)`;
    } else {
      const d = await detectConsultModel({ url });
      env = buildConsultEnv({ model: d.model, url });
      consultNote = d.reachable
        ? `model judge ON → ${d.model} @ ${url} (${d.picked ? 'detected in Ollama' : 'default; `ollama pull ' + d.model + '`'})`
        : `model judge ON → ${d.model} @ ${url} (Ollama not detected — falls back to the rule engine until it's running)`;
    }
  } else if (action === 'install') {
    consultNote = 'model judge OFF (rule engine only)';
  }
  const entry = serverEntry({ env });
  console.log(`Phaedo MCP — ${action}${opts.dryRun ? ' (dry run)' : ''}`);
  console.log(`Server: ${SERVER_PATH}`);
  console.log(`Node:   ${process.execPath}`);
  if (consultNote) console.log(`Consult: ${consultNote}`);
  console.log('');

  const results = clients.map((c) => applyToClient(c, { action, entry, dryRun: opts.dryRun }));
  // The Claude Code SessionStart hook: opt-in on install (--code-hook), always
  // cleaned up on uninstall.
  if (opts.codeHook || action === 'uninstall') {
    results.push(applyCodeHook({ action, dryRun: opts.dryRun }));
  }
  const touched = [];
  for (const r of results) {
    const mark = { configured: '✓', removed: '✓', 'would-write': '·', 'would-remove': '·',
      unchanged: '=', absent: '–', error: '✗' }[r.status] || '?';
    console.log(`  ${mark} ${r.name.padEnd(16)} ${r.detail}`);
    if (r.status === 'configured' || r.status === 'would-write') touched.push(r);
  }

  if (action === 'install') {
    if (!touched.length) {
      console.log('\nNo clients were updated. Are Claude Desktop / Cursor / Claude Code installed?');
    } else if (!opts.dryRun) {
      console.log('\nNext:');
      console.log('  1. Pair with your phone:  npm run pair   (or re-run with --pair)');
      console.log('  2. Restart any client that was already open:');
      for (const r of touched) console.log(`       • ${r.name}: ${r.restartHint}`);
      console.log('  3. Inject your fingerprint at session start:');
      console.log('       • any client: run the `/phaedo` prompt (one click), or call');
      console.log('         the `phaedo_request_injection` tool.');
      if (opts.codeHook) {
        console.log('       • Claude Code: AUTOMATIC — the SessionStart hook injects it for you.');
      } else {
        console.log('       • Claude Code: `--code-hook` makes it automatic at every session start.');
      }
      console.log('  4. Let Phaedo learn how you delegate — set `phaedo_record_outcome`');
      console.log('     to "Always allow" in your client\'s tool-permission settings.');
      console.log('     It records when you override an agent (the act-as-me signal); on');
      console.log('     "Ask" it prompts every time, so the learning stays cold if skipped.');
      console.log('     It only writes a local, encrypted audit receipt — nothing leaves the');
      console.log('     device, and an authored rule still needs your explicit endorsement.');
    }
    if (opts.pair && !opts.dryRun && touched.length) return runPairing();
  }
  return 0;
}

// Only run when invoked directly (so test-install.mjs can import the helpers).
if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
