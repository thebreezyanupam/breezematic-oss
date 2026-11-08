import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { dirs } from '../config.js';
import { readJson, writeJsonAtomic } from '../json.js';
import { log } from '../log.js';
import {
  IMAGE_SOURCES,
  IMAGERY_MODES,
  RENDER_MODES,
  STYLE_NAMES,
  SUBTITLE_MODES,
  ART_STYLES,
  EFFECT_NAMES,
  SFX_CUES,
} from '../schema.js';

/**
 * A series: a named format you make videos in, rather than a folder you put
 * them in afterwards.
 *
 * The distinction matters. A playlist collects finished videos; this collects
 * the decisions that made them. "Books in 60 seconds" is not a label — it is an
 * angle, a length, an illustrated look, one reader, and a genre to draw topics
 * from, and the reason a channel looks like a channel is that all of those stay
 * fixed while only the subject changes.
 *
 * So a series is the settings, and every video records which one it came from.
 * Picking a series fills the form; the library groups by it afterwards.
 */

const FILE = () => path.join(dirs.work, 'series.json');

/** Lower-case, dashed, so it can be a key and appear in a URL unescaped. */
const seriesId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'series id must be lowercase kebab-case')
  .max(64);

/**
 * Every field is optional. A series is a partial recipe on purpose: "anime
 * power explained" might fix the look and the reader and leave the music alone,
 * and forcing a complete set would mean inventing values the author never chose.
 */
export const seriesSchema = z
  .object({
    id: seriesId,
    name: z.string().min(1).max(80),
    /** Shown under the picker, and nowhere else. */
    note: z.string().max(200).default(''),
    /** The standing Direction: what every script in this series should do. */
    brief: z.string().max(2000).default(''),
    /** Which topic category Suggest draws from for this series. */
    genre: z.string().max(40).default('any'),
    createdMs: z.number().int().nonnegative(),
    settings: z
      .object({
        mode: z.enum(RENDER_MODES).optional(),
        imagery: z.enum(IMAGERY_MODES).optional(),
        imageSource: z.enum(IMAGE_SOURCES).optional(),
        effect: z.enum(EFFECT_NAMES).optional(),
        style: z.enum(STYLE_NAMES).optional(),
        subtitles: z.enum(SUBTITLE_MODES).optional(),
        /** Which sound-effect cues this format keeps audible. */
        sfxCues: z.array(z.enum(SFX_CUES)).optional(),
        artStyle: z.enum(ART_STYLES).optional(),
        captionScale: z.number().min(0.1).max(2).optional(),
        character: z.string().max(40).optional(),
        ttsProvider: z.enum(['kokoro', 'gemini', 'elevenlabs', 'clone']).optional(),
        /** The illustrated looks' paper texture behind each panel. */
        panelTexture: z.boolean().optional(),
        tone: z.string().max(40).optional(),
        music: z.string().max(200).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Series = z.infer<typeof seriesSchema>;

const fileSchema = z.object({ series: z.array(seriesSchema).max(200) }).strict();

export function listSeries(): Series[] {
  const file = FILE();
  if (!fs.existsSync(file)) return [];
  try {
    return fileSchema.parse(readJson(file)).series;
  } catch (error) {
    // A malformed file is the operator's to fix, and losing the picker is a
    // worse outcome than losing one bad entry, so this reports and carries on.
    log.warn(`series: ${path.basename(file)} could not be read (${(error as Error).message})`);
    return [];
  }
}

function save(all: readonly Series[]): void {
  fs.mkdirSync(dirs.work, { recursive: true });
  writeJsonAtomic(FILE(), { series: [...all].sort((a, b) => a.createdMs - b.createdMs) });
}

/** Creates or replaces one series, keyed by id. */
export function putSeries(input: unknown): Series {
  const entry = seriesSchema.parse(input);
  const all = listSeries().filter((existing) => existing.id !== entry.id);
  save([...all, entry]);
  log.info(`series: saved "${entry.name}"`);
  return entry;
}

/**
 * Forgets a series. The videos made in it are untouched: they carry the name
 * they were made under, and deleting the recipe should not orphan or erase a
 * single finished video.
 */
export function deleteSeries(id: string): boolean {
  const all = listSeries();
  const left = all.filter((entry) => entry.id !== id);
  if (left.length === all.length) return false;
  save(left);
  log.info(`series: removed "${id}"`);
  return true;
}

/** A name to an id, deduped against what already exists. */
export function idFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'series';
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}
