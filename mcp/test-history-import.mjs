// Learning from a ChatGPT or Claude data export (history-import.js): both formats, ChatGPT's
// branch tree, the date window, the shared capture spine, and that no text is ever kept.
//
//   node mcp/test-history-import.mjs

import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { detectFormat, conversationsFrom, readExport, importConversations, summaryText, SURFACES, DEFAULT_DAYS } from './history-import.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const NOW = Date.parse('2026-10-27T12:00:00Z');
const DAY = 86400000;
const secs = (daysAgo) => (NOW - daysAgo * DAY) / 1000;
const tmp = () => mkdtempSync(join(tmpdir(), 'phaedo-import-'));

// A ChatGPT conversation: system root → user → assistant, with a regenerated branch the person
// abandoned, and a code-interpreter turn that is not conversation.
function gpt(id, daysAgo, pairs) {
  const mapping = { root: { id: 'root', message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['sys'] } }, parent: null, children: [] } };
  let parent = 'root';
  pairs.forEach(([u, a], i) => {
    const uid = `${id}-u${i}`, aid = `${id}-a${i}`;
    mapping[uid] = { id: uid, message: { id: uid, author: { role: 'user' }, content: { content_type: 'text', parts: [u] }, create_time: secs(daysAgo) }, parent, children: [aid] };
    mapping[parent].children.push(uid);
    mapping[aid] = { id: aid, message: { id: aid, author: { role: 'assistant' }, content: { content_type: 'text', parts: [a] }, create_time: secs(daysAgo) }, parent: uid, children: [] };
    parent = aid;
  });
  // An abandoned branch off the first user turn, and a tool turn on the live path.
  const first = `${id}-u0`;
  mapping[`${id}-alt`] = { id: `${id}-alt`, message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['ABANDONED BRANCH'] } }, parent: first, children: [] };
  mapping[first].children.unshift(`${id}-alt`);
  const tool = `${id}-tool`;
  mapping[tool] = { id: tool, message: { author: { role: 'assistant' }, content: { content_type: 'code', text: 'print(1)' } }, parent, children: [] };
  mapping[parent].children.push(tool);
  return { id, conversation_id: id, title: 't', create_time: secs(daysAgo), update_time: secs(daysAgo), mapping, current_node: tool };
}
const claude = (uuid, daysAgo, pairs) => ({
  uuid, name: 't', created_at: new Date(NOW - daysAgo * DAY).toISOString(), updated_at: new Date(NOW - daysAgo * DAY).toISOString(),
  chat_messages: pairs.flatMap(([u, a], i) => [
    { uuid: `${uuid}-u${i}`, sender: 'human', text: '', content: [{ type: 'text', text: u }], created_at: new Date(NOW - daysAgo * DAY).toISOString() },
    { uuid: `${uuid}-a${i}`, sender: 'assistant', text: a, content: [], created_at: new Date(NOW - daysAgo * DAY).toISOString() },
  ]),
});

