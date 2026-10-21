#!/usr/bin/env node
// Phaedo — Claude Code ship hook (PreToolUse, PermissionRequest, PostToolUse,
// PostToolUseFailure on Bash).
//
// WHY THIS EXISTS. The precedent track is starved: no consultation has been written since
// 2026-07-28, so agreement, calibration and override learning have nothing to read. The
// decisions this subject actually delegates, every week, are the ones a coding agent takes
// for them — merging a PR, deploying the relay, cutting a phone build. This hook consults
// Phaedo before those run (ship-actions.js names them) and writes a §10.6 receipt, so the
// receipts accumulate in normal use instead of waiting for an agent to remember a tool.
//
// WHAT IT MAY DO — ONE RULE. The hook only ever ADDS friction; it never removes it. It
// never returns `allow`, so it cannot pre-approve anything Claude Code would otherwise
// have asked about. On a permissive answer it returns no decision at all (Claude Code's
// own permission flow applies unchanged); on a cautious one it returns `ask`, which puts
// the action in front of the subject. That is why it reads the at-rest profile cache and
// skips the server's stale-authority guard: the guard exists to stop a stale read from
// EXPANDING autonomy, and nothing here can.
//
// WHERE OUTCOMES COME FROM — SUBJECT-AUTHORED ONLY (§10.6 honesty rail). The one thing the
// hook records itself is a yes the subject gave on a prompt, and it records that only on
// EVIDENCE that the prompt was shown: Claude Code fires PermissionRequest when it is about
// to show one. So, per call:
//   - prompt shown, then the command ran → the subject said yes → `approved`. Whatever the
//     consult answered, and in any permission mode — a yes on a `proceed` is the scoreable
//     case agreement needs.
//   - prompt shown, then declined → Claude Code fires NO hook for a manual denial
//     (documented), so the agent is told the receipt id up front and records `rejected`.
//   - no prompt (bypass mode, an allow rule) → nothing recorded. After the run the agent is
//     told so, and records the subject's reaction only if they give one. Silence is never
//     approval.
// This replaces a guess: whether a hook's `ask` still prompts under bypassPermissions is
// not documented, and no longer needs to be.
//
// FAIL-SAFE: any error, timeout or unrecognised input exits 0 with no output, so a broken
// Phaedo never blocks or slows a merge beyond the budget. Wire it with
// `npm run setup:code-hook` (install.mjs adds all four events).

import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { classifyShipCommand } from '../ship-actions.js';
import { isMainModule } from '../lib/is-main.js';

const MCP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Never hold a command up for long. A consult with a model judge configured can take its
// own timeout (PHAEDO_CONSULT_TIMEOUT_MS, default 15s); past this the hook says nothing.
export const BUDGET_MS = 12000;

// Signals that hand the action to the subject. `insufficient_signal` is not one: an
// abstain is Phaedo saying it does not know, which is no reason to interrupt anyone.
export const ASKING_SIGNALS = new Set(['escalate', 'clarify', 'decline']);

// Permission modes in which a PermissionRequest is not evidence that a PERSON answered:
// auto mode's classifier and dontAsk decide without one.
const NO_HUMAN_MODES = new Set(['auto', 'dontAsk']);

// The profile is read from the at-rest cache, which only a live read refreshes. Past this
// age the agent is told once a day, so the subject hears about it in plain words.
export const STALE_PROFILE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = DAY_MS;

// The caller label on the receipt. `via` stays `phaedo_consult` — the hook runs a full
// consultation through the same path, and the receipt schema's `via` enum is closed — so
// the free-text, self-asserted `agent_id` is where "this came from the ship hook" lives.
export const AGENT_ID = 'claude-code/ship-hook';

export const commandHash = (cmd) => createHash('sha256').update(String(cmd ?? '')).digest('hex');

// ── CI state for a merge (precedent track Phase 1b, B6) ───────────────────────────────
// Merging a PR whose checks are failing, or have not finished, is a bigger act than merging a
// green one — and nothing the agent declares says so. CAUTION-ONLY, by measurement: on the
// dev Mac's profile a normal merge answers `proceed` with or without `evidence_provided`, and
// on an admin merge green evidence only SOFTENS the answer (clarify → proceed_with_note). So
// green is RECORDED and changes nothing; failing or unfinished raises the merge to `high`.
// The state comes from GitHub, read by the hook itself — never from the agent.
export const CI_LOOKUP_MS = 4000;

