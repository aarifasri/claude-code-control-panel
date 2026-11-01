// Parse the human-readable output of `claude mcp list`.
// Each server line looks like:  <name>: <target> - <mark> <status text>

import { redactCommandLine } from '../redact.ts';

export type McpStatus = 'connected' | 'needs-auth' | 'failed' | 'not-configured' | 'unknown';
export type McpOrigin = { type: 'connector' } | { type: 'plugin'; pluginName: string } | { type: 'configured' };

export interface McpEntry {
  /** Full name as Claude Code prints it, e.g. "plugin:ecc:chrome-devtools". */
  name: string;
  /** Server name without the plugin prefix, e.g. "chrome-devtools". */
  shortName: string;
  origin: McpOrigin;
  /** Command or URL, with secret-looking parts masked. */
  target: string;
  transport?: string;
  status: McpStatus;
  statusText: string;
}

const LINE = /^(.*) - ([✔✘!-]) (.*)$/u;

function statusOf(mark: string, text: string): McpStatus {
  if (mark === '✔') return 'connected';
  if (mark === '✘') return 'failed';
  if (mark === '!' && /auth/i.test(text)) return 'needs-auth';
  if (mark === '-' && /not configured/i.test(text)) return 'not-configured';
  return 'unknown';
}

function originOf(name: string): { origin: McpOrigin; shortName: string } {
  if (name.startsWith('claude.ai ')) return { origin: { type: 'connector' }, shortName: name.slice('claude.ai '.length) };
  const plugin = /^plugin:([^:]+):(.+)$/.exec(name);
  if (plugin) return { origin: { type: 'plugin', pluginName: plugin[1]! }, shortName: plugin[2]! };
  return { origin: { type: 'configured' }, shortName: name };
}

export function parseMcpList(output: string): { entries: McpEntry[]; unparsed: string[] } {
  const entries: McpEntry[] = [];
  const unparsed: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || /^Checking MCP server health/i.test(line) || /^No MCP servers configured/i.test(line)) continue;
    const sep = line.indexOf(': ');
    const m = sep === -1 ? null : LINE.exec(line.slice(sep + 2));
    if (!m) { unparsed.push(redactCommandLine(line)); continue; }

    const name = line.slice(0, sep);
    let target = m[1]!.trim();
    let transport: string | undefined;
    const t = /^(.*?)\s*\((HTTP|SSE|WS|WebSocket|stdio)\)$/i.exec(target);
    if (t) { target = t[1]!.trim(); transport = t[2]!.toLowerCase(); }

    const statusText = m[3]!.replace(/^—\s*/, '').trim();
    entries.push({
      name, ...originOf(name), target: redactCommandLine(target), ...(transport ? { transport } : {}),
      status: statusOf(m[2]!, statusText), statusText: redactCommandLine(statusText),
    });
  }
  return { entries, unparsed };
}
