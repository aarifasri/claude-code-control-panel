// Read a names-only summary of ~/.claude.json. That file holds MCP server configs (which may contain
// secrets in env/headers) and is rewritten constantly by Claude Code, so we only ever READ it, and
// only return names, never values (invariant I6).

import { join } from 'node:path';
import { readJsonObject } from './jsonFile.ts';

export interface ClaudeJsonSummary {
  /** User-scope MCP server names. */
  userMcpServers: string[];
  /** Local-scope MCP server names per project path. */
  localMcpServers: Record<string, string[]>;
  /** Project folders Claude Code has been used in. */
  projects: string[];
  error?: string;
}

function keys(v: unknown): string[] {
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
}

export async function readClaudeJsonSummary(home: string): Promise<ClaudeJsonSummary> {
  const { data, error } = await readJsonObject(join(home, '.claude.json'));
  const projectsObj = (data?.projects ?? {}) as Record<string, { mcpServers?: unknown }>;
  const localMcpServers: Record<string, string[]> = {};
  for (const [path, p] of Object.entries(projectsObj)) {
    const names = keys(p?.mcpServers);
    if (names.length) localMcpServers[path] = names;
  }
  return {
    userMcpServers: keys(data?.mcpServers),
    localMcpServers,
    projects: keys(projectsObj),
    ...(error ? { error } : {}),
  };
}
