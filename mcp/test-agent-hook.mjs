// The merge check for Cursor, Copilot CLI, Codex and Gemini CLI (hooks/agent-hook.mjs) and the
// installer that wires it (agent-hooks.js): each agent's input in, the same consult, each agent's
// format out — never "allow" — and the pause-once for agents that can't show a prompt.
//
//   node mcp/test-agent-hook.mjs

import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { normalize, render, runAgentHook, AGENTS, RETRY_WINDOW_MS } from './hooks/agent-hook.mjs';
import { mergeAgentHook, removeAgentHook, applyAgentHooks, agentCommand, hookFiles, MARKER } from './agent-hooks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const NOW = Date.parse('2026-10-27T12:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'phaedo-agent-hook-'));
const MERGE = 'gh pr merge 12 --squash';

console.log('\neach agent\'s input, as the ship hook sees it');
{
  ok(normalize('cursor', { hook_event_name: 'beforeShellExecution', command: MERGE, cwd: '/r' }).tool_input.command === MERGE, 'Cursor shell');
  ok(normalize('cursor', { command: MERGE, workspace_roots: ['/w'] }).cwd === '/w', 'Cursor: cwd from the workspace root');
  const cm = normalize('cursor', { tool_name: 'post_message', tool_input: '{"channel":"#eng","text":"hi"}', mcp_server_name: 'slack' });
  ok(cm.tool_name === 'mcp__slack__post_message' && cm.tool_input.channel === '#eng', 'Cursor MCP: server + tool, input parsed from its JSON string');
  ok(normalize('copilot', { toolName: 'bash', toolArgs: JSON.stringify({ command: MERGE }), cwd: '/r' }).tool_input.command === MERGE, 'Copilot camelCase, toolArgs as a JSON string');
  ok(normalize('copilot', { tool_name: 'bash', tool_input: { command: MERGE } }).tool_name === 'Bash', 'Copilot PascalCase variant');
  ok(normalize('copilot', { toolName: 'edit', toolArgs: '{}' }) === null, 'Copilot: an edit is not a shell command');
  ok(normalize('codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: MERGE } }).tool_input.command === MERGE, 'Codex shell (already Claude-shaped)');
  ok(normalize('codex', { tool_name: 'mcp__gmail__send_email', tool_input: { to: 'a@b.c' } }).tool_name === 'mcp__gmail__send_email', 'Codex MCP');
  ok(normalize('codex', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch' } }) === null, 'Codex: a patch is not reviewed');
  ok(normalize('gemini', { tool_name: 'run_shell_command', tool_input: { command: MERGE } }).tool_name === 'Bash', 'Gemini shell');
  ok(normalize('gemini', { tool_name: 'mcp_my_slack_post_message', tool_input: {}, mcp_context: { server_name: 'my_slack' } }).tool_name === 'mcp__my_slack__post_message', 'Gemini MCP: the server name from mcp_context, underscores and all');
  ok(normalize('gemini', { tool_name: 'mcp_slack_post_message', tool_input: {} }).tool_name === 'mcp__slack__post_message', 'Gemini MCP without context: split at the first underscore');
  ok(normalize('vim', { command: MERGE }) === null && normalize('cursor', null) === null && normalize('cursor', { command: '  ' }) === null, 'unknown agent, garbage, blank → null');
}

console.log('\neach agent\'s format out — never "allow"');
{
  const asked = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: "Phaedo thinks you'd want to OK this yourself: merge PR #12.", additionalContext: 'receipt_id: r1' } };
  const quiet = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'receipt_id: r1' } };
  const c = render('cursor', asked);
  ok(c.permission === 'ask' && c.user_message.includes('merge PR #12') && c.agent_message === 'receipt_id: r1', 'Cursor: ask, with the reason for the user and the receipt for the agent');
  const p = render('copilot', asked);
  ok(p.permissionDecision === 'ask' && p.permissionDecisionReason.includes('merge PR #12'), 'Copilot: ask with the reason');
  const x = render('codex', asked).hookSpecificOutput;
  ok(x.permissionDecision === 'deny' && /ask the user, and run the same command again only if they say yes/.test(x.permissionDecisionReason), 'Codex: no ask, so a pause with the reason');
  const g = render('gemini', asked);
  ok(g.decision === 'deny' && g.reason.includes('merge PR #12') && g.systemMessage.includes('merge PR #12'), 'Gemini: deny with the reason, shown to the user too');
  ok(render('cursor', quiet) === null && render('copilot', quiet) === null && render('gemini', quiet) === null, 'quiet → no output (the agent\'s own permissions apply)');
  ok(render('codex', quiet).hookSpecificOutput.additionalContext === 'receipt_id: r1' && !render('codex', quiet).hookSpecificOutput.permissionDecision, 'Codex quiet: context only, no decision');
  ok(render('cursor', null) === null && render('nope', asked) === null, 'nothing / unknown → null');
  for (const a of Object.keys(AGENTS)) for (const o of [asked, quiet]) ok(!JSON.stringify(render(a, o) ?? {}).includes('"allow"'), `${a}: never allow`);
}

