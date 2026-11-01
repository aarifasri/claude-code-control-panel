# Claude Code Control Panel — Data Model & Contracts

Status: **Phase 4** · Date: 2026-11-01
There is no database. The "data" is Claude Code's own files, read fresh on each request. This doc defines
the in-memory model, where each fact comes from, the API, and the invariants the code must never break.

## 1. Sources of truth

| Fact | Source | Access |
|---|---|---|
| Plugins and their on/off state | `claude plugin list --json` | CLI |
| Plugin contents and token cost | `claude plugin details <id>` (text) | CLI, parsed, cached by id + version |
| Standalone skills | `<root>/skills/<folder>/SKILL.md` frontmatter | File |
| Standalone agents | `<root>/agents/*.md` frontmatter | File |
| Skill on/off | `skillOverrides` in settings files | File |
| Agent blocked | `permissions.deny` entries `Agent(<name>)` in settings files | File |
| Hooks | `hooks` in settings files + the hook list in `plugin details` | File + CLI |
| Hooks master switch | `disableAllHooks` in settings files | File |
| MCP servers and health | `claude mcp list` (text) | CLI, parsed |
| What Claude actually loaded | `init` event (D-005) | CLI, on demand |

`<root>` is `~/.claude` (user) or `<project>/.claude` (project).

Settings files, from lowest to highest precedence:
1. `~/.claude/settings.json` (user)
2. `<project>/.claude/settings.json` (shared project)
3. `<project>/.claude/settings.local.json` (local project)

A managed settings file, if one exists, overrides all three. The app reads it but never writes it.

## 2. Model (TypeScript)

```ts
type Kind = 'plugin' | 'skill' | 'agent' | 'mcp' | 'hook';
type Scope = 'user' | 'project' | 'local' | 'managed' | 'plugin' | 'connector';
type SettingsLevel = 'user' | 'project' | 'local' | 'managed';

interface Item {
  id: string;            // stable + unique, see §3
  kind: Kind;
  key: string;           // the identifier Claude uses (D-006): skill folder, agent name, plugin id, mcp name
  name: string;          // display name
  description: string;   // from frontmatter / plugin manifest; '' if none
  scope: Scope;
  origin: { type: 'standalone' } | { type: 'plugin'; pluginId: string } | { type: 'connector' };
  path?: string;         // shown to the user; NEVER accepted back from the browser
  state: 'on' | 'off' | 'blocked' | 'partial' | 'unknown';
  stateSource?: { level: SettingsLevel; file: string; detail: string }; // "why is it off?"
  actions: Partial<Record<ActionName, ActionAvailability>>;
  cost?: { alwaysOn?: number; onInvoke?: number };
  warnings: string[];    // e.g. "frontmatter could not be parsed"
}

type ActionName = 'enable' | 'disable' | 'delete' | 'restore';
type ActionAvailability = { allowed: true; target: string } | { allowed: false; reason: string };

interface TrashEntry {
  id: string; kind: 'skill' | 'agent'; key: string;
  originalPath: string; trashedPath: string; trashedAt: string; // ISO
}
```

`partial` covers skill overrides that aren't simply on or off: `"name-only"` or `"user-invocable-only"`.

## 3. Item IDs

`<kind>:<scope>[:<project-hash>]:<key>`. Examples:
- `plugin:user:ecc@ecc`
- `skill:user:ccp-folder-skill`
- `skill:project:a1b2c3:my-skill`
- `skill:plugin:ecc@ecc:accessibility`
- `agent:user:Anthropologist`
- `mcp:plugin:ecc@ecc:chrome-devtools`

The server keeps a map from id to Item for each inventory build. Actions find their item by id in a **fresh** inventory.

## 4. Rules: effective state and allowed actions

Each rule gets a unit test.