/** statusCheckRollup → 'red' | 'pending' | 'green' | 'none' (no checks configured). */
export function ciStateFromRollup(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  if (!list.length) return 'none';
  const FAIL = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
  const OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  let pending = false;
  for (const c of list) {
    // CheckRun: status + conclusion. StatusContext: state.
    const v = String(c?.conclusion || c?.state || '').toUpperCase();
    if (FAIL.has(v)) return 'red';
    const done = c?.__typename === 'StatusContext' ? v && v !== 'PENDING' && v !== 'EXPECTED' : String(c?.status || '').toUpperCase() === 'COMPLETED';
    if (!done || !OK.has(v)) pending = true;
  }
  return pending ? 'pending' : 'green';
}

// How each state changes the consult, and the words the subject reads on the prompt.
export const CI_RAISES = new Set(['red', 'pending']);
const CI_WORDS = { red: 'its checks are failing', pending: "its checks haven't finished" };

// ── What a merge changes (precedent track Phase 1b, B3) ───────────────────────────────
// The classifier calls every merge `medium` — a 2-line typo fix and a 2,000-line rewrite of
// the rule engine alike. Two facts from the PR raise it to `high`; nothing lowers it (a
// lowered magnitude could let a §10.5 grant capped at `low` fire — the widening direction).
//
// LARGE: more than LARGE_LINES changed lines or LARGE_FILES files, markdown excluded. Set from
// the dev repo's last 60 merged PRs (code-only p50 135 lines / 3 files, p90 848 / 14): about
// 1 PR in 12 crosses either line.
export const LARGE_LINES = 1000;
export const LARGE_FILES = 20;
// SENSITIVE: a changed path that matters more than its size. Generic rules for any repo (CI
// and deploy config, migrations, auth / crypto / secrets / security / permissions by name —
// test files excluded from the name rule), plus the repo's own list in `.phaedo-sensitive`
// (one path prefix or `*` glob per line, # comments). The list is read from the BASE branch,
// so a PR cannot shrink it for itself, and a PR that edits the list is sensitive by definition.
export const SENSITIVE_FILE = '.phaedo-sensitive';
const GENERIC_SENSITIVE = [
  /^\.github\/workflows\//, /(^|\/)Dockerfile$/, /(^|\/)fly\.toml$/, /\.tf$/, /(^|\/)migrations?\//,
];
const SENSITIVE_NAME = /(^|[\/_.-])(auth|crypto|secrets?|security|permissions?)([\/_.-]|$)/i;
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|(^|\/)test[-_]|[._-]test\.|\.spec\./i;

