# Connect IQ store listing

Copy these into the Connect IQ developer dashboard (apps.garmin.com/developer) when you upload `Holdpoint.iq`.

## Basics

| Field | Value |
|---|---|
| App name | Holdpoint |
| App type | Device app (glance on supported watches) |
| Category | Tools / Productivity |
| Price | Free |
| Privacy policy URL | https://holdpoint.kiorte.com/privacy |
| Support / website URL | https://github.com/kiorte-lab/holdpoint |
| Permissions shown | Communications (talks to the relay), Background (checks for waiting requests every 5 minutes) |

## Short description (one line)

Approve, deny and reply to your AI coding agent from your wrist.

## Description

Step away from your desk while Claude Code, Codex, GitHub Copilot CLI or Antigravity keeps working. When your agent needs permission or finishes a task, Holdpoint buzzes your watch.

- **Approve or deny** commands and file edits from your wrist.
- **Read what your agent did** when it finishes, then send your next instruction with one tap: "Continue", "Run the tests", "Commit and push", or your own buttons.
- **Locked commands** such as force pushes, `rm -rf` and `sudo` can only be denied from the watch, never approved.
- **Away mode**: switch it on when you leave. At your desk, everything stays in the terminal as usual.
- Works with the Claude Code terminal, desktop app and VS Code, plus Codex, Copilot CLI and Antigravity CLI.
- Your watch talks to the internet through your phone, so your computer can be anywhere.

**Setup takes a minute.** Install the free Holdpoint plugin in Claude Code (`/plugin install holdpoint --marketplace kiorte-lab/holdpoint`) or the command-line tool, run `holdpoint pair`, and type the 6-digit code from your watch. Full guide: github.com/kiorte-lab/holdpoint

**Privacy:** no account and no tracking. Only short summaries (the command or a few lines of your agent's message) pass through the relay, which keeps them in memory and deletes them within an hour. Your code stays on your computer. You can also run your own relay.

Not affiliated with Anthropic, OpenAI, GitHub or Google.

## What's new (first release)

First public release. Supports 98 Garmin watches running Connect IQ 3.1 or newer, including Fenix, Epix, Forerunner, Venu, Vivoactive, Instinct and MARQ.

## Screenshots

Upload the files in `store/` in this order (Forerunner 965, 454×454):

1. `1-finished-card.png`: the agent finished; read its message and reply
2. `2-approve.png`: a permission request to approve or deny
3. `3-locked.png`: a locked command that can only be denied
4. `4-reader.png`: the full message, scrollable
5. `5-pair.png`: pairing with your computer

## Hero image / icon

The launcher icon is built into the app. For the store's app icon, use `store/cover-500.png` (500×500).
