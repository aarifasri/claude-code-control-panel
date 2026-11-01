// Starts the local server. Binds to 127.0.0.1 only (NFR-S1); request handling lives in app.ts.

import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realCli } from './adapters/cli.ts';
import { createApp } from './app.ts';

const HOST = '127.0.0.1';
const FIRST_PORT = Number(process.env.CCP_PORT ?? 4317);
let port = FIRST_PORT;

const { handler } = createApp({
  home: homedir(),
  appDir: join(homedir(), '.claude-control-panel'),
  cli: realCli,
  cwd: process.cwd(),
  getPort: () => port,
  ...(process.platform === 'win32' ? { managedSettingsPath: 'C:\\Program Files\\ClaudeCode\\managed-settings.json' } : {}),
});

const server = createServer(handler);

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
