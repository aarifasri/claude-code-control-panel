// Parse the human-readable output of `claude plugin details <id>`.
// The format isn't a documented contract, so every field is optional and failures are reported, not thrown.

export interface ComponentCost {
  name: string;
  alwaysOn: number;
  onInvoke: number;
}

export interface PluginCost {
  alwaysOn?: number;
  components: ComponentCost[];
  /** Set when the expected sections could not be found. */
  parseError?: string;
}

/** "~48,079" → 48079, "~2.7k" → 2700, "600" → 600. Unparseable → undefined. */
export function parseTokenCount(text: string): number | undefined {
  const m = /^~?\s*([\d,]+(?:\.\d+)?)(k)?$/i.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  return Math.round(m[2] ? n * 1000 : n);
}

const ALWAYS_ON = /^\s*Always-on:\s+(~?[\d.,]+k?)\s+tok/im;
const TABLE_HEADER = /^\s*component\s+always-on\s+on-invoke\s*$/i;
const TABLE_ROW = /^\s+(.+?)\s{2,}(~?[\d.,]+k?)\s+(~?[\d.,]+k?)\s*$/;

export function parsePluginDetails(output: string): PluginCost {
  const lines = output.split(/\r?\n/);
  const alwaysMatch = ALWAYS_ON.exec(output);
  const alwaysOn = alwaysMatch ? parseTokenCount(alwaysMatch[1]!) : undefined;

  const components: ComponentCost[] = [];
  const start = lines.findIndex((l) => TABLE_HEADER.test(l));
  if (start !== -1) {
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === '') break;
      const m = TABLE_ROW.exec(line);
      if (!m) continue;
      const a = parseTokenCount(m[2]!);
      const o = parseTokenCount(m[3]!);
      if (a !== undefined && o !== undefined) components.push({ name: m[1]!.trim(), alwaysOn: a, onInvoke: o });
    }
  }

  const result: PluginCost = { components };
  if (alwaysOn !== undefined) result.alwaysOn = alwaysOn;
  if (alwaysOn === undefined && components.length === 0) result.parseError = 'no cost information found in `claude plugin details` output';
  return result;
}