| Kind / origin | Effective state | enable / disable writes to | delete |
|---|---|---|---|
| Plugin | `enabled` from the CLI | `claude plugin enable\|disable <id> --scope <its scope>` | `claude plugin uninstall <id> --scope <its scope>` |
| Standalone skill | The highest-precedence `skillOverrides[folder]`. If none is set, it's `on` | The **target file** (see below): set or remove `skillOverrides[folder]` | Move the folder to trash |
| Standalone agent | `blocked` if **any** settings file denies `Agent(name)`, since deny lists merge. Otherwise `on` | Disable: add the deny rule to the target file. Enable: remove it from **every writable** file that has it. If a managed file has it, enable isn't allowed | Move the file to trash |
| Plugin skill / agent / hook / MCP | Same as its plugin | Not allowed: "Part of plugin X — disable the plugin instead" | Not allowed |
| User / project MCP | Health from `mcp list` | Not allowed in v1 (D-002): "Use /mcp in Claude Code" | `claude mcp remove <name> --scope <scope>` |
| claude.ai connector | Health from `mcp list` | Not allowed: "Managed on claude.ai" | Not allowed |
| Standalone hook | Off if the highest-precedence `disableAllHooks` is true | Not allowed one at a time (BR-6) | Not allowed |
| Hooks master switch | `disableAllHooks` | The target file | — |

**Target file:**
- In **User view**, the target is `~/.claude/settings.json`.
- In **Project view**, the target is `<project>/.claude/settings.local.json`. It's personal and not committed (BR-4).
- If a higher-precedence file would cancel the change, the result includes a warning naming that file, as in flow F4's alternate path.

## 5. API contract

All responses are JSON. Errors look like `{ "error": { "code": string, "message": string } }`.

**Read endpoints**

| Request | Response |
|---|---|
| `GET /api/inventory?project=<abs path>` (optional) | `{ items: Item[], projects: string[], generatedAt }` |
| `GET /api/costs` | `{ [pluginId]: { alwaysOn, components: {name, alwaysOn, onInvoke}[] } }` |
| `GET /api/mcp-health` | `{ [itemId]: { status: 'connected'\|'needs-auth'\|'failed'\|'not-configured'\|'unknown', raw } }` |
| `GET /api/trash` | `{ entries: TrashEntry[] }` |
| `POST /api/verify` `{ project? }` | `{ mismatches: { itemId, app, claude }[] }` (slow) |

**Change endpoint**

`POST /api/actions`, with header `X-CCP-Token`.

Request body:
```json
{ "itemId": "...", "action": "enable|disable|delete|restore", "project": "<abs path>|null", "confirm": true }
```

Responses:
- `200 { item: Item | null, backup?: string, warnings: string[], restartNeeded: true }`
- `400 invalid-request`: bad body, or `confirm` is missing for a delete
- `403 bad-token`, or the origin or host isn't allowed
- `404 unknown-item`: the item isn't in the fresh inventory
- `409 not-allowed`: the reason comes from the rules
- `409 restore-conflict`: something already exists at the original path
- `500 action-failed`: includes the CLI or file error message
- `423 busy`: another action is still running

**Validation:**
- The body may be at most 4 KB.
- `itemId` must exist in the inventory.
- `action` must be one of the four listed.
- `project` must be one of the known projects or a folder that exists, and it's resolved to an absolute path.

## 6. Invariants

These must always hold, and tests enforce them:

1. **I1 · Backup first.** No settings file changes unless a backup copy was written and confirmed first.
2. **I2 · Write allow-list.**
   - Files the app writes: `~/.claude/settings.json`, `<project>/.claude/settings.local.json`, and files under `~/.claude-control-panel/`.
   - Moves happen only between `<root>/skills/*` or `<root>/agents/*.md` and the trash folder.
   - Every other path is refused, even if a bug asks for it.
3. **I3 · No paths from the browser.** File paths come only from the server's own inventory.
4. **I4 · Keep other settings.** Changing one setting keeps every other key and value identical. JSON is written back with 2-space indents and a trailing newline.
5. **I5 · Whole-file writes.** The new content goes to a temp file next to the original, which is then renamed into place. The file is re-read just before writing, so changes Claude Code made a moment earlier aren't lost.
6. **I6 · No secrets out.** No response contains `.credentials.json` content, `env`, `headers`, or token-like values.
7. **I7 · One action at a time.** A server-side lock makes concurrent actions wait or get `423`.
8. **I8 · Report real results.** Every action result comes from state re-read after the change. A CLI exit code other than 0 means failure.
9. **I9 · Safe restore.** Restore never overwrites anything.

## 7. App-owned storage

```
~/.claude-control-panel/
  trash/<ISO-time>__<kind>__<key>/   moved skill folder or agent file
  trash/manifest.json                TrashEntry[]
  backups/<file-label>.<ISO-time>.json   last 50 kept
  cache/costs.json                   keyed by plugin id + version
  actions.log                        one JSON line per action
```
