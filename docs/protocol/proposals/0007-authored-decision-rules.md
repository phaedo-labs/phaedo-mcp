# Proposal 0007 — Authored decision rules (one home: `standing_rules`)

**Status:** ✅ **RATIFIED + FOLDED into v0.1.21 (2026-06-17).** Applied as: `standing_rules[]` on
`fingerprint.schema.json` (kind discriminator + `decision` binding); `consultation-policy.schema.json`
`$defs` refactor + deprecation; resolver projection in `mcp/consult-policy.js` (authorization + bound-
instruction `bias_cautious`); verbatim "Operating rules" injection in `context-block.js`; the
`scripts/test_standing_rules_invariant.mjs` authored-only lock; ties in `spec/test-schemas.mjs`,
`mcp/test-consult-policy.mjs`, `scripts/test_context_block.mjs`; v0.1.md §4.7/§5.2/§9/§10.5 + change log.
Kept as the rationale record. The §D positive-polarity → autonomy-expansion path remains deferred
(structured per-dimension values); the §5 sibling migration is the v0.2 destination (0003-B).
**Target:** `v0.1.md` §4.3 (polarity/authored-canonical) · §4.7 (conflict resolution) · §5.2
(standing instructions) · §9 (injection) · §10.5 (consultation policies);
`spec/schemas/consultation-policy.schema.json`, `spec/schemas/fingerprint.schema.json`;
`context-block.js`; `mcp/consult-policy.js`; `extraction/`; `interview/`.
**Source:** Prediction-demo "anchor" concept (2026-06-17), re-grounded against the protocol.
**Date:** 2026-06-17 (rev. 3 — collapsed to a single authored home; authorization is a typed
variant. rev. 2 withdrew the in-layer "endorsed signal" design after reading §4.6/§5; rev. 1 history
in Alternatives.)

## Problem

The weakest layers — **Decision & Risk** above all — cannot be learned from output deltas, because
a delta records an *output*, not the *rule* that produced it. You can watch a subject hold one
estimate and approve four a hundred times and never recover "I don't approve a recurring cost not
confirmed in writing." That layer has to be **elicited and endorsed directly**.

The protocol already anticipates this — but in three **disconnected** halves:

1. **§5.2 Standing Instructions** is the spec'd home for authored, verbatim, injected rules
   (examples: *"Refer to me as Randy"*, *"Default to skeptical pushback"*). But §5 is **unbuilt**
   (0003: spec-only — no storage, no envelope, no consumer).
2. **§9.1** already defines the injected projection as *"selected fingerprint layers, standing
   instructions from the paired user configuration, and selected examples."* But the reference
   injector (`context-block.js`) **never renders standing instructions** — it builds the Decision
   section purely from inferred delta signals (lines ~416–425). Authored rules never reach the prompt.
3. **§4.7** states *"user-authored configuration (§5 / §10.5) **overrides** any inferred resolution,"*
   and **§4.3** says treat an authored anti-preference as **canonical**. But nothing emits an authored
   rule **bound to a Decision & Risk dimension**, so the override clause is never exercised.

Separately, authored rules are today split across two structures by accident of history: hard gates
ride `consult_policies` (§10.5, shipped v0.1.10), while verbatim rules have no home at all. Proposal
0003 already named the unifying model — *standing instructions with `kind: instruction | authorization`* —
but deferred it to the v0.2 §5 build. This proposal pulls that model forward into one home now.

## Proposal — one authored home: `standing_rules`

Authored decision rules are **authored content** (§5 semantics: stated once, no confidence score, not
learned, applied verbatim). They live in **one** array on the fingerprint — `standing_rules` — never in
a behavioral layer's `signals[]` (the §4.6/§5 category error; Alternatives B). `standing_rules` is the
§5.2 Standing-Instruction shape, carried on the fingerprint as the v0.1 A-home (the same pragmatic
pattern 0003 chose for `consult_policies`), migrating to the real §5 User Configuration sibling in v0.2.

A single **`kind`** discriminator carries both semantics — exactly the `instruction | authorization`
model 0003 specified:

