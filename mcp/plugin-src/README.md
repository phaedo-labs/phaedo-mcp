# Phaedo for Claude

Phaedo learns how you like work done and how you decide, and keeps that profile on your
own devices. This plugin lets Claude use it:

- **Answers the way you like.** Your preferred length, tone and format load at the start
  of every Claude Code session, so you don't repeat them.
- **Checks with you before acting.** Before Claude merges, deploys, publishes, force-pushes,
  comments for you, or sends, pays or deletes through a connected app, it asks Phaedo whether
  you'd want it to go ahead. When you would want to see it, you get a prompt — even in auto
  mode — with the reason ("it can't be undone", or the rule of yours that says so). Otherwise
  it stays quiet.
- **Sends decisions to your phone.** With the Phaedo phone app paired, a decision that
  needs you shows up as an approve / deny card on your phone.
- **Shares it with your other agents, if you ask.** `/phaedo:rules` writes a short version of
  your profile into the instruction files Codex, Copilot CLI, Gemini CLI, Antigravity and
  Cursor read, and keeps it current.
- **Learns from your sessions.** It notices patterns in how you work in Claude Code, such
  as asking for shorter answers, and builds them into your profile. `/phaedo:learned` shows
  you each thing it learned in one plain sentence; remove any that aren't right.

## What you need

- **Node.js** (free, from [nodejs.org](https://nodejs.org)). The plugin runs on it.
- **Optional: the Phaedo phone app**, for your full profile and phone approvals. It isn't
  open to the public yet; [phaedo.so](https://phaedo.so) has a link to hear when it is.

Without the phone app, Phaedo starts a profile from your own Claude Code sessions on this
computer. It starts thin and grows as you work. Type `/phaedo:status` to see how far along
it is.

## Commands

- `/phaedo:status` — where your profile comes from right now, and how much it has learned.
- `/phaedo:pair` — pair with the Phaedo phone app.
- `/phaedo:rules` — give your other AI agents the same profile (or take it back out).
- `/phaedo:learned` — see what Phaedo learned from how you work, and keep or remove each item.
- `/phaedo:import` — teach Phaedo from your ChatGPT or Claude history (the export file each gives you).

## What it runs, stores and sends

- **On your computer:** a local MCP server (`server.js`) and hooks that run at session
  start, at the end of each turn, at session end, and around terminal commands and
  connected-app actions (to spot a merge, deploy, publish, message, payment or delete).
  Everything is plain JavaScript in this folder.
- **What it stores:** in `~/.phaedo-mcp` on your computer — the pairing with your phone,
  an encrypted copy of your profile for when the phone is offline, counts of patterns from
  your sessions, and a record of the decisions it was asked about (for an action through a
  connected app, who or what it was aimed at, such as a recipient or channel — never the
  message itself). Conversation text is
  read on your computer, reduced to counts (like "asked for a shorter answer, 4 times"),
  and discarded. The same goes for a ChatGPT or Claude export you import with `/phaedo:import`:
  read on your computer, counted, and discarded. If you run `/phaedo:rules`, a short, readable version of your profile (your
  rules and how you like answers) is also written into those agents' own instruction files,
  such as `~/.codex/AGENTS.md`, inside a marked block you can delete.
- **What it sends:** only when you've paired the phone app, encrypted messages between
  this computer and your phone — directly over your Wi-Fi, or through Phaedo's relay
  (`phaedo-relay.fly.dev`) when you're on different networks. The relay can't read them.
  Without a paired phone, Phaedo itself sends nothing. To judge how big or risky a merge
  is, the merge check runs your own `git` and `gh` commands to read the change and its
  checks, which `gh` fetches from GitHub as it normally does.

To remove it, uninstall the plugin. Your profile files stay in `~/.phaedo-mcp` until you
delete that folder.

## More

Source, the open Anamnesis standard behind it, and the full guide:
[github.com/phaedo-labs/phaedo-mcp](https://github.com/phaedo-labs/phaedo-mcp).
Licensed under Apache-2.0.
