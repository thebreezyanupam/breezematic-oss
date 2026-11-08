import fs from 'node:fs';
import { shortThumbPath } from './shortthumb.js';
import path from 'node:path';
import { dirs, env, workDir } from '../config.js';
import { ffprobe } from '../ffmpeg.js';
import { log } from '../log.js';
import type { BeatSheet } from '../schema.js';
import {
  setThumbnail,
  uploadVideo,
  readConnection,
  YouTubeNotConnectedError,
  canComment,
  postComment,
  subscribeUrl,
  type PrivacyStatus,
  type UploadResult,
  type VideoMetadata,
} from '../providers/youtube.js';
import { creditBlock } from './images.js';
import { assembleDescription, writeBlurb } from './describe.js';
import { recordPost } from '../posts.js';

/**
 * Turns a finished render into something YouTube will accept, and checks it
 * qualifies as a Short before spending an upload on it.
 *
 * A Short is decided by the file: vertical, and no longer than three minutes.
 * Ours are 1080x1920 and well under a minute, so this passes by construction —
 * but a hand-edited sheet or a swapped file can break both, and finding out
 * afterwards means a video on the channel in the wrong shape.
 */

export const SHORTS_MAX_MS = 180_000;
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const TAGS_MAX_CHARS = 450;
const SHORTS_TAG = '#Shorts';

export type PublishOptions = {
  sheet: BeatSheet;
  privacyStatus?: PrivacyStatus;
  /** YouTube's category id; absent, the machine's default. */
  categoryId?: string;
  title?: string;
  description?: string;
  onProgress?: (fraction: number) => void;
  /** Which connected channel it goes to. Absent: the default. */
  channelId?: string | null;
  /** A first comment to post once it is up. */
  comment?: string;
};

export type Probe = { width: number; height: number; durationMs: number };

export type Eligibility = {
  probe: Probe;
  vertical: boolean;
  withinDuration: boolean;
  ok: boolean;
  reasons: string[];
};

export type PublishResult = UploadResult & {
  file: string;
  metadata: VideoMetadata;
  eligibility: Eligibility;
  /** The first comment: posted, or why not -- never a reason the upload failed. */
  comment?: { posted: boolean; text: string; reason?: string };
};

export function renderedFile(slug: string): string {
  return path.join(dirs.out, `${slug}.mp4`);
}

export async function probeVideo(file: string): Promise<Probe> {
  const { stdout } = await ffprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1',
    file,
  ]);

  const fields = new Map(
    stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)] as const;
      }),
  );

  const width = Number(fields.get('width'));
  const height = Number(fields.get('height'));
  const seconds = Number(fields.get('duration'));
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(seconds)) {
    throw new Error(`could not read the dimensions of ${path.basename(file)}`);
  }
  return { width, height, durationMs: Math.round(seconds * 1000) };
}

export function checkEligibility(probe: Probe): Eligibility {
  const vertical = probe.height > probe.width;
  const withinDuration = probe.durationMs <= SHORTS_MAX_MS;
  const reasons: string[] = [];

  if (!vertical) {
    reasons.push(`${probe.width}x${probe.height} is not vertical, so it will post as a normal video`);
  }
  if (!withinDuration) {
    reasons.push(
      `${(probe.durationMs / 1000).toFixed(1)}s is over the ${SHORTS_MAX_MS / 1000}s Shorts limit`,
    );
  }

  return { probe, vertical, withinDuration, ok: vertical && withinDuration, reasons };
}

function titleCase(topic: string): string {
  return topic.charAt(0).toUpperCase() + topic.slice(1);
}

export function buildTitle(sheet: BeatSheet, override?: string): string {
  const base = (override ?? titleCase(sheet.meta.topic)).replace(/\s+/g, ' ').trim();
  // Angle brackets are the only characters YouTube rejects outright in a title.
  const safe = base.replace(/[<>]/g, '');
  if (safe.toLowerCase().includes('#shorts')) return safe.slice(0, TITLE_MAX);

  const room = TITLE_MAX - SHORTS_TAG.length - 1;
  const head = safe.length > room ? `${safe.slice(0, room - 1).trimEnd()}…` : safe;
  return `${head} ${SHORTS_TAG}`;
}

