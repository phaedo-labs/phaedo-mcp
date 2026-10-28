#!/usr/bin/env node
// Phaedo — write what Phaedo has learned into other agents' own instruction files.
//
// Claude Code gets the profile from the SessionStart hook. Codex, Copilot CLI, Gemini CLI and
// Antigravity have no such hook, but each reads a user-level instructions file at the start of
// every session. This writes a short version of the profile there, inside a marked block that
// Phaedo owns and replaces; everything else in the file is left exactly as it was.
//
//   npm run rules                     # every agent found on this computer
//   npm run rules -- --for codex,gemini
//   npm run rules -- --project ~/code/app   # Cursor: .cursor/rules/phaedo.mdc, kept out of git
//   npm run rules -- --remove         # take the block out again
//   npm run rules -- --dry-run        # show what would be written
//
// User-level files only, by default: a profile in a repository's AGENTS.md would be committed
// and shared. Cursor has no user-level rules file, so it takes an explicit project, and the
// rule file is added to that repository's .git/info/exclude (local, never committed).
//
// Opt-in only. A file that already carries the block is how the subject said yes, so the
// SessionStart hook refreshes those files (refreshExisting) and never adds new ones.

import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main.js';

export const BEGIN = '<!-- phaedo:begin — written by Phaedo and refreshed as it learns. Delete this whole block to stop. -->';
export const END = '<!-- phaedo:end -->';
export const MAX_CHARS = 6000;          // under Antigravity's ~12k per file and Codex's 32 KiB combined
export const CURSOR_RULE = join('.cursor', 'rules', 'phaedo.mdc');

// The sections an agent can act on, in the order they are worth keeping when space runs out.
const KEEP = ['## Operating rules (user-confirmed)', '## How to respond to this user', '## How this user thinks'];

/** The user-level instruction files Phaedo knows, for this home and environment. */
export function targets({ home = homedir(), env = process.env } = {}) {
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex');
  return {
    codex:   { label: 'Codex', file: join(codexHome, 'AGENTS.md'), dir: codexHome },
    copilot: { label: 'Copilot CLI', file: join(home, '.copilot', 'copilot-instructions.md'), dir: join(home, '.copilot') },
    gemini:  { label: 'Gemini CLI and Antigravity', file: join(home, '.gemini', 'GEMINI.md'), dir: join(home, '.gemini') },
    // Claude Code already gets the full profile from the SessionStart hook; only on request.
    claude:  { label: 'Claude Code', file: join(home, '.claude', 'CLAUDE.md'), dir: join(home, '.claude'), onRequest: true },
  };
}

