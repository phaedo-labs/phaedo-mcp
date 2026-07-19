# Phaedo MCP server — Phase 1 (push injection)

A local [MCP](https://modelcontextprotocol.io) server that exposes your Phaedo
cognitive-fingerprint **projection** to any MCP client (Claude Desktop, Claude
Code, Cursor, agent frameworks) — so the assistant responds in your style
without the Chrome extension. One integration, every MCP client.

Implements `docs/protocol/mcp-binding.md` §3.1:

| Surface | Name | Returns |
|---|---|---|
| tool | `phaedo_request_injection` | §9.2 request → §9.3 Injection Response |
| resource | `phaedo://fingerprint/projection` | default projection (all layers, standard) |
| prompt | `phaedo` | one-click `/phaedo` — inserts the projection as a message |
| tool | `phaedo_consult` | §10.2 request → §10.3 Consultation **signal** (never layer content) |
| tool | `phaedo_check_authorization` | deterministic-only pre-flight: does a standing authorization (§10.5) already decide this action? (no inference) |
| tool | `phaedo_escalate` | run the consult and, on a blocking signal (`escalate`, or a consequential `clarify`), wake the subject's paired device for a live **approve / deny / modify**; returns a `request_id` (non-blocking). Safe default on no answer: **hold**. |
| tool | `phaedo_escalation_status` | poll an escalation by `request_id`; on resolution records the subject's live decision as the §10.6 outcome automatically (a real-time approve/deny is the strongest act-as-me signal). |
| tool | `phaedo_record_outcome` | §10.6 — record what the SUBJECT decided about a consulted action (`approved`/`rejected`/`modified`/`unknown`). A `rejected`/`modified` outcome teaches the **act-as-me** channel (how the user wants delegated work handled). |

The projection is rendered by the **same** `context-block.js` the extension
injects, so MCP injection is byte-identical to web injection.

## Status

- **Phase 1a (this cut):** reads the fingerprint from a local JSON file (see
  *Fingerprint source*). Lets injection work in a real client today, no crypto.
- **Phase 1b-i (done):** the spec-faithful key boundary — authorize → pull
  `/v1/profile` → unwrap the §7.2 envelope from the paired phone, reusing the
  repo crypto modules (`protocol/envelope/kdf/identity.js`) in node. The
  decrypted fingerprint stays in memory (never written to disk). Auto-selected
  when a pairing record is configured (see *Fingerprint source*). Plan +
  decisions: `../docs/roadmap/mcp-1b-plan.md`.
- **Phase 1b-iii (done):** **encrypted at-rest cache** — a successful phone pull
  caches the fingerprint as ciphertext under a server-held key; when the phone is
  unreachable the server serves that cache, so it works **phone-absent**
  (frictionless default; mirrors the extension's Option C — defense-in-depth, NOT
  phone-gated). State dir defaults to `~/.phaedo-mcp/` (override `PHAEDO_MCP_STATE_DIR`);
  holds a `0600` key file + ciphertext-only cache. **Revocation is honored:** if
  the phone *rejects* this client (revoked / invalid credentials → 4xx), the cache
  is purged and the pull fails — a revoked agent can't keep serving a cached copy.
  The cache only covers the phone being genuinely *unreachable* (network/timeout).
  v1 caveat: the raw key is on disk (weaker than the extension's non-extractable
  key) — OS-keychain is a hardening follow-up.
- **Per-agent revocable pairing (built, device-verify pending):** the server
  pairs **itself** with the phone as its own SAS-approved, **revocable** client —
  `npm run pair` (LAN auto-discovery or relay typed-code, mirroring the
  extension). Needs the phone's multi-client support (spec §8.4 **v0.1.6**) + the
  phone **Agents/revoke** screen. Obviates hand-copying the pairing record. Plan:
  `../docs/roadmap/mcp-revocable-approval-plan.md`. Phone-gated unlock stays a
  deferred enterprise mode behind a config flag.

**Injection-only.** MCP never returns the conversation, so there is **no
capture** here (binding §5) — your fingerprint does not learn from MCP sessions.
Local **stdio** only; **standard** mode only (enhanced-privacy/Stained-Glass and
remote HTTP/SSE are out of this cut).

## Install & test

**From npm (published).** The server is on the registry as
[`phaedo-mcp`](https://www.npmjs.com/package/phaedo-mcp) — run it without cloning:

```bash
npx phaedo-mcp              # run the server directly over stdio
# or install the `phaedo-mcp` command globally:
npm install -g phaedo-mcp
```

Most users never start the server by hand — point your MCP client at it with the
**one-click install** below, which wires `phaedo-mcp` into Claude Desktop / Cursor /
Claude Code for you. The `cd mcp` / `npm run …` commands in the rest of this README
are for working from a **clone of this repo** (development & the smoke suite):

```bash
cd mcp
npm install
npm test             # full suite (smoke + phone + cache + pairing + consult + …)
npm run smoke        # 1a: unit + live stdio integration (23 checks)
npm run smoke:phone  # 1b-i: mock-phone authorize→pull→decrypt→project (12 checks)
npm run smoke:cache  # 1b-iii: encrypted at-rest cache + phone-absent fallback (11 checks)
npm run smoke:pair   # P3: self-pairing crypto vs a mock phone (pair_key + SAS match)
```

## Pair with the phone

```bash
cd mcp
npm run pair
```
The server generates its own long-term identity (`identity.json`, `0600`,
gitignored) and pairs with the phone vault as a distinct client named **"Phaedo
MCP Server"**:
- **Same Wi-Fi:** it finds the phone automatically — approve "Phaedo MCP Server"
  on the phone and confirm the SAS matches what the terminal prints.
- **Off-network:** it prints an `XXXX-XXXX` code; on the phone tap **Pair with
  code**, type it, then confirm the SAS.

On success it writes `pairing.json` and pulls your fingerprint autonomously
thereafter. Revoke anytime from the phone's **Agents** screen.

## Fingerprint source

`loadFingerprint()` auto-selects, so `server.js`/`projection.js` never change:

**Phase 1b — phone (preferred).** If a pairing record is configured, the server
pulls the live fingerprint from the paired phone over the encrypted boundary.
A record is found via `PHAEDO_PAIRING` (path) or `mcp/pairing.json`. Run
**`npm run pair`** (see *Pair with the phone*) to create it — the server pairs
itself with the phone as its own revocable client. `pairing.json` holds
`pair_key` (a long-term secret) and is **gitignored**. The phone app must be
foregrounded/reachable at the configured `endpoint`. *(You can still hand-copy
`pairing.sample.json` → `pairing.json` from the extension's `phaedo_local_pairing`
if you prefer.)*

**Phase 1a — local JSON (fallback / demo).** With no pairing record, reads a
**vault payload** from `PHAEDO_FINGERPRINT`, then `mcp/fingerprint.json`, then
the shipped `mcp/sample-fingerprint.json` (so it runs out of the box):
```json
{
  "phaedo_fingerprint": { "layers": { ... }, "fingerprint_id": "...", "persona_strength": 0.6 },
  "phaedo_behavioral_signals": { ... },
  "phaedo_linguistic_profile": { "messageCount": 64, ... },
  "phaedo_session_metrics": { "sessionCount": 6, ... }
}
```

## One-click install (recommended)

The installer finds the MCP clients you already have (Claude Desktop, Cursor,
Claude Code), adds Phaedo to each — preserving your other servers, backing the
file up first — and then runs the one-time phone pairing.

- **macOS:** double-click **`installers/macos/Install Phaedo MCP.command`**.
- **Windows:** double-click **`installers/windows/Install Phaedo MCP.bat`**.
- **Linux:** `bash installers/linux/install-phaedo-mcp.sh`.

(The launcher installs dependencies the first time, then runs the installer.)

Prefer the terminal? From this folder:
```bash
npm install
npm run setup        # configure detected clients
npm run setup:pair   # configure, then pair with the phone
npm run unsetup      # remove Phaedo from every client
node install.mjs --dry-run   # preview, write nothing
```

Each client entry runs the server with the **absolute path to your node binary**
(not bare `node`) — a GUI-launched app like Claude Desktop often has no `node` on
its PATH. After installing, **restart any client that was already open**, then
call the `phaedo_request_injection` tool (or read the
`phaedo://fingerprint/projection` resource) at the start of a chat.

> One remaining prerequisite: Node.js (from [nodejs.org](https://nodejs.org)). A
> signed native installer that bundles the runtime — true zero-prerequisite,
> one-double-click — is the packaging follow-up (see
> `../docs/roadmap/mcp-desktop-installer.md`).

## Inject at session start (manual → automatic)

MCP is pull-based — a server can't push a system prompt into every new session the
way the browser extension owns the input box. So injection ranges from one-click to
fully automatic depending on the client:

- **Any client — `/phaedo` (one click).** The server exposes a **prompt** named
  `phaedo`. Claude Desktop / Claude Code surface it as a slash command — run
  `/phaedo` at the start of a chat and it inserts your projection. One keystroke,
  no typing.
- **Claude Code — automatic (a hook).** Run `npm run setup:code-hook` (or
  `node install.mjs --code-hook`). It adds a **SessionStart hook** to
  `~/.claude/settings.json` that runs `hooks/session-start.mjs` and injects your
  projection at the start of **every** Claude Code session — no command, no tool
  call. Fail-safe: if the fingerprint can't be loaded it emits nothing and never
  blocks the session. Remove it with `npm run unsetup`.
- **Claude Desktop — near-automatic (a Project instruction).** Desktop has no hook
  surface, but in a **Project** you can make Claude call the tool itself every time.
  Paste into the Project's custom instructions:
  > At the start of every conversation, call the `phaedo_request_injection` tool and
  > treat the returned `projection` as authoritative on how I think and want
  > responses formatted. Don't announce that you did it.

  Every chat in that project then injects automatically.

## Consult at decision points (`phaedo_consult`, §10)

Beyond injecting style, an agent can **ask the fingerprint how the user's pattern
bears on a decision** — without ingesting the fingerprint. `phaedo_consult` takes a
§10.2 request and returns a §10.3 **signal**, never layer content (§10.4 boundary):

```jsonc
// request (tool arguments)
{ "consultation_type": "action_approval",
  "action_descriptor": { "domain": "financial", "reversible": false, "magnitude": "high",
                         "summary": "Approve $12k vendor payment outside terms." },
  "context": { "evidence_provided": ["invoice", "po_match"] } }

// response
{ "signal": "escalate", "confidence": 0.81,
  "rationale_hint": "On irreversible, high-magnitude actions in the financial domain, the subject favors caution and human review.",
  "deference_level": "high" }
```

- `consultation_type`: `action_approval` · `domain_risk_check` · `escalation_default` · `voice_draft`.
- `signal`: `proceed` · `proceed_with_note` · `clarify` · `escalate` · `decline` · `insufficient_signal` (abstain — either the fingerprint has no coverage for this action, or the relevant decision dimension is under an open §4.7 conflict the subject is still reconciling and is withheld; fall back to your own default or escalate to the subject).
- `deference_level` (`high`/`medium`/`low`) = how strongly to weight it; sparse data → `low`.

### Fast pre-flight (`phaedo_check_authorization`, §10.5)

Before paying for a full consult, an agent can ask whether one of your **standing
authorizations** already decides the action — a **deterministic-only** check (no
inference, no model):

```jsonc
// request:  { "action_descriptor": { "domain": "financial", "reversible": false, "amount": 12000 } }
// matched:  { "authorization_matched": true, "signal": "escalate", "rule_id": "irreversible-spend-over-5k-escalate",
//            "rationale_hint": "Per your standing rule: Any irreversible spend over $5,000 goes to me…" }
// no match: { "authorization_matched": false, "signal": null, "rule_id": null,
//            "rationale_hint": "No standing authorization matches this action; run phaedo_consult…" }
```

A match is your pre-decision (confidence 1.0, deference high). On no match, fall back to
`phaedo_consult` or your own default. Same §10.4 boundary — only the rule's decision crosses.

### Receipts (§10.6) — your on-device audit trail

Every resolved consultation (abstains included, plus matched pre-flights) writes one
**encrypted, append-only receipt** to `~/.phaedo-mcp/receipts.enc` — which agent asked
what, and what your oracle answered. Receipts **never leave the device**; the store is
ciphertext under its own derived key (`phaedo:receipts:enc:v0.1`), capped (default
5,000, oldest evicted; `PHAEDO_RECEIPTS_CAP` to change). Only one field is ever mutable
after write: `user_action` (what you actually did — feeds future agreement tracking).
Quick readout on your own machine:

```bash
cd mcp && npm run receipts                          # decrypts locally, lists the last 50 (with a short id per line)
node receipts.js mark <id|prefix|latest> approved   # record what YOU did → approved | rejected | modified | unknown
npm run agreement                                   # per-domain agreement rate (oracle vs your actual decisions)
```

`user_action` is **subject-authored**: set it from what *you* decided, not from whether an
agent proceeded. Until receipts carry one, `npm run agreement` shows `—`
(no data ≠ 0%); each one you mark makes the rate live. Metric definition:
`../docs/architecture/agreement-metric.md`.

**Two resolvers, both local.** The default is a **deterministic rule engine** —
resilient cue extraction (reads §4.2 signals, then keyword-scans the relevant
layers' interview text), relevance-scoped per consultation type, with
confidence/deference grounded in real cue coverage. Nothing leaves the device;
always available.

**Model judge (richest context — ON by default, local).** The judge reasons over
the *full projection* via a **local** Ollama / OpenAI-compatible endpoint and
returns a §10.3 signal. Any failure/timeout/parse error **falls back to the rule
engine**, so the model can only improve on, never break, the floor (and a missing
model never breaks consultation). The §10.4 boundary is enforced on parse.

The **installer turns this on automatically**: it probes local Ollama and writes
`PHAEDO_CONSULT_MODEL` into each client's server entry (picking an installed general
model, else defaulting to `llama3.1:8b`). Toggle it at install time:

```bash
npm run setup                              # model judge ON (auto-detect Ollama)
node install.mjs --consult-model qwen2.5:7b   # pin a specific model
node install.mjs --consult-url http://localhost:11434   # custom endpoint
node install.mjs --no-model-judge          # rule engine only
```

Use a **general** chat model (NOT the extraction fine-tune). To run it: `ollama
pull llama3.1:8b`. Raw env (if configuring a client by hand):
`PHAEDO_CONSULT_MODEL`, `PHAEDO_CONSULT_MODEL_URL`, `PHAEDO_CONSULT_API_KEY`
(OpenAI-compatible endpoints only).

`voice_draft` always redirects to the injection projection (generation is out of
scope). A retrieval/scoping reranker is the next upgrade (`../docs/roadmap/mcp-server.md`).

### Deference policies (guardrails that make delegation safe)

The user can author **standing rules** that *override* the inferred signal —
per-domain / magnitude / reversibility (spec §10.5). e.g. "always escalate
irreversible spend/legal", "auto-proceed low-stakes reversible writing".

**Author them in the browser:** open **`policy-editor.html`** (double-click — it's
self-contained), build rules with the form, and **Download / Copy** the result to
**`mcp/consult-policies.json`**. The server **auto-reads that file** — no env, just
restart the client. (Override the path with `PHAEDO_CONSULT_POLICIES`; see
`consult-policies.sample.json`.) Portable alternative: put the rules in the vault
under `phaedo_consult_policies` so they travel with you (in-app authoring is a
follow-up).

`effect`: `escalate`/`require_human` · `decline` · `autoproceed` (all at `deference:
high`) · `bias_cautious`/`bias_bold` (nudge one step). The matched rule's `note`
becomes the `rationale_hint` ("Per your standing rule: …"), so the agent sees why.
Policies never apply to `voice_draft` and never widen the §10.4 boundary.

## Connect a client manually (advanced)

The installer writes exactly this. The minimal **paired** entry needs no `env` —
`pairing.json` next to `server.js` drives the source automatically.

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "phaedo": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/galavoxx/phaedo/mcp/server.js"]
    }
  }
}
```
For the Phase-1a demo (no phone), add
`"env": { "PHAEDO_FINGERPRINT": "/absolute/path/to/your/fingerprint.json" }`.
Restart Claude Desktop, then call `phaedo_request_injection` at the start of a
chat and prepend the returned `projection`.

**Claude Code** — `.mcp.json` in a project, or:
```bash
claude mcp add phaedo -- /absolute/path/to/node /Users/galavoxx/phaedo/mcp/server.js
```
