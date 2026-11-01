import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listTrash, moveToTrash, restoreFromTrash, type TrashOptions } from '../../src/adapters/trash.ts';
import { isTrashableSource } from '../../src/domain/paths.ts';
import { fakeTree, md } from '../helpers.ts';

async function setup() {
  const home = await fakeTree({
    '.claude/skills/my-skill/SKILL.md': md({ description: 'skill' }),
    '.claude/skills/my-skill/scripts/run.py': 'print("hi")\n',
    '.claude/agents/helper.md': md({ name: 'Helper', description: 'agent' }),
    '.claude/settings.json': { model: 'x' },
    'elsewhere/precious.txt': 'do not touch',
  });
  const scope = { home, appDir: join(home, '.ccp'), projects: [] };
  const opts: TrashOptions = { trashDir: join(home, '.ccp', 'trash'), isAllowedSource: (p, k) => isTrashableSource(p, k, scope) };
  return { home, opts };
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const skill = (home: string) => ({ kind: 'skill' as const, key: 'my-skill', name: 'my-skill', itemId: 'skill:user:my-skill', path: join(home, '.claude', 'skills', 'my-skill') });

test('allowed sources: exactly one level inside skills/, agents/*.md, commands/*.md', () => {
  const scope = { home: '/h', appDir: '/h/.ccp', projects: [], caseInsensitive: false };
  assert.equal(isTrashableSource('/h/.claude/skills/s', 'skill', scope), true);
  assert.equal(isTrashableSource('/h/.claude/agents/a.md', 'agent', scope), true);
  assert.equal(isTrashableSource('/h/.claude/commands/c.md', 'command', scope), true);
  assert.equal(isTrashableSource('/h/.claude/skills', 'skill', scope), false, 'not the folder itself');
  assert.equal(isTrashableSource('/h/.claude/skills/s/SKILL.md', 'skill', scope), false, 'not deeper');
  assert.equal(isTrashableSource('/h/.claude/agents/a.txt', 'agent', scope), false);
  assert.equal(isTrashableSource('/h/.claude/settings.json', 'skill', scope), false);
  assert.equal(isTrashableSource('/h/.claude/skills/../settings.json', 'skill', scope), false);
  assert.equal(isTrashableSource('/h/.claude/plugins/cache/x/skills/s', 'skill', scope), false, 'never plugin files');
});

test('skill folder → trash → restore gives back identical files (AC-4)', async () => {
  const { home, opts } = await setup();
  const before = await readFile(join(home, '.claude/skills/my-skill/scripts/run.py'), 'utf8');
  const entry = await moveToTrash(skill(home), opts);
  assert.equal(await exists(skill(home).path), false, 'gone from its original place');
  assert.equal(await exists(join(entry.trashedPath, 'scripts', 'run.py')), true, 'whole folder kept in trash');
  assert.equal((await listTrash(opts)).length, 1);

  await restoreFromTrash(entry.id, opts);
  assert.equal(await readFile(join(home, '.claude/skills/my-skill/scripts/run.py'), 'utf8'), before);
  assert.deepEqual(await listTrash(opts), []);
  assert.deepEqual((await readdir(opts.trashDir)).filter((f) => f !== 'manifest.json'), [], 'trash slot cleaned up');
});

test('restore refuses to overwrite something new at the original path, and keeps the trashed copy (BR-8, I9)', async () => {
  const { home, opts } = await setup();
  const entry = await moveToTrash(skill(home), opts);
  await mkdir(skill(home).path);
  await writeFile(join(skill(home).path, 'SKILL.md'), 'NEW ONE');
  await assert.rejects(restoreFromTrash(entry.id, opts), (e: Error & { code?: string }) => e.code === 'conflict');
  assert.equal(await readFile(join(skill(home).path, 'SKILL.md'), 'utf8'), 'NEW ONE', 'new item untouched');
  assert.equal((await listTrash(opts)).length, 1, 'still in trash');
});

test('refuses to trash anything outside skill/agent/command locations', async () => {
  const { home, opts } = await setup();
  for (const path of [join(home, '.claude', 'settings.json'), join(home, 'elsewhere'), join(home, '.claude', 'skills')]) {
    await assert.rejects(moveToTrash({ ...skill(home), path }, opts), (e: Error & { code?: string }) => e.code === 'not-allowed', path);
  }
  assert.equal(await readFile(join(home, 'elsewhere', 'precious.txt'), 'utf8'), 'do not touch');
});

test('a tampered manifest cannot make restore move or delete other folders', async () => {
  const { home, opts } = await setup();
  const entry = await moveToTrash(skill(home), opts);
  const manifest = join(opts.trashDir, 'manifest.json');

  // Point the "trashed copy" at a folder outside the trash.
  await writeFile(manifest, JSON.stringify([{ ...entry, trashedPath: join(home, 'elsewhere', 'precious.txt') }]));
  await assert.rejects(restoreFromTrash(entry.id, opts), /not inside the trash folder/);
  assert.equal(await readFile(join(home, 'elsewhere', 'precious.txt'), 'utf8'), 'do not touch');

  // Point the restore destination outside the allowed locations.
  await writeFile(manifest, JSON.stringify([{ ...entry, originalPath: join(home, 'elsewhere', 'x') }]));
  await assert.rejects(restoreFromTrash(entry.id, opts), /Refusing to restore/);
});

test('agent file round trip, and unknown entry ids', async () => {
  const { home, opts } = await setup();
  const path = join(home, '.claude', 'agents', 'helper.md');
  const original = await readFile(path, 'utf8');
  const entry = await moveToTrash({ kind: 'agent', key: 'Helper', name: 'Helper', itemId: 'agent:user:Helper', path }, opts);
  await restoreFromTrash(entry.id, opts);
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(restoreFromTrash('nope', opts), (e: Error & { code?: string }) => e.code === 'missing');
});
