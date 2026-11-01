// Test helpers: build a fake home folder on disk, and a fake `claude` CLI.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ClaudeCli, CliResult } from '../src/adapters/cli.ts';

/** Create files from a { relativePath: content } map under a new temp folder. */
export async function fakeTree(files: Record<string, string | object>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ccp-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

/** Fake CLI: answers by joined args; records every call. */
export function fakeCli(answers: Record<string, Partial<CliResult>>): ClaudeCli & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      const a = answers[args.join(' ')];
      if (!a) return { code: 1, stdout: '', stderr: `fake cli: no answer for "${args.join(' ')}"` };
      return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
    },
  };
}

export const md = (front: Record<string, string>, body = 'body') =>
  `---\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;
