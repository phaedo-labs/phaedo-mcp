// §10.7 — fatigue-aware autonomy promotion.
//
// THE PROBLEM THIS SOLVES. Phaedo can add a gate and never remove one. The
// delegation-promotion channel learns only from DISAGREEMENTS
// (consult-core.js `buildDelegationPromotions`), and §10.5 permanently caps what
// an authored disposition may do at `bias_cautious`: "an authored disposition may
// make the agent MORE deferential, never less." Expanding autonomy requires the
// subject to hand-author a `kind:"authorization"` rule with a `match`. Almost
// nobody will. So in real use the oracle accumulates friction and never sheds it,
// and the 2026 approval-fatigue literature is unanimous about where that ends:
// approval stops being a decision and becomes a reflex, which is both a usability
// failure and an attack surface.
//
// THE OBJECTION, AND WHY IT SHAPES THE DESIGN. "Learn from approvals" is exactly
// what the honesty rail forbids — rubber stamps must not teach. That objection is
// correct, and it is the reason this module is not a counter. A subject clicking
// approve fourteen times in ninety seconds is not expressing a policy; they are
// tired. So the gate here is not "how many approvals" but "is this evidence of
// DELIBERATION":
//
//   - spread over distinct days, not a single sitting (volume ≠ deliberation)
//   - no contrary evidence at all: one rejection or modification in the class kills it
//   - the oracle must already be tracking the subject well in that domain
//     (agreement rate — the interlock the agreement read-out exists to provide)
//   - not batch-marked: approvals recorded in one burst are bookkeeping, not consent
//
// AND WHAT IS PROPOSED IS DELIBERATELY SMALL. Reversible only. Never `high`
// magnitude. A priced class is bounded by an `amount_lt` CEILING set to the
// SECOND-highest amount approved, never the highest — one outlier must not set the
// bar (see spendCeiling). Always `require_binding: true`, so the relaxation cannot
// be unlocked by a fabricated descriptor. Always `expires_at`, so an autonomy grant
// the subject stops wanting lapses by itself.
//
// AND IT IS STILL ONLY A PROPOSAL. This writes nothing authored. It stages a
// `suggested_rules` entry the subject reviews and endorses, exactly like every
// other promotion channel — the authored-only invariant holds. The producer
// stages; the user authors.
//
// PURE: (receipts, fp, agreement, opts) -> suggestions[]. No I/O, no globals.

import { computeAgreement, DEFAULT_WINDOW_DAYS } from './agreement.js';

// ── The bar. Every one of these is a way of asking "was this deliberate?" ─────
export const MIN_APPROVALS = 5;          // enough instances to be a pattern
export const MIN_DISTINCT_DAYS = 3;      // ...spread across days, not one sitting
export const MIN_AGREEMENT = 0.8;        // ...in a domain the oracle already tracks well
export const MIN_AGREEMENT_SCORED = 5;   // ...on enough scored decisions to mean anything
export const BATCH_WINDOW_MS = 60_000;   // marks this close together are bookkeeping
export const MAX_BATCH_FRACTION = 0.5;   // ...and may not carry the majority of the evidence
export const DEFAULT_TTL_DAYS = 30;      // a grant expires unless re-earned

const DAY_MS = 24 * 60 * 60 * 1000;
const MAG_RANK = { low: 0, medium: 1, high: 2 };
const RANK_MAG = ['low', 'medium', 'high'];

const uuid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : `aut-${Math.random().toString(36).slice(2, 10)}`;

const utcDay = (iso) => String(iso || '').slice(0, 10);   // RFC 3339 → YYYY-MM-DD

// A promotable class is (domain × reversible-true). Magnitude is not part of the
// key — it is the CEILING we derive from what was actually observed, so a class
// seen only at `low` never proposes a rule that would fire at `medium`.
function classKey(domain) { return String(domain || '').toLowerCase(); }

// Receipts that count as evidence FOR autonomy in a class. Deliberately narrow:
// the oracle must have been decisive, the subject must have approved, and the
// action must be one we would ever propose relaxing.
function isPromotableApproval(r) {
  const ad = r?.request?.action_descriptor || {};
  if (r?.user_action !== 'approved') return false;
  if (r?.response?.signal !== 'proceed' && r?.response?.signal !== 'proceed_with_note') return false;
  if (ad.reversible !== true) return false;                       // irreversible is never auto-proceeded
  if (ad.magnitude === 'high') return false;                      // nor is a major action
  if (ad.amount !== undefined && !(typeof ad.amount === 'number' && Number.isFinite(ad.amount) && ad.amount >= 0))
    return false;                                                 // a malformed amount is not evidence of anything
  if (!ad.domain) return false;                                   // an unscoped autoproceed rule is a blank cheque
  return true;
}

