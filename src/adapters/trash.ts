// Recoverable delete: move a standalone skill folder / agent or command file into the app's trash,
// recording where it came from so it can be moved back (D-001, invariants I2 and I9).

import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';

export type TrashKind = 'skill' | 'agent' | 'command';

export interface TrashEntry {
  id: string;
  kind: TrashKind;
  key: string;
  name: string;
  /** Inventory id the item had, so the UI can show it again after restore. */
  itemId: string;
  originalPath: string;
  trashedPath: string;
  trashedAt: string;
}

export interface TrashOptions {
  trashDir: string;
  /** Allow-list check for the original location (isTrashableSource). */
  isAllowedSource: (path: string, kind: TrashKind) => boolean;
  now?: () => Date;
}

export class TrashError extends Error {
  readonly code: 'not-allowed' | 'conflict' | 'missing' | 'failed';
  constructor(code: TrashError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const manifestPath = (o: TrashOptions) => join(o.trashDir, 'manifest.json');

/** True if `p` is strictly inside `dir` after resolving `..` (case-insensitive on Windows). */
function inside(p: string, dir: string): boolean {
  const norm = (x: string) => {
    const r = resolve(x).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(p).startsWith(`${norm(dir)}/`);
}

export async function listTrash(o: TrashOptions): Promise<TrashEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath(o), 'utf8'));
    return Array.isArray(parsed) ? (parsed as TrashEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveManifest(o: TrashOptions, entries: TrashEntry[]): Promise<void> {
  await mkdir(o.trashDir, { recursive: true });
  const tmp = `${manifestPath(o)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  await rename(tmp, manifestPath(o));
}

/** Move a file or folder; falls back to copy + remove if the two paths are on different drives. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true });
  }
}

export async function moveToTrash(
  item: { kind: TrashKind; key: string; name: string; itemId: string; path: string },
  o: TrashOptions,
): Promise<TrashEntry> {
  if (!o.isAllowedSource(item.path, item.kind)) throw new TrashError('not-allowed', `Refusing to move ${item.path}: not a standalone ${item.kind} location`);
  if (!(await exists(item.path))) throw new TrashError('missing', `${item.path} no longer exists`);

  const at = (o.now ?? (() => new Date()))();
  const id = `${at.toISOString().replace(/[:.]/g, '-')}_${randomBytes(3).toString('hex')}`;
  const slot = join(o.trashDir, id);
  await mkdir(slot, { recursive: true });
  const trashedPath = join(slot, basename(item.path));

  const entry: TrashEntry = {
    id, kind: item.kind, key: item.key, name: item.name, itemId: item.itemId,
    originalPath: item.path, trashedPath, trashedAt: at.toISOString(),
  };
  // Record first, then move: if the move fails we drop the record; if we crash after the move,
  // the record still says where the item belongs.
  const entries = await listTrash(o);
  await saveManifest(o, [...entries, entry]);
  try {
    await move(item.path, trashedPath);
  } catch (e) {
    await saveManifest(o, entries);
    await rm(slot, { recursive: true, force: true });
    throw new TrashError('failed', `Could not move ${item.path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  return entry;
}

export async function restoreFromTrash(entryId: string, o: TrashOptions): Promise<TrashEntry> {
  const entries = await listTrash(o);
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) throw new TrashError('missing', 'That item is no longer in the trash.');
  // Re-check both ends: the manifest lives on disk and could have been edited, and restore both
  // moves the trashed copy and removes its folder.
  if (!o.isAllowedSource(entry.originalPath, entry.kind)) throw new TrashError('not-allowed', `Refusing to restore to ${entry.originalPath}`);
  // Expected shape: <trashDir>/<slot>/<name>, so removing <slot> afterwards can't touch anything else.
  if (!inside(entry.trashedPath, o.trashDir) || relative(o.trashDir, entry.trashedPath).split(/[\\/]/).length !== 2) {
    throw new TrashError('not-allowed', `Refusing to restore from ${entry.trashedPath}: not inside the trash folder`);
  }
  if (await exists(entry.originalPath)) {
    throw new TrashError('conflict', `Something named "${basename(entry.originalPath)}" already exists at its original location. Rename or remove it first; the trashed copy is kept.`);
  }
  if (!(await exists(entry.trashedPath))) throw new TrashError('missing', `The trashed copy is missing (${entry.trashedPath}).`);

  await mkdir(dirname(entry.originalPath), { recursive: true });
  await move(entry.trashedPath, entry.originalPath);
  await saveManifest(o, entries.filter((e) => e.id !== entryId));
  await rm(dirname(entry.trashedPath), { recursive: true, force: true });
  return entry;
}
