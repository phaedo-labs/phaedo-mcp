// §10.2 `action_binding` — tying a consultation to the call it claims to describe.
//
// THE PROBLEM. Every field the resolver decides on lives in `action_descriptor`,
// and every one of them is authored by the agent being gated: domain, magnitude,
// reversible, amount, summary. A standing authorization like
//
//     { match: { domains: ["writing"], magnitude_max: "medium", reversible: true },
//       effect: "autoproceed" }
//
// therefore fires on whatever the agent SAYS it is doing, not on what it is doing.
// A buggy, prompt-injected, or hostile agent auto-proceeds on anything by
// describing it as low-magnitude reversible writing. The escalation rail inherits
// the same assumption: the subject approves the agent's prose summary.
//
// This is a known 2026 vulnerability class, not a hypothetical — agents requesting
// approval on a shown path while operating on the resolved target (CWE-61 symlink
// following + CWE-451 UI misrepresentation) produced CVE-2026-12958 (Amazon) and
// CVE-2026-50549 (Cursor), among others.
//
// WHAT THIS DOES, AND WHAT IT DOES NOT. A binding does NOT make the descriptor
// truthful — nothing at this layer can, short of the resolver executing the call
// itself. What it does:
//
//   1. makes a mismatch PROVABLE after the fact (the receipt records the exact
//      tool and a hash of its arguments, so the agent's own logs can be checked
//      against what the oracle was told),
//   2. gives the subject the REAL call on the escalation card, next to the
//      agent's description of it, and
//   3. lets an authored authorization demand a binding before it will RELAX
//      anything (§10.5 `require_binding`), so the blast radius of a fabricated
//      descriptor is bounded by what the subject explicitly opted into.
//
// The hash is over the RFC 8785 canonical form of the arguments, so an agent and
// an auditor computing it independently agree byte-for-byte. Arguments themselves
// are NEVER carried — only a digest, plus an optional short human preview that the
// subject sees on the escalation sheet.
//
// PURE: no I/O, no globals, no crypto beyond the hash the caller injects. Shared by
// the resolver (mcp/consult-core.js), the receipt writer (mcp/receipts.js) and the
// escalation payload builder (mcp/escalation.js) so the three cannot drift.

import { PhaedoError } from './errors.js';

// A preview is for a human glance on a phone sheet, not a serialization format.
export const PREVIEW_MAX = 200;
export const TOOL_NAME_MAX = 120;
// A hex or base64url digest. Bounded so a malformed field can't bloat the receipt
// store or the (encrypted) escalation payload.
const HASH_RE = /^[A-Za-z0-9_-]{16,128}$/;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clip = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

// Parse + validate §10.2 `action_binding`. Returns the normalized binding, or null
// when absent. THROWS `request_malformed` when present but structurally wrong — a
// half-formed binding is worse than none, because a caller could believe it is
// bound when the resolver treats it as unbound.
export function normalizeActionBinding(raw) {
  if (raw == null) return null;
  if (!isObj(raw)) throw new PhaedoError('request_malformed', 'action_binding must be an object.');

  const toolName = typeof raw.tool_name === 'string' ? raw.tool_name.trim() : '';
  if (!toolName) throw new PhaedoError('request_malformed', 'action_binding.tool_name is required and must be a non-empty string.');
  if (toolName.length > TOOL_NAME_MAX) throw new PhaedoError('request_malformed', `action_binding.tool_name exceeds ${TOOL_NAME_MAX} characters.`);

  const hash = typeof raw.arguments_hash === 'string' ? raw.arguments_hash.trim() : '';
  if (!hash) throw new PhaedoError('request_malformed', 'action_binding.arguments_hash is required and must be a non-empty string.');
  if (!HASH_RE.test(hash)) throw new PhaedoError('request_malformed', 'action_binding.arguments_hash must be a hex or base64url digest (16–128 chars).');

  const out = { tool_name: clip(toolName, TOOL_NAME_MAX), arguments_hash: hash };
  if (typeof raw.arguments_preview === 'string' && raw.arguments_preview.trim()) {
    out.arguments_preview = clip(raw.arguments_preview, PREVIEW_MAX);
  }
  return out;
}

// Is this request bound to a concrete call? The single predicate every consumer
// asks, so "bound" means exactly one thing across the resolver, the policy engine,
// the receipt and the escalation card.
export function isBound(binding) {
  return !!(binding && binding.tool_name && binding.arguments_hash);
}
