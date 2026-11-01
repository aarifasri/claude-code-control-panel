// Token costs per plugin, from `claude plugin details`. Slow (seconds per plugin), so results are
// cached on disk by plugin id + version and fetched with limited parallelism.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ClaudeCli, InstalledPlugin } from '../adapters/cli.ts';
import { parsePluginDetails, type PluginCost } from '../adapters/parsers/pluginDetails.ts';

export interface CachedCost extends PluginCost {
  version: string;
}

export type CostTable = Record<string, CachedCost>;

async function loadCache(file: string): Promise<CostTable> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as CostTable) : {};
  } catch {
    return {};
  }
}

async function saveCache(file: string, table: CostTable): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(table, null, 2)}\n`);
  await rename(tmp, file);
}

/** Run tasks with at most `limit` running at once. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await task(next);
  });
  await Promise.all(workers);
}

export async function getCosts(opts: { cli: ClaudeCli; plugins: InstalledPlugin[]; cacheFile: string; concurrency?: number }): Promise<CostTable> {
  const cache = await loadCache(opts.cacheFile);
  const result: CostTable = {};
  const missing: InstalledPlugin[] = [];

  for (const p of opts.plugins) {
    const version = p.version ?? '';
    const hit = cache[p.id];
    if (hit && hit.version === version && !hit.parseError) result[p.id] = hit;
    else missing.push(p);
  }

  await pool(missing, opts.concurrency ?? 4, async (p) => {
    const res = await opts.cli.run(['plugin', 'details', p.id], 90_000);
    const parsed = res.code === 0
      ? parsePluginDetails(res.stdout)
      : { components: [], parseError: `claude plugin details failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}` };
    result[p.id] = { version: p.version ?? '', ...parsed };
  });

  if (missing.length) await saveCache(opts.cacheFile, { ...cache, ...result });
  return result;
}
