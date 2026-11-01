// Carry out an allowed action, then report the state re-read from disk (invariant I8).

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeCli } from '../adapters/cli.ts';
import { backupSettingsFile, updateSettingsFile, type JsonObject } from '../adapters/settingsFile.ts';
import { SAFE_PLUGIN_ID } from '../domain/rules.ts';
import { agentRuleMatches, denyRules } from '../domain/effective.ts';
import { projectHash } from '../domain/ids.ts';
import { moveToTrash, restoreFromTrash, type TrashEntry, type TrashKind, type TrashOptions } from '../adapters/trash.ts';
import { isAllowedSettingsFile, isTrashableSource, userSettingsPath, type WriteScope } from '../domain/paths.ts';
import { addAgentDeny, removeAgentDeny, setSkillOverride } from '../domain/mutations.ts';
import type { ActionName, Item, ItemState } from '../domain/types.ts';
import type { Inventory } from './inventory.ts';

export interface ActionDeps {
  cli: ClaudeCli;
  home: string;
  appDir: string;
  projects: string[];
  /** Fresh inventory, used after the change to report the real result. */
  inventory: () => Promise<Inventory>;
}

export interface ActionResult {
  item: Item | null;
  backups: string[];
  warnings: string[];
  restartNeeded: boolean;
  /** Set when the item was moved to the trash; its id restores it. */
  trashEntry?: TrashEntry;
}

export function trashOptions(deps: Pick<ActionDeps, 'home' | 'appDir' | 'projects'>): TrashOptions {
  const scope: WriteScope = { home: deps.home, appDir: deps.appDir, projects: deps.projects };
  return { trashDir: join(deps.appDir, 'trash'), isAllowedSource: (p, kind) => isTrashableSource(p, kind, scope) };
}

function trashKind(item: Item): TrashKind {
  return item.variant === 'command' ? 'command' : item.kind === 'agent' ? 'agent' : 'skill';
}

export class ActionFailed extends Error {}

function backupLabel(file: string, deps: ActionDeps): string {
  if (file === userSettingsPath(deps.home)) return 'user-settings';
  const project = deps.projects.find((p) => file.startsWith(p));
  return project ? `project-${projectHash(project)}-settings.local` : 'settings';
}

function writeOptions(file: string, deps: ActionDeps) {
  const scope: WriteScope = { home: deps.home, appDir: deps.appDir, projects: deps.projects };
  return { isAllowed: (p: string) => isAllowedSettingsFile(p, scope), backupDir: join(deps.appDir, 'backups'), label: backupLabel(file, deps) };
}

async function writeSettings(file: string, mutate: (d: JsonObject) => void, deps: ActionDeps): Promise<string | undefined> {
  return (await updateSettingsFile(file, mutate, writeOptions(file, deps))).backup;
}

/** The settings file the CLI changes for a plugin in this scope. */
function pluginSettingsFile(item: Item, deps: ActionDeps): string | undefined {
  if (item.scope === 'user') return userSettingsPath(deps.home);
  // Local-scope plugins live in a project's settings.local.json; project view arrives in M7.
  return undefined;
}

/**
 * Run `claude plugin enable|disable|uninstall` for an installed plugin. The CLI edits the settings
 * file itself, so we back that file up first (I1). Returns the backup path, if one was made.
 */
async function pluginCommand(item: Item, action: ActionName, deps: ActionDeps): Promise<string | undefined> {
  // Re-checked here as well as in rules.ts: this is the last line before the id reaches the CLI.
  if (!SAFE_PLUGIN_ID.test(item.key)) throw new ActionFailed(`Unexpected plugin id "${item.key}"`);
  const verb = action === 'delete' ? 'uninstall' : action;
  if (verb !== 'enable' && verb !== 'disable' && verb !== 'uninstall') throw new ActionFailed(`"${action}" isn't available for plugins.`);
  const file = pluginSettingsFile(item, deps);
  if (!file) throw new ActionFailed(`Changing ${item.scope}-scope plugins arrives with project view (M7).`);
  const backup = await backupSettingsFile(file, writeOptions(file, deps));
  const args = ['plugin', verb, item.key, '--scope', item.scope, '--json', ...(verb === 'uninstall' ? ['--keep-data'] : [])];
  const res = await deps.cli.run(args, 120_000);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400);
    throw new ActionFailed(`claude plugin ${verb} failed (exit ${res.code}): ${detail}`);
  }
  return backup;
}

