// Which files the app may ever write (invariant I2). Pure: no file access.

import { join, resolve } from 'node:path';

export interface WriteScope {
  home: string;
  /** App-owned folder (~/.claude-control-panel). */
  appDir: string;
  /** Project folders the user may target. */
  projects: string[];
  /** Windows paths compare case-insensitively. */
  caseInsensitive?: boolean;
}

function norm(p: string, ci: boolean): string {
  const r = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return ci ? r.toLowerCase() : r;
}

export function userSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

/** Personal, uncommitted project settings (BR-4). The shared .claude/settings.json is never written. */
export function projectLocalSettingsPath(project: string): string {
  return join(project, '.claude', 'settings.local.json');
}

export function allowedSettingsFiles(scope: WriteScope): string[] {
  return [userSettingsPath(scope.home), ...scope.projects.map(projectLocalSettingsPath)];
}

export function isAllowedSettingsFile(path: string, scope: WriteScope): boolean {
  const ci = scope.caseInsensitive ?? process.platform === 'win32';
  const target = norm(path, ci);
  return allowedSettingsFiles(scope).some((p) => norm(p, ci) === target);
}

/** True for paths strictly inside the app folder (never the folder itself, never via `..`). */
export function isInsideAppDir(path: string, scope: WriteScope): boolean {
  const ci = scope.caseInsensitive ?? process.platform === 'win32';
  const dir = norm(scope.appDir, ci);
  return norm(path, ci).startsWith(`${dir}/`);
}
