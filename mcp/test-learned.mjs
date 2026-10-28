// "Here's what I learned — keep or remove" (learned.js): the plain list, merging and
// contradictions, the forget list applied on every profile read, and nothing but digests on disk.
//
//   node mcp/test-learned.mjs

import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  itemKey, learnedItems, applyForgotten, readLearnedState, writeLearnedState, decide, pick, unreviewed,
  reviewLine, formatList, shorten, isForgotten, STATE_FILE,
} from './learned.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const tmp = () => mkdtempSync(join(tmpdir(), 'phaedo-learned-'));

const sig = (field, value, n = 3, basis = 'observed') => ({ signal_id: `${field}-${JSON.stringify(value)}-${basis}`, field, value, evidence_basis: basis, observation_count: n, confidence: 0.8, source: 'delta' });
const VD = () => ({
  phaedo_fingerprint: {
    fingerprint_id: 'fp-test',
    layers: {
      surface: { signals: [sig('response_length_pref', 'short', 19), sig('formatting_prefs', ['bullets'], 2), sig('formatting_prefs', ['headers'], 2), sig('tone_register', 'formal', 5, 'self_reported')] },
      decision_and_risk: { signals: [sig('speed_vs_quality', 0.85, 8), sig('speed_vs_quality', 0.8, 1), sig('speed_vs_quality', 0.15, 3), sig('options_vs_recommendation', 'option_set', 2)] },
      big_picture: { summary: 'x' },
    },
  },
});

console.log('\nthe list');
{
  const items = learnedItems(VD());
  ok(items.length === 6, 'observed signals only, same choices merged (7 observed → 6 items)');
  ok(!items.some((i) => i.field === 'tone_register'), 'what the subject said themselves is not "learned"');
  ok(items[0].text === 'Keep answers short and to the point.' && items[0].times === 19, 'plain sentence, most-seen first within its area');
  const quality = items.find((i) => i.field === 'speed_vs_quality' && i.times === 9);
  ok(quality && quality.keys.length === 2 && /Favor quality/.test(quality.text), '0.8 and 0.85 are one item ("favor quality", seen 9×), both values kept as keys');
  const speed = items.find((i) => i.field === 'speed_vs_quality' && /Favor speed/.test(i.text));
  ok(quality.contradicts.includes(speed.key) && speed.contradicts.includes(quality.key), 'speed and quality disagree');
  ok(items.filter((i) => i.field === 'formatting_prefs').every((i) => !i.contradicts.length), 'bullets and headings do not (list traits)');
  ok(learnedItems(null).length === 0 && learnedItems({ phaedo_fingerprint: { layers: { a: { signals: [null, {}, 'x'] } } } }).length === 0, 'garbage → empty');
  ok(itemKey('speed_vs_quality', 0.85) === itemKey('speed_vs_quality', 0.85) && itemKey('speed_vs_quality', 0.85).startsWith('speed_vs_quality#'), 'keys are stable; the field in the clear');
  ok(!itemKey('domain_vocabulary', ['Acme secret']).includes('Acme'), 'the value only as a digest');
  ok(shorten('Terms I use: ' + Array.from({ length: 60 }, (_, i) => `term${i}`).join(', ') + '.').endsWith('more)'), 'long lists are cut with a count');
  ok(shorten('short.') === 'short.', 'short text untouched');
}

