---
description: Show what Phaedo has learned about how the user works, and keep or remove items. Use when the user asks what Phaedo knows or has learned about them, or wants something it learned taken out.
disable-model-invocation: true
---

Show the user what Phaedo learned from how they work, and let them keep or remove each item.

1. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/learned.js"
   ```

2. Show the numbered list as printed, including any "disagrees with" notes. Ask which to remove (and whether the rest can be kept). Don't explain how Phaedo works unless asked.

3. When they answer, run one of these with their numbers, from the same list:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/learned.js" --remove 3,5
   node "${CLAUDE_PLUGIN_ROOT}/learned.js" --keep all
   ```

   Run `--remove` first when they want both, since `--keep all` keeps everything still listed. To see or undo removals: `--forgotten`, then `--restore <number>`.

4. Confirm in one line what was removed or kept. If anything was removed, say that it stops shaping answers on this computer from the next session, and that removing it from the phone's profile is done in the Phaedo app.
