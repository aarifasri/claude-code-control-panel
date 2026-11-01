// The only place that runs the `claude` CLI. Always an argument array, never a shell (D-004).

import { execFile } from 'node:child_process';

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

/** Interface so tests (and services) can use a fake instead of the real CLI. */
export interface ClaudeCli {
  /** `cwd` matters: Claude Code decides which project's local settings apply from the folder it runs in. */
  run(args: string[], timeoutMs?: number, cwd?: string): Promise<CliResult>;
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
