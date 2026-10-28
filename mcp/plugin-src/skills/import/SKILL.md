---
description: Teach Phaedo from the user's ChatGPT or Claude history, using the data export file either service provides. Use when the user wants Phaedo to learn from their past ChatGPT or Claude conversations.
disable-model-invocation: true
---

Help the user teach Phaedo from their ChatGPT or Claude history.

1. If they don't have the export yet, tell them how to get it, then stop until they have it:
   - **ChatGPT:** Settings → Data controls → Export data. ChatGPT emails a download link.
   - **Claude:** Settings → Privacy → Export data. Claude emails a download link.

2. Ask where the downloaded `.zip` is (usually the Downloads folder), then run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/history-import.js" "<path to the zip>"
   ```

   It reads the last year of conversations. Add `--all` only if the user asks for everything.

3. Reply in one or two plain sentences with what it printed: how many conversations it read and what it found. Say that only counts were kept and the export file can be deleted, and that `/phaedo:learned` shows what it learned.

Never read, quote or summarize the conversations yourself. The script handles the file; the text stays on this computer.
