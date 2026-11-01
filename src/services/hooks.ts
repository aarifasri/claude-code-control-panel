// Hooks as inventory items (view-only: Claude Code can't disable one hook at a time, BR-6),
// plus one "All hooks" item per view that carries the documented disableAllHooks switch.

import { join } from 'node:path';
import type { InstalledPlugin } from '../adapters/cli.ts';
import { readJsonObject } from '../adapters/jsonFile.ts';
import { redactCommandLine } from '../adapters/redact.ts';
import { hooksDisabled } from '../domain/effective.ts';
import { itemId } from '../domain/ids.ts';
import type { Item, Scope, SettingsLayer } from '../domain/types.ts';

interface HookEntry {
  event: string;
  matcher?: string;
  type: string;
  /** Command (secrets masked), URL, or prompt summary. */
  detail: string;
}

/** Flatten `{ Event: [ { matcher, hooks: [ { type, command } ] } ] }`; anything malformed is skipped. */
export function flattenHooks(hooks: unknown): HookEntry[] {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const out: HookEntry[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const { matcher, hooks: handlers } = g as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(handlers)) continue;
      for (const h of handlers) {
        if (!h || typeof h !== 'object') continue;
        const { type, command, url, prompt } = h as Record<string, unknown>;
        const raw = typeof command === 'string' ? command : typeof url === 'string' ? url : typeof prompt === 'string' ? `prompt: ${prompt.slice(0, 120)}` : '';
        out.push({
          event,
          ...(typeof matcher === 'string' && matcher !== '' ? { matcher } : {}),
          type: typeof type === 'string' ? type : 'unknown',
          detail: redactCommandLine(raw.replace(/\s+/g, ' ').trim()).slice(0, 400),
        });
      }
    }
  }
  return out;
}

function toItems(entries: HookEntry[], scope: Scope, origin: Item['origin'], qualifier: string, state: Item['state'], path: string, stateSource: Item['stateSource']): Item[] {
  return entries.map((h, i) => ({
    id: itemId('hook', scope, `${h.event}#${i}`, qualifier),
    kind: 'hook', key: `${h.event}#${i}`,
    name: h.matcher ? `${h.event} (${h.matcher})` : h.event,
    description: h.detail ? `${h.type}: ${h.detail}` : h.type,
    scope, origin, path, state,
    ...(stateSource ? { stateSource } : {}),
    actions: {}, warnings: [],
  }));
}

export async function hookItems(layers: SettingsLayer[], plugins: InstalledPlugin[]): Promise<Item[]> {
  const master = hooksDisabled(layers);
  const allOff = master.state === 'off';
  const items: Item[] = [];

  for (const layer of layers) {
    const entries = flattenHooks(layer.data?.hooks);
    const scope: Scope = layer.level === 'user' ? 'user' : layer.level === 'managed' ? 'managed' : layer.level === 'local' ? 'local' : 'project';
    items.push(...toItems(entries, scope, { type: 'standalone' }, layer.level, allOff ? 'off' : 'on', layer.file, master.source));
  }

  for (const p of plugins) {
    if (!p.installPath) continue;
    const { data } = await readJsonObject(join(p.installPath, 'hooks', 'hooks.json'));
    const entries = flattenHooks(data?.hooks);
    const state = !p.enabled || allOff ? 'off' : 'on';
    const source = !p.enabled ? { level: 'cli' as const, file: 'claude plugin list', detail: `plugin ${p.id} is disabled` } : master.source;
    items.push(...toItems(entries, 'plugin', { type: 'plugin', pluginId: p.id }, p.id, state, join(p.installPath, 'hooks', 'hooks.json'), source));
  }

  // The master switch, shown as its own item so it can carry enable/disable actions.
  items.unshift({
    id: 'hook:master:*', kind: 'hook', key: '*', name: 'All hooks',
    description: `Master switch (disableAllHooks). ${items.length} hook${items.length === 1 ? '' : 's'} in this view, including plugin hooks.`,
    scope: 'user', origin: { type: 'standalone' }, state: master.state,
    ...(master.source ? { stateSource: master.source } : {}),
    actions: {}, warnings: [],
  });
  return items;
}
