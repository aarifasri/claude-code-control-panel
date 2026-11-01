// The only place that runs the `claude` CLI. Always an argument array, never a shell (D-004).

import { execFile, spawn } from 'node:child_process';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface InstalledPlugin {
  id: string;
  version?: string;
  scope: string;
  enabled: boolean;
  installPath: string;
}

/** What Claude Code reports it loaded, from the `init` event of `claude -p --output-format stream-json`. */
export interface InitEvent {
  skills: string[];
  slash_commands: string[];
  agents: string[];
  plugins: { name: string; source: string; version?: string }[];
  mcp_servers: { name: string; status: string; source?: string }[];
}

/** Interface so tests (and services) can use a fake instead of the real CLI. */
export interface ClaudeCli {
  /** `cwd` matters: Claude Code decides which project's local settings apply from the folder it runs in. */
  run(args: string[], timeoutMs?: number, cwd?: string): Promise<CliResult>;
  /** Start Claude Code in `cwd`, read its init event, and stop it before it answers (D-005). */
  init?(cwd: string, timeoutMs?: number): Promise<InitEvent>;
}

/**
 * Hooks are disabled for the probe so plugin hooks don't run (and send transcripts) just because we
 * looked; sessions aren't saved, so the probe leaves no history behind.
 */
export const INIT_ARGS = ['-p', 'reply ok', '--output-format', 'stream-json', '--verbose', '--max-turns', '1',
  '--no-session-persistence', '--settings', JSON.stringify({ disableAllHooks: true })];

function probeInit(cwd: string, timeoutMs = 90_000): Promise<InitEvent> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', INIT_ARGS, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Claude Code did not start within the time limit'))), timeoutMs);
    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', () => finish(() => reject(new Error('Claude Code exited before reporting what it loaded'))));
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.includes('"subtype":"init"')) continue;
        try {
          const j = JSON.parse(line) as Partial<InitEvent>;
          const list = <T,>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
          finish(() => resolvePromise({
            skills: list(j.skills), slash_commands: list(j.slash_commands), agents: list(j.agents),
            plugins: list(j.plugins), mcp_servers: list(j.mcp_servers),
          }));
        } catch (e) {
          finish(() => reject(new Error(`Could not read Claude Code's init event: ${(e as Error).message}`)));
        }
        return;
      }
    });
  });
}

export const realCli: ClaudeCli = {
  run(args, timeoutMs = 60_000, cwd) {
    return new Promise((resolvePromise) => {
      execFile('claude', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...(cwd ? { cwd } : {}) }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        const extra = err && typeof err.code !== 'number' ? `\n${err.message}` : '';
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) + extra });
      });
    });
  },
  init: probeInit,
};

export class CliError extends Error {
  readonly result: CliResult;
  constructor(message: string, result: CliResult) {
    super(message);
    this.result = result;
  }
}

export async function listPlugins(cli: ClaudeCli, cwd?: string): Promise<InstalledPlugin[]> {
  const res = await cli.run(['plugin', 'list', '--json'], undefined, cwd);
  if (res.code !== 0) throw new CliError(`claude plugin list failed (exit ${res.code}): ${res.stderr.trim()}`, res);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new CliError('claude plugin list did not return JSON', res);
  }
  if (!Array.isArray(parsed)) throw new CliError('claude plugin list returned an unexpected shape', res);
  return parsed
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
    .map((p) => ({
      id: p.id as string,
      version: typeof p.version === 'string' ? p.version : undefined,
      scope: typeof p.scope === 'string' ? p.scope : 'user',
      enabled: p.enabled === true,
      installPath: typeof p.installPath === 'string' ? p.installPath : '',
    }));
}
