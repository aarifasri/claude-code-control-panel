// The only code that modifies Claude Code settings files.
// Guarantees (docs/DATA_MODEL.md §6): allow-listed paths only (I2), backup before change (I1),
// other keys preserved (I4), re-read just before writing + atomic rename (I5).

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export type JsonObject = Record<string, unknown>;

export interface UpdateOptions {
  /** Called with the resolved path; must return true or nothing is written (I2). */
  isAllowed: (path: string) => boolean;
  backupDir: string;
  /** Short name used in backup file names, e.g. "user-settings". */
  label: string;
  maxBackups?: number;
  now?: () => Date;
}

export interface UpdateResult {
  changed: boolean;
  /** Backup of the previous content; absent when the file didn't exist or nothing changed. */
  backup?: string;
}

export class SettingsWriteError extends Error {}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SettingsWriteError(`Could not read ${path}: ${(e as NodeJS.ErrnoException).code}`);
  }
}

function parseObject(text: string | null, path: string): JsonObject {
  if (text === null || text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    // Never overwrite a file we can't understand: the user (or Claude Code) may be mid-edit.
    throw new SettingsWriteError(`${path} is not valid JSON, so it was left untouched: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SettingsWriteError(`${path} does not contain a JSON object`);
  return parsed as JsonObject;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function backupFile(original: string, opts: UpdateOptions): Promise<string> {
  await mkdir(opts.backupDir, { recursive: true });
  const base = `${opts.label}.${stamp((opts.now ?? (() => new Date()))())}`;
  let target = join(opts.backupDir, `${base}.json`);
  for (let n = 1; await stat(target).then(() => true, () => false); n++) target = join(opts.backupDir, `${base}-${n}.json`);
  // Back up the text we read, not the file on disk: the disk copy may already have been changed by
  // someone else, and the re-read check in updateSettingsFile guarantees `original` is what we replace.
  // 'wx' refuses to overwrite an existing backup.
  await writeFile(target, original, { flag: 'wx' });
  // Verify the backup really holds the original before we change anything (I1).
  if ((await readFile(target, 'utf8')) !== original) throw new SettingsWriteError(`Backup verification failed (${target})`);
  await pruneBackups(opts.backupDir, opts.label, opts.maxBackups ?? 50);
  return target;
}

async function pruneBackups(dir: string, label: string, keep: number): Promise<void> {
  const mine = (await readdir(dir)).filter((f) => f.startsWith(`${label}.`) && f.endsWith('.json')).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) await unlink(join(dir, old)).catch(() => {});
}

/** Write via temp file + rename, retrying briefly when Windows reports the file as busy. */
async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.ccp-${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 5) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      await unlink(tmp).catch(() => {});
      throw new SettingsWriteError(`Could not write ${path}: ${code}`);
    }
  }
}

/**
 * Apply `mutate` to the JSON object in `path`. `mutate` receives a copy and changes it in place.
 * If the file changes on disk while we work (e.g. Claude Code saved it), we start over on the new content.
 */
export async function updateSettingsFile(path: string, mutate: (data: JsonObject) => void, opts: UpdateOptions): Promise<UpdateResult> {
  if (!opts.isAllowed(path)) throw new SettingsWriteError(`Refusing to write ${path}: not on the allow-list`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const original = await readText(path);
    const before = parseObject(original, path);
    const after = structuredClone(before);
    mutate(after);
    if (isDeepStrictEqual(before, after)) return { changed: false };

    const backup = original === null ? undefined : await backupFile(original, opts);
    const text = `${JSON.stringify(after, null, 2)}\n`;

    // I5: if someone else wrote the file since we read it, don't clobber their change: retry.
    if ((await readText(path)) !== original) continue;
    await atomicWrite(path, text);
    return backup ? { changed: true, backup } : { changed: true };
  }
  throw new SettingsWriteError(`${path} kept changing while we tried to update it; nothing was written. Try again.`);
}
