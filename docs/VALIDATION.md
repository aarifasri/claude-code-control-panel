# Validation Checklist (Phase 7)

Date: 2026-11-01 · Claude Code 2.1.314 · Node 24.14.1 · Windows 11

This is a **personal local tool**, so "production-ready" here means safe and reliable for one user on one machine. It is not a hosted service.

## ✅ Completed, with evidence

### Automated tests: 112 passing (`npm test`), type check clean

They use temp-folder fake homes and a fake CLI, and never touch the real `~/.claude`.

| Area | Tests cover |
|---|---|
| Domain rules | Settings precedence; skill, agent and hook state; allowed actions and reasons; mutations that round-trip cleanly; verify comparison |
| Settings writer | Backup before write (I1), allow-list (I2), other keys kept (I4), concurrent-change retry (I5), invalid JSON untouched, pruning, no temp files left |
| Trash | Byte-identical round trip; restore conflict; tampered manifest can't move or delete other folders |
| Parsers | Real captured `plugin details` and `mcp list` output; secret masking |
| HTTP security | Token on every API call; Origin check on writes; JSON-only writes; foreign Host (DNS rebinding); body limits; busy lock (423) |
| End to end (fake CLI) | Skill, agent, plugin and hook switches; trash and restore; project view writes only `settings.local.json`; local plugins run in the project folder; MCP remove with backup and re-check |

### Live checks on the real installation, each reversed afterwards

| Check | Evidence |
|---|---|
| Skill off/on and agent block/unblock (throwaway items) | `settings.json` SHA-256 identical afterwards; Claude Code's `init` confirmed the skill gone while off (D-008) |
| Plugin off/on (`frontend-design`) | Claude Code stopped loading its skill; settings deep-equal afterwards (the CLI reorders keys, D-009) |
| Trash (throwaway skill with a nested file) | Every file's SHA-256 identical after restore (D-010) |
| Project view (empty `ClaudeCodeTest` project) | Skill off only inside that project per `init`; user settings unchanged (D-011) |
| All hooks off/on | `settings.json` SHA-256 identical (D-012) |
| MCP remove (throwaway `ccp-test` server) | Gone from `~/.claude.json`; backup holds it; real servers untouched (D-012) |
| Verify | Whole setup: 18 plugins, 717 skills, 409 agents, **0 differences** |
| Security in the browser | Page token present; API answers 403 without it; Host and Origin checks verified with curl |
| Keyboard | Tabs move with the arrow keys (roving tabindex); switches use `role="switch"` with labels; dialogs are native `<dialog>` elements |

### Performance (measured)

| Operation | Time |
|---|---|
| Inventory, cached plugin list | 0.7–0.9 s |
| Inventory, fresh plugin list | 2.3–3.0 s |
| Token costs | ~21 s the first time, ~3 s from cache |
| MCP health check | ~45 s (Claude Code checks every server) |
| Verify | ~14–16 s |

## ⚠ Not verified / known limits

- **Verify cost:** Verify stops Claude Code right after its `init` event, before any answer. Whether an API request is already sent at that point hasn't been measured (D-005).
- **Accessibility:**
  - Not tested with a real screen reader (NVDA or Narrator).
  - Colour contrast not measured with a tool.
- **Text parsing:** `plugin details` and `mcp list` output is parsed as text. A Claude Code update could change the format. Parsers fall back to "unknown" plus the raw text, and tests pin today's format.
- **Single-item switches inside plugins:** plugin skills and agents can only be switched by disabling the whole plugin. Claude Code doesn't support anything finer (D-006).
- **MCP on/off:** not provided (D-002). Use `/mcp`.
- **Leftover file:** after turning a skill off and on again in a project, a `{}` `settings.local.json` can be left behind. Harmless (D-011).
- **Tiny race window:** between the final re-read and the rename of a settings file. The backup covers it (D-007).
- **Untested paths:**
  - Managed (enterprise) settings: no such file on this machine. Covered only by unit tests.
  - Local-scope plugins and local MCP servers: none exist on this machine. Covered only by the fake CLI.

## Recovery

- **Restore settings:** copy a file from `~/.claude-control-panel/backups/` over the original, with Claude Code closed. See the README.
- **Restore deleted items:** from the Trash tab, or by moving folders back from `~/.claude-control-panel/trash/`.
- **Undo an MCP remove:** re-add the server with `claude mcp add`, using the settings in the `claude-json.<time>.json` backup.
