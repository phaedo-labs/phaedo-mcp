// Phaedo — how far a CACHED profile copy may be trusted to apply one of the subject's own
// relaxing rules (a §10.5 `autoproceed` grant or a `bias_bold`). One definition, shared by the
// Claude Code ship hook (hooks/pre-ship.mjs) and the server's stale-authority guard (server.js),
// so the two paths cannot drift apart again.
//
// THE RISK. A rule is revocable on the phone, and a revocation reaches this computer only with
// the next live read. A cached copy may predate it — the 2026-07-25 incident, where a withdrawn
// $500 payment permission kept working from a 22-hour-old copy. So by default a cached copy may
// NOT apply a rule.
//
// THE LEEWAY (Randy, 2026-10-31: "align them"). A live read needs the subject to approve on the
// phone, so "live only" means a rule almost never fires. For the cheap end of the risk, a cached
// copy may apply the rule when ALL hold:
//   - the action is reversible (stated `true`);
//   - its magnitude is stated `low` or `medium` (never high, never unstated);
//   - it moves no money (no `amount`) — every priced action stays live-only;
//   - the copy is at most RULE_FRESH_DAYS old, which caps how long a withdrawn rule can act;
//   - no rejected / modified outcome in that domain within RULE_PUSHBACK_DAYS — one "no" on
//     this computer stops it at once, before the phone's revocation has arrived.
// Anything else keeps the strict rule. PURE: no I/O, `now` injected.

import { canonicalDomain, normalizeDomain } from './domain.js';

export const RULE_FRESH_DAYS = 7;
export const RULE_PUSHBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEEWAY_MAGNITUDES = new Set(['low', 'medium']);
// Receipts store the canonical domain; a request may carry an alias or other casing. Compare
// canonical forms, so "code" and "engineering" are one class here as they are on the receipt.
const domainKey = (x) => (typeof x === 'string' && x.trim() ? (canonicalDomain(x) || normalizeDomain(x) || '') : '');

/**
 * May a cached copy apply the subject's relaxing rule to this action?
 * (source: sourceOf(read), descriptor: the request's action_descriptor, receipts, now)
 * → { ok: true } | { ok: false, why } where why ∈ not_reversible | high | magnitude_unstated | priced
 *   | stale | pushback.
 * The age gate applies only to a cached read; every other gate applies to any read.
 */
export function ruleLeeway({ source, descriptor, receipts, now = Date.now() } = {}) {
  const d = descriptor && typeof descriptor === 'object' ? descriptor : {};
  if (d.reversible !== true) return { ok: false, why: 'not_reversible' };
  const mag = typeof d.magnitude === 'string' ? d.magnitude.toLowerCase() : null;
  if (!LEEWAY_MAGNITUDES.has(mag)) return { ok: false, why: mag === 'high' ? 'high' : 'magnitude_unstated' };
  if (d.amount != null) return { ok: false, why: 'priced' };
  if (source && source.live === false && !(Number.isFinite(source.ageMs) && source.ageMs <= RULE_FRESH_DAYS * DAY_MS)) {
    return { ok: false, why: 'stale' };
  }
  const domain = domainKey(d.domain);
  const since = now - RULE_PUSHBACK_DAYS * DAY_MS;
  const pushback = (Array.isArray(receipts) ? receipts : []).some((r) =>
    (r?.user_action === 'rejected' || r?.user_action === 'modified')
    && domainKey(r?.request?.action_descriptor?.domain) === domain
    && Date.parse(r?.user_action_at || r?.created_at) >= since);
  if (pushback) return { ok: false, why: 'pushback' };
  return { ok: true };
}
