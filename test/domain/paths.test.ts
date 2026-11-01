import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isAllowedSettingsFile, isInsideAppDir, type WriteScope } from '../../src/domain/paths.ts';

const home = join('/', 'home', 'u');
const scope: WriteScope = { home, appDir: join(home, '.claude-control-panel'), projects: [join('/', 'work', 'proj')], caseInsensitive: true };

test('user settings and project-local settings are writable', () => {
  assert.equal(isAllowedSettingsFile(join(home, '.claude', 'settings.json'), scope), true);
  assert.equal(isAllowedSettingsFile(join('/', 'work', 'proj', '.claude', 'settings.local.json'), scope), true);
});

test('shared project settings, other files and unknown projects are not', () => {
  assert.equal(isAllowedSettingsFile(join('/', 'work', 'proj', '.claude', 'settings.json'), scope), false);
  assert.equal(isAllowedSettingsFile(join(home, '.claude.json'), scope), false);
  assert.equal(isAllowedSettingsFile(join(home, '.claude', '.credentials.json'), scope), false);
  assert.equal(isAllowedSettingsFile(join('/', 'other', '.claude', 'settings.local.json'), scope), false);
});

test('path tricks do not escape the allow-list', () => {
  assert.equal(isAllowedSettingsFile(join(home, '.claude', 'x', '..', 'settings.json'), scope), true, 'normalised path is the same file');
  assert.equal(isAllowedSettingsFile(join(home, '.claude', '..', '.claude.json'), scope), false);
  assert.equal(isAllowedSettingsFile(join(home, '.CLAUDE', 'Settings.json'), scope), true, 'Windows is case-insensitive');
  assert.equal(isAllowedSettingsFile(join(home, '.CLAUDE', 'Settings.json'), { ...scope, caseInsensitive: false }), false);
});

test('app dir: inside only, no escaping with ..', () => {
  assert.equal(isInsideAppDir(join(scope.appDir, 'backups', 'a.json'), scope), true);
  assert.equal(isInsideAppDir(scope.appDir, scope), false);
  assert.equal(isInsideAppDir(join(scope.appDir, '..', '.claude', 'settings.json'), scope), false);
  assert.equal(isInsideAppDir(`${scope.appDir}-evil/x`, scope), false);
});
