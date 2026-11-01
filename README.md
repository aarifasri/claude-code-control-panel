# Claude Code Control Panel

A small web page, running on your own computer, that shows everything installed in Claude Code (plugins, skills, commands, agents, MCP servers and hooks). For each item it shows what it does and how many tokens it adds to every session. It also lets you turn items on or off, or delete them, safely.

## Run it

You need Node.js 24 or newer and Claude Code on your `PATH`.

```bash
npm install
npm start
```

Then open the address it prints, usually **http://127.0.0.1:4317**. To stop it, press `Ctrl+C` in that terminal.

> **Changes take effect in new Claude Code sessions.** Sessions that are already open keep what they started with.

## What you can do

| Item | View | Switch on/off | Delete |
|---|---|---|---|
| Plugins | ✔ with token cost | ✔ (user scope; local scope in project view) | Uninstall (keeps the plugin's data) |
| Standalone skills and commands | ✔ | ✔ | Moved to the trash, restorable |
| Standalone agents | ✔ | Block or unblock | Moved to the trash, restorable |
| Skills, agents and hooks inside a plugin | ✔ | — (disable the plugin instead) | — |
| MCP servers | ✔ with health | — (use `/mcp`) | Remove (user scope; local scope in project view) |
| Hooks | ✔ | "All hooks" master switch only | — |

- **Scope picker:** choose a project to make changes that apply **only to that project**. They're written to its personal `.claude/settings.local.json`; the shared `.claude/settings.json` is never touched.
- **Verify with Claude Code:** starts Claude Code briefly, reads what it actually loaded, and compares that with the page. It stops before Claude answers, runs with hooks off, and saves no session.
- **Refresh:** re-reads everything, including the plugin list.

## Safety

- **Local only:** the page is reachable only from this computer (`127.0.0.1`).
- **Page token:** every request needs a random token the page receives when it loads. Other websites in your browser can't read your data, change it, or make it start `claude`.
- **Backups:** every settings file is backed up before any change. Backups live in `~/.claude-control-panel/backups/`, and the last 50 per file are kept.
  - ⚠ Backups of `~/.claude.json` (made before an MCP server is removed) can contain **API keys** from your MCP settings. Don't share that folder.
- **Trash:** deleted skills, commands and agents are **moved** to `~/.claude-control-panel/trash/` and can be restored from the Trash tab. Restore never overwrites anything.
- **Uninstall and MCP remove ask first** and use the official `claude` commands.
- **Log:** every change is recorded in `~/.claude-control-panel/actions.log`.

### Restore a settings file by hand

1. Close Claude Code.
2. Find the newest backup in `~/.claude-control-panel/backups/`. For example, `user-settings.<time>.json` is `~/.claude/settings.json`.
3. Copy it over the original.

## Develop

```bash
npm test            # 112 tests (fake home folders and a fake claude CLI; never your real setup)
npm run typecheck   # tsc --noEmit
```

Design and decisions are in [docs/](docs/). Start with [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [DECISIONS.md](docs/DECISIONS.md).
