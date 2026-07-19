# Security Policy

Phaedo handles encrypted personal data — security reports are taken seriously
and handled with priority.

## Reporting a vulnerability

**Please do NOT open a public issue for security problems.**

Email **hello@phaedo.so** with:

- A description of the issue and where it lives (file/function if known)
- Steps to reproduce, or a proof of concept
- The impact as you understand it (what an attacker gains)
- How you'd like to be credited, if you would

You'll get an acknowledgment within **7 days** (usually much sooner). Please
allow a reasonable window for a fix before any public disclosure — we'll work
with you on timing and credit you in the release notes unless you prefer
otherwise.

There is currently no bug bounty program.

## Scope

This repository: the reference MCP server (`mcp/`), the protocol JSON Schemas
(`spec/`), and the vendored crypto/envelope modules (`envelope.js`, `kdf.js`,
`identity.js`, `protocol.js`, `context-block.js`).

Especially interesting: anything that breaks the project's core guarantees —

- fingerprint data readable at rest or in transit (it must stay encrypted
  outside the active process)
- consultation responses leaking fingerprint *structure* rather than signals
  (spec §10.4)
- user-authored policies (§10.5) being overridable by inferred data
- the receipts log (§10.6) being silently mutable
- pairing/revocation bypasses

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (latest) | ✅ |

The npm package `phaedo-mcp` tracks this repository; fixes ship as patch
releases.
