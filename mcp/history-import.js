#!/usr/bin/env node
// Phaedo — learn from your ChatGPT or Claude history, from the export file each one gives you.
//
//   npm run import -- ~/Downloads/chatgpt-export.zip
//   npm run import -- ~/Downloads/claude-export.zip --all     # every conversation, not just the last year
//   npm run import -- conversations.json --dry-run            # count what it would read, change nothing
//
// Get the file: ChatGPT → Settings → Data controls → Export data; Claude → Settings → Privacy →
// Export data. Each emails a zip; its conversations.json is all this reads.
//
// Each conversation becomes {role, text} turns and goes through the SAME spine the Claude Code
// hook and the Mac reader use (capture/exchanges.js → capture-core.js: the deterministic
// detectors → per-session state → delta lift), as its own session keyed by the conversation's id,
// so importing the same export twice replaces rather than doubles. One deposit to the phone at
// the end when paired; a starter profile on this computer when not.
//
// DISCARD-RAW, as everywhere in capture: the text is read in memory, counted, and dropped.
// Nothing derived from it but signal names and integers is kept or sent. Not in the directory
// edition (its policy forbids reading chat history).

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main.js';

export const DEFAULT_DAYS = 365;
export const SURFACES = Object.freeze({ chatgpt: 'chatgpt-import', claude: 'claude-import' });
const DAY = 24 * 60 * 60 * 1000;

const text = (v) => (typeof v === 'string' ? v : '');
const iso = (t) => {
  if (typeof t === 'number' && Number.isFinite(t)) return new Date(t < 1e12 ? t * 1000 : t).toISOString();
  const p = Date.parse(t);
  return Number.isFinite(p) ? new Date(p).toISOString() : null;
};

/** Which service an export came from, by shape. PURE. */
export function detectFormat(list) {
  const first = Array.isArray(list) ? list.find((c) => c && typeof c === 'object') : null;
  if (!first) return null;
  if (first.mapping && typeof first.mapping === 'object') return 'chatgpt';
  if (Array.isArray(first.chat_messages)) return 'claude';
  return null;
}

// ChatGPT stores each conversation as a tree (every regenerate or edit is a branch). The
// conversation the person actually had is the path from `current_node` up to the root.
function chatgptTurns(c) {
  const map = c.mapping || {};
  let id = c.current_node && map[c.current_node] ? c.current_node : null;
  if (!id) {   // no current_node: the deepest leaf of the first branch
    id = Object.keys(map).find((k) => !map[k]?.parent) || null;
    while (id && Array.isArray(map[id]?.children) && map[id].children.length) id = map[id].children[0];
  }
  const path = [];
  const seen = new Set();
  while (id && map[id] && !seen.has(id)) { seen.add(id); path.push(map[id]); id = map[id].parent; }
  path.reverse();
  const turns = [];
  for (const node of path) {
    const m = node.message;
    const role = m?.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const ct = m.content?.content_type;
    if (ct && ct !== 'text' && ct !== 'multimodal_text') continue;   // code runs, browsing, tool output
    const body = (Array.isArray(m.content?.parts) ? m.content.parts : []).map(text).join('\n').trim();
    if (body) turns.push({ role, text: body, id: m.id || node.id, timestamp: iso(m.create_time) });
  }
  return turns;
}

function claudeTurns(c) {
  const turns = [];
  for (const m of Array.isArray(c.chat_messages) ? c.chat_messages : []) {
    const role = m?.sender === 'human' ? 'user' : m?.sender === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const parts = Array.isArray(m.content) ? m.content.filter((p) => p?.type === 'text').map((p) => text(p.text)) : [];
    const body = (parts.length ? parts.join('\n') : text(m.text)).trim();
    if (body) turns.push({ role, text: body, id: m.uuid, timestamp: iso(m.created_at) });
  }
  return turns;
}

/**
 * The export's conversations as [{ id, at, turns }], newest first, within `days` of `now`
 * (null = all). Never throws on a malformed entry; skips it. PURE.
 */
