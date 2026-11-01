// Carry out an allowed action, then report the state re-read from disk (invariant I8).

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { updateSettingsFile, type JsonObject } from '../adapters/settingsFile.ts';
import { agentRuleMatches, denyRules } from '../domain/effective.ts';
import { projectHash } from '../domain/ids.ts';
import { isAllowedSettingsFile, userSettingsPath, type WriteScope } from '../domain/paths.ts';
import { addAgentDeny, removeAgentDeny, setSkillOverride } from '../domain/mutations.ts';
import type { ActionName, Item, ItemState } from '../domain/types.ts';
import type { Inventory } from './inventory.ts';

export interface ActionDeps {
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
}

export class ActionFailed extends Error {}

function backupLabel(file: string, deps: ActionDeps): string {
  if (file === userSettingsPath(deps.home)) return 'user-settings';
  const project = deps.projects.find((p) => file.startsWith(p));
  return project ? `project-${projectHash(project)}-settings.local` : 'settings';
}

async function writeSettings(file: string, mutate: (d: JsonObject) => void, deps: ActionDeps): Promise<string | undefined> {
  const scope: WriteScope = { home: deps.home, appDir: deps.appDir, projects: deps.projects };
  const res = await updateSettingsFile(file, mutate, {
    isAllowed: (p) => isAllowedSettingsFile(p, scope),
    backupDir: join(deps.appDir, 'backups'),
    label: backupLabel(file, deps),
  });
  return res.backup;
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

  try {
    if (item.kind === 'skill' && (action === 'enable' || action === 'disable')) {
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
  await log(deps, { action, itemId: item.id, ok: true, state: fresh?.state, backups });
  return { item: fresh, backups, warnings, restartNeeded: true };
}
