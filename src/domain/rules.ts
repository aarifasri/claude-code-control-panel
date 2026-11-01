// Which actions an item allows, and why not (docs/DATA_MODEL.md §4). Pure: decides, never acts.

import { agentRuleMatches, denyRules } from './effective.ts';
import type { ActionAvailability, ActionName, Item, SettingsLayer } from './types.ts';

export interface RuleContext {
  layers: SettingsLayer[];
  /** The settings file toggles write to in the current view (user view: ~/.claude/settings.json). */
  targetFile: string;
  /** Whether the app may write this settings file (invariant I2). */
  isWritable: (file: string) => boolean;
}

type Actions = Partial<Record<ActionName, ActionAvailability>>;

const no = (reason: string): ActionAvailability => ({ allowed: false, reason });
const yes = (target: string): ActionAvailability => ({ allowed: true, target });

function managedLayer(layers: SettingsLayer[]): SettingsLayer | undefined {
  return layers.find((l) => l.level === 'managed' && l.data);
}

function skillActions(item: Item, ctx: RuleContext): Actions {
  if (item.stateSource?.level === 'managed') {
    const reason = 'Set by your organisation\'s managed settings, which this app can\'t change.';
    return { enable: no(reason), disable: no(reason) };
  }
  const target = ctx.layers.find((l) => l.file === ctx.targetFile);
  if (target?.error) {
    const reason = `${ctx.targetFile} can't be read (${target.error}). Fix it first.`;
    return { enable: no(reason), disable: no(reason) };
  }
  return item.state === 'on'
    ? { disable: yes(ctx.targetFile), enable: no('Already on.') }
    : { enable: yes(ctx.targetFile), disable: item.state === 'off' ? no('Already off.') : yes(ctx.targetFile) };
}

function agentActions(item: Item, ctx: RuleContext): Actions {
  // The deny-rule syntax has no escaping, so names with brackets can't be targeted safely.
  if (/[()]/.test(item.key)) {
    const reason = 'Agent names containing brackets can\'t be targeted by a permission rule.';
    return { enable: no(reason), disable: no(reason) };
  }
  if (item.state !== 'blocked') return { disable: yes(ctx.targetFile), enable: no('Already on.') };

  const managed = managedLayer(ctx.layers);
  if (managed && denyRules(managed).some((r) => agentRuleMatches(r, item.key))) {
    return { enable: no('Blocked by your organisation\'s managed settings.'), disable: no('Already blocked.') };
  }
  // A bare `Agent` rule blocks every agent; removing it is a much bigger change than this switch implies.
  for (const layer of ctx.layers) {
    const bare = denyRules(layer).find((r) => r.trim() === 'Agent' || r.trim() === 'Task');
    if (bare) return { enable: no(`All agents are blocked by the rule "${bare}" in ${layer.file}. Edit that file to change it.`), disable: no('Already blocked.') };
  }
  const files = ctx.layers.filter((l) => denyRules(l).some((r) => agentRuleMatches(r, item.key))).map((l) => l.file);
  const locked = files.find((f) => !ctx.isWritable(f));
  if (locked) return { enable: no(`Blocked by a rule in ${locked}, which this app doesn't edit (it's shared with your team).`), disable: no('Already blocked.') };
  return { enable: yes(files.join(', ')), disable: no('Already blocked.') };
}

/**
 * Plugin ids are passed to the CLI as an argument. Even without a shell, an "id" starting with "-"
 * would be read as a flag (`disable -a` disables ALL plugins), so only name@marketplace shapes pass.
 */
export const SAFE_PLUGIN_ID = /^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/;

function pluginActions(item: Item): Actions {
  if (!SAFE_PLUGIN_ID.test(item.key)) {
    const reason = `Unexpected plugin id "${item.key}"; refusing to pass it to the claude CLI.`;
    return { enable: no(reason), disable: no(reason), delete: no(reason) };
  }
  if (item.scope === 'synced') {
    const reason = 'Synced from your claude.ai account: manage it there.';
    return { enable: no(reason), disable: no(reason), delete: no(reason) };
  }
  if (item.scope === 'project') {
    const reason = 'Installed for the whole project (in its shared .claude/settings.json), so changing it would affect your team.';
    return { enable: no(reason), disable: no(reason), delete: no(reason) };
  }
  if (item.scope !== 'user') {
    // Local-scope plugins are stored in a project's settings.local.json, which needs project view (M7).
    const reason = 'Installed for one project only; changing it arrives with project view.';
    return { enable: no(reason), disable: no(reason), delete: no(reason) };
  }
  const cmd = (verb: string) => `claude plugin ${verb} ${item.key} --scope ${item.scope}`;
  return {
    enable: item.state === 'on' ? no('Already on.') : yes(cmd('enable')),
    disable: item.state === 'on' ? yes(cmd('disable')) : no('Already off.'),
    delete: yes(`${cmd('uninstall')} --keep-data`),
  };
}

const PLUGIN_PART = 'Part of a plugin: it can only be turned off by disabling the whole plugin.';

export function actionsFor(item: Item, ctx: RuleContext): Actions {
  if (item.kind === 'plugin') return pluginActions(item);
  if (item.origin.type === 'plugin') return { enable: no(PLUGIN_PART), disable: no(PLUGIN_PART), delete: no(PLUGIN_PART) };
  if (item.kind === 'skill' && item.scope === 'user') return skillActions(item, ctx);
  if (item.kind === 'agent' && item.scope === 'user') return agentActions(item, ctx);
  return {};
}
