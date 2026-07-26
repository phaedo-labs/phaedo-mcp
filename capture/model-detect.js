// Phaedo capture — option (b): the model-backed correction detector.
//
// Claude Code's terse register under-triggers the chat-tuned Path-A regexes
// ("tldr pls", "why r u explaining this", "wall of text again"), so a local
// model backend enriches capture — but as a RICHER DETECTOR, not a second
// extraction pipeline. The model classifies ONLY the user messages the regexes
// MISSED against the SAME correction taxonomy (CORRECTION_PATTERNS' layer/signal
// pairs), and its hits increment the SAME per-session counters. Everything
// downstream — per-session REPLACE state (resume-safe), cumulative delta-lift,
// per-source snapshot deposit, owner-side combine — applies unchanged, and the
// owner's "source:'delta' only" deposit guard stays exactly right: a model hit
// is just a counter the regex would have incremented if it were smarter.
//
// Why not deposit source:'extraction' signals: reconcile merges extraction
// signals ADDITIVELY (mergeSignal sums counts), so a SessionEnd re-fire (clear /
// resume re-processes the full transcript) or a double-drain would inflate them.
// Counters + per-session replace already solve that; the model feeds them.
//
// Privacy: regex-missed user messages are sent ONLY to the configured LOCAL
// endpoint (Ollama / OpenAI-compatible — same trust boundary as the WebLLM
// extraction and the consult model judge), and nothing derived from them but
// signal names + integers is persisted or deposited (the discard-raw contract).
//
// Transport mirrors mcp/consult.js modelJudge (the consult Ollama plumbing):
// POST {url}/v1/chat/completions, strict-JSON reply, hard timeout. Opt-in via
// PHAEDO_CAPTURE_MODEL; everything here fails toward "regex counts only".

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CORRECTION_PATTERNS, detectCorrection } from './detectors.js';

// The classification taxonomy: unique (layer, signal) pairs from the mirrored
// correction table, so the model can only ever emit counters the deterministic
// path could also produce (and the parity test already locks against content.js).
export function correctionTaxonomy() {
  const seen = new Map();
  for (const { layer, signal } of CORRECTION_PATTERNS) {
    if (!seen.has(signal)) seen.set(signal, { layer, signal });
  }
  return [...seen.values()];
}

const MAX_MODEL_PROMPTS = 40;     // most recent regex-miss messages sent per session
const CLIP_CHARS = 1500;          // per-message clip (corrections live in the first words)

// The regex-miss user messages of a batch (the only ones the model sees), most
// recent MAX_MODEL_PROMPTS. Same prompt-source fallback as accumulateBatchCounts.
export function regexMissPrompts(batch) {
  const exchanges = (batch && batch.exchanges) || [];
  const prompts = (batch && Array.isArray(batch.user_prompts))
    ? batch.user_prompts
    : exchanges.map((e) => e.user_msg);
  return prompts
    .filter((t) => typeof t === 'string' && t.trim() && !detectCorrection(t))
    .slice(-MAX_MODEL_PROMPTS)
    .map((t) => t.slice(0, CLIP_CHARS));
}

export function buildDetectPrompt(prompts) {
  const names = correctionTaxonomy().map((t) => t.signal).join(', ');
  const system =
    'You classify a user\'s messages to an AI assistant, looking for CORRECTIONS — moments where ' +
    'the user pushes back on HOW the assistant responded (length, format, tone, depth, autonomy, ' +
    'risk posture), not on facts. Signals: ' + names + '. ' +
    'The names are literal: too_long = the reply was too long / wants it shorter; wants_confirmation = ' +
    'asks the assistant to check before acting; and so on. Reply with STRICT JSON only:\n' +
    '{"hits": [{"m": <message number>, "signal": "<signal name>"}]}\n' +
    'At most ONE signal per message — the dominant correction. Messages with no correction are ' +
    'simply omitted. When unsure, omit (precision over recall). Output ONLY the JSON object.';
  const user = prompts.map((t, i) => `[${i + 1}] ${t}`).join('\n\n');
  return { system, user };
}

// Parse + validate the model's reply. Returns { <1-based m>: signal } for valid,
// in-range, first-per-message hits with known signal names; {} on any junk.
export function parseDetectResponse(text, promptCount) {
  let obj;
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return {};
    obj = JSON.parse(m[0]);
  } catch { return {}; }
  const valid = new Map(correctionTaxonomy().map((t) => [t.signal, t.layer]));
  const out = {};
  for (const hit of Array.isArray(obj?.hits) ? obj.hits : []) {
    const m = hit && hit.m;
    if (!Number.isInteger(m) || m < 1 || m > promptCount) continue;
    if (out[m]) continue;                          // first hit per message wins (regex parity)
    if (!valid.has(hit.signal)) continue;          // unknown name → dropped, never invented
    out[m] = hit.signal;
  }
  return out;
}

