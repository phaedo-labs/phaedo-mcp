// Phaedo capture — Claude Code transcript → exchange_batch.
//
// Track A of the desktop-capture plan (docs/roadmap/desktop-capture-helper.md):
// the Claude Code / Cowork capture hook reads the local session JSONL and turns it
// into the SAME exchange_batch the extension's Loop 2 produces (loop2-capture
// buildBatchPayload shape), so the surface-agnostic extraction engine
// (extraction/orchestrator.js) consumes it unchanged.
//
// Pure parsing only — no model, no network, no persistence. Raw transcript text
// lives here only as the returned in-memory batch; the caller runs extraction and
// discards it (the discard-raw contract, architecture/persona-vs-conversation-memory.md).
//
// Claude Code writes one JSON object per line to
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. The fields we rely on are the
// stable ones (type, timestamp, sessionId, message.role, message.content); the format
// is internal and can drift, so every access is defensive and a malformed line is
// skipped rather than thrown (a broken transcript must never corrupt the fingerprint).

const PLATFORM = 'claude-code';

// Pull plain text out of a message.content that is either a string or an array of
// content blocks. Only 'text' blocks count — 'thinking', 'tool_use', 'tool_result'
// and images are not conversational prose and are ignored.
function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

// A user line is a genuine subject prompt only when it is a real typed human turn.
// EXCLUDES machine-authored records that Claude Code writes as user-role lines:
//   - isMeta:true    — resume text ("Continue from where you left off"), slash-command
//                      expansions, "[Request interrupted by user]", harness notices;
//   - isSidechain:true — subagent (Task tool) turns, authored by the assistant;
//   - isVisibleInTranscriptOnly / isCompactSummary — injected/synthetic context.
// Without this filter the detectors mine documentation and harness text and fabricate
// source='delta' signals that reach max confidence (the capture-review finding).
function isMachineAuthored(rec) {
  return !!(rec && (rec.isMeta || rec.isSidechain || rec.isVisibleInTranscriptOnly || rec.isCompactSummary));
}
function isUserPrompt(rec) {
  return rec && rec.type === 'user' && rec.message && rec.message.role !== 'assistant'
    && !isMachineAuthored(rec);
}
function isAssistant(rec) {
  return rec && rec.type === 'assistant' && rec.message && !rec.isSidechain;
}

// The active conversation path only. The transcript is an append-only uuid/parentUuid
// TREE: an esc-esc edit/rewind leaves the abandoned branch in the file alongside the
// retry. A linear scan emits an exchange for EVERY branch, so one edited correction is
// counted N times (the capture-review finding). We walk parentUuid from the leaf (the
// last record — the most recent append is always on the live path) back to the root and
// keep only that chain. Falls back to all records when the tree can't be reconstructed
// (missing uuids / older format) so nothing breaks.
function activePathRecords(recs) {
  const byUuid = new Map();
  for (const r of recs) if (r && r.uuid) byUuid.set(r.uuid, r);
  // No usable tree → linear (current behavior, safe).
  if (byUuid.size < 2) return recs;
  let leaf = null;
  for (let i = recs.length - 1; i >= 0; i--) { if (recs[i] && recs[i].uuid) { leaf = recs[i]; break; } }
  if (!leaf) return recs;
  const onPath = new Set();
  let cur = leaf, guard = 0;
  while (cur && guard++ < byUuid.size + 1) {
    onPath.add(cur.uuid);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null;
  }
  // If the walk covered almost nothing (broken/mixed parent links), don't trust it.
  if (onPath.size < 2) return recs;
  return recs.filter((r) => !r || !r.uuid || onPath.has(r.uuid));
}

// Parse a raw JSONL string (or a pre-split array of lines) into records, skipping
// blank and malformed lines. Exported for callers that already hold the text.
export function parseJsonl(text) {
  const lines = Array.isArray(text) ? text : String(text || '').split('\n');
  const out = [];
  for (const line of lines) {
    const s = typeof line === 'string' ? line.trim() : '';
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip a torn/partial line */ }
  }
  return out;
}

// Records → exchange_batch. Each user prompt is paired with the assistant text that
// follows it (concatenated across multiple assistant lines) up to the next user
// prompt. A trailing user prompt with no reply yet is dropped (incomplete exchange),
// matching the web path's complete-only shipping.
//   records — array already parsed (parseJsonl), or a raw JSONL string.
//   opts.sessionId — override; otherwise taken from the first record's sessionId.
// Returns { exchange_batch_version, session_local_id, exchanges: [...] }.
export function recordsToBatch(records, opts = {}) {
  const parsed = typeof records === 'string' ? parseJsonl(records) : (Array.isArray(records) ? records : []);
  const recs = activePathRecords(parsed);   // drop abandoned edit/rewind branches
  const sessionId = opts.sessionId
    || recs.find((r) => r && r.sessionId)?.sessionId
    || null;

  const exchanges = [];
  const user_prompts = [];                  // EVERY genuine user prompt (answered or not)
  let pending = null;                       // the open user prompt awaiting a reply
  let replyParts = [];

  const flush = () => {
    if (pending && replyParts.length) {
      const ai = replyParts.join('\n').trim();
      if (ai) {
        exchanges.push({
          exchange_id: pending.id,
          session_id: sessionId,
          platform: PLATFORM,
          timestamp: pending.timestamp,
          user_msg: pending.text,
          ai_response: ai,
          delta_annotations: {},            // Path-A detector output is filled in by the caller (slice 2)
        });
      }
    }
    pending = null;
    replyParts = [];
  };

  for (const rec of recs) {
    if (isUserPrompt(rec)) {
      const text = contentText(rec.message.content);
      if (!text) continue;                  // tool_result-only user line — not prose
      flush();                              // close any previous exchange first
      user_prompts.push(text);              // count Path-A per SENT prompt (extension parity)
      pending = { id: rec.uuid || `ex-${exchanges.length}`, text, timestamp: rec.timestamp || null };
    } else if (isAssistant(rec) && pending) {
      const text = contentText(rec.message.content);
      if (text) replyParts.push(text);
    }
  }
  flush();                                  // close the final exchange

  // exchanges = COMPLETE pairs (for the future model/Loop-2 path); user_prompts = every
  // sent prompt (for Path-A counters — the web path counts at SEND time, so an
  // interrupted / unanswered correction must still count, unlike exchange shipping).
  return { exchange_batch_version: 'v0.1', session_local_id: sessionId, exchanges, user_prompts };
}

// Convenience: raw JSONL text → batch in one call.
export function transcriptToBatch(text, opts = {}) {
  return recordsToBatch(parseJsonl(text), opts);
}
