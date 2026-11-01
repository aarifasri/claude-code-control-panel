// Which project folders can be picked for project view (F7). Only folders Claude Code itself has
// been used in, that still exist, and that aren't the home folder (whose .claude/settings.json is
// the *user* settings file, so treating it as a project would count the same file twice).

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readClaudeJsonSummary } from '../adapters/claudeJson.ts';

export interface ProjectChoice {
  /** Absolute path in this OS's native form. */
  path: string;
  /** Last folder name, for display. */
  name: string;
}

function key(p: string): string {
  const r = resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export async function listProjects(home: string): Promise<ProjectChoice[]> {
  const { projects } = await readClaudeJsonSummary(home);
  const seen = new Set<string>([key(home)]);
  const out: ProjectChoice[] = [];
  for (const raw of projects) {
    const k = key(raw);
    if (seen.has(k)) continue;
    seen.add(k);
    const path = resolve(raw);
    if (!(await stat(path).then((s) => s.isDirectory(), () => false))) continue;
    out.push({ path, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a project path from the browser to one of the allowed choices, or null. Never trusts the raw string. */
export async function resolveProject(home: string, requested: string | null | undefined): Promise<string | null> {
  if (!requested) return null;
  const k = key(requested);
  const match = (await listProjects(home)).find((p) => key(p.path) === k);
  return match ? match.path : null;
}
