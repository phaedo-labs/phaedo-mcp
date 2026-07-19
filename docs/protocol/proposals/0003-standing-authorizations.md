# Proposal 0003 — Standing authorizations

**Status:** Fork **DECIDED (2026-06-09): sequenced A → B**. The **v0.1 / Option-A half is
IMPLEMENTED + folded into v0.1.10** (authored semantics on `consult_policies`: `amount_gt`
threshold, force = authorization @ confidence 1.0 / high, authored-only locked by a test,
real examples). The **Option-B half (authorizations in §5 User Configuration) remains QUEUED
for v0.2** — built when that artifact exists. See "The fork" below.
**Target:** `v0.1.md` §5.2 (standing instructions) and/or §10.5 (consultation policies)
+ `spec/schemas/consultation-policy.schema.json`.
**Source:** consultation build brief §11.3, §7 (M2).
**Date:** 2026-06-09

## Problem

The brief wants **authored, deterministic decision rules** — the lever that makes
delegation safe ("escalate any irreversible financial action over $5K", "decline
autonomous external email to vendor X"). These already exist in a shipped form as §10.5
**consultation policies** (`consult_policies`). The brief specifies them differently —
as an extension of §5 **standing instructions**. This proposal reconciles the two and
records the fork.

## What both agree on

- **Authored only.** Subject-confirmed before commit (§5.6). No inferred authorizations,
  ever; the extraction pipeline MUST have no write path into this structure.
- **Deterministic.** Exact, rule-based matching. No model involvement.
- **Overrides the inferred signal.** A matched authorization returns its `response` at
  `confidence: 1.0`, `deference_level: high`, with a `rationale_hint` naming the rule
  (never quoting fingerprint content). Resolution order: **authorizations first**, then
  inferred Decision/Risk signal, then abstain (proposal 0001).
- **Never widens §10.4.** Response shape unchanged; provenance rides `rationale_hint`.
- **Not for `voice_draft`** (a redirect, not a decision).

## The fields (semantic model, from the brief)

- `kind`: `instruction` (existing §5 behavior) or `authorization`.
- `scope`: activates the reserved `domain` / `task` scopes for authorizations.
- `condition` / `match`: structured matcher on the `action_descriptor` —
  `domains` (substring, case-insensitive), `magnitude_min`/`magnitude_max`,
  `reversible`, and (proposed) an optional numeric `amount_gt` threshold.
- `response` / `effect`: `proceed` (`autoproceed`), `escalate` (`require_human`),
  `decline`; plus the shipped soft `bias_cautious` / `bias_bold` nudges.

## The fork — which artifact owns authored decision rules?

**DECIDED 2026-06-09 (Randy): sequenced A → B, not a binary.** Option A is the v0.1
home; Option B is the named v0.2 destination, reached when the §5 User Configuration
artifact is built. Rationale below.

**Grounding fact that reframes the cost.** §5 User Configuration is **not implemented** —
it is spec-only. Its entire footprint in code is the `USER_CONFIGURATION` artifact-kind
constant (`protocol.js`, mobile `envelope.ts` typedef). There is no `standing_instructions`
storage, no envelope ever produced, no sync path, no authoring surface, no consumer. So
Option B is not "move authorizations into §5" — it is "**build the §5 artifact from
scratch** (phone storage + distinct-context envelope + sync + authoring), then put
authorizations in it." Meanwhile `consult_policies` already rides the fingerprint's
`inner.data` and syncs extension → phone → MCP for free (`toVaultPayload` maps
`inner.data → phaedo_fingerprint`; `loadPolicies` reads `phaedo_fingerprint.consult_policies`).

- **Option A — keep `consult_policies` in the fingerprint (shipped; the v0.1 home).**
  Portable with **zero mobile change**. Adopt the brief's *semantics* (authored,
  deterministic, conf 1.0, high deference, authorizations-resolve-first) on this existing
  transport. Lowest risk; matches running code; the only authored-policy user today
  (Randy, via editor → file) is trivially migratable.
- **Option B — authorizations as `kind:"authorization"` in §5 User Configuration (v0.2).**
  Its advantages are real and were undersold in the first pass:
  1. **Category integrity.** §5 exists to keep *authored* content (stated once, verbatim,
     no confidence score, subject-confirmed) separate from *inferred* content. Authorizations
     are authored; putting them in the (inferred) fingerprint is the exact category confusion
     §5 was written to prevent.
  2. **Structural no-inferred-writes guarantee.** §5.6 forbids inferred edits to config; if
     authorizations live in §5, extraction *structurally cannot* write them (it never touches
     the config artifact). In the fingerprint home this is enforced by hand + test, not by
     structure (see the invariant below).
  3. **Independent crypto boundary.** §5.5 gives config a distinct domain-separation context
     (`phaedo:config:enc:v0.1`), so a leak of one artifact does not expose the other. Authored
     guardrails are the most deliberate content a subject writes; they deserve their own envelope.
  4. **Down payment on an artifact we need anyway.** The consultation reframe *raises* §5's
     value — standing instructions (§5.2), the example corpus (§5.3), and canonical authored
     anti-preferences (§4.3) all live there. Building §5 for authorizations is a first brick of
     work we will do regardless, not throwaway.

**Recommendation (adopted): A now, B as the v0.2 destination.** Keep the §10.5 transport
for v0.1 and adopt the §5 *semantics* on it; migrate authorizations into §5 when the User
Configuration artifact is built (the migration is additive — `loadPolicies` already reads
multiple sources, so adding a config source does not break the fingerprint home).

**Do now regardless of A/B (the one real risk of the A home):** add an explicit invariant
+ test that the extraction pipeline has **no write-path into `consult_policies`**. The
fingerprint home does not give this structurally (Option B would); a test makes the
authored-only guarantee enforceable today.

## Schema delta (when ratified)

**v0.1 (Option A):** extend `consultation-policy.schema.json` with optional `amount_gt`
and an explicit `confidence:1.0 / deference:high` note for force effects; document
authorizations-resolve-first ordering in §10.5; add 2–3 real authored examples; extend
`spec/test-schemas.mjs`. Add the no-inferred-write test (above) in `extraction/`.

**v0.2 (Option B, when §5 is built):** add `kind`/`condition`/`response` to the §5.2
standing-instruction schema and specify `domain`/`task` scope activation; add a
`user_configuration` source to `loadPolicies` (additive); migrate Randy's authored rules.

## Risk

Option A is additive/low-risk; its one gap (no structural authored-only guarantee) is
closed by the no-inferred-write test. Option B is a coordinated mobile change gated on
building the §5 User Configuration artifact — sequenced for v0.2, not done blind now.
