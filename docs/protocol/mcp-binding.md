# Anamnesis MCP Binding (draft)

Status: draft. Binds **Anamnesis** — formerly "Phaedo Protocol", see `v0.1.md`
§1.4 — Sections 9 and 10 to the Model Context Protocol (MCP).
Companion to: `v0.1.md` (core protocol), `../roadmap/mcp-server.md` (delivery plan).

## 1. Purpose

The Phaedo core protocol is transport-agnostic: Sections 9 and 10 of `v0.1.md`
define message shapes, not how messages travel. This document specifies how the
Injection API (core spec Section 9) and the Agent Consultation API (core spec
Section 10) are carried over MCP.

MCP is the de facto standard by which AI clients (the Claude desktop app, Claude
Code, Cursor, and others) and agent frameworks (OpenAI Agents SDK, Google ADK)
connect to external context and tool providers. Binding Phaedo to MCP makes the
fingerprint reachable from every MCP-capable client through one integration,
with no per-client code.

## 2. The Phaedo MCP server

A local process on the user's working device. It pairs with the vault device
for key material exactly as the reference Chrome extension does (core spec
Sections 7.4–7.5), decrypts within a session-scoped boundary, and exposes the
injection and consultation surface to the connected MCP client. It holds no
plaintext at rest — the same boundary every Phaedo consumer observes.

Transport: stdio for local clients (default); HTTP/SSE permitted for remote
configurations.

## 3. Surface mapping

| Core protocol | MCP primitive | Name |
|---|---|---|
| Injection (Section 9) | tool | `phaedo_request_injection` |
| Injection — default projection | resource | `phaedo://fingerprint/projection` |
| Injection — one-click | prompt | `phaedo` |
| Consultation (Section 10) | tool | `phaedo_consult` |
| Authorization check (Section 10.5) | tool | `phaedo_check_authorization` |
| Outcome record (Section 10.6) | tool | `phaedo_record_outcome` |
| Real-time escalation (roadmap) | tool | `phaedo_escalate` |
| Escalation status (roadmap) | tool | `phaedo_escalation_status` |

The **`phaedo` prompt** surfaces in clients as a user-invokable command (e.g. a `/phaedo` slash command) and inserts the projection as a conversation message — near-automatic injection without a tool call. (Reference clients also ship a Claude Code SessionStart hook for fully-automatic injection; both render via the same projection as the tool/resource. These are delivery conveniences, not separate protocol surfaces.)

### 3.1 Injection

`phaedo_request_injection` accepts the Section 9.2 Injection Request as its tool
arguments and returns the Section 9.3 Injection Response. The MCP client calls it
at session start and inserts the returned `projection` as context.

For clients that consume resources but not tools, the server also exposes
`phaedo://fingerprint/projection` — a producer-selected default projection (all
layers, standard mode). Parameterized injection (task hints, layer selection,
enhanced privacy mode) requires the tool.

### 3.2 Consultation

`phaedo_consult` accepts the Section 10.2 Consultation Request and returns the
Section 10.3 Consultation Response. One tool serves all four consultation types;
the type is the `consultation_type` argument. The consultation boundary of
Section 10.4 holds unchanged: the tool never returns full fingerprint or layer
content, only signals. Per §4.7 (v0.1.28), a decision dimension under an **open
conflict** (the subject is still reconciling a contradiction) is withheld from the
resolver's cue readers — the consult-side mirror of injection suppression — so a
consult whose relevant dimensions are all contested returns `insufficient_signal`
(escalate to the subject) rather than answering on an unsettled dimension.

`phaedo_check_authorization` is a **deterministic-only pre-flight** over the Section
10.5 standing authorizations (the force-effect policy rules). It takes an
`action_descriptor` (`domain`, `reversible`, `magnitude`, `amount`) and reports whether
a standing authorization already decides the action — **without** running inferred
evaluation or the optional model judge. It returns a small fixed shape
(`spec/schemas/authorization-check-response.schema.json`): `authorization_matched`, the
authorized `signal` (`escalate | decline | proceed`, or `null`), the `rule_id`, and a
`rationale_hint`. A match is the subject's deterministic pre-decision (confidence 1.0,
deference high, by definition); on no match the agent falls back to `phaedo_consult` or
its own default. The Section 10.4 boundary holds — only the rule's decision and
provenance cross, never layer content. This is a fast path for agents that want to
short-circuit on a hard guardrail before paying for a full consultation.

`phaedo_record_outcome` records what the **subject** decided about an action they
consulted on (`approved | rejected | modified | unknown`), setting `user_action` on the
§10.6 receipt. It is the **act-as-me** loop closer: a `rejected`/`modified` outcome — the
subject correcting an agent that acted on their behalf — is the source the reference
server derives `delegation`-origin signals from (which then outrank the subject's `self`
pattern in future consults, §4.2/§10). Honesty rail: it records what the SUBJECT chose,
never whether the agent proceeded — only an override teaches, so `approved` self-reported
by an obedient agent contributes nothing. Returns `{matched, receipt_id, user_action}`;
no layer content crosses (§10.4).

