// Pure rules: work out an item's effective on/off state from the settings layers.
// See docs/DATA_MODEL.md §4 and docs/DECISIONS.md D-006.

import { PRECEDENCE_HIGH_FIRST, type ItemState, type SettingsLayer, type StateSource } from './types.ts';

export interface Effective {
  state: ItemState;
  source?: StateSource;
}

function byPrecedence(layers: SettingsLayer[]): SettingsLayer[] {
  return [...layers].sort(
    (a, b) => PRECEDENCE_HIGH_FIRST.indexOf(a.level) - PRECEDENCE_HIGH_FIRST.indexOf(b.level),
  );
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Standalone skill: the highest-precedence `skillOverrides[folder]` wins; none means on. */
export function skillState(folder: string, layers: SettingsLayer[]): Effective {
  for (const layer of byPrecedence(layers)) {
    const value = asRecord(layer.data?.skillOverrides)?.[folder];
    if (value === undefined) continue;
    const source = { level: layer.level, file: layer.file, detail: `skillOverrides["${folder}"] = ${JSON.stringify(value)}` };
    if (value === 'off') return { state: 'off', source };
    if (value === 'on') return { state: 'on', source };
    return { state: 'partial', source };
  }
  return { state: 'on' };
}

/**
 * What to write to `targetFile` to turn a skill on. If the other files would leave it on, just remove
 * our entry (cleanest); if a lower-precedence file turns it off (e.g. user settings, while we write a
 * project's settings.local.json), we need an explicit "on" that overrides it for this project only.
 */
export function skillEnableValue(folder: string, layers: SettingsLayer[], targetFile: string): 'on' | undefined {
  return skillState(folder, layers.filter((l) => l.file !== targetFile)).state === 'on' ? undefined : 'on';
}

/** What to write to turn all hooks back on: remove our key if that's enough, else an explicit false. */
export function hooksEnableValue(layers: SettingsLayer[], targetFile: string): false | undefined {
  return hooksDisabled(layers.filter((l) => l.file !== targetFile)).state === 'on' ? undefined : false;
}

/** All deny rules in a layer, as strings. */
export function denyRules(layer: SettingsLayer): string[] {
  const deny = asRecord(layer.data?.permissions)?.deny;
  return Array.isArray(deny) ? deny.filter((r): r is string => typeof r === 'string') : [];
}

/** Rule strings that block the named agent. `Task(...)` is a documented alias of `Agent(...)`. */
export function agentRuleMatches(rule: string, agentName: string): boolean {
  const r = rule.trim();
  return r === 'Agent' || r === 'Task' || r === `Agent(${agentName})` || r === `Task(${agentName})`;
}

/** Standalone agent: deny lists merge across files, so any matching deny blocks it. */
export function agentState(agentName: string, layers: SettingsLayer[]): Effective {
  for (const layer of byPrecedence(layers)) {
    const rule = denyRules(layer).find((r) => agentRuleMatches(r, agentName));
    if (rule) return { state: 'blocked', source: { level: layer.level, file: layer.file, detail: `permissions.deny contains "${rule}"` } };
  }
  return { state: 'on' };
}

/** Hooks master switch: the highest-precedence `disableAllHooks` wins. */
export function hooksDisabled(layers: SettingsLayer[]): Effective {
  for (const layer of byPrecedence(layers)) {
    const value = layer.data?.disableAllHooks;
    if (typeof value !== 'boolean') continue;
    return {
      state: value ? 'off' : 'on',
      source: { level: layer.level, file: layer.file, detail: `disableAllHooks = ${value}` },
    };
  }
  return { state: 'on' };
}
