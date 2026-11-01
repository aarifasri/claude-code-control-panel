# Claude Code Control Panel

A local web app to see and manage what's installed in Claude Code (plugins, skills, agents, MCP servers,
hooks): what each item does, what it costs, and turning items on, off or deleting them safely.

## Run, test, check
- `npm start`: serves http://127.0.0.1:4317 (moves to the next port if that one is busy)
- `npm test`: runs `node:test` over `test/**/*.test.ts`
- `npm run typecheck`: `tsc --noEmit`
- Node 24 runs `.ts` directly with no build step, so imports use `.ts` extensions and only erasable TypeScript syntax is allowed (no enums, no parameter properties)

## Layout
- `src/domain/`: pure rules and types, no input/output. Effective-state precedence lives in `effective.ts`.
- `src/adapters/`: the only code that touches files or the `claude` CLI
- `src/services/`: combines adapters and domain (`inventory.ts`)
- `src/server.ts`: HTTP server and API
- `public/`: plain browser JS, no framework

## Invariants (see docs/DATA_MODEL.md §6)
- Bind to 127.0.0.1 and check the `Host` header. Every write needs the page token (M3).
- Never run `claude` through a shell. Use `execFile` with an argument array (D-004).
- Never take file paths from the browser. Look items up by id in a fresh inventory.
- Back up before any settings write, write atomically, and keep unrelated keys.
- Third-party text (descriptions) goes into the page with `textContent` only, never `innerHTML`.
- Tests use temp-folder fake homes and a fake CLI. Never touch the real `~/.claude`.

## Verified facts (docs/DECISIONS.md)
- `skillOverrides` keys are skill **folder names**. Plugin skills can't be overridden.
- `permissions.deny Agent(<frontmatter name>)` blocks an agent, but it stays listed.
- A plugin can ship a skill and a command with the same name, so commands get their own id prefix.

## Docs
[Requirements](docs/REQUIREMENTS.md) · [User flows](docs/USER_FLOWS.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Data model](docs/DATA_MODEL.md) · [Decisions](docs/DECISIONS.md) · [Plan](docs/IMPLEMENTATION_PLAN.md)

## Slow sources
- `/api/costs` runs `claude plugin details` for each plugin: about 21 s cold. It's cached in `~/.claude-control-panel/cache/costs.json` by plugin id + version.
- `/api/mcp` runs `claude mcp list`, which health-checks every server: about 45 s.
- The page shows the inventory first and fills these in when they arrive.
- Their text output is parsed against real samples in `test/fixtures/`. If Claude Code changes the format, recapture the samples and rerun the tests.
- `~/.claude.json` is only ever read for **names** (MCP scopes, known projects), never values.

## Write path (M3)
- `src/app.ts` holds the request handler and security checks. `src/server.ts` only starts it.
- Every POST needs:
  - an `Origin` header from our own host
  - `Content-Type: application/json`
  - the `X-CCP-Token` header, matching the per-run token the server puts in a `<meta>` tag of index.html
- `src/adapters/settingsFile.ts` → `updateSettingsFile()` is the **only** function that writes settings. Its steps: check the allow-list (`src/domain/paths.ts`), back up the text it read, re-read and retry if the file changed, then write atomically.
- `ActionLock` allows one action at a time. A second request gets 423.
- `POST /api/actions` validates the request, looks the item up in a fresh inventory, then hands it to `executeAction()` (`src/services/actions.ts`). That function writes through `updateSettingsFile()`, re-reads, warns if another file overrides the change, and appends to `~/.claude-control-panel/actions.log`.
- `src/domain/rules.ts` decides which actions each item allows and why not. `src/domain/mutations.ts` holds the exact JSON edits. Both are pure.

## Plugins (M5, D-009)
- User-scope plugins only: `claude plugin enable|disable|uninstall --scope user --json`. Uninstall adds `--keep-data`.
- `SAFE_PLUGIN_ID` guards against ids that would be read as CLI flags.
- `backupSettingsFile()` runs before every plugin command, because the CLI writes `settings.json` itself.
- Claude Code's writer may reorder top-level keys. The content stays deep-equal.

## Current status
M0–M5 are done: skills, commands, agents and user-scope plugins can all be switched from the page. **Next: M6**, a trash folder for deleting standalone skills and agents, with restore.
