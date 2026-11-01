// Local HTTP server: serves the page and a JSON API. Binds to 127.0.0.1 only (NFR-S1).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaudeJsonSummary } from './adapters/claudeJson.ts';
import { CliError, listPlugins, realCli } from './adapters/cli.ts';
import { getCosts } from './services/costs.ts';
import { buildInventory } from './services/inventory.ts';
import { listMcp } from './services/mcp.ts';

const HOST = '127.0.0.1';
const FIRST_PORT = Number(process.env.CCP_PORT ?? 4317);
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MANAGED_SETTINGS = process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json' : undefined;
/** App-owned storage (docs/DATA_MODEL.md §7). */
const APP_DIR = join(homedir(), '.claude-control-panel');

let port = FIRST_PORT;

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

function apiError(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } });
}

/** Reject requests whose Host isn't us. Blocks DNS-rebinding attacks from other websites. */
function hostAllowed(req: IncomingMessage): boolean {
  return req.headers.host === `${HOST}:${port}` || req.headers.host === `localhost:${port}`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostAllowed(req)) return apiError(res, 403, 'bad-host', 'Requests must come from this computer.');
  const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);

  if (req.method === 'GET' && url.pathname in STATIC) {
    const file = STATIC[url.pathname]!;
    return send(res, 200, await readFile(join(PUBLIC_DIR, file), 'utf8'), TYPES[extname(file)]!);
  }

  if (req.method === 'GET' && url.pathname === '/api/inventory') {
    try {
      const inv = await buildInventory({ home: homedir(), cli: realCli, managedSettingsPath: MANAGED_SETTINGS });
      return json(res, 200, {
        items: inv.items,
        layers: inv.layers.map(({ level, file, data, error }) => ({ level, file, exists: data !== null, error })),
        generatedAt: inv.generatedAt,
      });
    } catch (e) {
      const message = e instanceof CliError ? e.message : `Could not build inventory: ${(e as Error).message}`;
      return apiError(res, 500, 'inventory-failed', message);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/costs') {
    try {
      const plugins = await listPlugins(realCli);
      return json(res, 200, await getCosts({ cli: realCli, plugins, cacheFile: join(APP_DIR, 'cache', 'costs.json') }));
    } catch (e) {
      return apiError(res, 500, 'costs-failed', (e as Error).message);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/mcp') {
    try {
      const [plugins, summary] = await Promise.all([listPlugins(realCli), readClaudeJsonSummary(homedir())]);
      return json(res, 200, await listMcp({ cli: realCli, summary, plugins, cwd: process.cwd() }));
    } catch (e) {
      return apiError(res, 500, 'mcp-failed', (e as Error).message);
    }
  }

  return apiError(res, 404, 'not-found', 'Not found');
}

const server = createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    console.error(e);
    if (!res.headersSent) apiError(res, 500, 'internal', 'Unexpected server error');
  });
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' && port < FIRST_PORT + 10) {
    port += 1;
    server.listen(port, HOST);
  } else {
    console.error(`Could not start server: ${e.message}`);
    process.exit(1);
  }
});

server.on('listening', () => console.log(`Claude Code Control Panel → http://${HOST}:${port}`));
server.listen(port, HOST);
