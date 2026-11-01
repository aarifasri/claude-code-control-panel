# Implementation Plan

Each milestone is a small vertical slice: it delivers something you can use, it has tests, and it's checked
before the next one starts. **Read-only first, writes later**, so nothing can damage your setup until the
safety core (M3) exists and is tested.

Verification commands (from M0 on): `npm test` · `npm run typecheck` · `npm start`

| # | Milestone | Status |
|---|---|---|
| M0 | Project setup | ✅ 2026-11-01 |
| M1 | Read-only inventory: plugins, skills, agents, with search | ✅ 2026-11-01 |
| M2 | Token costs + MCP list/health (text parsers) | ✅ 2026-11-01 |
| M3 | Safety core: token/origin checks, lock, backup + atomic settings writer, allow-list | ✅ 2026-11-01 |
| M4 | Standalone skill on/off and agent block/unblock | ✅ 2026-11-01 |
| M5 | Plugin enable/disable/uninstall | ☐ |
| M6 | Trash: delete + restore standalone skills/agents | ☐ |
| M7 | Project scope (picker, project items, local-settings writes, precedence warnings) | ☐ |
| M8 | Hooks view + master switch; MCP remove | ☐ |
| M9 | "Verify with Claude Code", accessibility pass, validation checklist | ☐ |

---

### M0 · Setup
- **Scope:** `package.json`, `tsconfig.json` (Node runs TypeScript natively), `node:test` runner, `.gitignore`, git repo, project `CLAUDE.md`.
- **Acceptance:** `npm test` runs a sample test; `npm run typecheck` passes.
- **Risk:** none.

### M1 · Read-only inventory
- **Depends on:** M0.
- **Files:** `domain/types.ts`, `domain/ids.ts`, `adapters/cli.ts`, `adapters/frontmatter.ts`, `services/inventory.ts`, `server.ts`, `public/*`.
- **Acceptance:**
  - AC-1: all 18 plugins are shown with on/off state that matches the CLI.
  - Standalone skills and agents show their descriptions.
  - Search and filters work.
  - A broken frontmatter file still produces a listed item, with a warning.
- **Tests:**
  - Frontmatter parsing: normal, missing, malformed, and CRLF line endings.
  - `plugin list` JSON mapping.
  - ID building.
  - Inventory built against a **fake `~/.claude` in a temp folder**.
- **Risk:** `claude` CLI output varies between versions. Mitigation: the CLI adapter is isolated in one module, and its tests use captured sample output.

### M2 · Costs + MCP
- **Files:** `adapters/parsers/pluginDetails.ts`, `adapters/parsers/mcpList.ts`, `services/costs.ts`.
- **Acceptance:**
  - AC-7: ECC shows about 48k always-on tokens.
  - Every MCP server from `claude mcp list` appears with its status.
  - Output the parser can't read shows as "unknown" plus the raw text, without crashing.
- **Tests:** the parsers run against real captured output (`test/fixtures/`).

### M3 · Safety core (nothing writes until this exists)
- **Files:** `adapters/settingsFile.ts`, `adapters/backup.ts`, `services/lock.ts`, `server.ts` (security middleware).
- **Acceptance:**
  - AC-5: a request without the token gets 403.
  - A bad `Origin` or `Host` header gets 403.
  - Each write produces a backup, then an atomic write that keeps all other keys.
  - Paths outside the allow-list are refused.
- **Tests:**
  - Invariants I1, I2, I4, I5 and I7 are tested on temp files.
  - One test changes the file between our read and our write.

### M4 · Skill and agent toggles
- **Acceptance:** AC-3, and agent block/unblock. The effective state comes from the precedence rules in DATA_MODEL §4.
- **Tests:**
  - The precedence table for each level combination.
  - Removing a deny rule from every writable file.
  - A managed-file deny leaves "enable" unavailable.

### M5 · Plugins
- **Acceptance:**
  - AC-2.
  - A CLI failure flips the switch back and shows the error.
  - Uninstall asks for confirmation.
- **Tests:** the CLI adapter is replaced by a fake that records the arguments it was given. **No real plugin changes in automated tests.**
- **Manual check:** disable and re-enable one small plugin for real.

### M6 · Trash
- **Acceptance:**
  - AC-4: restore gives back an identical copy.
  - The restore-conflict case refuses and explains.
- **Tests:** move and restore on temp folders, plus the manifest.

### M7 · Project scope
- **Acceptance:**
  - Selecting a project shows user items plus project items.
  - Toggles write to `settings.local.json`.
  - A precedence warning appears when another file cancels the change.

### M8 · Hooks + MCP remove
- **Acceptance:**
  - Hooks are listed by event, with their source.
  - The master switch writes `disableAllHooks`.
  - MCP remove calls the CLI with the item's scope.
  - Plugin and connector MCP servers are view-only, with a reason.

### M9 · Verify + finish
- **Acceptance:**
  - "Verify" reports mismatches against Claude's `init` event.
  - The keyboard and screen-reader checks from USER_FLOWS §4 pass.
  - The Phase 7 checklist is written.
- **Risk:** the probe may cost tokens (D-005, unverified). Measure it before shipping the button.
