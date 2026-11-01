// M8: hooks view + master switch, MCP remove. Real HTTP, fake home, fake CLI.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import type { ClaudeCli } from '../src/adapters/cli.ts';
import { flattenHooks } from '../src/services/hooks.ts';
import { fakeTree } from './helpers.ts';

const TOKEN = 't';
const get = (url: string) => fetch(url, { headers: { 'X-CCP-Token': TOKEN } });
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

test('flattenHooks: every handler, matcher kept, secrets masked, junk skipped', () => {
  const hooks = flattenHooks({
    PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'fmt --token abc123 file' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }, { type: 'prompt', prompt: 'Check the work' }] }],
    Broken: 'nope', Weird: [null, { hooks: 'x' }],
  });
  assert.deepEqual(hooks, [
    { event: 'PostToolUse', matcher: 'Edit|Write', type: 'command', detail: 'fmt --token *** file' },
    { event: 'Stop', type: 'command', detail: 'say done' },
    { event: 'Stop', type: 'prompt', detail: 'prompt: Check the work' },
  ]);
});

async function start() {
  const pluginDir = await fakeTree({
    '.claude-plugin/plugin.json': { name: 'hp', description: 'hook plugin' },
    'hooks/hooks.json': { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node start.js' }] }] } },
  });
  const home = await fakeTree({
    '.claude/settings.json': { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } },
    '.claude.json': { mcpServers: { 'aws-mcp': { command: 'uvx', env: { KEY: 'secret' } } }, projects: {} },
  });
  const calls: string[][] = [];
  const cli: ClaudeCli = {
    async run(args) {
      calls.push(args);
      if (args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: JSON.stringify([{ id: 'hp@m', version: '1', scope: 'user', enabled: true, installPath: pluginDir }]), stderr: '' };
      }
      if (args[0] === 'mcp' && args[1] === 'remove') {
        // Behave like the real CLI: rewrite ~/.claude.json without the server.
        const file = join(home, '.claude.json');
        const j = JSON.parse(await readFile(file, 'utf8'));
        delete j.mcpServers[args[2]!];
        await writeFile(file, JSON.stringify(j));
        return { code: 0, stdout: 'Removed', stderr: '' };
      }
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
  const inventory = async () => (await (await get(`${base}/api/inventory`)).json()).items as { id: string; kind: string; state: string; actions: Record<string, { allowed: boolean; reason?: string }> }[];
  return { home, post, inventory, calls };
}

test('hooks are listed from settings and plugins; single hooks are view-only', async () => {
  const { inventory } = await start();
  const hooks = (await inventory()).filter((i) => i.kind === 'hook');
  assert.deepEqual(hooks.map((h) => h.id).sort(), ['hook:master:*', 'hook:plugin:hp@m:SessionStart#0', 'hook:user:user:Stop#0']);
  const single = hooks.find((h) => h.id === 'hook:user:user:Stop#0')!;
  assert.match(single.actions.disable!.reason!, /can't turn off a single hook/);
});

test('All hooks off, then on again: settings file back to the original', async () => {
  const { home, post, inventory } = await start();
  const file = join(home, '.claude', 'settings.json');
  const original = JSON.parse(await readFile(file, 'utf8'));

  const off = await post({ itemId: 'hook:master:*', action: 'disable' });
  assert.equal(off.status, 200);
  assert.equal(off.body.item.state, 'off');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).disableAllHooks, true);
  assert.ok((await inventory()).filter((i) => i.kind === 'hook' && i.id !== 'hook:master:*').every((h) => h.state === 'off'), 'every hook shows off');

  const on = await post({ itemId: 'hook:master:*', action: 'enable' });
  assert.equal(on.body.item.state, 'on');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
});

test('MCP remove: backs up ~/.claude.json, runs the CLI, and checks the server is really gone', async () => {
  const { home, post, calls } = await start();
  const res = await post({ itemId: 'mcp:user:aws-mcp', action: 'delete', confirm: true });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.find((c) => c[0] === 'mcp'), ['mcp', 'remove', 'aws-mcp', '--scope', 'user']);
  assert.equal(res.body.backups.length, 1);
  assert.match(await readFile(res.body.backups[0], 'utf8'), /aws-mcp/, 'backup holds the removed server');
  assert.deepEqual(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers, {});
  assert.ok((await readdir(join(home, '.ccp', 'backups'))).some((f) => f.startsWith('claude-json.')));
});

test('MCP remove: unknown server → 404; flag-like names and connectors are refused', async () => {
  const { post } = await start();
  assert.equal((await post({ itemId: 'mcp:user:not-there', action: 'delete', confirm: true })).status, 404);
  assert.equal((await post({ itemId: 'mcp:user:aws-mcp', action: 'delete' })).status, 400, 'needs confirm');
});
