// Situational precedent, Phase 2 (precedent.js, proposal 0009): the banded shape, minimum
// support, the batch and pre-flight rails, and that nothing unbanded ever comes out.
//
//   node mcp/test-precedent.mjs

import assert from 'node:assert';
import {
  shapeOf, shapeKey, projectShape, batchMarkedIds, precedentFor, divergenceEpisodes,
  precedentTable, formatTable, SHAPE_FIELDS, MIN_SUPPORT, PREFLIGHT_VIA,
} from './precedent.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const NOW = Date.parse('2026-10-27T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (days, ms = 0) => new Date(NOW - days * DAY + ms).toISOString();

let n = 0;
// A ship-hook merge receipt by default; override anything.
function R({ days = 1, signal = 'proceed', action = 'approved', markedAt, summary = 'merge PR #12',
  domain = 'engineering', reversible = true, magnitude = 'medium', amount = null, stakes = 'normal',
  amountBand, tool = 'Bash', via = 'phaedo_consult' } = {}) {
  const drivers = [];
  if (stakes) drivers.push({ cue: 'diffStakes', value: stakes, confidence: null, basis: 'observed' });
  if (amountBand) drivers.push({ cue: 'amountBand', value: amountBand, confidence: 1, basis: 'self_reported' });
  return {
    receipt_id: `r${++n}`, created_at: at(days), via,
    request: {
      action_descriptor: { domain, reversible, magnitude, amount, summary },
      ...(tool ? { action_binding: { tool_name: tool, arguments_hash: 'h', arguments_preview: 'gh pr merge 12 --squash' } } : {}),
    },
    response: { signal }, drivers, user_action: action,
    ...(markedAt !== undefined ? { user_action_at: markedAt } : {}),
  };
}