### A. `kind: "instruction"` — verbatim rule / disposition (default)

```json
{
  "instruction_id": "i7f2a019",
  "kind": "instruction",
  "text": "I don't approve a recurring cost until the figure is confirmed in writing.",
  "exception": "Unless it is immaterial relative to reserves and reversible within one billing cycle.",
  "scope": "global",
  "priority": 10,
  "decision": { "dimension": "evidence_threshold", "polarity": "negative", "domain": "finance" },
  "created_at": "2026-06-17T18:40:00Z",
  "updated_at": "2026-06-17T18:40:00Z"
}
```

- `text` / `exception` — the verbatim rule and its boundary, injected as-is (§5.2: MUST NOT summarize).
- `priority` — §5.2 ordering hint, lower injects first (constraints get low numbers). This replaces a
  separate rhetorical-class enum; one ordering mechanism.
- `decision` (optional) — binds the rule to one Decision & Risk dimension
  (`spec/layer-vocabulary.json`: `evidence_threshold | ambiguity_posture | options_vs_recommendation |
  speed_vs_quality`, plus `reversible_vs_irreversible`). A bound rule marks that dimension
  **authored-canonical** in resolution (§D). A rule with no `decision` is a plain injected instruction.

### B. `kind: "authorization"` — deterministic gate (the matcher→effect variant)

The same authored object, plus the §10.5 `match`→`effect` fields. The consultation resolver consumes
authorization entries deterministically (override the inferred signal at `confidence:1.0`,
`consult-policy.js`). If the entry also carries `text`, it **also** injects — so the chat model respects
the same line the resolver enforces.

```json
{
  "instruction_id": "i231672",
  "kind": "authorization",
  "match": { "domains": ["finance"], "reversible": false, "amount_gt": 5000 },
  "effect": "escalate",
  "text": "I don't approve irreversible spend over $5k without written sign-off.",
  "note": "Surface big irreversible spend for a live decision.",
  "scope": "global",
  "priority": 5,
  "created_at": "2026-06-17T18:40:00Z",
  "updated_at": "2026-06-17T18:40:00Z"
}
```

- `match` / `effect` — the deterministic gate (unchanged §10.5 semantics; `effect` stays authoritative
  for consultation). `match` optional (a matchless authorization matches all); `effect` required.
- `text` (optional) — injectable verbatim rule. Present → also renders in the Operating-rules block.
- `note` (optional) — resolver `rationale_hint` source (back-compat with `consult_policies.note`).

This **supersedes the standalone `consult_policies` array**, which becomes a deprecated read-path alias
for back-compat (see Migration). One home, one authoring surface, one injection pass.

### C. Injection (§9) — render the authored home, verbatim

`context-block.js` gains a high-salience section near the top of `<phaedo_user_profile>` (above
inferred style, for §4.3 conflict-priority), sourced from every `standing_rules` entry that carries
`text` (both kinds). This **wires the standing-instruction projection §9.1 already specifies**:

```
## Operating rules (user-confirmed)
Explicit rules this person has endorsed. Treat them as hard constraints on decisions and
recommendations, higher priority than inferred style. Apply them silently; do not restate them
or open replies with "as someone who...".

- I don't approve irreversible spend over $5k without written sign-off.
- I don't approve a recurring cost until the figure is confirmed in writing. (Exception: unless immaterial and reversible within one billing cycle.)
- I ask one clarifying question before acting when a request is ambiguous.
- I trade speed for accuracy on consequential or irreversible decisions. (Exception: on small reversible ones I move fast.)
```

Verbatim per §5.2; ordered by `priority`; out-of-domain rules dropped by `scope`/`decision.domain`/
`match.domains`; capped at a small budget. The "apply silently, do not restate" line prevents the model
parroting the rules back — the exact tic the persona removes.

### D. Resolution (§4.7) — authored-canonical, not a new tier

