// "Are you being asked less?" (asks.js) — the week-by-week ask rate and its two honesty checks.
//
//   node mcp/test-asks.mjs

import assert from 'node:assert';
import { asksByWeek, formatAsks, headline, trendLine, formatTable, DEFAULT_WEEKS, MIN_TO_COMPARE } from './asks.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const NOW = Date.parse('2026-10-31T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (days) => new Date(NOW - days * DAY).toISOString();
let seq = 0;
const R = (signal, days, { action = null, reversible = true } = {}) => ({
  receipt_id: `r-${seq++}`, created_at: at(days),
  request: { action_descriptor: { domain: 'engineering', reversible } },
  response: { signal }, user_action: action,
});
const many = (k, f) => Array.from({ length: k }, (_, i) => f(i));

console.log('\nthe tally');
{
  const rep = asksByWeek([
    R('escalate', 1, { action: 'approved' }),                       // avoidable: reversible, yes as-is
    R('clarify', 2, { action: 'approved', reversible: false }),     // irreversible: never avoidable
    R('escalate', 3, { action: 'rejected' }),                       // an ask that mattered
    R('escalate', 3, { action: 'modified' }),
    R('proceed', 1, { action: 'approved' }),                        // confirmed
    R('proceed_with_note', 2, { action: 'rejected' }),              // overruled
    R('decline', 2, { action: 'approved' }),                        // overruled (stopped, you went ahead)
    R('decline', 4, { action: 'rejected' }),                        // confirmed
    R('proceed', 5, { action: 'unknown' }),                         // quiet, unanswered
    R('proceed', 5),                                                // quiet, unanswered
    R('insufficient_signal', 1),
    { created_at: 'garbage', response: { signal: 'proceed' } },
    { created_at: at(1), response: { signal: 'something_new' } },
    R('escalate', -1),                                              // future → skipped
  ], { now: NOW });
  const w = rep.weeks[rep.weeks.length - 1];
  ok(rep.weeks.length === DEFAULT_WEEKS, 'eight weeks by default');
  ok(w.checked === 11 && w.asked === 4 && w.quiet === 6 && w.unsure === 1, `checked/asked/quiet/unsure ${JSON.stringify(w)}`);
  ok(w.confirmed === 2 && w.overruled === 2, 'agreement scoring: go-ahead reversed and stop reversed both count as overruled');
  ok(w.avoidable === 1, 'only a reversible ask approved as-is is avoidable');
  ok(Math.abs(w.ask_rate - 4 / 11) < 1e-9, 'ask rate = asked / checked');
  ok(asksByWeek(null, { now: NOW }).total.checked === 0, 'no records → zero, never throws');
}

console.log('\nweeks and halves');
{
  const rep = asksByWeek([R('proceed', 0.5), R('proceed', 6.9), R('proceed', 7.1), R('proceed', 55), R('proceed', 57)], { now: NOW });
  ok(rep.weeks[7].checked === 2 && rep.weeks[6].checked === 1, 'records land in their own week');
  ok(rep.total.checked === 4 && rep.weeks[0].checked === 1, 'day 55 is in the oldest week; day 57 is past the window and skipped');
  ok(rep.half_weeks === 4 && rep.recent.checked === 3 && rep.earlier.checked === 1, 'recent = newest 4 weeks, earlier = the 4 before');
  const odd = asksByWeek([R('proceed', 7 * 4.5)], { now: NOW, weeks: 5 });
  ok(odd.half_weeks === 2 && odd.earlier.checked === 0 && odd.recent.checked === 0 && odd.total.checked === 1, 'an odd oldest week is left out of the comparison');
  ok(asksByWeek([], { now: NOW, weeks: 'x' }).weeks.length === DEFAULT_WEEKS && asksByWeek([], { now: NOW, weeks: 1 }).weeks.length === 2, 'bad or tiny week counts fall back safely');
}

console.log('\nthe sentences');
{
  ok(headline(asksByWeek([], { now: NOW })) === 'No actions came to Phaedo in the last 4 weeks.', 'nothing yet');
  const thin = asksByWeek([R('escalate', 1), R('proceed', 2)], { now: NOW });
  ok(headline(thin) === 'In the last 4 weeks Phaedo checked 2 actions and asked you about 1 (50%). Not enough yet to say whether that is falling.', headline(thin));
  ok(trendLine(thin) === '', 'status stays quiet until there is a trend');

  // Earlier: 10 checks, 5 asks (50%). Recent: 10 checks, 2 asks (20%).
  const falling = asksByWeek([
    ...many(5, () => R('escalate', 40)), ...many(5, () => R('proceed', 40)),
    ...many(2, () => R('escalate', 3, { action: 'approved' })), ...many(8, (i) => R('proceed', 3, { action: i < 3 ? 'approved' : null })),
  ], { now: NOW });
  const s = formatAsks(falling);
  ok(s.split('\n')[0] === "In the last 4 weeks Phaedo checked 10 actions and asked you about 2 (20%). That's down from 50% the 4 weeks before.", s);
  ok(s.split('\n')[1] === 'It decided 8 times without asking. You still had to answer 3 of those yourself, and reversed 0.', s);
  ok(s.split('\n')[2] === '2 asks were about something that could be undone and you said yes as-is — those are what it should learn to stop asking.', s);
  ok(trendLine(falling) === s.split('\n')[0], 'status shows the headline once there is a trend');

  const rising = asksByWeek([...many(5, () => R('proceed', 40)), ...many(5, () => R('escalate', 3))], { now: NOW });
  ok(headline(rising).endsWith("That's up from 0% the 4 weeks before."), headline(rising));
  const flat = asksByWeek([...many(MIN_TO_COMPARE, () => R('proceed', 40)), ...many(MIN_TO_COMPARE, () => R('proceed', 3))], { now: NOW });
  ok(headline(flat).endsWith("That's the same as the 4 weeks before."), headline(flat));

  const unanswered = formatAsks(asksByWeek([R('proceed', 1), R('escalate', 1, { action: 'approved' })], { now: NOW }));
  ok(unanswered.includes('It decided 1 time without asking; none of those has an answer from you yet.'), unanswered);
  ok(unanswered.includes('One ask was about something that could be undone and you said yes as-is — that is what it should learn to stop asking.'), unanswered);
  ok(!formatAsks(asksByWeek([R('escalate', 1)], { now: NOW })).includes('without asking'), 'no quiet calls → no cost line');
}

console.log('\nthe table');
{
  const t = formatTable(asksByWeek([R('escalate', 1, { action: 'approved' }), R('proceed', 2)], { now: NOW, weeks: 2 })).split('\n');
  ok(t.length === 2 && t[0].endsWith('—'), 'an empty week is a dash');
  ok(/2 checked\s+1 asked \(\s*50%\)\s+0 reversed\s+1 could have gone ahead$/.test(t[1]), t[1]);
}

console.log(`\nasks: ${pass} checks passed`);
