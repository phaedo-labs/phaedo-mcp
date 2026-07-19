# Contributing

Thanks for your interest — issues, ideas, and fixes are welcome. A few things
about how this repository works will save you time.

## How this repo is maintained (read first)

This repository is the **published export of a private monorepo** (Phaedo's
open half: the spec, schemas, and reference MCP server). Its history may be
regenerated on release, and changes land here *from* the monorepo — which means
a PR merged directly into this repo can be overwritten by the next export.

So the practical workflow is:

- **Bugs & questions → open an issue.** Always valuable, never lost.
- **Small fixes → PRs are welcome**; a maintainer ports the change into the
  monorepo (with credit in the commit and release notes) and it flows back out
  in the next export. Your PR may be closed as "ported" rather than merged —
  that's the change *succeeding*, not being rejected.
- **Anything substantial → open an issue before writing code**, so we can agree
  on direction first.

Note: a formal DCO/CLA policy is being finalized; until then, by submitting a
contribution you affirm it's your own work and you're licensing it under this
repo's Apache-2.0 terms.

## Protocol changes

The spec (`docs/protocol/v0.1.md`) changes through **proposals** — see
`docs/protocol/proposals/README.md` for the format and the 0001–0005 examples.
Open an issue describing the problem first; normative changes are folded only
after an implementation exists (the conformance suite enforces that schemas
match what the engine actually emits).

## Development

```bash
cd mcp
npm install
npm test                      # full server suite (10 suites)
cd .. && node spec/test-schemas.mjs   # schema conformance (84 checks)
```

PRs should keep both green. CI runs the same on every PR.

## Security issues

**Not here** — see [SECURITY.md](SECURITY.md) for private reporting.
