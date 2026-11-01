// Parse the YAML frontmatter block at the top of a skill/agent/command Markdown file.

import { parse } from 'yaml';

export interface Frontmatter {
  data: Record<string, unknown>;
  error?: string;
}

const BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(text: string): Frontmatter {
  const body = text.replace(/^﻿/, '');
  const match = BLOCK.exec(body);
  if (!match) return { data: {}, error: 'no frontmatter block' };
  try {
    const parsed: unknown = parse(match[1] ?? '');
    if (parsed === null || parsed === undefined) return { data: {} };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return { data: {}, error: 'frontmatter is not a key/value map' };
    return { data: parsed as Record<string, unknown> };
  } catch (e) {
    return { data: {}, error: `invalid frontmatter: ${(e as Error).message.split('\n')[0]}` };
  }
}

export function stringField(data: Record<string, unknown>, field: string): string | undefined {
  const v = data[field];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}
