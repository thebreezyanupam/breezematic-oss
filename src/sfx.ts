import fs from 'node:fs';
import path from 'node:path';
import { assetDirs } from './config.js';
import { SFX_CUES, type Sfx, type SfxCue } from './schema.js';

const SAMPLE_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.oga', '.aif', '.aiff', '.m4a']);

export type SfxLibrary = {
  dir: string;
  samples: Record<SfxCue, string[]>;
  unmatched: string[];
};

export type Placement = {
  cue: Sfx;
  file: string;
};

export type CueCoverage = {
  cue: SfxCue;
  cues: number;
  samples: number;
  placed: number;
  /** Whether the sheet asked for this cue to be audible at all. */
  on: boolean;
};

/**
 * Samples are matched by filename prefix, so `whoosh.wav`, `whoosh-01.wav` and
 * `whoosh_soft.aiff` all serve the whoosh cue. Sorting keeps variant selection
 * stable no matter what order the filesystem hands them back.
 */
export function loadSfxLibrary(dir: string = assetDirs.sfx): SfxLibrary {
  const samples = Object.fromEntries(SFX_CUES.map((cue) => [cue, [] as string[]])) as Record<
    SfxCue,
    string[]
  >;
  const unmatched: string[] = [];

  if (!fs.existsSync(dir)) return { dir, samples, unmatched };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!SAMPLE_EXTENSIONS.has(extension)) continue;

    const stem = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
    const cue = SFX_CUES.find((name) => matchesCue(stem, name));
    if (cue === undefined) {
      unmatched.push(entry.name);
      continue;
    }
    samples[cue].push(path.join(dir, entry.name));
  }

  return { dir, samples, unmatched };
}

function matchesCue(stem: string, cue: SfxCue): boolean {
  if (!stem.startsWith(cue)) return false;
  const rest = stem.slice(cue.length);
  return rest.length === 0 || /^[^a-z]/.test(rest);
}

export function resolveCue(library: SfxLibrary, cue: SfxCue, variant: number): string | undefined {
  const samples = library.samples[cue];
  if (samples.length === 0) return undefined;
  return samples[variant % samples.length];
}

export function placeCues(library: SfxLibrary, cues: readonly Sfx[]): Placement[] {
  const placements: Placement[] = [];
  for (const cue of cues) {
    const file = resolveCue(library, cue.cue, cue.variant);
    if (file !== undefined) placements.push({ cue, file });
  }
  return placements;
}

/**
 * What each cue amounts to in this video: how many the plan wrote, how many
 * samples are available to play them with, and how many will be heard.
 *
 * `enabled` is what the author chose. A cue that is switched off still reports
 * the count the sheet holds, because "89 of these exist and none of them are
 * playing" is the fact worth showing -- it is the number somebody needs to see
 * before deciding whether to switch it on.
 */
export function coverage(
  library: SfxLibrary,
  cues: readonly Sfx[],
  enabled: readonly SfxCue[],
): CueCoverage[] {
  return SFX_CUES.map((cue) => {
    const wanted = cues.filter((entry) => entry.cue === cue);
    const samples = library.samples[cue].length;
    const on = enabled.includes(cue);
    return {
      cue,
      cues: wanted.length,
      samples,
      placed: on && samples > 0 ? wanted.length : 0,
      on,
    };
  });
}

/** The cues the author left switched on, in sheet order. */
export function audibleCues(cues: readonly Sfx[], enabled: readonly SfxCue[]): Sfx[] {
  return cues.filter((entry) => enabled.includes(entry.cue));
}
