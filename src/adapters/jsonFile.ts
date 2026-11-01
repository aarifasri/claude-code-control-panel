// Read JSON files (settings, plugin manifests). Writing lives in settingsFile.ts (M3).

import { readFile } from 'node:fs/promises';

export interface JsonRead {
  data: Record<string, unknown> | null;
  error?: string;
}

/** Missing file → `{ data: null }` (not an error). Unparseable file → error, data null. */
export async function readJsonObject(path: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { data: null };
    return { data: null, error: `could not read: ${(e as NodeJS.ErrnoException).code}` };
  }
  try {
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { data: null, error: 'not a JSON object' };
    return { data: parsed as Record<string, unknown> };
  } catch (e) {
    return { data: null, error: `invalid JSON: ${(e as Error).message}` };
  }
}
