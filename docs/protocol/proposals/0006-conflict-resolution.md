# Proposal 0006 — Deterministic Conflict Resolution + Provenance

**Status:** ✅ RATIFIED + FOLDED into v0.1.20 (2026-06-16), then **FULLY INTEGRATED v0.1.24–v0.1.28
(2026-06-19)**. Applied as: new **§4.7 Conflict Resolution**; reference resolver `resolveDimension()` /
`resolveLayer()` in `spec/validate-fingerprint.mjs`; test vectors `spec/test-vectors/resolution.json`
(category TC-RESOLVE, run by `spec/test-vectors.mjs`). No wire change — the existing `signals[]`
evidence log is the provenance; the resolution is derived. The producer/projection integration
originally listed under Follow-up is now complete: a reviewable **`conflict_records[]`** staging queue
(v0.1.24), **injection suppression** of open-conflict dimensions (v0.1.27), and the symmetric
**consult suppression** (v0.1.28). See the Completion notice below.

**Target:** `v0.1.md` §4.7 (new) + §13 open question on multi-writer/merge semantics.
**Source:** external standard review (2026-06-16) + the live-projection autonomy contradiction.
**Date:** 2026-06-16. **Route chosen:** A (evidence-tier precedence + recency tiebreak + floor).

## Problem

A layer's `signals[]` may hold several signals for one `field` with different `value`s —
learned from different sources (interview vs observed behavior) at different times. The spec
specified **polarity** precedence (§4.3, anti-preference wins) but left **value** conflict
resolution implementation-defined. Two consequences, both observed in the live reference
projection:

1. **Non-determinism across implementations.** Two conformant consumers could resolve the same
   fingerprint to different values — breaking the interop the standard exists to provide.
2. **The autonomy-class defect.** The projection asserted *"execute without dialogue"* (thin
   observed) directly above *"check before acting"* (interview), with no resolution. For a
   decision-relevant dimension an agent **consults before acting** (§10), a confident-but-wrong
   resolution is the precise failure the consultation primitive cannot have.

## Proposal

Specify resolution **normatively and deterministically** so every implementation computes the
same resolved value from the same evidence log.

**Inputs** are the signals for one `field` (after §4.3 polarity precedence). Rank by:

1. **`evidence_basis` tier** — `corroborated` (3) > `observed` (2) > `self_reported` (1); absent/unknown → 1.
2. **`observation_count`** (higher wins) within a tier.
3. **`last_observed`** recency (more recent wins).
4. A stable order on the serialized `value` (guarantees total order — no ties).

**Minimum-evidence floor (the safeguard).** An `observed`/`corroborated` signal overrides a
**contradicting** `self_reported` value only once `observation_count ≥ RESOLUTION_FLOOR`
(normative default **3**). Below the floor, the conflict resolves to **`status: "unresolved"`**
instead of confidently flipping. Consumers MUST treat `unresolved` conservatively (a
consultation biases toward `clarify`/`escalate`; never a confident instruction).

**Output** per dimension:

```json
{
  "field": "autonomy",
  "value": "check before acting",
  "evidence_basis": "self_reported",
  "confidence": 0.5,
  "status": "unresolved",
  "provenance": [
    { "value": "check before acting", "evidence_basis": "self_reported", "observation_count": 1, "last_observed": "2026-06-01" },
    { "value": "execute without dialogue", "evidence_basis": "observed", "observation_count": 2, "last_observed": "2026-06-12" }
  ]
}
```

`provenance` is the candidate set — **no new wire structure**: the `signals[]` array already
*is* the provenance log, so a producer stores raw evidence and resolution is derived. This is
also the answer to multi-writer/merge semantics (§13): evidence accumulates from any writer,
resolved values recompute deterministically from the merged log.

## Rationale (Route A vs alternatives)

- **A — evidence-tier + recency + floor (chosen).** Reuses the existing `evidence_basis` enum;
  fully deterministic across producers; matches the product thesis (behavior beats self-report,
  *once established*). The floor structurally prevents the autonomy defect rather than catching
  it after.
- **B — confidence-weighted.** Rejected as the primary rule: `confidence` is producer-computed
  and not comparable across implementations, so the same fingerprint could resolve differently
  in two conformant consumers. Retained only as it informs the per-signal confidence the
  producer already emits.
- **C — recency-primary.** Rejected: a single recent outlier flips an established trait — the
  jumpiness that produced the autonomy defect.

## Conformance

A conformant consumer that resolves a dimension MUST produce the §4.7 result for the given
evidence. `spec/test-vectors/resolution.json` (TC-RESOLVE) is the portable proof, including
R-RESOLVE-0003 (the autonomy case → `unresolved`). An implementer runs the same vectors against
their own resolver.

## Completion notice (v0.1.24–v0.1.28, 2026-06-19)

The producer/projection integration originally queued here as follow-up is **done**. The reference
producer (`extraction/reconcile.js` → `renderLayerSummary`) adopts `resolveLayer()`, so the rendered
summary carries one resolved value per dimension at the source. On top of that:

- **Conflict records (v0.1.24).** A contradiction below the §4.7 floor is staged in a reviewable
  `phaedo_fingerprint.conflict_records[]` queue (`{conflict_id, layer, field, domain?, status,
  detected_at, last_seen, resolved_at?, candidates[]}`) rather than silently collapsed by the
  confidence merge — a producer-written proposal queue (never injected, never consulted; auto-closes
  at the floor; `dismissed` is sticky). The extension surfaces it as a "Conflicts to settle" popup
  card + a toolbar attention dot; settling authors a canonical rule (`source:"conflict_resolution"`).
- **Injection suppression (v0.1.27).** While a conflict is `open`, `renderLayerSummary` **withholds
  that `(field[, domain])` dimension from the projection** (§9), so a contested value is never asserted
  until the subject settles it (settle → canonical rule; dismiss → un-suppress).
- **Consult suppression (v0.1.28).** The reference resolver likewise withholds contested dimensions
  from the consultation cue readers; a consult whose relevant dimensions are all contested returns
  `insufficient_signal` (abstain → escalate). Reference: `mcp/consult-core.js`
  (`openConflictKeys`/`isFieldContested`). The model judge inherits this via the suppressed projection.
