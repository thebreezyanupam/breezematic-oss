import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assetDirs, dirs } from './config.js';
import { KEY_FIELDS, saveKeys } from './keys.js';
import { log } from './log.js';
import { localDb } from './store/local.js';
import { forgetAllProjects } from './supabase/account.js';

/**
 * Starting over: everything this install has made and remembered, removed in
 * one go, chosen by kind.
 *
 * Each kind names exactly the files it owns, so "delete everything" can never
 * reach anything the app did not put there -- the code, the models it
 * downloaded once, whisper, the sound library. Those are the install, not
 * the user's data, and removing them would only cost a long re-download.
 *
 *   videos       every project folder in work/ and every MP4 in out/
 *   performance  the record of what was posted where, and its numbers
 *   spending     the spend ledger and the limits
 *   presets      saved presets and saved drafts
 *   history      the local database: preferences and project history
 *   cache        stage results, downloaded pictures and footage (rebuilt on
 *                demand, at the cost of paying again for anything paid for)
 *   keys         the keys saved in Settings (keys in .env stay; that file is yours)
 *   channels     the YouTube and Facebook connections and the stored sign-in
 *   voices       cloned voices and the footage you added yourself
 *
 * Nothing goes to the Recycle Bin: this is the one action in the app whose
 * whole point is that it does not come back, and the screen says so twice.
 */

export const RESET_KINDS = [
  'videos', 'performance', 'spending', 'presets', 'history', 'cache', 'keys', 'channels', 'voices',
] as const;
export type ResetKind = (typeof RESET_KINDS)[number];

export const isResetKind = (value: unknown): value is ResetKind =>
  typeof value === 'string' && (RESET_KINDS as readonly string[]).includes(value);

/** Files in .cache that are connections, not cached results. */
const CHANNEL_FILES = [
  'youtube-tokens.json', 'youtube-client.json', 'facebook-tokens.json', 'facebook-client.json', 'supabase-session.json',
];
/** Tools in .cache that were installed once and are not anybody's data. */
const CACHE_KEEP = new Set(['whisper.cpp', 'whisper-models', 'asset-src', ...CHANNEL_FILES]);

/** Refuses any target outside the project, so a misconfigured directory cannot widen a reset. */
function inside(target: string): boolean {
  const relative = path.relative(ROOT, path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function remove(target: string, removed: string[]): void {
  if (!fs.existsSync(target)) return;
  if (!inside(target)) {
    log.warn(`reset: skipped ${target}, which is outside the project`);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(path.relative(ROOT, target));
}

/** Everything in a directory except the names kept, or only the names given. */
function entries(dir: string, filter: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(filter).map((name) => path.join(dir, name));
}

const WORK_FILES = {
  performance: ['posts.json'],
  spending: ['spend.json'],
  presets: ['series.json', 'drafts.json'],
} as const;

export async function resetEverything(
  kinds: readonly ResetKind[],
  /** Where downloaded pictures and footage are served from; a test points it at a sandbox. */
  options: { publicDir?: string } = {},
): Promise<{ removed: string[]; kinds: ResetKind[] }> {
  const publicDir = options.publicDir ?? path.join(ROOT, 'public');
  const chosen = new Set(kinds);
  const removed: string[] = [];

  if (chosen.has('videos')) {
    // Project folders only: the ledgers that also live in work/ are their own kinds.
    for (const target of entries(dirs.work, (name) => fs.statSync(path.join(dirs.work, name)).isDirectory())) remove(target, removed);
    for (const name of ['autopilot.json', 'autopilot.log', 'render-rate.json']) remove(path.join(dirs.work, name), removed);
    for (const target of entries(dirs.out, (name) => /\.(mp4|mov|webm|png|jpg)$/i.test(name))) remove(target, removed);
  }
  for (const kind of ['performance', 'spending', 'presets'] as const) {
    if (chosen.has(kind)) for (const name of WORK_FILES[kind]) remove(path.join(dirs.work, name), removed);
  }
  if (chosen.has('history')) {
    // The database is open, so it is emptied rather than deleted.
    const db = await localDb();
    if (db !== null) {
      db.exec('delete from projects; delete from preferences;');
      removed.push('.local/breezematic.db (emptied)');
    }
    // With an account, its copy of the history goes too, or the library would
    // offer every deleted video back as "in your account".
    if (await forgetAllProjects()) removed.push('account history');
  }
  if (chosen.has('cache')) {
    for (const target of entries(dirs.cache, (name) => !CACHE_KEEP.has(name))) remove(target, removed);
    for (const folder of ['images', 'videos']) {
      for (const target of entries(path.join(publicDir, folder), (name) => name !== '.gitkeep')) remove(target, removed);
    }
  }
  if (chosen.has('keys')) {
    saveKeys(Object.fromEntries(KEY_FIELDS.map((field) => [field.name, ''])));
    removed.push('.local/keys.json (emptied)');
  }
  if (chosen.has('channels')) {
    for (const name of CHANNEL_FILES) remove(path.join(dirs.cache, name), removed);
  }
  if (chosen.has('voices')) {
    for (const target of entries(assetDirs.voice, (name) => name !== '.gitkeep')) remove(target, removed);
    for (const target of entries(assetDirs.own, (name) => name !== '.gitkeep')) remove(target, removed);
  }

  log.info(`reset: ${[...chosen].join(', ')} -- ${removed.length} item(s) removed`);
  return { removed, kinds: [...chosen] };
}
