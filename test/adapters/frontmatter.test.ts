import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../../src/adapters/frontmatter.ts';

test('parses name and description', () => {
  const fm = parseFrontmatter('---\nname: x\ndescription: Does a thing\n---\nbody');
  assert.deepEqual(fm, { data: { name: 'x', description: 'Does a thing' } });
});

test('handles CRLF line endings and a BOM', () => {
  const fm = parseFrontmatter('﻿---\r\nname: x\r\n---\r\nbody');
  assert.equal(fm.data.name, 'x');
  assert.equal(fm.error, undefined);
});

test('multi-line YAML values', () => {
  const fm = parseFrontmatter('---\ndescription: >\n  line one\n  line two\ntools:\n  - Bash\n---\n');
  assert.equal(fm.data.description, 'line one line two\n');
  assert.deepEqual(fm.data.tools, ['Bash']);
});

test('missing frontmatter reports an error but does not throw', () => {
  assert.deepEqual(parseFrontmatter('# Just markdown'), { data: {}, error: 'no frontmatter block' });
});

test('malformed YAML reports an error but does not throw', () => {
  const fm = parseFrontmatter('---\nname: [unclosed\n---\n');
  assert.deepEqual(fm.data, {});
  assert.match(fm.error ?? '', /invalid frontmatter/);
});

test('empty frontmatter block is fine', () => {
  assert.deepEqual(parseFrontmatter('---\n\n---\n'), { data: {} });
});
