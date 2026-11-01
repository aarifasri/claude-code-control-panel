import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAgentDeny, removeAgentDeny, setSkillOverride } from '../../src/domain/mutations.ts';
import { actionsFor, type RuleContext } from '../../src/domain/rules.ts';
import type { Item, SettingsLayer } from '../../src/domain/types.ts';

// ---------- mutations ----------

test('skill override: set off, then remove; other overrides and keys untouched', () => {
  const d: Record<string, unknown> = { model: 'x', skillOverrides: { other: 'name-only' } };
  setSkillOverride(d, 's', 'off');
  assert.deepEqual(d, { model: 'x', skillOverrides: { other: 'name-only', s: 'off' } });
  setSkillOverride(d, 's', undefined);
  assert.deepEqual(d, { model: 'x', skillOverrides: { other: 'name-only' } });
});

test('skill override: off then on returns the object to exactly how it was', () => {
  const d: Record<string, unknown> = {};
  setSkillOverride(d, 's', undefined);
  assert.deepEqual(d, {});
  setSkillOverride(d, 's', 'off');
  assert.deepEqual(d, { skillOverrides: { s: 'off' } });
  setSkillOverride(d, 's', undefined);
  assert.deepEqual(d, {}, 'container we emptied is removed');
});

test('a container the user already had empty is left alone', () => {
  const d: Record<string, unknown> = { skillOverrides: {}, permissions: { deny: [] } };
  setSkillOverride(d, 's', undefined);
  removeAgentDeny(d, 'A');
  assert.deepEqual(d, { skillOverrides: {}, permissions: { deny: [] } });
});

test('refuses to edit a malformed container instead of replacing it', () => {
  assert.throws(() => setSkillOverride({ skillOverrides: ['bad'] }, 's', 'off'), /not an object/);
  assert.throws(() => addAgentDeny({ permissions: { deny: 'Bash' } }, 'A'), /not a list/);
});

test('agent deny: add once (no duplicates, Task alias counts), keep allow rules', () => {
  const d: Record<string, unknown> = { permissions: { allow: ['Bash(ls)'], deny: ['WebFetch'] } };
  addAgentDeny(d, 'My Agent');
  addAgentDeny(d, 'My Agent');
  assert.deepEqual(d, { permissions: { allow: ['Bash(ls)'], deny: ['WebFetch', 'Agent(My Agent)'] } });
  const t: Record<string, unknown> = { permissions: { deny: ['Task(A)'] } };
  addAgentDeny(t, 'A');
  assert.deepEqual(t, { permissions: { deny: ['Task(A)'] } });
});

test('agent deny: remove only this agent\'s rules, never bare Agent or others', () => {
  const d: Record<string, unknown> = { permissions: { deny: ['Agent(A)', 'Task(A)', 'Agent(B)', 'Agent', 'Bash'] } };
  removeAgentDeny(d, 'A');
  assert.deepEqual(d, { permissions: { deny: ['Agent(B)', 'Agent', 'Bash'] } });
  const empty: Record<string, unknown> = {};
  removeAgentDeny(empty, 'A');
  assert.deepEqual(empty, {});
});

test('agent deny: block then unblock returns the object to how it was', () => {
  const d: Record<string, unknown> = { model: 'x' };
  addAgentDeny(d, 'A');
  removeAgentDeny(d, 'A');
  assert.deepEqual(d, { model: 'x' });
  const withAllow: Record<string, unknown> = { permissions: { allow: ['Bash'] } };
  addAgentDeny(withAllow, 'A');
  removeAgentDeny(withAllow, 'A');
  assert.deepEqual(withAllow, { permissions: { allow: ['Bash'] } }, 'only the emptied deny list goes');
});

// ---------- rules ----------

const USER = 'C:/h/.claude/settings.json';
const L = (level: SettingsLayer['level'], data: Record<string, unknown> | null, file = `${level}.json`): SettingsLayer => ({ level, file, data });
const ctx = (layers: SettingsLayer[], writable = [USER]): RuleContext => ({ layers, targetFile: USER, isWritable: (f) => writable.includes(f) });

function item(over: Partial<Item>): Item {
  return { id: 'x', kind: 'skill', key: 'k', name: 'k', description: '', scope: 'user', origin: { type: 'standalone' }, state: 'on', actions: {}, warnings: [], ...over };
}

test('standalone skill: on → disable allowed; off → enable allowed', () => {
  const on = actionsFor(item({}), ctx([L('user', {}, USER)]));
  assert.deepEqual(on.disable, { allowed: true, target: USER });
  assert.equal(on.enable?.allowed, false);
  const off = actionsFor(item({ state: 'off' }), ctx([L('user', {}, USER)]));
  assert.deepEqual(off.enable, { allowed: true, target: USER });
});

test('skill set by managed settings cannot be changed', () => {
  const a = actionsFor(item({ state: 'off', stateSource: { level: 'managed', file: 'm', detail: '' } }), ctx([]));
  assert.match((a.enable as { reason: string }).reason, /managed/);
});

test('unreadable target settings file blocks toggles', () => {
  const a = actionsFor(item({}), ctx([{ level: 'user', file: USER, data: null, error: 'invalid JSON' }]));
  assert.match((a.disable as { reason: string }).reason, /can't be read/);
});

test('plugin components are view-only with a reason', () => {
  const a = actionsFor(item({ origin: { type: 'plugin', pluginId: 'p@m' }, scope: 'plugin' }), ctx([]));
  assert.match((a.disable as { reason: string }).reason, /disabling the whole plugin/);
});

test('agent: on → disable; blocked → enable lists the files holding the rule', () => {
  const layers = [L('user', { permissions: { deny: ['Agent(A)'] } }, USER)];
  assert.deepEqual(actionsFor(item({ kind: 'agent', key: 'A' }), ctx(layers)).disable, { allowed: true, target: USER });
  assert.deepEqual(actionsFor(item({ kind: 'agent', key: 'A', state: 'blocked' }), ctx(layers)).enable, { allowed: true, target: USER });
});

test('agent: bare Agent rule, managed rule, or non-writable file → enable not allowed', () => {
  const bare = actionsFor(item({ kind: 'agent', key: 'A', state: 'blocked' }), ctx([L('user', { permissions: { deny: ['Agent'] } }, USER)]));
  assert.match((bare.enable as { reason: string }).reason, /All agents are blocked/);
  const managed = actionsFor(item({ kind: 'agent', key: 'A', state: 'blocked' }), ctx([L('managed', { permissions: { deny: ['Agent(A)'] } })]));
  assert.match((managed.enable as { reason: string }).reason, /managed/);
  const shared = actionsFor(item({ kind: 'agent', key: 'A', state: 'blocked' }), ctx([L('project', { permissions: { deny: ['Agent(A)'] } }, 'shared.json')]));
  assert.match((shared.enable as { reason: string }).reason, /shared with your team/);
});

test('agent names with brackets are refused', () => {
  const a = actionsFor(item({ kind: 'agent', key: 'Bad (name)' }), ctx([]));
  assert.equal(a.disable?.allowed, false);
});