// The spend ceiling for a money class: the SECOND-highest amount approved, not the
// highest.
//
// Using the maximum would let ONE outlier set the bar — approve five $20 orders and a
// single $500 one, and the rule would thereafter auto-proceed anything up to $500.
// Requiring two approvals at a level before the rule reaches it is the money-shaped
// version of the "spread across days, not one sitting" rule: a bound has to be
// demonstrated more than once.
//
// Returns null when the class carries no amounts at all (then no ceiling is needed),
// or when fewer than two priced approvals exist (then no ceiling can be justified, so
// the class is not promotable).
export function spendCeiling(receipts) {
  const amounts = receipts
    .map((r) => r?.request?.action_descriptor?.amount)
    .filter((a) => typeof a === 'number' && Number.isFinite(a));
  if (!amounts.length) return null;                 // unpriced class — no ceiling needed
  if (amounts.length < 2) return undefined;         // one priced approval cannot justify a bound
  const sorted = amounts.slice().sort((a, b) => b - a);
  return sorted[1];
}

// Anything that argues AGAINST relaxing this class. One is enough to disqualify:
// a class the subject has ever rejected or edited is not settled.
function isContraryEvidence(r, domain) {
  const ad = r?.request?.action_descriptor || {};
  if (classKey(ad.domain) !== domain) return false;
  return r?.user_action === 'rejected' || r?.user_action === 'modified';
}

// Were these approvals RECORDED in a burst? Marking a screenful of receipts in one
// pass is bookkeeping, not consent — so if most of the supporting evidence was
// stamped inside one short window, it does not support a policy. Receipts without
// a mark timestamp (older stores) are treated as non-batch: absence of evidence
// is not evidence of fatigue, and the other gates still apply.
export function batchFraction(receipts, { windowMs = BATCH_WINDOW_MS } = {}) {
  const stamps = receipts
    .map((r) => Date.parse(r?.user_action_at))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (stamps.length < 2) return 0;
  let best = 1;
  for (let i = 0; i < stamps.length; i++) {
    let j = i;
    while (j < stamps.length && stamps[j] - stamps[i] <= windowMs) j++;
    best = Math.max(best, j - i);
  }
  return best / receipts.length;
}

function proposedText(domain, magMax, ceiling = null) {
  const scope = magMax === 'low' ? 'small, reversible' : 'routine, reversible';
  // The ceiling is the single most consequential term on a money rule, so it belongs
  // in the sentence the subject reads — not only in the terms line beneath it.
  const under = ceiling !== null ? ` under ${ceiling}` : '';
  return `Let agents go ahead with ${scope} ${domain} actions${under} without asking me first.`;
}

