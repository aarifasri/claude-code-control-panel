// HTTP request handling and the security checks around it. `server.ts` only starts it,
// so tests can run this handler against a fake home folder and a fake CLI.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaudeJsonSummary } from './adapters/claudeJson.ts';
import { CliError, listPlugins, type ClaudeCli, type InstalledPlugin } from './adapters/cli.ts';
import type { ActionName } from './domain/types.ts';
import { executeAction } from './services/actions.ts';
import { getCosts } from './services/costs.ts';
import { buildInventory } from './services/inventory.ts';
import { ActionLock } from './services/lock.ts';
import { listMcp } from './services/mcp.ts';

export interface AppConfig {
  home: string;
  /** App-owned storage (docs/DATA_MODEL.md §7). */
  appDir: string;
  cli: ClaudeCli;
  managedSettingsPath?: string;
  /** Folder `claude mcp list` runs in; decides which local-scope MCP servers it reports. */
  cwd: string;
  /** Port the server actually listens on (needed for Host/Origin checks). */
  getPort: () => number;
  /** Per-run secret embedded in the page; required on every write (NFR-S2). Random if omitted. */
  token?: string;
}

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ACTIONS: readonly ActionName[] = ['enable', 'disable', 'delete', 'restore'];
const MAX_BODY = 4 * 1024;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(400, 'invalid-request', 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid-request', 'Request body must be JSON');
  }
}

export function createApp(config: AppConfig) {
  const token = config.token ?? randomBytes(32).toString('hex');
  const lock = new ActionLock();
  const allowedHosts = () => [`127.0.0.1:${config.getPort()}`, `localhost:${config.getPort()}`];

  /** Blocks DNS-rebinding: a page on another site can't reach us under its own host name. */
  function checkHost(req: IncomingMessage): void {
    if (!allowedHosts().includes(req.headers.host ?? '')) throw new HttpError(403, 'bad-host', 'Requests must come from this computer.');
  }

  /** Every write must come from our own page (NFR-S2): right Origin, JSON body, and the page token. */
  function checkWriteRequest(req: IncomingMessage): void {
    const origin = req.headers.origin ?? '';
    if (!allowedHosts().some((h) => origin === `http://${h}`)) throw new HttpError(403, 'bad-origin', 'Changes can only be made from the control panel page.');
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(400, 'invalid-request', 'Content-Type must be application/json');
    const given = req.headers['x-ccp-token'];
    if (typeof given !== 'string' || !sameSecret(given, token)) throw new HttpError(403, 'bad-token', 'Missing or wrong page token. Reload the page.');
  }

  async function inventory(plugins?: InstalledPlugin[]) {
    return buildInventory({
      home: config.home, cli: config.cli,
      ...(config.managedSettingsPath ? { managedSettingsPath: config.managedSettingsPath } : {}),
      ...(plugins ? { plugins } : {}),
    });
  }

  async function handleAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    checkWriteRequest(req);
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid-request', 'Body must be a JSON object');
    const { itemId, action, confirm } = body as Record<string, unknown>;
    if (typeof itemId !== 'string' || itemId.length > 500) throw new HttpError(400, 'invalid-request', 'itemId must be a string');
    if (typeof action !== 'string' || !ACTIONS.includes(action as ActionName)) throw new HttpError(400, 'invalid-request', `action must be one of ${ACTIONS.join(', ')}`);
    if (action === 'delete' && confirm !== true) throw new HttpError(400, 'invalid-request', 'Deleting requires confirm: true');

    const outcome = await lock.tryRun(async () => {
      // I3: look the item up in a fresh inventory; never trust names or paths from the browser.
      const inv = await inventory();
      const item = inv.items.find((i) => i.id === itemId);
      if (!item) throw new HttpError(404, 'unknown-item', 'That item no longer exists. Refresh the page.');
      const availability = item.actions[action as ActionName];
      if (!availability || !availability.allowed) {
        throw new HttpError(409, 'not-allowed', availability?.reason ?? `"${action}" isn't available for this item yet.`);
      }
      try {
        // Skill/agent changes can't affect plugins, so the re-read reuses the plugin list (much faster).
        const reread = item.kind === 'plugin' ? () => inventory() : () => inventory(inv.plugins);
        return await executeAction(item, action as ActionName, inv, { cli: config.cli, home: config.home, appDir: config.appDir, projects: [], inventory: reread });
      } catch (e) {
        throw new HttpError(500, 'action-failed', (e as Error).message);
      }
    });
    if (!outcome.ran) throw new HttpError(423, 'busy', 'Another change is still running. Try again in a moment.');
    return json(res, 200, outcome.value);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    checkHost(req);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${config.getPort()}`);

    if (req.method === 'GET' && url.pathname in STATIC) {
      const file = STATIC[url.pathname]!;
      let text = await readFile(join(PUBLIC_DIR, file), 'utf8');
      if (file === 'index.html') text = text.replace('__CCP_TOKEN__', token);
      return send(res, 200, text, TYPES[extname(file)]!);
    }

    if (req.method === 'GET' && url.pathname === '/api/inventory') {
      try {
        const inv = await inventory();
        return json(res, 200, {
          items: inv.items,
          layers: inv.layers.map(({ level, file, data, error }) => ({ level, file, exists: data !== null, error })),
          generatedAt: inv.generatedAt,
        });
      } catch (e) {
        throw new HttpError(500, 'inventory-failed', e instanceof CliError ? e.message : `Could not build inventory: ${(e as Error).message}`);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/costs') {
      try {
        const plugins = await listPlugins(config.cli);
        return json(res, 200, await getCosts({ cli: config.cli, plugins, cacheFile: join(config.appDir, 'cache', 'costs.json') }));
      } catch (e) {
        throw new HttpError(500, 'costs-failed', (e as Error).message);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/mcp') {
      try {
        const [plugins, summary] = await Promise.all([listPlugins(config.cli), readClaudeJsonSummary(config.home)]);
        return json(res, 200, await listMcp({ cli: config.cli, summary, plugins, cwd: config.cwd }));
      } catch (e) {
        throw new HttpError(500, 'mcp-failed', (e as Error).message);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/actions') return handleAction(req, res);

    throw new HttpError(404, 'not-found', 'Not found');
  }

  function handler(req: IncomingMessage, res: ServerResponse): void {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return;
      if (e instanceof HttpError) return json(res, e.status, { error: { code: e.code, message: e.message } });
      console.error(e);
      json(res, 500, { error: { code: 'internal', message: 'Unexpected server error' } });
    });
  }

  return { handler, token };
}
