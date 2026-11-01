// Build the full inventory: plugins (and what they contain), standalone skills, commands and agents.
// Read-only. Actions are added in later milestones (docs/IMPLEMENTATION_PLAN.md).

import { join } from 'node:path';
import { readAgents, readCommands, readSkills, type FoundComponent } from '../adapters/claudeDir.ts';
import { listPlugins, type ClaudeCli, type InstalledPlugin } from '../adapters/cli.ts';
import { readJsonObject } from '../adapters/jsonFile.ts';
import { hookItems } from './hooks.ts';
import { agentState, skillState } from '../domain/effective.ts';
import { itemId, projectHash } from '../domain/ids.ts';
import { isAllowedSettingsFile, projectLocalSettingsPath, userSettingsPath } from '../domain/paths.ts';
import { actionsFor } from '../domain/rules.ts';
import type { Item, Scope, SettingsLayer, SettingsLevel } from '../domain/types.ts';

export interface InventoryOptions {
  /** The user's home folder; `~/.claude` lives inside it. */
  home: string;
  /** Absolute project folder, when viewing a project. */
  project?: string;
  cli: ClaudeCli;
  /** Managed (enterprise) settings file, if any. Read-only. */
  managedSettingsPath?: string;
  /** Reuse an already-fetched plugin list (skips the slow `claude plugin list` call). */
  plugins?: InstalledPlugin[];
}

export interface Inventory {
  items: Item[];
  layers: SettingsLayer[];
  plugins: InstalledPlugin[];
  generatedAt: string;
}

async function layer(level: SettingsLevel, file: string): Promise<SettingsLayer> {
  const { data, error } = await readJsonObject(file);
  return error ? { level, file, data, error } : { level, file, data };
}

export async function readLayers(opts: InventoryOptions): Promise<SettingsLayer[]> {
  const layers = [await layer('user', join(opts.home, '.claude', 'settings.json'))];
  if (opts.project) {
    layers.push(await layer('project', join(opts.project, '.claude', 'settings.json')));
    layers.push(await layer('local', join(opts.project, '.claude', 'settings.local.json')));
  }
  if (opts.managedSettingsPath) {
    const managed = await layer('managed', opts.managedSettingsPath);
    if (managed.data || managed.error) layers.push(managed);
  }
  return layers;
}

function standaloneItems(
  scope: Scope,
  qualifier: string | undefined,
  found: { skills: FoundComponent[]; commands: FoundComponent[]; agents: FoundComponent[] },
  layers: SettingsLayer[],
): Item[] {
  const items: Item[] = [];
  const skillLike = [
    ...found.skills.map((c) => ({ c, variant: undefined })),
    ...found.commands.map((c) => ({ c, variant: 'command' })),
  ];
  for (const { c, variant } of skillLike) {
    const eff = skillState(c.key, layers);
    items.push({
      id: itemId(variant === 'command' ? 'command' : 'skill', scope, c.key, qualifier), kind: 'skill', key: c.key, name: c.name,
      description: c.description, ...(variant ? { variant } : {}), scope, origin: { type: 'standalone' }, path: c.path,
      state: eff.state, ...(eff.source ? { stateSource: eff.source } : {}), actions: {}, warnings: c.warnings,
    });
  }
  for (const c of found.agents) {
    const eff = agentState(c.key, layers);
    items.push({
      id: itemId('agent', scope, c.key, qualifier), kind: 'agent', key: c.key, name: c.name, description: c.description,
      scope, origin: { type: 'standalone' }, path: c.path,
      state: eff.state, ...(eff.source ? { stateSource: eff.source } : {}), actions: {}, warnings: c.warnings,
    });
  }
  return items;
}

async function readRoot(root: string) {
  const [skills, commands, agents] = await Promise.all([
    readSkills([join(root, 'skills')]),
    readCommands([join(root, 'commands')]),
    readAgents([join(root, 'agents')]),
  ]);
  return { skills, commands, agents };
}

/** Manifest path fields may be a string or an array of strings, relative to the plugin root. */
function manifestPaths(value: unknown, base: string): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  return list.map((p) => join(base, p));
}

