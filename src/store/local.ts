import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../config.js';
import { log } from '../log.js';

/**
 * The local database: the same three things the Supabase schema keeps
 * (preferences, and one row per project holding its beat sheet), in a single
 * SQLite file on this computer.
 *
 * It is what an install without accounts uses, and it is written to with an
 * account too: a beat sheet is the whole recipe for a video, and a copy that
 * survives deleting a work folder or losing the network is worth the few
 * kilobytes. With an account, the account is what is read; without, this is.
 *
 * SQLite is Node's own (node:sqlite, Node 22.5+), so there is no native
 * module to build and no server to run. The file is .local/breezematic.db,
 * gitignored, next to the saved keys.
 */

export const DB_FILE = path.join(ROOT, '.local', 'breezematic.db');

let db: DatabaseSync | null | undefined;

/**
 * node:sqlite prints an "experimental" warning the first time it loads. It is
 * stable enough for a single-user file and the warning reads like an error in
 * the app's console, so it is muted for that one import and nothing else.
 */
async function loadSqlite(): Promise<typeof import('node:sqlite') | null> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('SQLite')) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

export async function localDb(): Promise<DatabaseSync | null> {
  if (db !== undefined) return db;
  const sqlite = await loadSqlite();
  if (sqlite === null) {
    log.warn(`local history is off: this Node (${process.version}) has no built-in SQLite; Node 22.5 or newer does`);
    db = null;
    return db;
  }
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new sqlite.DatabaseSync(DB_FILE);
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists preferences (
      id integer primary key check (id = 1),
      theme text not null default 'dark',
      effect text not null default 'static',
      voice text not null default 'af_heart',
      variant integer not null default 0
    );
    create table if not exists projects (
      slug text primary key,
      topic text not null,
      seed integer,
      effect text,
      duration_ms integer,
      beat_count integer,
      word_count integer,
      sfx_count integer,
      sheet text not null,
      rendered_on text not null default '[]',
      created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  return db;
}
