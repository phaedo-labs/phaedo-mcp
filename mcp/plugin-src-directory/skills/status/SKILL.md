---
description: Show whether Phaedo is set up — paired with the Phaedo phone app, or not yet. Use when the user asks whether Phaedo is working, set up or paired.
disable-model-invocation: true
---

Check whether this computer's Phaedo is paired with the user's phone.

1. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/pull.js"
   ```

   If a phone is paired, the phone may show an approval card. Tell the user to approve it.

2. Reply in one or two plain sentences based on what it printed:
   - **From the phone:** Phaedo is paired and working.
   - **Cached copy:** the phone couldn't be reached, so an older copy was used. Open the Phaedo app and try again.
   - **No profile:** nothing is set up yet. Pair the phone app with `/phaedo:pair`.

3. End with the line it printed about this week (what Phaedo handled without interrupting them), as printed.

Don't show file paths, ids or raw output unless the user asks.