function sections(projection) {
  const body = String(projection || '').replace(/^\s*<phaedo_user_profile>\s*/, '').replace(/\s*<\/phaedo_user_profile>\s*$/, '');
  const parts = body.split(/\n(?=## )/);
  const preamble = parts[0].startsWith('## ') ? '' : parts.shift().trim();
  const byHead = new Map(parts.map((p) => [p.split('\n', 1)[0].trim(), p.trim()]));
  return { preamble, byHead };
}

/**
 * The short profile for an instructions file, from the same projection Claude Code gets.
 * PURE. Null when the projection has nothing an agent can act on.
 */
export function rulesText(projection, { now = Date.now(), maxChars = MAX_CHARS } = {}) {
  const { preamble, byHead } = sections(projection);
  const kept = KEEP.map((h) => byHead.get(h)).filter(Boolean);
  if (!kept.length) return null;
  const date = new Date(now).toISOString().slice(0, 10);
  const head = [
    '# How I like to work (from Phaedo)',
    '',
    `Learned by Phaedo and refreshed ${date}. ${preamble.replace(/\s+/g, ' ').trim()}`.trim(),
  ].join('\n');
  // Shed whole sections from the end first; cut inside one only if the first alone is too long.
  while (kept.length > 1 && [head, ...kept].join('\n\n').length > maxChars) kept.pop();
  let text = [head, ...kept].join('\n\n');
  if (text.length > maxChars) text = text.slice(0, text.lastIndexOf('\n', maxChars)).trimEnd();
  return text;
}

/** The managed block, markers included. */
export function block(text) {
  return `${BEGIN}\n${text}\n${END}`;
}

function findBlock(content) {
  const b = content.indexOf('<!-- phaedo:begin');
  const e = content.indexOf(END);
  if (b < 0 && e < 0) return { state: 'absent' };
  if (b < 0 || e < 0 || e < b || content.indexOf('<!-- phaedo:begin', b + 1) >= 0) return { state: 'broken' };
  return { state: 'present', start: b, end: e + END.length };
}

/**
 * The file's new content with the block put in (or replaced), everything else untouched.
 * PURE. { content, changed } — or { error } when the markers are damaged, so a hand-edited
 * file is never guessed at.
 */
export function upsertBlock(existing, text) {
  const src = existing ?? '';
  const f = findBlock(src);
  if (f.state === 'broken') return { error: 'the Phaedo markers in this file are damaged — fix or delete them by hand' };
  let content;
  if (f.state === 'present') content = src.slice(0, f.start) + block(text) + src.slice(f.end);
  else content = src.trim() ? `${src.replace(/\s*$/, '')}\n\n${block(text)}\n` : `${block(text)}\n`;
  return { content, changed: content !== src };
}

/** The file's content with the block taken out. PURE. */
export function removeBlock(existing) {
  const src = existing ?? '';
  const f = findBlock(src);
  if (f.state === 'broken') return { error: 'the Phaedo markers in this file are damaged — fix or delete them by hand' };
  if (f.state === 'absent') return { content: src, changed: false };
  const before = src.slice(0, f.start).replace(/\s*$/, '');
  const after = src.slice(f.end).replace(/^\s*/, '');
  const content = before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after;
  return { content, changed: true };
}

export const hasBlock = (content) => findBlock(content ?? '').state === 'present';

/** Cursor's project rule: a whole file Phaedo owns, always applied. PURE. */
export function cursorRule(text) {
  return [
    '---',
    'description: How I like to work, learned by Phaedo',
    'alwaysApply: true',
    '---',
    '',
    text,
    '',
  ].join('\n');
}

// ── I/O ───────────────────────────────────────────────────────────────────────

const read = (file) => fs.readFile(file, 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
const exists = (p) => fs.stat(p).then(() => true, () => false);

async function writeAtomic(file, content) {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.phaedo-${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

/** Put (or refresh) the block in one file. → { status: 'written'|'unchanged'|'error', error? } */
export async function applyToFile(file, text, { dryRun = false } = {}) {
  const r = upsertBlock(await read(file), text);
  if (r.error) return { status: 'error', error: r.error };
  if (!r.changed) return { status: 'unchanged' };
  if (!dryRun) await writeAtomic(file, r.content);
  return { status: 'written' };
}

export async function removeFromFile(file, { dryRun = false } = {}) {
  const src = await read(file);
  if (src === null) return { status: 'unchanged' };
  const r = removeBlock(src);
  if (r.error) return { status: 'error', error: r.error };
  if (!r.changed) return { status: 'unchanged' };
  if (!dryRun) await writeAtomic(file, r.content);
  return { status: 'removed' };
}

/** Which agents to write for: those named, or every agent whose folder exists here. */
export async function chooseTargets(all, names = null) {
  if (names) return names.filter((n) => all[n]).map((n) => [n, all[n]]);
  const out = [];
  for (const [n, t] of Object.entries(all)) if (!t.onRequest && await exists(t.dir)) out.push([n, t]);
  return out;
}

// Keep a project's Cursor rule out of git without touching its committed .gitignore.
function excludeFromGit(projectDir) {
  let excl;
  try {
    excl = execFileSync('git', ['-C', projectDir, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return false; }
  return resolve(projectDir, excl);
}

export async function applyToCursorProject(projectDir, text, { dryRun = false } = {}) {
  const file = join(projectDir, CURSOR_RULE);
  const content = cursorRule(text);
  const changed = (await read(file)) !== content;
  const excl = excludeFromGit(projectDir);
  const line = '/' + CURSOR_RULE.split('\\').join('/');
  if (!dryRun) {
    if (changed) await writeAtomic(file, content);
    if (excl) {
      const cur = (await read(excl)) || '';
      if (!cur.split('\n').includes(line)) await writeAtomic(excl, `${cur.replace(/\s*$/, '')}${cur.trim() ? '\n' : ''}${line}\n`);
    }
  }
  return { status: changed ? 'written' : 'unchanged', file, keptOutOfGit: Boolean(excl) };
}

/**
 * Refresh only the files that already carry the block — the subject opted those in. Used by
 * the SessionStart hook; never adds the block anywhere new, never throws.
 */
export async function refreshExisting(projection, { home, env, now } = {}) {
  const text = rulesText(projection, { now });
  if (!text) return [];
  const out = [];
  for (const [name, t] of Object.entries(targets({ home, env }))) {
    try {
      const src = await read(t.file);
      if (!hasBlock(src)) continue;
      out.push({ name, ...(await applyToFile(t.file, text)) });
    } catch { /* one unreadable file never stops the rest */ }
  }
  return out;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const tilde = (p) => (p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p);

async function main(argv) {
  const flag = (f) => argv.includes(f);
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const dryRun = flag('--dry-run');
  const names = opt('--for') ? opt('--for').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
  const project = opt('--project');
  const all = targets();
  if (names) {
    const unknown = names.filter((n) => !all[n] && n !== 'cursor');
    if (unknown.length) { process.stderr.write(`Unknown agent: ${unknown.join(', ')}. Known: ${Object.keys(all).join(', ')}, cursor (with --project).\n`); return 1; }
  }
  const chosen = await chooseTargets(all, names ? names.filter((n) => n !== 'cursor') : null);
  const say = (s) => process.stdout.write(s + '\n');

  if (flag('--remove')) {
    for (const [, t] of names ? chosen : Object.entries(all)) {
      const r = await removeFromFile(t.file, { dryRun });
      if (r.status === 'removed') say(`✓ ${t.label}: took Phaedo's section out of ${tilde(t.file)}`);
      else if (r.status === 'error') say(`✗ ${t.label}: ${r.error} (${tilde(t.file)})`);
    }
    if (project) {
      const file = join(resolve(project), CURSOR_RULE);
      if (await exists(file)) { if (!dryRun) await fs.rm(file); say(`✓ Cursor: removed ${tilde(file)}`); }
    }
    return 0;
  }

  const MCP_DIR = dirname(fileURLToPath(import.meta.url));
  const { loadFingerprintPreferCache } = await import('./fingerprint-source.js');
  const { buildInjectionResponse } = await import('./projection.js');
  let text = null;
  try {
    const vd = await loadFingerprintPreferCache(MCP_DIR);
    text = rulesText(buildInjectionResponse(vd, { requested_layers: ['all'], mode: 'standard' }).projection);
  } catch { /* falls through to the message below */ }
  if (!text) { say('Phaedo has no profile with rules or preferences yet, so nothing was written.'); return 0; }

  if (dryRun) say(`Would write this (${text.length} characters):\n\n${text}\n`);
  if (!chosen.length && !project) {
    say('No other AI agents found on this computer (looked for Codex, Copilot CLI, Gemini CLI and Antigravity).');
    say('Name one with --for codex,copilot,gemini,claude, or a Cursor project with --project <folder>.');
    return 0;
  }
  let failed = false;
  for (const [, t] of chosen) {
    const r = await applyToFile(t.file, text, { dryRun });
    if (r.status === 'error') { failed = true; say(`✗ ${t.label}: ${r.error} (${tilde(t.file)})`); }
    else say(`✓ ${t.label}: ${r.status === 'written' ? (dryRun ? 'would update' : 'updated') : 'already up to date'} — ${tilde(t.file)}`);
  }
  if (project) {
    const r = await applyToCursorProject(resolve(project), text, { dryRun });
    say(`✓ Cursor: ${r.status === 'written' ? (dryRun ? 'would update' : 'updated') : 'already up to date'} — ${tilde(r.file)}${r.keptOutOfGit ? ' (kept out of git)' : ''}`);
  }
  if (!dryRun) say('Phaedo refreshes these whenever a Claude Code session starts with Phaedo on. To take them out: npm run rules -- --remove');
  return failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { process.stderr.write(`✗ ${err.message}\n`); process.exit(1); });
}
