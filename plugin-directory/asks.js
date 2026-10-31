#!/usr/bin/env node
// "Are you being asked less?" — the number Phaedo's purpose is judged by.
//
// Phaedo's promise: agents stop interrupting you for things you'd have said yes to, and still
// bring you the irreversible, high-stakes ones. weekly.js counts one week; this reads the local
// decision records (receipts.js) week by week so the trend shows, together with the two checks
// that keep a falling number honest:
//
//   checked    — every action an agent brought to Phaedo
//   asked      — Phaedo sent it to you (escalate / clarify)
//   quiet      — Phaedo decided without asking (proceed / proceed_with_note / decline)
//   overruled  — a quiet call you then reversed (agreement.js scoring). The cost of asking less.
//   confirmed  — a quiet call you then agreed with
//   avoidable  — an ask about something that could be undone, which you approved as-is: the asks
//                Phaedo should learn to stop making. An ask about an irreversible action is never
//                avoidable — those are the subject's to decide.
//   unsure     — insufficient_signal: neither an ask nor a call
//
// The trend compares the ask rate of the recent half of the window with the half before it, and
// says nothing until each half holds MIN_TO_COMPARE checks — a rate over a handful is noise.
// Pure over the receipts list; the CLI reads the local store.
//
//   npm run asks                       last 8 weeks, in plain lines
//   npm run asks -- --weeks 12 --table week by week

import { readReceipts } from './receipts.js';
import { defaultStateDir } from './cache.js';
import { DECISIVE, agrees } from './agreement.js';
import { isMainModule } from './lib/is-main.js';

export const DEFAULT_WEEKS = 8;
export const MIN_TO_COMPARE = 5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ASKED = new Set(['escalate', 'clarify']);

const empty = () => ({ checked: 0, asked: 0, quiet: 0, overruled: 0, confirmed: 0, avoidable: 0, unsure: 0 });

function tally(row, r) {
  const signal = r?.response?.signal;
  const action = r?.user_action;
  if (ASKED.has(signal)) {
    row.checked++; row.asked++;
    if (action === 'approved' && r?.request?.action_descriptor?.reversible === true) row.avoidable++;
  } else if (DECISIVE.includes(signal)) {
    row.checked++; row.quiet++;
    if (action && action !== 'unknown') { if (agrees(signal, action)) row.confirmed++; else row.overruled++; }
  } else if (signal === 'insufficient_signal') {
    row.checked++; row.unsure++;
  }
}

function sum(rows) {
  const out = empty();
  for (const row of rows) for (const k of Object.keys(out)) out[k] += row[k];
  out.ask_rate = out.checked ? out.asked / out.checked : null;
  return out;
}

/**
 * (receipts, { now, weeks }) -> { weeks: [row…] oldest first, recent, earlier, half_weeks, total }.
 * `recent` is the newest half of the window, `earlier` the equal span before it (an odd oldest week
 * is left out of the comparison, never folded into one side).
 */
export function asksByWeek(receipts, { now = Date.now(), weeks = DEFAULT_WEEKS } = {}) {
  const n = Math.max(2, Math.floor(Number(weeks)) || DEFAULT_WEEKS);
  const start = now - n * WEEK_MS;
  const rows = Array.from({ length: n }, (_, i) => ({ start: new Date(start + i * WEEK_MS).toISOString(), ...empty() }));
  for (const r of Array.isArray(receipts) ? receipts : []) {
    const t = Date.parse(r?.created_at);
    if (!Number.isFinite(t) || t < start || t > now) continue;
    tally(rows[Math.min(n - 1, Math.floor((t - start) / WEEK_MS))], r);
  }
  for (const row of rows) row.ask_rate = row.checked ? row.asked / row.checked : null;
  const half = Math.floor(n / 2);
  return {
    weeks: rows,
    half_weeks: half,
    recent: sum(rows.slice(n - half)),
    earlier: sum(rows.slice(n - 2 * half, n - half)),
    total: sum(rows),
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (x) => `${Math.round(x * 100)}%`;

/** The headline: how often Phaedo asked lately, and whether that is falling. */
export function headline(rep) {
  const { recent: r, earlier: e, half_weeks: h } = rep;
  const span = plural(h, 'week');
  if (!r.checked) return `No actions came to Phaedo in the last ${span}.`;
  const first = `In the last ${span} Phaedo checked ${plural(r.checked, 'action')} and asked you about ${r.asked} (${pct(r.ask_rate)}).`;
  if (r.checked < MIN_TO_COMPARE || e.checked < MIN_TO_COMPARE) return `${first} Not enough yet to say whether that is falling.`;
  const diff = Math.round(r.ask_rate * 100) - Math.round(e.ask_rate * 100);
  if (diff === 0) return `${first} That's the same as the ${span} before.`;
  return `${first} That's ${diff < 0 ? 'down' : 'up'} from ${pct(e.ask_rate)} the ${span} before.`;
}

/** Plain lines for a person: the headline, what asking less cost, and the asks it could drop. */
export function formatAsks(rep) {
  const r = rep.recent;
  const lines = [headline(rep)];
  if (r.quiet) {
    const answered = r.confirmed + r.overruled;
    // An answer on a quiet call means the subject was in the loop anyway — from the ship and
    // agent hooks, only ever because the app showed its own approval prompt. Said plainly: it
    // is the next interruption to remove, not a win to count.
    lines.push(answered
      ? `It decided ${plural(r.quiet, 'time')} without asking. You still had to answer ${answered} of those yourself, and reversed ${r.overruled}.`
      : `It decided ${plural(r.quiet, 'time')} without asking; none of those has an answer from you yet.`);
  }
  if (r.avoidable) {
    lines.push(`${r.avoidable === 1 ? 'One ask was' : `${r.avoidable} asks were`} about something that could be undone and you said yes as-is — ${r.avoidable === 1 ? 'that is' : 'those are'} what it should learn to stop asking.`);
  }
  return lines.join('\n');
}

/** For /phaedo:status: the headline only once there is a trend to show; '' until then. */
export function trendLine(rep) {
  return rep.recent.checked >= MIN_TO_COMPARE && rep.earlier.checked >= MIN_TO_COMPARE ? headline(rep) : '';
}

/** Week by week, for the curious: `--table`. */
export function formatTable(rep) {
  return rep.weeks.map((w) => {
    const day = new Date(w.start).toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
    if (!w.checked) return `${day}  —`;
    return `${day}  ${String(w.checked).padStart(3)} checked  ${String(w.asked).padStart(3)} asked (${pct(w.ask_rate).padStart(4)})  ${w.overruled} reversed  ${w.avoidable} could have gone ahead`;
  }).join('\n');
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--weeks');
  const weeks = i >= 0 ? Number(args[i + 1]) : DEFAULT_WEEKS;
  const receipts = await readReceipts(defaultStateDir()).catch(() => []);
  const rep = asksByWeek(receipts, { weeks });
  console.log(formatAsks(rep));
  if (args.includes('--table')) console.log(`\n${formatTable(rep)}`);
}
