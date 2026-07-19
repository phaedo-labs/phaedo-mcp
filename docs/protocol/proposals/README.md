# Protocol Spec Proposals — queued, not normative

This directory holds **queued proposals** for changes to the Phaedo Protocol spec
(`../v0.1.md`). Per the consultation build brief's working discipline (§2.5, §11), any
change to the normative spec is a **proposal first**. Nothing here is in effect until it
is reviewed and explicitly folded into `v0.1.md` with a change-log entry and (where
applicable) a `spec/schemas/` update + conformance test.

**Status of everything in this dir: QUEUED FOR REVIEW. Do not build against a proposal
as if it were ratified.** The stable, build-against surfaces remain the shapes already
in `v0.1.md` (§9 injection, §10.2/10.3 consultation request/response, §10.5 policies).

## Index (queued 2026-06-09, from the consultation build brief §11)

| # | Proposal | Touches | Why |
|---|---|---|---|
| 0001 | Abstain signal (`insufficient_signal`) | §10.3 enum | ✅ **FOLDED v0.1.9** — implemented + ratified. A confidently-wrong `proceed` is the worst output; abstain when coverage is thin. |
| 0002 | Normative Decision & Risk signal schema | §13 Q13 (one layer) | ✅ **FOLDED v0.1.14** — `decision-risk-signal.schema.json` (dimension/polarity/value/confidence/evidence_basis); producer emits + resolver consumes. domain/threshold reserved. |
| 0003 | Standing authorizations | §5.2 + §10.5 | ⏳ **A-half FOLDED v0.1.10** (authored semantics on `consult_policies`: `amount_gt`, force=authorization@conf 1.0, authored-only test). B-half (§5 home) queued for v0.2. |
| 0004 | Consultation receipts | new §10.6 (proposed) | ✅ **FOLDED v0.1.13** — §10.6 + receipt schema + `mcp/receipts.js` (`phaedo:receipts:enc:v0.1`, append-only, cap-evicted). |
| 0005 | Vault-data (`vd`) contract | new informative appendix | ✅ **FOLDED v0.1.12** — Appendix C + `vault-data.schema.json` + consultation-boundary guard + snapshot fixtures. |
| 0006 | Conflict resolution + provenance | new §4.7 | ✅ **FOLDED v0.1.20; FULLY INTEGRATED v0.1.24–v0.1.28** — deterministic evidence-tier resolution + ≥3 floor → `unresolved` (`resolveDimension()`/`resolveLayer()` + TC-RESOLVE vectors), then a reviewable `conflict_records[]` queue (v0.1.24), **injection suppression** of open-conflict dimensions (v0.1.27), and the symmetric **consult suppression** (v0.1.28, `mcp/consult-core.js`). Closes the autonomy-class defect; provenance = the `signals[]` log (no wire change). |
| 0007 | Authored decision rules (one home: `standing_rules`) | §4.3/§4.7 + §5.2 + §9 + §10.5 | ✅ **FOLDED v0.1.21 (2026-06-17, rev. 3).** One authored home `standing_rules[]` (§5.2 shape, A-home) with a `kind: instruction \| authorization` discriminator — realizes 0003's model and supersedes the standalone `consult_policies` (kept as a deprecated read-path alias, migrated). Instruction = verbatim rule + optional `decision` binding (marks DR dimension authored-canonical, §4.7); authorization = §10.5 matcher→effect gate. Renders §9.1's unbuilt standing-instruction projection. **Rejects** an in-layer evidence tier (rev. 1, §4.6/§5 confusion) and standalone `anchors[]`. Diffs: `0007-schema-diffs.md`; onboarding bank: `0007-onboarding-decision-rules.json`. **§E delta promotion** folded v0.1.22 and **fully wired 2026-06-19** — `promoteRules()` now runs in the live extraction pass (`extraction/offscreen-runner.js`/`orchestrator.js`) and the review surface moved to the extension popup ("Rules to review" card + shared attention dot; the interview `Review.jsx` was removed). |
| 0008 | Fingerprint sync mailbox (offline-tolerant, two-way) | new relay mailbox + §8 sync | ✅ **COMPLETE — device-verified, merged 2026-06-18 (PRs #39–#41).** Relay store-and-forward mailbox (`relay/mailbox.js`) holds ciphertext-only fingerprints under `fp_sync_key = HKDF(pair_key)`; clients drain on reconnect (no simultaneous liveness). Directions `to_ext` (phone→ext), `to_phone` (ext→phone), and **`agent_to_ext`** (a paired agent → ext, added v0.1.32 for the act-as-me delegation-suggestion deposit — Proposal 0007 §E / delegation promotion). Authored-content union merge so a rule is never clobbered by whole-fp LWW; separate `rules_updated_at` clock (#41). Spec ref: `docs/protocol/v0.1.md`. |

## Review gate (what folding a proposal in requires)

1. Randy's explicit approval of the shape.
2. Edit `v0.1.md` (body + change-log row; bump doc minor).
3. If it changes a machine surface: update/add the `spec/schemas/*.schema.json` and
   extend `spec/test-schemas.mjs` so the schema and the reference impl stay tied.
4. Keep the wire `phaedo_protocol_version` at `0.1` unless a shape actually breaks.
