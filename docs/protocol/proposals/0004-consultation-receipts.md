# Proposal 0004 — Consultation receipts

**Status:** ✅ RATIFIED + FOLDED into v0.1.13 (2026-06-10), after implementation.
Kept here as the rationale record. Applied as: §10.6 in `v0.1.md`,
`spec/schemas/consultation-receipt.schema.json`, `mcp/receipts.js` (HKDF
`phaedo:receipts:enc:v0.1` from the stored root key; append-only API; `user_action`
the sole mutation; cap-eviction; `npm run receipts` dev readout), receipt writes in
both consultation tools (fail-safe, post-resolution), and `test-receipts.mjs` +
live-server smoke assertions. One delta from the draft below: a `via` field was added
(`phaedo_consult` | `phaedo_check_authorization`) so agreement tracking (M5) can weigh
full consultations and matched pre-flights separately; unmatched pre-flights write no
receipt (probes are not decisions).
**Target:** new `v0.1.md` §10.6 (proposed) + a new domain-separation context in §7 +
relationship to the reserved §8.3 `signatures` field.
**Source:** consultation build brief §11.4, §9 (M4).
**Date:** 2026-06-09

## Problem

There is no record of what an agent asked and what the oracle answered. Without it there
is no audit trail for the subject, and no data layer for the delegation gradient
(proposal-adjacent: agreement tracking, brief M5). Receipts must exist **without
weakening the privacy invariant** — Phaedo holds nothing; the record lives only in the
vault.

## Proposal

Define an encrypted, append-only, on-device **receipt** emitted for every resolved
consultation (including abstains).

### Receipt object

```json
{
  "receipt_id": "uuid-v4",
  "created_at": "2026-06-09T17:00:00Z",
  "agent_id": "vendor_agent_v2.4",
  "request": {
    "consultation_type": "action_approval",
    "action_descriptor": { "domain": "financial", "reversible": false, "magnitude": "high" }
  },
  "response": { "signal": "escalate", "confidence": 0.78, "deference_level": "high" },
  "user_action": null
}
```

- `user_action` is `null` at write time; updated later when override data exists:
  `approved | rejected | modified | unknown`. It is the **only** mutable field.
- The receipt stores the *request descriptor and the response signal* — never layer
  content, never the projection, never free-text subject content (§10.4 holds).

### Storage & semantics

- **Encrypted at rest** in the vault using the same AES-256-GCM envelope machinery
  (§7), with a **distinct domain-separation context**: `phaedo:receipts:enc:v0.1`.
  Receipts never leave the device.
- **Append-only.** Receipts are never edited (except `user_action`) and never
  individually deleted. Account deletion destroys the receipt store with everything else.
- **Bounded.** A configurable cap (start 5,000, oldest evicted) prevents unbounded
  on-device growth.
- **Write site.** The MCP/transport layer emits the receipt **after** resolution; the
  resolver stays pure (it does no I/O). One receipt per resolved request.

### Relationship to §8.3 signatures (future)

§8.3 reserves a `signatures` field for post-v1.0 Ed25519. A signed receipt
(subject- or producer-signed) would let a third party verify "this agent did consult the
subject's oracle and got this signal" without seeing the fingerprint — an enterprise/
attestation primitive. Out of scope for v0.1; noted so the receipt shape leaves room.

## Schema delta (when ratified)

Add `spec/schemas/consultation-receipt.schema.json`; add §10.6 to `v0.1.md`; register
the `phaedo:receipts:enc:v0.1` context in §7/§5.5's domain-separation list; extend
`spec/test-schemas.mjs`.

## Risk

New encrypted artifact in the vault. Must reuse the existing envelope/key machinery (no
new crypto) and must never spill plaintext outside the vault. The mutable `user_action`
field is the only break from strict immutability — keep it the only one.
