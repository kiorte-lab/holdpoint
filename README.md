# Holdpoint (v0.5)

Leave your desk while your coding agent keeps working. When you're away, Claude Code and Codex send their permission prompts and "finished" messages to your phone (and later your Garmin watch). Approve, deny, or reply with one tap, and the agent carries on.

```
Claude Code / Codex ──PermissionRequest hook──▶ relay ◀── phone page (now) / Connect IQ glance (next)
```

## Quick start (Claude Code plugin)

In Claude Code:

```
/plugin install holdpoint --marketplace simoncassford-lab/holdpoint
/holdpoint:pair
```

`/holdpoint:pair` shows a 6-digit code. Enter it in Garmin Connect (your watch > Connect IQ apps > Holdpoint > Settings > Pairing code) or on the phone page, and pairing finishes by itself. Other commands: `/holdpoint:status`, `/holdpoint:on`, `/holdpoint:off`, `/holdpoint:unpair`.

Other agents: run `node cli/holdpoint.js agents <list>` once after pairing, e.g. `agents claude,codex,copilot,antigravity` (or `all`). Supported:
- **Claude Code** (terminal, desktop app, VS Code): approvals, finished cards, replies.
- **Codex** (ChatGPT): the same. Run `/hooks` in Codex once to trust the hooks.
- **GitHub Copilot CLI**: the same. The hooks go in `~/.copilot/hooks/holdpoint.json`.
- **Antigravity CLI** (Gemini CLI's successor; `gemini` works as an alias): approvals and finished cards with replies. It has no prompt-submit hook, so press Esc in the terminal to release a waiting card.

## Hosted relay: Cloudflare Workers (recommended)

```
npm i -g wrangler
wrangler login
wrangler deploy          # from this folder; uses wrangler.toml
```

You get `https://holdpoint-relay.<your-subdomain>.workers.dev` with HTTPS built in. One Durable Object holds the live queue and the long-polls. Pairings are stored per key in Durable Object storage, so they survive restarts. Pending approvals are held in memory, so a hook that's waiting during a redeploy falls back to the terminal prompt.
The free Workers plan covers Durable Objects, but check Cloudflare's current limits before launch. Set `PUBLIC_URL` under `[vars]` for the notification tap-through link.

## Self-hosted relay (e.g. on the Pi)

```
docker build -t holdpoint .
docker run -d --name holdpoint -p 8787:8787 -v holdpoint-data:/data --restart unless-stopped holdpoint
```

Put it behind HTTPS (Cloudflare Tunnel, Tailscale Funnel or your reverse proxy). The CLI refuses plain http except on local addresses.
Optional env: `PUBLIC_URL` (link opened when you tap a notification), `NTFY_BASE` (self-hosted ntfy).

## Pair a machine

1. Open the relay URL on your phone. It registers itself and shows a 6-digit code.
2. On the Claude Code machine run: `npx holdpoint pair <code> --relay https://your-relay`
   (before it's on npm, run `node cli/holdpoint.js pair …` from this folder instead)

This copies the hook to `~/.config/holdpoint/` and adds a `PermissionRequest` hook for each agent it finds: `~/.claude/settings.json` for Claude Code, `~/.codex/hooks.json` for Codex. Force a choice with `--agent claude|codex|both`. Your other settings and hooks are left alone.

**Codex:** open Codex and run `/hooks` once to trust the Holdpoint hook. Codex skips hooks it hasn't been told to trust. `holdpoint off`/`on` never change the hook definition, so you won't have to trust it again.

## Watch app (Garmin Vivoactive 6)

Source is in `watch/`. A signed build for your relay is in `watch/bin/Holdpoint.prg`.

**Sideload:** plug the watch into the PC by USB. It shows up as a device in Explorer. Copy `Holdpoint.prg` into `Internal Storage\GARMIN\Apps`, then unplug. Holdpoint appears in the apps list and as a glance.

**Pairing, two ways:**
- **PC shows the code (easiest):** run `node cli/holdpoint.js pair` on the PC. It prints a code. Type it into Garmin Connect: your watch > Connect IQ apps > Holdpoint > Settings > **Pairing code** (store installs only), or on the phone page under "Pair a machine". The PC finishes pairing by itself.
- **Watch shows the code:**
- run `node cli/holdpoint.js pair <code>` on a PC, which pairs that PC to the watch; or
- type the code on the phone page under **Add a watch**, which joins the watch to the phone's queue so both see the same cards (recommended).

**Using it:**
- Reply buttons can be edited in Garmin Connect (Holdpoint > Settings > Reply buttons, comma-separated) or on the phone page.
- Tap the **AT DESK / AWAY** pill at the top for Away mode and pairing.
- Swipe up or down to move between cards.
- Tap a card to answer it: Approve or Deny, or a reply button on a finished card.
- With the app closed, the glance shows how many cards are waiting. A background check every 5 minutes offers to open the app when something new is waiting while you're away. Open the app for instant updates and buzzes.

**Build:** with the Connect IQ SDK: `monkeyc -f watch/monkey.jungle -d vivoactive6 -y developer_key.der -o Holdpoint.prg -r`.

## Away mode

Nothing changes at the desk. Flip **Away** on the phone page (later on the watch) and:
- **Permission prompts** go to your wrist (approve / deny).
- **"Finished" cards** appear when the agent stops. They show the last thing it said, plus your reply buttons (default: Continue, Run the tests, Commit and push, Summarise what you did; edit them on the phone page) or a typed reply. Your reply goes back as the agent's next instruction through the `Stop` hook. **Done for now** lets it stop.
- Switch Away off and anything still waiting is handed back to the terminal straight away.
- `--always` on `pair` routes prompts even when you're not away. `--no-stop` skips finished cards. `--reply-timeout <s>` sets how long a finished card waits (default 900s).

## Behaviour

- Only fires when Claude Code would have shown a permission prompt. Commands you've already allowed never reach the phone.
- Approve → runs. Deny → Claude is told not to retry and to ask you instead.
- No answer in 120s → denied, and Claude carries on with other work. Use `--on-timeout prompt` to fall back to the terminal prompt instead. Change the wait with `--timeout <s>`.
- **Locked commands** (`rm -rf`, `sudo`, force push, `reset --hard`, `curl | sh`, `DROP TABLE`…) can be denied remotely but never approved. If you don't deny them, they fall through to the terminal.
- If the relay is unreachable, the hook steps aside and you get the normal prompt.
- Plan-mode exits and questions to you always stay in the terminal.
- `holdpoint off` / `on` / `status` / `unpair`.

## Security notes

- Tokens are random 256-bit values, and the relay stores only their SHA-256 hashes.
- ntfy notifications contain only the tool and machine name, never the command.
- v0.1 trusts the relay: whoever controls it could approve requests. End-to-end signing (the device signs decisions with a key the relay never sees) is planned before the hosted public version.

## Tests

`WRANGLER=$(which wrangler) node --test test/worker.smoke.js` runs the Worker in Cloudflare's local emulator and drives it with the real CLI and hook (9 checks, including restart persistence, finished cards and away mode).


`npm test` covers 63 end-to-end cases against a real relay and the real hook process: pairing, allow/deny, Claude + Codex install/uninstall, Codex `apply_patch` summaries, timeouts, locked commands, SIGTERM cancel (including a kill that arrives mid-request), relay down, unpair, persistence and ntfy privacy.

## Not yet verified against the real tools

Hook formats come from documentation and community references. Do one live check with each agent:
- **Claude Code:** `PermissionRequest` → `hookSpecificOutput.decision.behavior`. Also check whether the terminal prompt stays usable while the hook waits.
- **Stop hook:** that `{"decision":"block","reason":…}` makes Claude carry on with the reply, and what happens if you type in the terminal while a finished card is waiting.
- **Codex:** the same output shape is assumed (Codex's PermissionRequest copies Claude's fields). Check the `apply_patch` input field name and that hooks don't need extra enabling in your Codex version.
