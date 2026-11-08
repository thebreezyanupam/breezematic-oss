import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { dirs } from './config.js';
import { readJson, writeJsonAtomic } from './json.js';
import { log } from './log.js';

/**
 * Everywhere a finished video was posted, and how it has done since.
 *
 * Until this existed the answer to "where did that one go" was nowhere: an
 * upload returned a video id to whichever browser tab asked for it and the id
 * was never written down. The autopilot kept its own record, which is why the
 * only videos the machine could account for were the ones nobody chose.
 *
 * One row per posting rather than one per video, because the same render goes
 * to several places and each gets its own id, its own visibility and its own
 * numbers. A video posted to three platforms is three rows that happen to share
 * a slug.
 */

export const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'facebook'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
};

/**
 * What every platform will tell you about a post.
 *
 * Deliberately the intersection rather than the union. YouTube reports watch
 * time and retention, TikTok reports shares, Instagram reports saves and
 * reach — and a table whose columns are mostly blank teaches you less than a
 * narrow one that is full. Anything a platform knows beyond this goes in
 * `extra`, where the screen shows it only for the rows that have it.
 */
const statsSchema = z
  .object({
    views: z.number().nonnegative().nullable().default(null),
    likes: z.number().nonnegative().nullable().default(null),
    comments: z.number().nonnegative().nullable().default(null),
    shares: z.number().nonnegative().nullable().default(null),
    /** Platform-specific extras, already formatted for reading. */
    extra: z.record(z.string()).default({}),
    /** When these numbers were fetched. */
    at: z.string(),
  })
  .strict();

export type PostStats = z.infer<typeof statsSchema>;

const postSchema = z
  .object({
    platform: z.enum(PLATFORMS),
    slug: z.string(),
    topic: z.string(),
    /** The platform's own id, which is what the stats call asks about. */
    remoteId: z.string(),
    url: z.string(),
    title: z.string(),
    /** What the platform actually applied, not what was asked for. */
    visibility: z.string(),
    at: z.string(),
    stats: statsSchema.nullable().default(null),
  })
  .strict();

export type Post = z.infer<typeof postSchema>;

const fileSchema = z
  .object({
    version: z.literal(1).default(1),
    posts: z.array(postSchema).default([]),
  })
  .strict();

const FILE = (): string => path.join(dirs.work, 'posts.json');

function read(): z.infer<typeof fileSchema> {
  const file = FILE();
  if (!fs.existsSync(file)) return { version: 1, posts: [] };
  try {
    return fileSchema.parse(readJson(file));
  } catch (error) {
    // A ledger that cannot be read must not stop a publish. Say so once and
    // carry on with an empty one rather than throwing inside an upload.
    log.warn(`posts: ${path.basename(file)} could not be read (${String(error)})`);
    return { version: 1, posts: [] };
  }
}

/**
 * Writes down a posting, replacing any earlier row for the same id.
 *
 * Re-posting the same video to the same platform makes a new id and so a new
 * row; re-recording the same id — a retried publish that succeeded the second
 * time, a visibility that changed — updates the one that is there. The stats
 * survive that, because nothing about a re-record makes the numbers older.
 */
export function recordPost(post: Omit<Post, 'at' | 'stats'> & { at?: string }): Post {
  const store = read();
  const row: Post = {
    ...post,
    at: post.at ?? new Date().toISOString(),
    stats: store.posts.find(
      (p) => p.platform === post.platform && p.remoteId === post.remoteId,
    )?.stats ?? null,
  };
  store.posts = store.posts.filter(
    (p) => !(p.platform === post.platform && p.remoteId === post.remoteId),
  );
  store.posts.push(row);
  writeJsonAtomic(FILE(), store);
  return row;
}

export function listPosts(): Post[] {
  return read().posts.sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function postsForSlug(slug: string): Post[] {
  return listPosts().filter((post) => post.slug === slug);
}

/** Attaches freshly fetched numbers to rows already in the ledger. */
export function updateStats(
  platform: Platform,
  fetched: Map<string, Omit<PostStats, 'at'>>,
): number {
  if (fetched.size === 0) return 0;
  const store = read();
  const at = new Date().toISOString();
  let touched = 0;

  for (const post of store.posts) {
    if (post.platform !== platform) continue;
    const stats = fetched.get(post.remoteId);
    if (stats === undefined) continue;
    post.stats = { ...stats, at };
    touched += 1;
  }

  if (touched > 0) writeJsonAtomic(FILE(), store);
  return touched;
}

/**
 * Drops a row, for a post that is no longer there.
 *
 * A deleted video keeps returning nothing from the stats call for ever, and a
 * row that can never be filled in is worse than an absent one: it drags every
 * average down and looks like a video that got no views rather than one that
 * does not exist.
 */
export function forgetPost(platform: Platform, remoteId: string): boolean {
  const store = read();
  const before = store.posts.length;
  store.posts = store.posts.filter(
    (p) => !(p.platform === platform && p.remoteId === remoteId),
  );
  if (store.posts.length === before) return false;
  writeJsonAtomic(FILE(), store);
  return true;
}
