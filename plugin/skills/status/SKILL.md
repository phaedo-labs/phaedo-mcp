---
description: Show where Phaedo's profile comes from right now — the paired phone, a starter profile built from your sessions, or none yet. Use when the user asks whether Phaedo is working, set up or paired.
disable-model-invocation: true
---

Check where this computer's Phaedo profile comes from.

1. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/pull.js"
   ```

   If a phone is paired, the phone may show an approval card. Tell the user to approve it.

2. Reply in one or two plain sentences based on what it printed:
   - **From the phone:** Phaedo is paired and working.
   - **Cached copy:** the phone couldn't be reached, so an older copy was used. Open the Phaedo app and try again.
   - **Starter profile:** say how much it has learned, as printed, and that pairing the phone app (`/phaedo:pair`) adds the rest.
   - **No profile:** nothing is set up yet. Using Claude Code builds a starter profile over a few sessions, or pair the phone with `/phaedo:pair`.

Don't show file paths, ids or raw output unless the user asks.
