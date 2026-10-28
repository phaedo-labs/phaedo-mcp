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
];

// Order matters for one pair: `eas build --auto-submit` is a submit, not a build.
const ORDER = ['merge_pr', 'deploy', 'app_submit', 'app_build', 'push_main'];

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