/** Parse `.phaedo-sensitive` text → patterns. */
export function parseSensitiveList(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
}
function patternMatches(pattern, path) {
  if (!pattern.includes('*')) return path === pattern || path.startsWith(pattern);
  const re = new RegExp('^' + pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
  return re.test(path);
}
export function isSensitivePath(path, repoPatterns = []) {
  const p = String(path || '');
  if (!p) return false;
  if (p === SENSITIVE_FILE) return true;
  if (GENERIC_SENSITIVE.some((re) => re.test(p))) return true;
  if (!TEST_PATH.test(p) && SENSITIVE_NAME.test(p)) return true;
  return repoPatterns.some((pat) => patternMatches(pat, p));
}

/** (PR facts, repo patterns) → { large, sensitive, lines, files } — PURE. */
export function diffStakes(facts, repoPatterns = []) {
  const all = Array.isArray(facts?.files) ? facts.files : [];
  const code = all.filter((f) => !/\.md$/i.test(String(f?.path || '')));
  const lines = code.reduce((n, f) => n + (Number(f?.additions) || 0) + (Number(f?.deletions) || 0), 0);
  // gh lists at most 100 files; past that, the count it reports is the floor of the truth.
  const truncated = Number(facts?.changedFiles) > all.length;
  const files = truncated ? Number(facts.changedFiles) : code.length;
  const large = lines > LARGE_LINES || files > LARGE_FILES || truncated;
  const sensitive = all.some((f) => isSensitivePath(f?.path, repoPatterns));
  return { large, sensitive, lines, files };
}
export const stakesValue = (st) => (!st ? 'unknown' : st.large && st.sensitive ? 'large+sensitive' : st.large ? 'large' : st.sensitive ? 'sensitive' : 'normal');

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((res) => {
    try {
      execFile(cmd, args, { cwd: cwd || undefined, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => res(err ? null : String(stdout)));
    } catch { res(null); }
  });
}

/**
 * One read-only GitHub lookup for everything the hook needs about a merge, via the gh CLI the
 * agent itself uses: { ci, stakes } — ci 'unknown' and stakes null on any failure.
 */
export async function lookupPrFacts(ship, cwd, {
  gh = process.env.PHAEDO_SHIP_GH || 'gh', git = process.env.PHAEDO_SHIP_GIT || 'git', timeoutMs = CI_LOOKUP_MS,
} = {}) {
  const args = ['pr', 'view', ...(ship.pr ? [ship.pr] : []), ...(ship.repo ? ['--repo', ship.repo] : []),
    '--json', 'statusCheckRollup,files,changedFiles,baseRefName'];
  const out = await run(gh, args, cwd, timeoutMs);
  let j = null;
  try { j = out ? JSON.parse(out) : null; } catch { j = null; }
  if (!j || typeof j !== 'object') return { ci: 'unknown', stakes: null };
  // The repo's own list, from the base branch. Only when the merge targets THIS checkout
  // (no --repo); a list we cannot read is an empty list — the generic rules still apply.
  let patterns = [];
  if (!ship.repo && typeof j.baseRefName === 'string' && /^[\w./-]+$/.test(j.baseRefName)) {
    const text = await run(git, ['show', `origin/${j.baseRefName}:${SENSITIVE_FILE}`], cwd, 2000);
    patterns = parseSensitiveList(text);
  }
  return { ci: ciStateFromRollup(j.statusCheckRollup), stakes: diffStakes(j, patterns) };
}

/** Back-compat: the CI state alone. */
export async function lookupCiState(ship, cwd, opts) { return (await lookupPrFacts(ship, cwd, opts)).ci; }

// The words the subject reads, joined into one line.
export function raiseWords(ci, stakes) {
  const w = [];
  if (CI_RAISES.has(ci)) w.push(CI_WORDS[ci]);
  if (stakes?.large) w.push(`it's a large change (${stakes.lines.toLocaleString('en-US')} lines across ${stakes.files} files)`);
  if (stakes?.sensitive) w.push('it touches sensitive files');
  return w.join('; ');
}

// ── Hook state: tool_use_id → its consult, so later events can find it. ───────────────
// Ids, a command DIGEST and flags only — never the command. Entries pruned after a day.
export function readState(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    if (j && typeof j === 'object' && j.pending && typeof j.pending === 'object') return j;
  } catch { /* missing or corrupt → fresh */ }
  return { pending: {} };
}
export function writeState(path, state, now) {
  const pending = {};
  for (const [k, v] of Object.entries(state.pending || {})) if (now - Date.parse(v?.at) < PENDING_TTL_MS) pending[k] = v;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, pending }), { mode: 0o600 });
  renameSync(tmp, path);
}

// What the subject reads on the prompt. Plain words, no numbers, no protocol terms.
export function promptReason(signal, summary, why) {
  const what = why ? `${summary} — ${why}` : summary;
  if (signal === 'decline') return `Phaedo thinks you'd say no to this one: ${what}. Go ahead anyway?`;
  if (signal === 'clarify') return `Phaedo isn't sure how you'd want this handled: ${what}. Go ahead?`;
  return `Phaedo thinks you'd want to OK this yourself: ${what}.`;
}

// What the agent reads before the command. It carries the receipt id — the one handle
// that attributes an outcome to THIS decision rather than whatever receipt is newest.
export function preContext({ summary, signal, receiptId, asked, hint }) {
  const head = `Phaedo was consulted before this command (${summary}) and answered "${signal}"` +
    (hint ? ` — ${hint}` : '') + `. receipt_id: ${receiptId}.`;
  if (asked) {
    return `${head} Phaedo flagged it for the user, so they may be asked to confirm. If they decline, ` +
      `call phaedo_record_outcome with this receipt_id and "rejected" (or "modified" if they want it ` +
      `done differently). A yes on the prompt is recorded automatically.`;
  }
  return `${head} If the user reacts to this specific action when you report it — says it was right, ` +
    `objects, or wants it changed — call phaedo_record_outcome with this receipt_id and "approved", ` +
    `"rejected" or "modified". Record only what they actually said about it; silence is not approval, ` +
    `and do not record anything because you proceeded.`;
}

