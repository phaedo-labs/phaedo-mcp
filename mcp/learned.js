#!/usr/bin/env node
// Phaedo — "here's what I learned about you: keep it or remove it."
//
// Everything Phaedo inferred from how the subject works (evidence_basis `observed` — not what
// they said in the interview, not their rules) as one plain sentence each, from the shared
// phrasebook (vendor/trait-phrases.js). Remove one and it stops shaping answers and decisions on
// this computer: the forget list is applied every time the profile loads (fingerprint-source.js),
// so a trait the sessions keep showing stays forgotten. Keep one and it isn't asked about again.
//
//   npm run learned                 # what Phaedo learned, numbered; new ones marked
//   npm run learned -- --remove 3,5
//   npm run learned -- --keep 1,2   # or --keep all
//   npm run learned -- --forgotten  # what you removed
//   npm run learned -- --restore 2  # (number from --forgotten)
//
// The list file holds a field name and a digest of the value per item — never the text.
// PURE functions above the CLI; `now` and the state are passed in.

import { createHash } from 'crypto';
import { join } from 'path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import './vendor/trait-phrases.js';               // UMD → globalThis.PhaedoTraitPhrases
import { isMainModule } from './lib/is-main.js';

const T = globalThis.PhaedoTraitPhrases;
export const STATE_FILE = 'learned.json';
export const SHOW_CHARS = 160;

const canon = (field, value) => {
  try { return T.canonical(field, value); } catch { return value; }
};

/** A stable key for a (field, value): the field in the clear, the value only as a digest. */
export function itemKey(field, value) {
  const v = JSON.stringify(canon(field, value) ?? null);
  return `${field}#${createHash('sha256').update(v).digest('hex').slice(0, 12)}`;
}

function sentence(field, value) {
  let s;
  try { s = T.phrase(field, value); } catch { s = ''; }
  return String(s || `${String(field).replace(/_/g, ' ')}: ${JSON.stringify(value)}`).trim();
}

/** Shorten a long list sentence for the screen: "Terms I use: a, b, c … (+40 more)." */
export function shorten(text, max = SHOW_CHARS) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(', ');
  const shown = at > max / 2 ? cut.slice(0, at) : cut.trimEnd();
  const more = (text.slice(shown.length).match(/, /g) || []).length;
  return `${shown}${more ? ` … (+${more} more)` : ' …'}`;
}

/**
 * What Phaedo learned, merged by choice: [{ key, keys, field, layer, text, times, contradicts }].
 * Values that are the same choice (0.8 and 0.85 on a scale) are one item; `keys` holds every
 * value's key, so removing the item forgets all of them. `times` sums the observations.
 * `contradicts` lists the other items for the same field that are a different choice — never
 * for list traits (bullets and headings can both be true). Ordered by layer, then most-seen. PURE.
 */
export function learnedItems(vd) {
  const layers = vd?.phaedo_fingerprint?.layers || {};
  const items = [];
  for (const [layer, l] of Object.entries(layers)) {
    for (const s of Array.isArray(l?.signals) ? l.signals : []) {
      if (!s || s.evidence_basis !== 'observed' || !s.field) continue;
      const k = itemKey(s.field, s.value);
      const times = Number(s.observation_count) || 1;
      const same = items.find((it) => it.field === s.field && (it.keys.includes(k) || (!Array.isArray(s.value) && sameChoice(s.field, it.value, s.value))));
      if (same) {
        if (!same.keys.includes(k)) same.keys.push(k);
        if (times > same.best) { same.best = times; same.value = s.value; same.text = sentence(s.field, s.value); }
        same.times += times;
        continue;
      }
      items.push({ key: k, keys: [k], field: s.field, layer, value: s.value, text: sentence(s.field, s.value), times, best: times });
    }
  }
  for (const it of items) {
    it.contradicts = Array.isArray(it.value) ? [] : items.filter((o) => o !== it && o.field === it.field && !Array.isArray(o.value)).map((o) => o.key);
  }
  const order = Object.keys(layers);
  items.sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer) || b.times - a.times || a.text.localeCompare(b.text));
  return items.map(({ value, best, ...rest }) => rest);
}

function sameChoice(field, a, b) {
  try { return T.sameChoice(field, a, b); } catch { return JSON.stringify(a) === JSON.stringify(b); }
}

/** The state: { forgotten: { key: at }, kept: { key: at } }. Never throws. */
export function readLearnedState(stateDir) {
  try {
    const j = JSON.parse(readFileSync(join(stateDir, STATE_FILE), 'utf8'));
    return { forgotten: obj(j.forgotten), kept: obj(j.kept) };
  } catch { return { forgotten: {}, kept: {} }; }
}
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

export function writeLearnedState(stateDir, state) {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, STATE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ forgotten: state.forgotten, kept: state.kept }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The profile with every forgotten trait taken out of its layers, in place (the loaders'
 * provenance marker lives on the object, so it is kept). Signals the subject said themselves
 * are never touched by a forget — only `observed` ones are listed, so only those can match.
 */
