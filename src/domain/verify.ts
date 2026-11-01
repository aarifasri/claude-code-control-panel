// Compare what the app computed with what Claude Code says it actually loaded (D-005). Pure.

import type { Item } from './types.ts';

export interface LoadedByClaude {
  skills: string[];
  slash_commands: string[];
  agents: string[];
  plugins: { source: string }[];
}

export interface Mismatch {
  itemId: string | null;
  kind: Item['kind'];
  name: string;
  /** What the app shows. */
  app: string;
  /** What Claude Code did. */
  claude: string;
}

export interface VerifyReport {
  checked: { plugins: number; skills: number; agents: number };
  mismatches: Mismatch[];
  /** Skills with `user-invocable: false`: loaded for Claude but absent from the init list, so not checkable. */
  uncheckedSkills: number;
  /** Claude Code's own internal plugins ("…@builtin"), which `claude plugin list` doesn't show. */
  builtinPlugins: string[];
}

/** The name Claude Code uses for a skill, command or agent: plugin items are prefixed "plugin:". */
function claudeName(item: Item): string {
  if (item.origin.type !== 'plugin') return item.key;
  const plugin = item.origin.pluginId.split('@')[0] ?? item.origin.pluginId;
  return item.kind === 'agent' ? `${plugin}:${item.key}` : item.key; // plugin skill keys already carry the prefix
}

export function compareWithInit(items: Item[], loaded: LoadedByClaude): VerifyReport {
  const mismatches: Mismatch[] = [];
  const skillNames = new Set([...loaded.skills, ...loaded.slash_commands]);
  const agentNames = new Set(loaded.agents);
  const pluginIds = new Set(loaded.plugins.map((p) => p.source));
  const checked = { plugins: 0, skills: 0, agents: 0 };
  let uncheckedSkills = 0;

  for (const item of items) {
    if (item.kind === 'plugin') {
      checked.plugins++;
      const isLoaded = pluginIds.has(item.key);
      if (item.state === 'on' && !isLoaded) mismatches.push({ itemId: item.id, kind: 'plugin', name: item.name, app: 'on', claude: 'not loaded' });
      if (item.state === 'off' && isLoaded) mismatches.push({ itemId: item.id, kind: 'plugin', name: item.name, app: 'off', claude: 'loaded' });
      pluginIds.delete(item.key);
    } else if (item.kind === 'skill' && item.hiddenFromMenu) {
      uncheckedSkills++;
    } else if (item.kind === 'skill' && (item.state === 'on' || item.state === 'off')) {
      checked.skills++;
      const isLoaded = skillNames.has(claudeName(item));
      if (item.state === 'on' && !isLoaded) mismatches.push({ itemId: item.id, kind: 'skill', name: item.name, app: 'on', claude: 'not loaded' });
      if (item.state === 'off' && isLoaded) mismatches.push({ itemId: item.id, kind: 'skill', name: item.name, app: 'off', claude: 'loaded' });
    } else if (item.kind === 'agent' && item.state !== 'off') {
      // Blocked agents stay listed (D-006), so only presence of non-off agents can be checked.
      checked.agents++;
      if (!agentNames.has(claudeName(item))) mismatches.push({ itemId: item.id, kind: 'agent', name: item.name, app: item.state, claude: 'not listed' });
    }
  }
  const builtinPlugins: string[] = [];
  for (const source of pluginIds) {
    if (source.endsWith('@builtin')) builtinPlugins.push(source);
    else mismatches.push({ itemId: null, kind: 'plugin', name: source, app: 'not in the list', claude: 'loaded' });
  }
  return { checked, mismatches, uncheckedSkills, builtinPlugins };
}