/**
 * What sits under the video.
 *
 * It used to be the whole script, then a line disclosing the voice, then the
 * credits. The script is the audio of the video, so repeating it under the
 * video serves nobody -- least of all search, which reads the first two lines
 * and found the opening sentence of a narration there. This is a couple of
 * sentences about the short, what it borrowed and from where, the copyright
 * position, and a few hashtags.
 *
 * The synthetic-media disclosure has not gone anywhere: it is the
 * `containsSyntheticMedia` flag on the upload, which is where YouTube asks
 * for it and where it belongs. A line of prose in the description was never
 * what that requirement meant.
 */
export async function buildDescription(sheet: BeatSheet, override?: string): Promise<string> {
  if (override !== undefined) return override.slice(0, DESCRIPTION_MAX);

  const blurb = await writeBlurb({
    title: sheet.meta.topic,
    about: sheet.meta.topic,
    sample: sheet.script.fullText,
    kind: 'short',
  });

  /**
   * The credits are the one part that is not a courtesy.
   *
   * Most of the photographs are CC BY, which is permission granted in advance
   * on one condition: credit, in a way that suits the medium. For a published
   * video that medium is the description.
   */
  const credits = creditBlock(sheet.meta.slug)
    .split(String.fromCharCode(10))
    .filter((line) => line.trim() !== '' && !/^-+$/.test(line.trim()) && line.trim() !== 'Credits');

  return assembleDescription({ blurb, credits, extraTags: [SHORTS_TAG] }).slice(0, DESCRIPTION_MAX);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'from', 'is', 'are', 'was', 'were', 'be', 'why', 'how', 'do', 'does', 'did', 'what',
]);

export function buildTags(sheet: BeatSheet): string[] {
  const seen = new Set<string>();
  const tags: string[] = ['shorts'];
  let budget = TAGS_MAX_CHARS - 'shorts'.length;

  for (const raw of sheet.meta.topic.toLowerCase().split(/\s+/)) {
    const word = raw.replace(/[^a-z0-9]/g, '');
    if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
    if (budget - word.length < 0) break;
    seen.add(word);
    tags.push(word);
    budget -= word.length;
  }
  return tags;
}

export async function buildMetadata(
  sheet: BeatSheet,
  options: { privacyStatus?: PrivacyStatus; title?: string; description?: string; categoryId?: string } = {},
): Promise<VideoMetadata> {
  return {
    title: buildTitle(sheet, options.title),
    description: await buildDescription(sheet, options.description),
    tags: buildTags(sheet),
    categoryId: options.categoryId ?? env.YOUTUBE_CATEGORY_ID,
    privacyStatus: options.privacyStatus ?? env.YOUTUBE_PRIVACY,
    // The voice is synthesised on every render, so this is never not true.
    containsSyntheticMedia: true,
  };
}