// (receipts, fp, opts) -> suggestion[]  — the §10.5 authorizations worth PROPOSING.
//
// `fp` supplies what is already authored or already staged, so an endorsed or
// pending suggestion is never re-proposed (the no-nag rule every promotion
// channel follows).
export function buildAutonomyPromotions(receipts, fp, opts = {}) {
  const {
    now = Date.now(),
    windowDays = DEFAULT_WINDOW_DAYS,
    minApprovals = MIN_APPROVALS,
    minDistinctDays = MIN_DISTINCT_DAYS,
    minAgreement = MIN_AGREEMENT,
    minAgreementScored = MIN_AGREEMENT_SCORED,
    maxBatchFraction = MAX_BATCH_FRACTION,
    ttlDays = DEFAULT_TTL_DAYS,
  } = opts;

  const list = Array.isArray(receipts) ? receipts : [];
  const since = now - windowDays * DAY_MS;
  const inWindow = list.filter((r) => {
    const t = Date.parse(r?.created_at);
    return Number.isFinite(t) && t >= since && t <= now;
  });

  // Already covered? An authored autoproceed for the domain, or a live suggestion.
  const authored = new Set(
    (Array.isArray(fp?.standing_rules) ? fp.standing_rules : [])
      .filter((r) => r?.kind === 'authorization' && r?.effect === 'autoproceed')
      .flatMap((r) => (Array.isArray(r?.match?.domains) ? r.match.domains : []).map(classKey)),
  );
  const staged = new Set(
    (Array.isArray(fp?.suggested_rules) ? fp.suggested_rules : [])
      .filter((s) => s?.source === 'autonomy_promotion')
      .flatMap((s) => (Array.isArray(s?.match?.domains) ? s.match.domains : []).map(classKey)),
  );

  const agreement = computeAgreement(list, { windowDays, now });

  const byClass = new Map();
  for (const r of inWindow) {
    if (!isPromotableApproval(r)) continue;
    const key = classKey(r.request.action_descriptor.domain);
    const bucket = byClass.get(key) || { receipts: [], days: new Set(), magRank: 0, clients: new Set() };
    bucket.receipts.push(r);
    bucket.days.add(utcDay(r.created_at));
    bucket.magRank = Math.max(bucket.magRank, MAG_RANK[r.request.action_descriptor.magnitude] ?? 0);
    // §10.5 scoping (step 5): WHICH paired client's actions earned this. Recorded from
    // the receipt's `client_id` — the serving client, established out-of-band with the
    // phone — never from `agent_id`, which is the caller's claim about itself.
    if (typeof r.client_id === 'string' && r.client_id) bucket.clients.add(r.client_id);
    byClass.set(key, bucket);
  }

  const out = [];
  for (const [domain, bucket] of byClass) {
    if (authored.has(domain) || staged.has(domain)) continue;          // no-nag
    if (bucket.receipts.length < minApprovals) continue;               // not yet a pattern
    if (bucket.days.size < minDistinctDays) continue;                  // one sitting is not a policy
    if (inWindow.some((r) => isContraryEvidence(r, domain))) continue; // any pushback disqualifies the class
    if (batchFraction(bucket.receipts, opts) > maxBatchFraction) continue;  // batch-marked = bookkeeping

    // The interlock: don't hand autonomy to an oracle that isn't tracking this
    // subject here. `(none)` is how computeAgreement keys undomained receipts.
    const dom = agreement.domains[domain];
    if (!dom || dom.scored < minAgreementScored || dom.rate === null || dom.rate < minAgreement) continue;

    // Money needs a ceiling, and a ceiling needs to have been demonstrated twice.
    // `undefined` means the class is priced but cannot justify a bound — skip it
    // rather than propose an unbounded spend authorization.
    const ceiling = spendCeiling(bucket.receipts);
    if (ceiling === undefined) continue;
    if (ceiling !== null && !(ceiling > 0)) continue;                  // a 0 ceiling can never match

    const magMax = RANK_MAG[bucket.magRank] || 'low';

    // §10.5 `agents` — scope the proposed grant to the clients that EARNED it.
    //
    // Only meaningful now that scoping is enforced (v0.1.53) and authorable on the
    // phone (#197). Before that, writing this field would have shipped something that
    // looked like a boundary and was not — the reason it was deliberately left off.
    //
    // Strictly narrowing versus the previous behaviour, which granted every paired
    // client whatever any one of them earned. A client that contributed approvals but
    // cannot be attributed (receipts written before v0.1.53 carry no `client_id`) is
    // simply left out — it keeps asking, which is the fail-safe direction.
    //
    // The empty case is the one that matters: when NO receipt in the class can be
    // attributed, the field is OMITTED rather than written as `[]`. Absent means
    // unscoped (today's behaviour, preserved for pre-v0.1.53 history); `[]` means a
    // scope naming nobody, which would stage a grant that can never fire. Getting
    // those two confused is precisely the defect the v0.1.54 hardening pass caught.
    const agents = [...bucket.clients].sort();
    out.push({
      suggestion_id: uuid(),
      status: 'suggested',
      kind: 'authorization',
      source: 'autonomy_promotion',
      proposed_text: proposedText(domain, magMax, ceiling),
      match: {
        domains: [domain],
        reversible: true,
        magnitude_max: magMax,
        ...(ceiling !== null ? { amount_lt: ceiling } : {}),
      },
      effect: 'autoproceed',
      // Non-negotiable on a PROPOSED relaxation: it may only apply to a request
      // bound to a concrete call, and it lapses unless the subject re-earns it.
      require_binding: true,
      expires_at: new Date(now + ttlDays * DAY_MS).toISOString(),
      ...(agents.length ? { agents } : {}),
      note: agents.length
        // Say the grant is limited, without printing an opaque `c_…` the subject
        // cannot recognise — only the phone holds the registry that names it.
        ? `you have approved every ${domain} action like this that Phaedo has seen — limited to the agent that earned it`
        : `you have approved every ${domain} action like this that Phaedo has seen`,
      evidence: {
        observation_count: bucket.receipts.length,
        distinct_days: bucket.days.size,
        agreement_rate: dom.rate,
        evidence_basis: 'observed',
        last_observed: bucket.receipts[bucket.receipts.length - 1]?.created_at || null,
        // Provenance for the audit: how many paired clients this evidence came from,
        // and whether any of it predates client attribution. Distinct from `agents`,
        // which is the enforceable scope.
        client_count: bucket.clients.size,
        unattributed: bucket.receipts.some((r) => !(typeof r.client_id === 'string' && r.client_id)),
      },
      created: new Date(now).toISOString(),
    });
  }
  // Deterministic order — this rides a last-write-wins mailbox deposit.
  return out.sort((a, b) => a.match.domains[0].localeCompare(b.match.domains[0]));
}
