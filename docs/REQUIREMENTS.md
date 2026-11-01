# Claude Code Control Panel — Requirements

Status: **Approved scope** (Phase 1) · Date: 2026-11-01

## 1. Problem statement

The user's Claude Code installation has grown large: 18 plugins, ~100 standalone
skills, ~286 standalone agents, ~20 MCP servers, plus hooks — and plugins bring
hundreds more skills/agents of their own. One plugin (ECC) alone adds ~48k tokens
to every session. Today the only way to see or change any of this is a mix of CLI
commands, slash-command menus, and hand-editing JSON/Markdown files.

**Goal:** a local web app that shows everything installed, explains what each item
does and what it costs, and lets the user turn items on/off or delete them safely.

### Goals
- G1. One searchable inventory of plugins, skills, agents, MCP servers, and hooks.
- G2. For each item: what it does (its own description), where it comes from, its scope, and its state.
- G3. Turn items on/off and delete them, using Claude Code's **officially documented** mechanisms.
- G4. Make it hard to break the installation: backups, confirmations, recoverable deletes.
- G5. Show context/token cost so the user can decide what is worth keeping.

### Non-goals (v1)
- Installing new plugins or browsing marketplaces (use `/plugin`).
- Editing skill/agent/hook contents.
- Managing claude.ai connectors (Gmail, Claude Docs…) — those are managed on claude.ai.
- Running on other machines, multi-user use, or hosting online.

## 2. Users and permissions

| Role | Description |
|---|---|
| Owner (single user) | The person logged into this Windows account. Full read/write over their own `~/.claude` and chosen project folders. |

There are no accounts or logins. The app's safety boundary is: **only reachable from
this computer**, and **only callable by the app's own page** (see NFR-S1/S2).

## 3. Scope

