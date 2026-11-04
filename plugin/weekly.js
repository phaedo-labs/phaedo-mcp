#!/usr/bin/env node
// "This week Phaedo handled N decisions for you" — the visible win.
//
// Phaedo's case is fewer, better interruptions: an agent asks Phaedo instead of you, and only the
// decisions you'd actually want to see reach you. That is invisible unless it's counted, so this
// counts it from the local decision records (receipts.js), over the last 7 days:
//
//   went_ahead  — Phaedo said go ahead (proceed / proceed_with_note): you weren't interrupted
//   stopped     — Phaedo said no (decline), usually one of your rules: you weren't interrupted
//   came_to_you — Phaedo said check with you (escalate / clarify)
//   unsure      — Phaedo didn't know (insufficient_signal); the agent fell back to its own default
//
// "Handled" is went_ahead + stopped. `by_rule` is the part of went_ahead that one of the subject's
// standing rules decided — the receipt carries a `standingRule` (server) or `standingGrant` (ship
// hook) driver saying so — which is how they see a rule they accepted actually being used.
// Pure over the receipts list; the CLI reads the local store.
//
//   npm run week

import { readReceipts } from './receipts.js';
import { defaultStateDir } from './cache.js';
import { isMainModule } from './lib/is-main.js';

export const WEEK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET = {
  proceed: 'went_ahead', proceed_with_note: 'went_ahead',
  decline: 'stopped',
  escalate: 'came_to_you', clarify: 'came_to_you',
  insufficient_signal: 'unsure',
};

// The driver cues that mean "a standing rule answered this" (server.js ruleAnsweredDriver,
// hooks/pre-ship.mjs). A held grant is recorded as `held:<why>`, so only 'answered' counts.
export const RULE_CUES = new Set(['standingRule', 'standingGrant']);
export function answeredByRule(r) {
  return Array.isArray(r?.drivers) && r.drivers.some((d) => RULE_CUES.has(d?.cue) && d?.value === 'answered');
}

/** The server's driver for a receipt a standing rule decided: an authorization that matched and
 *  said go ahead, AND an answer that still says go ahead after the stale-authority guard — one the
 *  guard withheld went to the subject instead, so the rule did not decide it. */
export function standingRuleDriver(auth, response) {
  return auth?.authorization_matched === true && auth.signal === 'proceed' && response?.signal === 'proceed'
    ? [{ cue: 'standingRule', value: 'answered', confidence: 1, basis: 'authored' }] : [];
}

export function weeklyHandled(receipts, { now = Date.now(), days = WEEK_DAYS } = {}) {
  const since = now - days * DAY_MS;
  const out = { days, went_ahead: 0, by_rule: 0, stopped: 0, came_to_you: 0, unsure: 0 };
  for (const r of Array.isArray(receipts) ? receipts : []) {
    const t = Date.parse(r?.created_at);
    if (!Number.isFinite(t) || t < since || t > now) continue;
    const b = BUCKET[r?.response?.signal];
    if (b) out[b]++;
    if (b === 'went_ahead' && answeredByRule(r)) out.by_rule++;
  }
  out.handled = out.went_ahead + out.stopped;
  out.total = out.handled + out.came_to_you + out.unsure;
  return out;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One plain sentence (two at most) for a person. */
export function formatWeekly(w) {
  if (!w || !w.total) return 'No decisions came to Phaedo this week yet.';
  const parts = [];
  if (w.went_ahead) parts.push(`${w.went_ahead} went ahead`);
  if (w.stopped) parts.push(`${w.stopped} stopped`);
  const handled = w.handled
    ? `This week Phaedo handled ${plural(w.handled, 'decision')} without interrupting you (${parts.join(', ')})`
    : 'This week Phaedo handled no decisions on its own';
  const asked = w.came_to_you ? ` and brought ${w.came_to_you} to you` : '';
  const rule = w.by_rule ? ` Your standing rule decided ${w.handled === 1 ? 'it' : `${w.by_rule === 1 ? 'one' : w.by_rule} of them`}.` : '';
  const unsure = w.unsure ? ` ${w.unsure === 1 ? 'One more was' : `${w.unsure} more were`} too unclear to call.` : '';
  return `${handled}${asked}.${rule}${unsure}`;
}

if (isMainModule(import.meta.url)) {
  const receipts = await readReceipts(defaultStateDir()).catch(() => []);
  console.log(formatWeekly(weeklyHandled(receipts)));
}
