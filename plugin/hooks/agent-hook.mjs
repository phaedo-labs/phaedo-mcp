#!/usr/bin/env node
// Phaedo — the merge check for agents other than Claude Code.
//
//   node hooks/agent-hook.mjs <cursor|copilot|codex|gemini>
//
// Each agent's pre-action hook sends its own JSON on stdin. This turns it into the shape the
// Claude Code ship hook (pre-ship.mjs) already handles, runs the SAME classification, consult
// and receipt path, and answers in the agent's own format. Same rule as pre-ship: it only ever
// adds friction — it never returns "allow" — and it stays silent for anything that isn't a
// merge, deploy, publish, message, payment, delete or the like.
//
//   agent     hook                                         can it show a prompt?
//   Cursor    ~/.cursor/hooks.json beforeShellExecution,   yes — permission "ask"
//             beforeMCPExecution
//   Copilot   ~/.copilot/hooks/phaedo.json preToolUse      yes — permissionDecision "ask"
//   Codex     ~/.codex/hooks.json PreToolUse               no  — "ask" is unsupported
//   Gemini    ~/.gemini/settings.json BeforeTool           no  — allow / deny only
//
// Where the agent can't prompt, Phaedo pauses the action once with the reason, so the agent
// stops and asks in the chat; the same call again within RETRY_WINDOW_MS goes through (the
// subject has answered) and is not consulted twice. A pause, never a wall — and never a loop.
//
// FAIL-SAFE: any error, and anything past BUDGET_MS, exits 0 with no output. That matters most
// for Copilot, where a hook that crashes DENIES the tool call.

import { join } from 'path';
import { classifyToolCall } from '../ship-actions.js';
import { runShipHook, callHash, readState, writeState, BUDGET_MS } from './pre-ship.mjs';
import { isMainModule } from '../lib/is-main.js';

export const AGENTS = Object.freeze({
  cursor:  { id: 'cursor/ship-hook', canAsk: true },
  copilot: { id: 'copilot-cli/ship-hook', canAsk: true },
  codex:   { id: 'codex/ship-hook', canAsk: false },
  gemini:  { id: 'gemini-cli/ship-hook', canAsk: false },
});
export const RETRY_WINDOW_MS = 15 * 60 * 1000;

const parseMaybe = (v) => {
  if (typeof v !== 'string') return v && typeof v === 'object' ? v : {};
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
};
const shell = (command, cwd) => (typeof command === 'string' && command.trim()
  ? { tool_name: 'Bash', tool_input: { command }, cwd, hook_event_name: 'PreToolUse' } : null);
const mcp = (server, tool, args, cwd) => (server && tool
  ? { tool_name: `mcp__${server}__${tool}`, tool_input: parseMaybe(args), cwd, hook_event_name: 'PreToolUse' } : null);

/** The agent's hook input as the Claude Code PreToolUse shape, or null when it isn't a tool call. PURE. */
export function normalize(agent, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const cwd = r.cwd || (Array.isArray(r.workspace_roots) ? r.workspace_roots[0] : undefined);
  switch (agent) {
    case 'cursor':
      if (typeof r.mcp_server_name === 'string') return mcp(r.mcp_server_name, r.tool_name, r.tool_input, cwd);
      return shell(r.command, cwd);
    case 'copilot': {
      // camelCase `preToolUse` (toolName/toolArgs), or the PascalCase variant (tool_name/tool_input).
      const name = String(r.toolName ?? r.tool_name ?? '');
      const args = parseMaybe(r.toolArgs ?? r.tool_input);
      if (/^(bash|shell|powershell)$/i.test(name)) return shell(args.command, cwd);
      if (name.startsWith('mcp__')) return { tool_name: name, tool_input: args, cwd, hook_event_name: 'PreToolUse' };
      return null;
    }
    case 'codex':
      // Codex's PreToolUse is already Claude-shaped: Bash + tool_input.command, mcp__server__tool.
      if (r.tool_name === 'Bash') return shell(r.tool_input?.command, cwd);
      if (typeof r.tool_name === 'string' && r.tool_name.startsWith('mcp__')) return { tool_name: r.tool_name, tool_input: parseMaybe(r.tool_input), cwd, hook_event_name: 'PreToolUse' };
      return null;
    case 'gemini': {
      const name = String(r.tool_name || '');
      if (name === 'run_shell_command') return shell(r.tool_input?.command, cwd);
      const ctx = r.mcp_context && typeof r.mcp_context === 'object' ? r.mcp_context : {};
      const server = ctx.server_name;
      if (server && name.startsWith(`mcp_${server}_`)) return mcp(server, name.slice(`mcp_${server}_`.length), r.tool_input, cwd);
      const m = /^mcp_([^_]+)_(.+)$/.exec(name);
      return m ? mcp(m[1], m[2], r.tool_input, cwd) : null;
    }
    default: return null;
  }
}

