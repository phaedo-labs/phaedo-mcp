# 0008 — Fingerprint sync mailbox (offline-tolerant, two-way)

Status: **COMPLETE — two-way, device-verified, merged 2026-06-18** (Randy, iPhone + Chrome).
Phone→extension (#39) and extension→phone (#40) sync both confirmed on-device; stale-pairing
prune (#40) and the `rules_updated_at` authored-content clock (#41) merged. Empty-vault
recovery re-pair builds on this mailbox (#43).
Relates to: 0005 (vault data contract), 0006 (conflict resolution), 0007 (authored decision rules).

## Status detail / handoff (2026-06-18)

Working end-to-end, device-verified: a rule authored on the phone reaches the extension
(and its questionnaire) even when the phone is offline at sync time.

Bugs found and fixed during device test (each its own commit):
- relay `Dockerfile` only `COPY`d `server.js`, so deploys silently shipped without
  `mailbox.js` → every redeploy stayed 404. Now `COPY *.js ./`.
- the drain was gated behind a live session (almost never held) → moved to run on every
  popup open, session-independent, in `initPhoneSync`.
- the phone encrypted under a *stale* extension's `pair_key` (the client registry
  accumulates verified clients across re-pairs and `fpSync` picked the oldest) → now picks
  the most-recently-registered verified client.
- the merge tie-break was "longer text wins", so shorter fresh phone edits lost → replaced
  with `mergeFingerprintForLocal` (LWW by `updated_at`, tie → phone), unit-tested.

Done (all merged + device-verified):
1. ✅ **Reverse direction (extension → phone)** (#40). `fpSync.drainFingerprint` pulls the
   `to_phone` slot, decrypts under `fp_sync_key`, merges via `syncMerge.mergeExtensionDeposit`
   (TS port of `sync-merge.js`'s `mergeFingerprintForLocal`, tie toward local so the shared
   "phone wins ties" invariant holds on both sides), saves, `notifySync()`s. Triggered from
   `navigation` `bringUp` on launch + every foreground once the relay assigns a device id.
2. ✅ **Stale-pairing cleanup** (#40): `clientRegistry.setVerified` keeps only the just-verified
   client, so a clean re-pair leaves a single live pairing shared by both devices.
3. ✅ **`rules_updated_at`** (#41): a separate authored-content clock, so an extraction that
   bumps only `updated_at` can't mask a more-recently-authored rule. The merge resolves
   inferred content by `updated_at` and authored content by `rules_updated_at`.

## Problem

Fingerprint sync between the phone and the extension was **synchronous request/response
through the relay**, which requires **both devices live on the relay at the same instant**:

- `silentSync` has a single trigger — opening the extension popup (`popup.js`). No
  background/periodic sync.
- The phone **never initiates**. `saveFingerprint` (`mobile/.../vault.ts`) writes the
  local vault and stops; it does not upload or announce. The phone is a passive server.
- So a rule authored on the phone only propagates if the extension opens its popup
  **and** `GET /v1/profile` succeeds — phone foregrounded (iOS suspends backgrounded
  sockets), connected to the relay (it flaps every ~1–2 min on cellular, see
  `docs/testing/qr-free-pairing-2026-06-01.md`), and the session unexpired.

This is the same "simultaneous liveness" wall we hit on 2026-06-04 and solved **for the
pairing seed** with a store-and-forward mailbox — but never applied to the fingerprint.

**Architectural forcing function:** a browser extension has **no inbound address**, so the
phone can *never* push to it directly. The only durable phone→extension path is a mailbox
the extension drains later. A mailbox is required, not merely convenient.

## Design

A bidirectional, pull-only mailbox on the relay, mirroring the seed mailbox.

### Relay (landed)
`relay/mailbox.js` (pure, unit-tested) + routes in `relay/server.js`:

- `POST /fp-mailbox/:deviceId/:dir` — deposit ciphertext (latest-per-direction wins; 512 KB cap).
- `GET  /fp-mailbox/:deviceId/:dir` — drain the latest **without consuming it**.
- `dir ∈ {to_ext (phone→extension), to_phone (extension→phone), agent_to_ext (paired agent→extension)}`.
- TTL **7 days**; swept every 60 s alongside the seed mailbox.
- The relay holds **only ciphertext** — it validates an `envelope` field is present but
  cannot read it.

`agent_to_ext` (spec v0.1.32) is a **separate slot** from `to_ext`: a paired agent (the
MCP server) deposits an encrypted delegation-promotion suggestion for the extension to
drain + union-merge, and using its own direction means an agent deposit can neither
clobber nor be clobbered by the phone's `to_ext` fingerprint deposit. Same `fp_sync_key`
(the MCP shares the extension's pairing), same ciphertext-only guarantee.

**No-delete-on-read** is deliberate: draining is idempotent (clients merge — below), so a
dropped GET response can never lose data; entries are superseded by a newer deposit or expire.

In-memory (a relay restart drops queued entries). Acceptable: the source device still holds
its fingerprint and re-deposits on its next save/sync.

### Crypto (constant landed)
Mailbox payload = a §7.2 envelope encrypted under
**`fp_sync_key = HKDF(pair_key, "phaedo-fp-sync-v0.1")`** (`HKDF_INFO.FP_SYNC_KEY`).

`pair_key` is already persisted on **both** sides (`pairing.pair_key` on the extension,
`client.pairKey` on the phone), so `fp_sync_key` is derivable on either device **with no
live session and no biometric** — the property that makes asynchronous store-and-forward
possible. A distinct sub-key, so it never reuses `pair_key`'s HMAC-in-authorize role or
`seed_key`'s envelope role.

### Conflict resolution (reuses 0006 + sync-merge.js)
A deposit carries a whole fingerprint. On **drain**, the receiver does **not** overwrite —
it reconciles:
- **Authored content** (`standing_rules` + their rule-elicitation answers): **union-merge**
  via `sync-merge.js` — never lose a rule written on either device.
- **Inferred content** (signals/summary/closed-form answers): **last-write-wins** by
  `updated_at`, as today.

This is exactly the extension's existing `reconcileFingerprint`, now fed from the mailbox
instead of only a live `GET /v1/profile`.

## Security

- **Trust model unchanged.** The relay already holds the encrypted **seed** (more sensitive
  than the fingerprint) for 10 min. Holding fingerprint ciphertext under a pair-derived key
  the relay cannot read crosses **no new boundary**.
- **Weaker forward secrecy than the session-key path** (static pair-derived key vs ephemeral
  session key) — identical to the seed mailbox, and the cost of offline delivery. `pair_key`
  rotates on re-pair. Documented trade-off; accepted for the seed already.
- **Bounds:** 7-day TTL, 512 KB cap, latest-wins (no unbounded growth per device).

## Client responsibilities (pending — implement after review)

**Extension (`popup.js`)**
- On `silentSync`: in addition to the live `GET /v1/profile` fast-path, `GET
  /fp-mailbox/:dev/to_ext`, unwrap with `fp_sync_key`, run `reconcileFingerprint`. Works
  even when the phone is **offline** — this is what fixes the reported bug.
- On local save/extract (and after a merge that changed local): deposit to
  `/fp-mailbox/:dev/to_phone` so the phone gets it whenever it's next online.

**Phone (`mobile/src/lib/`)**
- Add `deriveFpSyncKey` (mirror `deriveSeedKey`) + a TS port of the union-merge.
- On `saveFingerprint`: deposit to `/fp-mailbox/:dev/to_ext`.
- On relay connect / app foreground: `GET /fp-mailbox/:dev/to_phone`, merge, save.

## Open decisions for review
1. **TTL = 7 days** — long enough to bridge a device offline for a week; bounded so the
   relay isn't an archive. Longer/shorter?
2. **Static `fp_sync_key`** (vs a periodically re-derived key) — accept the seed's forward-
   secrecy trade-off for offline delivery? (Recommended: yes, for parity + simplicity.)
3. **Deposit cadence on the phone** — every save, or debounced? (Recommended: every save;
   deposits are small and overwrite.)

## Test status
- `relay/mailbox.js` — `scripts/test_fp_mailbox.mjs` (16 checks): isolation, latest-wins,
  ciphertext guard, idempotent drain, TTL/sweep.
- `sync-merge.js` — `scripts/test_sync_merge.mjs` (14 checks): the union-merge reused here.
- Client crypto wiring is **device-test-only** (no relay/devices in CI) — flagged on landing.
