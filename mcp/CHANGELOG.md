# Changelog — phaedo-mcp

## 0.3.14 — unreleased

### Your "no" counts too

Phaedo learned from a yes on a confirmation prompt but almost never saw a no: Claude Code fires
no hook when you decline, so a rejection reached the record only if the agent remembered to
write it (13 yes / 0 no on merges). The ship hook now also runs on `UserPromptSubmit` and
`Stop`, and for this session's still-open consults reads the end of the transcript (4 MB at
most), where Claude Code marks a person's denial `toolDenialKind: "user-rejected"`.

- Records `rejected`, or `modified` when you said what to do instead ("…the user said:").
- Only a person's no: auto mode's classifier, permission rules, and quitting the app mid-prompt
  record nothing. An outcome already on the receipt (the agent's, or a yes) is kept.
- Cheap on every prompt: a state-file read, and the transcript only when a consult is open.
  Nothing is printed on a prompt or a stop. Pending calls now carry their session id.
- Claude Code only (other agents' transcripts don't mark denials); not in the directory
  edition, which never reads chat history. Re-run `npm run setup:code-hook` to wire it.
- The learned list no longer shows "assume state proceed": the phrasebook maps that value of
  `ambiguity_posture` to "be decisive" (shared with the phone).
- Tests: ship hook 233 (+the transcript cases), install 112, plugin 95.

## 0.3.13 — unreleased

### Learn from your ChatGPT or Claude history

`npm run import -- <export.zip | conversations.json>` (plugin: `/phaedo:import`) reads the data
export ChatGPT or Claude emails you. Format by shape; ChatGPT's branch tree followed along
`current_node` (abandoned regenerations and tool/code turns skipped); Claude's content parts.

- The last 365 days by default (`--all`, `--days N`, `--dry-run`): old habits shouldn't outweigh
  current ones.
- Each conversation goes through the shared capture spine (`turnsToBatch` → `foldBatchToSignals`,
  regex detectors only) as its own session, keyed `chatgpt-import:<id>` / `claude-import:<id>` —
  a re-import replaces, never doubles. One deposit at the end when paired (the phone keeps one
  snapshot per source, so no phone change); unpaired, it becomes the starter profile.
- Discard-raw: text in memory only; nothing but signal names and integers on disk (tested).
- Zip via the system `unzip`, else `tar`. Not in the directory edition. Tests: history import 34.

## 0.3.12 — unreleased

### Here's what I learned — keep it or remove it

`npm run learned` (plugin: `/phaedo:learned`) lists every trait Phaedo inferred from how the
subject works (`evidence_basis: observed` — never interview answers or rules) as one sentence
from the shared phrasebook (`trait-phrases.js`), numbered, most-seen first.

- **Merged and checked:** values that are the same choice are one item (0.8 and 0.85 "favor
  quality"); items for the same field that are different choices are flagged "disagrees with
  #n; keep the one that's right" (never for list traits: bullets and headings can both hold).
- **Remove** stops an item shaping answers, consults and the rules files on this computer: the
  forget list is applied on every profile read (`loadFingerprint`, `loadFingerprintPreferCache`),
  so a pattern the sessions keep showing stays removed. Never touches self-reported signals.
  `--keep`, `--forgotten`, `--restore`. Removing from the phone's profile stays the app's job.
- **On disk:** `learned.json` in the state dir — field names and value digests only.
- `/phaedo:status` (`pull.js`) adds a line when there are unreviewed items. Tests: learned 37.

## 0.3.11 — unreleased

### The merge check in Cursor, Copilot CLI, Codex and Gemini CLI

`npm run setup:agent-hooks` wires `hooks/agent-hook.mjs` into each agent found: Cursor
(`beforeShellExecution` + `beforeMCPExecution`), Copilot CLI (`preToolUse`, its own
`~/.copilot/hooks/phaedo.json`), Codex (`PreToolUse` in `~/.codex/hooks.json`) and Gemini CLI
(`BeforeTool` in `~/.gemini/settings.json`). Each agent's input is turned into the Claude Code
shape and runs the same classification, consult and receipt path as the ship hook; receipts name
the agent (`cursor/ship-hook`, …).

- **Never allow.** Cursor and Copilot get a real `ask` with Phaedo's reason. Codex and Gemini
  can't prompt from a hook (Codex marks `ask` unsupported; Gemini has allow/deny only), so the
  action is paused once with the reason; the identical call within 15 minutes passes without a
  second consult — a pause, never a wall or a loop.
- **Fail-safe** everywhere — and on Copilot a crashing hook denies, so every path exits 0.
- Entries merge beside the user's own hooks, with a backup; unparseable files are refused;
  uninstall removes them (Copilot's own file is deleted). Codex needs `/hooks` trust once.
- Antigravity documents no hooks: profile only (`npm run rules`). Outcomes are not yet recorded
  in these agents. `pre-ship.mjs` `realDeps` now takes the agent id. Tests: agent hooks 77.

## 0.3.10 — unreleased

### Share what Phaedo learned with your other agents

Codex, Copilot CLI, Gemini CLI and Antigravity have no session-start hook, but each reads a
user-level instructions file every session. `npm run rules` (plugin: `/phaedo:rules`) writes a
short version of the profile there — operating rules, how to respond, how this user thinks
(≈3.5 KB; capped at 6,000 characters, under Antigravity's ~12k and Codex's 32 KiB combined).

- **Where:** `~/.codex/AGENTS.md` (honours `CODEX_HOME`), `~/.copilot/copilot-instructions.md`,
  `~/.gemini/GEMINI.md` (Gemini CLI and Antigravity share it) — each one whose folder exists, or
  `--for codex,copilot,gemini,claude`. Cursor has no user-level rules file, so `--project <dir>`
  writes `.cursor/rules/phaedo.mdc` (`alwaysApply: true`) and lists it in that repo's
  `.git/info/exclude` — never a committed file. Never a repository's own AGENTS.md: it would be
  committed and shared.
- **A marked block,** replaced in place; the rest of the file is untouched. Damaged markers are
  refused, not guessed at. `--remove` takes it out; `--dry-run` shows the text first.
- **Kept current, opt-in only:** the SessionStart hook refreshes files that already carry the block
  and never adds one anywhere new (`refreshExisting`). Uninstall takes the blocks out.
- Not in the directory edition (it changes other agents' behaviour with the profile).
- Disclosed: plugin README, mcp README, privacy policy, data inventory — the text is plain and
  those agents send it to their providers. Tests: rules-files 52, install 110, plugin.

## 0.3.9 — unreleased

### Your personal reviewer inside Claude Code's auto mode

Auto mode's reviewer judges actions by type. Phaedo now asks whether *this* person would want to
see an action, and forces a prompt (a hook `ask` prompts even in auto mode) when they would.

- **More of what people disagree about** (`ship-actions.js`): force-push any branch, delete a
  remote branch, open a PR, comment on or review a PR or issue, publish a package (never a
  `--dry-run`), create a release, and deploys beyond Fly (`vercel --prod`, `netlify deploy --prod`,
  `firebase deploy`, `terraform apply|destroy`, `kubectl apply|delete`).
- **Connected apps, not just the shell:** MCP tool calls whose name says send/post/reply/forward/
  comment/share/invite, pay/purchase/transfer/checkout, delete/purge/destroy/trash, or merge —
  except Phaedo's own tools (`classifyMcpCall`, matcher `SHIP_HOOK_MATCHER` in the installer and
  both plugin editions). The receipt binds the tool call and previews only its target
  (recipient, channel, subject, amount), never a message body; an amount counts only on a payment.
- **A personal reason on the prompt** (`personalWhy`): your matching rule when one decided it,
  else what's at stake ("it can't be undone", "it spends $250").
- **Auto mode outcomes:** a yes on the prompt Phaedo forced in auto mode is now recorded as
  `approved` (it was ignored, on the assumption no person answers in auto mode); a prompt Phaedo
  didn't force is still the classifier's and records nothing.
- `ship-readout` names the new kinds. Tests: ship-actions 96, ship-hook 206, install, plugin 81.
- Disclosures updated (plugin READMEs, privacy policy, data inventory): decision records can name
  a connected-app action's target, never the message.

## 0.3.8 — 2026-10-27

### The reason matches the answer; Phaedo shows what it did for you

- **A consult's reason now agrees with its answer.** A cautious person's low-stakes, reversible
  action came back "proceed_with_note" with the reason "the subject favors caution and human
  review" — an answer and a reason pointing opposite ways. The reason now says how the person
  leans *and* what that means for this action ("…favors caution and human review, but this one is
  reversible and low-stakes, so go ahead and tell them what you did"). `actionApprovalHint`, pinned
  over all 96 answer × lean × situation combinations in `test-consult.mjs`.
- **The server overview fits Codex.** Codex keeps the first 512 characters of a server's
  instructions; the three rules (load, consult, record) now come first and fit inside them, in both
  editions. Pinned by `test-smoke.mjs`.
- **"This week Phaedo handled N decisions without interrupting you."** `weekly.js` counts the last
  7 days of decision records: went ahead, stopped, brought to you, too unclear to call. Shown by
  `/phaedo:status` (via `pull.js`), by `npm run week`, and on the phone's Activity screen (it rides
  the receipts digest as `week`). `test-weekly.mjs`.
- **"Why you're seeing this" on every phone approval.** The approval payload carries `why_asked`,
  one plain line for the person built from the rule that matched or the stakes ("Phaedo asked
  because it can't be undone and it spends $1,250, and you usually want to see those yourself").
  The phone shows it under a label; older MCPs fall back to the agent-facing rationale.

## 0.3.7 — 2026-10-27

### A directory edition of the Claude plugin

- **`plugin-directory/`** in the public repo, the folder submitted to Claude's plugin directory.
  Anthropic's directory policy says listed software must not read Claude's chat history or "use
  conversation content to build user profiles", nor change Claude's behavior across sessions. This
  edition therefore ships without the session hooks (profile at session start, session capture)
  and without the capture and learning modules; it keeps the server and the merge check.
- Its `install-layout.json` says `"edition": "directory"`, and the server then never builds the
  starter profile from local capture counts, tells Claude to load the profile only when the user
  asks (server instructions and the injection tool's description), and says "pair the phone app"
  when there is no profile (`lib/config-dir.js isDirectoryEdition`).
- The full plugin (`plugin/`, the `phaedo` marketplace) is unchanged.
- `test-plugin.mjs` 57 → 77: the directory edition's files, hooks and manifest, and its server with
  captured sessions present (still no profile, only-when-asked instructions).

## 0.3.6 — 2026-10-27

- The plugin and the Claude Desktop bundle link Phaedo's privacy policy and terms of service
  (`https://phaedo.so/privacy`, `https://phaedo.so/terms`, published 2026-10-27 as drafts ahead of
  counsel review). The Claude plugin directory listing reads them from `plugin.json`.

## 0.3.5 — 2026-10-27

### Install in one step: a Claude Code plugin and a Claude Desktop bundle

- **Claude Code plugin** (`plugin/` in the public repo, listed by its root
  `.claude-plugin/marketplace.json`): `claude plugin marketplace add phaedo-labs/phaedo-mcp`, then
  `claude plugin install phaedo@phaedo`. It brings the MCP server and every Claude Code hook
  (session-start profile, the merge/deploy check, session capture) with no installer, no JSON
  editing and no settings changes; Claude Code installs the server's two dependencies from the
  lockfile. Two skills: `/phaedo:status` and `/phaedo:pair`. The folder is the one to submit to
  Claude's plugin directory.
- **Claude Desktop bundle** (`desktop/phaedo.mcpb`, 0.6 MB): double-click to install. The npm
  dependencies are bundled into one file, so there is no install step, and Desktop brings Node.
- **Pairing survives updates.** Both packaged installs carry `install-layout.json` and keep the
  pairing, identity and policy files in `~/.phaedo-mcp` (`lib/config-dir.js`) instead of beside
  `server.js`, which an update replaces. The same folder for both, so one pairing covers Claude
  Code and Desktop. A clone and the npm package are unchanged; `PHAEDO_CONFIG_DIR` overrides.
- Inside the plugin, "no profile" says a starter profile builds from your sessions and how to
  pair, instead of telling you to install a hook the plugin already is.
- Built by `build-plugin.mjs` from `npm pack`, so all three ship the same files. Tested by
  `test-plugin.mjs` (55): the directory's file limits, manifest, hooks, lockfile, and the built
  plugin's server and SessionStart hook run with `CLAUDE_PLUGIN_ROOT` set.

## 0.3.4 — 2026-10-22

### The starter profile says how far along it is

- **The startup line now reports progress** — how many things it has learned, across how many
  areas, from how many sessions, and what that means:
  "…9 things learned across 4 areas from 23 sessions — a solid start. The Phaedo phone app adds
  what sessions can't show." It is "just getting started" below 3 traits, "taking shape" from 3,
  and "a solid start" from 8; only that last one points to the phone app. Traits count once
  however often they were seen.
- `npm run pull` prints the same summary for a starter profile.
- Tests: `test-no-profile.mjs` 24 → 33 (the readout, each stage, de-duplication, session count).

## 0.3.3 — 2026-10-20

### A starter profile without the phone

- **No phone, no profile file, but Claude Code capture on → a starter profile.** The server
  folds what the capture hook recorded on this computer onto an *empty* fingerprint and
  serves that: only the user's own signals (for example "short answers, no headers"), labelled
  preliminary by the projection's confidence section. It is served only when something was
  learned; with nothing captured it is still "no profile". Id `starter-local`. A profile file
  or a paired phone still wins, and pairing later carries the counts to the phone.
- **One line in the server log about where the profile comes from**, after the handshake:
  "no profile is set up on this computer…", "no phone paired; using a starter profile…", or
  "using the made-up example profile". Silent when paired or a file is configured, and it never
  contacts the phone at startup. Claude Desktop shows it in its MCP log.
- The "no profile" message now names the Claude Code route; `npm run pull` says "starter
  profile", not "from the phone", when that is what it read.
- README: "Start a profile from your Claude Code sessions (no phone needed)".
- Tests: `test-no-profile.mjs` (24) covers all four cases and the log line; the packed-tarball
  test builds a starter profile in the published layout and reads the server's log.

## 0.3.2 — 2026-10-20

### Described as what it is now

- **The server now tells AI apps how to use it** (MCP server `instructions`): load the profile
  at the start of a session, consult before a consequential action, escalate when acting alone,
  record what the user chose, and say plainly once when there is no profile. Until now an app
  saw eight tool descriptions and nothing about their order.
- **npm and MCP registry descriptions in plain words**, covering every surface: matching your
  style, checking before acting, phone approvals, and Face ID-signed purchase approvals. The npm
  text says the phone app is needed and how to try the example. npm keywords now include
  `claude`, `claude-code`, `cursor`, `human-in-the-loop`, `approval`, `guardrails`, `ap2`.
- Tool descriptions say "the user" throughout (the signing tools said "the subject"), and
  `phaedo_check_authorization` no longer cites a spec section number.
- README: "No conversation capture" contradicted the opt-in capture hooks documented further
  down; it now says what is captured, when, and only if you turn it on.

## 0.3.1 — 2026-10-20

### A fresh install says it has no profile — it no longer borrows a made-up one

- **No pairing and no profile file now means no profile.** Through 0.3.0 the server fell back,
  silently, to the shipped `sample-fingerprint.json` — so anyone who ran `npx phaedo-mcp`
  without the phone app had a made-up person's style injected into their assistant, and
  nothing said so. Every tool now returns a plain-language `decryption_failed` error instead:
  there is no profile, nothing about the assistant changed, and how to get one.
- **The example profile is opt-in by name:** `PHAEDO_FINGERPRINT=sample`. It resolves next to
  the server, so it works from `npx` as well as from a clone.
- **A `PHAEDO_FINGERPRINT` path that doesn't read is an error naming that path.** It used to
  serve the sample, which looked exactly like success.
- `test-no-profile.mjs`, and the packed-tarball test now boots the server unconfigured and
  checks it refuses to serve the sample.
- README: a newcomer's opening (what you need, try the example, use your own profile);
  the developer reference follows it.

### Capture

- **Open sessions (2026-10-20):** a throttled `Stop` hook (`hooks/stop-capture.mjs`) captures
  Claude Code sessions that stay open for days (the desktop app's), at most once per session
  per 15 minutes, in a detached process so no turn waits. `--code-hook` wires it.

## 0.3.0 — 2026-09-20 (protocol v0.1.39 → v0.1.69)

> ### ⚠️ 0.2.0, 0.2.1 and 0.2.2 never started. Upgrade; do not diff against them.
>
> All three published builds are **dead on arrival**. `server.js` imports
> `./delegation-sync.js`, `./receipts-sync.js` and `./escalation.js`; none of the three
> were in `package.json`'s hand-maintained `files` allowlist, so npm shipped a tarball
> without them and `npx phaedo-mcp` threw `ERR_MODULE_NOT_FOUND` before the stdio
> transport opened. **The last version that runs is 0.1.1 (2026-06-10).** Anyone who
> installed `latest` between 2026-07-18 and this release got a crash, not a server —
> which is also why the "0.2.x in the wild" figures mean nothing.
>
> Nothing caught it for two months because nothing tested the published artifact:
> `npm pack --dry-run` proves the tarball *builds*, `test-vendored-capture.mjs` copies
> the whole of `mcp/` (so it supplies every file the allowlist forgot), and every other
> suite imports from the working tree, where all 38 modules exist.
>
> **Fixed here, in both directions.** The allowlist gains the 14 runtime modules it was
> missing, and `mcp/test-package-closure.mjs` (in `npm test`, so CI runs it) now (a)
> walks the import graph from the real entry points and fails naming any module outside
> `files`, and (b) packs the tarball, extracts it into a directory with no repo above
> it, and drives *that* server over stdio through `initialize`, `tools/list` and a real
> `phaedo_request_injection` call. A package that does not boot can no longer be
> published.

Everything since the 0.2.2 tag (`e2a9c63`, 2026-07-18) — two months, ~3,300 lines
across 33 modules, spec v0.1.39 → **v0.1.69**. Additive on the wire:
`phaedo_protocol_version` stays `0.1`, so a 0.1.1 client keeps working. Minor rather
than patch because the public tool surface grows from six tools to **eight**.

### §8.3 signing ceremony — TWO NEW TOOLS

- **`phaedo_sign_mandate` + `phaedo_sign_status` (#234).** Invoke the on-device
  signing ceremony: the agent deposits a sign request, the subject's paired phone
  signs it in the Secure Enclave behind Face ID (ES256, device-bound key), and the
  agent polls for the credential. Non-blocking, same shape as the escalation pair.
  Built on the signing core (#227, canonical §6 RFC 8785 input + ES256 verification),
  key publication over the trusted pairing (#230) and the deposit/poll/verify
  transport (#231).
- **A signing audit, deliberately NOT a §10.6 receipt (#235, v0.1.59).** A minted
  credential is recorded in its own encrypted, domain-separated append-only log —
  a digest of the signed bytes plus coarse metadata, never the mandate content or the
  signature. A signature carries no `signal`, so it must not feed the act-as-me
  learning loop or the agreement metric.
- **What still does NOT change:** `optional_features.asymmetric_signatures` stays
  `false`. The reference producer does not emit the fingerprint `signatures` field
  (`maxItems: 0`). The ceremony ships; emitting signatures does not.
- Three hardware-found fixes are in this release, not a later one: publish the signing
  key on every path with a live-pull fallback (#242), retry verification once against a
  freshly pulled key so a rotation is not a failure (#243), and fetch the key *before*
  presenting the sheet rather than mid-ceremony, which crashed the iOS modal (#244).

### Authority rules — seven fixes, every one of them NARROWING

An agent asks these two tools whether it may act. Each fix below closes a path that
answered "yes" when the subject's rules did not say yes. **A tester running 0.1.1 is
running all seven of the old answers.**

- **An unstated `magnitude` no longer satisfies a magnitude bound on a relaxing rule
  (#317, v0.1.68).** The resolver defaulted an absent `magnitude` to `medium`, both on
  the wire and in the matcher — so a grant the subject capped at `magnitude_max: medium`
  fired for an action whose stakes **the agent never stated**. The party being gated
  was authoring the field that gates it (the fifth instance of that same bug class).
  Restrictive rules are unchanged and still read an absent magnitude as `medium`: a
  prohibition must not stop biting because a field was omitted. Found by the
  2026-09-13 audit's randomized probe over 2,400 rule sets; owner-approved, since it
  changes a documented default.
- **A tie between two restrictive rules goes to the STRICTER one (#319, v0.1.69).**
  Two equally specific rules, one `escalate` and one `decline`, were separated by array
  position — and array position is not stable across devices, because the sync merge
  reorders authored rules. The same request could resolve `decline` on one surface and
  `escalate` on the other. Now `decline` > `escalate`/`require_human` > `autoproceed`,
  and only a full tie keeps author order.
- **Precedence became specificity-based, and `amount_lte` was added (v0.1.66).** A
  blanket `autoproceed` authored in January beat an `escalate above $1,000` authored in
  June, purely by position — the only §10.5 ordering that ever resolved toward *more*
  authority. The more specific rule now governs. Separately, §10.7 was staging ceilings
  as `amount_lt`, so a subject who approved six $20 purchases minted a rule matching
  `amount < 20` — one that excludes every purchase that earned it, unfireable by
  construction and silently so.
- **A stale profile could authorize a payment the subject had revoked (#252).** The
  stale-authority guard applied to `phaedo_check_authorization` alone; `phaedo_consult`
  — the other tool an autonomous agent actually uses — still answered from a possibly
  revoked cache. Both are guarded now.
- **A mis-paired configuration could authorize the agent (#286).** §5.4 pairing is now
  checked before a configuration is *carried forward*, not only before it is read:
  re-deriving from a configuration naming a different `fingerprint_id` re-stamped the
  current pairing onto it, turning a document every reader correctly rejects into one
  that governs — and §8.3 mints payment credentials against exactly those grants.
- **Revocation never worked (#247).** `standing_instructions` merge by union across
  devices, which cannot represent a deletion: any peer still holding a revoked rule
  restored it on the next sync. Revocation tombstones, enforced at read time as well as
  merge time, because enforcing only at the merge is what let one artifact give two
  answers.
- **`agents` scoping, enforced then hardened (#191, #193, v0.1.53–54).** A rule may
  scope a grant to a paired client; an adversarial pass then found four defects in the
  first implementation, all fixed here. Plus the missing ceiling `amount_lt` (#187),
  `action_descriptor` domain canonicalization — case and whitespace only (#200), and
  the §10.2 published domain vocabulary (#204).

### Capture — the agent can now learn from its own sessions

- **Track A (#162, #169):** a deposit contract, a transcript parser, a Claude Code
  `SessionEnd` hook, owner-side drain in the extension, owner tiers, service-worker
  alarm sync and a capture-model detector. 27 review findings across #165 and #166.
- **Track B (#174):** a sub-keyed capture lane and a tier-agnostic spine, with a live
  macOS accessibility reader piping reconstructed turns into `capture-a11y.js`.
- **§5.7 commitments (#182)** — decision *state*, what the subject already decided.
- **§10.7 fatigue-aware autonomy promotion (#184, #201)** — propose *less* friction
  when the evidence supports it, scoped to the client that earned it.
- **AP2 Intent Mandate profile + serializer (#183, #237)** — reads both authorization
  homes, and never asserts more headroom than the rule grants.

### §5 configuration home

The migration completes: vault persistence, canonical reads and cross-device parity
(#157, #158), the agent reporting in through the phone (#281), every reader turned
config-home native (#287), and the §5 upgrade gate wired with the register closed
(#301). Also RFC 8785 canonicalization in full, including NFC normalization — which
§6.2 had required since v0.1 with no implementation anywhere.

### Packaging, licensing and deletion

- **NOTICE and DCO travel with every distribution (#209)** — Apache-2.0 §4(d).
- **`install.mjs --uninstall --purge` (#153)** — truthful data deletion: actually
  removes local Phaedo data from disk rather than unregistering and leaving it.
- **The public open-core export could not build (#257, #258)** — one file list shared
  with `build-package.mjs`, not two that drift, and the public tree's suites now run.
- `escalation-policy.sample.json` now ships, alongside the consult-policy sample.

## 0.2.2 — published 2026-07-19 (metadata only) — ⚠️ DOES NOT START, see 0.3.0

`repository` (package.json + server.json) → the new PUBLIC open-core repo
`github.com/phaedo-labs/phaedo-mcp` (spec + reference server; staged by
`scripts/export-public-repo.mjs`). The prior target — the `phaedo-labs/phaedo`
monorepo — is private, so npm's Repository link 404'd for the public.
`directory`/`subfolder: mcp` unchanged (the public repo keeps the same layout).
No code change, no wire change; `phaedo_protocol_version` stays `0.1`.

**This entry read "pending publish" until 2026-09-20. It was wrong on both counts:**
the version went to npm on 2026-07-19, and it does not run — see the 0.3.0 notice.

## 0.2.1 — published 2026-07-18 (metadata only) — ⚠️ DOES NOT START, see 0.3.0

Namespace + repository move from the personal `galavoxx` account to the `phaedo-labs`
org — no code change, no wire change. `phaedo_protocol_version` stays `0.1`.

- **MCP registry namespace:** `mcpName` / `server.json name` → `io.github.phaedo-labs/phaedo-mcp`
  (was `io.github.galavoxx`). Publishing under the org (legal owner), not a personal account.
  The registry entry had not been published under the old namespace, so nothing is orphaned.
- **`repository` now points at the real source of truth:** `github.com/phaedo-labs/phaedo`
  with `directory`/`subfolder: mcp` (package.json + server.json), instead of the separate
  `galavoxx/phaedo-mcp` mirror. Publishing straight from the monorepo — no mirror to keep in
  sync, which was the drift source behind the 0.1.1→0.2.0 gap.

## 0.2.0 (2026-07-18) — protocol v0.1.24 → v0.1.39 — ⚠️ DOES NOT START, see 0.3.0

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