console.log('\nthe whole hook, with a fake consult');
{
  const dir = tmp();
  const mk = (signal) => {
    const seen = { consults: 0, receipts: [] };
    return {
      seen,
      deps: {
        now: NOW, statePath: join(dir, `ship-${signal}.json`), pausePath: join(dir, `pause-${signal}.json`),
        consult: async () => { seen.consults++; return { response: { signal, rationale_hint: 'h' }, drivers: [] }; },
        writeReceipt: async ({ request }) => { seen.receipts.push(request); return `rid-${seen.receipts.length}`; },
      },
    };
  };
  const cursorIn = { command: MERGE, cwd: dir };
  const { seen, deps } = mk('escalate');
  const c = await runAgentHook('cursor', cursorIn, deps);
  ok(c.permission === 'ask' && seen.consults === 1, 'Cursor: an escalate becomes a real prompt');
  ok(seen.receipts[0].agent_id === 'cursor/ship-hook', 'the receipt names the agent');
  ok((await runAgentHook('cursor', cursorIn, deps)).permission === 'ask' && seen.consults === 2, 'Cursor asks every time — it can prompt, so no pause state');
  ok(await runAgentHook('cursor', { command: 'git status' }, deps) === null && seen.consults === 2, 'not a ship action → no consult, no output');

  const k = mk('escalate');
  const codexIn = { tool_name: 'Bash', tool_input: { command: MERGE }, cwd: dir };
  const first = await runAgentHook('codex', codexIn, k.deps);
  ok(first.hookSpecificOutput.permissionDecision === 'deny' && k.seen.consults === 1, 'Codex: paused the first time');
  ok(k.seen.receipts[0].agent_id === 'codex/ship-hook', 'labelled as Codex');
  ok(await runAgentHook('codex', codexIn, k.deps) === null && k.seen.consults === 1, 'the same call again: through, and not consulted twice');
  ok((await runAgentHook('codex', codexIn, k.deps)).hookSpecificOutput.permissionDecision === 'deny' && k.seen.consults === 2, 'the next time it is a new decision: paused again');
  ok(!readFileSync(k.deps.pausePath, 'utf8').includes('merge'), 'the pause file holds a digest, never the command');
  ok(await runAgentHook('codex', { tool_name: 'Bash', tool_input: { command: 'gh pr merge 13 --squash' } }, k.deps) !== null, 'a different command is its own decision');

  const late = mk('escalate');
  await runAgentHook('gemini', { tool_name: 'run_shell_command', tool_input: { command: MERGE } }, late.deps);
  const later = { ...late.deps, now: NOW + RETRY_WINDOW_MS + 1000 };
  ok((await runAgentHook('gemini', { tool_name: 'run_shell_command', tool_input: { command: MERGE } }, later)).decision === 'deny', 'Gemini: a retry after the window is paused again');

  const q = mk('proceed');
  ok(await runAgentHook('gemini', { tool_name: 'run_shell_command', tool_input: { command: MERGE } }, q.deps) === null, 'go ahead → no output');
  ok(!existsSync(q.deps.pausePath) || !Object.keys(JSON.parse(readFileSync(q.deps.pausePath, 'utf8')).pending).length, 'and nothing paused');
  ok((await runAgentHook('copilot', { toolName: 'bash', toolArgs: { command: MERGE } }, mk('decline').deps)).permissionDecision === 'ask', 'Copilot: a decline is a prompt too, never a block');
  ok(await runAgentHook('nope', cursorIn, deps) === null, 'unknown agent → nothing');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nwiring it into each agent');
{
  const o = { nodePath: '/n/node', hookPath: '/p/mcp/hooks/agent-hook.mjs' };
  ok(agentCommand('codex', o) === '"/n/node" "/p/mcp/hooks/agent-hook.mjs" codex', 'command: node + script + agent, quoted');
  const theirs = { version: 1, hooks: { beforeShellExecution: [{ command: './audit.sh' }], afterFileEdit: [{ command: './fmt.sh' }] } };
  const cur = mergeAgentHook('cursor', theirs, o);
  ok(cur.hooks.beforeShellExecution.length === 2 && cur.hooks.beforeShellExecution[0].command === './audit.sh', 'Cursor: added beside the user\'s own hook');
  ok(cur.hooks.beforeMCPExecution[0].command.includes(MARKER) && cur.hooks.afterFileEdit.length === 1, 'and on MCP calls; other events untouched');
  ok(JSON.stringify(mergeAgentHook('cursor', cur, o)) === JSON.stringify(cur), 'Cursor: idempotent');
  const moved = mergeAgentHook('cursor', cur, { ...o, hookPath: '/elsewhere/hooks/agent-hook.mjs' });
  ok(moved.hooks.beforeShellExecution.length === 2 && moved.hooks.beforeShellExecution[1].command.includes('/elsewhere/'), 'an older Phaedo entry is replaced, not doubled');
  ok(JSON.stringify(removeAgentHook('cursor', cur)) === JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: './audit.sh' }], afterFileEdit: [{ command: './fmt.sh' }] } }), 'Cursor: remove leaves exactly the user\'s hooks');
  const win = { hooks: { beforeShellExecution: [{ command: '"C:\\node.exe" "C:\\p\\mcp\\hooks\\agent-hook.mjs" cursor' }] } };
  ok(!removeAgentHook('cursor', win).hooks.beforeShellExecution, 'a Windows path is recognised as ours');

  const cp = mergeAgentHook('copilot', {}, o);
  ok(cp.version === 1 && cp.hooks.preToolUse[0].bash.includes(MARKER) && cp.hooks.preToolUse[0].powershell.startsWith('& ') && cp.hooks.preToolUse[0].timeoutSec === 15, 'Copilot: version 1, bash + PowerShell, 15 s');

  const cx = mergeAgentHook('codex', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }, o);
  ok(cx.hooks.PreToolUse.length === 2 && cx.hooks.PreToolUse[1].matcher.startsWith('Bash|mcp__') && cx.hooks.PreToolUse[1].hooks[0].timeout === 15, 'Codex: its own matcher group beside the user\'s');
  ok(JSON.stringify(removeAgentHook('codex', cx)) === JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }), 'Codex: remove leaves the user\'s group');
  const gm = mergeAgentHook('gemini', { theme: 'dark', hooks: { BeforeTool: [] } }, o);
  ok(gm.theme === 'dark' && gm.hooks.BeforeTool[0].matcher.startsWith('run_shell_command|mcp_.*(') && gm.hooks.BeforeTool[0].hooks[0].timeout === 15000, 'Gemini: settings kept; matcher for shell + MCP; timeout in ms');
  ok(!removeAgentHook('gemini', gm).hooks.BeforeTool && removeAgentHook('gemini', gm).theme === 'dark', 'Gemini: remove leaves the rest of settings');
  ok(hookFiles({ home: '/h', env: { CODEX_HOME: '/c', COPILOT_HOME: '/cp' } }).codex.file === '/c/hooks.json' && hookFiles({ home: '/h', env: { COPILOT_HOME: '/cp' } }).copilot.file === '/cp/hooks/phaedo.json', 'CODEX_HOME and COPILOT_HOME respected');
}

