// Phaedo — wire the merge check (hooks/agent-hook.mjs) into Cursor, Copilot CLI, Codex and
// Gemini CLI. Each keeps its hooks in its own user-level file; Phaedo's entry is recognised by
// the script path, merged in beside whatever is there, and removed on uninstall.
//
//   Cursor   ~/.cursor/hooks.json            beforeShellExecution + beforeMCPExecution
//   Copilot  ~/.copilot/hooks/phaedo.json    preToolUse  (a file of Phaedo's own)
//   Codex    ~/.codex/hooks.json             PreToolUse  (new hooks need trusting in /hooks)
//   Gemini   ~/.gemini/settings.json         hooks.BeforeTool
//
// Antigravity documents no hooks, so it gets the profile (rules-files.js) but no merge check.
// The merge functions are PURE (config in, config out); applyAgentHooks does the file I/O.

import { homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { MCP_HOOK_MATCHER } from './ship-actions.js';

export const AGENT_HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), 'hooks', 'agent-hook.mjs');
export const MARKER = 'hooks/agent-hook.mjs';
export const TIMEOUT_S = 15;              // above the hook's own 12 s budget
const SHIP_MATCHER = `Bash|${MCP_HOOK_MATCHER}`;
// Gemini names MCP tools mcp_<server>_<tool> (one underscore), so the same verbs, one prefix.
const GEMINI_MATCHER = `run_shell_command|${MCP_HOOK_MATCHER.replace(/^mcp__/, 'mcp_')}`;

const norm = (s) => String(s ?? '').replace(/\\/g, '/');
const ours = (cmd) => norm(cmd).includes(MARKER);
export const agentCommand = (agent, { nodePath = process.execPath, hookPath = AGENT_HOOK_PATH } = {}) => `"${nodePath}" "${hookPath}" ${agent}`;

/** Where each agent keeps its hooks, for this home and environment. */
export function hookFiles({ home = homedir(), env = process.env } = {}) {
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex');
  const copilotHome = env.COPILOT_HOME ? resolve(env.COPILOT_HOME) : join(home, '.copilot');
  return {
    cursor:  { label: 'Cursor', dir: join(home, '.cursor'), file: join(home, '.cursor', 'hooks.json') },
    copilot: { label: 'Copilot CLI', dir: copilotHome, file: join(copilotHome, 'hooks', 'phaedo.json'), ownFile: true },
    codex:   { label: 'Codex', dir: codexHome, file: join(codexHome, 'hooks.json'), note: 'In Codex, run /hooks once and trust the Phaedo hook — Codex skips new hooks until you do.' },
    gemini:  { label: 'Gemini CLI', dir: join(home, '.gemini'), file: join(home, '.gemini', 'settings.json') },
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o ?? {}));
const arr = (v) => (Array.isArray(v) ? v : []);

// Cursor and Copilot: { hooks: { event: [ {command…} ] } } — one flat entry per hook.
function mergeFlat(config, events, entry, cmdOf) {
  const c = clone(config);
  c.version ??= 1;
  c.hooks = c.hooks && typeof c.hooks === 'object' ? c.hooks : {};
  for (const ev of events) {
    const rest = arr(c.hooks[ev]).filter((h) => !ours(cmdOf(h)));
    c.hooks[ev] = [...rest, entry];
  }
  return c;
}
function removeFlat(config, events, cmdOf) {
  const c = clone(config);
  if (!c.hooks || typeof c.hooks !== 'object') return c;
  for (const ev of events) {
    if (!Array.isArray(c.hooks[ev])) continue;
    c.hooks[ev] = c.hooks[ev].filter((h) => !ours(cmdOf(h)));
    if (!c.hooks[ev].length) delete c.hooks[ev];
  }
  return c;
}

// Codex and Gemini: { hooks: { Event: [ { matcher, hooks: [ {command…} ] } ] } } — Claude-style groups.
function mergeGrouped(container, event, group) {
  const c = clone(container);
  c.hooks = c.hooks && typeof c.hooks === 'object' ? c.hooks : {};
  const rest = removeGrouped({ hooks: { [event]: arr(c.hooks[event]) } }, event).hooks[event] || [];
  c.hooks[event] = [...rest, group];
  return c;
}
function removeGrouped(container, event) {
  const c = clone(container);
  if (!c.hooks || !Array.isArray(c.hooks[event])) return c;
  c.hooks[event] = c.hooks[event]
    .map((g) => ({ ...g, hooks: arr(g?.hooks).filter((h) => !ours(h?.command)) }))
    .filter((g) => g.hooks.length);
  if (!c.hooks[event].length) delete c.hooks[event];
  return c;
}