console.log('\nreading both exports');
{
  const g = [gpt('g1', 3, [['Plan my week, Zanzibar', 'Here is a long plan…'], ['too long, shorter please', 'Short plan.']]), gpt('g2', 400, [['old', 'old']]), null, { mapping: {} }];
  ok(detectFormat(g) === 'chatgpt' && detectFormat([claude('c1', 1, [['a', 'b']])]) === 'claude', 'format by shape');
  ok(detectFormat([{ foo: 1 }]) === null && detectFormat('x') === null && detectFormat([]) === null, 'anything else → null');
  const cs = conversationsFrom(g, 'chatgpt', { now: NOW });
  ok(cs.length === 1 && cs[0].id === 'g1', 'the last year only; garbage skipped');
  ok(conversationsFrom(g, 'chatgpt', { now: NOW, days: null }).length === 2, '--all reads everything');
  const t = cs[0].turns;
  ok(t.map((x) => x.role).join() === 'user,assistant,user,assistant', 'the live branch, in order; system and tool turns dropped');
  ok(!t.some((x) => /ABANDONED/.test(x.text)), 'a regenerated branch the person left is not read');
  ok(t[2].text === 'too long, shorter please' && t[0].timestamp.startsWith('2026-10-24'), 'text and time kept per turn (in memory)');
  const noCurrent = gpt('g3', 2, [['hi', 'hello']]); delete noCurrent.current_node;
  ok(conversationsFrom([noCurrent], 'chatgpt', { now: NOW })[0].turns.length >= 2, 'no current_node: follows the first branch down');
  const c = conversationsFrom([claude('c1', 1, [['no headers please', 'ok']]), claude('c2', 30, [['x', 'y']]), claude('c3', 500, [['x', 'y']])], 'claude', { now: NOW });
  ok(c.length === 2 && c[0].id === 'c1' && c[0].turns[0].text === 'no headers please' && c[0].turns[1].text === 'ok', 'Claude: content parts, falling back to text; newest first');
  const oneSided = claude('c4', 1, [['only me', '']]);
  ok(conversationsFrom([oneSided], 'claude', { now: NOW }).length === 0, 'a conversation with no reply is skipped');
  ok(DEFAULT_DAYS === 365, 'default window: a year');
}

