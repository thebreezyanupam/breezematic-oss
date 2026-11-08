import fs from 'node:fs';
import path from 'node:path';
import { dirs, env } from '../config.js';
import { log } from '../log.js';
import type { BeatSheet } from '../schema.js';
import * as facebook from '../providers/facebook.js';
import { requiredCredits } from './images.js';
import { recordPost } from '../posts.js';
import { probeVideo, renderedFile, type Probe } from './publish.js';

/**
 * A finished render, posted to a Facebook Page.
 *
 * Kept apart from the YouTube stage rather than sharing one, because almost
 * nothing about the metadata survives the trip. A YouTube title carries
 * #Shorts and is the whole of what a viewer reads before clicking; a Facebook
 * Page video has a title nobody sees and a description that *is* the post. The
 * one thing that does carry over is the disclosure, and even that is a separate
 * declaration to a separate company rather than an inherited flag.
 */

const TITLE_MAX = 255;
const DESCRIPTION_MAX = 5000;

/**
 * Facebook Reels are short-form and capped well below the length of a narrated
 * storybook, so nothing here posts one. A Page video has no such ceiling.
 * This is only the point past which the distinction stops being academic.
 */
export const REEL_MAX_MS = 90_000;

export type FacebookPublishOptions = {
  sheet: BeatSheet;
  published?: boolean;
  title?: string;
  description?: string;
  onProgress?: (fraction: number) => void;
};

export type FacebookPublishResult = facebook.UploadResult & {
  file: string;
  metadata: facebook.VideoMetadata;
  probe: Probe;
  /** Said out loud because it decides how the post is treated, not refused. */
  couldBeReel: boolean;
};

function titleCase(topic: string): string {
  return topic.charAt(0).toUpperCase() + topic.slice(1);
}

export function buildFacebookTitle(sheet: BeatSheet, override?: string): string {
  const base = (override ?? titleCase(sheet.meta.topic)).replace(/\s+/g, ' ').trim();
  // No #Shorts. It means nothing here and reads as a video posted to the wrong
  // place, which is exactly what it would be.
  return base.slice(0, TITLE_MAX);
}

/**
 * The post's text.
 *
 * Not the narration. On YouTube the description sits under a fold nobody opens
 * and repeating the script there is harmless; on a Page the description is the
 * post — it is what appears in the feed above the video, and a wall of the
 * words you are about to hear read aloud is the worst thing to put there. So
 * this is the topic, then the attribution the licences actually require, and
 * nothing in between pretending to be writing.
 *
 * "Actually require" is doing work there. The full credits file also lists the
 * prompt behind every generated panel, under a heading that says in so many
 * words that there is nobody to credit — a useful working note and a terrible
 * opening line for a post. Those are dropped; photographs and footage stay.
 */
export function buildFacebookDescription(sheet: BeatSheet, override?: string): string {
  if (override !== undefined) return override.slice(0, DESCRIPTION_MAX);

  const credits = requiredCredits(sheet.meta.slug);
  return [titleCase(sheet.meta.topic), '', credits]
    .join('\n')
    .trim()
    .slice(0, DESCRIPTION_MAX);
}

export function buildFacebookMetadata(
  sheet: BeatSheet,
  options: { published?: boolean; title?: string; description?: string } = {},
): facebook.VideoMetadata {
  return {
    title: buildFacebookTitle(sheet, options.title),
    description: buildFacebookDescription(sheet, options.description),
    // The voice is synthesised on every render, so this is never not true.
    containsSyntheticMedia: true,
    published: options.published ?? env.FACEBOOK_PUBLISHED,
  };
}

export async function publishToFacebook(
  options: FacebookPublishOptions,
): Promise<FacebookPublishResult> {
  const file = renderedFile(options.sheet.meta.slug);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${path.relative(dirs.root, file)} does not exist — render the video before publishing it.`,
    );
  }

  const metadata = buildFacebookMetadata(options.sheet, {
    ...(options.published !== undefined ? { published: options.published } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  });

  return sendToFacebook({
    slug: options.sheet.meta.slug,
    topic: options.sheet.meta.topic,
    file,
    metadata,
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
  });
}

/** The upload itself, shared by shorts and long videos; only the metadata differs. */
export async function sendToFacebook(options: {
  slug: string;
  topic: string;
  file: string;
  metadata: facebook.VideoMetadata;
  onProgress?: (fraction: number) => void;
}): Promise<FacebookPublishResult> {
  const { file, metadata } = options;
  const probe = await probeVideo(file);

  const page = facebook.connectedPage();
  log.info(`facebook: uploading ${path.basename(file)} to "${page?.name ?? 'the Page'}"`);
  log.info(`facebook: posting ${metadata.published ? 'published' : 'unpublished'}`);

  const result = await facebook.uploadVideo({
    file,
    metadata,
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
  });

  recordPost({
    platform: 'facebook',
    slug: options.slug,
    topic: options.topic,
    remoteId: result.videoId,
    url: result.url,
    title: metadata.title,
    visibility: result.published ? 'published' : 'unpublished',
  });

  return {
    ...result,
    file,
    metadata,
    probe,
    couldBeReel: probe.durationMs <= REEL_MAX_MS && probe.height > probe.width,
  };
}