No new `evidence_basis` tier. When a `standing_rules` entry carries a `decision` binding, the
**projection / consultation** treats that dimension as **authored-canonical** — the value reported for
that dimension, regardless of the inferred `signals[]` candidates. This is exactly the §4.7 clause
(*"authored config overrides inferred resolution"*) and §4.3 (*"treat the authored form as canonical"*),
made concrete for a bound dimension. The inferred `signals[]` log and `layer.confidence` are
**untouched** — the authored rule overrides the *resolved projection*, not the *stored inference*.

> **The demo's "0.58 → 0.63 lift," corrected.** That is **not** a mutation of the inferred layer's
> confidence (that would be the category error). It is the Decision & Risk *dimension* reading
> authored-canonical — `source: ANCHOR` in the demo's own labeling — which is what drives injection and
> consultation. The honest readout is "authored rule applied," not a moved mean.

### E. Seeding & steady state

- **Cold start — onboarding elicitation** (`interview/`; bank in `0007-onboarding-decision-rules.json`).
  Four free-text scenarios, each mapped to one DR dimension: surface the rule from a concrete scenario →
  reflect a first-person candidate back → user **endorses** → capture the exception (built into the
  question, so rule + boundary land in one pass). Endorsement writes a `kind:"instruction"` entry. This
  is a **new question type** (`rule_elicitation`), distinct from the existing closed-form
  `decision_and_risk` questions (r1–r3), which produce inferred self-reported *signals*, not authored
  *rules*.
- **Steady state — delta promotion.** When the delta engine sees a pattern recur, it writes a
  **`suggested`** candidate to a staging area **outside** `standing_rules`, with evidence pointing at the
  delta cluster. The user endorses or kills it from a review UI; **endorsement is the only write into
  `standing_rules`.** The producer never writes the authored home — preserved structurally and by test.

## Alternatives weighed

