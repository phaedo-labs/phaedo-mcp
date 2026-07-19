# Protocol Surface — `/v1/exchanges` (Loop 2 Exchange Buffer: Ship / Pull / Consume)

**Version:** 0.1.0-draft
**Date:** 2026-05-29
**Status:** Draft — **phone-side handlers REMOVED 2026-06-18 (dead code).** The
Loop-2 design moved to a per-session local pass → reconcile (M-accumulation was
removed 2026-06-09), so the phone never buffered exchanges in the live product.
The `/v1/exchanges` ship/pull/consume handlers + `exchangeBuffer.ts` have been
deleted from the vault app. The extension still assembles `exchange_batch`
envelopes for the local pass (the `EXCHANGE_BATCH` artifact kind is retained).
This doc is kept as the historical design record for that surface.
**Parent docs:** [v0.1.md](v0.1.md) §7, [../persona-extraction/privacy-architecture.md](../persona-extraction/privacy-architecture.md) §7, [../persona-extraction/loop2-integration.md](../persona-extraction/loop2-integration.md) §4.4, [../persona-extraction/m-session-accumulation.md](../persona-extraction/m-session-accumulation.md)

---

## 1. Purpose

Defines the authorized message types for the Loop 2 exchange buffer between the
working device (extension) and the phone (vault device), where the phone-resident
ring buffer persists exchanges encrypted at rest:

- **`exchange_batch`** (§2–§7) — ship a session's exchanges extension→phone.
- **`exchange_pull`** (§8) — request a working copy of the buffer back for an
  extraction pass (browser-side WebLLM, privacy §4.1).
- **`exchange_consume`** (§9) — confirm a pass succeeded; phone prunes the
  consumed exchanges.

This closes the protocol gap flagged in privacy-architecture §7 and
loop2-integration §6, and the pull/consume gap settled in
[m-session-accumulation.md](../persona-extraction/m-session-accumulation.md).

All three sit alongside the existing pair/session message types (`/v1/pair`,
`/v1/authorize`, `/v1/profile`, `/v1/fingerprint`, `/v1/metrics`).

---

## 2. Preconditions

- The pair + authorize handshake has completed and the session is **verified**
  (the SAS-gated state). An `exchange_batch` MUST be rejected on an unverified
  session — same rule as `/v1/fingerprint`.
- The user has opted in (`extractionEnabled`); the extension does not assemble
  or ship a batch otherwise (loop2 §4.1).

---

## 3. Envelope

The batch rides the standard §7.2 envelope under the **authorized session key**
already established by pair/authorize. No new key material is introduced.

- `alg`: `AES-256-GCM` (§7.1).
- `metadata.artifact_kind`: **`exchange_batch`** (new; added to protocol.js
  `ARTIFACT_KIND`).
- `metadata.created_at`: UTC timestamp.
- `metadata.session_local_id`: the per-page-load session id the exchanges share
  (not persisted, not an account identifier).
- `metadata.count`: number of exchanges in the batch (cleartext, for routing /
  backpressure only — discloses no content).

The canonical `metadata` is AAD (§7.3), binding it to the ciphertext.

---

## 4. Plaintext payload (the canonical artifact)

The ciphertext wraps the canonical serialization (§6) of:

```json
{
  "exchange_batch_version": "0.1",
  "session_local_id": "uuid-v4",
  "exchanges": [
    {
      "exchange_id": "uuid-v4",
      "platform": "Claude",
      "timestamp": "2026-05-29T00:00:00Z",
      "user_msg": "<user message text>",
      "ai_response": "<assistant response text>",
      "delta_annotations": { "corrections": [], "positive": false, "mental_models": [] }
    }
  ]
}
```

Only **complete, extraction-eligible** exchanges are shipped (loop2 §4.5): an
exchange with a paired assistant response, in a session the richness trigger
qualified. Incomplete (user-only) exchanges are never shipped.

---

## 5. Phone-side handling

- Verify the session, decrypt into process memory, append exchanges to the
  ring buffer (count + age cap, loop2 §4.4), persist the buffer encrypted at
  rest under the platform key store (privacy §3.3).
