#!/usr/bin/env node
// Ship-hook readout — what the Claude Code ship hook (hooks/pre-ship.mjs) has seen: how many
// merges / deploys / phone builds it consulted on, what Phaedo answered, what the subject
// said, and whether agreement has anything to score yet. The precedent track's Phase 1
// exit is "receipts gain marked outcomes in normal use"; this is how to see whether they do.
//
//   npm run ship-readout              # last 30 days
//   npm run ship-readout -- --days 90
//
// All local: decrypts the receipt store with the local key; prints counts and the summary
// line each receipt already carries (never layer content).

import { computeAgreement } from './agreement.js';
import { AGENT_ID } from './hooks/pre-ship.mjs';

export const DEFAULT_DAYS = 30;
const PERMISSIVE = new Set(['proceed', 'proceed_with_note']);
const ASKING = new Set(['escalate', 'clarify', 'decline']);

// The action a hook receipt was about, from the summary ship-actions.js wrote.
export function actionKind(summary) {
  const s = String(summary || '');
  if (/^(admin-)?merge\b/.test(s)) return 'merge';
  if (/^deploy\b/.test(s)) return 'deploy';
  if (/^submit\b/.test(s)) return 'phone submit';
  if (/^phone build\b/.test(s)) return 'phone build';
  if (/push/.test(s)) return 'push to main';
  return 'other';
}

/**
 * (receipts, { now, windowDays }) -> the readout, PURE. Only receipts the ship hook wrote
 * count — the agreement figure here is the hook's own, not the whole store's.
 */
export function shipReadout(receipts, { now = Date.now(), windowDays = DEFAULT_DAYS } = {}) {
  const since = now - windowDays * 24 * 60 * 60 * 1000;
  const mine = (Array.isArray(receipts) ? receipts : []).filter((r) => r?.agent_id === AGENT_ID);
  const inWindow = mine.filter((r) => { const t = Date.parse(r?.created_at); return Number.isFinite(t) && t >= since && t <= now; });
  const kinds = {};
  const answers = { go_ahead: 0, flagged: 0, unsure: 0 };
  const outcomes = { approved: 0, rejected: 0, modified: 0, unmarked: 0 };
  for (const r of inWindow) {
    const k = actionKind(r.request?.action_descriptor?.summary);
    kinds[k] = (kinds[k] || 0) + 1;
    const sig = r.response?.signal;
    if (PERMISSIVE.has(sig)) answers.go_ahead++; else if (ASKING.has(sig)) answers.flagged++; else answers.unsure++;
    const a = r.user_action;
    if (a === 'approved' || a === 'rejected' || a === 'modified') outcomes[a]++; else outcomes.unmarked++;
  }
  const agreement = computeAgreement(inWindow, { now, windowDays }).overall;
  const newest = inWindow[inWindow.length - 1] || null;
  return {
    window_days: windowDays,
    total_ever: mine.length,
    consults: inWindow.length,
    kinds,
    answers,
    outcomes,
    agreement: { scored: agreement.scored, agreements: agreement.agreements, rate: agreement.rate },
    newest: newest && {
      at: newest.created_at,
      summary: newest.request?.action_descriptor?.summary || null,
      signal: newest.response?.signal || null,
      user_action: newest.user_action || null,
    },
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const KIND_PLURAL = { merge: 'merges', deploy: 'deploys', 'phone build': 'phone builds', 'phone submit': 'phone submits', 'push to main': 'pushes to main', other: 'others' };
const saidIt = (sig) => (PERMISSIVE.has(sig) ? 'go ahead' : ASKING.has(sig) ? 'flagged for you' : "didn't know");

// Plain lines for the terminal. No confidences, no protocol terms beyond the summary.
export function formatReadout(o) {
  const lines = [`Ship hook — last ${o.window_days} days`];
  if (!o.consults) {
    lines.push(o.total_ever
      ? `  Nothing in this window (${plural(o.total_ever, 'consult')} before it). Try --days ${o.window_days * 3}.`
      : '  No consults yet. Is the hook installed? (npm run setup:code-hook, then a new Claude Code session)');
    return lines.join('\n');
  }
  const kinds = Object.entries(o.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => plural(n, k, KIND_PLURAL[k]));
  lines.push(`  ${plural(o.consults, 'consult')}: ${kinds.join(', ')}`);
  const ans = [`go ahead ${o.answers.go_ahead}×`, `flagged for you ${o.answers.flagged}×`];
  if (o.answers.unsure) ans.push(`didn't know ${o.answers.unsure}×`);
  lines.push(`  Phaedo said: ${ans.join(', ')}`);
  const { approved, rejected, modified, unmarked } = o.outcomes;
  lines.push(`  You said: yes ${approved}, no ${rejected}, changed it ${modified} — ${unmarked} not marked`);
  lines.push(o.agreement.scored
    ? `  Phaedo matched you on ${o.agreement.agreements} of ${o.agreement.scored} decisions it could be scored on`
    : '  Nothing to score yet (needs a "go ahead" you then answered)');
  if (o.newest) {
    const day = String(o.newest.at).slice(0, 10);
    lines.push(`  Newest: ${day} ${o.newest.summary || '(no summary)'} → Phaedo: ${saidIt(o.newest.signal)}${o.newest.user_action ? ` · you: ${o.newest.user_action}` : ''}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('ship-readout.js')) {
  const i = process.argv.indexOf('--days');
  const days = i > 0 ? Number(process.argv[i + 1]) : DEFAULT_DAYS;
  const { readReceipts } = await import('./receipts.js');
  const { defaultStateDir } = await import('./cache.js');
  const rs = await readReceipts(defaultStateDir());
  console.log(formatReadout(shipReadout(rs, { windowDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS })));
}