console.log('\nthe shape — banded features only');
{
  const s = shapeOf(R());
  ok(JSON.stringify(Object.keys(s)) === JSON.stringify(SHAPE_FIELDS), 'every field, in order');
  ok(s.domain === 'engineering' && s.kind === 'merge' && s.reversible === true && s.magnitude === 'medium', 'descriptor fields');
  ok(s.size === 'normal' && s.touched === 'ordinary' && s.binding === 'shell' && s.amount_band === 'none', 'stakes, binding, no amount');
  ok(shapeOf(R({ stakes: 'large+sensitive' })).size === 'large' && shapeOf(R({ stakes: 'large+sensitive' })).touched === 'sensitive', 'large + sensitive');
  ok(shapeOf(R({ stakes: 'sensitive' })).size === 'normal', 'sensitive alone is not large');
  ok(shapeOf(R({ stakes: 'unknown' })).size === null && shapeOf(R({ stakes: null })).touched === null, 'GitHub not read → null, not a guess');
  ok(shapeOf(R({ tool: 'mcp__slack__post_message' })).binding === 'connected_app', 'MCP tool → connected app');
  ok(shapeOf(R({ tool: 'Edit' })).binding === 'agent_tool' && shapeOf(R({ tool: null })).binding === 'none', 'other tool / no binding');
  ok(shapeOf(R({ amount: 40 })).amount_band === 'low', 'an amount below the edges is low');
  ok(shapeOf(R({ amount: 400, amountBand: 'medium' })).amount_band === 'medium' && shapeOf(R({ amount: 4000, amountBand: 'high' })).amount_band === 'high', 'the recorded band');
  ok(shapeOf(R({ amount: 0 })).amount_band === 'none' && shapeOf(R({ amount: -5 })).amount_band === 'none', 'no positive amount → none');
  ok(shapeOf(R({ domain: 'Procurement' })).domain === 'shopping', 'synonyms fold to the §10.2 term');
  ok(shapeOf(R({ domain: '  ' })).domain === '(none)', 'blank domain');
  ok(shapeOf(R({ magnitude: 'huge', reversible: 'yes' })).magnitude === null && shapeOf(R({ reversible: 'yes' })).reversible === null, 'off-vocabulary → null');
  ok(shapeOf(R({ summary: 'send or post a message (slack)' })).kind === 'message' && shapeOf(R({ summary: 'buy a lamp' })).kind === 'other', 'kind is a closed vocabulary');
  const leak = JSON.stringify(shapeOf(R({ summary: 'merge PR #12 to Acme Corp', amount: 1234.56, amountBand: 'high' })));
  ok(!/Acme|1234|#12|gh pr|r\d/.test(leak), 'no summary, exact amount, preview or id in the shape');
  ok(shapeOf(null).domain === '(none)' && shapeOf({}).binding === 'none' && shapeOf({ drivers: 'x' }).size === null, 'garbage never throws');
}

console.log('\nthe key');
{
  ok(shapeKey(shapeOf(R())) === shapeKey(shapeOf(R({ days: 9 }))), 'same situation, same key');
  ok(shapeKey(shapeOf(R())) !== shapeKey(shapeOf(R({ stakes: 'large' }))), 'a different size, a different key');
  ok(shapeKey(shapeOf(R()), ['domain', 'kind']) === shapeKey(shapeOf(R({ stakes: 'large' })), ['domain', 'kind']), 'a coarser key merges them');
  ok(JSON.stringify(projectShape(shapeOf(R()), ['kind', 'domain'])) === '{"kind":"merge","domain":"engineering"}', 'projection keeps only the fields asked for');
}

console.log('\nminimum support — null, never a guess');
{
  const four = Array.from({ length: MIN_SUPPORT - 1 }, (_, i) => R({ days: i + 1 }));
  ok(precedentFor(four, shapeOf(R()), { now: NOW }) === null, `${MIN_SUPPORT - 1} observations → null`);
  const p = precedentFor([...four, R({ days: 6, action: 'modified' })], shapeOf(R()), { now: NOW });
  ok(p && p.observed === 5, `${MIN_SUPPORT} → an answer`);
  ok(p.user_actions.approved === 4 && p.user_actions.modified === 1 && p.user_actions.rejected === 0, 'what the subject did');
  ok(p.oracle_agreement === 0.8, 'proceed ↔ approved agrees; modified does not');
  ok(p.most_recent_divergence_days_ago === 6 && p.window_days === 180, 'when the oracle last missed');
  ok(p.preflight.observed === 0 && typeof p.shape_revision === 'string', 'pre-flight apart; the shape revision recorded');
  const wire = JSON.stringify(p);
  ok(!/summary|merge PR|receipt_id|arguments|"amount"/.test(wire), 'nothing unbanded crosses (rail 1)');
  ok(precedentFor([...four, R({ days: 6 })], shapeOf(R()), { now: NOW, minSupport: 6 }) === null, 'N is a parameter');
}

console.log('\nwhat counts as evidence');
{
  const base = Array.from({ length: 5 }, (_, i) => R({ days: i + 1 }));
  ok(precedentFor([...base.slice(0, 4), R({ days: 200 })], shapeOf(R()), { now: NOW }) === null, 'outside the window does not count');
  ok(precedentFor([...base.slice(0, 4), R({ days: -1 })], shapeOf(R()), { now: NOW }) === null, 'the future does not count');
  ok(precedentFor([...base.slice(0, 4), R({ action: null }), R({ action: 'unknown' })], shapeOf(R()), { now: NOW }) === null, 'unmarked outcomes do not count');
  ok(precedentFor([...base.slice(0, 4), R({ stakes: 'large' })], shapeOf(R()), { now: NOW }) === null, 'another shape does not count');
  ok(precedentFor([...base.slice(0, 4), R({ stakes: 'large' })], shapeOf(R()), { now: NOW, fields: ['domain', 'kind'] }).observed === 5, '…unless the key is coarser');
  const divergent = precedentFor([...base.slice(0, 4), R({ signal: 'escalate', action: 'rejected' })], shapeOf(R()), { now: NOW });
  ok(divergent.oracle_agreement === 1 && divergent.user_actions.rejected === 1, 'a non-decisive call counts as observed but is not scored');
}

console.log('\nrail 3 — marks made in a burst are bookkeeping');
{
  const burst = [0, 10_000, 20_000].map((ms) => R({ markedAt: at(0, ms) }));
  const pair = [R({ markedAt: at(2) }), R({ markedAt: at(2, 30_000) })];
  const ids = batchMarkedIds([...burst, ...pair, R({ markedAt: at(4) }), R()]);
  ok(ids.size === 3 && burst.every((r) => ids.has(r.receipt_id)), 'three marks inside a minute are a burst');
  ok(!pair.some((r) => ids.has(r.receipt_id)), 'two quick marks are not');
  const p = precedentFor([...burst, ...pair, R({ days: 3 }), R({ days: 4 })], shapeOf(R()), { now: NOW });
  ok(p === null, 'the burst is left out, so support falls short');
  const t = precedentTable([...burst, ...pair], { now: NOW });
  ok(t.excluded_batch === 3 && t.usable === 2, 'the table says how many were left out');
  ok(batchMarkedIds([{ user_action_at: 'x' }, null]).size === 0, 'no mark times → no burst');
}

console.log('\nrail 5 — pre-flight receipts are counted apart');
{
  const pre = Array.from({ length: 6 }, (_, i) => R({ days: i + 1, via: PREFLIGHT_VIA }));
  ok(precedentFor(pre, shapeOf(R()), { now: NOW }) === null, 'pre-flight alone never reaches support');
  const p = precedentFor([...pre.slice(0, 2), ...Array.from({ length: 5 }, (_, i) => R({ days: i + 1 }))], shapeOf(R()), { now: NOW });
  ok(p.observed === 5 && p.preflight.observed === 2 && p.preflight.user_actions.approved === 2, 'and never mixed into observed');
  ok(precedentTable(pre, { now: NOW }).shapes.length === 0, 'the table leaves them out too');
}

console.log('\nthe divergence episodes — the only thing worth keeping');
{
  const list = [R({ days: 1 }), R({ days: 2, action: 'rejected' }), R({ days: 5, signal: 'decline', action: 'approved', stakes: 'large' }),
    R({ days: 3, signal: 'escalate', action: 'rejected' }), R({ days: 4, signal: 'decline', action: 'rejected' })];
  const e = divergenceEpisodes(list, { now: NOW });
  ok(e.length === 2, 'agreements and non-decisive calls are not episodes');
  ok(e[0].days_ago === 2 && e[0].predicted === 'proceed' && e[0].user_action === 'rejected', 'newest first');
  ok(e[1].shape.size === 'large' && e[1].predicted === 'decline', 'each carries its banded shape');
  ok(!/merge PR|r\d|gh pr/.test(JSON.stringify(e)), 'and nothing unbanded');
}

console.log('\nthe readout');
{
  const list = [...Array.from({ length: 5 }, (_, i) => R({ days: i + 1 })), R({ days: 2, stakes: 'large', action: 'rejected' })];
  const t = precedentTable(list, { now: NOW });
  ok(t.shapes.length === 2 && t.shapes[0].observed === 5 && t.shapes[0].supported && !t.shapes[1].supported, 'shapes by support, flagged at N');
  const s = formatTable(t);
  ok(s.includes('✓ 5× domain=engineering kind=merge') && s.includes('· 1×') && s.includes('size=large'), s);
  ok(!s.includes('amount_band=none') && !s.includes('merge PR'), 'quiet fields hidden; no summaries');
  ok(formatTable(precedentTable(null, { now: NOW })).includes('No marked decisions yet'), 'empty store');
}

console.log(`\n✓ precedent: ${pass} checks passed`);
