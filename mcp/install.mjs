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

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const BASE_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(BASE_DIR, 'server.js');
const HOOK_PATH = join(BASE_DIR, 'hooks', 'session-start.mjs');
const CAPTURE_HOOK_PATH = join(BASE_DIR, 'hooks', 'session-end.mjs');
const ENTRY_KEY = 'phaedo';
const HOOK_MARKER = 'hooks/session-start.mjs';         // identifies our SessionStart entry
const CAPTURE_HOOK_MARKER = 'hooks/session-end.mjs';   // identifies our SessionEnd capture entry
// The same capture, run on Stop (end of each turn) for sessions that stay open for days
// (the desktop app's) — throttled per session inside the hook, so most Stops cost one read.
const STOP_CAPTURE_HOOK_PATH = join(BASE_DIR, 'hooks', 'stop-capture.mjs');
const STOP_CAPTURE_HOOK_MARKER = 'hooks/stop-capture.mjs';
const SHIP_HOOK_PATH = join(BASE_DIR, 'hooks', 'pre-ship.mjs');
const SHIP_HOOK_MARKER = 'hooks/pre-ship.mjs';           // identifies our ship-consult entries
// The ship hook (consult before a merge / deploy / phone build) runs on four Bash events:
// before the command, when a prompt is shown (the evidence a person was asked), and after
// it ran or failed (to record that person's yes). Its own budget is 12s; the timeout is
// the backstop.
export const SHIP_HOOK_EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure'];
const SHIP_HOOK_ENTRY = { matcher: 'Bash', timeout: 15 };

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

