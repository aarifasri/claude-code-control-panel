// Pure edits applied to a parsed settings object. Each changes only what it must (invariant I4):
// containers are created when needed, and removed only when OUR removal leaves them empty, so
// turning something off and on again returns the file to how it was.

import { agentRuleMatches } from './effective.ts';

type Json = Record<string, unknown>;

function objectAt(data: Json, key: string): Json {
  const v = data[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json;
  if (v !== undefined) throw new Error(`settings field "${key}" is not an object; refusing to change it`);
  const created: Json = {};
  data[key] = created;
  return created;
}

/** Set `skillOverrides[folder]` to "off"/"on", or remove it (undefined) so lower files decide. */
export function setSkillOverride(data: Json, folder: string, value: 'off' | 'on' | undefined): void {
  if (value === undefined) {
    const overrides = data.skillOverrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || !(folder in overrides)) return;
    delete (overrides as Json)[folder];
    if (Object.keys(overrides).length === 0) delete data.skillOverrides;
    return;
  }
  objectAt(data, 'skillOverrides')[folder] = value;
}

function denyList(data: Json, create: boolean): unknown[] | undefined {
  const permissions = create ? objectAt(data, 'permissions') : (data.permissions as Json | undefined);
  if (!permissions || typeof permissions !== 'object') return undefined;
  const deny = permissions.deny;
  if (Array.isArray(deny)) return deny;
  if (deny !== undefined) throw new Error('settings field "permissions.deny" is not a list; refusing to change it');
  if (!create) return undefined;
  const list: unknown[] = [];
  permissions.deny = list;
  return list;
}

export function agentDenyRule(agentName: string): string {
  return `Agent(${agentName})`;
}

/** Add `Agent(name)` to permissions.deny unless an equivalent rule is already there. */
export function addAgentDeny(data: Json, agentName: string): void {
  const deny = denyList(data, true)!;
  if (!deny.some((r) => r === agentDenyRule(agentName) || r === `Task(${agentName})`)) deny.push(agentDenyRule(agentName));
}

/** Remove `Agent(name)` / `Task(name)` rules for this agent. Bare `Agent`/`Task` rules are left alone. */
export function removeAgentDeny(data: Json, agentName: string): void {
  const deny = denyList(data, false);
  if (!deny) return;
  const before = deny.length;
  for (let i = deny.length - 1; i >= 0; i--) {
    const r = deny[i];
    if (typeof r === 'string' && agentRuleMatches(r, agentName) && r.trim() !== 'Agent' && r.trim() !== 'Task') deny.splice(i, 1);
  }
  if (deny.length === before || deny.length > 0) return;
  const permissions = data.permissions as Json;
  delete permissions.deny;
  if (Object.keys(permissions).length === 0) delete data.permissions;
}