async function pluginItems(p: InstalledPlugin): Promise<Item[]> {
  const pluginName = p.id.split('@')[0] ?? p.id;
  const scope: Scope = p.scope === 'synced' ? 'synced' : p.scope === 'project' ? 'project' : p.scope === 'local' ? 'local' : 'user';
  const warnings: string[] = [];
  const manifest = p.installPath ? await readJsonObject(join(p.installPath, '.claude-plugin', 'plugin.json')) : { data: null, error: 'no install path' };
  if (manifest.error) warnings.push(`plugin.json: ${manifest.error}`);
  const m = manifest.data ?? {};

  // Default component folders, plus any custom paths the manifest declares.
  const base = p.installPath;
  const [skills, commands, agents] = base
    ? await Promise.all([
        readSkills([join(base, 'skills'), ...manifestPaths(m.skills, base)]),
        readCommands([join(base, 'commands'), ...manifestPaths(m.commands, base)]),
        readAgents([join(base, 'agents'), ...manifestPaths(m.agents, base)]),
      ])
    : [[], [], []];

  const componentState = p.enabled ? 'on' : 'off';
  const cliSource = { level: 'cli' as const, file: 'claude plugin list', detail: `plugin ${p.id} is ${p.enabled ? 'enabled' : 'disabled'}` };
  const plugin: Item = {
    id: itemId('plugin', scope, p.id), kind: 'plugin', key: p.id, name: typeof m.name === 'string' ? m.name : pluginName,
    description: typeof m.description === 'string' ? m.description : '', scope, origin: { type: 'standalone' }, path: p.installPath,
    state: componentState, stateSource: cliSource, actions: {}, warnings,
    contents: { skills: skills.length, agents: agents.length, commands: commands.length },
  };

  const children: Item[] = [];
  const add = (kind: 'skill' | 'agent', c: FoundComponent, variant?: string) => {
    const key = kind === 'skill' ? `${pluginName}:${c.key}` : c.key;
    children.push({
      id: itemId(variant === 'command' ? 'command' : kind, 'plugin', key, p.id), kind, key, name: c.name, description: c.description,
      ...(variant ? { variant } : {}), scope: 'plugin', origin: { type: 'plugin', pluginId: p.id }, path: c.path,
      state: componentState, stateSource: cliSource, actions: {}, warnings: c.warnings,
    });
  };
  skills.forEach((c) => add('skill', c));
  commands.forEach((c) => add('skill', c, 'command'));
  agents.forEach((c) => add('agent', c));
  return [plugin, ...children];
}

export async function buildInventory(opts: InventoryOptions): Promise<Inventory> {
  const layers = await readLayers(opts);
  const [plugins, userRoot, projectRoot] = await Promise.all([
    // Run in the project folder so `enabled` reflects that project's local settings too.
    opts.plugins ? Promise.resolve(opts.plugins) : listPlugins(opts.cli, opts.project),
    readRoot(join(opts.home, '.claude')),
    opts.project ? readRoot(join(opts.project, '.claude')) : Promise.resolve(undefined),
  ]);

  const items: Item[] = [];
  // In user view only user (+managed) settings apply; in project view all layers apply.
  items.push(...standaloneItems('user', undefined, userRoot, layers));
  if (opts.project && projectRoot) {
    items.push(...standaloneItems('project', projectHash(opts.project), projectRoot, layers));
  }
  for (const list of await Promise.all(plugins.map(pluginItems))) items.push(...list);
  items.push(...(await hookItems(layers, plugins)));

  // User view writes ~/.claude/settings.json; project view writes the project's personal
  // settings.local.json, so a change affects only that project (BR-4).
  const writeScope = { home: opts.home, appDir: join(opts.home, '.claude-control-panel'), projects: opts.project ? [opts.project] : [] };
  const ctx = {
    layers,
    targetFile: opts.project ? projectLocalSettingsPath(opts.project) : userSettingsPath(opts.home),
    isWritable: (f: string) => isAllowedSettingsFile(f, writeScope),
    ...(opts.project ? { project: opts.project } : {}),
  };
  for (const item of items) item.actions = actionsFor(item, ctx);

  return { items, layers, plugins, generatedAt: new Date().toISOString() };
}
