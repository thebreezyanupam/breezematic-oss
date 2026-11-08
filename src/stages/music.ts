import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assetDirs } from '../config.js';
import { probeDurationMs } from '../ffmpeg.js';
import { log } from '../log.js';
import { rngFor } from '../rng.js';
import { generateScore } from './score.js';

const TRACK_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus']);

export type Track = {
  /** Filename as it sits in assets/music, which is how it is chosen. */
  name: string;
  /** Repo-relative, so the beat sheet stays portable. */
  trackPath: string;
};

export type MusicChoice = Track & { startOffsetMs: number };

/** Reserved name for the bed BreezeMatic writes itself. */
export const GENERATED_NAME = 'generated';

/** Anything droppable in assets/music, sorted so the pick is stable. */
export function listTracks(dir: string = assetDirs.music): Track[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && TRACK_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      trackPath: path.relative(ROOT, path.join(dir, name)).split(path.sep).join('/'),
    }));
}

/**
 * Picks the bed for a video. `preferred` is a filename from assets/music, the
 * literal string "none" to go without, or undefined to let the seed choose so
 * the same topic always gets the same track.
 *
 * Music is never required: with an empty assets/music the mix stage simply
 * runs narration-only, which is what it has always done.
 */
export async function chooseTrack(options: {
  seed: number;
  slug: string;
  preferred?: string | undefined;
  durationMs: number;
}): Promise<MusicChoice | null> {
  if (options.preferred === 'none') return null;

  const tracks = listTracks();

  // Nothing in assets/music is not a reason to ship a silent video. A bed is
  // generated instead, seeded so the same topic always scores the same way.
  if (tracks.length === 0 || options.preferred === 'generated') {
    return generated(options);
  }

  let chosen: Track | undefined;
  if (options.preferred !== undefined) {
    chosen = tracks.find((track) => track.name === options.preferred);
    if (chosen === undefined) {
      log.warn(`"${options.preferred}" is not in ${assetDirs.music}; picking by seed instead`);
    }
  }
  if (chosen === undefined) {
    const rng = rngFor(options.seed, 'music');
    chosen = tracks[Math.floor(rng() * tracks.length)] ?? tracks[0];
  }
  if (chosen === undefined) return null;

  return { ...chosen, startOffsetMs: await startOffset(chosen, options) };
}

/** The generated bed is written to length, so it always starts at its own zero. */
async function generated(options: {
  seed: number;
  durationMs: number;
}): Promise<MusicChoice> {
  const file = await generateScore({ seed: options.seed, durationMs: options.durationMs });
  return {
    name: GENERATED_NAME,
    trackPath: path.relative(ROOT, file).split(path.sep).join('/'),
    startOffsetMs: 0,
  };
}

/**
 * Long tracks rarely open the way a 40 second short wants to, so start
 * somewhere inside them — deterministically, and always leaving the whole
 * video's worth of audio ahead of the cursor.
 */
async function startOffset(
  track: Track,
  options: { seed: number; slug: string; durationMs: number },
): Promise<number> {
  const file = path.resolve(ROOT, track.trackPath);
  let trackMs: number;
  try {
    trackMs = await probeDurationMs(file);
  } catch (error) {
    log.warn(`could not read ${track.name} (${(error as Error).message}); starting at 0`);
    return 0;
  }

  const room = trackMs - options.durationMs;
  if (room <= 0) return 0;

  const rng = rngFor(options.seed, `music-offset-${track.name}`);
  // Skip the first few seconds, which are usually a fade-in.
  const earliest = Math.min(4_000, room);
  return Math.round(earliest + rng() * (room - earliest));
}
