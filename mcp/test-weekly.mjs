// "This week Phaedo handled N decisions for you" (weekly.js), and its trip to the phone.
//
//   node mcp/test-weekly.mjs

import assert from 'node:assert';
import { weeklyHandled, formatWeekly, answeredByRule, standingRuleDriver, RULE_CUES, WEEK_DAYS } from './weekly.js';
import { buildReceiptsDeposit } from './receipts-sync.js';
import { resolveConsultation, checkAuthorization } from './consult.js';
import { classifyToolCall } from './ship-actions.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';

const { Kdf, Envelope } = Phaedo;
const HERE = dirname(fileURLToPath(import.meta.url));

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

console.log('\nwhat your standing rule decided');
{
  const D = (cue, value) => ({ cue, value, confidence: null, basis: 'observed' });
  const byRule = (signal, days, d) => ({ ...R(signal, days), receipt_id: `rule-${signal}-${days}-${d.cue}`, drivers: [d] });
  const list = [
    byRule('proceed', 1, D('standingRule', 'answered')),        // server: an authorization said go ahead
    byRule('proceed', 2, D('standingGrant', 'answered')),       // ship hook: answered Claude Code's prompt
    byRule('proceed', 2, D('standingGrant', 'held:stale')),     // held back → not the rule's doing
    byRule('escalate', 1, D('standingRule', 'answered')),       // never counted outside "went ahead"
    byRule('proceed', 9, D('standingRule', 'answered')),        // last week
    { ...R('proceed', 1), receipt_id: 'r-junk', drivers: 'nope' },
    R('proceed', 3), R('decline', 3),
  ];
  const w = weeklyHandled(list, { now: NOW });
  ok(w.by_rule === 2, `standingRule/standingGrant 'answered' count; held, escalated and old ones do not (${w.by_rule})`);
  ok(w.went_ahead === 5 && w.handled === 6, 'the rule count is part of went ahead, not a separate bucket');
  ok(answeredByRule(list[0]) && answeredByRule(list[1]) && !answeredByRule(list[2]) && !answeredByRule(list[5]) && !answeredByRule(null), 'answeredByRule');
  ok(RULE_CUES.has('standingRule') && RULE_CUES.has('standingGrant') && RULE_CUES.size === 2, 'the two cues');
  const s = formatWeekly(w);
  ok(s === 'This week Phaedo handled 6 decisions without interrupting you (5 went ahead, 1 stopped) and brought 1 to you. Your standing rule decided 2 of them.', s);
  ok(formatWeekly({ ...w, by_rule: 1 }).endsWith('Your standing rule decided one of them.'), 'one of them');
  const one = weeklyHandled([list[0]], { now: NOW });
  ok(formatWeekly(one) === 'This week Phaedo handled 1 decision without interrupting you (1 went ahead). Your standing rule decided it.', formatWeekly(one));
  const withUnsure = formatWeekly(weeklyHandled([list[0], R('insufficient_signal', 1)], { now: NOW }));
  ok(withUnsure.endsWith('Your standing rule decided it. One more was too unclear to call.'), 'the rule line comes before the unclear one');
  ok(!formatWeekly(weeklyHandled([R('proceed', 1)], { now: NOW })).includes('rule'), 'no rule line when no rule decided anything');
  // The phone shows at most 240 characters of the sentence (mobile receiptsSync.ts parseWeek).
  const big = { days: 7, went_ahead: 999, by_rule: 998, stopped: 999, came_to_you: 999, unsure: 999, handled: 1998, total: 3996 };
  ok(formatWeekly(big).length <= 240, `fits the phone even with large counts (${formatWeekly(big).length})`);
}

console.log('\nthe server marks what a rule decided');
{
  const DAY = 24 * 60 * 60 * 1000;
  const vd = JSON.parse(readFileSync(join(HERE, 'sample-fingerprint.json'), 'utf8'));
  const rule = { instruction_id: 'auth-eng', kind: 'authorization', effect: 'autoproceed', require_binding: true,
    match: { domains: ['engineering'], reversible: true, magnitude_max: 'medium' },
    expires_at: new Date(Date.now() + 30 * DAY).toISOString() };
  const ruled = { ...vd, phaedo_fingerprint: { ...vd.phaedo_fingerprint, standing_rules: [...(vd.phaedo_fingerprint.standing_rules || []), rule] } };
  const ship = classifyToolCall('Bash', { command: 'gh pr merge 5 --squash' });
  const req = { consultation_type: 'action_approval', action_descriptor: ship.action_descriptor, action_binding: ship.action_binding };
  const raw = await resolveConsultation(ruled, req, {});
  const d = standingRuleDriver(checkAuthorization(ruled, req, {}), raw);
  ok(raw.signal === 'proceed' && d.length === 1 && d[0].cue === 'standingRule' && d[0].value === 'answered', 'a merge your rule covers is marked');
  ok(answeredByRule({ drivers: d }), 'in the shape the weekly count reads');
  ok(standingRuleDriver(checkAuthorization(vd, req, {}), raw).length === 0, 'no rule → no mark, even when the answer is go ahead');
  ok(standingRuleDriver(checkAuthorization(ruled, req, {}), { ...raw, signal: 'escalate', stale_downgrade: true }).length === 0, 'withheld by the stale guard → no mark (it came to you)');
  ok(standingRuleDriver({ authorization_matched: true, signal: 'decline' }, { signal: 'decline' }).length === 0, 'a rule that says no is "stopped", not this');
  ok(standingRuleDriver(null, null).length === 0, 'nothing in → nothing out');
  // Wiring: all three tools put the mark FIRST on the receipt they write.
  const src = readFileSync(join(HERE, 'server.js'), 'utf8');
  ok(/drivers = \[\.\.\.ruleAnsweredDriver\(vd, args \|\| \{\}, response\), \.\.\.drivers\];\s*const receiptId = await emitReceipt\('phaedo_consult'/.test(src), 'phaedo_consult marks it');
  ok(/emitReceipt\('phaedo_check_authorization'[^;]*ruleAnsweredDriver\(vd, req, response\)\)/.test(src), 'phaedo_check_authorization marks it');
  ok(/drivers = \[\.\.\.ruleAnsweredDriver\(vd, req, response\), \.\.\.drivers\];\s*const escReceiptId = await emitReceipt\('phaedo_escalate'/.test(src), 'phaedo_escalate marks it');
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
  const ruled = [{ ...R('proceed', 1), drivers: [{ cue: 'standingRule', value: 'answered' }] }];
  const d2 = await buildReceiptsDeposit(b64u, ruled, { now: () => new Date(NOW).toISOString() });
  const inner2 = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(d2.envelope, await Kdf.deriveFpSyncKey(new Uint8Array(pairKey)))));
  ok(inner2.data.week.by_rule === 1 && inner2.data.week.summary.endsWith('Your standing rule decided it.'), 'the rule count reaches the phone in the sentence it already shows');
  ok(!JSON.stringify(inner2.data.receipts).includes('drivers'), 'the drivers themselves still never leave this computer');
}

console.log(`\n✓ weekly: ${pass} checks passed`);