// After the command, when Phaedo had flagged it and no prompt was shown.
export function unpromptedContext(receiptId) {
  return `No confirmation prompt was shown for this command (receipt_id: ${receiptId}), though Phaedo ` +
    `had flagged it for the user. Tell them in one line that it ran and Phaedo had flagged it, and ` +
    `record their reaction with phaedo_record_outcome and this receipt_id if they give one. Silence ` +
    `is not approval.`;
}

export function staleContext(days, mcpDir) {
  return `Also: Phaedo's copy of the user's profile is ${days} days old (their phone has not been ` +
    `reached since). Mention once, in one line, that they can refresh it by running ` +
    `\`cd ${mcpDir} && npm run pull\` and approving on their phone.`;
}

/**
 * One hook invocation. Pure apart from injected deps, so the whole flow is testable
 * without a vault, a receipt store or Claude Code.
 *
 * deps: { consult(req) → { response, drivers, source? }, writeReceipt({request,response,drivers}) → id,
 *         markOutcome(id, action), statePath, now, mcpDir? }
 * Returns the JSON object to print, or null for no output.
 */
export async function runShipHook(input, deps) {
  if (!input || input.tool_name !== 'Bash') return null;
  const now = deps.now ?? Date.now();
  const ev = input.hook_event_name;

  if (ev === 'PreToolUse') {
    const ship = classifyShipCommand(input.tool_input?.command);
    if (!ship) return null;
    // B6 + B3: one GitHub lookup per merge — check state, size, paths. Each can only raise.
    let ci = null, stakes = null;
    if (ship.class === 'merge_pr') {
      if (deps.prFacts) ({ ci, stakes } = await deps.prFacts(ship, input.cwd));
      else if (deps.ciState) ci = await deps.ciState(ship, input.cwd);
    }
    const why = raiseWords(ci, stakes);
    const raised = why !== '';
    const request = {
      consultation_type: 'action_approval',
      agent_id: AGENT_ID,
      action_descriptor: raised ? { ...ship.action_descriptor, magnitude: 'high' } : ship.action_descriptor,
      action_binding: ship.action_binding,
    };
    const { response, drivers, source } = await deps.consult(request);
    const signal = String(response?.signal || '');
    // Provenance: what the hook saw, beside what drove the answer. Local receipt only.
    const extra = [];
    if (ci) extra.push({ cue: 'ciState', value: ci, confidence: null, basis: ci === 'unknown' ? null : 'observed' });
    if (ci && deps.prFacts) extra.push({ cue: 'diffStakes', value: stakesValue(stakes), confidence: null, basis: stakes ? 'observed' : null });
    const allDrivers = extra.length ? [...(drivers || []), ...extra] : drivers;
    const receiptId = await deps.writeReceipt({ request, response, drivers: allDrivers });
    if (!receiptId) return null;     // no receipt = nothing to learn from; stay out of the way
    const asked = ASKING_SIGNALS.has(signal);

    const state = readState(deps.statePath);
    if (input.tool_use_id) {
      state.pending[input.tool_use_id] = {
        receipt_id: receiptId, cmd_hash: commandHash(input.tool_input?.command),
        asked, prompt_shown: false, at: new Date(now).toISOString(),
      };
    }
    let context = preContext({
      summary: ship.summary, signal, receiptId, asked,
      hint: typeof response?.rationale_hint === 'string' ? response.rationale_hint : '',
    });
    if (raised) context += ` GitHub shows ${why}, so Phaedo treated this merge as high-stakes.`;
    const ageDays = source && source.live === false && Number.isFinite(source.ageMs) ? Math.floor(source.ageMs / DAY_MS) : 0;
    if (ageDays >= STALE_PROFILE_DAYS && !(now - Date.parse(state.stale_noted_at) < DAY_MS)) {
      context += ' ' + staleContext(ageDays, deps.mcpDir || MCP_DIR);
      state.stale_noted_at = new Date(now).toISOString();
    }
    writeState(deps.statePath, state, now);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        ...(asked ? { permissionDecision: 'ask', permissionDecisionReason: promptReason(signal, ship.summary, why) } : {}),
        additionalContext: context,
      },
    };
  }

  if (ev === 'PermissionRequest') {
    // Evidence that a prompt is about to be shown for this command. PermissionRequest has
    // no tool_use_id (documented), so match the newest pending consult on the same command.
    if (NO_HUMAN_MODES.has(input.permission_mode)) return null;
    const h = commandHash(input.tool_input?.command);
    const state = readState(deps.statePath);
    const hit = Object.values(state.pending)
      .filter((e) => e.cmd_hash === h && !e.prompt_shown)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (!hit) return null;
    hit.prompt_shown = true;
    writeState(deps.statePath, state, now);
    return null;                     // never decide here — the subject answers the prompt
  }

  if (ev === 'PostToolUse' || ev === 'PostToolUseFailure') {
    if (!input.tool_use_id) return null;
    const state = readState(deps.statePath);
    const entry = state.pending[input.tool_use_id];
    if (!entry) return null;
    delete state.pending[input.tool_use_id];
    writeState(deps.statePath, state, now);
    // An interrupted command is the subject changing their mind mid-run, which is not a
    // clean yes — record nothing.
    if (ev === 'PostToolUseFailure' && input.is_interrupt) return null;
    if (entry.prompt_shown) {
      // The command started after a prompt, so the subject said yes. A failed command is
      // still an approved decision.
      await deps.markOutcome(entry.receipt_id, 'approved');
      return null;
    }
    if (!entry.asked) return null;   // permissive + unprompted: the pre-context already said how
    return { hookSpecificOutput: { hookEventName: ev, additionalContext: unpromptedContext(entry.receipt_id) } };
  }
  return null;
}