// Fold validated model hits into a session-counts object (accumulateBatchCounts
// shape). Pure — returns a new counts object; the input is not mutated. Only
// behavioral_signals move: positives/mental-models stay regex-only for now.
export function mergeModelCounts(counts, hits) {
  const layerOf = new Map(correctionTaxonomy().map((t) => [t.signal, t.layer]));
  const behavioral = {};
  for (const [layer, sigs] of Object.entries((counts && counts.behavioral_signals) || {})) {
    behavioral[layer] = { ...sigs };
  }
  let added = 0;
  for (const signal of Object.values(hits || {})) {
    const layer = layerOf.get(signal);
    if (!layer) continue;
    if (!behavioral[layer]) behavioral[layer] = {};
    behavioral[layer][signal] = (behavioral[layer][signal] || 0) + 1;
    added++;
  }
  return { counts: { ...counts, behavioral_signals: behavioral }, added };
}

// Opt-in config, mirroring consultOptsFromEnv's conventions. `model` unset →
// the whole backend is off and the hook never touches the network for it.
export function captureModelOptsFromEnv(env = process.env) {
  return {
    model: env.PHAEDO_CAPTURE_MODEL || null,
    modelUrl: env.PHAEDO_CAPTURE_MODEL_URL || 'http://localhost:11434',
    apiKey: env.PHAEDO_CAPTURE_API_KEY || null,
    timeoutMs: Number(env.PHAEDO_CAPTURE_MODEL_TIMEOUT_MS) || 15000,
  };
}

// The durable on-switch: <state dir>/capture-model.json, written by
// `node install.mjs --capture-model <name>` (removed with `... off`). A shell
// `export` only reaches TERMINAL-launched sessions — Claude Desktop / Cowork
// launched from the Dock never read the shell profile, so their hooks would
// silently stay regex-only. The config file lives beside capture-state.json,
// which the hook reads anyway, so it reaches every launch path.
// Shape: { "model": "llama3.1:8b", "url"?, "api_key"?, "timeout_ms"? }.
export function captureModelConfigPath(env = process.env) {
  const dir = env.PHAEDO_MCP_STATE_DIR || join(homedir(), '.phaedo-mcp');
  return join(dir, 'capture-model.json');
}

// Resolved capture-model config: env vars win (per-session override, and the
// original interface), else the config file, else off. A missing or malformed
// file is simply "off" — the hook must never fail on config.
export function captureModelOpts(env = process.env) {
  const fromEnv = captureModelOptsFromEnv(env);
  if (fromEnv.model) return fromEnv;
  try {
    const cfg = JSON.parse(readFileSync(captureModelConfigPath(env), 'utf8'));
    if (cfg && typeof cfg.model === 'string' && cfg.model) {
      return {
        model: cfg.model,
        modelUrl: (typeof cfg.url === 'string' && cfg.url) || fromEnv.modelUrl,
        apiKey: (typeof cfg.api_key === 'string' && cfg.api_key) || null,
        timeoutMs: Number(cfg.timeout_ms) || fromEnv.timeoutMs,
      };
    }
  } catch { /* no/broken file → off */ }
  return fromEnv;
}

// One chat call against an Ollama / OpenAI-compatible endpoint (the consult
// modelJudge transport). Throws on any transport/HTTP failure; the caller
// treats every throw as "no enrichment".
export async function callChatModel(system, user, opts) {
  const res = await fetch(`${String(opts.modelUrl).replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs || 15000),
  });
  if (!res.ok) throw new Error(`capture model endpoint ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// The enrichment pass: classify the regex-miss messages and fold the hits into
// the session counts. NEVER throws and never degrades the deterministic result —
// any failure (endpoint down, timeout, junk output) returns the input counts.
//   opts — captureModelOptsFromEnv shape; opts.call is injectable for tests.
export async function enrichCountsWithModel(batch, counts, opts = {}) {
  if (!opts.model) return { counts, added: 0 };
  const prompts = regexMissPrompts(batch);
  if (!prompts.length) return { counts, added: 0 };
  try {
    const { system, user } = buildDetectPrompt(prompts);
    const call = opts.call || callChatModel;
    const hits = parseDetectResponse(await call(system, user, opts), prompts.length);
    return mergeModelCounts(counts, hits);
  } catch {
    return { counts, added: 0 };                   // enrichment only — regex counts always land
  }
}
