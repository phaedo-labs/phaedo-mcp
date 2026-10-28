// Ship actions — which shell commands are a decision the subject would want consulted on.
//
// The precedent track's Phase 1 (docs/roadmap/precedent-and-sync-design-2026-09-13.md) is
// starved of outcome data because nothing consults: no receipt has been written since
// 2026-07-28. The decisions the subject actually delegates, every week, are the ones a
// coding agent takes on their behalf — merging a PR, deploying the relay, cutting a phone
// build. This module names those, so the PreToolUse hook (hooks/pre-ship.mjs) can consult
// before they run. Everything else a shell does is not a decision and is ignored.
//
// PURE: (command string) -> classification | null. No I/O.

import { createHash } from 'node:crypto';

// One entry per class. `match` sees one simple command, already split out of a compound
// line and stripped of env assignments and `npx`. The descriptor is what the consult
// reasons about — magnitude is the stakes, reversible is whether it can be walked back.
const CLASSES = [
  {
    id: 'merge_pr',
    // `gh pr merge` — reversible (a revert), medium. `--admin` skips required checks, which
    // is a different act: high.
    match: (w) => w[0] === 'gh' && w[1] === 'pr' && w[2] === 'merge',
    describe: (w) => {
      const num = w.slice(3).find((x) => /^#?\d+$/.test(x));
      const admin = w.includes('--admin');
      // `-R/--repo` names the repository when the agent is not inside it; the hook passes it
      // through when it asks GitHub for the PR's check state (B6).
      const ri = w.findIndex((x) => x === '-R' || x === '--repo');
      const repo = ri >= 0 ? w[ri + 1] : (w.find((x) => x.startsWith('--repo='))?.split('=')[1]);
      return {
        magnitude: admin ? 'high' : 'medium',
        reversible: true,
        summary: `${admin ? 'admin-merge' : 'merge'} ${num ? `PR #${num.replace('#', '')}` : "this branch's PR"}`,
        pr: num ? num.replace('#', '') : null,
        repo: repo || null,
      };
    },
  },
  {
    id: 'deploy',
    // `fly deploy` — production for every paired phone. Reversible (`fly releases` rollback)
    // but high: a bad relay breaks sync for everyone until it is rolled back.
    match: (w) => (w[0] === 'fly' || w[0] === 'flyctl') && w[1] === 'deploy',
    describe: (w) => {
      const i = w.findIndex((x) => x === '-a' || x === '--app');
      const app = i >= 0 ? w[i + 1] : null;
      return { magnitude: 'high', reversible: true, summary: `deploy${app ? ` ${app}` : ''} to Fly` };
    },
  },
  {
    id: 'app_build',
    // `eas build` — a build artifact, nothing reaches a device yet. Low.
    match: (w) => isEas(w[0]) && w[1] === 'build',
    describe: (w) => ({ magnitude: 'low', reversible: true, summary: `phone build${platform(w)}` }),
  },
  {
    id: 'app_submit',
    // `eas submit` (or `eas build --auto-submit`) — the build goes to TestFlight / the store.
    match: (w) => isEas(w[0]) && (w[1] === 'submit' || (w[1] === 'build' && w.includes('--auto-submit'))),
    describe: (w) => ({ magnitude: 'medium', reversible: true, summary: `submit phone build${platform(w)}` }),
  },
  {
    id: 'push_main',
    // A direct push to the default branch, skipping review. A force-push there rewrites
    // shared history: high, and not cleanly reversible.
    match: (w) => w[0] === 'git' && w[1] === 'push' && w.slice(2).some((x) => /^\+?(?:[^:]*:)?(?:refs\/heads\/)?(?:main|master)$/.test(x)),
    describe: (w) => {
      const force = w.some((x) => x === '-f' || x === '--force' || x.startsWith('--force-with-lease') || x.startsWith('+'));
      return force
        ? { magnitude: 'high', reversible: false, summary: 'force-push to main' }
        : { magnitude: 'medium', reversible: true, summary: 'push directly to main' };
    },
  },
  // ── The personal reviewer (2026-10-27): the other things an agent does for the subject that
  // people disagree about. Auto mode's classifier judges these by TYPE and lets the routine
  // ones through; Phaedo asks whether THIS subject would want to see this one.
  {
    id: 'force_push',
    // Any force-push (main is push_main's, ranked first). Rewrites shared history.
    match: (w) => w[0] === 'git' && w[1] === 'push' && hasForce(w),
    describe: (w) => {
      const ref = w.slice(2).filter((x) => !x.startsWith('-')).pop();
      return { magnitude: 'high', reversible: false, summary: `force-push${ref ? ` ${ref.replace(/^\+/, '')}` : ''}` };
    },
  },
  {
    id: 'delete_branch',
    // `git push <remote> --delete x` / `git push <remote> :x`.
    match: (w) => w[0] === 'git' && w[1] === 'push' && (w.includes('--delete') || w.includes('-d') || w.slice(3).some((x) => /^:[^:]+$/.test(x))),
    describe: (w) => {
      const ref = w.slice(2).filter((x) => !x.startsWith('-')).slice(1).map((x) => x.replace(/^:/, '')).join(', ');
      return { magnitude: 'medium', reversible: false, summary: `delete remote branch${ref ? ` ${ref}` : ''}` };
    },
  },
  {
    id: 'open_pr',
    // Opening a PR is cheap and reversible, but whether an agent may open one unasked is
    // exactly the kind of thing people differ on.
    match: (w) => w[0] === 'gh' && w[1] === 'pr' && w[2] === 'create',
    describe: () => ({ magnitude: 'low', reversible: true, summary: 'open a pull request' }),
  },
  {
    id: 'comment',
    // Speaking for the subject in public: comments and reviews can be edited, not unsaid.
    match: (w) => w[0] === 'gh' && ((['pr', 'issue'].includes(w[1]) && w[2] === 'comment') || (w[1] === 'pr' && w[2] === 'review')),
    describe: (w) => {
      const approve = w[2] === 'review' && (w.includes('--approve') || w.includes('-a'));
      const reject = w[2] === 'review' && (w.includes('--request-changes') || w.includes('-r'));
      return {
        magnitude: 'medium', reversible: false,
        summary: approve ? 'approve a pull request' : reject ? 'request changes on a pull request' : `post a comment on a GitHub ${w[1] === 'issue' ? 'issue' : 'pull request'}`,
      };
    },
  },
  {
    id: 'publish',
    // A published package version can't be taken back cleanly (npm forbids re-using one).
    match: (w) => !w.includes('--dry-run') && (
      (['npm', 'pnpm', 'bun'].includes(w[0]) && w[1] === 'publish')
      || (w[0] === 'yarn' && (w[1] === 'publish' || (w[1] === 'npm' && w[2] === 'publish')))
      || (w[0] === 'cargo' && w[1] === 'publish') || (w[0] === 'twine' && w[1] === 'upload') || (w[0] === 'gem' && w[1] === 'push')),
    describe: (w) => ({ magnitude: 'high', reversible: false, summary: `publish a package (${w[0]})` }),
  },
  {
    id: 'release',
    match: (w) => w[0] === 'gh' && w[1] === 'release' && w[2] === 'create',
    describe: (w) => ({ magnitude: 'medium', reversible: true, summary: `create a GitHub release${w[3] && !w[3].startsWith('-') ? ` ${w[3]}` : ''}` }),
  },
  {
    id: 'deploy_other',
    // Production deploys outside Fly. `terraform destroy` and `kubectl delete` can't be undone.
    match: (w) => (w[0] === 'vercel' && w.includes('--prod')) || (w[0] === 'netlify' && w[1] === 'deploy' && w.includes('--prod'))
      || (w[0] === 'firebase' && w[1] === 'deploy') || (w[0] === 'terraform' && ['apply', 'destroy'].includes(w[1]))
      || (w[0] === 'kubectl' && ['apply', 'delete'].includes(w[1])),
    describe: (w) => {
      const destroy = (w[0] === 'terraform' && w[1] === 'destroy') || (w[0] === 'kubectl' && w[1] === 'delete');
      return { magnitude: 'high', reversible: !destroy, summary: destroy ? `${w[0]} ${w[1]}` : `deploy with ${w[0]}` };
    },
  },
];

function hasForce(w) {
  return w.some((x) => x === '-f' || x === '--force' || x.startsWith('--force-with-lease') || (x.startsWith('+') && x.length > 1));
}

// Order matters: `eas build --auto-submit` is a submit, not a build, and a force-push to main is
// push_main's (it names main), so push_main is tried before the general force_push.
const ORDER = ['merge_pr', 'deploy', 'app_submit', 'app_build', 'push_main', 'force_push', 'delete_branch',
  'open_pr', 'comment', 'publish', 'release', 'deploy_other'];

function isEas(w0) { return w0 === 'eas' || w0 === 'eas-cli'; }
function platform(w) {
  const i = w.findIndex((x) => x === '--platform' || x === '-p');
  const p = i >= 0 ? w[i + 1] : (w.find((x) => x.startsWith('--platform='))?.split('=')[1]);
  return p ? ` (${p})` : '';
}

// Split a shell line into simple commands on && || ; | and newlines. Not a shell parser —
// quotes are honoured only enough that `git commit -m "a && b"` does not split.
export function splitCommands(line) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && line[i + 1] === '&')) {
      if (c === '&' || (c === '|' && line[i + 1] === '|')) i++;
      out.push(cur); cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Words of one simple command, with leading env assignments, `npx`/`npx --yes`, and a
// quoted-string's quotes removed.
export function words(cmd) {
  const w = (cmd.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((x) => x.replace(/^["']|["']$/g, ''));
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
  if (w[0] === 'npx') { w.shift(); while (w[0] && w[0].startsWith('-')) w.shift(); }
  // A path to the binary (`/opt/homebrew/bin/gh`, `./node_modules/.bin/eas`) is the binary.
  if (w[0]) w[0] = w[0].split('/').pop();
  return w;
}

// Stakes order for a line that chains several ship actions: irreversible first, then by
// magnitude. A line that merges and then deploys is consulted on the deploy — consulting on
// the merge would let the riskier half ride on the safer half's answer.
const MAG_RANK = { low: 0, medium: 1, high: 2 };
const stakes = (d) => (d.reversible === false ? 10 : 0) + (MAG_RANK[d.magnitude] ?? 1);

// ── Actions through connected tools (MCP), not the shell ──────────────────────────────────
// The same decisions arrive as tool calls: a Gmail `send_message`, a Slack `post_message`, a
// payments `create_payment`, a Drive `trash_file`. Tool names follow `mcp__<server>__<tool>`;
// the VERB in the tool name says what it does. Read-only tools (get_/list_/search_) never match,
// and Phaedo's own tools are never classified (consulting Phaedo about consulting Phaedo).
const MCP_VERBS = [
  { re: /(?:^|_)(send|reply|forward|post|publish|comment|share|invite)(?:_|$)/, kind: 'send' },
  { re: /(?:^|_)(pay|payment|purchase|transfer|checkout|buy)(?:_|$)/, kind: 'spend' },
  { re: /(?:^|_)(delete|purge|destroy)(?:_|$)/, kind: 'delete' },
  { re: /(?:^|_)(trash)(?:_|$)/, kind: 'trash' },
  { re: /(?:^|_)(merge)(?:_|$)/, kind: 'merge' },
];
// A broad first cut for the hook's matcher (hooks.json): cheap to spawn on, then refined here.
export const MCP_HOOK_MATCHER = 'mcp__.*(send|reply|forward|post|publish|comment|share|invite|pay|purchase|transfer|checkout|buy|delete|purge|destroy|trash|merge).*';

export function parseMcpToolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  return m ? { server: m[1], tool: m[2].toLowerCase() } : null;
}

// A short, privacy-conscious preview of who/what the call targets — never a message body.
const PREVIEW_KEYS = ['to', 'recipient', 'recipients', 'channel', 'chat', 'subject', 'title', 'name', 'amount', 'currency', 'merchant', 'payee', 'repo', 'pull_number', 'file_id', 'id'];
function previewOf(input) {
  if (!input || typeof input !== 'object') return '';
  const parts = [];
  for (const k of PREVIEW_KEYS) {
    const v = input[k];
    if (v == null || typeof v === 'object' && !Array.isArray(v)) continue;
    parts.push(`${k}: ${Array.isArray(v) ? v.slice(0, 3).join(', ') : String(v)}`);
  }
  return parts.join('; ').slice(0, 120);
}

/**
 * Classify an MCP tool call. Returns null for anything that isn't a consequential action, else
 * the same shape as classifyShipCommand.
 */
export function classifyMcpCall(toolName, toolInput) {
  const p = parseMcpToolName(toolName);
  if (!p || /(^|_)phaedo($|_)/.test(p.server) || p.server.startsWith('plugin_phaedo')) return null;
  const verb = MCP_VERBS.find((v) => v.re.test(p.tool));
  if (!verb) return null;
  // Connector servers are often named by an id ("597bdf05-a786-…"); say what it is instead.
  const named = p.server.replace(/^plugin_/, '').replace(/_/g, ' ');
  const via = /^[0-9a-f]{6,}(-[0-9a-f]+)*$/i.test(p.server) ? 'a connected app' : named;
  // An amount only means money on a payment; on a message or a delete it's just a field.
  const amount = verb.kind === 'spend' && typeof toolInput?.amount === 'number' && isFinite(toolInput.amount) ? toolInput.amount : undefined;
  const d = {
    send:   { domain: 'communication', magnitude: 'medium', reversible: false, summary: `send or post a message via ${via}` },
    spend:  { domain: 'payments', magnitude: 'high', reversible: false, summary: `make a payment via ${via}` },
    delete: { domain: 'data', magnitude: 'medium', reversible: false, summary: `delete something via ${via}` },
    trash:  { domain: 'data', magnitude: 'low', reversible: true, summary: `move something to the trash via ${via}` },
    merge:  { domain: 'engineering', magnitude: 'medium', reversible: true, summary: `merge via ${via}` },
  }[verb.kind];
  const preview = previewOf(toolInput);
  return {
    class: `mcp_${verb.kind}`,
    summary: d.summary,
    multiple: false,
    action_descriptor: {
      domain: d.domain, reversible: d.reversible, magnitude: d.magnitude, summary: d.summary,
      ...(amount !== undefined ? { amount } : {}),
    },
    action_binding: {
      tool_name: String(toolName),
      arguments_hash: createHash('sha256').update(JSON.stringify(toolInput ?? null)).digest('hex'),
      ...(preview ? { arguments_preview: preview } : {}),
    },
  };
}

/** Either kind of call: a Bash command, or an MCP tool. Null when it isn't a decision. */
export function classifyToolCall(toolName, toolInput) {
  if (toolName === 'Bash') return classifyShipCommand(toolInput?.command);
  return classifyMcpCall(toolName, toolInput);
}

/**
 * Classify a Bash command. Returns null when no part of it is a ship action, else the
 * highest-stakes ship action in it (ties: the first), with `multiple` set when the line
 * chains more than one.
 *
 * @returns {null | { class, summary, multiple, action_descriptor, action_binding }}
 */
export function classifyShipCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const hits = [];
  for (const seg of splitCommands(command)) {
    const w = words(seg);
    if (!w.length) continue;
    for (const id of ORDER) {
      const k = CLASSES.find((c) => c.id === id);
      if (k.match(w)) { hits.push({ id, seg, d: k.describe(w) }); break; }
    }
  }
  if (!hits.length) return null;
  const first = hits.reduce((best, h) => (stakes(h.d) > stakes(best.d) ? h : best));
  return {
    class: first.id,
    summary: first.d.summary,
    multiple: hits.length > 1,
    // merge_pr only: which PR, and in which repo (null = the current branch's, here).
    ...(first.id === 'merge_pr' ? { pr: first.d.pr, repo: first.d.repo } : {}),
    action_descriptor: {
      domain: 'engineering',
      reversible: first.d.reversible,
      magnitude: first.d.magnitude,
      summary: first.d.summary,
    },
    // §10.2 binding: the concrete call this descriptor claims to describe — a digest of the
    // whole line, never the line itself beyond a short preview.
    action_binding: {
      tool_name: 'Bash',
      arguments_hash: createHash('sha256').update(command).digest('hex'),
      arguments_preview: first.seg.slice(0, 120),
    },
  };
}
