import { env } from './config.js';

export type Level = 'error' | 'warn' | 'info' | 'debug';

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let current: Level = env.LOG_LEVEL;

export function setLevel(level: Level): void {
  current = level;
}

export function levelEnabled(level: Level): boolean {
  return RANK[level] <= RANK[current];
}

const useColor = process.stderr.isTTY === true && process.env['NO_COLOR'] === undefined;
const ESC = String.fromCharCode(27);

function paint(code: string, text: string): string {
  return useColor ? ESC + '[' + code + 'm' + text + ESC + '[0m' : text;
}

const TAG: Record<Level, string> = {
  error: paint('31', 'error'),
  warn: paint('33', 'warn '),
  info: paint('36', 'info '),
  debug: paint('90', 'debug'),
};

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  return JSON.stringify(value);
}

export type LogListener = (level: Level, line: string) => void;

const listeners = new Set<LogListener>();

/**
 * Observe every line that passes the level filter. This is how the app streams
 * stage progress without the stages knowing a UI exists — they keep logging,
 * the server subscribes for the duration of a run.
 */
export function onLog(listener: LogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(level: Level, parts: unknown[]): void {
  if (!levelEnabled(level)) return;
  const line = parts.map(render).join(' ');
  process.stderr.write(`${TAG[level]} ${line}\n`);
  for (const listener of listeners) listener(level, line);
}

export const log = {
  error: (...parts: unknown[]) => emit('error', parts),
  warn: (...parts: unknown[]) => emit('warn', parts),
  info: (...parts: unknown[]) => emit('info', parts),
  debug: (...parts: unknown[]) => emit('debug', parts),
};

export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