console.log('\ninstalling and removing, on a throwaway home');
{
  const home = tmp();
  for (const d of ['.cursor', '.codex', '.copilot']) mkdirSync(join(home, d));
  writeFileSync(join(home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: './x' }] } }));
  writeFileSync(join(home, '.codex', 'hooks.json'), '{ // a comment\n}');
  const env = {};
  const inst = applyAgentHooks({ action: 'install', home, env, nodePath: 'node' });
  const by = Object.fromEntries(inst.map((r) => [r.name, r]));
  ok(by['Cursor merge check'].status === 'configured' && by['Copilot CLI merge check'].status === 'configured', 'installed where the agent exists');
  ok(!by['Gemini CLI merge check'], 'not where it doesn\'t (no ~/.gemini)');
  ok(by['Codex merge check'].status === 'error' && readFileSync(join(home, '.codex', 'hooks.json'), 'utf8') === '{ // a comment\n}', 'a file it can\'t parse is refused and left alone');
  ok(existsSync(join(home, '.cursor', 'hooks.json.phaedo.bak')), 'the existing file is backed up first');
  ok(JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8')).hooks.stop[0].command === './x', 'the user\'s hook survives');
  ok(applyAgentHooks({ action: 'install', home, env, nodePath: 'node' }).every((r) => r.status !== 'configured'), 'second install: nothing to change');
  writeFileSync(join(home, '.codex', 'hooks.json'), '{}');
  const cx = applyAgentHooks({ action: 'install', home, env, nodePath: 'node', only: ['codex'] });
  ok(cx.length === 1 && /run \/hooks once and trust/.test(cx[0].restartHint), 'Codex: the install says to trust it in /hooks');
  const un = applyAgentHooks({ action: 'uninstall', home, env });
  ok(un.length === 3 && un.every((r) => r.status === 'removed'), 'uninstall removes all three');
  ok(!existsSync(join(home, '.copilot', 'hooks', 'phaedo.json')), 'Copilot: Phaedo\'s own file is deleted');
  ok(JSON.stringify(JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8'))) === JSON.stringify({ version: 1, hooks: { stop: [{ command: './x' }] } }), 'Cursor: back to the user\'s own');
  ok(applyAgentHooks({ action: 'uninstall', home, env }).length === 0, 'second uninstall: nothing to do');
  rmSync(home, { recursive: true, force: true });
}

