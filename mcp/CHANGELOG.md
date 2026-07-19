# Changelog — phaedo-mcp

## 0.2.2 — pending publish (metadata only)

`repository` (package.json + server.json) → the new PUBLIC open-core repo
`github.com/phaedo-labs/phaedo-mcp` (spec + reference server; staged by
`scripts/export-public-repo.mjs`). The prior target — the `phaedo-labs/phaedo`
monorepo — is private, so npm's Repository link 404'd for the public.
`directory`/`subfolder: mcp` unchanged (the public repo keeps the same layout).
No code change, no wire change; `phaedo_protocol_version` stays `0.1`.

## 0.2.1 — published 2026-07-18 (metadata only)

Namespace + repository move from the personal `galavoxx` account to the `phaedo-labs`
org — no code change, no wire change. `phaedo_protocol_version` stays `0.1`.

- **MCP registry namespace:** `mcpName` / `server.json name` → `io.github.phaedo-labs/phaedo-mcp`
  (was `io.github.galavoxx`). Publishing under the org (legal owner), not a personal account.
  The registry entry had not been published under the old namespace, so nothing is orphaned.
- **`repository` now points at the real source of truth:** `github.com/phaedo-labs/phaedo`
  with `directory`/`subfolder: mcp` (package.json + server.json), instead of the separate
  `galavoxx/phaedo-mcp` mirror. Publishing straight from the monorepo — no mirror to keep in
  sync, which was the drift source behind the 0.1.1→0.2.0 gap.

## 0.2.0 (2026-07-18) — protocol v0.1.24 → v0.1.39

Everything since the 0.1.1 publish (2026-06-10). All additive; the wire
`phaedo_protocol_version` stays `0.1`, so 0.1.1 clients keep working. Headline: a new
real-time **escalation channel** (two new tools) and the **act-as-me / delegation** loop
end to end. Two new public tools since 0.1.1 — `phaedo_escalate`, `phaedo_escalation_status`
— on top of `phaedo_record_outcome`.

### Real-time escalation channel — NEW (v0.1.33–v0.1.35)

- **`phaedo_escalate` + `phaedo_escalation_status` (v0.1.33).** When an agent acting
  autonomously for the subject hits a process-blocking signal and no one is at its
  conversation, route the decision to the subject's paired device for a live **approve /
  deny / modify**. `phaedo_escalate` self-gates (runs the consult, only wakes on a blocking
  signal), deposits a ciphertext-only request, and returns a `request_id` (non-blocking);
  `phaedo_escalation_status` polls and, on resolution, records the live decision as the §10.6
  outcome automatically. Relay holds ciphertext only (sealed under `fp_sync_key`); only the
  action descriptor + consult `signal`/`rationale_hint` ever cross (§10.4). **No-response
  policy: a bounded window (`PHAEDO_ESCALATION_WINDOW_MS`, default 3 min) with a safe default
  of HOLD** — a timeout is not an override and teaches nothing. `mcp/escalation.js`,
  `mcp/server.js`; locked by `mcp/test-escalation.mjs`.
