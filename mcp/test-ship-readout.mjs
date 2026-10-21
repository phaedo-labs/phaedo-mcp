#!/usr/bin/env node
// Ship-hook readout (ship-readout.js): counts only the hook's own receipts, inside the
// window, and says plainly when there is nothing to score. Pinned clock.
// Run: node test-ship-readout.mjs   (from mcp/)

import assert from 'assert';
import { shipReadout, formatReadout, actionKind } from './ship-readout.js';
import { classifyShipCommand } from './ship-actions.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const NOW = Date.parse('2026-11-01T12:00:00Z');
const ago = (d) => new Date(NOW - d * 24 * 3600e3).toISOString();
const r = (cmd, signal, user_action, days, agent_id = 'claude-code/ship-hook') => ({
  receipt_id: `r-${Math.random()}`, created_at: ago(days), via: 'phaedo_consult', agent_id,
  request: { consultation_type: 'action_approval', action_descriptor: classifyShipCommand(cmd).action_descriptor },
  response: { signal, confidence: 0.44, deference_level: 'medium' }, user_action,
});

// The kinds come from the summaries ship-actions.js actually writes.
for (const [cmd, kind] of [['gh pr merge 3', 'merge'], ['gh pr merge 3 --admin', 'merge'], ['fly deploy', 'deploy'],
  ['eas build -p ios', 'phone build'], ['eas submit -p ios', 'phone submit'], ['git push origin main', 'push to main'],
  ['git push -f origin main', 'push to main']]) {
  ok(actionKind(classifyShipCommand(cmd).summary) === kind, `kind: ${cmd} → ${kind}`);
}
ok(actionKind('something else') === 'other' && actionKind(null) === 'other', 'unknown summary → other');

const receipts = [
  r('gh pr merge 1', 'proceed_with_note', 'approved', 20),
  r('gh pr merge 2', 'proceed_with_note', null, 10),
  r('gh pr merge 3', 'proceed', 'rejected', 5),
  r('fly deploy', 'escalate', 'approved', 3),
  r('eas build -p ios', 'insufficient_signal', null, 2),
  r('fly deploy', 'escalate', null, 45),                                   // outside 30d
  r('gh pr merge 9', 'proceed', 'approved', 1, 'some-other-agent'),        // not the hook's
];
const o = shipReadout(receipts, { now: NOW });
ok(o.total_ever === 6 && o.consults === 5, 'only hook receipts; window applied');
ok(o.kinds.merge === 3 && o.kinds.deploy === 1 && o.kinds['phone build'] === 1, 'kinds counted');
ok(o.answers.go_ahead === 3 && o.answers.flagged === 1 && o.answers.unsure === 1, 'answers bucketed');
ok(o.outcomes.approved === 2 && o.outcomes.rejected === 1 && o.outcomes.unmarked === 2, 'outcomes counted');
ok(o.agreement.scored === 2 && o.agreement.agreements === 1 && o.agreement.rate === 0.5, "agreement is the hook's own: 2 scored, 1 match");
ok(o.newest.summary === 'phone build (ios)' && o.newest.user_action === null, 'newest in window');

const text = formatReadout(o);
ok(/5 consults: 3 merges, 1 deploy, 1 phone build/.test(text), 'plain summary line');
ok(/matched you on 1 of 2/.test(text), 'agreement in words');
ok(!/0\.\d|confidence|signal|receipt/i.test(text), 'no numbers-as-decimals or protocol terms');
ok(/Newest: .* → Phaedo: didn't know$/m.test(text), 'newest line says what Phaedo said in words');
ok(/2 pushes to main/.test(formatReadout(shipReadout([r('git push origin main', 'proceed', null, 1), r('git push origin main', 'proceed', null, 1)], { now: NOW }))), 'pushes to main pluralised');
ok(/: 1 deploy$/m.test(formatReadout(shipReadout([r('fly deploy', 'escalate', null, 1)], { now: NOW }))), 'singular kind');

// Empty and out-of-window cases say what to do.
ok(/No consults yet\. Is the hook installed\?/.test(formatReadout(shipReadout([], { now: NOW }))), 'empty → install hint');
ok(/Nothing in this window \(1 consult before it\)/.test(formatReadout(shipReadout([r('fly deploy', 'escalate', null, 45)], { now: NOW }))), 'out of window → widen hint');
ok(/Nothing to score yet/.test(formatReadout(shipReadout([r('fly deploy', 'escalate', 'approved', 1)], { now: NOW }))), 'only flagged → nothing to score');
ok(shipReadout(null, { now: NOW }).consults === 0, 'null receipts tolerated');
ok(shipReadout(receipts, { now: NOW, windowDays: 60 }).consults === 6, '--days widens the window');

console.log(`✓ test-ship-readout: ${pass} checks passed`);
