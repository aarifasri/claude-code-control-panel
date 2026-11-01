// Real HTTP requests against the app handler, with a fake home and a fake CLI.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import type { ClaudeCli } from '../src/adapters/cli.ts';
import { fakeCli, fakeTree, md } from './helpers.ts';

const TOKEN = 'test-token-123';
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function start(cli?: ClaudeCli) {
  const home = await fakeTree({ '.claude/skills/s1/SKILL.md': md({ description: 'A skill' }) });
  let port = 0;
  const { handler } = createApp({
    home, appDir: join(home, '.claude-control-panel'), cwd: home, getPort: () => port, token: TOKEN,
    cli: cli ?? fakeCli({ 'plugin list --json': { stdout: '[]' } }),
  });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-CCP-Token': TOKEN, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { base, post, port };
}

test('page embeds the token; APIs never return it', async () => {
  const { base } = await start();
  assert.match(await (await fetch(base)).text(), new RegExp(`content="${TOKEN}"`));
  assert.doesNotMatch(await (await fetch(`${base}/api/inventory`)).text(), new RegExp(TOKEN));
});

test('write without the token → 403 (AC-5)', async () => {
  const { post } = await start();
  const res = await post({ itemId: 'skill:user:s1', action: 'disable' }, { 'X-CCP-Token': '' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'bad-token');
  const wrong = await post({ itemId: 'skill:user:s1', action: 'disable' }, { 'X-CCP-Token': 'nope' });
  assert.equal(wrong.status, 403);
});

test('write from another origin → 403, even with the token', async () => {
  const { post } = await start();
  const res = await post({ itemId: 'skill:user:s1', action: 'disable' }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'bad-origin');
});

test('non-JSON content type → 400 (blocks plain HTML form posts)', async () => {
  const { post } = await start();
  const res = await post('itemId=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(res.status, 400);
});

test('foreign Host header → 403 on every route (DNS rebinding)', async () => {
  const { port } = await start();
  // fetch() won't let us override Host, so use a raw request.
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve) => {
    request({ host: '127.0.0.1', port, path: '/api/inventory', headers: { Host: `evil.example:${port}` } }, (res) => resolve(res.statusCode ?? 0)).end();
  });
  assert.equal(status, 403);
});

test('body validation', async () => {
  const { post } = await start();
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post({ itemId: 'x', action: 'explode' })).status, 400);
  assert.equal((await post({ itemId: 'skill:user:s1', action: 'delete' })).status, 400, 'delete needs confirm');
  assert.equal((await post({ itemId: 'x'.repeat(5000), action: 'enable' })).status, 400, 'oversized body');
});

test('unknown item → 404; known item without that action → 409 with a reason', async () => {
  const { post } = await start();
  const missing = await post({ itemId: 'skill:user:nope', action: 'disable' });
  assert.equal(missing.status, 404);
  const known = await post({ itemId: 'skill:user:s1', action: 'disable' });
  assert.equal(known.status, 409);
  assert.equal((await known.json()).error.code, 'not-allowed');
});

test('a second action while one is running → 423 busy (I7)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slowCli: ClaudeCli = { async run() { await gate; return { code: 0, stdout: '[]', stderr: '' }; } };
  const { post } = await start(slowCli);
  const first = post({ itemId: 'skill:user:s1', action: 'disable' });
  await new Promise((r) => setTimeout(r, 50));
  const second = await post({ itemId: 'skill:user:s1', action: 'disable' });
  assert.equal(second.status, 423);
  release();
  assert.equal((await first).status, 409);
});