// ── Real deps: the same consult path as the MCP server (consult-runtime.js). ──────────
async function realDeps() {
  const { loadConsultVd, buildConsultOpts } = await import('../consult-runtime.js');
  const { resolveConsultation, consultDrivers, withRevision } = await import('../consult.js');
  const { buildReceipt, appendReceipt, receiptsCapFromEnv, markOutcome } = await import('../receipts.js');
  const { sourceOf } = await import('../fingerprint-source.js');
  const { defaultStateDir } = await import('../cache.js');
  const stateDir = defaultStateDir();
  const quiet = () => {};
  const opts = buildConsultOpts(MCP_DIR, process.env, { warn: quiet });
  return {
    statePath: join(stateDir, 'ship-hook.json'),
    mcpDir: MCP_DIR,
    prFacts: (ship, cwd) => lookupPrFacts(ship, cwd),
    async consult(request) {
      const vd = await loadConsultVd(MCP_DIR, { preferCache: true, warn: quiet });
      const response = await resolveConsultation(vd, request, opts);
      let drivers = [];
      try { drivers = withRevision(consultDrivers(vd, request, opts), response); } catch { /* provenance is non-critical */ }
      return { response, drivers, source: sourceOf(vd) };
    },
    async writeReceipt({ request, response, drivers }) {
      const r = buildReceipt({ via: 'phaedo_consult', agentId: AGENT_ID, clientId: opts.clientId, request, response, drivers });
      await appendReceipt(stateDir, r, { cap: receiptsCapFromEnv(process.env) });
      return r.receipt_id;
    },
    async markOutcome(id, action) { await markOutcome(stateDir, id, action); },
  };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  // Cheap exit before importing the vault stack: most Bash calls are not ship actions.
  if (input?.tool_name !== 'Bash') return;
  if (input.hook_event_name === 'PreToolUse' && !classifyShipCommand(input.tool_input?.command)) return;
  const out = await runShipHook(input, await realDeps());
  if (out) process.stdout.write(JSON.stringify(out));
}

if (isMainModule(import.meta.url)) {
  const timeout = new Promise((res) => setTimeout(res, BUDGET_MS));
  Promise.race([main().catch(() => {}), timeout])
    .then(() => process.exit(0))
    .catch(() => process.exit(0)); // a hook must never break the session
}
