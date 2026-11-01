// Read skills, agents and commands from a `.claude`-style folder or a plugin folder.

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseFrontmatter, stringField } from './frontmatter.ts';

export interface FoundComponent {
  /** Identifier Claude Code uses (D-006): skill folder name, agent frontmatter name, command file name. */
  key: string;
  name: string;
  description: string;
  path: string;
  warnings: string[];
}

async function isDir(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isDirectory(), () => false);
}

async function isFile(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isFile(), () => false);
}

interface Markdown {
  data: Record<string, unknown>;
  /** First non-empty body line, without leading '#'. Claude Code uses it when there is no description. */
  firstLine: string;
  /** Frontmatter problem, if any. Callers decide whether it deserves a warning. */
  frontmatterError?: string;
  warnings: string[];
}

async function readMarkdown(path: string): Promise<Markdown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    return { data: {}, firstLine: '', warnings: [`could not read file: ${(e as NodeJS.ErrnoException).code ?? 'error'}`] };
  }
  const fm = parseFrontmatter(text);
  const body = fm.error === 'no frontmatter block' ? text : text.replace(/^﻿?---[\s\S]*?\n---[^\n]*\n?/, '');
  const firstLine = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l !== '') ?? '';
  return { data: fm.data, firstLine: firstLine.slice(0, 300), ...(fm.error ? { frontmatterError: fm.error } : {}), warnings: [] };
}

function description(md: Markdown): string {
  return stringField(md.data, 'description') ?? md.firstLine;
}

async function readSkillFolder(folder: string): Promise<FoundComponent> {
  const key = basename(folder);
  const md = await readMarkdown(join(folder, 'SKILL.md'));
  const warnings = md.frontmatterError ? [...md.warnings, md.frontmatterError] : md.warnings;
  return { key, name: stringField(md.data, 'name') ?? key, description: description(md), path: folder, warnings };
}

/**
 * Skills from one or more locations. Each location is either a skill folder itself
 * (contains SKILL.md) or a folder of skill folders. Folders without SKILL.md are skipped.
 */
export async function readSkills(locations: string[]): Promise<FoundComponent[]> {
  const found = new Map<string, FoundComponent>();
  for (const loc of locations) {
    if (await isFile(join(loc, 'SKILL.md'))) {
      found.set(resolve(loc), await readSkillFolder(loc));
      continue;
    }
    if (!(await isDir(loc))) continue;
    for (const entry of await readdir(loc)) {
      const folder = join(loc, entry);
      if (await isFile(join(folder, 'SKILL.md'))) found.set(resolve(folder), await readSkillFolder(folder));
    }
  }
  return [...found.values()];
}

/** Markdown files from locations that are either `.md` files or folders of them. */
async function markdownFiles(locations: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const loc of locations) {
    if (loc.endsWith('.md') && (await isFile(loc))) files.add(resolve(loc));
    else if (await isDir(loc)) {
      for (const entry of await readdir(loc)) if (entry.endsWith('.md')) files.add(resolve(join(loc, entry)));
    }
  }
  return [...files];
}

export async function readAgents(locations: string[]): Promise<FoundComponent[]> {
  const out: FoundComponent[] = [];
  for (const file of await markdownFiles(locations)) {
    const md = await readMarkdown(file);
    const name = stringField(md.data, 'name') ?? basename(file, '.md');
    const warnings = md.frontmatterError ? [...md.warnings, md.frontmatterError] : md.warnings;
    out.push({ key: name, name, description: description(md), path: file, warnings });
  }
  return out;
}

/** Commands: frontmatter is optional, so a missing block is not a warning (a broken one is). */
export async function readCommands(locations: string[]): Promise<FoundComponent[]> {
  const out: FoundComponent[] = [];
  for (const file of await markdownFiles(locations)) {
    const md = await readMarkdown(file);
    const key = basename(file, '.md');
    const broken = md.frontmatterError && md.frontmatterError !== 'no frontmatter block';
    out.push({ key, name: key, description: description(md), path: file, warnings: broken ? [...md.warnings, md.frontmatterError!] : md.warnings });
  }
  return out;
}
