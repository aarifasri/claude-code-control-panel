# Decisions

Short records of decisions and the evidence behind them. Newest first.

## D-012 · Hooks are view-only except the master switch; MCP remove goes through the CLI (2026-11-01)
- **Hooks:**
  - Listed from every settings layer, plus each plugin's `hooks/hooks.json`. Each handler becomes one view-only item, with secrets in commands masked.
  - Claude Code has no per-hook switch (BR-6). The only control is an **"All hooks"** item that writes `disableAllHooks`.
  - Turning hooks back on mirrors skills: remove our key if that's enough, otherwise write `false` (`hooksEnableValue`).
  - `~/.claude/settings.local.json` also has hooks, but it only applies to sessions started in the home folder, which isn't offered as a project. It isn't counted.
- **MCP remove:** `claude mcp remove <name> --scope user|local`. Local servers need their project in view, and the command runs there.
  - Before removing, the app copies `~/.claude.json` to `backups/claude-json.<time>.json`. That copy **can contain MCP secrets** (env, headers), but it stays in the app folder in the user's profile and is never sent to the browser.
  - Afterwards `~/.claude.json` is re-read to confirm the server is really gone (I8). Removal requests are checked against the names in `~/.claude.json`, so they don't wait for the 45 s health check.
  - View-only, with reasons: claude.ai connectors, plugin servers, servers in a project's shared `.mcp.json`, and flag-like names (`SAFE_MCP_NAME`).
- **Live tests:**
  - "All hooks" off and on through the page: `settings.json`'s SHA-256 was identical afterwards.
  - A throwaway user-scope server (`ccp-test`, added with `claude mcp add`) was removed through the page. It was gone from `~/.claude.json`, the backup still held it, and the user's three real servers were untouched.

