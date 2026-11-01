import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildInventory } from '../../src/services/inventory.ts';
import { fakeCli, fakeTree, md } from '../helpers.ts';

async function setup() {
  const home = await fakeTree({
    '.claude/settings.json': {
      skillOverrides: { 'off-skill': 'off' },
      permissions: { deny: ['Agent(Blocked Agent)'] },
      unrelated: { keep: true },
    },
    '.claude/skills/my-folder/SKILL.md': md({ name: 'front-name', description: 'Folder name is the key' }),
    '.claude/skills/off-skill/SKILL.md': md({ description: 'Turned off' }),
    '.claude/skills/broken/SKILL.md': '---\nname: [oops\n---\n',
    '.claude/skills/not-a-skill/README.md': 'no SKILL.md here',
    '.claude/commands/do-thing.md': md({ description: 'A command' }),
    '.claude/agents/file-name.md': md({ name: 'Blocked Agent', description: 'Blocked by deny' }),
    '.claude/agents/plain.md': md({ description: 'No name field' }),
    'plugins/p1/.claude-plugin/plugin.json': { name: 'p1', description: 'Plugin one', skills: ['./extra/solo'] },
    'plugins/p1/skills/s1/SKILL.md': md({ description: 'Plugin skill' }),
    'plugins/p1/extra/solo/SKILL.md': md({ description: 'Custom-path skill' }),
    'plugins/p1/agents/a1.md': md({ name: 'p1-agent', description: 'Plugin agent' }),
  });
  const cli = fakeCli({
    'plugin list --json': {
      stdout: JSON.stringify([
        { id: 'p1@mkt', version: '1.0.0', scope: 'user', enabled: false, installPath: join(home, 'plugins/p1') },
      ]),
    },
  });
  return { home, cli };
}

test('lists standalone skills keyed by folder name, with descriptions', async () => {
  const { home, cli } = await setup();
  const { items } = await buildInventory({ home, cli });
  const skill = items.find((i) => i.id === 'skill:user:my-folder');
  assert.ok(skill);
  assert.equal(skill.key, 'my-folder');
  assert.equal(skill.name, 'front-name');
  assert.equal(skill.description, 'Folder name is the key');
  assert.equal(skill.state, 'on');
});

test('skips folders without SKILL.md', async () => {
  const { home, cli } = await setup();
  const { items } = await buildInventory({ home, cli });
  assert.equal(items.some((i) => i.key === 'not-a-skill'), false);
});

test('skill override from settings makes it off, with the reason', async () => {
  const { home, cli } = await setup();
  const { items } = await buildInventory({ home, cli });
  const off = items.find((i) => i.id === 'skill:user:off-skill');
  assert.equal(off?.state, 'off');
  assert.equal(off?.stateSource?.level, 'user');
});

test('broken frontmatter still lists the item with a warning', async () => {
  const { home, cli } = await setup();
  const { items } = await buildInventory({ home, cli });
  const broken = items.find((i) => i.id === 'skill:user:broken');
  assert.ok(broken);
  assert.match(broken.warnings.join(), /invalid frontmatter/);
});

test('commands are listed as skills with variant "command"', async () => {
  const { home, cli } = await setup();
  const { items } = await buildInventory({ home, cli });
  const cmd = items.find((i) => i.id === 'command:user:do-thing');
  assert.equal(cmd?.kind, 'skill');
  assert.equal(cmd?.variant, 'command');
});

test('a skill and a command with the same name get distinct ids', async () => {
  const home = await fakeTree({
    '.claude/skills/same/SKILL.md': md({ description: 'skill' }),
    '.claude/commands/same.md': md({ description: 'command' }),
  });
  const { items } = await buildInventory({ home, cli: fakeCli({ 'plugin list --json': { stdout: '[]' } }) });
  const ids = items.filter((i) => i.kind === 'skill').map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.sort(), ['command:user:same', 'skill:user:same']);
});

test('command without frontmatter uses its first line as description, without warning', async () => {
  const home = await fakeTree({ '.claude/commands/plain.md': '\n# Do the plain thing\nmore text' });
  const { items } = await buildInventory({ home, cli: fakeCli({ 'plugin list --json': { stdout: '[]' } }) });
  const cmd = items.find((i) => i.id === 'command:user:plain');
  assert.equal(cmd?.description, 'Do the plain thing');
  assert.deepEqual(cmd?.warnings, []);
});

test('user-invocable: false is recorded as hiddenFromMenu', async () => {
  const home = await fakeTree({ '.claude/skills/quiet/SKILL.md': '---\ndescription: d\nuser-invocable: false\n---\n' });
  const { items } = await buildInventory({ home, cli: fakeCli({ 'plugin list --json': { stdout: '[]' } }) });
  assert.equal(items.find((i) => i.id === 'skill:user:quiet')?.hiddenFromMenu, true);
});

test('skill without frontmatter still warns, but gets a first-line description', async () => {
  const home = await fakeTree({ '.claude/skills/nofm/SKILL.md': 'Use this when testing.\n' });
  const { items } = await buildInventory({ home, cli: fakeCli({ 'plugin list --json': { stdout: '[]' } }) });
  const s = items.find((i) => i.id === 'skill:user:nofm');
  assert.equal(s?.description, 'Use this when testing.');
  assert.deepEqual(s?.warnings, ['no frontmatter block']);
});

test('agents keyed by frontmatter name, falling back to filename; deny = blocked', async () => {
  const { home, cli } = await setup();
  const { items } = await buildInventory({ home, cli });
  assert.equal(items.find((i) => i.id === 'agent:user:Blocked Agent')?.state, 'blocked');
  assert.equal(items.find((i) => i.id === 'agent:user:plain')?.state, 'on');
});

test('plugins list their components, including custom manifest paths', async () => {
  const { home, cli } = await setup();
  const { items } = await buildInventory({ home, cli });
  const plugin = items.find((i) => i.id === 'plugin:user:p1@mkt');
  assert.equal(plugin?.description, 'Plugin one');
  assert.equal(plugin?.state, 'off');
  assert.deepEqual(plugin?.contents, { skills: 2, agents: 1, commands: 0 });
  const child = items.find((i) => i.id === 'skill:plugin:p1@mkt:p1:solo');
  assert.equal(child?.state, 'off', 'components follow the plugin state');
  assert.deepEqual(child?.origin, { type: 'plugin', pluginId: 'p1@mkt' });
});

test('project view adds project items and project/local layers', async () => {
  const { home, cli } = await setup();
  const project = await fakeTree({
    '.claude/settings.local.json': { skillOverrides: { 'proj-skill': 'off' } },
    '.claude/skills/proj-skill/SKILL.md': md({ description: 'Project skill' }),
  });
  const { items, layers } = await buildInventory({ home, cli, project });
  assert.deepEqual(layers.map((l) => l.level), ['user', 'project', 'local']);
  const p = items.find((i) => i.kind === 'skill' && i.scope === 'project' && i.key === 'proj-skill');
  assert.equal(p?.state, 'off');
  assert.equal(p?.stateSource?.level, 'local');
});

test('CLI failure surfaces as an error, not an empty list', async () => {
  const home = await fakeTree({});
  const cli = fakeCli({ 'plugin list --json': { code: 1, stderr: 'boom' } });
  await assert.rejects(buildInventory({ home, cli }), /plugin list failed.*boom/);
});
