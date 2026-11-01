// Core data model. See docs/DATA_MODEL.md §2.

export type Kind = 'plugin' | 'skill' | 'agent' | 'mcp' | 'hook';

// 'synced' = plugin synced from claude.ai; 'connector' = claude.ai MCP connector.
export type Scope = 'user' | 'project' | 'local' | 'managed' | 'plugin' | 'synced' | 'connector';

// Settings files, lowest precedence first.
export type SettingsLevel = 'user' | 'project' | 'local' | 'managed';
export const PRECEDENCE_HIGH_FIRST: readonly SettingsLevel[] = ['managed', 'local', 'project', 'user'];

export type ItemState = 'on' | 'off' | 'blocked' | 'partial' | 'unknown';

export type Origin =
  | { type: 'standalone' }
  | { type: 'plugin'; pluginId: string }
  | { type: 'connector' };

export type ActionName = 'enable' | 'disable' | 'delete' | 'restore';

export type ActionAvailability =
  | { allowed: true; target: string }
  | { allowed: false; reason: string };

export interface StateSource {
  level: SettingsLevel | 'cli';
  file: string;
  detail: string;
}

export interface Item {
  id: string;
  kind: Kind;
  /** Identifier Claude Code uses: skill folder, agent frontmatter name, plugin id, MCP name (D-006). */
  key: string;
  name: string;
  description: string;
  /** e.g. 'command' for a slash-command file listed under skills. */
  variant?: string;
  scope: Scope;
  origin: Origin;
  /** Display only. Never accepted back from the browser (invariant I3). */
  path?: string;
  state: ItemState;
  stateSource?: StateSource;
  actions: Partial<Record<ActionName, ActionAvailability>>;
  cost?: { alwaysOn?: number; onInvoke?: number };
  warnings: string[];
  /** Plugins only: counts of what they contain. */
  contents?: { skills: number; agents: number; commands: number };
}

/** One parsed settings file. `data` is null when the file is missing. */
export interface SettingsLayer {
  level: SettingsLevel;
  file: string;
  data: Record<string, unknown> | null;
  error?: string;
}