export function conversationsFrom(list, format, { now = Date.now(), days = DEFAULT_DAYS } = {}) {
  const since = days == null ? -Infinity : now - days * DAY;
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object') continue;
    const id = format === 'chatgpt' ? (c.conversation_id || c.id) : c.uuid;
    const at = format === 'chatgpt' ? iso(c.update_time ?? c.create_time) : iso(c.updated_at ?? c.created_at);
    if (!id || !at || Date.parse(at) < since || Date.parse(at) > now) continue;
    const turns = format === 'chatgpt' ? chatgptTurns(c) : claudeTurns(c);
    if (turns.some((t) => t.role === 'user') && turns.some((t) => t.role === 'assistant')) out.push({ id: String(id), at, turns });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** conversations.json from a .zip (system unzip, else bsdtar) or a .json path. */
export function readExport(path) {
  const p = resolve(path);
  if (!existsSync(p)) throw Object.assign(new Error(`no file at ${p}`), { code: 'ENOENT' });
  if (extname(p).toLowerCase() !== '.zip') return JSON.parse(readFileSync(p, 'utf8'));
  const opts = { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };
  for (const [cmd, args] of [['unzip', ['-p', p, 'conversations.json']], ['tar', ['-xOf', p, 'conversations.json']]]) {
    try { const raw = execFileSync(cmd, args, opts); if (raw.trim()) return JSON.parse(raw); } catch { /* try the next */ }
  }
  throw new Error("couldn't find conversations.json in that zip — is it the ChatGPT or Claude data export?");
}

/**
 * Fold every conversation through the capture spine and deposit once. deps: { fold, deposit,
 * sourceId, statePath, now } — the real ones in the CLI, fakes in tests. Returns a summary.
 */
export async function importConversations(convos, format, deps) {
  const surface = SURFACES[format];
  let signals = [];
  let messages = 0;
  for (const c of convos) {
    const r = await deps.fold(c, surface);
    messages += r.counted || 0;
    if (Array.isArray(r.signals)) signals = r.signals;     // cumulative: the last fold holds them all
  }
  const deposit = signals.length && deps.deposit ? await deps.deposit(signals, surface) : null;
  return { conversations: convos.length, messages, signals: signals.length, deposited: Boolean(deposit?.deposited), deposit };
}

const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

/** The result in plain words. PURE. */
export function summaryText(r, { service, days, dryRun = false, paired = false }) {
  const span = days == null ? '' : ` from the last ${days === 365 ? 'year' : `${days} days`}`;
  if (!r.conversations) return `No ${service} conversations${span} to read in that file.`;
  const head = `${dryRun ? 'Would read' : 'Read'} ${plural(r.conversations, 'conversation')}${span} from ${service} (${plural(r.messages, 'message')} of yours).`;
  if (dryRun) return `${head} Nothing was changed.`;
  const learned = r.signals
    ? `Phaedo found ${plural(r.signals, 'pattern')} in how you work${paired ? (r.deposited ? ' and sent them to your phone' : '; they\'ll reach your phone with the next sync') : ''}.`
    : 'Phaedo found nothing new in how you work from these.';
  return `${head} ${learned} Only counts were kept; you can delete the export file now. To see and prune what it learned: npm run learned`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  const say = (s) => process.stdout.write(s + '\n');
  if (!file) {
    say('Usage: npm run import -- <ChatGPT or Claude export .zip, or its conversations.json> [--all] [--days N] [--dry-run]');
    return 1;
  }
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const days = argv.includes('--all') ? null : (Number(opt('--days')) > 0 ? Number(opt('--days')) : DEFAULT_DAYS);
  const dryRun = argv.includes('--dry-run');

  let list;
  try { list = readExport(file); } catch (e) { say(`✗ ${e.code === 'ENOENT' ? `No file at ${file}.` : e.message}`); return 1; }
  const format = detectFormat(list);
  if (!format) { say("✗ That doesn't look like a ChatGPT or Claude data export (no conversations in the shape either one uses)."); return 1; }
  const service = format === 'chatgpt' ? 'ChatGPT' : 'Claude';
  const convos = conversationsFrom(list, format, { days });
  list = null;                                   // the raw export is not needed past this point

  if (dryRun) {
    const messages = convos.reduce((n, c) => n + c.turns.filter((t) => t.role === 'user').length, 0);
    say(summaryText({ conversations: convos.length, messages, signals: 0 }, { service, days, dryRun: true }));
    return 0;
  }

  const MCP_DIR = dirname(fileURLToPath(import.meta.url));
  const { loadCaptureModule } = await import('./lib/capture-home.js');
  const [{ turnsToBatch }, { foldBatchToSignals }, { deriveSourceDeviceId }] = await Promise.all(
    ['capture/exchanges.js', 'capture/capture-core.js', 'capture/source-id.js'].map(loadCaptureModule));
  const { loadPairingRecord } = await import('./phone-source.js');
  const { buildCaptureDelta, depositCaptureDelta } = await import('./capture-sync.js');
  let pairing = null;
  try { pairing = await loadPairingRecord(MCP_DIR); } catch { pairing = null; }
  const now = new Date().toISOString();
  const sourceId = deriveSourceDeviceId(pairing, SURFACES[format]);

  const r = await importConversations(convos, format, {
    async fold(c, surface) {
      const batch = turnsToBatch(c.turns, { sessionId: `${surface}:${c.id}`, platform: surface });
      // Regex detectors only: a local model over a whole history would take hours.
      const out = await foldBatchToSignals(batch, { sourceId, surface, sessionLocalId: `${surface}:${c.id}`, now, captureModel: null });
      return { signals: out.signals, counted: batch.user_prompts.length };
    },
    deposit: pairing ? async (signals, surface) => {
      const delta = buildCaptureDelta(signals, { sourceSurface: surface, sourceDeviceId: sourceId, capturedAt: now });
      return depositCaptureDelta(pairing, delta, { now: () => now });
    } : null,
  });
  say(summaryText(r, { service, days, paired: Boolean(pairing) }));
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`✗ ${e.message}\n`); process.exit(1); });
}
