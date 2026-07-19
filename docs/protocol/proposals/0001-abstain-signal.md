# Proposal 0001 — Abstain signal (`insufficient_signal`)

**Status:** ✅ RATIFIED + FOLDED into v0.1.9 (2026-06-09), after implementation in the
reference resolver. Kept here as the rationale record. The §10.3 enum + response schema
now list `insufficient_signal`; the engine emits it (zero-coverage abstain floor in
`mcp/consult-core.js`); `spec/test-schemas.mjs` ties the two.
**Target (applied):** `v0.1.md` §10.3 (consultation response `signal` enum) +
`spec/schemas/consultation-response.schema.json`.
**Source:** consultation build brief §11.1, §6 (M1 step 3).
**Date:** 2026-06-09

## Problem

The §10.3 `signal` enum is `proceed | proceed_with_note | clarify | escalate | decline`.
None of these means *"the fingerprint does not cover this; I decline to answer."* Today
a thin-coverage request is forced into `clarify` (which means something different — "go
gather evidence") or a low-confidence `escalate`. The brief's first architecture
principle is **abstain is a first-class outcome**: a confidently-wrong `proceed` is the
worst output the system can produce, and the resolver must be able to say "insufficient
signal" rather than guess.

## Proposal

Add one value to the §10.3 enum:

- **`insufficient_signal`** — the producer declines to answer because the fingerprint
  lacks adequate coverage or confidence for this `action_descriptor` domain. Paired
  conventionally with `deference_level: low` and a `rationale_hint` naming the gap
  ("fingerprint has no Decision/Risk coverage for the `legal` domain").

### Semantics / boundaries

- **Distinct from `clarify`.** `clarify` asks the *agent* to gather more evidence and
  re-ask; `insufficient_signal` says *the subject's model itself* has no basis here —
  more evidence about the action won't help. An agent receiving `insufficient_signal`
  should fall back to its own default / human escalation, not loop.
- **Distinct from an error.** `insufficient_signal` is a valid, successful response, not
  a `request_malformed`/`internal_error`. The request was well-formed; the answer is
  "abstain."
- Confidence SHOULD be reported low; deference SHOULD be `low`. The response carries no
  layer content (§10.4 unchanged).

## Schema delta (when ratified)

`consultation-response.schema.json` → add `"insufficient_signal"` to the `signal`
`enum`. No other field changes. Extend `spec/test-schemas.mjs` so the response enum
still equals the set the reference engine can emit.

## Implementation note

The reference engine (`mcp/consult.js`) gains an abstain floor at the end of resolution
order (brief M1 step C): standing authorizations → inferred Decision/Risk signal above a
per-layer confidence threshold → else `insufficient_signal`. Mark it clearly
**pre-normative** in code until this proposal is folded in.

## Risk

Additive enum value. Existing consumers that switch over the enum must add a branch;
a conforming consumer already has to tolerate the documented set, and abstain degrades
safely (treat as "no signal → use your own default"). Low risk.
