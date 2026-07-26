# Anamnesis ↔ AP2 profile (draft)

**Status:** Draft profile, 2026-07-22. Non-normative; targets Anamnesis v0.1.50.
**Companion to:** `docs/protocol/v0.1.md` §10.5 (standing authorizations), §10.2 (`action_binding`), §10.4 (consultation boundary).
**Reference:** `mcp/ap2.js`, `mcp/test-ap2.mjs`.

---

## Why this profile exists

The largest standing risk to Anamnesis is not a competitor building a better decision oracle. It is the **standards cold-start**: one implementer is a file format, not a standard. Months of demand-side validation — sovereignty benchmarks scoring Anamnesis-shaped agents, a Chinese law mandating decision-authorization policies, an ITU trust-and-identity focus group — have not produced a second implementer, and evangelism has not moved that number.

Binding to a standard that *already has* implementers does move it. This profile makes **every AP2 participant a partial Anamnesis consumer without adopting Anamnesis**.

## What AP2 is, and why it rhymes

The Agent Payments Protocol was donated by Google to the **FIDO Alliance** (announced 2026-05-26), alongside Mastercard's **Verifiable Intent**, co-developed with Google. The FIDO **Payments Technical Working Group** for agent-initiated commerce is chaired by Mastercard and Visa.

AP2 chains signed **mandates**. The one that matters here is the **Intent Mandate**: a verifiable credential

- **signed by the user with a hardware-backed key on their device**,
- **time-to-live bounded**,
- carrying **structured constraints** (budget caps, categories, refundability) rather than prose,
- carrying **"prompt playback"** — the agent's stated understanding of the user's request, and
- carrying an **intentionally open-ended risk payload**.

Read that against §10.5. An Intent Mandate is a standing authorization — `match` + `amount_gt` + `expires_at` — rendered as a credential the card networks already accept. Phaedo's escalate-to-phone flow, with the subject's key in a secure enclave, is architecturally the **signing ceremony**. And "prompt playback" is the payments industry independently arriving at §10.2 `action_binding`: the observation that an agent's account of what it is doing must be committed to, separately from the doing.

Two designs reached the same primitive from opposite ends. That is the strongest available evidence that the primitive is right — and the cheapest available route out of the cold-start.

## The mapping

| Anamnesis (§10.5) | AP2 Intent Mandate | Note |
|---|---|---|
| authorization, `effect: "autoproceed"` | a grant in the mandate | the only effect that maps — see below |
| `match.domains` | `constraints.categories` | direct |
| `match.amount_lt` | `constraints.max_amount` | the ceiling — the only bound that may fill a spend cap |
| `match.amount_gt` | `constraints.annotations` | a **floor**, not a cap; annotation only (see below) |
| `match.reversible` | `constraints.refundable_only` | direct |
| `match.magnitude_max` | `constraints.annotations` | **advisory only** — magnitude is behavioral, not commercial; never a spend limit |
| `require_binding` (§10.2) | `requires_action_binding` | tells a verifier the subject demanded a bound action |
| `expires_at` | mandate `expires_at` | the mandate expires with the **first** grant to lapse |
| §10.3 consultation signal | `risk_payload.anamnesis_signal` | the one thing a behavioral system has to say to a payments network |

### Only grants become mandates

`escalate`, `require_human`, `decline`, and both `bias_*` effects produce **no mandate**. This is the profile's single most important rule.

An Intent Mandate is a grant of authority to act with the human not present. The correct AP2 rendering of "ask me first" is not a restrictive credential — it is **no credential at all**. Emitting one would invert the subject's meaning to a merchant, who would read the presence of a mandate as authorization.

For the same reason, a subject with no live `autoproceed` authorizations yields `null`, never a mandate with an empty grant list: an empty credential reads as "authorized, no constraints".

### The boundary holds on the new transport

Only the deterministic, subject-authored half crosses: authorizations, their bounds, their expiry. **No layer content, no inferred signals, no persona strength, no commitments.** The §10.4 consultation boundary applied to a payments transport — and the reason this payload is safe to hand to a merchant's stack.

The single behavioral fact that does cross is a §10.3 **signal** in the risk payload: *the subject's own oracle was consulted, and it said this*. That claim is precisely what makes a mandate more trustworthy to an issuer, and it says nothing about the subject.

## What is deliberately not built

**Signing.** `mcp/ap2.js` is a pure serializer. It renders the payload the phone would sign; it does not sign. The subject's key lives in the phone's secure enclave and is unreachable from the server by design. An unsigned mandate is a *proposal*.

Completing the loop is a natural next step and a small one, because the ceremony already exists: the escalation card is a biometric-gated approval on a device holding an enclave key. Turning that into an Intent Mandate signature is the same interaction with a different artifact. It needs §8.3 signing (OQ9) to land first, which is v0.3.

**Transport.** No endpoint, no merchant handshake, no wallet integration. This profile defines a *shape*; where it travels is the integrator's concern.

## Open questions

1. **Which AP2 revision to pin.** v0.2.0 (April 2026) introduced human-not-present flows; FIDO stewardship may re-cut the shape. The payload carries `anamnesis_profile: "0.1"` so a verifier knows which mapping produced it, but the profile should pin an AP2 revision once the FIDO TWG publishes one.
2. ~~**`amount_gt` is a floor, not a ceiling.**~~ ✅ **Resolved in v0.1.52.** `amount_lt` was added to `$defs/match`; it maps to `max_amount`, and `amount_gt` is demoted to an annotation. Mapping a floor into AP2's spend cap would have told a merchant the subject capped spending at exactly the figure above which they wanted *more* scrutiny — an inversion, on a payment credential. The same field also unblocked §10.7 proposing autonomy for priced classes.
3. **Whether a mandate should be per-agent.** AP2 mandates name a payer and a payee; Anamnesis authorizations are agent-agnostic until §10.5 `agents` is enforceable. Blocked on authenticated agent identity — see `docs/roadmap/agent-identity-mcp-i-2026-07-22.md`.
4. **Verifiable Intent.** Mastercard's VI turns an authorization into portable cryptographic evidence verifiable by issuers, networks and merchants. It is the closer analogue to §10.6 signed receipts than to §10.5, and deserves its own mapping pass once signing lands.
