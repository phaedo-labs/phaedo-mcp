# 0009 — Situational precedent at the consultation boundary

Status: **Draft — not normative.** Written 2026-09-13; matured 2026-10-27 (precedent track Phase 2).
The derived view is implemented as a dev-only readout (`mcp/precedent.js`, `npm run precedent`); it
is **not** wired into consult and nothing here changes the wire until a later version says so.
**Reviewed by Randy 2026-10-27 — all four open recommendations accepted (see "Decided"); Phase 2
exit passed.** Still a draft: it stays one until rejections are captured (Decided, 3).
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
    "shape": {
      "domain": "engineering", "kind": "merge", "reversible": true, "magnitude": "medium",
      "amount_band": "none", "size": "normal", "touched": "ordinary", "binding": "shell"
    },
    "shape_revision": "2026-10-27.v0",
    "observed": 7,
    "user_actions": { "approved": 7, "rejected": 0, "modified": 0 },
    "oracle_agreement": 1.0,
    "window_days": 180,
    "most_recent_divergence_days_ago": null,
    "preflight": { "observed": 0, "user_actions": { "approved": 0, "rejected": 0, "modified": 0 } }
  }
}
```

`shape` is the situation key. Every field is a closed vocabulary read from what the receipt already
holds — no new capture:

| Field | Values | Read from |
|---|---|---|
| `domain` | §10.2 canonical term, else the normalized free-text domain | `action_descriptor.domain` |
| `kind` | `merge`, `deploy`, `push to main`, `force-push`, `publish`, `release`, `message`, `payment`, `delete`, … `other` | the summary, classified; the summary itself never crosses |
| `reversible` | `true` / `false` / `null` | `action_descriptor.reversible` |
| `magnitude` | `low` / `medium` / `high` / `null` | `action_descriptor.magnitude` (the agent's description) |
| `amount_band` | `none` / `low` / `medium` / `high` | the amount against the subject's own edges (G8 B1 `amountBand` driver) |
| `size` | `normal` / `large` / `null` | the `diffStakes` driver, when the change was read |
| `touched` | `ordinary` / `sensitive` / `null` | the `diffStakes` driver, when the change was read |
| `binding` | `shell` / `connected_app` / `agent_tool` / `none` | `action_binding.tool_name` |

`null` means "not observed", never a guess, and is its own key value. A coarser match uses a subset of
fields. `shape_revision` versions the key the way `resolverRevision` versions the resolver, so
precedent computed under one key is never silently compared with another.

Only **divergence episodes** — a decisive prediction that did not match what the subject did — are
worth keeping as episodes (the Principle); the view also exposes them, banded, newest first.

### What the first real data says (2026-10-27)

Run against the primary store (22 usable marked decisions in 180 days):

- **Full key:** 2 shapes reach N=5 (merges, 7×; a finance escalation shape, 8×), 3 do not.
- **Coarse key** (`domain × kind × reversible × magnitude`): the same merges collapse to 11×.
  The full key split one real situation three ways because older merge receipts predate the diff
  read (`size`/`touched` = `null`). Key coarseness is therefore a data question, not a taste one.
- **"No" is nearly invisible.** Claude Code fires no hook when the subject denies a permission
  prompt, so a rejection reaches the store only if the agent records it. Merges show 13 yes / 0 no;
  that zero is partly a capture gap, and it biases `oracle_agreement` upward. Until rejections are
  captured as reliably as approvals, precedent on hook-collected shapes overstates agreement.

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

1. ~~Phase 1 — in-flow outcome collection.~~ **Exit passed 2026-10-27**: `npm run agreement` returns a
   non-null rate (engineering, 12/12 scored); by resolver revision 7/7 and 5/5.
2. ~~Phase 2 — the key and the bands.~~ **Exit passed 2026-10-27**: banding function pure and tested
   (`mcp/precedent.js`, 51 checks); this proposal matured to match; Randy reviewed it and accepted
   all four recommendations below.
3. **Phase 3 — next.** "No" capture built for Claude Code (0.3.14; Decided, 3); let it gather; then a TC conformance category
   for banding on the coarse key; then a spec version that lets the field appear on the wire,
   confidence-only (Decided, 4).

## Decided (Randy's review, 2026-10-27)

1. **Key coarseness → coarse key first.** v1 matches on `domain × kind × reversible × magnitude`.
   `size`, `touched` and `amount_band` join the key once most receipts in a shape carry them.
2. **N and the window → N=5 within 180 days.** The implemented defaults stand.
3. **Capturing "no" → gate.** Precedent does not leave draft until rejections reach the store
   without the agent having to remember them (e.g. read from the next prompt after a denied
   permission), or until the agreement figure ships with the bias disclosed beside it.
   *Built for Claude Code 2026-10-27 (phaedo-mcp 0.3.14):* the ship hook reads the transcript's
   `toolDenialKind: "user-rejected"` mark at the next prompt or turn end. The gate clears once
   enough post-0.3.14 receipts exist that a shape's rejection rate is measured rather than
   missing; receipts from before it stay biased toward yes. Cursor, Copilot, Codex and Gemini
   still depend on the agent recording a no.
4. **Reach in v1 → confidence only.** Precedent may adjust `confidence`; it may not move a response
   from `escalate` to a decisive signal, and never to `autoproceed` (Rail 4).

## Open

- **Burst threshold.** Implemented: 3 marks inside 60 s are bookkeeping and excluded per receipt
  (the §10.7 gate is per bucket, as a fraction). Whether the two should converge.
- Disclosure: all paired agents, or scoped.