console.log('\nthe file');
{
  const dir = tmp();
  const json = join(dir, 'conversations.json');
  writeFileSync(json, JSON.stringify([claude('c1', 1, [['a', 'b']])]));
  ok(readExport(json)[0].uuid === 'c1', 'a conversations.json path');
  const hasZip = spawnSync('zip', ['-v'], { encoding: 'utf8' }).status === 0;
  if (hasZip) {
    spawnSync('zip', ['-q', '-j', join(dir, 'export.zip'), json]);
    ok(readExport(join(dir, 'export.zip'))[0].uuid === 'c1', 'the export zip');
    writeFileSync(join(dir, 'other.txt'), 'x');
    spawnSync('zip', ['-q', '-j', join(dir, 'wrong.zip'), join(dir, 'other.txt')]);
    assert.throws(() => readExport(join(dir, 'wrong.zip')), /conversations\.json/); pass++;
  } else console.log('  (zip not installed — zip read skipped)');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nthe import, with fake capture');
{
  const convos = conversationsFrom([claude('c1', 1, [['a', 'b'], ['c', 'd']]), claude('c2', 2, [['e', 'f']])], 'claude', { now: NOW });
  const folded = [];
  let deposited = null;
  const r = await importConversations(convos, 'claude', {
    fold: async (c, surface) => { folded.push([c.id, surface]); return { signals: folded.length === 2 ? [{ a: 1 }, { b: 2 }] : [{ a: 1 }], counted: c.turns.filter((t) => t.role === 'user').length }; },
    deposit: async (signals, surface) => { deposited = [signals.length, surface]; return { deposited: true }; },
  });
  ok(folded.map((f) => f.join(':')).join() === 'c1:claude-import,c2:claude-import', 'each conversation folded once, on its own surface');
  ok(r.conversations === 2 && r.messages === 3 && r.signals === 2, 'messages summed; the last (cumulative) signals kept');
  ok(deposited && deposited[0] === 2 && deposited[1] === 'claude-import' && r.deposited, 'one deposit at the end');
  const none = await importConversations(convos, 'chatgpt', { fold: async () => ({ signals: [], counted: 1 }), deposit: async () => { throw new Error('should not deposit'); } });
  ok(none.signals === 0 && !none.deposited, 'nothing learned → no deposit');
  ok(SURFACES.chatgpt === 'chatgpt-import', 'surfaces named for the source');
}

console.log('\nwhat it says');
{
  ok(summaryText({ conversations: 412, messages: 3210, signals: 6, deposited: true }, { service: 'ChatGPT', days: 365, paired: true }) ===
    'Read 412 conversations from the last year from ChatGPT (3,210 messages of yours). Phaedo found 6 patterns in how you work and sent them to your phone. Only counts were kept; you can delete the export file now. To see and prune what it learned: npm run learned', 'paired');
  ok(/found 1 pattern in how you work\. Only counts/.test(summaryText({ conversations: 1, messages: 1, signals: 1 }, { service: 'Claude', days: null })), 'unpaired, --all, singular');
  ok(/Would read 2 conversations .* Nothing was changed\./.test(summaryText({ conversations: 2, messages: 5, signals: 0 }, { service: 'Claude', days: 30, dryRun: true })), 'dry run');
  ok(summaryText({ conversations: 0 }, { service: 'Claude', days: 365 }) === 'No Claude conversations from the last year to read in that file.', 'empty');
}

console.log('\nend to end: the real capture spine, nothing kept but counts');
{
  const dir = tmp();
  const exportPath = join(dir, 'conversations.json');
  const pairs = [['Write the Zanzibar memo', 'A very long memo …'], ['too long, shorter please', 'Shorter memo.'], ['no headers please', 'Done.']];
  const list = Array.from({ length: 4 }, (_, i) => gpt(`conv-${i}`, i + 1, pairs));
  writeFileSync(exportPath, JSON.stringify(list));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, PHAEDO_MCP_STATE_DIR: join(dir, 'state'), PHAEDO_CONFIG_DIR: join(dir, 'cfg') };
  delete env.PHAEDO_FINGERPRINT; delete env.PHAEDO_PAIRING; delete env.PHAEDO_CAPTURE_MODEL;
  const run = (...args) => spawnSync(process.execPath, [join(HERE, 'history-import.js'), ...args], { env, encoding: 'utf8', timeout: 60000 });
  const dry = run(exportPath, '--dry-run');
  ok(dry.status === 0 && /Would read 4 conversations .*\(12 messages of yours\)\. Nothing was changed\./.test(dry.stdout), dry.stdout + dry.stderr);
  ok(!existsSync(join(dir, 'state', 'capture-state.json')), 'dry run writes nothing');
  const r = run(exportPath);
  ok(r.status === 0 && /^Read 4 conversations from the last year from ChatGPT \(12 messages of yours\)\. Phaedo found \d+ patterns? in how you work\./.test(r.stdout), r.stdout + r.stderr);
  const state = readFileSync(join(dir, 'state', 'capture-state.json'), 'utf8');
  ok(/chatgpt-import/.test(state), 'counts land in the capture state, on the import surface');
  const everything = readdirSync(join(dir, 'state')).map((f) => readFileSync(join(dir, 'state', f), 'utf8')).join('\n');
  ok(!/Zanzibar|shorter please|memo/.test(everything), 'no message text anywhere on disk');
  ok(run(exportPath).status === 0, 'a second import runs');
  const st1 = JSON.parse(state), st2 = JSON.parse(readFileSync(join(dir, 'state', 'capture-state.json'), 'utf8'));
  const sessions = (s) => Object.values(s.surfaces || {}).reduce((n, x) => n + Object.keys(x.sessions || {}).length, 0);
  ok(sessions(st1) === 4 && sessions(st2) === 4, 'four conversations, four sessions — before and after a re-import');
  const fp = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { loadFingerprint } = await import(${JSON.stringify(join(HERE, 'fingerprint-source.js'))});
    const vd = await loadFingerprint(${JSON.stringify(HERE)});
    const sigs = Object.values(vd.phaedo_fingerprint.layers).flatMap((l) => l.signals || []);
    console.log(vd.phaedo_fingerprint.fingerprint_id, sigs.length);
  `], { env, encoding: 'utf8' });
  ok(/^starter-local [1-9]/.test(fp.stdout.trim()), `unpaired: it becomes the starter profile (${fp.stdout.trim()} ${fp.stderr.slice(0, 200)})`);
  ok(run(join(dir, 'missing.zip')).stdout.includes('No file at'), 'a missing file is said plainly');
  writeFileSync(join(dir, 'x.json'), '[{"foo":1}]');
  ok(/doesn't look like a ChatGPT or Claude data export/.test(run(join(dir, 'x.json')).stdout), 'a wrong file is said plainly');
  ok(run().status === 1, 'no file → usage');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n✓ history import: ${pass} checks passed`);
