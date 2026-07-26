// Phaedo capture — the merge-owner precedence predicate.
//
// Resolves open question Q3 of docs/roadmap/desktop-capture-deposit.md. A capture
// surface deposits a signal delta to the `capture_to_owner` mailbox lane; exactly ONE
// device drains and reconciles it. Which device is the owner is a presence-based
// precedence ROLE, not a hardwired device:
//
//   1. phone       — if a phone is paired (canonical vault owner; re-broadcasts §5)
//   2. extension   — else, if the extension is present (today's browser-primary user)
//   3. mcp-local   — else (phone-less + browser-less desktop/CLI — the Claude Code dev)
//
// Anti-deadlock (the Q3 concern — "confirm the claim rule can't have BOTH yield"):
// the order is TOTAL and MONOTONIC in presence. The top tier (phone) never yields;
// each lower tier yields only when a STRICTLY HIGHER tier is present. So there is
// always exactly one owner and never zero — "both yield" is unreachable. A pairing
// still verifying counts as NOT present (fail toward the lower, always-available
// tier), so the extension keeps owning until the phone's pairing is verified, then
// yields; the brief two-owner overlap during that handoff is harmless because the
// reconcile is per-source idempotent (Q2 / §3).

export const TIERS = ['phone', 'extension', 'mcp-local'];

// presence — { phonePaired?: bool, extensionPresent?: bool }. Unknown/undefined
// treated as absent (fail toward the always-available mcp-local tier).
export function resolveMergeOwner(presence = {}) {
  if (presence.phonePaired) return 'phone';
  if (presence.extensionPresent) return 'extension';
  return 'mcp-local';
}

// Does `tier` own the capture lane given this presence? Exactly one tier is true for
// any presence, so a drainer calls isOwner(myTier, presence) to decide whether to drain.
export function isOwner(tier, presence = {}) {
  return resolveMergeOwner(presence) === tier;
}
