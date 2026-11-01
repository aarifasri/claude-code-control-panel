// MCP servers as inventory items, from `claude mcp list` (slow: it health-checks every server).

import type { ClaudeCli, InstalledPlugin } from '../adapters/cli.ts';
import type { ClaudeJsonSummary } from '../adapters/claudeJson.ts';
import { parseMcpList, type McpEntry, type McpStatus } from '../adapters/parsers/mcpList.ts';
import { itemId } from '../domain/ids.ts';
import { actionsFor, type RuleContext } from '../domain/rules.ts';
import type { Item, ItemState, Scope } from '../domain/types.ts';

export interface McpItem extends Item {
  mcp: { target: string; transport?: string; status: McpStatus; statusText: string };
}

const STATE: Record<McpStatus, ItemState> = {
  connected: 'on', 'needs-auth': 'partial', failed: 'unknown', 'not-configured': 'off', unknown: 'unknown',
};

const STATUS_TEXT: Record<McpStatus, string> = {
  connected: 'Connected', 'needs-auth': 'Needs sign-in', failed: 'Failed to connect', 'not-configured': 'Not configured', unknown: 'Unknown',
};

function scopeOf(e: McpEntry, summary: ClaudeJsonSummary, cwd: string): Scope {
  if (e.origin.type === 'connector') return 'connector';
  if (e.origin.type === 'plugin') return 'plugin';
  if (summary.userMcpServers.includes(e.name)) return 'user';
  const normalized = cwd.replace(/\\/g, '/').toLowerCase();
  const local = Object.entries(summary.localMcpServers).find(([p]) => p.replace(/\\/g, '/').toLowerCase() === normalized);
  if (local?.[1].includes(e.name)) return 'local';
  return 'project';
}

/** Rule context for MCP items: they never write settings files, only call the CLI. */
function mcpRuleContext(project: string | undefined): RuleContext {
  return { layers: [], targetFile: '', isWritable: () => false, ...(project ? { project } : {}) };
}

function sameFolder(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}

/**
 * Configured (non-plugin, non-connector) MCP servers straight from ~/.claude.json, without the slow
 * health check. Used to validate a remove request against fresh data (I3).
 */
export function configuredMcpItems(summary: ClaudeJsonSummary, project: string | undefined): Item[] {
  const local = project ? Object.entries(summary.localMcpServers).find(([p]) => sameFolder(p, project))?.[1] ?? [] : [];
  const entries: [string, Scope][] = [...summary.userMcpServers.map((n): [string, Scope] => [n, 'user']), ...local.map((n): [string, Scope] => [n, 'local'])];
  return entries.map(([name, scope]) => {
    const item: Item = {
      id: itemId('mcp', scope, name), kind: 'mcp', key: name, name, description: '', scope,
      origin: { type: 'standalone' }, state: 'unknown', actions: {}, warnings: [],
    };
    item.actions = actionsFor(item, mcpRuleContext(project));
    return item;
  });
}

export async function listMcp(opts: { cli: ClaudeCli; summary: ClaudeJsonSummary; plugins: InstalledPlugin[]; cwd: string; project?: string }): Promise<{ items: McpItem[]; unparsed: string[] }> {
  const res = await opts.cli.run(['mcp', 'list'], 180_000, opts.cwd);
  if (res.code !== 0) throw new Error(`claude mcp list failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
  const { entries, unparsed } = parseMcpList(res.stdout);

  const items = entries.map((e): McpItem => {
    const scope = scopeOf(e, opts.summary, opts.cwd);
    const plugin = e.origin.type === 'plugin'
      ? opts.plugins.find((p) => p.id.split('@')[0] === (e.origin as { pluginName: string }).pluginName)
      : undefined;
    const origin: Item['origin'] = e.origin.type === 'connector'
      ? { type: 'connector' }
      : plugin ? { type: 'plugin', pluginId: plugin.id } : { type: 'standalone' };
    return {
      id: itemId('mcp', scope, e.name), kind: 'mcp', key: e.name, name: e.shortName,
      description: `${STATUS_TEXT[e.status]} · ${e.target || '(no address configured)'}`,
      scope, origin, state: STATE[e.status],
      stateSource: { level: 'cli', file: 'claude mcp list', detail: e.statusText },
      actions: {}, warnings: [],
      mcp: { target: e.target, ...(e.transport ? { transport: e.transport } : {}), status: e.status, statusText: e.statusText },
    };
  });
  for (const item of items) item.actions = actionsFor(item, mcpRuleContext(opts.project));
  return { items, unparsed };
}
