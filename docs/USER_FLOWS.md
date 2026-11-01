# Claude Code Control Panel — User Flows & Screens

Status: **Draft for review** (Phase 2) · Date: 2026-11-01 · Based on [REQUIREMENTS.md](REQUIREMENTS.md)

## 1. Main user journeys

### F1. Start the app and see the inventory
1. User runs `npm start` in `claude-control-panel` (later: a desktop shortcut).
2. App prints `Open http://127.0.0.1:4317` and opens the browser.
3. Page loads plugins, skills, agents and hooks first (fast, from disk and `plugin list --json`).
4. MCP health and token costs fill in progressively (slow CLI calls) with "checking…" placeholders.

*Failure:* `claude` not on PATH → full-page error with the fix ("install Claude Code / reopen terminal").
*Failure:* port in use → app tries the next port and prints it.

### F2. Find out what something does
1. User types in search, e.g. "review".
2. List filters across all types (name + description match).
3. User clicks an item → detail panel: description, type, source (standalone / plugin X), scope,
   file path, effective state + *which settings file decided it*, token cost (if known).

### F3. Turn a plugin off (the main token-saving flow)
1. Plugins tab, sorted by always-on token cost (biggest first).
2. User flips ECC's switch off.
3. Switch shows a spinner → app runs `claude plugin disable ecc@ecc --scope user`.
4. Success → switch off, toast: "ECC disabled. Restart Claude Code sessions to apply." Total-cost bar updates.
5. Failure → switch flips back, error shown with the CLI's message.

### F4. Turn a standalone skill or agent off/on
1. Skills (or Agents) tab → flip switch.
2. App backs up the settings file, then writes `skillOverrides` (skill) or a `permissions.deny Agent(...)` rule (agent).
3. Re-reads state from disk → confirms change → toast with backup location.

*Alternate:* item is effectively controlled by a higher-precedence file (e.g. project-local says "on") →
detail panel explains: "Your change was saved in user settings, but `<project>/.claude/settings.local.json`
overrides it." Offer to change it there instead.

### F5. Delete a standalone skill/agent → Trash → Restore
1. User clicks Delete → confirm dialog names the exact path.
2. App moves it to the trash folder; item disappears; toast with **Undo**.
3. Trash tab lists deleted items with original path and date → **Restore**.

*Failure:* restore target now exists → refuse, explain, keep in trash (BR-8).

### F6. Uninstall a plugin / remove an MCP server
1. User clicks Delete → stronger confirm: "This cannot be undone from this app. You can reinstall with /plugin."
2. App runs `claude plugin uninstall` / `claude mcp remove` with the item's scope.
3. Inventory refreshes.

### F7. Switch to a project scope
1. Scope picker at top: **User (all projects)** ▾ — dropdown lists known projects (from `~/.claude.json`) + "Choose folder…".
2. Selecting a project shows user-scope items **plus** that project's items, each tagged with its scope.
3. Toggles made in project scope write to `<project>/.claude/settings.local.json` (personal, not committed).

### F8. Disable all hooks
1. Hooks tab shows each hook (event, matcher, command, source) read-only.
2. One switch: "Run hooks" for the current scope → writes `disableAllHooks`.
3. Banner explains Claude Code cannot disable individual hooks.

## 2. Screens

| Screen | Purpose |
|---|---|
| Main inventory (tabs: Overview · Plugins · Skills · Agents · MCP · Hooks · Trash) | Browse, search, toggle |
| Detail panel (right side, or full screen on narrow windows) | What it does, where it lives, why it's on/off |
| Confirm dialog | Delete / uninstall confirmation |
| Toasts | Success, undo, errors |
| Startup error page | `claude` CLI missing or unreadable `~/.claude` |

## 3. Low-fidelity wireframe

Numbers below are illustrative except ECC's ~48k, which was measured.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Claude Code Control Panel        Scope: [User (all projects) ▾]  [⟳]     │
│ Always-on context: ~71k tokens across 15 enabled plugins  ▓▓▓▓▓▓░░░░     │
├──────────────────────────────────────────────────────────────────────────┤
│ Overview  Plugins(18)  Skills(100)  Agents(286)  MCP(20)  Hooks  Trash   │
│ [🔍 search name or description........]  State:[All▾] Source:[All▾]       │
├───────────────────────────────────────────────┬──────────────────────────┤
│ ● ON   ecc@ecc            v2.2.3  user  ~48k  │ ecc@ecc                  │
│        412 skills · 71 agents · 8 hooks       │ Harness-native ECC       │
│ ● ON   superpowers@...    v5.x    user  ~3k   │ operator layer – 71      │
│ ○ OFF  claude-ads@...     v2.0.2  user  ~6k   │ agents, 314 skills…      │
│ ...                                           │                          │
│                                               │ State: ON (user settings)│
│                                               │ Cost: ~48,079 always-on  │
│                                               │ [ Disable ] [ Uninstall ]│
│                                               │ ▸ Skills (412) view-only │
└───────────────────────────────────────────────┴──────────────────────────┘
```

Switch states: `● ON` / `○ OFF` / `◌ working…` / `⊘ view-only (reason on hover/focus)` — always text + icon, never colour only.

## 4. States checklist

| State | Behaviour |
|---|---|
| Loading | Skeleton rows; slow columns show "checking…" |
| Empty | Per tab, e.g. "No standalone agents in this scope" + what that means |
| Search no results | "No matches for 'x'" + clear-search button |
| Validation | Unknown item / stale state → "This changed outside the app — refreshed" |
| Error | Inline on the row + toast with CLI/file error text; switch reverts |
| Success | Toast + "Restart Claude Code to apply" reminder (persistent dot until dismissed) |
| View-only | Disabled switch with reason, e.g. "Part of plugin ecc — disable the plugin instead" |
| Responsive | < 900 px: detail panel becomes full screen; table becomes cards |
| Accessibility | Tab/Enter/Space work everywhere; switches are `role="switch"` with `aria-checked`; focus returns after dialogs; toasts announced via `aria-live` |
