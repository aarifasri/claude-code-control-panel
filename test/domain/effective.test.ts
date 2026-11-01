import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentState, hooksDisabled, skillState } from '../../src/domain/effective.ts';
import type { SettingsLayer, SettingsLevel } from '../../src/domain/types.ts';

const L = (level: SettingsLevel, data: Record<string, unknown> | null): SettingsLayer => ({ level, file: `${level}.json`, data });

test('skill with no override is on', () => {
  assert.equal(skillState('x', [L('user', {})]).state, 'on');
  assert.equal(skillState('x', [L('user', null)]).state, 'on');
});

test('skill override off / on / partial values', () => {
  assert.equal(skillState('x', [L('user', { skillOverrides: { x: 'off' } })]).state, 'off');
  assert.equal(skillState('x', [L('user', { skillOverrides: { x: 'on' } })]).state, 'on');
  assert.equal(skillState('x', [L('user', { skillOverrides: { x: 'name-only' } })]).state, 'partial');
});

test('higher-precedence layer wins, regardless of array order', () => {
  const layers = [L('local', { skillOverrides: { x: 'on' } }), L('user', { skillOverrides: { x: 'off' } })];
  const eff = skillState('x', layers);
  assert.equal(eff.state, 'on');
  assert.equal(eff.source?.level, 'local');
  assert.equal(skillState('x', [...layers].reverse()).source?.level, 'local');
});

test('managed beats local', () => {
  const eff = skillState('x', [L('local', { skillOverrides: { x: 'on' } }), L('managed', { skillOverrides: { x: 'off' } })]);
  assert.deepEqual([eff.state, eff.source?.level], ['off', 'managed']);
});

test('override for another skill does not apply', () => {
  assert.equal(skillState('x', [L('user', { skillOverrides: { y: 'off' } })]).state, 'on');
});

test('malformed skillOverrides is ignored', () => {
  assert.equal(skillState('x', [L('user', { skillOverrides: ['x'] })]).state, 'on');
});

test('agent blocked by Agent(name) or Task(name) in any layer', () => {
  assert.equal(agentState('A B', [L('user', { permissions: { deny: ['Agent(A B)'] } })]).state, 'blocked');
  assert.equal(agentState('A B', [L('project', { permissions: { deny: ['Task(A B)'] } })]).state, 'blocked');
  assert.equal(agentState('A B', [L('user', { permissions: { deny: ['Agent(Other)', 'Bash'] } })]).state, 'on');
});

test('deny lists merge: a user-level deny still blocks when local allows', () => {
  const eff = agentState('A', [L('local', { permissions: { allow: ['Agent(A)'] } }), L('user', { permissions: { deny: ['Agent(A)'] } })]);
  assert.deepEqual([eff.state, eff.source?.level], ['blocked', 'user']);
});

test('bare Agent deny blocks every agent', () => {
  assert.equal(agentState('Anything', [L('user', { permissions: { deny: ['Agent'] } })]).state, 'blocked');
});

test('hooks master switch precedence', () => {
  assert.equal(hooksDisabled([L('user', {})]).state, 'on');
  assert.equal(hooksDisabled([L('user', { disableAllHooks: true })]).state, 'off');
  assert.equal(hooksDisabled([L('user', { disableAllHooks: true }), L('project', { disableAllHooks: false })]).state, 'on');
});
