import { log } from './log.js';
import {
  listPosts,
  updateStats,
  PLATFORMS,
  type Platform,
  type Post,
  type PostStats,
} from './posts.js';
import * as youtube from './providers/youtube.js';
import * as facebook from './providers/facebook.js';
import { slugify } from './text.js';
import { recordPost } from './posts.js';

/**
 * How the published videos are actually doing.
 *
 * The ledger holds where everything went; this is the part that goes and asks.
 * It is deliberately a refresh rather than a live read: every platform rate
 * limits, several of them hourly, and a screen that called four APIs on every
 * paint would spend its allowance on nobody looking. The numbers are fetched
 * when asked for, written down, and shown from what was written down — with
 * their age, because a view count with no timestamp is a number you cannot
 * argue with.
 */

/** Below this, a refresh is served from what is already on disk. */
const FRESH_MS = 10 * 60 * 1000;

export type PlatformState = {
  platform: Platform;
  label: string;
  connected: boolean;
  /** What has to happen before this one can be connected, if anything. */
  blocker: string | null;
};

/**
 * What each platform needs before it can do anything, in the terms of the
 * person who has to go and do it.
 *
 * These are not the same shape of task. YouTube wants a Google Cloud project
 * and nothing else; the other three want a developer app *and* a review of it
 * before anything posts publicly, which is a wait measured in days and a
 * decision made by somebody else.
 */
export const PLATFORM_NOTES: Record<Platform, string> = {
  youtube:
    'A Google Cloud project with the YouTube Data API turned on. Uploads are forced private ' +
    'until the project passes audit.',
  tiktok:
    'A TikTok for Developers app with Content Posting. Until it passes audit every post is ' +
    'visible only to you, and the API requires showing the creator their privacy and ' +
    'comment settings before it posts.',
  instagram:
    'A Meta app plus an Instagram Business or Creator account. Publishing is capped at 25 ' +
    'posts a day and needs Advanced Access review to work for anyone but you.',
  facebook:
    'A Meta app with Facebook Login, and a Page you admin. The app can stay in development: ' +
    'review is only needed to post to other people\'s Pages.',
};

export function platformStates(): PlatformState[] {
  return PLATFORMS.map((platform) => {
    if (platform === 'youtube') {
      return {
        platform,
        label: 'YouTube',
        connected: youtube.isConnected(),
        blocker: youtube.isConfigured() ? null : 'no OAuth client is set up on this machine',
      };
    }
    if (platform === 'facebook') {
      return {
        platform,
        label: 'Facebook',
        connected: facebook.isConnected(),
        blocker: facebook.isConfigured()
          ? facebook.readConnection() === null
            ? null
            : 'connected, but no Page is chosen yet'
          : 'no Meta app is set up on this machine',
      };
    }
    return {
      platform,
      label: platform === 'tiktok' ? 'TikTok' : 'Instagram',
      connected: false,
      blocker: 'not built yet',
    };
  });
}

function stale(posts: readonly Post[]): boolean {
  const cutoff = Date.now() - FRESH_MS;
  return posts.some((post) => post.stats === null || Date.parse(post.stats.at) < cutoff);
}

/**
 * Goes and asks every connected platform about its own posts.
 *
 * One platform failing is not the others failing. A TikTok token that expired
 * overnight must not cost you the YouTube numbers, so each is caught on its
 * own and the failure is reported alongside the results rather than instead of
 * them.
 */
