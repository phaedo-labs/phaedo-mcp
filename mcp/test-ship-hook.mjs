#!/usr/bin/env node
// Ship hook (hooks/pre-ship.mjs): consult before a merge / deploy / phone build, and record
// the subject's yes — only on evidence a prompt was shown (PermissionRequest). Two halves:
// the decision flow with injected deps (every branch, pinned clock), then the real script
// as a subprocess against a temp receipt store and the sample fingerprint — the path Claude
// Code actually runs.
// Run: node test-ship-hook.mjs   (from mcp/)

import assert from 'assert';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  runShipHook, readState, writeState, promptReason, commandHash, callHash, personalWhy, callResults,
  ASKING_SIGNALS, STALE_PROFILE_DAYS, AGENT_ID,
  ciStateFromRollup, lookupCiState, CI_RAISES,
  lookupPrFacts, diffStakes, isSensitivePath, parseSensitiveList, stakesValue, raiseWords,
  LARGE_LINES, LARGE_FILES, SENSITIVE_FILE,
} from './hooks/pre-ship.mjs';
import { SIGNALS } from './consult-core.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-10-18T20:00:00Z');
const DAY = 24 * 3600e3;

const dir = mkdtempSync(join(tmpdir(), 'phaedo-ship-'));
try {
  // ── Fake deps: a consult that answers `signal`, a receipt log, an outcome log ────────
  let seq = 0;
  const mk = (signal, { receiptId = 'rcpt-1', source = { live: true }, now = NOW, statePath } = {}) => {
    const log = { consults: [], receipts: [], marks: [] };
    return {
      log,
      deps: {
        now,
        statePath: statePath || join(dir, `s-${++seq}.json`),
        mcpDir: '/x/mcp',
        async consult(req) { log.consults.push(req); return { response: { signal, confidence: 0.44, rationale_hint: 'hint text' }, drivers: [], source }; },
        async writeReceipt(r) { log.receipts.push(r); return receiptId; },
        async markOutcome(id, a, o) { log.marks.push(o ? [id, a, o] : [id, a]); },
      },
    };
  };
  const CMD = 'fly deploy';
  const ev = (name, extra = {}) => ({ hook_event_name: name, tool_name: 'Bash', tool_use_id: 'tu-1', permission_mode: 'default', tool_input: { command: CMD }, ...extra });
  const pre = (command = CMD, extra = {}) => ev('PreToolUse', { tool_input: { command }, ...extra });
  // PermissionRequest carries no tool_use_id (documented) — match is by command.
  const perm = (command = CMD, extra = {}) => { const e = ev('PermissionRequest', { tool_input: { command }, ...extra }); delete e.tool_use_id; return e; };
  const post = (extra = {}) => ev('PostToolUse', extra);

  // ── Not a ship action → no consult, no receipt, no output ───────────────────────────
  {
    const { deps, log } = mk('proceed');
    ok(await runShipHook(pre('git status'), deps) === null, 'non-ship Bash → no output');
    ok(await runShipHook({ ...pre(), tool_name: 'Edit' }, deps) === null, 'non-Bash tool → no output');
    ok(await runShipHook(null, deps) === null, 'no input → no output');
    ok(log.consults.length === 0 && log.receipts.length === 0, 'nothing consulted or written');
    ok(!existsSync(deps.statePath), 'no state written for a non-ship command');
  }

  // ── Permissive, unprompted: receipt, no decision, nothing recorded ──────────────────
  {
    const { deps, log } = mk('proceed_with_note');
    const out = await runShipHook(pre('gh pr merge 372 --squash'), deps);
    const h = out.hookSpecificOutput;
    ok(h.hookEventName === 'PreToolUse', 'PreToolUse output');
    ok(!('permissionDecision' in h), 'permissive → no permission decision (Claude Code flow unchanged)');
    ok(h.additionalContext.includes('receipt_id: rcpt-1'), 'agent gets the receipt id');
    ok(/silence is not approval/.test(h.additionalContext), 'agent told silence is not approval');
    ok(log.consults[0].action_descriptor.domain === 'engineering' && log.consults[0].action_binding.tool_name === 'Bash', 'consult is bound + engineering');
    ok(log.consults[0].agent_id === AGENT_ID && AGENT_ID === 'claude-code/ship-hook', 'agent id labels the caller');
    const e = readState(deps.statePath).pending['tu-1'];
    ok(e && e.asked === false && e.prompt_shown === false, 'pending entry for every ship consult');
    ok(e.cmd_hash === commandHash('gh pr merge 372 --squash') && !JSON.stringify(readState(deps.statePath)).includes('merge'),
      'state holds a digest, never the command');
    ok(await runShipHook(post(), deps) === null && log.marks.length === 0, 'unprompted run → nothing recorded, no output');
    ok(readState(deps.statePath).pending['tu-1'] === undefined, 'entry consumed');
  }

  // ── Permissive BUT prompted (no allow rule): the yes is recorded — scoreable ────────
  {
    const { deps, log } = mk('proceed');
    await runShipHook(pre(), deps);
    ok(await runShipHook(perm(), deps) === null, 'PermissionRequest → no output (never decides)');
    await runShipHook(post(), deps);
    ok(log.marks.length === 1 && log.marks[0][1] === 'approved', 'prompted + ran after a proceed → approved');
  }

  // ── Cautious: ask; prompted → approved; unprompted → agent told, nothing recorded ───
  {
    const { deps, log } = mk('escalate');
    const h = (await runShipHook(pre(), deps)).hookSpecificOutput;
    ok(h.permissionDecision === 'ask', 'escalate → ask');
    ok(h.permissionDecisionReason === promptReason('escalate', 'deploy to Fly'), 'prompt names the action in plain words');
    ok(!/\d\.\d|signal|subject|escalat/i.test(h.permissionDecisionReason), 'prompt has no numbers or protocol terms');
    ok(/A yes on the prompt is recorded automatically/.test(h.additionalContext), 'agent told the yes records itself');
    await runShipHook(perm(), deps);
    ok(readState(deps.statePath).pending['tu-1'].prompt_shown === true, 'PermissionRequest marks the prompt shown');
    await runShipHook(post(), deps);
    ok(log.marks.length === 1 && log.marks[0][0] === 'rcpt-1' && log.marks[0][1] === 'approved', 'prompted + ran → approved');
    await runShipHook(post(), deps);
    ok(log.marks.length === 1, 'a second PostToolUse records nothing');
  }
  for (const mode of ['bypassPermissions', 'default', 'acceptEdits']) {
    const { deps, log } = mk('escalate');
    await runShipHook(pre(CMD, { permission_mode: mode }), deps);
    const out = await runShipHook(post({ permission_mode: mode }), deps);   // no PermissionRequest
    ok(log.marks.length === 0, `${mode}: no prompt seen → nothing recorded`);
    const c = out?.hookSpecificOutput?.additionalContext || '';
    ok(out.hookSpecificOutput.hookEventName === 'PostToolUse' && /No confirmation prompt was shown/.test(c) && c.includes('rcpt-1'),
      `${mode}: agent told no prompt was shown, with the receipt id`);
    ok(/Silence\s+is not approval/.test(c), `${mode}: silence is not approval`);
  }
  {
    // A prompt in bypass mode, if Claude Code shows one, is still a person's yes.
    const { deps, log } = mk('escalate');
    await runShipHook(pre(CMD, { permission_mode: 'bypassPermissions' }), deps);
    await runShipHook(perm(CMD, { permission_mode: 'bypassPermissions' }), deps);
    await runShipHook(post({ permission_mode: 'bypassPermissions' }), deps);
    ok(log.marks[0]?.[1] === 'approved', 'bypass + prompt actually shown → approved');
  }
  {
    // dontAsk never shows a person a prompt.
    const { deps, log } = mk('escalate');
    await runShipHook(pre(CMD, { permission_mode: 'dontAsk' }), deps);
    await runShipHook(perm(CMD, { permission_mode: 'dontAsk' }), deps);
    await runShipHook(post({ permission_mode: 'dontAsk' }), deps);
    ok(log.marks.length === 0, 'dontAsk: a PermissionRequest decided without a person is not a yes');
  }
  {
    // Auto mode: the classifier decides without a person — unless Phaedo's `ask` forced a real
    // prompt ("a hook's ask also forces a permission prompt in auto mode", hooks reference).
    const asked = mk('escalate');
    await runShipHook(pre(CMD, { permission_mode: 'auto' }), asked.deps);
    await runShipHook(perm(CMD, { permission_mode: 'auto' }), asked.deps);
    await runShipHook(post({ permission_mode: 'auto' }), asked.deps);
    ok(asked.log.marks[0]?.[1] === 'approved', 'auto + Phaedo forced the prompt + it ran → the subject said yes → approved');
    const quiet = mk('proceed');
    await runShipHook(pre(CMD, { permission_mode: 'auto' }), quiet.deps);
    await runShipHook(perm(CMD, { permission_mode: 'auto' }), quiet.deps);
    await runShipHook(post({ permission_mode: 'auto' }), quiet.deps);
    ok(quiet.log.marks.length === 0, 'auto + Phaedo did not ask → a PermissionRequest is the classifier\'s, not a yes');
  }
  {
    const { deps } = mk('decline');
    ok(/say no/.test((await runShipHook(pre(), deps)).hookSpecificOutput.permissionDecisionReason), 'decline wording');
    const c = mk('clarify');
    ok(/isn't sure/.test((await runShipHook(pre(), c.deps)).hookSpecificOutput.permissionDecisionReason), 'clarify wording');
  }

  // ── PermissionRequest matching: by command, newest first, one prompt per consult ────
  {
    const { deps, log } = mk('escalate');
    await runShipHook(pre('fly deploy -a one', { tool_use_id: 'a' }), { ...deps, now: NOW - 1000 });
    await runShipHook(pre('fly deploy -a two', { tool_use_id: 'b' }), deps);
    await runShipHook(perm('fly deploy -a two'), deps);
    const st = readState(deps.statePath).pending;
    ok(st.b.prompt_shown === true && st.a.prompt_shown === false, 'prompt attributed to the matching command only');
    ok(await runShipHook(perm('gh pr merge 1'), deps) === null && !readState(deps.statePath).pending.a.prompt_shown, 'unmatched command → nothing marked');
    await runShipHook(post({ tool_use_id: 'a' }), deps);
    ok(log.marks.length === 0, 'the unprompted sibling records nothing');
    // Same command twice: the prompt goes to the newest unprompted consult.
    const s = mk('escalate');
    await runShipHook(pre(CMD, { tool_use_id: 'old' }), { ...s.deps, now: NOW - 5000 });
    await runShipHook(pre(CMD, { tool_use_id: 'new' }), s.deps);
    await runShipHook(perm(), s.deps);
    const p2 = readState(s.deps.statePath).pending;
    ok(p2.new.prompt_shown && !p2.old.prompt_shown, 'same command: newest consult gets the prompt');
  }

  // ── A failed command is still an approved decision; an interrupted one is not ───────
  {
    const a = mk('escalate');
    await runShipHook(pre(), a.deps); await runShipHook(perm(), a.deps);
    await runShipHook(post({ hook_event_name: 'PostToolUseFailure', is_interrupt: false }), a.deps);
    ok(a.log.marks[0]?.[1] === 'approved', 'failure after a yes → approved');
    const b = mk('escalate');
    await runShipHook(pre(), b.deps); await runShipHook(perm(), b.deps);
    await runShipHook(post({ hook_event_name: 'PostToolUseFailure', is_interrupt: true }), b.deps);
    ok(b.log.marks.length === 0, 'interrupted → nothing recorded');
    ok(readState(b.deps.statePath).pending['tu-1'] === undefined, 'interrupted entry still consumed');
    const c = mk('escalate');
    await runShipHook(pre(), c.deps);
    const out = await runShipHook(post({ hook_event_name: 'PostToolUseFailure', is_interrupt: false }), c.deps);
    ok(out?.hookSpecificOutput?.hookEventName === 'PostToolUseFailure', 'unprompted failure → context on the failure event');
  }

  // ── An abstain interrupts nobody; a missing receipt keeps the hook out of the way ───
  {
    const { deps } = mk('insufficient_signal');
    const out = await runShipHook(pre(), deps);
    ok(!('permissionDecision' in out.hookSpecificOutput), 'insufficient_signal → no prompt');
    const n = mk('escalate', { receiptId: null });
    ok(await runShipHook(pre(), n.deps) === null, 'receipt write failed → no output at all');
    ok(!existsSync(n.deps.statePath), 'receipt write failed → nothing pending');
  }

  // ── THE RULE: the hook never returns `allow`, for any signal Phaedo can produce ──────
  for (const sig of [...SIGNALS, 'autoproceed', 'bias_bold', '', 'garbage']) {
    const { deps } = mk(sig);
    const out = await runShipHook(pre('gh pr merge 1'), deps);
    const d = out?.hookSpecificOutput?.permissionDecision;
    ok(d === undefined || d === 'ask', `never allow/deny (${sig || 'empty'})`);
    ok((d === 'ask') === ASKING_SIGNALS.has(sig), `asks exactly on cautious signals (${sig || 'empty'})`);
  }

  // ── Stale profile: told once a day, only past the threshold, only for a cached read ─
  {
    const old = { live: false, ageMs: 83 * DAY };
    const statePath = join(dir, 'stale.json');
    const first = mk('proceed', { source: old, statePath });
    const c1 = (await runShipHook(pre(), first.deps)).hookSpecificOutput.additionalContext;
    ok(/profile is 83 days old/.test(c1) && c1.includes('cd /x/mcp && npm run pull'), 'stale → age + the refresh command');
    const again = mk('proceed', { source: old, statePath, now: NOW + 3600e3 });
    ok(!/days old/.test((await runShipHook(pre(CMD, { tool_use_id: 'tu-2' }), again.deps)).hookSpecificOutput.additionalContext), 'not repeated within a day');
    const next = mk('proceed', { source: old, statePath, now: NOW + DAY + 1 });
    ok(/days old/.test((await runShipHook(pre(CMD, { tool_use_id: 'tu-3' }), next.deps)).hookSpecificOutput.additionalContext), 'repeated the next day');
    const fresh = mk('proceed', { source: { live: false, ageMs: (STALE_PROFILE_DAYS - 1) * DAY } });
    ok(!/days old/.test((await runShipHook(pre(), fresh.deps)).hookSpecificOutput.additionalContext), 'under the threshold → silent');
    const live = mk('proceed', { source: { live: true, ageMs: 0 } });
    ok(!/days old/.test((await runShipHook(pre(), live.deps)).hookSpecificOutput.additionalContext), 'live read → silent');
  }

  // ── B6: a merge's CI state — read by the hook, caution-only ───────────────────────
  {
    const CR = (conclusion, status = 'COMPLETED') => ({ __typename: 'CheckRun', status, conclusion });
    const SC = (state) => ({ __typename: 'StatusContext', state });
    ok(ciStateFromRollup([CR('SUCCESS'), CR('SUCCESS')]) === 'green', 'all checks passed → green');
    ok(ciStateFromRollup([CR('SUCCESS'), CR('NEUTRAL'), CR('SKIPPED'), SC('SUCCESS')]) === 'green', 'neutral / skipped / status success → green');
    ok(ciStateFromRollup([CR('SUCCESS'), CR('FAILURE')]) === 'red', 'one failure → red');
    for (const c of ['ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
      ok(ciStateFromRollup([CR(c)]) === 'red', `${c} → red`);
    ok(ciStateFromRollup([SC('FAILURE')]) === 'red' && ciStateFromRollup([SC('ERROR')]) === 'red', 'status context failure/error → red');
    ok(ciStateFromRollup([CR('SUCCESS'), CR(null, 'IN_PROGRESS')]) === 'pending', 'a check still running → pending');
    ok(ciStateFromRollup([CR(null, 'QUEUED')]) === 'pending' && ciStateFromRollup([SC('PENDING')]) === 'pending' && ciStateFromRollup([SC('EXPECTED')]) === 'pending',
      'queued / pending / expected → pending');
    ok(ciStateFromRollup([CR(null, 'IN_PROGRESS'), CR('FAILURE')]) === 'red', 'red outranks pending');
    ok(ciStateFromRollup([]) === 'none' && ciStateFromRollup(undefined) === 'none', 'no checks (docs-only PR) → none');
    ok([...CI_RAISES].sort().join() === 'pending,red', 'only red and pending raise the stakes');

    const mkCi = (ci, signalFor = (r) => (r.action_descriptor.magnitude === 'high' ? 'escalate' : 'proceed')) => {
      const log = { consults: [], receipts: [], calls: [] };
      return { log, deps: {
        now: NOW, statePath: join(dir, `ci-${++seq}.json`), mcpDir: '/x/mcp',
        ciState: async (ship, cwd) => { log.calls.push([ship.pr, ship.repo, cwd]); return ci; },
        async consult(req) { log.consults.push(req); return { response: { signal: signalFor(req), confidence: 0.44 }, drivers: [{ cue: 'irreversibleCaution', confidence: 0.5, basis: 'observed' }] }; },
        async writeReceipt(r) { log.receipts.push(r); return 'rcpt-ci'; },
        async markOutcome() {},
      } };
    };
    const merge = (cmd = 'gh pr merge 372 --squash') => pre(cmd, { cwd: '/repo' });

    const red = mkCi('red');
    const h = (await runShipHook(merge(), red.deps)).hookSpecificOutput;
    ok(red.log.calls[0][0] === '372' && red.log.calls[0][2] === '/repo', 'lookup gets the PR number and the agent\'s cwd');
    ok(red.log.consults[0].action_descriptor.magnitude === 'high', 'red → the consult sees a high-stakes merge');
    ok(h.permissionDecision === 'ask', 'red → the merge comes to the subject');
    ok(h.permissionDecisionReason === "Phaedo thinks you'd want to OK this yourself: merge PR #372 — its checks are failing.", 'the prompt says why, in plain words');
    ok(/GitHub shows its checks are failing/.test(h.additionalContext), 'the agent is told why');
    const d = red.log.receipts[0].drivers.find((x) => x.cue === 'ciState');
    ok(d && d.value === 'red' && d.basis === 'observed', 'receipt records ciState red, observed');
    ok(red.log.receipts[0].request.action_descriptor.magnitude === 'high', 'receipt records the raised stakes');

    const pend = mkCi('pending');
    ok(/its checks haven't finished/.test((await runShipHook(merge(), pend.deps)).hookSpecificOutput.permissionDecisionReason), 'pending → asked, with its own reason');

    const green = mkCi('green');
    const g = (await runShipHook(merge(), green.deps)).hookSpecificOutput;
    ok(green.log.consults[0].action_descriptor.magnitude === 'medium' && !('context' in green.log.consults[0]), 'green → the consult is unchanged (no evidence added: it could only soften)');
    ok(!('permissionDecision' in g) && !/GitHub shows/.test(g.additionalContext), 'green → no prompt, nothing added');
    ok(green.log.receipts[0].drivers.find((x) => x.cue === 'ciState')?.value === 'green', 'green is still recorded');

    for (const st of ['none', 'unknown']) {
      const x = mkCi(st);
      const o = (await runShipHook(merge(), x.deps)).hookSpecificOutput;
      ok(x.log.consults[0].action_descriptor.magnitude === 'medium' && !('permissionDecision' in o), `${st} → unchanged`);
      const dd = x.log.receipts[0].drivers.find((y) => y.cue === 'ciState');
      ok(dd?.value === st && dd.basis === (st === 'unknown' ? null : 'observed'), `${st} recorded (basis ${st === 'unknown' ? 'null' : 'observed'})`);
    }

    const admin = mkCi('red');
    await runShipHook(merge('gh pr merge 9 --admin'), admin.deps);
    ok(admin.log.consults[0].action_descriptor.magnitude === 'high', 'already-high stays high (raise never lowers)');
    const deploy = mkCi('red');
    await runShipHook(pre('fly deploy', { cwd: '/repo' }), deploy.deps);
    ok(deploy.log.calls.length === 0 && !deploy.log.receipts[0].drivers.some((x) => x.cue === 'ciState'), 'only merges are looked up');
    const repo = mkCi('green');
    await runShipHook(merge('gh pr merge 5 -R o/r'), repo.deps);
    ok(repo.log.calls[0][1] === 'o/r', '-R repo passed through');
    const nodep = mk('proceed');
    ok((await runShipHook(merge(), nodep.deps)).hookSpecificOutput && true, 'no ciState dep → hook still works');

    // The real lookup against a fake gh: arguments, parsing, and every failure → unknown.
    const { writeFileSync: wf, chmodSync } = await import('fs');
    const fake = join(dir, 'fake-gh');
    wf(fake, '#!/bin/sh\necho "$@" > "$(dirname "$0")/gh-args"\necho \'{"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}]}\'\n');
    chmodSync(fake, 0o755);
    ok(await lookupCiState({ pr: '12', repo: 'o/r' }, dir, { gh: fake }) === 'red', 'real lookup parses gh output');
    ok(readFileSync(join(dir, 'gh-args'), 'utf8').trim() === 'pr view 12 --repo o/r --json statusCheckRollup,files,changedFiles,baseRefName', 'gh called read-only: pr view <n> --repo <r> --json …');
    ok(await lookupCiState({ pr: null, repo: null }, dir, { gh: fake }) === 'red'
      && readFileSync(join(dir, 'gh-args'), 'utf8').trim() === 'pr view --json statusCheckRollup,files,changedFiles,baseRefName', "unnumbered → the current branch's PR");
    ok(await lookupCiState({ pr: '1' }, dir, { gh: join(dir, 'missing') }) === 'unknown', 'gh missing → unknown');
    const bad = join(dir, 'bad-gh'); wf(bad, '#!/bin/sh\necho not json\n'); chmodSync(bad, 0o755);
    ok(await lookupCiState({ pr: '1' }, dir, { gh: bad }) === 'unknown', 'garbage output → unknown');
    const fail = join(dir, 'fail-gh'); wf(fail, '#!/bin/sh\nexit 1\n'); chmodSync(fail, 0o755);
    ok(await lookupCiState({ pr: '1' }, dir, { gh: fail }) === 'unknown', 'gh error (no PR, not logged in) → unknown');
    const slow = join(dir, 'slow-gh'); wf(slow, '#!/bin/sh\nsleep 5\n'); chmodSync(slow, 0o755);
    const t0 = Date.now();
    ok(await lookupCiState({ pr: '1' }, dir, { gh: slow, timeoutMs: 300 }) === 'unknown' && Date.now() - t0 < 3000, 'slow gh → unknown within the timeout');
  }

  // ── B3: what a merge changes — size and sensitive paths, raise-only ───────────────
  {
    const F = (path, add = 10, del = 0) => ({ path, additions: add, deletions: del });
    // Size: markdown never counts; either line crosses.
    ok(LARGE_LINES === 1000 && LARGE_FILES === 20, 'thresholds: 1,000 lines / 20 files');
    ok(!diffStakes({ files: [F('a.js', 600, 400)] }).large, 'exactly 1,000 lines → not large');
    ok(diffStakes({ files: [F('a.js', 600, 401)] }).large, '1,001 lines → large');
    ok(!diffStakes({ files: [F('docs/state.md', 5000), F('a.js', 10)] }).large, 'markdown lines never count');
    ok(diffStakes({ files: Array.from({ length: 21 }, (_, i) => F(`f${i}.js`, 1)) }).large, '21 code files → large');
    ok(!diffStakes({ files: Array.from({ length: 30 }, (_, i) => F(`d${i}.md`, 1)) }).large, '30 markdown files → not large');
    ok(diffStakes({ files: [F('a.js')], changedFiles: 150 }).large, 'gh truncated the file list (150 > listed) → large');
    const st = diffStakes({ files: [F('a.js', 700), F('b.js', 400)] });
    ok(st.lines === 1100 && st.files === 2, 'lines and files counted');

    // Sensitive: generic, by name (tests excluded), repo list, the list itself.
    for (const p of ['.github/workflows/ci.yml', 'relay/Dockerfile', 'relay/fly.toml', 'infra/main.tf', 'db/migrations/001.sql',
      'relay/auth.js', 'mcp/lib/phaedo-crypto.js', 'config/secrets.json', 'src/security/policy.ts', 'permissions.json', SENSITIVE_FILE])
      ok(isSensitivePath(p), `generic sensitive: ${p}`);
    for (const p of ['scripts/test_lan_permission.mjs', 'relay/test-auth.mjs', 'src/__tests__/auth.ts', 'tests/crypto.js', 'auth.test.js',
      'popup.js', 'README.md', 'author.js', 'docs/authoring.md', 'cryptography-notes/x.js'.replace('cryptography-notes', 'notes')])
      ok(!isSensitivePath(p), `not sensitive: ${p}`);
    const pats = parseSensitiveList('# the rule engine\nmcp/consult\n\nspec/  # the standard\nmcp/hooks/*.mjs\n');
    ok(pats.join('|') === 'mcp/consult|spec/|mcp/hooks/*.mjs', 'list parsed: comments, blanks, trailing comments');
    ok(isSensitivePath('mcp/consult-core.js', pats) && isSensitivePath('spec/conformance.json', pats), 'prefix patterns');
    ok(isSensitivePath('mcp/hooks/pre-ship.mjs', pats) && !isSensitivePath('mcp/hooks/readme.txt', pats), 'glob pattern');
    ok(!isSensitivePath('mcp/server.js', pats) && !isSensitivePath('', pats), 'unlisted path / empty → not sensitive');
    ok(diffStakes({ files: [F('popup.js'), F('spec/x.json')] }, pats).sensitive, 'one sensitive file is enough');

    ok(stakesValue(null) === 'unknown' && stakesValue({ large: false, sensitive: false }) === 'normal'
      && stakesValue({ large: true, sensitive: true }) === 'large+sensitive', 'driver values');
    ok(raiseWords('red', { large: true, sensitive: true, lines: 1234, files: 21 })
      === "its checks are failing; it's a large change (1,234 lines across 21 files); it touches sensitive files", 'all reasons, one plain line');
    ok(raiseWords('green', { large: false, sensitive: false }) === '' && raiseWords(null, null) === '', 'nothing to say → empty');

    // Through the hook: raise on either, never lower, words on the prompt, driver recorded.
    const mkPr = (facts, signalFor = (r) => (r.action_descriptor.magnitude === 'high' ? 'clarify' : 'proceed')) => {
      const log = { consults: [], receipts: [] };
      return { log, deps: {
        now: NOW, statePath: join(dir, `pr-${++seq}.json`), mcpDir: '/x/mcp',
        prFacts: async () => facts,
        async consult(req) { log.consults.push(req); return { response: { signal: signalFor(req), confidence: 0.44 }, drivers: [{ cue: 'irreversibleCaution', confidence: 0.5, basis: 'observed' }] }; },
        async writeReceipt(r) { log.receipts.push(r); return 'rcpt-pr'; },
        async markOutcome() {},
      } };
    };
    const big = mkPr({ ci: 'green', stakes: { large: true, sensitive: false, lines: 1500, files: 9 } });
    const hb = (await runShipHook(pre('gh pr merge 5'), big.deps)).hookSpecificOutput;
    ok(big.log.consults[0].action_descriptor.magnitude === 'high' && hb.permissionDecision === 'ask', 'large → high → asked');
    ok(/merge PR #5 — it's a large change \(1,500 lines across 9 files\)/.test(hb.permissionDecisionReason), 'prompt says how large');
    ok(big.log.receipts[0].drivers.find((d) => d.cue === 'diffStakes')?.value === 'large', 'receipt: diffStakes large');
    const sens = mkPr({ ci: 'green', stakes: { large: false, sensitive: true, lines: 40, files: 2 } });
    ok(/it touches sensitive files/.test((await runShipHook(pre('gh pr merge 6'), sens.deps)).hookSpecificOutput.permissionDecisionReason), 'sensitive → asked, says so');
    const both = mkPr({ ci: 'red', stakes: { large: true, sensitive: true, lines: 2000, files: 30 } });
    ok(/its checks are failing; it's a large change .*; it touches sensitive files/.test((await runShipHook(pre('gh pr merge 7'), both.deps)).hookSpecificOutput.permissionDecisionReason), 'all reasons on one line');
    const small = mkPr({ ci: 'green', stakes: { large: false, sensitive: false, lines: 12, files: 1 } });
    const hs = (await runShipHook(pre('gh pr merge 8'), small.deps)).hookSpecificOutput;
    ok(small.log.consults[0].action_descriptor.magnitude === 'medium' && !('permissionDecision' in hs), 'small, not sensitive → unchanged (never lowered)');
    ok(small.log.receipts[0].drivers.find((d) => d.cue === 'diffStakes')?.value === 'normal', 'receipt: diffStakes normal');
    const unk = mkPr({ ci: 'unknown', stakes: null });
    await runShipHook(pre('gh pr merge 9'), unk.deps);
    ok(unk.log.consults[0].action_descriptor.magnitude === 'medium', 'lookup failed → unchanged');
    const ud = unk.log.receipts[0].drivers.find((d) => d.cue === 'diffStakes');
    ok(ud?.value === 'unknown' && ud.basis === null, 'receipt: diffStakes unknown, basis null');

    // The real lookup with a fake gh + fake git: arguments, base-branch list, and failures.
    const { writeFileSync: wf, chmodSync } = await import('fs');
    const fakeGh = join(dir, 'gh-b3');
    wf(fakeGh, '#!/bin/sh\necho "$@" > "$(dirname "$0")/gh-b3-args"\ncat <<J\n{"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}],"baseRefName":"main","changedFiles":2,"files":[{"path":"popup.js","additions":5,"deletions":1},{"path":"spec/x.json","additions":3,"deletions":0}]}\nJ\n');
    chmodSync(fakeGh, 0o755);
    const fakeGit = join(dir, 'git-b3');
    wf(fakeGit, '#!/bin/sh\necho "$@" > "$(dirname "$0")/git-b3-args"\nprintf "# test list\\nspec/\\n"\n');
    chmodSync(fakeGit, 0o755);
    const facts = await lookupPrFacts({ pr: '12', repo: null }, dir, { gh: fakeGh, git: fakeGit });
    ok(readFileSync(join(dir, 'gh-b3-args'), 'utf8').trim() === 'pr view 12 --json statusCheckRollup,files,changedFiles,baseRefName', 'one read-only gh call for everything');
    ok(readFileSync(join(dir, 'git-b3-args'), 'utf8').trim() === `show origin/main:${SENSITIVE_FILE}`, "the list is read from the BASE branch, not the PR's");
    ok(facts.ci === 'green' && facts.stakes.sensitive === true && facts.stakes.lines === 9, 'facts: green, sensitive via the repo list, 9 lines');
    const noGit = await lookupPrFacts({ pr: '12', repo: null }, dir, { gh: fakeGh, git: join(dir, 'nogit') });
    ok(noGit.stakes.sensitive === false && noGit.ci === 'green', 'list unreadable → generic rules only, no failure');
    const other = await lookupPrFacts({ pr: '12', repo: 'o/r' }, dir, { gh: fakeGh, git: fakeGit });
    ok(other.stakes.sensitive === false, "--repo elsewhere → this checkout's list does not apply");
    ok(JSON.stringify(await lookupPrFacts({ pr: '1' }, dir, { gh: join(dir, 'missing') })) === '{"ci":"unknown","stakes":null}', 'gh missing → unknown, no stakes');
    const evil = join(dir, 'gh-evil');
    wf(evil, '#!/bin/sh\necho \'{"statusCheckRollup":[],"baseRefName":"main;rm -rf ~","files":[]}\'\n'); chmodSync(evil, 0o755);
    const ev = await lookupPrFacts({ pr: '1', repo: null }, dir, { gh: evil, git: fakeGit });
    ok(ev.ci === 'none' && ev.stakes.sensitive === false, 'a hostile base-branch name is never passed to git');
  }

  // ── State store: TTL prune against a pinned clock, corrupt file tolerated ───────────
  {
    const p = join(dir, 'prune.json');
    writeState(p, { pending: { old: { receipt_id: 'a', at: new Date(NOW - 25 * 3600e3).toISOString() }, fresh: { receipt_id: 'b', at: new Date(NOW - 3600e3).toISOString() } }, stale_noted_at: 'x' }, NOW);
    const m = readState(p);
    ok(!m.pending.old && m.pending.fresh?.receipt_id === 'b', 'entries older than 24h pruned');
    ok(m.stale_noted_at === 'x', 'non-pending state survives a prune');
    writeFileSync(p, '{not json');
    ok(JSON.stringify(readState(p)) === '{"pending":{}}', 'corrupt state file → fresh, no throw');
    writeFileSync(p, '{"some":"other shape"}');
    ok(JSON.stringify(readState(p)) === '{"pending":{}}', 'foreign shape → fresh');
  }

  // ── A "no": read from the transcript at the next prompt or stop ─────────────────────
  {
    // Lines shaped like Claude Code's own transcript entries (2026-10 transcripts).
    const REJECT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
    const line = (id, content, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] }, ...extra });
    const denied = (id, extra = {}) => line(id, REJECT, { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected', ...extra });
    const said = (id) => line(id, [{ type: 'text', text: `${REJECT.split(' STOP')[0]} To tell you how to proceed, the user said:\nmerge after CI` }], { toolDenialKind: 'user-rejected' });
    const ran = (id) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'merged' }] } });
    const classifier = (id) => line(id, 'Error: Permission for this action was denied by the Claude Code auto mode classifier.', { toolDenialKind: 'automode-blocked' });

    const m = callResults([denied('a'), said('b'), denied('c', { interruptedByShutdown: true }), classifier('d'), ran('e'), '{oops', '', denied('zzz')].join('\n'), ['a', 'b', 'c', 'd', 'e', 'f']);
    ok(m.get('a').denied === 'rejected', 'transcript: a person\'s no → rejected');
    ok(m.get('b').denied === 'modified', 'transcript: a no with "do this instead" → modified');
    ok(m.get('c').denied === null, 'transcript: quitting the app mid-prompt is not a decision');
    ok(m.get('d').denied === null, 'transcript: auto mode\'s classifier saying no is not the person');
    ok(m.get('e').denied === null, 'transcript: a call that ran is not a no');
    ok(!m.has('f') && !m.has('zzz'), 'transcript: no result yet → absent; other calls ignored');
    ok(callResults('', ['a']).size === 0 && callResults(denied('a'), []).size === 0 && callResults(null, ['a']).size === 0, 'transcript: empty input → empty');

    const flow = (signal = 'escalate') => {
      const t = { text: '' };
      const made = mk(signal);
      made.deps.readTranscript = async () => t.text;
      return { ...made, t };
    };
    const turn = (name, extra = {}) => ({ hook_event_name: name, session_id: 's1', transcript_path: '/t.jsonl', ...extra });

    {
      const { deps, log, t } = flow();
      const h = (await runShipHook(pre(CMD, { session_id: 's1' }), deps)).hookSpecificOutput;
      ok(/A yes or a no on the prompt is recorded automatically/.test(h.additionalContext) && !/If they decline/.test(h.additionalContext), 'Claude Code: the agent is told both answers record themselves');
      await runShipHook(perm(), deps);
      ok(await runShipHook(turn('UserPromptSubmit'), deps) === null && log.marks.length === 0, 'no result yet → nothing recorded');
      ok(readState(deps.statePath).pending['tu-1'], '…and the call stays open for the next event');
      t.text = [ran('other'), denied('tu-1')].join('\n');
      ok(await runShipHook(turn('UserPromptSubmit', { session_id: 's2' }), deps) === null && log.marks.length === 0, 'another session\'s prompt never closes this one');
      ok(await runShipHook(turn('UserPromptSubmit'), deps) === null, 'a prompt never gets output from the hook');
      ok(log.marks.length === 1 && log.marks[0][0] === 'rcpt-1' && log.marks[0][1] === 'rejected', 'denied prompt → rejected on its receipt');
      ok(log.marks[0][2]?.keepExisting === true, 'never over what the agent already recorded');
      ok(!readState(deps.statePath).pending['tu-1'], 'the call is closed');
      await runShipHook(turn('UserPromptSubmit'), deps);
      ok(log.marks.length === 1, 'recorded once');
    }
    {
      const { deps, log, t } = flow();
      await runShipHook(pre(CMD, { session_id: 's1' }), deps);
      t.text = said('tu-1');
      await runShipHook(turn('Stop'), deps);
      ok(log.marks.length === 1 && log.marks[0][1] === 'modified', 'Stop: "no, do this instead" (the turn goes on) → modified');
    }
    {
      const { deps, log, t } = flow();
      await runShipHook(pre(CMD, { session_id: 's1' }), deps);
      t.text = classifier('tu-1');
      await runShipHook(turn('Stop'), deps);
      ok(log.marks.length === 0 && !readState(deps.statePath).pending['tu-1'], 'classifier no → closed, nothing recorded');
    }
    {
      const { deps, log, t } = flow('proceed');
      await runShipHook(pre(CMD, { session_id: 's1' }), deps);
      await runShipHook(perm(), deps);
      await runShipHook(post(), deps);
      t.text = ran('tu-1');
      await runShipHook(turn('UserPromptSubmit'), deps);
      ok(log.marks.length === 1 && log.marks[0][1] === 'approved', 'a yes is still the PostToolUse path; the turn event adds nothing');
    }
    {
      const { deps, log } = flow();
      await runShipHook(pre(), deps);          // no session id (an older entry)
      deps.readTranscript = async () => { throw new Error('should not read'); };
      ok(await runShipHook(turn('UserPromptSubmit'), deps) === null && log.marks.length === 0, 'an entry with no session id is never matched');
      deps.readTranscript = async () => { throw new Error('unreadable'); };
      await runShipHook(pre(CMD, { session_id: 's1', tool_use_id: 'tu-2' }), deps);
      ok(await runShipHook(turn('UserPromptSubmit'), deps) === null && readState(deps.statePath).pending['tu-2'], 'unreadable transcript → nothing, call kept');
      ok(await runShipHook(turn('UserPromptSubmit', { transcript_path: undefined }), deps) === null, 'no transcript path → nothing');
    }
    {
      const { deps, log } = mk('escalate');     // other agents: no transcript reader
      await runShipHook(pre(CMD, { session_id: 's1' }), deps);
      ok(await runShipHook(turn('UserPromptSubmit'), deps) === null && log.marks.length === 0, 'without a transcript reader the turn events do nothing');
    }
  }

  // ── The real script, as Claude Code runs it ─────────────────────────────────────────
  {
    const stateDir = mkdtempSync(join(dir, 'state-'));
    const env = { ...process.env, PHAEDO_MCP_STATE_DIR: stateDir, PHAEDO_FINGERPRINT: join(HERE, 'sample-fingerprint.json') };
    delete env.PHAEDO_CONSULT_MODEL;     // hermetic: never call a real model judge
    env.PHAEDO_SHIP_GH = join(dir, 'no-such-gh');   // hermetic: never ask the real GitHub
    const script = join(HERE, 'hooks', 'pre-ship.mjs');
    const run = (input) => spawnSync(process.execPath, [script], { input: JSON.stringify(input), env, encoding: 'utf8', timeout: 20000 });
    const { readReceipts } = await import('./receipts.js');

    const quiet = run(pre('git status'));
    ok(quiet.status === 0 && quiet.stdout === '', 'script: non-ship → exit 0, no output');
    ok(!existsSync(join(stateDir, 'receipts.enc')), 'script: non-ship writes no receipt');

    const r = run(pre('gh pr merge 372 --squash', { tool_use_id: 'tu-real' }));
    ok(r.status === 0, 'script: exit 0');
    const out = JSON.parse(r.stdout);
    ok(out.hookSpecificOutput?.hookEventName === 'PreToolUse', 'script: emits a PreToolUse decision object');
    const rid = /receipt_id: ([0-9a-f-]{36})/.exec(out.hookSpecificOutput.additionalContext)?.[1];
    ok(!!rid, 'script: context carries a real receipt id');

    const rs = await readReceipts(stateDir);
    ok(rs.length === 1 && rs[0].receipt_id === rid, 'script: one receipt in the store');
    ok(rs[0].via === 'phaedo_consult' && rs[0].agent_id === 'claude-code/ship-hook', 'script: a full consult, labelled as the hook');
    ok(rs[0].request.action_descriptor.domain === 'engineering' && rs[0].request.action_binding?.tool_name === 'Bash', 'script: bound engineering receipt');
    ok(rs[0].user_action === null, 'script: no outcome invented');
    const { RESOLVER_REVISION } = await import('./consult-core.js');
    ok((rs[0].drivers || []).some((d) => d.cue === 'resolverRevision' && d.value === RESOLVER_REVISION), 'script: receipt stamped with the rule-engine revision');
    // The published receipt schema (§10.6) — the same structural checks spec/test-schemas.mjs
    // applies to buildReceipt, run on the receipt the hook actually wrote.
    const rSchema = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'schemas', 'consultation-receipt.schema.json'), 'utf8'));
    ok(rSchema.required.every((k) => k in rs[0]), 'schema: all required keys');
    ok(Object.keys(rs[0]).every((k) => rSchema.properties[k]), 'schema: no keys outside the schema');
    ok(rSchema.properties.via.enum.includes(rs[0].via), 'schema: via ∈ enum');

    // Prompt shown → yes recorded, across three separate processes (state on disk).
    const pr = run({ ...perm('gh pr merge 372 --squash') });
    ok(pr.status === 0 && pr.stdout === '', 'script: PermissionRequest exit 0, no output');
    const p2 = run(post({ tool_use_id: 'tu-real' }));
    ok(p2.status === 0 && p2.stdout === '', 'script: PostToolUse exit 0, no output after a recorded yes');
    ok((await readReceipts(stateDir))[0].user_action === 'approved', 'script: prompted + ran → approved on the receipt');
    ok(!readFileSync(join(stateDir, 'ship-hook.json'), 'utf8').includes('merge'), 'script: state file never holds the command');

    // Prompt shown → declined: Claude Code fires no hook; the next prompt reads the transcript.
    const r3 = run(pre('gh pr merge 373 --squash', { tool_use_id: 'tu-no', session_id: 'sess-1' }));
    const rid3 = /receipt_id: ([0-9a-f-]{36})/.exec(JSON.parse(r3.stdout).hookSpecificOutput.additionalContext)?.[1];
    run(perm('gh pr merge 373 --squash'));
    const tPath = join(dir, 'transcript.jsonl');
    writeFileSync(tPath, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-no', name: 'Bash', input: { command: 'gh pr merge 373 --squash' } }] } }),
      JSON.stringify({ type: 'user', toolDenialKind: 'user-rejected', toolUseResult: 'User rejected tool use', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-no', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } }),
    ].join('\n') + '\n');
    const ups = run({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', transcript_path: tPath, prompt: 'no, wait for CI' });
    ok(ups.status === 0 && ups.stdout === '', 'script: UserPromptSubmit exit 0, no output');
    ok((await readReceipts(stateDir)).find((x) => x.receipt_id === rid3)?.user_action === 'rejected', 'script: declined prompt → rejected on the receipt');
    // An outcome the agent already recorded is kept.
    const r4 = run(pre('gh pr merge 374 --squash', { tool_use_id: 'tu-kept', session_id: 'sess-1' }));
    const rid4 = /receipt_id: ([0-9a-f-]{36})/.exec(JSON.parse(r4.stdout).hookSpecificOutput.additionalContext)?.[1];
    const { markOutcome } = await import('./receipts.js');
    await markOutcome(stateDir, rid4, 'modified');
    writeFileSync(tPath, JSON.stringify({ type: 'user', toolDenialKind: 'user-rejected', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-kept', content: 'x' }] } }) + '\n');
    run({ hook_event_name: 'Stop', session_id: 'sess-1', transcript_path: tPath });
    ok((await readReceipts(stateDir)).find((x) => x.receipt_id === rid4)?.user_action === 'modified', 'script: the agent\'s recorded outcome is kept');
    const idle = run({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-other', transcript_path: join(dir, 'missing.jsonl') });
    ok(idle.status === 0 && idle.stdout === '', 'script: a prompt with nothing open → exit 0, no output');

    const garbage = spawnSync(process.execPath, [script], { input: 'not json', env, encoding: 'utf8' });
    ok(garbage.status === 0 && garbage.stdout === '', 'script: garbage stdin → exit 0, no output');

    // Broken vault: the hook stays out of the way.
    const badFp = join(dir, 'bad-fp.json');
    writeFileSync(badFp, '{"nope": true}');
    const broken = spawnSync(process.execPath, [script], { input: JSON.stringify(pre()), env: { ...env, PHAEDO_FINGERPRINT: badFp }, encoding: 'utf8' });
    ok(broken.status === 0 && broken.stdout === '', 'script: unusable fingerprint → exit 0, no output');
  }
  // ── The personal reviewer: connected-tool actions, and a reason that's about THIS person ──
  {
    const mcp = (name, extra = {}) => ({ hook_event_name: name, tool_name: 'mcp__slack__post_message', tool_use_id: 'tu-m1',
      permission_mode: 'auto', tool_input: { channel: '#eng', text: 'deploying now' }, ...extra });
    const { deps, log } = mk('escalate');
    const out = await runShipHook(mcp('PreToolUse'), deps);
    const h = out.hookSpecificOutput;
    ok(h.permissionDecision === 'ask', 'a cautious answer on a Slack post → ask (forces a prompt even in auto mode)');
    ok(h.permissionDecisionReason === "Phaedo thinks you'd want to OK this yourself: send or post a message via slack — it can't be undone.",
      `the prompt says why for this person: ${h.permissionDecisionReason}`);
    ok(log.consults[0].action_descriptor.domain === 'communication' && log.consults[0].action_binding.tool_name === 'mcp__slack__post_message',
      'consulted as communication, bound to the tool');
    ok(!/deploying now/.test(JSON.stringify(log.consults[0])), 'the message body never reaches the consult or the receipt');
    // PermissionRequest has no tool_use_id: matched by the call's identity, same as Bash.
    const permEv = mcp('PermissionRequest'); delete permEv.tool_use_id;
    ok(readState(deps.statePath).pending['tu-m1'].cmd_hash === callHash(permEv), 'a tool call is matched across events by its input');
    await runShipHook(permEv, deps);
    await runShipHook(mcp('PostToolUse'), deps);
    ok(log.marks.length === 1 && log.marks[0][1] === 'approved', 'the subject said yes on the prompt → approved, as for Bash');

    const { deps: d2, log: l2 } = mk('proceed');
    const quiet = await runShipHook(mcp('PreToolUse', { tool_use_id: 'tu-m2' }), d2);
    ok(!('permissionDecision' in quiet.hookSpecificOutput) && l2.receipts.length === 1, 'a permissive answer stays quiet — the reviewer only asks when it should');
    ok(await runShipHook(mcp('PreToolUse', { tool_name: 'mcp__gmail__search_threads' }), d2) === null, 'read-only tools are never reviewed');
    ok(await runShipHook(mcp('PreToolUse', { tool_name: 'mcp__phaedo__phaedo_escalate' }), d2) === null, 'nor Phaedo\'s own tools');

    ok(personalWhy({ reversible: false, amount: 1250 }, {}) === "it can't be undone and it spends $1,250", 'stakes named plainly');
    ok(personalWhy({ reversible: false }, { rationale_hint: 'Per your standing rule: ask me before posting in #eng.' }) === 'your rule: ask me before posting in #eng',
      'a matched rule wins over the stakes');
    ok(personalWhy({ reversible: true, magnitude: 'low' }, {}) === '', 'nothing at stake → no extra words');
    ok(promptReason('escalate', 'force-push feature', '', "it can't be undone") === "Phaedo thinks you'd want to OK this yourself: force-push feature — it can't be undone.",
      'promptReason adds the personal reason');
    ok(promptReason('escalate', 'merge PR #3', 'the checks are failing', "it can't be undone").includes('the checks are failing; it can\'t be undone'),
      'GitHub facts and the personal reason read together');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`✓ test-ship-hook: ${pass} checks passed`);
