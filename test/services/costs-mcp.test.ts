import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readClaudeJsonSummary } from '../../src/adapters/claudeJson.ts';
import { getCosts } from '../../src/services/costs.ts';
import { listMcp } from '../../src/services/mcp.ts';
import { fakeCli, fakeTree } from '../helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const plugin = (id: string, version = '1.0.0') => ({ id, version, scope: 'user', enabled: true, installPath: '' });

test('costs: fetches missing plugins, then serves them from cache', async () => {
  const dir = await fakeTree({});
  const cacheFile = join(dir, 'cache', 'costs.json');
  const cli = fakeCli({ 'plugin details fd@m': { stdout: fixture('details-frontend-design.txt') } });

  const first = await getCosts({ cli, plugins: [plugin('fd@m')], cacheFile });
  assert.equal(first['fd@m']?.alwaysOn, 80);
  assert.equal(cli.calls.length, 1);

  const second = await getCosts({ cli, plugins: [plugin('fd@m')], cacheFile });
  assert.equal(second['fd@m']?.alwaysOn, 80);
  assert.equal(cli.calls.length, 1, 'second call served from cache');
  assert.ok(JSON.parse(await readFile(cacheFile, 'utf8'))['fd@m']);
});

test('costs: a new plugin version invalidates the cache entry', async () => {
  const dir = await fakeTree({});
  const cacheFile = join(dir, 'costs.json');
  const cli = fakeCli({ 'plugin details fd@m': { stdout: fixture('details-frontend-design.txt') } });
  await getCosts({ cli, plugins: [plugin('fd@m', '1.0.0')], cacheFile });
  await getCosts({ cli, plugins: [plugin('fd@m', '1.1.0')], cacheFile });
  assert.equal(cli.calls.length, 2);
});

test('costs: CLI failure is reported per plugin and not cached as good', async () => {
  const dir = await fakeTree({});
  const cacheFile = join(dir, 'costs.json');
  const cli = fakeCli({ 'plugin details ok@m': { stdout: fixture('details-frontend-design.txt') }, 'plugin details bad@m': { code: 2, stderr: 'nope' } });
  const costs = await getCosts({ cli, plugins: [plugin('ok@m'), plugin('bad@m')], cacheFile });
  assert.equal(costs['ok@m']?.alwaysOn, 80);
  assert.match(costs['bad@m']?.parseError ?? '', /exit 2.*nope/);
  await getCosts({ cli, plugins: [plugin('ok@m'), plugin('bad@m')], cacheFile });
  assert.deepEqual(cli.calls.map((c) => c[2]), ['ok@m', 'bad@m', 'bad@m'], 'failed one is retried, good one cached');
});

test('claude.json summary returns names only, never values', async () => {
  const home = await fakeTree({
    '.claude.json': {
      mcpServers: { srv: { command: 'x', env: { API_KEY: 'super-secret' } } },
      projects: { 'C:/proj': { mcpServers: { loc: { headers: { Authorization: 'Bearer secret' } } } }, 'C:/other': {} },
    },
  });
  const s = await readClaudeJsonSummary(home);
  assert.deepEqual(s, { userMcpServers: ['srv'], localMcpServers: { 'C:/proj': ['loc'] }, projects: ['C:/proj', 'C:/other'] });
  assert.doesNotMatch(JSON.stringify(s), /secret/);
});

test('mcp items: scope, origin, state from the real sample', async () => {
  const cli = fakeCli({ 'mcp list': { stdout: fixture('mcp-list.txt') } });
  const summary = { userMcpServers: ['playwright', 'aws-mcp', 'rea'], localMcpServers: {}, projects: [] };
  const { items, unparsed } = await listMcp({ cli, summary, plugins: [plugin('ecc@ecc')], cwd: 'C:/x' });
  assert.deepEqual(unparsed, []);
  const by = (k: string) => items.find((i) => i.key === k)!;

  assert.deepEqual([by('playwright').scope, by('playwright').state], ['user', 'on']);
  assert.deepEqual([by('aws-mcp').scope, by('aws-mcp').mcp.status], ['user', 'failed']);
  assert.deepEqual([by('claude.ai Gmail').scope, by('claude.ai Gmail').origin], ['connector', { type: 'connector' }]);
  assert.deepEqual(by('plugin:ecc:chrome-devtools').origin, { type: 'plugin', pluginId: 'ecc@ecc' });
  assert.equal(by('plugin:design:slack').state, 'partial');
  assert.equal(by('plugin:design:gmail').state, 'off');
});

test('mcp list CLI failure is an error, not an empty list', async () => {
  const cli = fakeCli({ 'mcp list': { code: 1, stderr: 'broken' } });
  await assert.rejects(listMcp({ cli, summary: { userMcpServers: [], localMcpServers: {}, projects: [] }, plugins: [], cwd: '' }), /broken/);
});
