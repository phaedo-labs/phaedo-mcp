// Phaedo capture — reconstructed {role, text} turns → exchange_batch.
//
// The tier-agnostic front door for capture surfaces that read a RENDERED transcript
// (the Track B OS-accessibility helper: Claude Desktop's chat tab, later an OCR tier)
// rather than Claude Code's JSONL. It emits the SAME exchange_batch shape transcript.js
// produces (recordsToBatch), so everything downstream — detectors, state, delta-lift,
// deposit — consumes it unchanged. The only thing that differs per surface is how the
// turns are obtained; this module is where a11y/OCR/JSONL converge onto one pipeline.
//
// Pure: no model, no network, no persistence. The turns' raw text lives here only as the
// returned in-memory batch; the caller runs detectors and discards it (the discard-raw
// contract, architecture/persona-vs-conversation-memory.md).
//
// Turn shape (what the native front-end emits, one object per rendered turn IN ORDER):
//   { role: 'user' | 'assistant', text: string, id?: string, timestamp?: string }
// Anything else (role 'system'/'tool', empty text, a leading assistant turn with no
// preceding user prompt) is ignored, mirroring transcript.js's isUserPrompt/isAssistant
// filtering — so a UI label or a streamed-but-partial turn can't fabricate an exchange.

const PLATFORM = 'a11y';

// Turns → exchange_batch. Each user turn is paired with the assistant text that follows
// it (concatenated across consecutive assistant turns) up to the next user turn. A
// trailing user turn with no reply yet is dropped (incomplete exchange), matching both
// the web path and transcript.js. `user_prompts` collects EVERY genuine user turn (Path-A
// counts at send time, so an unanswered correction still counts).
//   turns — array of { role, text, id?, timestamp? }.
//   opts.sessionId — a STABLE per-conversation id (the front-end derives it, e.g. from the
//     first user message, so re-reading the same chat REPLACES that session's counts in
//     state.js instead of double-counting — the same idempotency the JSONL hook relies on).
//   opts.platform — surface tag for the exchange records (default 'a11y').
export function turnsToBatch(turns, opts = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const sessionId = opts.sessionId || null;
  const platform = opts.platform || PLATFORM;

  const exchanges = [];
  const user_prompts = [];
  let pending = null;
  let replyParts = [];
  let seq = 0;

  const flush = () => {
    if (pending && replyParts.length) {
      const ai = replyParts.join('\n').trim();
      if (ai) {
        exchanges.push({
          exchange_id: pending.id,
          session_id: sessionId,
          platform,
          timestamp: pending.timestamp,
          user_msg: pending.text,
          ai_response: ai,
          delta_annotations: {},   // filled by the caller's detector pass (accumulateBatchCounts)
        });
      }
    }
    pending = null;
    replyParts = [];
  };

  for (const t of list) {
    if (!t || typeof t.text !== 'string') continue;
    const text = t.text.trim();
    if (!text) continue;
    if (t.role === 'user') {
      flush();                                  // close any previous exchange first
      user_prompts.push(text);                  // count Path-A per sent prompt
      pending = { id: (typeof t.id === 'string' && t.id) || `ex-${seq++}`, text, timestamp: t.timestamp || null };
    } else if (t.role === 'assistant' && pending) {
      replyParts.push(text);                    // a leading assistant turn (no pending) is ignored
    }
  }
  flush();                                      // close the final exchange

  return { exchange_batch_version: 'v0.1', session_local_id: sessionId, exchanges, user_prompts };
}