### In scope
- Item types: plugins, skills, agents, MCP servers, hooks.
- Scopes: **user** (`~/.claude`) and **project** (a project folder's `.claude/` and `.mcp.json`).
  The user picks the project folder; known projects can be suggested from `~/.claude.json`.
- Actions: view, search/filter, enable, disable, delete (to trash), restore from trash.

### Out of scope (v1)
- Per-hook enable/disable (Claude Code has no official way — see BR-6).
- Disabling a single skill or agent *inside* a plugin (not documented — see BR-3).
- Managed (enterprise policy) settings — shown read-only if present.

## 4. Functional requirements

### Inventory
- **FR-1** List all plugins from `claude plugin list --json`: id, version, scope, enabled, installed date.
- **FR-2** List standalone skills from `~/.claude/skills/*/SKILL.md` and `<project>/.claude/skills/*/SKILL.md`,
  reading `name` and `description` from frontmatter.
- **FR-3** List standalone agents from `~/.claude/agents/*.md` and `<project>/.claude/agents/*.md`,
  reading `name` and `description` from frontmatter.
- **FR-4** List plugin-provided skills, agents, hooks, and MCP servers (from `claude plugin details`),
  grouped under their plugin.
- **FR-5** List MCP servers with health status (from `claude mcp list`), labelled by origin:
  user, project (`.mcp.json`), local, plugin, or claude.ai connector.
- **FR-6** List hooks by event, from settings files and plugins.
- **FR-7** Search by name/description; filter by type, scope, state (on/off), and source plugin.
- **FR-8** Show each plugin's always-on token cost and per-component costs (from `claude plugin details`).
  Also show a total always-on cost across enabled plugins.

### Actions
- **FR-9** Plugin on/off → `claude plugin enable|disable <id> --scope <scope>`.
- **FR-10** Plugin delete → `claude plugin uninstall <id> --scope <scope>` (after confirmation).
- **FR-11** Standalone skill on/off → `skillOverrides: { "<name>": "off" }` in the settings file for that scope.
  Removing the override turns it back on.
- **FR-12** Standalone agent on/off → add/remove `Agent(<name>)` in `permissions.deny` of the settings file for that scope.
- **FR-13** Standalone skill/agent delete → move the file/folder to the app's trash folder, recording
  its original path. **FR-14** Restore moves it back.
- **FR-15** MCP server delete → `claude mcp remove <name> --scope <scope>`.
- **FR-16** MCP server on/off → **not in v1** (decision Q1). The UI says "use `/mcp` in Claude Code to toggle".
- **FR-17** Hooks: global "disable all hooks" switch per scope via `disableAllHooks`. Individual hooks are view-only.
- **FR-18** Items that can't be changed individually (plugin skills/agents, plugin MCP servers, connectors)
  show *why*, and point to the action that does work (e.g. "disable the plugin").
- **FR-19** After any change, show "Restart Claude Code sessions to apply" — changes take effect on new sessions.
- **FR-20** A refresh button reloads the inventory; nothing is cached across app restarts except token costs.

## 5. Non-functional requirements

### Safety and security
- **NFR-S1** Server binds to `127.0.0.1` only — never reachable from the network.
- **NFR-S2** Every write request must carry a random per-run token embedded in the page. This blocks
  other websites in your browser from silently calling the local API (cross-site request forgery).
- **NFR-S3** Before modifying any settings/config file, copy it to a timestamped backup.
- **NFR-S4** Writes to settings files preserve every other key, and are written atomically
  (write temp file, then rename) so a crash can't leave half a file.
- **NFR-S5** Never read or display `.credentials.json`, tokens, API keys, or MCP `env`/header values.
- **NFR-S6** CLI commands are run with argument arrays (no shell string building), and names are
  validated against the inventory, so a crafted name can't inject commands.
- **NFR-S7** Deletes require explicit confirmation; plugin uninstall states it can't be undone from the app.

### Reliability
- **NFR-R1** If a CLI command fails, show its error message; never report success without checking the exit code.
- **NFR-R2** If a file's frontmatter can't be parsed, still list the item with a warning rather than crashing.
- **NFR-R3** Re-read state from disk/CLI after each action, so the UI reflects reality, not assumptions.

### Performance
- **NFR-P1** Inventory loads in under ~5 s for the current installation (~1,000+ items).
  `claude mcp list` health checks and `plugin details` are slow, so they load progressively and cache.

### Accessibility and usability
- **NFR-A1** Keyboard navigable; switches have labels; status is not shown by colour alone.
- **NFR-A2** Plain-language explanations of each scope and action.

### Maintainability
- **NFR-M1** Node.js (already installed, v24), minimal dependencies.
- **NFR-M2** Business rules (what action applies to which item) live in one module, separate from the UI and from file/CLI access, with unit tests.

## 6. Business rules and edge cases

- **BR-1** Prefer the official `claude` CLI over editing files; edit files only where no CLI exists (skills, agents, hooks switch).
- **BR-2** Settings precedence (highest first): managed → `--settings` → project local → project shared → user.
  The app shows the **effective** state and *which file* set it. Example: a skill turned off in user settings but
  on in project-local settings is effectively on in that project.
- **BR-3** Plugin skills and agents cannot be toggled individually in v1 (`skillOverrides` does not apply to plugin
  skills; per-agent deny for plugin agents is undocumented). They are view-only.
- **BR-4** Project-scope writes go to `.claude/settings.local.json` (personal, not committed) by default,
  not the shared `.claude/settings.json` — so toggling doesn't change things for teammates.
- **BR-5** A disabled plugin's components are shown greyed out under it, not hidden.
- **BR-6** Claude Code has no per-hook disable; only `disableAllHooks`. The UI must not imply otherwise.
- **BR-7** Duplicate names (e.g. same skill at user and project scope) are listed separately with their scope.
- **BR-8** Restoring from trash when something with the same name now exists → refuse and explain; never overwrite.
- **BR-9** Claude Code may be running while the app writes settings. The app re-reads the file immediately before
  writing, and warns that running sessions won't pick up changes until restarted.

## 7. Acceptance criteria (key features)

- **AC-1** Opening the app lists all 18 plugins with correct on/off state matching `claude plugin list`.
- **AC-2** Disabling a plugin in the app → `claude plugin list` shows it disabled; re-enabling restores it.
- **AC-3** Turning off a standalone skill adds `skillOverrides.<name> = "off"` to the right settings file, all other
  keys unchanged, and a backup file exists.
- **AC-4** Deleting a standalone agent moves it to trash; it disappears from the list; Restore puts it back byte-identical.
- **AC-5** A request to the write API without the page token is rejected (HTTP 403).
- **AC-6** The server is not reachable from another device on the network.
- **AC-7** ECC shows ~48k always-on tokens, matching `claude plugin details ecc@ecc`.
- **AC-8** A plugin skill shows no toggle and explains "disable the plugin to turn this off".

## 8. Assumptions (verified ✔ / unverified ?)

- ✔ `claude plugin list --json` gives id/version/scope/enabled (checked locally).
- ✔ `enabledPlugins`, `skillOverrides`, `permissions.deny Agent(name)`, `disableAllHooks` are documented
  (code.claude.com docs, checked 2026-11-01).
- ✔ `claude plugin details` prints human-readable text only → the app parses text (fragile across versions).
- ? `claude mcp list` has no JSON output → the app parses text (fragile across versions).
- ? `skillOverrides` key name matches the skill's frontmatter `name` vs folder name — to test in Phase 4.
- ? Whether `Agent(name)` uses the frontmatter `name` (e.g. "Anthropologist") or the filename — to test in Phase 4.
- Assumed: single user, Windows 11, run on demand (not a background service).

## 9. Decisions on earlier open questions

- **Q1 — MCP on/off → decided (a), 2026-11-01:** v1 offers MCP view + delete only. The documented toggle
  lives in `~/.claude.json`, which Claude Code rewrites constantly; editing it concurrently risks conflicts.
  Toggle deferred to a later version.
- **Q2 — Project location → decided, 2026-11-01:** `ARIF PROJECT\claude-control-panel`.