export async function publishToYouTube(options: PublishOptions): Promise<PublishResult> {
  const file = renderedFile(options.sheet.meta.slug);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${path.relative(dirs.root, file)} does not exist — render the video before publishing it.`,
    );
  }

  const metadata = await buildMetadata(options.sheet, {
    ...(options.categoryId !== undefined ? { categoryId: options.categoryId } : {}),
    ...(options.privacyStatus !== undefined ? { privacyStatus: options.privacyStatus } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  });

  return sendToYouTube({
    slug: options.sheet.meta.slug,
    topic: options.sheet.meta.topic,
    file,
    metadata,
    shortForm: true,
    // The Short's own vertical thumbnail, when one was made.
    thumbnail: fs.existsSync(shortThumbPath(options.sheet.meta.slug)) ? shortThumbPath(options.sheet.meta.slug) : null,
    ...(options.channelId !== undefined ? { channelId: options.channelId } : {}),
    ...(options.comment !== undefined ? { comment: options.comment } : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
  });
}

/**
 * The upload itself, for any finished file with its metadata already built.
 *
 * Split out of the Shorts path so an essay or a long reading goes up through
 * exactly the same upload, warnings and post record -- only the metadata
 * differs. `shortForm` decides whether "this is not a Short" is a warning
 * worth printing: for a short it means something went wrong, for a
 * twenty-minute essay it is the point.
 */
export async function sendToYouTube(options: {
  slug: string;
  topic: string;
  file: string;
  metadata: VideoMetadata;
  shortForm: boolean;
  onProgress?: (fraction: number) => void;
  /** A custom thumbnail to set once the video is up. */
  thumbnail?: string | null;
  /** Which connected channel it goes to. Absent: the default. */
  channelId?: string | null;
  /** A first comment to post once the video is up. "{subscribe}" becomes the channel's subscribe link. */
  comment?: string;
}): Promise<PublishResult> {
  const { file, metadata } = options;
  const eligibility = checkEligibility(await probeVideo(file));
  if (options.shortForm) for (const reason of eligibility.reasons) log.warn(`youtube: ${reason}`);

  const channel = readConnection(options.channelId);
  if (channel === null) throw new YouTubeNotConnectedError();
  log.info(`youtube: uploading ${path.basename(file)} as "${metadata.title}" to ${channel.channelTitle ?? 'the channel'}`);
  log.info(`youtube: requested visibility ${metadata.privacyStatus}`);

  const result = await uploadVideo({
    file,
    metadata,
    channelId: channel.channelId,
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
  });

  // An unaudited API project has every upload forced private, whatever was asked
  // for. Saying so here saves a hunt through the Studio for a video that is
  // there but invisible.
  if (result.privacyStatus !== metadata.privacyStatus) {
    log.warn(
      `youtube: asked for ${metadata.privacyStatus} but the video is ${result.privacyStatus} — ` +
        'unaudited API projects have every upload forced private',
    );
  }
  if (result.rejectionReason !== null) {
    log.warn(`youtube: rejected (${result.rejectionReason})`);
  }

  // After the upload, never instead of it: a thumbnail that fails leaves the
  // video up with YouTube's own frame, which is a warning, not a failure.
  if (options.thumbnail !== undefined && options.thumbnail !== null) {
    try {
      await setThumbnail(result.videoId, options.thumbnail, channel.channelId);
      log.info('youtube: custom thumbnail set');
    } catch (error) {
      log.warn(
        `youtube: the thumbnail could not be set (${(error as Error).message}). Custom thumbnails ` +
          'need a phone-verified channel: YouTube Studio > Settings > Channel > Feature eligibility.',
      );
    }
  }

  /**
   * Written down before this returns.
   *
   * The upload result used to go back to whichever browser tab asked for it
   * and nowhere else, so the machine that made the video could not afterwards
   * say where it had gone -- which is both why there was nothing to analyse
   * and why a second publish of the same piece had no way of knowing there had
   * been a first.
   */
  /**
   * The first comment, after the upload and the thumbnail, never instead of
   * them. Kept next to the video either way, so a comment YouTube refused --
   * a private video takes none -- is there to paste once it is public.
   */
  let comment: PublishResult['comment'];
  if (options.comment !== undefined && options.comment.trim() !== '') {
    const text = options.comment.replace(/\{subscribe\}/g, channel.channelId === null ? '' : subscribeUrl(channel.channelId)).trim().slice(0, 9000);
    fs.writeFileSync(path.join(workDir(options.slug), 'comment.txt'), `${text}\n`, 'utf8');
    if (!canComment(channel)) {
      comment = { posted: false, text, reason: 'this channel was connected before comments were allowed — reconnect it once in Account → YouTube' };
    } else if (result.privacyStatus === 'private') {
      comment = { posted: false, text, reason: 'the video is private, and private videos take no comments — post it once the video is public' };
    } else {
      try {
        await postComment(result.videoId, text, channel.channelId);
        comment = { posted: true, text };
        log.info('youtube: first comment posted — pin it on YouTube (⋮ → Pin)');
      } catch (error) {
        comment = { posted: false, text, reason: (error as Error).message };
        log.warn(`youtube: the comment was not posted (${(error as Error).message})`);
      }
    }
  }

  recordPost({
    platform: 'youtube',
    slug: options.slug,
    topic: options.topic,
    remoteId: result.videoId,
    url: result.url,
    title: metadata.title,
    visibility: result.privacyStatus,
  });

  return { ...result, file, metadata, eligibility, ...(comment === undefined ? {} : { comment }) };
}
