---
description: Share what Phaedo has learned with the user's other AI coding agents (Codex, Copilot CLI, Gemini CLI, Antigravity, Cursor) by writing it into their own instruction files. Use when the user asks for their other agents to know how they like to work, or to take that back out.
disable-model-invocation: true
---

Write the user's Phaedo profile into the instruction files their other AI agents read.

1. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/rules-files.js"
   ```

   - To include a Cursor project, add `--project "<folder>"` (Cursor has no file for every project, so it goes in that project, kept out of git).
   - To include Claude Code's own `~/.claude/CLAUDE.md`, add `--for claude` (usually not needed: Phaedo already loads the profile here).
   - If the user asks to take it back out, add `--remove`.

2. Reply in one or two plain sentences: which agents now have it, or that none were found on this computer. Say that Phaedo keeps those files up to date as it learns, and that `/phaedo:rules` with "remove" takes it out.

Don't show the profile text, file contents or raw output unless the user asks.