async function log(deps: ActionDeps, entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(deps.appDir, { recursive: true });
    await appendFile(join(deps.appDir, 'actions.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Logging must never turn a successful change into a reported failure.
  }
}

const EXPECTED: Partial<Record<ActionName, Partial<Record<Item['kind'], ItemState>>>> = {
  enable: { skill: 'on', agent: 'on', plugin: 'on' },
  disable: { skill: 'off', agent: 'blocked', plugin: 'off' },
};

export async function executeAction(item: Item, action: ActionName, inv: Inventory, deps: ActionDeps): Promise<ActionResult> {
  const availability = item.actions[action];
  if (!availability?.allowed) throw new ActionFailed(availability?.reason ?? 'Not allowed');
  const backups: string[] = [];
  let trashEntry: TrashEntry | undefined;

  try {
    if (action === 'delete' && (item.kind === 'skill' || item.kind === 'agent')) {
      if (!item.path) throw new ActionFailed('No file location known for this item.');
      trashEntry = await moveToTrash({ kind: trashKind(item), key: item.key, name: item.name, itemId: item.id, path: item.path }, trashOptions(deps));
    } else if (item.kind === 'plugin') {
      const b = await pluginCommand(item, action, deps);
      if (b) backups.push(b);
    } else if (item.kind === 'skill' && (action === 'enable' || action === 'disable')) {
      const b = await writeSettings(availability.target, (d) => setSkillOverride(d, item.key, action === 'disable' ? 'off' : undefined), deps);
      if (b) backups.push(b);
    } else if (item.kind === 'agent' && action === 'disable') {
      const b = await writeSettings(availability.target, (d) => addAgentDeny(d, item.key), deps);
      if (b) backups.push(b);
    } else if (item.kind === 'agent' && action === 'enable') {
      // Remove the rule from every file that has it; deny lists merge, so one leftover keeps it blocked.
      const files = inv.layers.filter((l) => denyRules(l).some((r) => agentRuleMatches(r, item.key))).map((l) => l.file);
      for (const f of files) {
        const b = await writeSettings(f, (d) => removeAgentDeny(d, item.key), deps);
        if (b) backups.push(b);
      }
    } else {
      throw new ActionFailed(`"${action}" isn't implemented for ${item.kind} items yet.`);
    }
  } catch (e) {
    await log(deps, { action, itemId: item.id, ok: false, error: (e as Error).message });
    throw e instanceof ActionFailed ? e : new ActionFailed((e as Error).message);
  }

  // I8: report what is really on disk now, not what we hoped to write.
  const fresh = (await deps.inventory()).items.find((i) => i.id === item.id) ?? null;
  const warnings: string[] = [];
  const expected = EXPECTED[action]?.[item.kind];
  if (fresh && expected && fresh.state !== expected) {
    const why = fresh.stateSource ? `${fresh.stateSource.detail} in ${fresh.stateSource.file}` : 'another setting';
    warnings.push(`Saved, but it is still ${fresh.state}: ${why} takes priority.`);
  }
  if (trashEntry) warnings.push(...leftoverSettingsNotes(item));
  await log(deps, { action, itemId: item.id, ok: true, state: fresh?.state, backups, ...(trashEntry ? { trashed: trashEntry.trashedPath } : {}) });
  return { item: fresh, backups, warnings, restartNeeded: true, ...(trashEntry ? { trashEntry } : {}) };
}

/** A deleted item's override / deny rule stays in settings (harmless, and re-applies on restore). */
function leftoverSettingsNotes(item: Item): string[] {
  if (item.state === 'on' || !item.stateSource || item.stateSource.level === 'cli') return [];
  return [`Its setting (${item.stateSource.detail}) is kept, so it comes back the same way if you restore it.`];
}

export async function restoreAction(entryId: string, deps: ActionDeps): Promise<ActionResult> {
  let entry: TrashEntry;
  try {
    entry = await restoreFromTrash(entryId, trashOptions(deps));
  } catch (e) {
    await log(deps, { action: 'restore', trashId: entryId, ok: false, error: (e as Error).message });
    throw e;
  }
  const fresh = (await deps.inventory()).items.find((i) => i.id === entry.itemId) ?? null;
  await log(deps, { action: 'restore', itemId: entry.itemId, ok: true, restored: entry.originalPath });
  return { item: fresh, backups: [], warnings: fresh ? [] : ['Restored, but it did not reappear under the same id. Refresh the page.'], restartNeeded: true };
}