- **Escalation push-gating: `clarify` is stakes-gated + subject-configurable (v0.1.34).**
  `escalate` always wakes the subject; `clarify` (the agent's uncertainty reflex, fires often)
  wakes only when the action is **consequential** (`reversible === false` OR
  `magnitude === 'high'`) — else it resolves in the agent's own flow and surfaces in the
  deferred review queue, no interruption. The gate is a DEFAULT overridable globally + per
  domain via an **escalation push policy** (vault-portable `escalation_policy` and/or local
  `PHAEDO_ESCALATION_POLICY`, file wins). `escalate` is deliberately NOT configurable.
  `mcp/escalation.js`, `mcp/escalation-policy.sample.json`.
- **APNs hardware wiring (v0.1.35).** Real push-to-wake for a backgrounded phone (content-free
  wake, §10.4-safe) lives in `relay/` + `mobile/`; the MCP escalation path is inert-safe until
  Apple credentials are configured (the foreground WS delivers meanwhile).

### Act-as-me / delegation channel — end to end (v0.1.25, v0.1.29–v0.1.32)

- **`phaedo_record_outcome` + the delegation resolver (v0.1.29–v0.1.30).** *How the subject
  wants work done FOR them ≠ how they do it themselves.* `delegation` signals are DERIVED from
  the consult override history — a `rejected`/`modified` outcome lifts into a delegation signal
  on the consult's driving dimension(s); the resolver's origin-awareness lets a `delegation`
  signal OUTRANK a `self` one for the same dimension. New tool **`phaedo_record_outcome`** marks
  the outcome in-flow. Honesty rail: ONLY an override teaches (`approved` teaches nothing), so
  the channel can't become "agent obedience". Loop closes in the local receipt store — no
  fingerprint write-back. `mcp/consult-core.js`, `mcp/server.js`; locked by `mcp/test-consult.mjs`.
- **Delegation promotion — make a learned act-as-me preference portable (v0.1.30–v0.1.32).** An
  established override pattern (|net corrections| ≥ 3 on a canonical dimension) is staged as a
  reviewable `suggested_rules` candidate (producer, `buildDelegationPromotions`), carried across
  the sync boundary to the extension's review queue via a new `agent_to_ext` mailbox direction
  (`mcp/delegation-sync.js`), and — once the subject endorses — authored as a `standing_rules`
  entry with `decision.origin:"delegation"` that shapes BOTH injection and consult, portably.
  Authored-only invariant holds: the MCP only ever suggests. Locked by `mcp/test-delegation-sync.mjs`,
  `mcp/test-consult.mjs`.
- **Consult provenance (v0.1.25).** The §10.6 receipt gains optional `drivers[]` — the
  Decision&Risk cues that drove an inferred consult — recorded for the subject's LOCAL audit
  only, never in the agent-facing response (§10.4). `mcp/consult-core.js`, `mcp/receipts.js`.

### Receipts audit channel — MCP ⇄ phone (v0.1.38)

- Closes the act-as-me loop's transport: §10.6 receipts previously needed the dev CLI
  `node receipts.js mark` to ever teach. Now `mcp/receipts-sync.js` deposits a §10.4-safe
  receipts DIGEST (whitelisted subset — never `drivers`, never layer content) best-effort after
  every receipt-producing tool, and `drainAndApplyMarks` pulls the subject's phone-tapped
  outcomes back (idempotent). A new phone Home → Activity surface lists receipts with
  approved/modified/rejected taps. Best-effort + isolated — an audit failure never throws into
  the triggering tool. `mcp/receipts-sync.js`, `mcp/server.js`; locked by `mcp/test-receipts-sync.mjs` (new).

### Consult correctness + forward-compat

- **Conditional + revocable authority (§10.5, v0.1.26).** A standing authorization gains
  `expires_at` (RFC 3339, **ENFORCED** — fail-safe, authority-narrowing) and `agents`
  (**RESERVED**). `mcp/consult-policy.js`; locked by `mcp/test-consult-policy.mjs`.
- **Consult suppression of open conflicts (§4.7, v0.1.28).** A decision dimension under an
  `open` conflict is WITHHELD from the consult cue readers; a consult whose relevant dimensions
  are all contested returns `insufficient_signal` with a distinct *contested* rationale
  (escalate to the subject) rather than answering on an unsettled dimension. `mcp/consult-core.js`.
- **Reserve `agent_credential` (v0.1.37).** The §10.2 request + the four `agent_id`-accepting
  tools declare an optional `agent_credential` string — **reserved, ignored** by v0.1 resolvers,
  there so v0.3 authenticated per-agent identity lands as an ADDITION, not a wire break. Whitelisted
  out of the receipt store. `mcp/server.js`; locked by `mcp/test-smoke.mjs`.
- **Connectivity polish (v0.1.39).** Receipts-audit + `agent_credential` review cleanups; three
  new platform install targets.

## 0.1.1 (2026-06-10)

- **`PHAEDO_FINGERPRINT` now takes precedence over phone pairing.** Pointing the
  env var at a fingerprint file is an unambiguous "use THIS source" — it forces a
  local file even on a phone-paired machine. (Also makes the smoke suite hermetic
  on paired dev boxes.)
- Registry alignment: `mcpName` → `io.github.galavoxx/phaedo-mcp`, matching the
  public repo (github.com/galavoxx/phaedo-mcp).
- README: documents the npm install path (`npx phaedo-mcp` / global install).
- Ship this CHANGELOG.

## 0.1.0 (2026-06-10)

Initial publish. Reference Phaedo MCP server: session-start injection
(`phaedo_request_injection`, `/phaedo` prompt, resource), agent consultation
(`phaedo_consult`, spec §10) with deference policies (§10.5), deterministic
pre-flight (`phaedo_check_authorization`), encrypted consultation receipts
(§10.6) + agreement metric, phone pairing with encrypted at-rest cache and
revocation, one-click client installers. Apache-2.0.
