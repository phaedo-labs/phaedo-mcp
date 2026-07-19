# Phaedo — your cognitive fingerprint, on every AI surface

[![npm](https://img.shields.io/npm/v/phaedo-mcp)](https://www.npmjs.com/package/phaedo-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Phaedo learns **how you think** — communication style, working style, decision
pattern — into a portable, user-owned **cognitive fingerprint**, and carries it to
any AI tool. This repo is the open half of that system:

- **`spec/`** — **Anamnesis** (formerly "Phaedo Protocol"), the open
  cognitive-fingerprint standard: machine-readable JSON Schemas (fingerprint
  layers, consultation request/response, deference policies, receipts) + the
  conformance suite.
- **`docs/protocol/`** — the Anamnesis spec (v0.1), the MCP binding, and accepted
  proposals.
- **`mcp/`** — the reference **MCP server** (`phaedo-mcp` on npm): injects your
  fingerprint at session start and answers **agent consultations** — an agent at a
  decision point can ask "would my human proceed here?" and get a calibrated
  `proceed / clarify / escalate / decline` signal (or an honest abstain), gated by
  user-authored deference policies, with an encrypted on-device audit trail. On a
  blocking signal it can **escalate to your paired phone in real time** for a live
  approve / deny / modify, and your overrides teach the **act-as-me** channel —
  how you want delegated work handled, not just how you work yourself.

## Quick start

```bash
npx phaedo-mcp        # run the server over stdio
```

Or wire it into Claude Desktop / Cursor / Claude Code automatically:

```bash
npm install -g phaedo-mcp
cd "$(npm root -g)/phaedo-mcp" && npm run setup
```

Out of the box it serves a sample fingerprint, so every tool works immediately.
Your *real* fingerprint comes from the Phaedo app — currently in **private beta**
([phaedo.so](https://phaedo.so)) — learned on-device from your actual
usage; pair with `npm run pair`. See
[`mcp/README.md`](mcp/README.md) for the full guide (pairing, policies, receipts,
the agreement metric).

## Design commitments

- **User-owned & local.** The fingerprint lives on your devices, encrypted; the
  server holds no plaintext at rest. Nothing is sent to any Phaedo service.
- **Signals out, never structure.** Consultations return a signal + confidence —
  never fingerprint internals (spec §10.4).
- **Honest abstention.** No coverage → `insufficient_signal`, not a confident guess.
- **User-authored guardrails win.** Deference policies (§10.5) override any
  inferred signal; standing authorizations are explicit and auditable (§10.6).

## What's not in this repo

The learning pipeline that *builds* fingerprints (conversation capture, on-device
extraction models) is Phaedo's proprietary side. This repo is everything a
client, agent, or independent producer needs to **consume and interoperate**:
the spec, the schemas, and a complete reference server.

## License

[Apache-2.0](LICENSE). The Phaedo name and logo are trademarks; see phaedo.so.
