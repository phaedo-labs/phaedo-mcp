# 0009 — Situational precedent at the consultation boundary

Status: **Draft — not normative.** Written 2026-09-13. Nothing here is implemented; nothing here
changes the wire until a later version says so.
Relates to: 0003 (standing authorizations), 0004 (consultation receipts), 0007 (authored decision
rules). Design and roadmap: `docs/roadmap/precedent-and-sync-design-2026-09-13.md`. Spec: §13 OQ24
(this proposal), OQ25 (synchronization state).

## Problem

A §10 consultation answers *dispositionally*: "this subject prefers thoroughness", "escalates
irreversible spend". An agent cannot act on a disposition; it can act on a precedent — *"you have
faced this shape six times; approved five, escalated once."* The §10.6 receipt store already
records every prediction (`response.signal`) and, when the subject marks it, the actual outcome
(`user_action`). Nothing reads those back as situations. `deriveDelegationSignals` collapses them
into per-(cue, domain) nudges, which throws the situation away.

## Principle

> Record an episode only when the agent's prediction of the user diverged from what the user
> actually did.

Agreement costs nothing and stores nothing; only divergence is kept. As fidelity improves the store
shrinks. This is what makes the approach minimal by construction rather than by cap, and it is why
this is **precedent, not memory** — see the "What NOT to build" rail in
`docs/competitive/capability-gap-analysis-2026-07-21.md`.

## Draft shape (non-normative)

Precedent is a **derived view over receipts**, not a stored artifact — pure, `now` injected, no I/O,
the same discipline as `mcp/agreement.js`. If it reaches the §10.3 response:

```json
{
  "precedent": {
    "shape": { "domain": "procurement", "reversible": true, "magnitude": "low", "amount_band": "lt_500" },
    "observed": 6,
    "user_actions": { "approved": 5, "rejected": 0, "modified": 1 },
    "oracle_agreement": 0.83,
    "window_days": 180,
    "most_recent_divergence_days_ago": 41
  }
}
```

`shape` is the situation key: canonical domain (§10.2 vocabulary) × `reversible` × `magnitude`
× amount **band** × binding tool class. The band edges, the minimum support and the window are
open (design doc §9).

## Rails proposed for normative status

1. **Banded features only cross §10.** No `summary`, no exact `amount`, no counterparty, no receipt
   identifiers. Receipts may hold these on-device; precedent may not carry them.
2. **Minimum support.** Below N observations the field is **absent or null — never a guess.**
3. **Subject-authored outcomes only.** Batch-marked outcomes are excluded, reusing the §10.7 gates.
4. **Precedent informs; it never authorizes.** Autonomy expansion has exactly one path — a §10.5
   authorization, reached via §10.7 promotion. Precedent MAY adjust `confidence` and MAY choose
   between a decisive signal and `escalate`; it MUST NOT produce `autoproceed` on its own.
5. **Pre-flight receipts** (`via: phaedo_check_authorization`) are weighted separately.
6. **OQ16 applies in full.** Outcomes are not yet authenticated as the subject's; precedent raises
   the stakes of that gap because it steers agents. Nothing in this proposal weakens the OQ16 rail.

## Sequencing

Blocked on outcome data. Measured 2026-09-13: 51 receipts on the primary machine, 9 scored, one
domain, none in the last 30 days. Phase 1 of the design doc (in-flow outcome collection) precedes
any implementation of this proposal.

## Open

- Band edges; whether binding class is in the shape.
- N and the window.
- Disclosure: all paired agents, or scoped.
- Whether precedent may move `escalate` → decisive in v1 (recommendation: confidence only).