Beyond consult-time, the reference server also **promotes** an established override
pattern into a portable rule: after a consultation it best-effort deposits a delegation
SUGGESTION (never an authored rule) into the relay's `agent_to_ext` sync-mailbox lane
(Proposal 0008), encrypted under the shared `fp_sync_key`, for the extension to review and
the subject to endorse. This is a reference-implementation transport, not an MCP surface —
it carries no new tool or response shape, and the §10.4 boundary is unchanged (ciphertext
only; the relay never sees content).

### 3.3 Real-time escalation

The delegation channel above learns from *past* overrides; `phaedo_escalate` is the
*live* counterpart for an agent acting **autonomously** for the subject
(`../roadmap/escalation-and-push.md`). When such an agent hits a process-blocking decision
and no one is at its conversation, it routes the decision to the subject's device and waits
for a real-time **approve / deny / modify**.

`phaedo_escalate` takes a consultation request (same `action_descriptor` shape as
`phaedo_consult`) and is **self-gating**: it runs the consultation itself and only wakes the
subject when the signal is genuinely blocking. The two blocking signals are not equal:
**`escalate`** (hold for a live human go/no-go) always pushes; **`clarify`** (the agent's
default reflex when uncertain) pushes **only when the action is also consequential** —
`reversible === false` **OR** `magnitude === 'high'`. A low-stakes `clarify` returns
`escalated:false` / `reason:"clarify_below_threshold"` and is the agent's to resolve in its
own flow (it surfaces in the deferred review queue); a `proceed*`/`decline` signal returns
"act on it with your own judgment". This keeps the channel from crying wolf on routine
uncertainty. On a signal that does clear the bar it deposits an encrypted decision request to
the relay's escalation channel (waking the device via push), then returns **immediately** with
a `request_id`, `window_ms`, and `expires_at` (a multi-minute block would be hostile to MCP
clients). The agent then **holds** and polls.

The clarify gate is the **default**; the subject can override how `clarify` pushes — globally
and per-domain — via an **escalation push policy** that rides the vault
(`phaedo_fingerprint.escalation_policy`, portable/syncs) and/or a local file
(`PHAEDO_ESCALATION_POLICY`, which overrides the vault), the same dual home as consult
policies: `{ "clarify": { "default": "always" | "consequential" | "never", "by_domain": {
"<domain>": "<mode>" } } }`. `escalate` is not configurable (suppressing a "needs-a-human" wake
would strand a blocking decision).

`phaedo_escalation_status` polls a `request_id`. It returns `resolved` with the subject's
`decision` (`approve | deny | modify`) once they answer, `pending` while the agent should
keep holding, or `expired` once the window lapsed — at which point the agent applies the
**safe default: hold (do not proceed)**. A resolved decision is recorded **automatically**
as the §10.6 outcome (a real-time approve/deny is the strongest act-as-me signal), feeding
the same delegation-learning loop as `phaedo_record_outcome`.

The §10.4 boundary holds on the wire: only the agent's own action descriptor and the consult
`signal`/`rationale_hint` cross to the device — never layer content — and even that is sealed
under `fp_sync_key`, so the relay forwards ciphertext and wakes the device, nothing more. The
relay escalation channel, the push-to-wake (APNs) seam, and the response window/safe-default
are reference-implementation transport; the MCP surface is the two tools above. The real APNs
send and the phone approve/deny/modify UI are not yet implemented (they require Apple
infrastructure and a device build) — until then the channel runs foreground-only.

## 4. Errors

Section 9.5 error responses are returned as MCP tool errors with the
`error.code` value preserved. The six v0.1 error codes map one-to-one.

## 5. What MCP does not cover

MCP is an injection and consultation transport only. It does not hand the
conversation back to the server, so it provides **no capture signal** — neither
Path A delta capture nor Path B extraction. Capture on MCP-only clients remains
an open problem addressed by the desktop helper track
(`../roadmap/desktop-app-support.md`).

## 6. Conformance

An implementation of this binding is an MCP-transport realization of the core
spec's Injector and Agent Consultant profiles (core spec Section 11.1). It MUST
conform to those profiles' core requirements; this binding adds only the
transport mapping. Folding transport bindings formally into Section 11 is
tracked as core-spec open question 14.

## 7. Open items

- Resource vs tool default for clients that support both — currently tool-first.
- Pairing and unlock UX when the MCP client and the vault device differ.
- Whether enhanced privacy mode (Stained Glass) is offered over the resource
  surface or tool-only.
- Authentication model for a remote (HTTP/SSE) server.

---
*Draft — tracks core protocol v0.1.35 (adds, in v0.1.34–35, the real-time escalation surface:
`phaedo_escalate` + `phaedo_escalation_status` route a blocking decision to the subject's
device for a live approve/deny/modify, over a ciphertext-only relay escalation channel with a
bounded window + safe-default hold; v0.1.35 stakes-gates the `clarify` push. And, since
v0.1.30, the delegation-PROMOTION transport via the relay `agent_to_ext` mailbox lane,
Proposal 0008). Will be revised to normative alongside protocol v0.2.*
