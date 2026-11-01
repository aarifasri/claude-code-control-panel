# Decisions

Short records of decisions and the evidence behind them. Newest first.

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
