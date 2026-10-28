// Writing what Phaedo learned into other agents' instruction files (rules-files.js): the short
// profile, the marked block, opt-in refresh, Cursor's project rule kept out of git, and the CLI
// and SessionStart hook run end to end against a throwaway home.
//
//   node mcp/test-rules-files.mjs

import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  targets, rulesText, block, upsertBlock, removeBlock, hasBlock, cursorRule, applyToFile,
  removeFromFile, chooseTargets, refreshExisting, applyToCursorProject, BEGIN, END, MAX_CHARS, CURSOR_RULE,
} from './rules-files.js';

const MCP = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const NOW = Date.parse('2026-10-27T12:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'phaedo-rules-'));

const PROJECTION = [
  '<phaedo_user_profile>',
  'This is a persona model of the subject.',
  'Use it to calibrate tone.',
  '',
  '## Operating rules (user-confirmed)',
  '- Default to concise.',
  '',
  '## How to respond to this user',
  'Format:',
  '  - Always wrap code in code blocks',
  '',
  '## How this user thinks',
  '- Exploratory',
  '',
  '## Interview answers',
  '### Communication style',
  '- a private answer',
  '',
  '## Learned from your conversations',
  '- something learned',
  '',
  '## Fingerprint confidence',
  '- 0.7',
  '</phaedo_user_profile>',
].join('\n');

console.log('\nthe short profile');
{
  const t = rulesText(PROJECTION, { now: NOW });
  ok(t.startsWith('# How I like to work (from Phaedo)'), 'a plain heading');
  ok(t.includes('refreshed 2026-10-27') && t.includes('This is a persona model of the subject. Use it to calibrate tone.'), 'dated, with the framing kept');
  ok(t.indexOf('## Operating rules') < t.indexOf('## How to respond') && t.indexOf('## How to respond') < t.indexOf('## How this user thinks'), 'the three sections, in order');
  ok(!/Interview answers|private answer|Learned from|Fingerprint confidence|phaedo_user_profile/.test(t), 'interview answers, raw learnings, confidence and the tag stay out');
  ok(rulesText('<phaedo_user_profile>\n## Interview answers\n- x\n</phaedo_user_profile>') === null, 'nothing to act on → null');
  ok(rulesText(null) === null && rulesText('') === null, 'no projection → null');
  const short = rulesText(PROJECTION, { now: NOW, maxChars: 300 });
  ok(short.length <= 300 && short.includes('## Operating rules') && !short.includes('## How this user thinks'), 'over the cap: later sections go first');
  const long = rulesText('## Operating rules (user-confirmed)\n' + Array.from({ length: 400 }, (_, i) => `- rule ${i}`).join('\n'), { now: NOW });
  ok(long.length <= MAX_CHARS && long.endsWith('- rule ' + long.split('- rule ').pop().trim().split('\n')[0]), 'one long section is cut on a line break, under the cap');
}

console.log('\nthe marked block');
{
  ok(block('x') === `${BEGIN}\nx\n${END}`, 'markers around the text');
  const fresh = upsertBlock(null, 'hello');
  ok(fresh.changed && fresh.content === `${block('hello')}\n`, 'a new file is just the block');
  const mine = '# My rules\n\nUse tabs.\n';
  const a = upsertBlock(mine, 'v1');
  ok(a.content.startsWith(mine.trimEnd()) && a.content.includes(block('v1')), 'appended after the user\'s own text');
  const b = upsertBlock(a.content + '\nMore of mine.\n', 'v2');
  ok(b.content.includes(block('v2')) && !b.content.includes('v1') && b.content.startsWith('# My rules') && b.content.endsWith('More of mine.\n'), 'replaced in place; text before and after untouched');
  ok(upsertBlock(b.content, 'v2').changed === false, 'same text → unchanged');
  ok(hasBlock(b.content) && !hasBlock(mine) && !hasBlock(null), 'hasBlock');
  for (const [name, broken] of [['begin only', `${BEGIN}\nx`], ['end only', `x\n${END}`], ['reversed', `${END}\n${BEGIN}`], ['two blocks', `${block('a')}\n${block('b')}`]]) {
    ok(upsertBlock(broken, 'y').error && removeBlock(broken).error, `damaged markers (${name}) → refused, not guessed`);
  }
  ok(removeBlock(upsertBlock(mine, 'v1').content).content === mine, 'remove gives back exactly what was there');
  ok(removeBlock(upsertBlock('', 'v1').content).content === '', 'a file that was only the block ends empty');
  const mid = removeBlock(`top\n\n${block('x')}\n\nbottom\n`);
  ok(mid.content === 'top\n\nbottom\n', 'text on both sides joins cleanly');
  ok(removeBlock(mine).changed === false, 'no block → unchanged');
  ok(cursorRule('t').startsWith('---\ndescription: How I like to work, learned by Phaedo\nalwaysApply: true\n---\n\nt'), 'Cursor rule: always applied');
}

console.log('\nwhere it goes');
{
  const t = targets({ home: '/h', env: {} });
  ok(t.codex.file === '/h/.codex/AGENTS.md' && t.copilot.file === '/h/.copilot/copilot-instructions.md' && t.gemini.file === '/h/.gemini/GEMINI.md', 'the user-level files');
  ok(targets({ home: '/h', env: { CODEX_HOME: '/c' } }).codex.file === '/c/AGENTS.md', 'CODEX_HOME is respected');
  ok(t.claude.onRequest === true, 'Claude Code only on request (the hook already covers it)');
  const home = tmp();
  mkdirSync(join(home, '.codex')); mkdirSync(join(home, '.gemini')); mkdirSync(join(home, '.claude'));
  const found = (await chooseTargets(targets({ home, env: {} }))).map(([n]) => n);
  ok(found.join() === 'codex,gemini', 'found: agents whose folder exists; never Claude Code by default');
  ok((await chooseTargets(targets({ home, env: {} }), ['claude', 'nope'])).map(([n]) => n).join() === 'claude', 'named: exactly those known');
  rmSync(home, { recursive: true, force: true });
}

console.log('\nwriting, refreshing, removing');
{
  const home = tmp();
  const t = targets({ home, env: {} });
  const text = rulesText(PROJECTION, { now: NOW });
  ok((await applyToFile(t.codex.file, text)).status === 'written' && readFileSync(t.codex.file, 'utf8').includes(text), 'written, folder made');
  ok((await applyToFile(t.codex.file, text)).status === 'unchanged', 'second time: unchanged');
  ok((await applyToFile(t.copilot.file, text, { dryRun: true })).status === 'written' && !existsSync(t.copilot.file), 'dry run writes nothing');
  mkdirSync(dirname(t.gemini.file), { recursive: true });
  writeFileSync(t.gemini.file, 'My own Gemini notes.\n');
  mkdirSync(dirname(t.copilot.file), { recursive: true });
  const r = await refreshExisting(PROJECTION.replace('Default to concise.', 'Default to concise. NEW'), { home, env: {}, now: NOW });
  ok(r.length === 1 && r[0].name === 'codex' && r[0].status === 'written', 'refresh touches only files that carry the block');
  ok(readFileSync(t.codex.file, 'utf8').includes('NEW'), '…and brings them up to date');
  ok(readFileSync(t.gemini.file, 'utf8') === 'My own Gemini notes.\n' && !existsSync(t.copilot.file), 'never adds the block anywhere new');
  mkdirSync(dirname(t.claude.file), { recursive: true }); writeFileSync(t.claude.file, `${BEGIN}\nhalf a block\n`);
  ok((await refreshExisting(PROJECTION, { home, env: {}, now: NOW })).every((x) => x.name !== 'claude') && readFileSync(t.claude.file, 'utf8') === `${BEGIN}\nhalf a block\n`, 'damaged markers are left alone');
  ok((await refreshExisting('<phaedo_user_profile></phaedo_user_profile>', { home, env: {} })).length === 0, 'nothing to say → nothing touched');
  ok((await removeFromFile(t.codex.file)).status === 'removed' && readFileSync(t.codex.file, 'utf8') === '', 'removed');
  ok((await removeFromFile(join(home, 'missing.md'))).status === 'unchanged', 'missing file → unchanged');
  rmSync(home, { recursive: true, force: true });
}

console.log('\nCursor: a project rule kept out of git');
{
  const repo = tmp();
  execFileSync('git', ['init', '-q', repo]);
  const text = rulesText(PROJECTION, { now: NOW });
  const r = await applyToCursorProject(repo, text);
  ok(r.status === 'written' && r.keptOutOfGit && readFileSync(join(repo, CURSOR_RULE), 'utf8') === cursorRule(text), 'the rule file');
  const excl = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  ok(excl.split('\n').includes('/.cursor/rules/phaedo.mdc'), 'listed in .git/info/exclude');
  ok(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim() === '', 'git does not see it');
  ok(!existsSync(join(repo, '.gitignore')), 'the committed .gitignore is not touched');
  await applyToCursorProject(repo, text);
  ok(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8') === excl, 'the exclude line is added once');
  const plain = tmp();
  const p = await applyToCursorProject(plain, text);
  ok(p.status === 'written' && p.keptOutOfGit === false, 'not a git repo: written, nothing to exclude');
  rmSync(repo, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true });
}

console.log('\nend to end: the CLI and the SessionStart hook');
{
  const home = tmp();
  mkdirSync(join(home, '.codex')); mkdirSync(join(home, '.gemini'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, PHAEDO_FINGERPRINT: 'sample', PHAEDO_CONFIG_DIR: join(home, 'cfg') };
  delete env.CODEX_HOME;
  const run = (args) => execFileSync(process.execPath, [join(MCP, 'rules-files.js'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = run([]);
  ok(/✓ Codex: updated/.test(out) && /✓ Gemini CLI and Antigravity: updated/.test(out), out);
  const codex = readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8');
  ok(hasBlock(codex) && codex.includes('# How I like to work (from Phaedo)'), 'the sample profile landed in Codex\'s file');
  ok(/already up to date/.test(run(['--for', 'codex'])), 'a second run changes nothing');
  ok(/Unknown agent/.test((() => { try { run(['--for', 'vim']); return ''; } catch (e) { return e.stderr; } })()), 'an unknown agent is refused');
  // The hook refreshes what was opted in, and only that.
  writeFileSync(join(home, '.codex', 'AGENTS.md'), codex.replace(/refreshed \d{4}-\d{2}-\d{2}/, 'refreshed 1999-01-01'));
  writeFileSync(join(home, '.gemini', 'GEMINI.md'), 'mine only\n');
  const hook = execFileSync(process.execPath, [join(MCP, 'hooks', 'session-start.mjs')], { env, encoding: 'utf8' });
  ok(JSON.parse(hook).hookSpecificOutput.additionalContext.startsWith('<phaedo_user_profile>'), 'the hook still injects the profile');
  ok(!readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8').includes('1999-01-01'), 'and refreshed the opted-in file');
  ok(readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8') === 'mine only\n', 'and left the other alone');
  ok(/took Phaedo's section out/.test(run(['--remove'])) && !hasBlock(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8')), '--remove takes it out');
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n✓ rules-files: ${pass} checks passed`);
