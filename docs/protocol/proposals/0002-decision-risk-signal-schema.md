# Proposal 0002 — Normative Decision & Risk signal schema

**Status:** ✅ RATIFIED + FOLDED into v0.1.14 (2026-06-10), after implementation — for the
fields the producer actually emits. Kept as the rationale record. Applied as:
`spec/schemas/decision-risk-signal.schema.json` (`dimension`/`polarity`/`value`/`confidence`/
`evidence_basis`), §4.2.7 normative note resolving open question 13 for this one layer, the
producer emitting the shape (`extraction/fingerprint-update.js`: `dimension` + `evidence_basis`),
the resolver consuming it (`mcp/consult-core.js`: per-signal confidence, evidence-basis
weighting), and `spec/test-schemas.mjs` ties.
**`domain`: PROTOTYPE EMISSION live as of v0.1.15 (2026-06-10).** `extraction/domain-inference.js`
infers a session's domain from the subject's own messages (lexical lexicon mirroring the
consultation/policy domain namespace; precision-gated — ≥2 distinct cues AND a strict winner,
else untagged) and tags that session's Decision&Risk signals. Reconcile keys per
(field, polarity, domain); the resolver prefers matching-domain signals, falls back to untagged,
never borrows wrong-domain (per-domain answers + per-domain abstain where tags exist). Untagged
signals keep fingerprint-wide semantics. **Tag ACCURACY validation is data-gated** — Randy's
real-use window + eval decides whether the tags are good enough to drive per-domain
confidence/calibration. `threshold` remains reserved.
**Target:** `v0.1.md` §4.2.7 + §13 open question 13 (per-layer signal schemas) +
new `spec/schemas/decision-risk-signal.schema.json`.
**Source:** consultation build brief §11.2.
**Date:** 2026-06-09 (consumption half: 2026-06-10)

## Problem

§4.3 records signal *polarity* but §13 Q13 leaves the per-layer `signals[]` object shape
**implementation-defined** in v0.1. The consultation resolver consumes the Decision and
Risk layer (§4.2.7) deterministically, so it needs a stable per-signal shape for *one*
layer to read without guessing. Resolving Q13 for all eight layers at once is premature;
resolving it for the hero layer (Decision & Risk) unblocks the resolver now.

## Proposal

Specify a normative per-signal object for the **Decision and Risk** layer only. Other
layers stay implementation-defined until separately proposed.

```json
{
  "signal_id": "uuid-v4",
  "domain": "financial",
  "polarity": "positive",
  "dimension": "reversibility_preference",
  "value": "prefers_reversible",
  "threshold": { "magnitude_min": "medium" },
  "evidence_basis": "observed",
  "confidence": 0.74
}
```

| Field | Type | Req | Notes |
|---|---|---|---|
| `signal_id` | uuid | yes | Stable id. |
| `domain` | string | yes | e.g. `financial`, `legal`, `external_comms`. Matches the resolver's `action_descriptor.domain` (substring, case-insensitive). |
| `polarity` | `positive` \| `negative` | yes | Per §4.3. Negative (anti-preference) takes precedence on conflict. |
| `dimension` | string | yes | Which decision axis: `evidence_threshold`, `reversibility_preference`, `escalation_default`, `option_set_vs_recommendation`, `ambiguity_posture`. |
| `value` | string | yes | Enum per dimension (e.g. `requires_human_review`, `prefers_reversible`, `defaults_escalate`). |
| `threshold` | object | no | Optional magnitude/numeric gate (`magnitude_min`, `magnitude_max`, `amount_gt`). |
| `evidence_basis` | `observed` \| `self_reported` \| `corroborated` | yes | Provenance; corroborated > self_reported for confidence. |
| `confidence` | number `[0,1]` | yes | Per-signal confidence; resolver applies the §10 per-layer threshold (start 0.5) against it. |

## Why this shape

It is exactly what the resolver needs to (a) scope a signal to an action's domain,
(b) apply a magnitude/threshold gate, (c) honor polarity precedence, and (d) gate on
confidence and abstain (proposal 0001) below threshold. It is deliberately a *subset* of
a general per-layer schema so the other seven layers can adopt their own shapes later
without breaking this one.

## Schema delta (when ratified)

Add `spec/schemas/decision-risk-signal.schema.json`; reference it from
`fingerprint.schema.json` for the `decision_and_risk.signals[]` items only; extend
`spec/test-schemas.mjs`. Update §4.2.7 prose and resolve §13 Q13 "for the Decision and
Risk layer" (leave Q13 open for the rest).

## Risk

Narrowing one layer's signal shape is forward-compatible (other layers unaffected;
unknown fields tolerated per §4.5). The reference extraction pipeline must emit this
shape for Decision/Risk — coordinate with `extraction/` before ratifying.