const PAUSE = " This agent can't show a confirmation prompt, so Phaedo paused it: ask the user, and run the same command again only if they say yes.";

/**
 * The ship hook's answer in the agent's own format, or null for no output. PURE.
 * Never "allow": a quiet answer is no output, so the agent's own permission flow applies.
 */
export function render(agent, out) {
  const h = out?.hookSpecificOutput || {};
  const asked = h.permissionDecision === 'ask';
  const reason = h.permissionDecisionReason || '';
  const context = h.additionalContext || '';
  switch (agent) {
    case 'cursor':
      return asked ? { permission: 'ask', user_message: reason, agent_message: context } : null;
    case 'copilot':
      return asked ? { permissionDecision: 'ask', permissionDecisionReason: reason } : null;
    case 'codex':
      if (asked) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason + PAUSE } };
      return context ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } } : null;
    case 'gemini':
      return asked ? { decision: 'deny', reason: reason + PAUSE, systemMessage: reason } : null;
    default: return null;
  }
}

/**
 * One invocation. deps: the pre-ship deps (consult, writeReceipt, statePath, now…) plus
 * `pausePath` for the agents that can't prompt. Returns what to print, or null.
 */
export async function runAgentHook(agent, raw, deps) {
  const spec = AGENTS[agent];
  if (!spec) return null;
  const input = normalize(agent, raw);
  if (!input || !classifyToolCall(input.tool_name, input.tool_input)) return null;
  const now = deps.now ?? Date.now();
  const hash = callHash(input);

  if (!spec.canAsk) {
    const paused = readState(deps.pausePath);
    paused.pending ||= {};
    for (const [k, v] of Object.entries(paused.pending)) if (!(now - Date.parse(v?.at) < RETRY_WINDOW_MS)) delete paused.pending[k];
    const key = `${agent}:${hash}`;
    if (paused.pending[key]) {
      // The retry after a pause: the subject answered in the chat. Let it through, once.
      delete paused.pending[key];
      writeState(deps.pausePath, paused, now);
      return null;
    }
    const out = await runShipHook(input, { ...deps, agentId: spec.id });
    if (out?.hookSpecificOutput?.permissionDecision === 'ask') {
      paused.pending[key] = { at: new Date(now).toISOString() };
      writeState(deps.pausePath, paused, now);
    }
    return render(agent, out);
  }
  return render(agent, await runShipHook(input, { ...deps, agentId: spec.id }));
}

async function main(agent) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; }
  // Cheap exit before importing the vault stack: most tool calls are not ship actions.
  const input = normalize(agent, parsed);
  if (!input || !classifyToolCall(input.tool_name, input.tool_input)) return;
  const { realDeps } = await import('./pre-ship.mjs');
  const { defaultStateDir } = await import('../cache.js');
  const deps = await realDeps({ agentId: AGENTS[agent]?.id });
  const out = await runAgentHook(agent, parsed, { ...deps, pausePath: join(defaultStateDir(), 'agent-hook-paused.json') });
  if (out) process.stdout.write(JSON.stringify(out));
}

if (isMainModule(import.meta.url)) {
  const timeout = new Promise((res) => setTimeout(res, BUDGET_MS));
  Promise.race([main(process.argv[2]).catch(() => {}), timeout])
    .then(() => process.exit(0))
    .catch(() => process.exit(0)); // never break, and never deny by crashing (Copilot fails closed)
}
