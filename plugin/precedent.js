#!/usr/bin/env node
// Phaedo — situational precedent, Phase 2 (proposal 0009, design doc §9 / G8 B4).
//
// A §10 consultation answers dispositionally ("this subject favors caution"). An agent can act
// on a precedent: "you have faced this shape 6 times; approved 5, edited 1." This module is the
// derived view that would say so — over the §10.6 receipt store, never a stored artifact.
//
// PURE: (receipts, opts) -> report. No I/O, `now` injected — the agreement.js discipline.
// NOT WIRED into consult: 0009 is a draft, and its rail 4 says precedent informs and never
// authorizes. Dev-only readout: `npm run precedent`.
//
// The SHAPE is the situation key — banded features only, a closed vocabulary per field, so
// nothing a receipt holds on-device (summary, exact amount, counterparty, ids, previews) can
// leave through it (0009 rail 1):
//
//   domain       canonical §10.2 term when there is one, else the normalized free-text domain
//   kind         merge | deploy | push to main | publish | message | payment | … | other
//   reversible   true | false | null
//   magnitude    low | medium | high | null            (as the agent described it)
//   amount_band  none | low | medium | high            (against the subject's own edges, G8 B1)
//   size         normal | large | null                 (the diff, when GitHub was read)
//   touched      ordinary | sensitive | null           (the paths, when GitHub was read)
//   binding      shell | connected_app | agent_tool | none   (what would carry the action out)
//
// Rails enforced here (0009 "Rails proposed for normative status"):
//   1. banded features only — shapeOf() reads nothing else into the key;
//   2. minimum support — below MIN_SUPPORT observations the answer is null, never a guess;
//   3. subject-authored outcomes only — a burst of marks (BATCH_MIN within BATCH_WINDOW_MS)
//      is bookkeeping, not consent, and is excluded (the §10.7 batch gate, per receipt);
//   5. pre-flight receipts (via phaedo_check_authorization) are counted apart, never mixed in.
// Rails 4 and 6 are about use, not computation: nothing here produces a signal.

import { actionKind } from './ship-readout.js';
import { canonicalDomain, normalizeDomain } from './lib/domain.js';
import { DECISIVE } from './agreement.js';
import { BATCH_WINDOW_MS } from './autonomy-promotion.js';
import { isMainModule } from './lib/is-main.js';

export const SHAPE_REVISION = '2026-10-27.v0';
export const SHAPE_FIELDS = Object.freeze(['domain', 'kind', 'reversible', 'magnitude', 'amount_band', 'size', 'touched', 'binding']);
export const DEFAULT_WINDOW_DAYS = 180;
export const MIN_SUPPORT = 5;
export const BATCH_MIN = 3;                 // this many marks inside BATCH_WINDOW_MS = a burst
export const PREFLIGHT_VIA = 'phaedo_check_authorization';

const DAY = 24 * 60 * 60 * 1000;
const OUTCOMES = new Set(['approved', 'rejected', 'modified']);
const MAGNITUDES = new Set(['low', 'medium', 'high']);

const driver = (r, cue) => (Array.isArray(r?.drivers) ? r.drivers.find((d) => d && d.cue === cue) : null)?.value ?? null;

function domainOf(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '(none)';
  return canonicalDomain(raw) || normalizeDomain(raw) || '(none)';
}

function amountBandOf(r) {
  const a = r?.request?.action_descriptor?.amount;
  if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0) return 'none';
  // consult-core only writes amountBand when the amount raised the stakes; a positive
  // amount without one sat below the subject's low edge.
  const b = driver(r, 'amountBand');
  return b === 'medium' || b === 'high' ? b : 'low';
}

function bindingOf(r) {
  const t = r?.request?.action_binding?.tool_name;
  if (typeof t !== 'string' || !t) return 'none';
  if (t === 'Bash') return 'shell';
  if (t.startsWith('mcp__')) return 'connected_app';
  return 'agent_tool';
}

/** The situation a receipt was about, as banded features. Never throws. */
export function shapeOf(r) {
  const ad = r?.request?.action_descriptor || {};
  const stakes = driver(r, 'diffStakes');        // normal | large | sensitive | large+sensitive | unknown
  const read = typeof stakes === 'string' && stakes !== 'unknown';
  return {
    domain: domainOf(ad.domain),
    kind: actionKind(ad.summary),
    reversible: typeof ad.reversible === 'boolean' ? ad.reversible : null,
    magnitude: MAGNITUDES.has(ad.magnitude) ? ad.magnitude : null,
    amount_band: amountBandOf(r),
    size: read ? (stakes.includes('large') ? 'large' : 'normal') : null,
    touched: read ? (stakes.includes('sensitive') ? 'sensitive' : 'ordinary') : null,
    binding: bindingOf(r),
  };
}

