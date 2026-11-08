import fs from 'node:fs';
import path from 'node:path';

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function stablePretty(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    result[key] = sortKeys(entryValue);
  }
  return result;
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, stablePretty(value), 'utf8');
  fs.renameSync(temp, file);
}
