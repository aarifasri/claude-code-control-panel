// Project view (M7) end to end: real HTTP, fake home + fake project folder, fake CLI.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import type { ClaudeCli } from '../src/adapters/cli.ts';
import { fakeTree, md } from './helpers.ts';

const TOKEN = 't';
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function start() {
  const project = await fakeTree({
    '.claude/skills/proj-skill/SKILL.md': md({ description: 'Project skill' }),
    '.claude/settings.json': { model: 'team-model' },
  });
  const home = await fakeTree({
    '.claude/settings.json': { skillOverrides: { 'user-skill': 'off' }, theme: 'dark' },
    '.claude/skills/user-skill/SKILL.md': md({ description: 'User skill' }),
    '.claude.json': { projects: { [project.replace(/\\/g, '/')]: {}, 'C:/does/not/exist': {} } },
  });
  const calls: { args: string[]; cwd?: string }[] = [];
  const plugins = [{ id: 'loc@m', version: '1', scope: 'local', enabled: true, installPath: '' }];
  const cli: ClaudeCli = {
    async run(args, _t, cwd) {
      calls.push({ args, ...(cwd ? { cwd } : {}) });
      if (args.join(' ') === 'plugin list --json') return { code: 0, stdout: JSON.stringify(plugins), stderr: '' };
      if (args[1] === 'disable') { plugins[0]!.enabled = false; return { code: 0, stdout: '{}', stderr: '' }; }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  };
  let port = 0;
  const { handler } = createApp({ home, appDir: join(home, '.ccp'), cwd: home, getPort: () => port, token: TOKEN, cli });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-CCP-Token': TOKEN }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const inventory = async (p?: string) => (await (await fetch(`${base}/api/inventory${p ? `?project=${encodeURIComponent(p)}` : ''}`)).json());
  return { home, project, base, post, inventory, calls };
}

test('project list: known, existing folders only (home excluded)', async () => {
  const { base, project } = await start();
  const { projects } = await (await fetch(`${base}/api/projects`)).json();
  assert.deepEqual(projects.map((p: { path: string }) => p.path), [project]);
});

test('unknown project paths are rejected, never used', async () => {
  const { base, post } = await start();
  assert.equal((await fetch(`${base}/api/inventory?project=${encodeURIComponent('C:/Windows')}`)).status, 400);
  const res = await post({ itemId: 'skill:user:user-skill', action: 'enable', project: 'C:/Windows' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'unknown-project');
});

test('project view lists project items too, with project + local layers', async () => {
  const { project, inventory } = await start();
  const inv = await inventory(project);
  assert.ok(inv.items.some((i: { kind: string; scope: string; key: string }) => i.kind === 'skill' && i.scope === 'project' && i.key === 'proj-skill'));
  assert.deepEqual(inv.layers.map((l: { level: string }) => l.level), ['user', 'project', 'local']);
});

test('turning on a globally-off skill for one project writes "on" to settings.local.json only', async () => {
  const { home, project, post, inventory } = await start();
  const userBefore = await readFile(join(home, '.claude', 'settings.json'), 'utf8');

  const res = await post({ itemId: 'skill:user:user-skill', action: 'enable', project });
  assert.equal(res.status, 200);
  assert.equal(res.body.item.state, 'on');
  assert.equal(res.body.item.stateSource.level, 'local');

  assert.deepEqual(JSON.parse(await readFile(join(project, '.claude', 'settings.local.json'), 'utf8')), { skillOverrides: { 'user-skill': 'on' } });
  assert.equal(await readFile(join(home, '.claude', 'settings.json'), 'utf8'), userBefore, 'user settings untouched');
  assert.deepEqual(JSON.parse(await readFile(join(project, '.claude', 'settings.json'), 'utf8')), { model: 'team-model' }, 'shared project settings untouched');

  const userView = await inventory();
  assert.equal(userView.items.find((i: { id: string }) => i.id === 'skill:user:user-skill').state, 'off', 'still off everywhere else');
});

test('project skill can be turned off, writing the project-local file', async () => {
  const { project, post, inventory } = await start();
  const id = (await inventory(project)).items.find((i: { key: string; scope: string }) => i.key === 'proj-skill' && i.scope === 'project').id;
  const res = await post({ itemId: id, action: 'disable', project });
  assert.equal(res.body.item.state, 'off');
  assert.deepEqual(JSON.parse(await readFile(join(project, '.claude', 'settings.local.json'), 'utf8')), { skillOverrides: { 'proj-skill': 'off' } });
});

test('local-scope plugin: view-only in user view; in project view the CLI runs inside the project', async () => {
  const { project, post, inventory, calls } = await start();
  const userView = (await inventory()).items.find((i: { id: string }) => i.id === 'plugin:local:loc@m');
  assert.equal(userView.actions.disable.allowed, false);

  const res = await post({ itemId: 'plugin:local:loc@m', action: 'disable', project });
  assert.equal(res.status, 200);
  const disable = calls.find((c) => c.args[1] === 'disable')!;
  assert.deepEqual(disable.args, ['plugin', 'disable', 'loc@m', '--scope', 'local', '--json']);
  assert.equal(disable.cwd, project);
});