- **A — Standalone top-level `anchors[]` (the demo's design). Rejected.** Duplicates the authored home,
  reopens the settled 0003 fork, bumps the wire version for no transport reason, re-implements
  resolution/injection that already exist.
- **B — `endorsed` evidence tier inside `layer.signals[]` (rev. 1). Withdrawn.** Reproduced the demo's
  layer-confidence lift cheaply, but **contradicts §5** (*"treating authored content as a layer creates
  category confusion"*; authored content has no confidence score and is not learned) and pushes verbatim
  prose into the behavioral layers §4.6 keeps for structured signals. The "lift" it bought was itself the
  category error.
- **C — Two authored homes (`standing_rules` + `consult_policies`) (rev. 2). Superseded by decision.**
  Category-clean but pushed a "gate or disposition?" routing decision onto the authoring UI and kept two
  structures.
- **D — One home, authorization as a typed variant of `standing_rules` (chosen).** Realizes 0003's
  `kind: instruction | authorization` model in a single array; one authoring surface; one injection pass;
  `consult_policies` deprecated to a back-compat alias. Most consolidated, and it *advances* the v0.2 §5
  build rather than adding a parallel structure.

## Schema / code delta (when ratified)

See `0007-schema-diffs.md` for exact, ready-to-apply JSON.

| Surface | Change | Breaking? |
|---|---|---|
| `fingerprint.schema.json` | add optional `phaedo_fingerprint.standing_rules[]` — §5.2 object + `kind` (`instruction`/`authorization`), optional `text`/`exception`/`decision{dimension,polarity,domain}`, and (authorization) `match`/`effect`/`note` (`$ref`'d from §10.5) | Additive |
| `consultation-policy.schema.json` | expose `$defs.match` / `$defs.effect` so both `consult_policies` and `standing_rules` share one definition; mark `consult_policies` **deprecated** (read-path alias) | Additive / docs |
| `mcp/consult-policy.js` | `loadPolicies` gains a `standing_rules` (kind=authorization) source projected to the normalized policy shape, alongside the deprecated `consult_policies`; `applyPolicies`/`matchAuthorization` unchanged | Additive |
| `context-block.js` | render `## Operating rules (user-confirmed)` from `standing_rules` entries carrying `text`; verbatim, ordered, domain-filtered, budget-capped | Additive injection content |
| `validate-fingerprint.mjs` / projection | apply a bound `standing_rules.decision` as the authored-canonical value for its dimension at projection/consultation time (extends §4.7 "authored overrides inferred"; `resolveDimension` over `signals[]` unchanged) | Additive |
| `extraction/` | **invariant test:** the producer never writes `standing_rules` (mirrors `scripts/test_consult_policies_invariant.mjs`) | New test |
| `interview/` | `rule_elicitation` question type + the 4-item DR bank | New artifact |

**Wire version stays `0.1`** — every change is additive. No enum narrowing, no `layer.confidence` math
change, no `BASIS_WEIGHT` change.

## Migration (the one real cost of collapsing the home)

`consult_policies` is **shipped** (v0.1.10): a live resolver path (`loadPolicies`/`applyPolicies`/
`matchAuthorization`), an invariant test, and Randy's authored rules (editor → file). Collapsing the home
must not break it.

1. **Read-path back-compat.** `loadPolicies` keeps reading `phaedo_fingerprint.consult_policies` and
   `phaedo_consult_policies` (it already concatenates sources) and **adds** `standing_rules` (kind=authorization,
   projected to the same normalized shape). Old fingerprints keep working unchanged.
2. **Write-path moves to `standing_rules`.** New authoring (policy editor, onboarding) writes
   `standing_rules`. `consult_policies` is documented **deprecated**.
3. **One-line transform** migrates existing `consult_policies.rules[]` → `standing_rules[]`
   (`id→instruction_id`, `match→match`, `effect→effect`, `note→note`, `kind:"authorization"`). Randy's
   rules are the only authored set today — trivially migrated.
4. **v0.2.** `consult_policies` removed when `standing_rules` migrates to the §5 sibling (0003-B); its
   invariant test retires with it. Until then both invariant tests run.

## Risk

1. **Authored-only erosion.** `standing_rules` needs the same structural guarantee `consult_policies` has —
   the new invariant test is load-bearing; without it the A-home is unsafe.
2. **Deprecation window discipline.** Two read paths (`consult_policies` + `standing_rules`) coexist until
   v0.2. A rule authored in both would double-count; the editor must write one home only, and the migration
   should move, not copy.
3. **Binding accuracy.** A `decision.dimension` that mis-binds marks the wrong dimension canonical. The
   elicitation flow binds explicitly (each question targets one dimension); delta-promoted bindings inherit
   the cluster's dimension and are user-confirmed on endorsement.

## Follow-up (not in this proposal)

- The real §5 User Configuration artifact and migration of `standing_rules` into it — the 0003-B v0.2 work,
  now with a concrete first consumer and the `instruction|authorization` model already realized.
- ✅ **Delta promotion (§E) — DONE, folded v0.1.22; producer + review surface fully wired 2026-06-19.**
  `extraction/rule-promotion.js` stages `suggested` rules from established inferred D&R signals;
  `rule-review.js` endorses (→ `standing_rules`, `source:"delta_promotion"`, bumping `rules_updated_at`)
  or rejects; `suggested_rules[]` schema added; locked by `scripts/test_rule_promotion.mjs` (producer
  stages, user authors). The **producer is now actually called in the live extraction pass**
  (`extraction/offscreen-runner.js` + `orchestrator.js` via `promoteRules()` — previously it had no
  runtime caller and the queue was only seedable by hand). The **review-UI surface** moved out of the
  interview app into the **extension popup** ("Rules to review" card, `rule-review.js` as a classic
  IIFE) sharing the unified "needs review" attention dot with conflict records; the old interview
  `Review.jsx` screen was removed. See `0007-deferred-discussion.md` for the two resolved
  threads: **Thread A** — positive-polarity stays inject-only; autonomy expansion is **authorization-only**
  (permanent asymmetry, §10.5, test-locked). **Thread B** — the §5 sibling migration stays v0.2, triggered
  by the next mobile-vault cycle.
- Config integration into the §9.2/§9.3 request/response shapes (flagged for v0.2 in §9.1's note).
