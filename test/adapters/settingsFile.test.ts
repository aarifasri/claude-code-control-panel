import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updateSettingsFile, type UpdateOptions } from '../../src/adapters/settingsFile.ts';
import { fakeTree } from '../helpers.ts';

const ORIGINAL = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] }, enabledPlugins: { 'a@b': true } };

/** `null` = no settings file exists yet. */
async function setup(content: object | null = ORIGINAL) {
  const dir = await fakeTree(content === null ? {} : { 'settings.json': content });
  const file = join(dir, 'settings.json');
  const backupDir = join(dir, 'backups');
  const opts: UpdateOptions = { isAllowed: (p) => p === file, backupDir, label: 'user-settings' };
  return { dir, file, backupDir, opts };
}

test('changes one key, keeps every other key identical, and backs up first (I1, I4)', async () => {
  const { file, opts } = await setup();
  const before = await readFile(file, 'utf8');
  const res = await updateSettingsFile(file, (d) => { d.skillOverrides = { s: 'off' }; }, opts);

  assert.equal(res.changed, true);
  assert.ok(res.backup);
  assert.equal(await readFile(res.backup, 'utf8'), before, 'backup is byte-identical to the original');
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(after, { ...ORIGINAL, skillOverrides: { s: 'off' } });
  assert.ok((await readFile(file, 'utf8')).endsWith('}\n'), 'trailing newline');
});

test('refuses paths that are not on the allow-list (I2)', async () => {
  const { dir, opts } = await setup();
  const other = join(dir, 'other.json');
  await assert.rejects(updateSettingsFile(other, (d) => { d.x = 1; }, opts), /not on the allow-list/);
});

test('no change → no write and no backup', async () => {
  const { file, backupDir, opts } = await setup();
  const res = await updateSettingsFile(file, () => {}, opts);
  assert.deepEqual(res, { changed: false });
  await assert.rejects(readdir(backupDir), /ENOENT/);
});

test('invalid JSON is left untouched', async () => {
  const { file, opts } = await setup();
  await writeFile(file, '{ "model": "opus", ');
  await assert.rejects(updateSettingsFile(file, (d) => { d.x = 1; }, opts), /not valid JSON.*left untouched/);
  assert.equal(await readFile(file, 'utf8'), '{ "model": "opus", ');
});

test('missing file is created, with no backup', async () => {
  const { file, opts } = await setup(null);
  const res = await updateSettingsFile(file, (d) => { d.skillOverrides = { s: 'off' }; }, opts);
  assert.deepEqual(res, { changed: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { skillOverrides: { s: 'off' } });
});

test('if the file changes while we work, we redo the change on the new content (I5)', async () => {
  const { file, opts } = await setup();
  let calls = 0;
  const theirs = JSON.stringify({ ...ORIGINAL, theme: 'dark' });
  const res = await updateSettingsFile(file, (d) => {
    calls++;
    d.skillOverrides = { s: 'off' };
    // Simulate Claude Code saving the file between our read and our write (first attempt only).
    if (calls === 1) writeFileSyncCompat(file, theirs);
  }, opts);
  assert.equal(res.changed, true);
  assert.equal(calls, 2);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.theme, 'dark', 'their change survived');
  assert.deepEqual(after.skillOverrides, { s: 'off' }, 'our change applied');
  assert.equal(await readFile(res.backup!, 'utf8'), theirs, 'backup holds the version we actually replaced');
});

test('gives up (and writes nothing) if the file never stops changing', async () => {
  const { file, opts } = await setup();
  let n = 0;
  await assert.rejects(
    updateSettingsFile(file, (d) => { d.x = 1; writeFileSyncCompat(file, JSON.stringify({ n: ++n })); }, opts),
    /kept changing/,
  );
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 3 }, 'last external write is intact');
});

test('no temp files are left behind, and old backups are pruned', async () => {
  const { dir, file, backupDir, opts } = await setup();
  for (let i = 0; i < 5; i++) {
    await updateSettingsFile(file, (d) => { d.counter = i; }, { ...opts, maxBackups: 3, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
  }
  assert.equal((await readdir(backupDir)).length, 3);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
});

// Synchronous write so the simulated "other writer" happens inside the mutate callback.
import { writeFileSync } from 'node:fs';
function writeFileSyncCompat(path: string, text: string): void {
  writeFileSync(path, text);
}