/** A stable string for a shape over `fields` (a coarser key = fewer fields). */
export function shapeKey(shape, fields = SHAPE_FIELDS) {
  return fields.map((f) => `${f}=${shape?.[f] ?? 'null'}`).join('|');
}

/** Only the requested fields of a shape — what may cross the boundary. */
export function projectShape(shape, fields = SHAPE_FIELDS) {
  return Object.fromEntries(fields.map((f) => [f, shape?.[f] ?? null]));
}

/**
 * Receipt ids whose outcome was marked in a burst: BATCH_MIN or more marks inside one
 * windowMs span. Receipts without a mark time are never batch (absence of evidence).
 */
export function batchMarkedIds(receipts, { windowMs = BATCH_WINDOW_MS, batchMin = BATCH_MIN } = {}) {
  const marked = (Array.isArray(receipts) ? receipts : [])
    .map((r) => ({ id: r?.receipt_id, t: Date.parse(r?.user_action_at) }))
    .filter((x) => x.id && Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const out = new Set();
  let i = 0;
  for (let j = 0; j < marked.length; j++) {
    while (marked[j].t - marked[i].t > windowMs) i++;
    if (j - i + 1 >= batchMin) for (let k = i; k <= j; k++) out.add(marked[k].id);
  }
  return out;
}

function agrees(signal, action) {
  if (action === 'approved') return signal === 'proceed' || signal === 'proceed_with_note';
  if (action === 'rejected') return signal === 'decline';
  return false;   // modified: not accepted as-judged (agreement.js v0, conservative)
}

// The receipts that may count as evidence at all: in the window, subject-marked, not in a burst.
function evidence(receipts, { now, windowDays, windowMs, batchMin }) {
  const since = now - windowDays * DAY;
  const list = Array.isArray(receipts) ? receipts : [];
  const batch = batchMarkedIds(list, { windowMs, batchMin });
  const out = { usable: [], excluded_batch: 0 };
  for (const r of list) {
    const t = Date.parse(r?.created_at);
    if (!Number.isFinite(t) || t < since || t > now) continue;
    if (!OUTCOMES.has(r?.user_action)) continue;
    if (batch.has(r.receipt_id)) { out.excluded_batch++; continue; }
    out.usable.push({ r, t });
  }
  return out;
}

function tally(items, now) {
  const user_actions = { approved: 0, rejected: 0, modified: 0 };
  let scored = 0, agreed = 0, lastDivergence = null;
  for (const { r, t } of items) {
    user_actions[r.user_action]++;
    const signal = r?.response?.signal;
    if (!DECISIVE.includes(signal)) continue;
    scored++;
    if (agrees(signal, r.user_action)) agreed++;
    else if (lastDivergence === null || t > lastDivergence) lastDivergence = t;
  }
  return {
    observed: items.length,
    user_actions,
    oracle_agreement: scored ? Math.round((agreed / scored) * 100) / 100 : null,
    most_recent_divergence_days_ago: lastDivergence === null ? null : Math.floor((now - lastDivergence) / DAY),
  };
}

/**
 * The precedent for one situation, or null below minimum support (rail 2 — never a guess).
 * `shape` may be a receipt's shapeOf() or any object with the SHAPE_FIELDS; `fields` picks
 * how coarse the match is. The result carries banded features and counts only (rail 1).
 */
export function precedentFor(receipts, shape, {
  now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, minSupport = MIN_SUPPORT,
  fields = SHAPE_FIELDS, windowMs = BATCH_WINDOW_MS, batchMin = BATCH_MIN,
} = {}) {
  const want = shapeKey(shape, fields);
  const { usable } = evidence(receipts, { now, windowDays, windowMs, batchMin });
  const match = usable.filter(({ r }) => shapeKey(shapeOf(r), fields) === want);
  const main = match.filter(({ r }) => r.via !== PREFLIGHT_VIA);
  if (main.length < minSupport) return null;
  const pre = match.filter(({ r }) => r.via === PREFLIGHT_VIA);
  const { observed, user_actions, oracle_agreement, most_recent_divergence_days_ago } = tally(main, now);
  return {
    shape: projectShape(shape, fields),
    shape_revision: SHAPE_REVISION,
    observed,
    user_actions,
    oracle_agreement,
    window_days: windowDays,
    most_recent_divergence_days_ago,
    preflight: { observed: pre.length, user_actions: tally(pre, now).user_actions },
  };
}

/**
 * The divergence episodes — the only thing 0009's principle says is worth keeping: receipts
 * where a decisive prediction did not match what the subject did. Banded, newest first.
 */
export function divergenceEpisodes(receipts, {
  now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, fields = SHAPE_FIELDS,
  windowMs = BATCH_WINDOW_MS, batchMin = BATCH_MIN,
} = {}) {
  const { usable } = evidence(receipts, { now, windowDays, windowMs, batchMin });
  return usable
    .filter(({ r }) => DECISIVE.includes(r?.response?.signal) && !agrees(r.response.signal, r.user_action))
    .sort((a, b) => b.t - a.t)
    .map(({ r, t }) => ({
      shape: projectShape(shapeOf(r), fields),
      predicted: r.response.signal,
      user_action: r.user_action,
      days_ago: Math.floor((now - t) / DAY),
      preflight: r.via === PREFLIGHT_VIA,
    }));
}

/**
 * Every shape seen in the window with its support — the readout's table, and the data for
 * choosing N, the window and the coarseness of the key (0009 "Open").
 */
export function precedentTable(receipts, {
  now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, minSupport = MIN_SUPPORT,
  fields = SHAPE_FIELDS, windowMs = BATCH_WINDOW_MS, batchMin = BATCH_MIN,
} = {}) {
  const { usable, excluded_batch } = evidence(receipts, { now, windowDays, windowMs, batchMin });
  const groups = new Map();
  for (const item of usable) {
    if (item.r.via === PREFLIGHT_VIA) continue;
    const s = shapeOf(item.r);
    const k = shapeKey(s, fields);
    if (!groups.has(k)) groups.set(k, { shape: projectShape(s, fields), items: [] });
    groups.get(k).items.push(item);
  }
  const shapes = [...groups.values()]
    .map(({ shape, items }) => ({ shape, ...tally(items, now), supported: items.length >= minSupport }))
    .sort((a, b) => b.observed - a.observed);
  return {
    window_days: windowDays,
    min_support: minSupport,
    fields: [...fields],
    usable: usable.length,
    excluded_batch,
    shapes,
  };
}

const show = (shape) => Object.entries(shape).filter(([, v]) => v !== null && v !== 'none' && v !== '(none)').map(([k, v]) => `${k}=${v}`).join(' ');

export function formatTable(t) {
  const lines = [
    `Precedent — last ${t.window_days} days, ${t.usable} marked decision(s) usable` +
      (t.excluded_batch ? `, ${t.excluded_batch} left out as marked in a burst` : '') + '.',
    `Key: ${t.fields.join(' × ')}. A shape needs ${t.min_support} to answer.`,
  ];
  if (!t.shapes.length) lines.push('  No marked decisions yet — nothing to show.');
  for (const s of t.shapes) {
    const a = s.user_actions;
    const agree = s.oracle_agreement === null ? 'no decisive calls' : `matched ${Math.round(s.oracle_agreement * 100)}%`;
    const div = s.most_recent_divergence_days_ago === null ? '' : `, last miss ${s.most_recent_divergence_days_ago}d ago`;
    lines.push(`  ${s.supported ? '✓' : '·'} ${s.observed}× ${show(s.shape)} — yes ${a.approved}, no ${a.rejected}, edited ${a.modified}; ${agree}${div}`);
  }
  return lines.join('\n');
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const num = (flag, d) => { const i = args.indexOf(flag); const n = i >= 0 ? Number(args[i + 1]) : NaN; return Number.isFinite(n) && n > 0 ? n : d; };
  const fi = args.indexOf('--fields');
  const fields = fi >= 0 ? String(args[fi + 1] || '').split(',').filter((f) => SHAPE_FIELDS.includes(f)) : SHAPE_FIELDS;
  const { readReceipts } = await import('./receipts.js');
  const { defaultStateDir } = await import('./cache.js');
  const receipts = await readReceipts(defaultStateDir()).catch(() => []);
  const t = precedentTable(receipts, { windowDays: num('--days', DEFAULT_WINDOW_DAYS), minSupport: num('--min', MIN_SUPPORT), fields: fields.length ? fields : SHAPE_FIELDS });
  process.stdout.write(formatTable(t) + '\n');
}
