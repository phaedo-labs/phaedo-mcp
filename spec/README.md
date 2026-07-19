# Anamnesis — open spec

*(formerly "Phaedo Protocol", retained as a v0.x alias; **Phaedo** is the reference
implementation and steward — see `../docs/protocol/v0.1.md` §1.4.)*

**A portable, user-owned format for modeling *the person* — not a bot persona — and
a constrained API for AI sessions and agents to consult it.**

Phaedo represents a subject's **cognitive fingerprint**: how they think, communicate,
decide, and work, across eight layers. The fingerprint is produced on the subject's
device, encrypted under keys the subject controls, and consumed by any conforming AI
session or agent — so outputs align to the *individual*, not the platform. Unlike
agent-persona formats (which give a *bot* a personality) and memory stores (which
keep *episodic facts*), Phaedo models the human and is built for **portability +
privacy + consultation**.

This directory is the machine-readable, externally-consumable surface. The full
normative text is `../docs/protocol/v0.1.md` (working draft v0.1.x).

> **Direction (2026-06-09): consultation-led.** Phaedo leads with **consultation** — the
> user-owned decision-style oracle an agent queries at a fork (§10) — over **injection**
> (§9), which mainstream assistants have commoditized via auto-memory. Injection remains a
> supported surface; consultation is the distinguishing one. See
> `../docs/roadmap/consultation-reframe-2026-06-09.md`.

## What's here

| File | What it specifies |
|---|---|
| `schemas/fingerprint.schema.json` | The §4 fingerprint (8 layers, signals). The decrypted vault payload. |
| `schemas/consultation-request.schema.json` | §10.2 — what an agent sends to `phaedo_consult` at a decision point. |
| `schemas/consultation-response.schema.json` | §10.3 — the constrained **signal** returned (never layer content, §10.4). |
| `schemas/consultation-policy.schema.json` | §10.5 — subject-authored guardrails / standing authorizations that override the inferred signal. |
| `schemas/authorization-check-response.schema.json` | The result of `phaedo_check_authorization` — a deterministic-only pre-flight over §10.5 authorizations (no inference; only the rule's decision crosses, §10.4). |
| `schemas/vault-data.schema.json` | **Informative** — the decrypted runtime payload (`vd`) reference consumers share (Appendix C): fingerprint + metrics wrappers, empty-vs-breach semantics. |
| `schemas/consultation-receipt.schema.json` | §10.6 — one entry in the encrypted, append-only, vault-held audit record of resolved consultations (at-rest shape, never leaves the device). |
| `schemas/decision-risk-signal.schema.json` | §4.2.7 — normative per-signal shape for the Decision & Risk layer (dimension/polarity/value/confidence/evidence_basis); resolves Q13 for the hero layer. |

JSON Schema draft 2020-12. Validated against the reference implementation +
examples by `test-schemas.mjs` (`node spec/test-schemas.mjs`).

### Validate your own fingerprint

`validate-fingerprint.mjs` is the conformance checker (`phaedo-validate`) — the
same code `test-schemas.mjs` runs, so the tool and the spec never disagree. Point
it at a fingerprint document **or** a runtime vault payload (it auto-detects the
`phaedo_fingerprint` wrapper); it prints line-level errors and exits non-zero on
any failure, so you know exactly when your producer is conformant:

```
node spec/validate-fingerprint.mjs my-fingerprint.json
```

It enforces the schema **plus** signal uniqueness per (field, polarity, domain)
(which JSON Schema cannot express across array items) **plus §4.6 layer admission**
— behavioral layers carry persona patterns, never episodic content, so a value with
a URL / email / domain is rejected. Importable too:
`import { validateFingerprint, validateVaultData } from './validate-fingerprint.mjs'`.
The per-layer signal **field vocabulary** (§4.2, OQ13) is published at
[`layer-vocabulary.json`](layer-vocabulary.json), generated from the reference
producer catalog and kept in sync by `test-schemas.mjs`.

## Conformance levels (start at Level 0)

§11 groups conformance into three levels by adoption cost:

- **Level 0 — Projection Consumer (no cryptography).** Read the
  `phaedo://fingerprint/projection` MCP resource (or a §9.3 `projection` string) and
  insert it. You consume a string — no envelope, no schema machinery. **Any MCP host
  already qualifies.** This is the on-ramp.
- **Level 1 — Consumer / Injector / Agent Consultant.** Decrypt artifacts (§7), read
  the §4/§5/§10 shapes, inject or consult.
- **Level 2 — Producer.** Create and update artifacts.

The reference implementation's self-identification (§11.3) is published at
[`conformance.json`](conformance.json) and kept honest by `test-schemas.mjs`. Run
`node spec/test-vectors.mjs` to execute the §12 conformance vectors.

## The two consumption surfaces

1. **Injection (§9)** — a *projection* (system-prompt block) inserted at session
   start so the assistant responds in the subject's style. Commoditized; table-stakes.
2. **Consultation (§10)** — an agent queries *how the subject would decide* at a fork
   and gets back a constrained signal: `proceed | proceed_with_note | clarify |
   escalate | decline`, with `confidence` and a `deference_level`. This is the
   distinguishing primitive: a portable, **user-owned decision-style oracle** any
   agent can consult, with **standing policies** (§10.5) the subject authors to make
   delegation safe ("always escalate irreversible spend", "auto-proceed low-stakes
   writing").

## Transport

The reference transport is **MCP** (Model Context Protocol) — see
`../docs/protocol/mcp-binding.md`: `phaedo_request_injection` (tool) +
`phaedo://fingerprint/projection` (resource) for §9, and `phaedo_consult` (tool) for
§10 plus `phaedo_check_authorization` (tool) — a deterministic-only pre-flight over the
§10.5 standing authorizations. The core spec is transport-agnostic; any conforming
transport may carry it.

## Boundaries (non-negotiable)

- **Ciphertext only leaves the device** (§7). Consumers hold the decrypted artifact
  only with the subject's key material, locally.
- **Consultation returns only signals, never layer content** (§10.4). An agent that
  needs content uses injection and accepts its boundaries.
- **Persona memory ≠ conversation memory.** This spec is persona (stable patterns).
  Episodic facts are a separate, opt-in scope.

## Status & license

Working draft (v0.1.x); v1.0 targeted for first public release. Schema/envelope may
change incompatibly before v1.0; semver applies after. License: the protocol,
schemas, envelope, injection/consultation shapes, reference clients, and conformance
tests are intended for permissive open-source release (see `../docs/protocol/v0.1.md`
Appendix A for the open-vs-proprietary boundary).