const CURSOR_EVENTS = ['beforeShellExecution', 'beforeMCPExecution'];

/** The agent's config with Phaedo's hook in (replacing any older Phaedo entry). PURE. */
export function mergeAgentHook(agent, config, opts = {}) {
  const cmd = agentCommand(agent, opts);
  switch (agent) {
    case 'cursor':
      return mergeFlat(config, CURSOR_EVENTS, { command: cmd, timeout: TIMEOUT_S }, (h) => h?.command);
    case 'copilot':
      return mergeFlat(config, ['preToolUse'], { type: 'command', bash: cmd, powershell: `& ${cmd}`, timeoutSec: TIMEOUT_S }, (h) => h?.bash ?? h?.command ?? h?.powershell);
    case 'codex':
      return mergeGrouped(config, 'PreToolUse', { matcher: SHIP_MATCHER, hooks: [{ type: 'command', command: cmd, timeout: TIMEOUT_S, statusMessage: 'Checking with Phaedo' }] });
    case 'gemini':
      return mergeGrouped(config, 'BeforeTool', { matcher: GEMINI_MATCHER, hooks: [{ type: 'command', command: cmd, timeout: TIMEOUT_S * 1000, name: 'phaedo-merge-check' }] });
    default: throw new Error(`unknown agent: ${agent}`);
  }
}

/** The agent's config with every Phaedo hook entry taken out. PURE. */
export function removeAgentHook(agent, config) {
  switch (agent) {
    case 'cursor': return removeFlat(config, CURSOR_EVENTS, (h) => h?.command);
    case 'copilot': return removeFlat(config, ['preToolUse'], (h) => h?.bash ?? h?.command ?? h?.powershell);
    case 'codex': return removeGrouped(config, 'PreToolUse');
    case 'gemini': return removeGrouped(config, 'BeforeTool');
    default: throw new Error(`unknown agent: ${agent}`);
  }
}

function readJson(path) {
  if (!existsSync(path)) return { config: {}, existed: false };
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return { config: {}, existed: true };
  const config = JSON.parse(raw);   // throws on comments or damage — the caller refuses to touch it
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('not a JSON object');
  return { config, existed: true };
}

/**
 * Install or remove the merge check for every agent found (or `only`). Returns result
 * records in install.mjs's shape: { name, status, detail }.
 */
export function applyAgentHooks({ action, dryRun = false, home = homedir(), env = process.env, only = null, nodePath, hookPath } = {}) {
  const out = [];
  for (const [agent, t] of Object.entries(hookFiles({ home, env }))) {
    if (only && !only.includes(agent)) continue;
    const name = `${t.label} merge check`;
    if (action === 'install' && !existsSync(t.dir)) continue;          // not installed here
    let read;
    try { read = readJson(t.file); } catch (e) {
      out.push({ name, status: 'error', detail: `${t.file} isn't plain JSON (${e.message}); not touched` });
      continue;
    }
    if (action === 'uninstall') {
      if (!read.existed) continue;
      const next = removeAgentHook(agent, read.config);
      if (JSON.stringify(next) === JSON.stringify(read.config)) continue;
      const empty = t.ownFile && !Object.keys(next.hooks || {}).length;
      if (!dryRun) {
        if (empty) rmSync(t.file);
        else { copyFileSync(t.file, `${t.file}.phaedo.bak`); writeFileSync(t.file, JSON.stringify(next, null, 2) + '\n'); }
      }
      out.push({ name, status: dryRun ? 'would-remove' : 'removed', detail: t.file });
      continue;
    }
    const next = mergeAgentHook(agent, read.config, { nodePath, hookPath });
    if (JSON.stringify(next) === JSON.stringify(read.config)) { out.push({ name, status: 'unchanged', detail: 'already configured' }); continue; }
    if (!dryRun) {
      if (read.existed) copyFileSync(t.file, `${t.file}.phaedo.bak`);
      mkdirSync(dirname(t.file), { recursive: true });
      writeFileSync(t.file, JSON.stringify(next, null, 2) + '\n');
    }
    out.push({ name, status: dryRun ? 'would-write' : 'configured', detail: t.file, ...(t.note ? { restartHint: t.note } : {}) });
  }
  return out;
}
