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
// "Handled" is went_ahead + stopped. Pure over the receipts list; the CLI reads the local store.
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

export function weeklyHandled(receipts, { now = Date.now(), days = WEEK_DAYS } = {}) {
  const since = now - days * DAY_MS;
  const out = { days, went_ahead: 0, stopped: 0, came_to_you: 0, unsure: 0 };
  for (const r of Array.isArray(receipts) ? receipts : []) {
    const t = Date.parse(r?.created_at);
    if (!Number.isFinite(t) || t < since || t > now) continue;
    const b = BUCKET[r?.response?.signal];
    if (b) out[b]++;
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
  const unsure = w.unsure ? ` ${w.unsure === 1 ? 'One more was' : `${w.unsure} more were`} too unclear to call.` : '';
  return `${handled}${asked}.${unsure}`;
}

if (isMainModule(import.meta.url)) {
  const receipts = await readReceipts(defaultStateDir()).catch(() => []);
  console.log(formatWeekly(weeklyHandled(receipts)));
}
