// Stable item IDs. See docs/DATA_MODEL.md §3.

import { createHash } from 'node:crypto';
import type { Kind, Scope } from './types.ts';

/** Short hash of a project path, so IDs stay readable but unique per project. */
export function projectHash(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return createHash('sha1').update(normalized).digest('hex').slice(0, 6);
}

/** 'command' gets its own prefix: a plugin may ship a skill and a command with the same name. */
export function itemId(kind: Kind | 'command', scope: Scope, key: string, qualifier?: string): string {
  return [kind, scope, qualifier, key].filter((p) => p !== undefined && p !== '').join(':');
}
