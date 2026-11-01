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
  /** Frontmatter `user-invocable: false`: hidden from the / menu (and from Claude Code's init skill list). */
  hiddenFromMenu?: boolean;
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
  return {
    key, name: stringField(md.data, 'name') ?? key, description: description(md), path: folder, warnings,
    ...(md.data['user-invocable'] === false ? { hiddenFromMenu: true } : {}),
  };
}

/**
 * Skills from one or more locations. Each location is either a skill folder itself
 * (contains SKILL.md) or a folder of skill folders. Folders without SKILL.md are skipped.
 */
// File reads below run in parallel (Promise.all): reading ~1,200 files one after another took seconds.

/** Skill folders under one location: the location itself if it holds SKILL.md, else its subfolders that do. */
async function skillFolders(loc: string): Promise<string[]> {
  if (await isFile(join(loc, 'SKILL.md'))) return [loc];
  if (!(await isDir(loc))) return [];
  const candidates = (await readdir(loc)).map((entry) => join(loc, entry));
  const checks = await Promise.all(candidates.map((f) => isFile(join(f, 'SKILL.md'))));
  return candidates.filter((_, i) => checks[i]);
}

export async function readSkills(locations: string[]): Promise<FoundComponent[]> {
  const folders = new Map<string, string>();
  for (const list of await Promise.all(locations.map(skillFolders))) for (const f of list) folders.set(resolve(f), f);
  return Promise.all([...folders.values()].map(readSkillFolder));
}

/** Markdown files from locations that are either `.md` files or folders of them. */
async function markdownFiles(locations: string[]): Promise<string[]> {
  const lists = await Promise.all(locations.map(async (loc) => {
    if (loc.endsWith('.md')) return (await isFile(loc)) ? [resolve(loc)] : [];
    if (!(await isDir(loc))) return [];
    return (await readdir(loc)).filter((e) => e.endsWith('.md')).map((e) => resolve(join(loc, e)));
  }));
  return [...new Set(lists.flat())];
}

export async function readAgents(locations: string[]): Promise<FoundComponent[]> {
  return Promise.all((await markdownFiles(locations)).map(async (file) => {
    const md = await readMarkdown(file);
    const name = stringField(md.data, 'name') ?? basename(file, '.md');
    const warnings = md.frontmatterError ? [...md.warnings, md.frontmatterError] : md.warnings;
    return { key: name, name, description: description(md), path: file, warnings };
  }));
}

/** Commands: frontmatter is optional, so a missing block is not a warning (a broken one is). */
export async function readCommands(locations: string[]): Promise<FoundComponent[]> {
  return Promise.all((await markdownFiles(locations)).map(async (file) => {
    const md = await readMarkdown(file);
    const key = basename(file, '.md');
    const broken = md.frontmatterError && md.frontmatterError !== 'no frontmatter block';
    return { key, name: key, description: description(md), path: file, warnings: broken ? [...md.warnings, md.frontmatterError!] : md.warnings };
  }));
}