// ── Consult model judge config (OFF by default — opt in) ──────────────────────
// Was on by default. Measured 2026-10-18 on the dev Mac against the same cached profile:
// llama3.1:8b answered a $12k IRREVERSIBLE payment `clarify 0.9` on one run and
// `proceed_with_note 0.9` on the next — flipping between runs, toward proceeding, with
// high confidence both times — where the rule engine says `clarify` every time. A judge
// that can talk itself into a payment does not get to be the default. Opt in with
// --model-judge (auto-detect) or --consult-model <id> (pin).
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
// Prefers the default when it is installed, else the first installed CHAT model —
// skipping the phaedo extraction fine-tunes and embedding models. An embedding model
// cannot answer a chat prompt: `nomic-embed-text` was picked on the dev Mac (it sorts
// before llama3.1:8b), every judge call failed in ~15 ms and fell back to the rules,
// and the installer kept printing "model judge ON" for a judge that had never run.
// Falls back to the default string + reachable:false on any failure.
const NOT_A_JUDGE = /phaedo|extract|embed|nomic|bge|minilm|mxbai|arctic|e5-|gte-|rerank/i;
export async function detectConsultModel({ url = DEFAULT_CONSULT_URL, fallback = DEFAULT_CONSULT_MODEL, fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { model: fallback, reachable: false, hadModels: false };
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
    const bare = (n) => String(n).replace(/:latest$/, '');
    const general = names.find((n) => bare(n) === bare(fallback)) || names.find((n) => !NOT_A_JUDGE.test(n));
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

// Match the marker path-separator-agnostically: the marker uses forward slashes
// ('hooks/session-end.mjs') but the command is built with path.join(), which on Windows
// yields backslashes ('...\\hooks\\session-end.mjs'). Without normalizing, Windows never
// recognizes its own hook entries — re-installs duplicate them and uninstall can't remove
// them. Normalize both sides to forward slashes before the substring test.
const norm = (s) => String(s).replace(/\\/g, '/');
const isPhaedoHookEntryFor = (marker) => (e) =>
  e && Array.isArray(e.hooks) &&
  e.hooks.some((h) => typeof h.command === 'string' && norm(h.command).includes(norm(marker)));

// Generic per-event merge/remove — the SessionStart (injection) and SessionEnd
// (capture) entries use the same shape, distinguished by their script-path marker.
// `matcher` / `timeout` (optional) are for tool events: the ship hook filters to Bash.
export function mergeHookEntry(settings, event, command, marker, { matcher, timeout } = {}) {
  const isOurs = isPhaedoHookEntryFor(marker);
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
  const prior = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
  const others = prior.filter((e) => !isOurs(e)); // drop a stale phaedo entry (path refresh)
  const existing = prior.find(isOurs);
  const handler = { type: 'command', command, ...(timeout ? { timeout } : {}) };
  const entry = { ...(matcher ? { matcher } : {}), hooks: [handler] };
  const already = !!existing && existing.matcher === entry.matcher &&
    existing.hooks.some((h) => h.command === command && h.timeout === handler.timeout);
  next.hooks[event] = [...others, entry];
  return { settings: next, changed: !already };
}

export function removeHookEntry(settings, event, marker) {
  const isOurs = isPhaedoHookEntryFor(marker);
  if (!settings.hooks || !Array.isArray(settings.hooks[event])) return { settings, changed: false };
  const prior = settings.hooks[event];
  const others = prior.filter((e) => !isOurs(e));
  if (others.length === prior.length) return { settings, changed: false };
  const hooks = { ...settings.hooks };
  if (others.length) hooks[event] = others; else delete hooks[event];
  const next = { ...settings, hooks };
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, changed: true };
}

// Back-compat wrappers (SessionStart injection hook).
export function mergeSessionStartHook(settings, command) {
  return mergeHookEntry(settings, 'SessionStart', command, HOOK_MARKER);
}
export function removeSessionStartHook(settings) {
  return removeHookEntry(settings, 'SessionStart', HOOK_MARKER);
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
    const start = removeSessionStartHook(read.config);
    const both = removeHookEntry(start.settings, 'SessionEnd', CAPTURE_HOOK_MARKER);
    const stop = removeHookEntry(both.settings, 'Stop', STOP_CAPTURE_HOOK_MARKER);
    let s = stop.settings;
    let shipChanged = false;
    for (const ev of SHIP_HOOK_EVENTS) {
      const r = removeHookEntry(s, ev, SHIP_HOOK_MARKER);
      s = r.settings; shipChanged = shipChanged || r.changed;
    }
    if (!start.changed && !both.changed && !stop.changed && !shipChanged) return { name, status: 'absent', detail: 'no phaedo hook to remove' };
    if (!dryRun) { backup(path); writeConfig(path, s); }
    return { name, status: dryRun ? 'would-remove' : 'removed', detail: path };
  }
  // Always install SessionStart injection. Only install the SessionEnd + Stop CAPTURE hooks
  // when its dependencies actually resolve from THIS install location: the hook loads
  // capture/* and extraction/delta-lift.js via lib/capture-home.js — repo root in a
  // clone, mcp/vendor/ in the published tarball (build-package.mjs vendors the
  // closure). captureHookAvailable() gates the wiring so a broken layout (e.g. a
  // hand-copied hooks/ dir with neither home) degrades to injection-only instead of
  // failing every session end with ERR_MODULE_NOT_FOUND.
  const start = mergeSessionStartHook(read.config, hookCommand());
  let settings = start.settings;
  let captureChanged = false;
  let captureNote = '';
  if (captureHookAvailable()) {
    const both = mergeHookEntry(settings, 'SessionEnd', hookCommand({ hookPath: CAPTURE_HOOK_PATH }), CAPTURE_HOOK_MARKER);
    const stop = mergeHookEntry(both.settings, 'Stop', hookCommand({ hookPath: STOP_CAPTURE_HOOK_PATH }), STOP_CAPTURE_HOOK_MARKER);
    settings = stop.settings; captureChanged = both.changed || stop.changed;
  } else {
    // Never leave a broken capture hook wired if we can't run it here.
    const rm = removeHookEntry(settings, 'SessionEnd', CAPTURE_HOOK_MARKER);
    const rmStop = removeHookEntry(rm.settings, 'Stop', STOP_CAPTURE_HOOK_MARKER);
    settings = rmStop.settings; captureChanged = rm.changed || rmStop.changed;
    captureNote = ' (capture hook skipped — not available in this install; injection only)';
  }
  // Ship hook: consult before a merge / deploy / phone build. Its imports are all inside
  // mcp/, so it runs wherever the server does — no availability gate needed.
  let shipChanged = false;
  for (const ev of SHIP_HOOK_EVENTS) {
    const r = mergeHookEntry(settings, ev, hookCommand({ hookPath: SHIP_HOOK_PATH }), SHIP_HOOK_MARKER, SHIP_HOOK_ENTRY);
    settings = r.settings; shipChanged = shipChanged || r.changed;
  }
  const changed = start.changed || captureChanged || shipChanged;
  if (!changed) return { name, status: 'unchanged', detail: `already configured${captureNote}` };
  if (!dryRun) { if (read.existed) backup(path); writeConfig(path, settings); }
  return { name, status: dryRun ? 'would-write' : 'configured', detail: path + captureNote,
    restartHint: 'Start a new Claude Code session — hooks load when a session starts.' };
}

