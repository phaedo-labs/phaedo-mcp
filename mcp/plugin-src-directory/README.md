# Phaedo for Claude

Phaedo keeps a profile of how you like work done and how you decide, on your own devices, in
the Phaedo phone app. This plugin lets Claude use it:

- **Checks with you before acting.** Before Claude merges, deploys or publishes, it asks
  Phaedo whether you'd want it to go ahead, and asks you when the stakes are high.
- **Sends decisions to your phone.** A decision that needs you shows up as an approve / deny
  card on your phone.
- **Signs spending approvals.** When an agent needs your permission to spend, you approve it
  on your phone with Face ID.
- **Answers the way you like, when you ask.** Say "load my Phaedo profile" and Claude uses
  your preferred length, tone and format for that session. It never loads on its own.

This edition doesn't read your conversations or Claude's chat history, and doesn't learn from
your sessions. Your profile comes only from the Phaedo phone app.

## What you need

- **Node.js** (free, from [nodejs.org](https://nodejs.org)). The plugin runs on it.
- **The Phaedo phone app**, for your profile and phone approvals. It isn't open to the public
  yet; [phaedo.so](https://phaedo.so) has a link to hear when it is. Without it, Phaedo has no
  profile, and says so plainly.

## Commands

- `/phaedo:pair` — pair with the Phaedo phone app.
- `/phaedo:status` — whether Phaedo is paired and working.

## What it runs, stores and sends

- **On your computer:** a local MCP server (`server.js`) and one check that runs around
  terminal commands, to spot a merge, deploy or publish and ask Phaedo first. Everything is
  plain JavaScript in this folder.
- **What it stores:** in `~/.phaedo-mcp` on your computer — the pairing with your phone, an
  encrypted copy of your profile for when the phone is offline, and a record of each decision it
  was asked about (the action, a short description, any amount, what Phaedo answered, and what
  you decided).
- **What it sends:** encrypted messages between this computer and your phone — directly over
  your Wi-Fi, or through Phaedo's relay (`phaedo-relay.fly.dev`) when you're on different
  networks. The relay can't read them. To judge how big or risky a merge is, the check runs your
  own `git` and `gh` commands, which `gh` fetches from GitHub as it normally does.

To remove it, uninstall the plugin. The files stay in `~/.phaedo-mcp` until you delete that
folder. [Privacy policy](https://phaedo.so/privacy) · [Terms](https://phaedo.so/terms).

## More

Source and the open Anamnesis standard behind it:
[github.com/phaedo-labs/phaedo-mcp](https://github.com/phaedo-labs/phaedo-mcp). Licensed under
Apache-2.0.