- Acknowledge. On ack, the extension prunes the shipped exchanges from its
  in-memory set (privacy §3.1).
- Plaintext is zeroed after the append (privacy §5).

---

## 6. Failure handling

- **Phone unreachable / no ack:** the extension retries a bounded number of
  times while the browser session is alive; unsent exchanges stay in process
  memory and are lost if the browser closes first — accepted degradation
  (privacy §3.4). They are NEVER spilled to the extension's disk store.
- **Unverified session:** reject; the extension does not retry-as-unverified.
- **Decrypt/AAD failure on the phone:** drop the batch, do not ack.

---

## 7. Extension-side seam

`loop2-capture.js` assembles the batch (`buildBatchPayload`) and exposes a
`shipEligible(transport)` seam. `transport` is an injected async function that:

1. wraps the payload via `Phaedo.Envelope.wrap(payload, sessionKey, metadata)`,
2. sends it over the established pair/session channel (LAN TCP or relay),
3. resolves on ack.

The envelope wrap + session-key handle + LAN/relay send are the
**mobile-coordinated** parts (they reuse the existing authorized-session
transport). Batch assembly and post-ack pruning live in the extension and are
implemented + tested now; the transport is wired when the mobile side accepts
`exchange_batch`.

---

## 8. Pull message — `exchange_pull`

Requests a working copy of the buffered exchanges back to the browser for an
extraction pass (privacy §4.1). The pass runs locally; only the fingerprint
update is retained.

- **Direction:** extension → phone. **Precondition:** verified session (same SAS
  gate as ship / `/v1/fingerprint`); reject otherwise.
- **Request payload** (canonical, enveloped under the session key,
  `metadata.artifact_kind = 'exchange_pull'`):
  ```json
  { "exchange_pull_version": "0.1", "intent": "extraction_pass", "max_count": 200 }
  ```
  `max_count` bounds the response for backpressure; the phone returns the most
  recent ≤ `max_count` exchanges.
- **Response:** a §7.2 envelope wrapping the standard `exchange_batch` payload
  (§4) — the buffered exchanges, encrypted under the session key
  (`metadata.artifact_kind = 'exchange_batch'`, `metadata.count`).
- **Idempotent:** a pull removes nothing; it returns a working copy. Removal
  happens only via `exchange_consume` (§9), so a pull whose pass never confirms
  is safely re-pulled next cycle.

---

## 9. Consume message — `exchange_consume`

Confirms a pass completed and the fingerprint update was persisted; the phone
prunes the consumed exchanges. Two-phase (pull → run → consume) so an
interrupted pass never loses exchanges.

- **Direction:** extension → phone. **Precondition:** verified session.
- **Sent only after** the pass succeeds and the §4.2 update is persisted.
- **Payload** (canonical, enveloped, `metadata.artifact_kind = 'exchange_consume'`):
  ```json
  { "exchange_consume_version": "0.1", "exchange_ids": ["uuid-v4", "…"] }
  ```
- The phone removes those `exchange_id`s from the ring buffer and acks. Unknown
  ids are ignored (idempotent). Re-processing un-consumed exchanges on a later
  pull is near-idempotent (reconcile dedups by field/polarity; delta is
  snapshot-idempotent), so the only cost of a missed consume is wasted compute.

---

## 10. Open items

- **Ring-buffer cap calibration** (count + age) — placeholder in loop2 §4.4.
- **Retry bound** for the phone-unreachable case — unspecified count/backoff.
  With the m-session-accumulation §3 fallback, an exhausted retry routes the
  session to the immediate local pass rather than dropping it.
- **Batch size cap** — a single ship should not exceed a reasonable size;
  partition very large sessions across multiple `exchange_batch` messages.
- **Pull pagination** — `max_count` + a cursor for buffers larger than one
  response.
- **Re-pull leasing** — an optional phone-side "pending" mark to skip re-pulling
  very recently pulled exchanges (bounds duplicate compute).