// The SessionEnd capture hook can only run where its imported modules resolve —
// the repo root (dev clone) or mcp/vendor/ (published tarball), mirroring
// lib/capture-home.js's resolution exactly.
export function captureHookAvailable(hookPath = CAPTURE_HOOK_PATH) {
  const hookDir = dirname(hookPath);
  const homes = [join(hookDir, '..', '..'), join(hookDir, '..', 'vendor')];
  return homes.some((h) => existsSync(join(h, 'capture', 'transcript.js')) &&
                           existsSync(join(h, 'extraction', 'delta-lift.js')));
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

// Default on-disk locations for everything the server persists. The state dir
// (cache.key + cache.enc + receipts.enc) mirrors mcp/cache.js; the pairing/identity
// records sit next to the server.
const STATE_DIR = process.env.PHAEDO_MCP_STATE_DIR || join(homedir(), '.phaedo-mcp');

// Delete all local Phaedo state the server wrote — the "leave nothing behind" half
// of uninstall. Client-config removal only unwires the server; without this the
// derived key material (cache.key), the ciphertext at-rest cache (cache.enc), the
// §10.6 receipts audit store (receipts.enc), and the pairing/identity records all
// persist on disk after "uninstall". Parameterized (stateDir/baseDir) so it's
// node-testable against temp dirs, not the real home.
export function purgeLocalData({ stateDir = STATE_DIR, baseDir = BASE_DIR, dryRun = false } = {}) {
  const targets = [
    stateDir,                          // cache.key + cache.enc + receipts.enc
    join(baseDir, 'pairing.json'),
    join(baseDir, 'identity.json'),
  ];
  const removed = [];
  for (const t of targets) {
    if (!existsSync(t)) continue;
    if (!dryRun) {
      try { rmSync(t, { recursive: true, force: true }); }
      catch (e) { removed.push(`${t} (error: ${e.message})`); continue; }
    }
    removed.push(t);
  }
  return removed;
}

// ── Capture-model config (--capture-model) ────────────────────────────────────
// The durable on-switch for the SessionEnd capture hook's option-(b) model
// detector: <state dir>/capture-model.json, read by capture/model-detect.js
// captureModelOpts (env vars still win as a per-session override). A config
// FILE — not env in the MCP client entries — because the hook is spawned by
// Claude Code / Cowork, not by the MCP server, and Dock-launched apps never
// read shell-profile exports. `off` removes the file. Exported for tests.
export async function applyCaptureModelConfig(model, { url, stateDir = STATE_DIR, dryRun = false, fetchImpl } = {}) {
  const path = join(stateDir, 'capture-model.json');
  if (model === 'off') {
    if (!existsSync(path)) return { status: 'unchanged', detail: 'capture model already off', path };
    if (!dryRun) rmSync(path);
    return { status: dryRun ? 'would-remove' : 'removed', detail: `capture model OFF (${path})`, path };
  }
  if (!model || typeof model !== 'string') {
    return { status: 'error', detail: '--capture-model needs a model name (e.g. llama3.1:8b) or "off"', path };
  }
  if (!dryRun) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ model, ...(url ? { url } : {}) }, null, 2) + '\n', 'utf8');
  }
  // Advisory reachability/presence probe (same endpoint shape as the consult
  // judge's) — config is written regardless; the hook fails safe to regex-only.
  let note = '';
  try {
    const probeUrl = (url || 'http://localhost:11434').replace(/\/$/, '');
    const res = await (fetchImpl || globalThis.fetch)(`${probeUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const names = res.ok ? ((await res.json()).models || []).map((m) => m.name || m.model).filter(Boolean) : [];
    note = names.some((n) => n === model || n.startsWith(`${model}:`))
      ? ' (model found in Ollama)'
      : ` (endpoint reachable but "${model}" not pulled — run: ollama pull ${model})`;
  } catch {
    note = ' (endpoint not reachable — hook stays regex-only until it is)';
  }
  return { status: dryRun ? 'would-write' : 'configured', detail: `capture model → ${model}${url ? ` @ ${url}` : ''}${note}`, path };
}

function parseArgs(argv) {
  const opts = { pair: false, uninstall: false, purge: false, dryRun: false, only: null, codeHook: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pair') opts.pair = true;
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--purge') opts.purge = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--code-hook') opts.codeHook = true;
    else if (a === '--consult-model') opts.consultModel = argv[++i];
    else if (a === '--consult-url') opts.consultUrl = argv[++i];
    else if (a === '--no-model-judge') opts.noModelJudge = true;
    else if (a === '--model-judge') opts.modelJudge = true;
    else if (a === '--capture-model') opts.captureModel = argv[++i];
    else if (a === '--capture-url') opts.captureUrl = argv[++i];
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
  node install.mjs --capture-model <name|off>   turn the capture hook's local
                                   model detector on (e.g. llama3.1:8b) or off.
                                   Writes <state dir>/capture-model.json, which
                                   reaches EVERY launch path (Dock apps never
                                   read shell-profile exports). --capture-url
                                   overrides the endpoint (default Ollama).
  node install.mjs --uninstall     remove the phaedo entry (and hook) everywhere
  node install.mjs --uninstall --purge   ALSO delete all local Phaedo data on disk
                                   (cache, key, receipts, pairing/identity records)
  node install.mjs --dry-run       preview changes, write nothing
  node install.mjs --only <id>     one client only: claude-desktop | cursor | claude-code

  Consult model judge (OFF by default — the rule engine answers; opt in below):
  node install.mjs --model-judge          turn it on, auto-detecting a local Ollama chat model
  node install.mjs --consult-model <id>   turn it on with a pinned model (e.g. llama3.1:8b)
  node install.mjs --consult-url <url>    endpoint (default http://localhost:11434)
  node install.mjs --no-model-judge       rule engine only (the default; kept for scripts)
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

  // Consult model judge: OFF unless asked for (see the measurement above buildConsultEnv).
  // --consult-model pins one; --model-judge probes local Ollama for an installed chat model.
  // Always falls back to the rule engine at runtime, so a missing model never breaks
  // consultation. A plain install REMOVES a judge env an earlier default-on install wrote.
  let env = {}, consultNote = '';
  if (action === 'install' && !opts.noModelJudge && (opts.consultModel || opts.modelJudge)) {
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
    consultNote = 'model judge OFF — the rule engine answers (opt in: --model-judge)';
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
  // Capture-model on-switch (state-dir config file; see applyCaptureModelConfig).
  if (action === 'install' && opts.captureModel !== undefined) {
    const r = await applyCaptureModelConfig(opts.captureModel, { url: opts.captureUrl, dryRun: opts.dryRun });
    results.push({ name: 'capture-model', ...r });
  }
  const touched = [];
  for (const r of results) {
    const mark = { configured: '✓', removed: '✓', 'would-write': '·', 'would-remove': '·',
      unchanged: '=', absent: '–', error: '✗' }[r.status] || '?';
    console.log(`  ${mark} ${r.name.padEnd(16)} ${r.detail}`);
    if (r.status === 'configured' || r.status === 'would-write') touched.push(r);
  }

  if (opts.purge) {
    const removed = purgeLocalData({ dryRun: opts.dryRun });
    console.log(`\n${opts.dryRun ? 'Would delete' : 'Deleted'} local Phaedo data:`);
    if (removed.length) for (const p of removed) console.log(`  ✓ ${p}`);
    else console.log('  (nothing on disk to delete)');
  } else if (action === 'uninstall') {
    console.log(`\nLocal key material, cache, and receipts remain on disk (${STATE_DIR}, plus pairing.json/identity.json).`);
    console.log('Run `node install.mjs --uninstall --purge` to delete those too.');
  }

  if (action === 'install') {
    if (!touched.length) {
      console.log('\nNo clients were updated. Are Claude Desktop / Cursor / Claude Code installed?');
    } else if (!opts.dryRun) {
      console.log('\nNext:');
      console.log('  1. Pair with your phone:  npm run pair   (or re-run with --pair)');
      console.log('  2. Restart any client that was already open:');
      for (const r of touched) if (r.restartHint) console.log(`       • ${r.name}: ${r.restartHint}`);
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
