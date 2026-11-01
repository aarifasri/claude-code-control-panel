import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareWithInit } from '../../src/domain/verify.ts';
import type { Item } from '../../src/domain/types.ts';

function item(over: Partial<Item>): Item {
  return { id: over.key ?? 'x', kind: 'skill', key: 'k', name: over.key ?? 'k', description: '', scope: 'user', origin: { type: 'standalone' }, state: 'on', actions: {}, warnings: [], ...over };
}

const items: Item[] = [
  item({ kind: 'plugin', key: 'ecc@ecc', state: 'on' }),
  item({ kind: 'plugin', key: 'fd@official', state: 'off' }),
  item({ key: 'careful', state: 'on' }),
  item({ key: 'off-skill', state: 'off' }),
  item({ key: 'cmd', variant: 'command', state: 'on' }),
  item({ key: 'ecc:accessibility', origin: { type: 'plugin', pluginId: 'ecc@ecc' }, scope: 'plugin' }),
  item({ kind: 'agent', key: 'Helper', state: 'on' }),
  item({ kind: 'agent', key: 'Blocked One', state: 'blocked' }),
  item({ kind: 'agent', key: 'architect', origin: { type: 'plugin', pluginId: 'ecc@ecc' }, scope: 'plugin' }),
];

test('everything matching → no mismatches', () => {
  const report = compareWithInit(items, {
    plugins: [{ source: 'ecc@ecc' }],
    skills: ['careful', 'ecc:accessibility'], slash_commands: ['cmd'],
    agents: ['Helper', 'Blocked One', 'ecc:architect'],
  });
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.checked, { plugins: 2, skills: 4, agents: 3 });
});

test('hidden-from-menu skills are not checkable; @builtin plugins are listed, not reported', () => {
  const report = compareWithInit([item({ key: 'data:viz', hiddenFromMenu: true, origin: { type: 'plugin', pluginId: 'data@synced' } })], {
    plugins: [{ source: 'cc-plugin-telemetry@builtin' }], skills: [], slash_commands: [], agents: [],
  });
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.uncheckedSkills, 1);
  assert.deepEqual(report.builtinPlugins, ['cc-plugin-telemetry@builtin']);
});

test('each kind of disagreement is reported', () => {
  const report = compareWithInit(items, {
    plugins: [{ source: 'fd@official' }, { source: 'extra@m' }],
    skills: ['off-skill'], slash_commands: [],
    agents: ['Blocked One'],
  });
  const summary = report.mismatches.map((m) => `${m.kind}:${m.name}:${m.app}->${m.claude}`).sort();
  assert.deepEqual(summary, [
    'agent:Helper:on->not listed',
    'agent:architect:on->not listed',
    'plugin:ecc@ecc:on->not loaded',
    'plugin:extra@m:not in the list->loaded',
    'plugin:fd@official:off->loaded',
    'skill:careful:on->not loaded',
    'skill:cmd:on->not loaded',
    'skill:ecc:accessibility:on->not loaded',
    'skill:off-skill:off->loaded',
  ]);
});