export async function refresh(options: { force?: boolean } = {}): Promise<{
  updated: number;
  errors: string[];
}> {
  const posts = listPosts();
  const errors: string[] = [];
  let updated = 0;

  const yt = posts.filter((post) => post.platform === 'youtube');
  if (yt.length > 0 && youtube.isConnected() && (options.force === true || stale(yt))) {
    try {
      const fetched = await youtube.videoStats(yt.map((post) => post.remoteId));
      const asStats = new Map<string, Omit<PostStats, 'at'>>();
      for (const [id, stats] of fetched) {
        asStats.set(id, {
          views: stats.views,
          likes: stats.likes,
          comments: stats.comments,
          // YouTube does not report shares through the Data API. Null rather
          // than zero: nobody shared it and nobody will say are different.
          shares: null,
          extra: stats.extra,
        });
      }
      updated += updateStats('youtube', asStats);

      const missing = yt.filter((post) => !fetched.has(post.remoteId));
      if (missing.length > 0) {
        log.debug(`analytics: ${missing.length} youtube post(s) returned nothing`);
      }
    } catch (error) {
      errors.push(`YouTube: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const fb = posts.filter((post) => post.platform === 'facebook');
  if (fb.length > 0 && facebook.isConnected() && (options.force === true || stale(fb))) {
    try {
      const fetched = await facebook.videoStats(fb.map((post) => post.remoteId));
      updated += updateStats('facebook', fetched);
    } catch (error) {
      errors.push(`Facebook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { updated, errors };
}

export type Totals = {
  posts: number;
  views: number;
  likes: number;
  comments: number;
  /** Rows the platform has not answered for yet, so the totals can be honest. */
  unmeasured: number;
};

function total(posts: readonly Post[]): Totals {
  let views = 0;
  let likes = 0;
  let comments = 0;
  let unmeasured = 0;
  for (const post of posts) {
    if (post.stats === null) {
      unmeasured += 1;
      continue;
    }
    views += post.stats.views ?? 0;
    likes += post.stats.likes ?? 0;
    comments += post.stats.comments ?? 0;
  }
  return { posts: posts.length, views, likes, comments, unmeasured };
}

export type Overview = {
  totals: Totals;
  /**
   * Carried in the overview rather than added by the route that happens to
   * serve it. Refreshing used to return everything except this, so pressing
   * the button emptied the column explaining what each platform still needs --
   * the one part of the screen that was answering a question.
   */
  notes: Record<Platform, string>;
  byPlatform: (Totals & { platform: Platform; label: string })[];
  posts: Post[];
  platforms: PlatformState[];
  /** The oldest set of numbers on the page, which is how stale the page is. */
  measuredAt: string | null;
};

export function overview(): Overview {
  const posts = listPosts();
  const measured = posts
    .map((post) => post.stats?.at)
    .filter((at): at is string => at !== undefined)
    .sort();

  return {
    totals: total(posts),
    notes: PLATFORM_NOTES,
    byPlatform: PLATFORMS.map((platform) => ({
      platform,
      label:
        platform === 'youtube'
          ? 'YouTube'
          : platform === 'tiktok'
            ? 'TikTok'
            : platform === 'instagram'
              ? 'Instagram'
              : 'Facebook',
      ...total(posts.filter((post) => post.platform === platform)),
    })).filter((row) => row.posts > 0),
    posts,
    platforms: platformStates(),
    measuredAt: measured[0] ?? null,
  };
}

/**
 * Fills the ledger in backwards from the channel.
 *
 * The record-keeping is younger than the channel, so without this the screen
 * opens empty for anyone who was already publishing -- which is everyone using
 * it, including the videos that went up an hour ago. The title is matched back
 * to a slug where it can be (the #Shorts tag comes off first, since publishing
 * adds it), and where it cannot the row still goes in: a video on the channel
 * that this machine has no working copy of is still a video on the channel.
 */
export async function importFromYouTube(): Promise<{ added: number; total: number }> {
  if (!youtube.isConnected()) throw new Error('no channel is connected');

  const known = new Set(listPosts().filter((p) => p.platform === 'youtube').map((p) => p.remoteId));
  // Every connected channel's uploads, not just the default's.
  const uploads = (
    await Promise.all(youtube.listConnections().map((c) => youtube.recentUploads(50, c.channelId)))
  ).flat();
  let added = 0;

  for (const upload of uploads) {
    if (known.has(upload.videoId)) continue;
    const topic = upload.title.replace(/#shorts/gi, '').replace(/\s+/g, ' ').trim();
    recordPost({
      platform: 'youtube',
      slug: slugify(topic),
      topic,
      remoteId: upload.videoId,
      url: `https://www.youtube.com/watch?v=${upload.videoId}`,
      title: upload.title,
      visibility: upload.privacyStatus,
      at: upload.publishedAt,
    });
    added += 1;
  }
  return { added, total: uploads.length };
}
