# Proposal 0007 — Discussion: the two deferred threads

**Status:** ✅ **RESOLVED (2026-06-17, Randy).** Both threads decided per the recommendations below.
- **Thread A → A2 (authorization-only autonomy).** Positive-polarity / unbound instructions stay
  **inject-only**; autonomy expansion requires an explicit `kind:"authorization"`. The asymmetry is now
  stated as permanent in §10.5 and locked by `mcp/test-consult-policy.mjs` (a bound positive/unbound
  instruction projects no consultation policy). No new code — the capability (authorizations) already exists.
- **Thread B → defer to v0.2.** The in-fingerprint A-home stands (safe, tested). **Trigger:** the next time
  the mobile vault artifact is open for work; not opened solely for this. Crypto-isolation of authored rules
  is a v0.2 benefit, not a near-term correctness need.

The original brief is retained below as the rationale record.

---


Proposal 0007 shipped end-to-end (onboarding → injection → resolution → delta promotion → review UI,
folded through v0.1.22). Two things were deliberately left out. This brief lays out what they are, why
they were deferred, the options, and a recommendation — so we can decide rather than drift.

---

## Thread A — Positive-polarity autonomy expansion

### Where we are
A `kind:"instruction"` rule bound to a Decision & Risk dimension affects consultation **only when its
polarity is negative** (anti-preference → `bias_cautious`, one step toward escalate). Positive-polarity
and unbound instructions **inject verbatim but have no consultation effect**. So:

- *"I don't approve a recurring cost without written sign-off"* (negative) → biases the agent cautious. ✅
- *"I move fast on small reversible calls"* (positive) → shapes the chat persona, but does **not** make
  the agent act more autonomously in a consultation. ⚠️ (gap)

The asymmetry is intentional: **authored rules can make the agent more deferential, never less** — for now.

### Why it was deferred (two real reasons)
1. **Safety asymmetry.** Making an agent *more autonomous* from a soft disposition is the dangerous
   direction. A stale or mis-bound cautious rule over-escalates (annoying); a stale bold rule
   **auto-proceeds on something it shouldn't** (harmful, possibly irreversible). The conservative default
   is to never expand autonomy from a vague lean.
2. **The prose→value gap.** An instruction is prose + dimension + polarity — no structured enum value.
   `bias_cautious` works as a blunt one-step nudge regardless. But "expand autonomy" toward `proceed`
   really wants to know *how much* and *on what* (e.g. reversible **and** magnitude ≤ medium **and**
   amount < X) — which needs a structured value/threshold, not just "positive on speed_vs_quality".

### Options
- **A1 — Symmetric bias.** Positive bound instruction → `bias_bold` (one step toward proceed), mirroring
  negative → `bias_cautious`. Cheap, reuses the ladder. Risk: a soft authored lean nudges the agent
  toward acting — bounded to one step, and forces/authorizations still override, but it *does* relax
  deference from prose.
- **A2 — Authorization-only autonomy (recommended).** Keep the asymmetry **permanently**: instructions
  can only nudge cautious; any autonomy *expansion* must be an explicit `kind:"authorization"` with
  `effect:"autoproceed"` and a `match` (domain / magnitude / amount). Boldness gets a deterministic,
  scoped, auditable gate — which is exactly what authorizations are for. Nothing new to build; the
  capability already exists.
- **A3 — Structured per-dimension values.** Give instructions an optional structured `value` + threshold
  so the resolver maps them precisely in both directions. Most expressive, most work, and it reopens the
  prose-vs-structured tension Proposal 0007 deliberately closed.

### Recommendation
**A2.** Caution can be a soft lean; **autonomy expansion should require an explicit scoped authorization**,
not an inferred-adjacent disposition. This keeps the safe asymmetry, needs no new code, and bounds the
blast radius via the matcher. Net: "positive-polarity autonomy expansion" likely shouldn't be *built* —
the answer is "author an authorization." The only sub-question is whether positive instructions should
stay strictly inject-only (my lean: **yes**) or get the A1 one-step `bias_bold` nudge.

### Decision needed
> Do positive-polarity bound instructions stay **inject-only** (A2, recommended), or do we add the
> symmetric one-step `bias_bold` nudge (A1)? Either way, autonomy expansion stays in authorizations.

---

## Thread B — The v0.2 §5 User Configuration sibling migration

### Where we are
`standing_rules` (and the deprecated `consult_policies`) ride **inside the fingerprint** — the "A-home"
(Proposal 0003-A's pragmatic choice). But §5 of the spec says authored content should be a **separate
sibling artifact**: its own envelope, its own crypto domain-separation context, its own sync path, and a
structural no-inferred-write guarantee. §5 is currently **spec-only / unbuilt**. The v0.2 plan (0003-B)
is to build §5 and migrate the authored rules into it.

### What we gain by doing it
1. **Structural authored-only guarantee.** Today it's enforced by tests + convention
   (`test_standing_rules_invariant.mjs`). In §5 it's *structural*: extraction never touches the config
   artifact, so it physically cannot write authored rules.
2. **Independent crypto boundary.** §5 gets its own domain-separation context (`phaedo:config:enc:v0.1`),
   so a leak of one artifact doesn't expose the other. Authored guardrails are the most deliberate
   content a subject writes — they arguably deserve their own envelope.
3. **Category integrity.** Authored vs inferred fully separated, as §5 intends — no "authored content in
   the fingerprint" compromise.
4. **A brick we need anyway.** §5 also houses the example corpus (§5.3) and standing instructions broadly,
   so building it isn't throwaway.

### Why it was deferred (the cost driver)
§5 is a **coordinated mobile change**, not just JS. It needs: phone-side storage for the config artifact,
a distinct-context envelope, a sync path (extension ↔ phone ↔ MCP), and an authoring surface. That's
real work in the React Native vault app — which is why 0003 sequenced it to v0.2. The A-home is *safe
today* (invariant tests + the no-write guarantee by test), so there's no correctness pressure forcing it.

### Migration mechanics (when we do it)
- `loadPolicies` already reads multiple sources → **additive**: add a §5 source alongside the fingerprint
  A-home. `context-block.js` reads standing instructions from §5.
- **Dual-read window:** old fingerprints with in-fingerprint `standing_rules` keep working; new authoring
  writes §5; a one-time migration moves existing authored rules across.
- **Cleanup:** once migrated, remove `consult_policies` and the fingerprint A-home for authored rules.
  Both invariant tests retire with their structures.

### Recommendation
**Keep it v0.2, and trigger it off the next time the mobile vault work is open** — don't open the mobile
artifact *just* for this. The payoff (crypto isolation + structural guarantee) matters most at beta scale
and for enterprise/security posture, not for correctness today. Sequence when triggered:
build §5 artifact → dual-read window → migrate → deprecate the A-home.

### Decision needed
> What **triggers** the §5 build — a beta-scale milestone, a security/enterprise requirement, or simply
> the next open mobile-vault cycle? And is crypto-isolation of authored rules a near-term priority or a
> v0.2 nicety?

---

## Summary — what I need from you

| Thread | The call | My rec |
|---|---|---|
| A — positive-polarity | inject-only vs symmetric `bias_bold`; autonomy stays in authorizations | inject-only (A2) |
| B — §5 migration | what triggers building §5; is crypto-isolation near-term | v0.2, trigger off the next mobile cycle |
