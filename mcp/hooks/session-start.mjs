#!/usr/bin/env node
// Phaedo — Claude Code SessionStart hook.
//
// Claude Code runs this at the start of every session. It loads your fingerprint
// via the SAME source the MCP server uses (paired phone → at-rest cache) and
// emits the projection as `additionalContext`, so Claude Code injects it
// automatically — no tool call, no slash command. This is true auto-injection
// for Claude Code (Claude Desktop has no hook surface; use the `/phaedo` prompt
// or a Project instruction there).
//
// Wire it up (or run `npm run setup:code-hook` to do this for you) — in
// ~/.claude/settings.json:
//   { "hooks": { "SessionStart": [ { "hooks": [
//       { "type": "command", "command": "<node> <abs path to this file>" }
//   ] } ] } }
//
// FAIL-SAFE: any error (no pairing, phone unreachable + no cache, render failure)
// exits 0 with NO output, so a missing fingerprint never blocks or slows your
// session beyond a short timeout. It never writes anything.

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { loadFingerprintPreferCache } from '../fingerprint-source.js';
import { buildInjectionResponse } from '../projection.js';

// hooks/ lives one level under mcp/ — the sources resolve against mcp/.
const MCP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Never hang session start. If the phone pull + cache fallback hasn't resolved
// within the budget, emit nothing and let the session proceed.
const BUDGET_MS = 8000;

function emitContext(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  }));
}

async function run() {
  // PREFER the at-rest encrypted cache over a live phone pull. Claude Code (and Claude
  // Desktop's per-tab MCP spawn) runs SessionStart often — including on every tab bounce
  // to a session that uses this hook — so a LIVE pull here surfaces a stray "authorize"
  // sheet on the phone with no live caller behind it, since the user didn't initiate
  // anything from the subject side. The cache is exactly what session-start should rely
  // on: fast, non-interrupting, and refreshed by any real consult/escalate that follows.
  // Same pattern that #76 applied to escalation (cache-preferred fingerprint read).
  const vd = await loadFingerprintPreferCache(MCP_DIR);
  const response = buildInjectionResponse(vd, { requested_layers: ['all'], mode: 'standard' });
  if (response && response.projection) emitContext(response.projection);
}

const timeout = new Promise((res) => setTimeout(res, BUDGET_MS));
Promise.race([run().catch(() => {}), timeout])
  .then(() => process.exit(0))
  .catch(() => process.exit(0)); // belt-and-suspenders: a hook must never break the session
