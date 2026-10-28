---
description: Pair Phaedo with the Phaedo phone app, so Claude uses your full profile and can send decisions to your phone. Use when the user asks to pair, connect or set up Phaedo with their phone.
disable-model-invocation: true
---

Pair this computer with the user's Phaedo phone app.

1. Tell the user, in one line, to open the Phaedo app on their phone and keep it open.
2. Run this command in the background, and watch its output:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/pair.js"
   ```

3. Relay what it prints, in plain words, as soon as it prints it:
   - **"Found your phone"**: tell the user to approve **"Phaedo MCP Server"** on the phone.
   - **"Pair with code → XXXX-XXXX"**: tell the user to tap **Pair with code** in the app and type that code. Quote it.
   - **"Compare this code with the one on your phone"**: quote the code it prints, and tell the user to tap **Codes match** on the phone only if the phone shows the same code.
4. Wait for the command to finish. It waits up to two minutes for the phone.
   - On success, tell the user pairing worked and that their full profile is now used. A new Claude Code session picks it up at the start.
   - On failure, quote the error in one line and suggest running `/phaedo:pair` again with the app open.

Don't run anything else, and don't show the user file paths unless they ask.
