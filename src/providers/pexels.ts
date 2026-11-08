import { env } from '../config.js';
import { log } from '../log.js';
import { MissingApiKeyError } from './errors.js';

/**
 * Pexels video search.
 *
 * The Pexels License allows commercial use with no attribution required and no
 * share-alike clause, which is what makes it usable here at all — the Commons
 * filter this project already carries exists because most "free" imagery comes
 * with terms that would attach themselves to the finished video. Crediting is
 * asked for rather than required, so the credits file lists it anyway.
 *
 * Nothing here decides what to search for. The stage above writes the query.
 */

const API = 'https://api.pexels.com/videos/search';
const TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 11_000];
/**
 * How much longer than the beat a clip may run before it is deprioritised.
 *
 * Not a fixed ceiling, because what counts as long depends on the beat. The
 * renditions are the right size — 1080x1920 is exactly the frame — so length is
 * the whole story on bytes: a fourteen-second clip behind a three-second beat is
 * 44 MB to show 9 MB of, and the other eleven seconds are decoded and dropped.
 */
const PREFERRED_LENGTH_FACTOR = 2;
const PREFERRED_FLOOR_SEC = 8;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type StockClip = {
  id: number;
  /** The rendition chosen for our frame size. */
  url: string;
  width: number;
  height: number;
  durationSec: number;
  author: string;
  /** The Pexels page, which is what a credit line should point at. */
  page: string;
};

export function isConfigured(): boolean {
  return env.PEXELS_API_KEY !== undefined;
}

export function assertConfigured(): void {
  if (!isConfigured()) throw new MissingApiKeyError('PEXELS_API_KEY');
}

type PexelsFile = {
  link?: string;
  width?: number | null;
  height?: number | null;
  file_type?: string;
};

type PexelsVideo = {
  id?: number;
  width?: number;
  height?: number;
  duration?: number;
  url?: string;
  user?: { name?: string };
  video_files?: PexelsFile[];
};

/**
 * The rendition to fetch.
 *
 * A clip is offered at every size from 360p to 4K, and both extremes are wrong:
 * the small ones are soft once they fill a 1080-wide frame, and a 4K rendition
 * of a six-second shot is tens of megabytes that get scaled straight back down.
 * So: the narrowest file that still covers the frame, and only if nothing does,
 * the widest available.
 */
function pickFile(files: readonly PexelsFile[], minWidth: number): PexelsFile | undefined {
  const usable = files
    .filter((file) => file.file_type === 'video/mp4' && typeof file.link === 'string')
    .filter((file) => Number(file.width ?? 0) > 0)
    .sort((a, b) => Number(a.width) - Number(b.width));

  return usable.find((file) => Number(file.width) >= minWidth) ?? usable[usable.length - 1];
}

async function get(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: env.PEXELS_API_KEY ?? '', Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(
        response.status === 401
          ? 'PEXELS_API_KEY was rejected'
          : response.status === 429
            ? 'the stock video provider is rate limiting'
            : `stock video provider responded ${response.status}`,
      ) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clips matching a query, best first, already narrowed to ones worth using.
 *
 * `orientation=portrait` is not a preference here. A landscape clip in a 9:16
 * frame is either pillarboxed or cropped to its middle third, and the middle
 * third of a landscape shot is rarely where the subject is.
 */
export async function searchClips(options: {
  query: string;
  minWidth: number;
  minDurationSec: number;
  count: number;
}): Promise<StockClip[]> {
  assertConfigured();

  const url =
    `${API}?query=${encodeURIComponent(options.query)}` +
    `&orientation=portrait&size=medium&per_page=${Math.min(80, Math.max(1, options.count))}`;

  let body: Record<string, unknown>;
  for (let attempt = 0; ; attempt++) {
    try {
      body = await get(url);
      break;
    } catch (error) {
      const status = (error as { status?: number }).status;
      const wait = RETRY_DELAYS_MS[attempt];
      if (wait === undefined || (status !== 429 && (status ?? 0) < 500)) throw error;
      log.debug(`pexels: ${status}, waiting ${wait}ms`);
      await sleep(wait);
    }
  }

  const videos = (body['videos'] as PexelsVideo[] | undefined) ?? [];
  const clips: StockClip[] = [];

  for (const video of videos) {
    const duration = Number(video.duration ?? 0);
    // Too short to sit under a beat without visibly restarting.
    if (duration < options.minDurationSec) continue;

    const file = pickFile(video.video_files ?? [], options.minWidth);
    if (file?.link === undefined) continue;
    // Portrait was asked for, but the field is advisory and squares come back.
    if (Number(file.height ?? 0) <= Number(file.width ?? 0)) continue;

    clips.push({
      id: Number(video.id ?? 0),
      url: file.link,
      width: Number(file.width),
      height: Number(file.height),
      durationSec: duration,
      author: video.user?.name ?? 'Unknown',
      page: video.url ?? 'https://www.pexels.com/',
    });
  }

  /**
   * Shorter first, relevance preserved inside each group.
   *
   * Pexels answers in relevance order and the length is incidental, so taking
   * the top hit meant a three-second beat could pull down a thirty-second 4K
   * clip: measured on one twenty-beat sheet, three beats alone accounted for
   * 167 MB of a 340 MB download, all of it decoded and thrown away after the
   * first three seconds. Grouping rather than sorting outright is what keeps
   * this from quietly trading the right shot for a smaller one.
   */
  const preferUnder = Math.max(
    PREFERRED_FLOOR_SEC,
    options.minDurationSec * PREFERRED_LENGTH_FACTOR,
  );
  const brief = clips.filter((clip) => clip.durationSec <= preferUnder);
  const rest = clips.filter((clip) => clip.durationSec > preferUnder);
  return [...brief, ...rest];
}

export async function downloadClip(url: string, destination: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`clip download responded ${response.status}`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
}
