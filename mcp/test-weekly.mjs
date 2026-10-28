// "This week Phaedo handled N decisions for you" (weekly.js), and its trip to the phone.
//
//   node mcp/test-weekly.mjs

import assert from 'node:assert';
import { weeklyHandled, formatWeekly, WEEK_DAYS } from './weekly.js';
import { buildReceiptsDeposit } from './receipts-sync.js';
import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';

const { Kdf, Envelope } = Phaedo;

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const NOW = Date.parse('2026-10-27T12:00:00Z');
const at = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
const R = (signal, days) => ({ receipt_id: `r-${signal}-${days}`, created_at: at(days), response: { signal }, request: { action_descriptor: {} }, user_action: null });

console.log('\nthe count');
{
  const w = weeklyHandled([
    R('proceed', 1), R('proceed_with_note', 2), R('decline', 3),
    R('escalate', 1), R('clarify', 6), R('insufficient_signal', 2),
    R('proceed', 8),                                    // last week — not counted
    { created_at: 'garbage', response: { signal: 'proceed' } },
    { created_at: at(1), response: { signal: 'something_new' } },
  ], { now: NOW });
  ok(WEEK_DAYS === 7 && w.days === 7, 'a week is 7 days');
  ok(w.went_ahead === 2 && w.stopped === 1, 'went ahead = proceed + proceed_with_note; stopped = decline');
  ok(w.came_to_you === 2 && w.unsure === 1, 'came to you = escalate + clarify; unsure = insufficient_signal');
  ok(w.handled === 3 && w.total === 6, 'handled = went ahead + stopped; older, malformed and unknown records are skipped');
  ok(weeklyHandled(null, { now: NOW }).total === 0, 'no records → zero, never throws');
}

console.log('\nthe sentence');
{
  const s = formatWeekly(weeklyHandled([R('proceed', 1), R('proceed', 2), R('decline', 3), R('escalate', 1), R('insufficient_signal', 1)], { now: NOW }));
  ok(s === 'This week Phaedo handled 3 decisions without interrupting you (2 went ahead, 1 stopped) and brought 1 to you. One more was too unclear to call.', s);
  ok(formatWeekly(weeklyHandled([R('proceed', 1)], { now: NOW })) === 'This week Phaedo handled 1 decision without interrupting you (1 went ahead).', 'singular');
  ok(formatWeekly(weeklyHandled([R('escalate', 1)], { now: NOW })) === 'This week Phaedo handled no decisions on its own and brought 1 to you.', 'only escalations');
  ok(formatWeekly(weeklyHandled([], { now: NOW })) === 'No decisions came to Phaedo this week yet.', 'nothing yet');
}

console.log('\nit rides the receipts digest to the phone');
{
  const pairKey = crypto.getRandomValues(new Uint8Array(32));
  const b64u = b64uEnc(pairKey);
  const list = [R('proceed', 1), R('decline', 2), R('escalate', 1)];
  const { envelope } = await buildReceiptsDeposit(b64u, list, { now: () => new Date(NOW).toISOString() });
  const key = await Kdf.deriveFpSyncKey(new Uint8Array(pairKey));
  const inner = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(envelope, key)));
  ok(inner.data.week && inner.data.week.handled === 2 && inner.data.week.came_to_you === 1, 'the digest carries the week\'s counts');
  ok(inner.data.week.summary === formatWeekly(weeklyHandled(list, { now: NOW })), 'and the same sentence /phaedo:status prints');
}

console.log(`\n✓ weekly: ${pass} checks passed`);