console.log('\nthe real script, as each agent runs it');
{
  const dir = tmp();
  const env = { ...process.env, PHAEDO_MCP_STATE_DIR: join(dir, 'state'), PHAEDO_FINGERPRINT: join(HERE, 'sample-fingerprint.json'), PHAEDO_SHIP_GH: join(dir, 'no-such-gh') };
  delete env.PHAEDO_CONSULT_MODEL;
  const script = join(HERE, 'hooks', 'agent-hook.mjs');
  const run = (agent, input) => spawnSync(process.execPath, [script, agent], { input: typeof input === 'string' ? input : JSON.stringify(input), env, encoding: 'utf8', timeout: 20000 });
  for (const [agent, input] of [['cursor', { command: 'ls' }], ['copilot', { toolName: 'bash', toolArgs: '{"command":"ls"}' }], ['codex', { tool_name: 'Bash', tool_input: { command: 'ls' } }], ['gemini', { tool_name: 'run_shell_command', tool_input: { command: 'ls' } }]]) {
    const r = run(agent, input);
    ok(r.status === 0 && r.stdout === '', `${agent}: an ordinary command → exit 0, no output`);
  }
  const g = run('copilot', 'not json');
  ok(g.status === 0 && g.stdout === '', 'garbage → exit 0, no output (Copilot would deny on a crash)');
  ok(run('nope', { command: MERGE }).stdout === '', 'unknown agent → no output');
  const { readReceipts } = await import('./receipts.js');
  const m = run('cursor', { command: MERGE, cwd: dir });
  ok(m.status === 0, 'a merge: exit 0');
  const rs = await readReceipts(join(dir, 'state'));
  ok(rs.length === 1 && rs[0].agent_id === 'cursor/ship-hook' && rs[0].request.action_descriptor.summary.startsWith('merge'), 'a real consult, on the receipt as Cursor');
  ok(m.stdout === '' || JSON.parse(m.stdout).permission === 'ask', 'and Cursor\'s format: ask or nothing');
  const rSchema = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'schemas', 'consultation-receipt.schema.json'), 'utf8'));
  ok(Object.keys(rs[0]).every((k) => rSchema.properties[k]) && rSchema.required.every((k) => k in rs[0]), 'the receipt fits the §10.6 schema');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n✓ agent hooks: ${pass} checks passed`);