console.log('\nkeep and remove');
{
  const items = learnedItems(VD());
  let st = { forgotten: {}, kept: {} };
  ok(pick('2, 9, x', items).picked.length === 1 && pick('2, 9, x', items).bad.join() === '9,x', 'numbers picked; unknown ones reported');
  ok(pick('all', items).picked.length === items.length, '"all"');
  const speed = items.find((i) => /Favor speed/.test(i.text));
  const quality = items.find((i) => /Favor quality/.test(i.text));
  st = decide(st, [speed], 'remove', 't1');
  ok(isForgotten(speed, st) && !isForgotten(quality, st), 'removed');
  st = decide(st, [quality], 'keep', 't2');
  ok(Object.keys(st.kept).length === 2, 'keeping a merged item keeps every value in it');
  ok(unreviewed(items, st).length === items.length - 2, 'reviewed ones leave the queue');
  st = decide(st, [speed], 'restore', 't3');
  ok(!isForgotten(speed, st) && st.kept[speed.key], 'restore brings it back as kept');
  ok(reviewLine(items, { forgotten: {}, kept: {} }) === `Phaedo learned ${items.length} things about how you work that you haven't looked at yet — /phaedo:learned (or npm run learned) to keep or remove them.`, 'the status line');
  ok(reviewLine(items, decide({ forgotten: {}, kept: {} }, items, 'keep')) === null, 'nothing waiting → no line');
  const first = formatList(items, { forgotten: {}, kept: {} });
  ok(!first.includes('(new)') && /disagrees with #\d/.test(first), 'first review: no "(new)" on everything; conflicts flagged');
  const later = formatList(items, decide({ forgotten: {}, kept: {} }, [items[0]], 'keep'));
  ok((later.match(/\(new\)/g) || []).length === items.length - 1, 'later: the ones not kept are marked new');
  ok(formatList([], { forgotten: {}, kept: {} }).includes("hasn't learned anything"), 'empty');
}

console.log('\nthe forget list, applied to the profile');
{
  const items = learnedItems(VD());
  const speed = items.find((i) => /Favor speed/.test(i.text));
  const quality = items.find((i) => /Favor quality/.test(i.text));
  const SOURCE = Symbol('src');
  const vd = VD(); vd[SOURCE] = 'kept';
  const out = applyForgotten(vd, decide({ forgotten: {}, kept: {} }, [speed, quality], 'remove'));
  const left = out.phaedo_fingerprint.layers.decision_and_risk.signals.map((s) => s.value);
  ok(JSON.stringify(left) === '["option_set"]', 'every value of a removed item is gone (0.85, 0.8 and 0.15)');
  ok(out.phaedo_fingerprint.layers.surface.signals.length === 4 && out.phaedo_fingerprint.layers.big_picture.summary === 'x', 'everything else untouched');
  ok(out[SOURCE] === 'kept', 'the provenance marker survives');
  const said = VD(); said.phaedo_fingerprint.layers.surface.signals.push(sig('response_length_pref', 'short', 4, 'self_reported'));
  const short = learnedItems(said).find((i) => i.field === 'response_length_pref');
  const kept = applyForgotten(said, decide({ forgotten: {}, kept: {} }, [short], 'remove')).phaedo_fingerprint.layers.surface.signals;
  ok(kept.some((s) => s.field === 'response_length_pref' && s.evidence_basis === 'self_reported') && !kept.some((s) => s.field === 'response_length_pref' && s.evidence_basis === 'observed'), 'a forget never touches what the subject said themselves');
  ok(applyForgotten(VD(), { forgotten: {}, kept: {} }).phaedo_fingerprint.layers.decision_and_risk.signals.length === 4 && applyForgotten(null, { forgotten: { a: 1 } }) === null, 'empty list / no profile → unchanged');
}

console.log('\nthe file on disk');
{
  const dir = tmp();
  ok(JSON.stringify(readLearnedState(dir)) === '{"forgotten":{},"kept":{}}', 'missing → empty');
  writeFileSync(join(dir, STATE_FILE), 'garbage');
  ok(Object.keys(readLearnedState(dir).forgotten).length === 0, 'corrupt → empty, never throws');
  const vd = VD(); vd.phaedo_fingerprint.layers.surface.signals.push(sig('domain_vocabulary', ['Project Nightingale', 'Acme'], 5));
  writeLearnedState(dir, decide({ forgotten: {}, kept: {} }, learnedItems(vd), 'remove'));
  const raw = readFileSync(join(dir, STATE_FILE), 'utf8');
  ok(!/Nightingale|Acme|short|formal|bullets/.test(raw) && raw.includes('domain_vocabulary#'), 'only field names and digests, never the words');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nend to end: the CLI, and every profile read');
{
  const dir = tmp();
  const sample = JSON.parse(readFileSync(join(HERE, 'sample-fingerprint.json'), 'utf8'));
  const fp = sample.phaedo_fingerprint || sample;
  fp.layers.decision_and_risk = { ...(fp.layers.decision_and_risk || {}), signals: [...(fp.layers.decision_and_risk?.signals || []), sig('speed_vs_quality', 0.15, 3), sig('speed_vs_quality', 0.85, 8)] };
  const fpPath = join(dir, 'fp.json');
  writeFileSync(fpPath, JSON.stringify(sample));
  const env = { ...process.env, PHAEDO_FINGERPRINT: fpPath, PHAEDO_MCP_STATE_DIR: join(dir, 'state') };
  const run = (...args) => spawnSync(process.execPath, [join(HERE, 'learned.js'), ...args], { env, encoding: 'utf8', timeout: 20000 });
  const list = run();
  ok(list.status === 0 && /Favor quality/.test(list.stdout) && /Favor speed/.test(list.stdout) && /disagrees with/.test(list.stdout), list.stdout);
  const n = list.stdout.split('\n').find((l) => /Favor speed/.test(l)).trim().split('.')[0];
  const rm = run('--remove', n);
  ok(rm.status === 0 && /^Removed: Favor speed/m.test(rm.stdout) && /Phaedo app/.test(rm.stdout), 'removed, and told where else to remove it');
  ok(!/Favor speed/.test(run().stdout), 'gone from the list');
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { loadFingerprint, loadFingerprintPreferCache } = await import(${JSON.stringify(join(HERE, 'fingerprint-source.js'))});
    const vals = (vd) => vd.phaedo_fingerprint.layers.decision_and_risk.signals.filter((s) => s.field === 'speed_vs_quality').map((s) => s.value).join(',');
    console.log(vals(await loadFingerprint(${JSON.stringify(HERE)})), '|', vals(await loadFingerprintPreferCache(${JSON.stringify(HERE)})), '|', vals(await loadFingerprintPreferCache(${JSON.stringify(HERE)}, { unfiltered: true })));
  `], { env, encoding: 'utf8' });
  ok(read.stdout.trim() === '0.85 | 0.85 | 0.15,0.85', `every read leaves it out; the review read can still see it (${read.stdout.trim()} ${read.stderr})`);
  const gone = run('--forgotten');
  ok(/What you removed:\n\s+1\. Favor speed/.test(gone.stdout), 'listed under --forgotten');
  ok(/^Brought back: Favor speed/m.test(run('--restore', '1').stdout) && /Favor speed/.test(run().stdout), 'restore brings it back');
  ok(run('--remove', '99').status === 1 && /Not on the list: 99/.test(run('--remove', '99').stdout), 'an unknown number is refused');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n✓ learned: ${pass} checks passed`);
