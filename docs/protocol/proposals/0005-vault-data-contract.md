# Proposal 0005 — Vault-data (`vd`) contract

**Status:** ✅ RATIFIED + FOLDED into v0.1.12 (2026-06-09), after implementation.
Kept here as the rationale record. Applied as: informative **Appendix C** in `v0.1.md`,
`spec/schemas/vault-data.schema.json`, the consultation-boundary guard
(`validateVaultShape` in `mcp/consult-core.js`, structured `internal_error` on breach),
snapshot fixtures (`scripts/fixtures/context-block/` + drift-lock), and `spec/test-schemas.mjs` ties.
**Target (applied):** new informative appendix in `v0.1.md` + new
`spec/schemas/vault-data.schema.json`.
**Source:** consultation build brief §11.5, §5 (M0 step 2).
**Date:** 2026-06-09

## Problem

`vd` — the decrypted vault payload passed to `renderContextBlock(vd)` (injection) and to
`resolveConsultation(vd, …)` (consultation) — is a real, load-bearing shape shared by
three runtimes (content script, harness, MCP), but it is only documented by code
(`context-block.js validateVaultData`). The §4 fingerprint schema covers the
*fingerprint document*, not the *wrapper* the runtimes actually hold. Producers and
consumers should share one documented shape.

## Proposal

Publish the `vd` shape as an **informative** schema + appendix (informative because it is
a runtime payload convention, not a wire artifact like §4/§7). It documents the wrapper
keys the reference implementation passes around:

| Key | What it carries |
|---|---|
| `phaedo_fingerprint` | The §4 fingerprint document (incl. `consult_policies`, §10.5). |
| `phaedo_behavioral_signals` | Cross-session accumulated signals feeding the layers. |
| `phaedo_linguistic_profile` | Surface/style features used by injection. |
| `phaedo_session_metrics` | Session counters / persona-strength inputs (no content). |

Each field documented; all optional (an empty vault is legitimate — `validateVaultData`
distinguishes *empty* from *malformed*). The schema is the documented form of the guard
that already exists in `context-block.js`; the brief's M0 also asks to centralize that
guard (`lib/validate-vd.js`) and wire it at all three consumer boundaries — fail loud in
dev/harness (named violating field), fail safe in production (skip injection / structured
error, never proceed on partial data).

## Schema delta (when ratified)

Add `spec/schemas/vault-data.schema.json` (draft 2020-12, all keys optional, additive);
add an informative appendix to `v0.1.md` pointing to it; extend `spec/test-schemas.mjs`
to validate the reference `vd` fixtures. Keep it **informative** — it must not become a
normative wire shape (the normative artifacts stay §4 fingerprint + §5 configuration).

## Risk

Informative only; documents existing behavior. The main caution is to not let the `vd`
wrapper drift into looking normative — it is a convenience payload, and the canonical
artifacts remain the §4/§5 documents inside it.