## D-011 · Project view: personal settings.local.json, CLI runs in the project (2026-11-01)
- **Project picker:**
  - The picker lists only folders from `~/.claude.json` → `projects` that still exist, de-duplicated across `/` and `\` and letter case.
  - The **home folder is excluded**: its `.claude/settings.json` *is* the user settings file, so listing it would count the same file twice.
  - A project path from the browser is matched against that list. The raw string is never used (I3).
- **Writes** go to `<project>/.claude/settings.local.json` only. The shared `.claude/settings.json` is never written (BR-4).
- **Enable a skill for one project:** write `"on"` if a lower-precedence file turns it off (`skillEnableValue`), otherwise just remove our entry.
- **Unblock an agent:** removes the deny rule from every writable file, *including user settings*, because deny rules merge and an allow rule can't beat them. The target shown names both files, so the global effect is visible.
- **Local-scope plugins:** `claude plugin … --scope local` means "the project the CLI runs in", so the command runs with `cwd = project`. `plugin list` and `mcp list` also run there.
- **Trash:** restore may target any known project's `.claude` folder, whatever view is open.
- **Live test on the empty `ClaudeCodeTest` project:**
  - Turned off the user skill `careful` for that project only.
  - Claude Code's `init` event showed `careful` missing inside the project but still loaded in another folder.
  - User `settings.json`'s SHA-256 was unchanged.
- **Known leftover:**
  - After turning it back on, the app leaves a `{}` `settings.local.json` that didn't exist before. It's harmless, since Claude Code treats it like no file.
  - The test removed it by hand. Deleting files the app created is a possible later improvement.
- **Stray servers:** a restart found five `node src/server.ts` processes from earlier background starts. Restarts now go through one stop-all step, and the count was checked to be one.

## D-010 · Trash: record first, then move; check both ends on restore (2026-11-01)
- **Delete** moves a standalone skill folder, or an agent or command `.md` file, into `~/.claude-control-panel/trash/<time>_<rand>/<name>`. The entry goes into `trash/manifest.json` *before* the move: if the move fails, the entry is removed again; if the app crashes after the move, the entry still says where the item belongs.
- **Allowed sources** (`isTrashableSource`): exactly one level inside `<root>/skills/`, or a `.md` file directly in `<root>/agents/` or `<root>/commands/`. Plugin files never qualify.
- **Restore** re-checks both ends, because `manifest.json` is a file on disk and could be edited:
  - The destination must be an allowed source.
  - The trashed copy must be exactly `<trashDir>/<slot>/<name>`.
  - Tests prove a tampered manifest can't move or remove other folders.
- **Conflicts:** restore refuses when something now exists at the original path (BR-8), and keeps the trashed copy.
- **Settings left in place:** a deleted item's `skillOverrides` entry or deny rule stays in settings. It's harmless and re-applies on restore, and the toast says so.
- **Live test:**
  - A throwaway skill folder with a nested file was moved to the trash and restored through the page.
  - Every file's SHA-256 matched afterwards, and the trash slot and manifest entry were cleaned up.
- **Not in v1:** emptying the trash. The user can delete `~/.claude-control-panel/trash` by hand.

## D-009 · Plugins go through the claude CLI, with our own backup first (2026-11-01)
- **Commands:**
  - Enable and disable run `claude plugin enable|disable <id> --scope <scope> --json`.
  - Delete runs `claude plugin uninstall … --keep-data`. Keeping the plugin's data dir means a reinstall gets its state back.
- **ID safety:** plugin ids must match `name@marketplace` (`SAFE_PLUGIN_ID`) before they reach the CLI. With no shell, injection isn't possible, but an "id" like `-a` would be read as a *flag*, and `plugin disable -a` disables **all** plugins. The check runs in both `rules.ts` and the executor.
- **Scope limits (v1):**
  - Only **user**-scope plugins are changeable.
  - Project scope would rewrite the team-shared `.claude/settings.json`.
  - Synced plugins belong to claude.ai.
  - Local scope waits for project view (M7).
- **Bug found in the live test:** the first real disable logged `backups: []`. The CLI writes `settings.json` itself, so our backup step never ran (an I1 violation). Fixed with `backupSettingsFile()` before every plugin command. The re-enable then produced a backup.
- **Observation:** after a real off and on of `frontend-design`, `settings.json` was **deep-equal** to the original, but its top-level key *order* had changed. That reordering comes from Claude Code's own settings writer: our writer keeps key order, as D-008 proved byte-for-byte. Key order has no meaning in JSON settings, so this is harmless. Don't compare plugin round-trips by hash.
- **Speed:** a plugin change takes about 8–15 s: `plugin list`, then the command, then `plugin list` and a page refresh. That's slower while the MCP health check runs.

## D-008 · Toggles leave no trace when reversed; file reads run in parallel (2026-11-01)
- **Commands:** `skillOverrides` turns off a standalone **command** too. A probe showed `ccp-cmd` gone from `slash_commands`. So commands share the skill switch.
- **Clean reversal:** removing an override or deny rule also removes the container (`skillOverrides`, `permissions.deny`, `permissions`), but only when *that removal* emptied it. Containers the user already had empty are kept.
  - *Live proof on the real `~/.claude/settings.json`:* a throwaway skill was turned off and on, and a throwaway agent was blocked and unblocked, all through the page. The file's SHA-256 afterwards was identical to before. Claude Code's `init` event confirmed the skill really disappeared while off.
- **Speed:** a toggle first took about 10 s. Measuring showed the cause was reading ~1,200 skill and agent files one at a time (2.4–6.7 s), not the CLI.
  - Reads now run in parallel: 0.6–0.8 s.
  - The re-read after a skill or agent change reuses the plugin list it already has.
  - *Still slow:* the inventory *before* a change calls `claude plugin list` (2–3 s, longer while `mcp list` runs).

## D-007 · Settings writes: back up what we read, retry if the file changes (2026-11-01)
- **Found by a test:** the first version copied the file from disk for its backup. When another program (Claude Code) changed the file between our read and our backup, the backup held *their* version rather than the one we were replacing. Backup verification caught it and refused to write, so nothing was lost.
- **Decision:**
  - Back up the exact text we read.
  - Re-read the file just before writing. If it changed, start again on the new content, up to 3 attempts, then give up without writing.
  - Write to a temp file and rename it into place.
- **Known limit:**
  - A tiny window remains between the final re-read and the rename. Closing it fully would need OS-level file locking, which Claude Code doesn't use.
  - The backup covers it: the user can restore the previous version by hand.
- Invalid JSON is never overwritten, because the user or Claude Code may be in the middle of editing it.

## D-006 · Skill identity = folder name; agent identity = frontmatter `name` (2026-11-01)
**Evidence (probe of Claude Code 2.1.314's `init` event, throwaway project):**

| Test | Result |
|---|---|
| Skill at `.claude/skills/ccp-folder-skill/` with frontmatter `name: ccp-front-skill` | Listed as `ccp-folder-skill` |
| `skillOverrides: {"ccp-folder-skill": "off"}` | ✅ removed (611 → 610 skills) |
| `skillOverrides: {"ccp-front-skill": "off"}` | ❌ no effect |
| Agent file `ccp-file-agent.md` with `name: CCP Front Agent` | Listed as `CCP Front Agent` |
| `permissions.deny: ["Agent(CCP Front Agent)"]` | Agent **still listed**, but a real call was **blocked** ("permission rule … blocked it") |
| `skillOverrides` for plugin skill `accessibility` or `ecc:accessibility` | ❌ no effect: plugin skills can't be toggled individually |

**Decision:**
- `skillOverrides` keys use the skill's **folder name**.
- Agent deny rules use the agent's **frontmatter `name`**, falling back to the filename when the frontmatter has no name.
- A denied agent is shown as **"Blocked"** rather than "Off", because Claude still sees it in its list but can't run it.

## D-005 · Verify against Claude Code's own `init` event (2026-11-01)
- `claude -p … --output-format stream-json --verbose` prints an `init` event listing exactly which skills, agents, plugins and MCP servers were loaded.
- The app can read that event and stop the process right away, in about 6–23 s. No model reply is generated.
- **Decision:** offer a **"Verify with Claude Code"** button that compares the app's computed state with what Claude Code actually loaded. It isn't used for the main inventory because it's too slow.
- Hooks are disabled for the probe (`--settings {"disableAllHooks":true}`) so ECC's hooks don't run.
- *Unverified:* whether stopping right after `init` avoids every API call. Watch for cost.

## D-004 · Never spawn `claude` through a shell (2026-11-01)
- During the spike, `spawn(..., {shell: true})` glued the arguments together as raw text and broke the JSON argument.
- On this machine, `claude` resolves to `C:\Users\amiru\.local\bin\claude.exe`. There is also an npm `claude.cmd`.
- **Decision:** call it with `execFile`/`spawn` and an argument array, with no shell (NFR-S6).
- **Fallback:** if `claude` isn't found on PATH, report an error. Don't guess paths.

## D-003 · Stack: Node 24 + native TypeScript + plain browser JS (2026-11-01)
Approved by the user. The reasoning is in [ARCHITECTURE.md §5](ARCHITECTURE.md).

## D-002 · MCP: view and remove only in v1 (2026-11-01)
The documented on/off switch lives in `~/.claude.json`, which Claude Code rewrites all the time, so editing it at the same time is risky. The user chose option (a).

## D-001 · Deletes of standalone items go to a trash folder (2026-11-01)
Chosen by the user. Plugin uninstall and MCP remove use the official CLI and can't be undone from the app.