export function applyForgotten(vd, state) {
  const forgotten = state?.forgotten || {};
  const layers = vd?.phaedo_fingerprint?.layers;
  if (!layers || !Object.keys(forgotten).length) return vd;
  const next = {};
  for (const [id, l] of Object.entries(layers)) {
    if (!l || !Array.isArray(l.signals)) { next[id] = l; continue; }
    const signals = l.signals.filter((s) => !(s && s.evidence_basis === 'observed' && forgotten[itemKey(s.field, s.value)]));
    next[id] = signals.length === l.signals.length ? l : { ...l, signals };
  }
  vd.phaedo_fingerprint = { ...vd.phaedo_fingerprint, layers: next };
  return vd;
}

/** Items not yet kept or removed. */
const any = (map, it) => it.keys.some((k) => map[k]);
export const isForgotten = (it, state) => any(state.forgotten, it);
export const isKept = (it, state) => any(state.kept, it);
export const unreviewed = (items, state) => items.filter((i) => !isKept(i, state) && !isForgotten(i, state));

/** The screen. PURE. */
export function formatList(items, state) {
  if (!items.length) return 'Phaedo hasn\'t learned anything from how you work yet.';
  const num = new Map(items.map((it, i) => [it.key, i + 1]));
  const reviewedBefore = Object.keys(state.kept).length + Object.keys(state.forgotten).length > 0;
  const lines = [`Here's what Phaedo learned from how you work (${items.length}). Remove anything that isn't right.`, ''];
  for (const [i, it] of items.entries()) {
    const fresh = reviewedBefore && !isKept(it, state) ? ' (new)' : '';
    const clash = it.contradicts.filter((k) => num.has(k)).map((k) => `#${num.get(k)}`);
    lines.push(`${String(i + 1).padStart(3)}. ${shorten(it.text)}${fresh}`);
    if (clash.length) lines.push(`      ⚠ disagrees with ${clash.join(', ')}; keep the one that's right`);
  }
  lines.push('', 'Remove: npm run learned -- --remove 3,5    Keep: --keep 1,2 (or --keep all)');
  return lines.join('\n');
}

/** "3,5" / "all" → indexes into `items`; unknown numbers reported. PURE. */
export function pick(arg, items) {
  if (String(arg).trim().toLowerCase() === 'all') return { picked: items.slice(), bad: [] };
  const picked = [], bad = [];
  for (const p of String(arg || '').split(/[\s,]+/).filter(Boolean)) {
    const n = Number(p);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) picked.push(items[n - 1]); else bad.push(p);
  }
  return { picked, bad };
}

/** Record a decision. PURE: returns the new state. */
export function decide(state, items, action, now = new Date().toISOString()) {
  const s = { forgotten: { ...state.forgotten }, kept: { ...state.kept } };
  for (const it of items) for (const k of it.keys || [it.key]) {
    if (action === 'remove') { s.forgotten[k] = now; delete s.kept[k]; }
    if (action === 'keep') { s.kept[k] = now; delete s.forgotten[k]; }
    if (action === 'restore') { delete s.forgotten[k]; s.kept[k] = now; }
  }
  return s;
}

/** One line for /phaedo:status, or null when nothing is waiting. */
export function reviewLine(items, state) {
  const n = unreviewed(items, state).length;
  if (!n) return null;
  return `Phaedo learned ${n} thing${n === 1 ? '' : 's'} about how you work that you haven't looked at yet — /phaedo:learned (or npm run learned) to keep or remove ${n === 1 ? 'it' : 'them'}.`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main(argv) {
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? (argv[i + 1] ?? '') : null; };
  const { dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const { loadFingerprintPreferCache } = await import('./fingerprint-source.js');
  const { defaultStateDir } = await import('./cache.js');
  const MCP_DIR = dirname(fileURLToPath(import.meta.url));
  const stateDir = defaultStateDir();
  let vd;
  try { vd = await loadFingerprintPreferCache(MCP_DIR, { unfiltered: true }); } catch {
    process.stdout.write('Phaedo has no profile on this computer yet, so there is nothing to review.\n');
    return 0;
  }
  const all = learnedItems(vd);
  let state = readLearnedState(stateDir);
  const showing = all.filter((i) => !isForgotten(i, state));
  const gone = all.filter((i) => isForgotten(i, state));
  const say = (s) => process.stdout.write(s + '\n');
  const report = (bad) => { if (bad.length) say(`Not on the list: ${bad.join(', ')}.`); };

  for (const [flag, action, from] of [['--remove', 'remove', showing], ['--keep', 'keep', showing], ['--restore', 'restore', gone]]) {
    const arg = opt(flag);
    if (arg === null) continue;
    const { picked, bad } = pick(arg, from);
    report(bad);
    if (!picked.length) return bad.length ? 1 : 0;
    state = decide(state, picked, action);
    writeLearnedState(stateDir, state);
    const verb = { remove: 'Removed', keep: 'Kept', restore: 'Brought back' }[action];
    for (const it of picked) say(`${verb}: ${shorten(it.text, 100)}`);
    if (action === 'remove') say('Phaedo stops using these on this computer from the next session. To remove them from your phone\'s profile too, use the Phaedo app.');
    return 0;
  }
  if (argv.includes('--forgotten')) {
    if (!gone.length) { say('You haven\'t removed anything.'); return 0; }
    say('What you removed:');
    gone.forEach((it, i) => say(`${String(i + 1).padStart(3)}. ${shorten(it.text)}`));
    say('\nBring one back: npm run learned -- --restore 2');
    return 0;
  }
  say(formatList(showing, state));
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`✗ ${e.message}\n`); process.exit(1); });
}
