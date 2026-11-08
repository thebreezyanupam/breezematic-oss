import fs from 'node:fs';
import path from 'node:path';
import { AUDIO, dirs, resolveFromRoot, workDir } from '../config.js';
import { cache, hashFile } from '../cache.js';
import { BITEXACT, ffmpeg, probeVideoDurationMs } from '../ffmpeg.js';
import {
  dbToLinear,
  duckRatio,
  loudnormFilter,
  measureLoudness,
  type Loudness,
  type LoudnessTarget,
} from '../loudness.js';
import { log } from '../log.js';
import {
  audibleCues,
  coverage,
  loadSfxLibrary,
  placeCues,
  type CueCoverage,
  type Placement,
} from '../sfx.js';
import { SFX_CUES, type BeatSheet } from '../schema.js';
import { picturePath } from './render.js';
import { planWarSound, writeWarCredits } from './warsound.js';
import { planExplainerSound } from './explainsound.js';
import { DUCK_DB } from './essaysound.js';
import type { StickBeat } from './stickworld.js';

export type MixResult = {
  outputPath: string;
  picturePath: string;
  durationMs: number;
  stems: {
    narration: string;
    music: string | undefined;
    sfx: string | undefined;
  };
  cues: { total: number; placed: number };
  coverage: CueCoverage[];
  unmatchedSamples: string[];
  narrationLoudness: Loudness;
  masterLoudness: Loudness;
};

const STEM_FORMAT = `aformat=sample_fmts=fltp:sample_rates=${AUDIO.sampleRate}:channel_layouts=stereo`;

const WAV_OUTPUT = [
  '-ar', String(AUDIO.sampleRate),
  '-ac', String(AUDIO.channels),
  '-c:a', 'pcm_s16le',
  ...BITEXACT,
  '-f', 'wav',
];

/**
 * Cutting a stem to length belongs on the output, not in the filter graph:
 * `atrim` after `apad` throws the padding away and hands back a stem that stops
 * at its last real sample, so the stems no longer line up with each other.
 */
function wavOutput(durationMs: number): string[] {
  return ['-t', seconds(durationMs), ...WAV_OUTPUT];
}

const NARRATION_TARGET: LoudnessTarget = {
  lufs: AUDIO.narrationLufs,
  truePeakDb: AUDIO.stemTruePeakDb,
};
/**
 * The bed's level is per video, not a house constant: how loud music should sit
 * depends on the piece. `AUDIO.musicLufs` is only the default the planner
 * stamps onto a new sheet.
 */
function musicTarget(sheet: BeatSheet): LoudnessTarget {
  return { lufs: sheet.music.levelLufs, truePeakDb: AUDIO.stemTruePeakDb };
}

/** Bed in and out. Zero-length fades are left out of the graph entirely. */
function musicFades(sheet: BeatSheet, durationMs: number): string[] {
  const filters: string[] = [];
  const { fadeInMs, fadeOutMs } = sheet.music;

  if (fadeInMs > 0) {
    filters.push(`afade=t=in:st=0:d=${seconds(Math.min(fadeInMs, durationMs))}`);
  }
  if (fadeOutMs > 0) {
    const span = Math.min(fadeOutMs, durationMs);
    filters.push(`afade=t=out:st=${seconds(durationMs - span)}:d=${seconds(span)}`);
  }
  return filters;
}
const MASTER_TARGET: LoudnessTarget = { lufs: AUDIO.masterLufs, truePeakDb: AUDIO.truePeakDb };

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/**
 * Every stem runs the full length of the picture. `whole_dur` is not optional:
 * a bare `apad` never emits its padding and the graph stalls at the last
 * sample instead of reaching EOF.
 */
function padTo(durationMs: number): string {
  return `apad=whole_dur=${seconds(durationMs)}`;
}

async function narrationStem(
  sheet: BeatSheet,
  durationMs: number,
): Promise<{ path: string; loudness: Loudness }> {
  const source = resolveFromRoot(sheet.voice.audioPath);
  if (!fs.existsSync(source)) {
    throw new Error(`narration audio not found: ${source} (run "breezematic voice" first)`);
  }

  const sha = hashFile(source);
  const measured = await cache.json('mix-measure', { sha, ...NARRATION_TARGET }, () =>
    measureLoudness(source, NARRATION_TARGET),
  );

  const stem = await cache.file(
    'mix-narration',
    { sha, ...NARRATION_TARGET, durationMs, rate: AUDIO.sampleRate },
    '.wav',
    async (destination) => {
      log.info(`narration ${measured.value.integratedLufs} -> ${AUDIO.narrationLufs} LUFS`);
      await ffmpeg([
        '-i', source,
        '-af', [
          loudnormFilter(measured.value, NARRATION_TARGET),
          `aresample=${AUDIO.sampleRate}`,
          padTo(durationMs),
        ].join(','),
        ...wavOutput(durationMs), destination,
      ]);
    },
  );

  return { path: stem.path, loudness: measured.value };
}

async function musicStem(sheet: BeatSheet, durationMs: number): Promise<string | undefined> {
  const track = sheet.music.trackPath.trim();
  if (track === '') return undefined;

  const source = resolveFromRoot(track);
  if (!fs.existsSync(source)) {
    log.warn(`music track not found, mixing without it: ${source}`);
    return undefined;
  }

  const target = musicTarget(sheet);
  const sha = hashFile(source);
  const measured = await cache.json('mix-measure', { sha, ...target }, () =>
    measureLoudness(source, target),
  );

  const stem = await cache.file(
    'mix-music',
    {
      sha,
      ...target,
      durationMs,
      startOffsetMs: sheet.music.startOffsetMs,
      fadeInMs: sheet.music.fadeInMs,
      fadeOutMs: sheet.music.fadeOutMs,
      rate: AUDIO.sampleRate,
    },
    '.wav',
    async (destination) => {
      log.info(`music ${measured.value.integratedLufs} -> ${target.lufs} LUFS`);
      await ffmpeg([
        '-stream_loop', '-1',
        '-ss', seconds(sheet.music.startOffsetMs),
        '-i', source,
        '-af', [
          loudnormFilter(measured.value, target),
          `aresample=${AUDIO.sampleRate}`,
          padTo(durationMs),
          // After the pad, so the fade-out lands on the end of the video and
          // not on the end of whatever the track happened to give us.
          ...musicFades(sheet, durationMs),
        ].join(','),
        ...wavOutput(durationMs), destination,
      ]);
    },
  );

  return stem.path;
}

/**
 * One input per distinct sample file, fanned out with asplit so a cue that
 * fires 76 times still decodes its sample once. Returns the input file list in
 * the order the graph indexes them.
 */
export function sfxGraph(
  placements: readonly Placement[],
  durationMs: number,
): { files: string[]; graph: string } {
  const files = [...new Set(placements.map((placement) => placement.file))];
  const inputIndex = new Map(files.map((file, index) => [file, index]));
  const useCount = new Map<string, number>();
  for (const placement of placements) {
    useCount.set(placement.file, (useCount.get(placement.file) ?? 0) + 1);
  }

  const graph: string[] = [];
  for (const [file, index] of inputIndex) {
    const total = useCount.get(file) ?? 0;
    const outputs = Array.from({ length: total }, (_, copy) => `[s${index}_${copy}]`).join('');
    graph.push(`[${index}:a]${STEM_FORMAT},asplit=${total}${outputs}`);
  }

  const taken = new Map<string, number>();
  placements.forEach((placement, cueIndex) => {
    const index = inputIndex.get(placement.file) ?? 0;
    const copy = taken.get(placement.file) ?? 0;
    taken.set(placement.file, copy + 1);
    graph.push(
      `[s${index}_${copy}]adelay=${placement.cue.atMs}:all=1,` +
        `volume=${placement.cue.gainDb}dB[c${cueIndex}]`,
    );
  });

  const sum = placements.map((_, cueIndex) => `[c${cueIndex}]`).join('');
  graph.push(
    `${sum}amix=inputs=${placements.length}:normalize=0:dropout_transition=0,` +
      `${padTo(durationMs)},${STEM_FORMAT}[bed]`,
  );

  return { files, graph: graph.join(';') };
}

async function sfxStem(
  placements: readonly Placement[],
  durationMs: number,
): Promise<string | undefined> {
  if (placements.length === 0) return undefined;

  const { files, graph } = sfxGraph(placements, durationMs);

  const key = {
    durationMs,
    rate: AUDIO.sampleRate,
    cues: placements.map((placement) => ({
      sha: hashFile(placement.file),
      atMs: placement.cue.atMs,
      gainDb: placement.cue.gainDb,
    })),
  };

  const stem = await cache.file('mix-sfx', key, '.wav', async (destination) => {
    log.info(`sfx bed: ${placements.length} cue(s) from ${files.length} sample(s)`);
    await ffmpeg([
      ...files.flatMap((file) => ['-i', file]),
      '-filter_complex', graph,
      '-map', '[bed]',
      ...wavOutput(durationMs), destination,
    ]);
  });

  return stem.path;
}

async function mixdown(
  stems: { narration: string; music: string | undefined; sfx: string | undefined },
  durationMs: number,
): Promise<string> {
  const inputs = [stems.narration];
  const graph: string[] = [];
  const sum: string[] = [];

  if (stems.music !== undefined) {
    const musicIndex = inputs.push(stems.music) - 1;
    const ratio = duckRatio(AUDIO.duckDb, AUDIO.duckOvershootDb);
    graph.push('[0:a]asplit=2[narration][key]');
    graph.push(
      `[${musicIndex}:a][key]sidechaincompress=` +
        `threshold=${dbToLinear(AUDIO.duckThresholdDb).toFixed(6)}:` +
        `ratio=${ratio.toFixed(3)}:` +
        `attack=${AUDIO.duckAttackMs}:release=${AUDIO.duckReleaseMs}:` +
        'makeup=1:level_sc=1:detection=rms[ducked]',
    );
    sum.push('[narration]', '[ducked]');
  } else {
    sum.push('[0:a]');
  }

  if (stems.sfx !== undefined) {
    sum.push(`[${inputs.push(stems.sfx) - 1}:a]`);
  }

  const tail = `${padTo(durationMs)},${STEM_FORMAT}[mix]`;
  graph.push(
    sum.length === 1
      ? `${sum[0]}${tail}`
      : `${sum.join('')}amix=inputs=${sum.length}:normalize=0:dropout_transition=0,${tail}`,
  );

  const result = await cache.file(
    'mix-sum',
    {
      stems: inputs.map((file) => path.basename(file)),
      duck:
        stems.music === undefined
          ? null
          : {
              db: AUDIO.duckDb,
              thresholdDb: AUDIO.duckThresholdDb,
              overshootDb: AUDIO.duckOvershootDb,
              attackMs: AUDIO.duckAttackMs,
              releaseMs: AUDIO.duckReleaseMs,
            },
      durationMs,
    },
    '.wav',
    async (destination) => {
      await ffmpeg([
        ...inputs.flatMap((file) => ['-i', file]),
        '-filter_complex', graph.join(';'),
        '-map', '[mix]',
        ...wavOutput(durationMs), destination,
      ]);
    },
  );

  return result.path;
}

async function master(source: string): Promise<{ path: string; loudness: Loudness }> {
  const sha = hashFile(source);
  const measured = await cache.json('mix-measure', { sha, ...MASTER_TARGET }, () =>
    measureLoudness(source, MASTER_TARGET),
  );

  const result = await cache.file(
    'mix-master',
    { sha, ...MASTER_TARGET, rate: AUDIO.sampleRate },
    '.wav',
    async (destination) => {
      log.info(`master ${measured.value.integratedLufs} -> ${AUDIO.masterLufs} LUFS`);
      await ffmpeg([
        '-i', source,
        '-af', [
          loudnormFilter(measured.value, MASTER_TARGET),
          // loudnorm's linear mode already respects TP; this is the hard ceiling.
          `alimiter=limit=${dbToLinear(AUDIO.truePeakDb).toFixed(6)}:level=disabled`,
          `aresample=${AUDIO.sampleRate}`,
        ].join(','),
        ...WAV_OUTPUT, destination,
      ]);
    },
  );

  return { path: result.path, loudness: measured.value };
}

export async function mixVideo(sheet: BeatSheet, options: { force: boolean }): Promise<MixResult> {
  cache.setForce(options.force);

  const picture = picturePath(sheet.meta.slug);
  if (!fs.existsSync(picture)) {
    throw new Error(`picture track not found: ${picture} (run "breezematic render" first)`);
  }

  // The picture is the master clock: rounding to whole frames can put it a few
  // milliseconds away from meta.durationMs, and the audio has to follow it.
  const durationMs = await probeVideoDurationMs(picture);

  const library = loadSfxLibrary();
  /**
   * The sheet keeps every cue the plan could justify; this is where the ones
   * the author switched off stop being audible. Filtering here rather than at
   * plan time is what makes the choice cheap: changing it is a re-mix, and the
   * clicks are still in the sheet to switch back on.
   */
  const wanted = audibleCues(sheet.sfx, sheet.meta.sfxCues);
  const muted = sheet.sfx.length - wanted.length;
  if (muted > 0) {
    const off = SFX_CUES.filter((cue) => !sheet.meta.sfxCues.includes(cue));
    log.info(`sfx: ${off.join(', ')} switched off (${muted} cue(s) not mixed)`);
  }
  const placements = placeCues(library, wanted);
  if (placements.length === 0 && wanted.length > 0) {
    log.warn(`no samples in ${library.dir}: mixing ${wanted.length} cue(s) as silence`);
  }

  /**
   * The war channel's story sounds, when the stick figure was staged for it:
   * the gunshot on "fire", the rimshot after the punchline. Planned from the
   * beats rather than stored as cues, so the sheet keeps one source of truth
   * for what was staged and the sounds follow it.
   *
   * The levels are the essay mix's, which ducks its effects 12 dB and lifts
   * these back out of it; this mix does not duck, so the lift comes off.
   */
  const warBeats = sheet.beats.flatMap((beat) =>
    beat.stage?.war === undefined
      ? []
      : [{ id: beat.id, startMs: beat.startMs, endMs: beat.endMs, action: beat.action ?? 'stand', stage: beat.stage as StickBeat['stage'] }],
  );
  if (warBeats.length > 0) {
    // The voice file on its own clock, which in a short is the video's.
    const war = await planWarSound(warBeats, sheet.meta.seed, {
      narration: { path: resolveFromRoot(sheet.voice.audioPath), offsetMs: 0 },
      voiceLufs: AUDIO.narrationLufs,
      trimDb: sheet.meta.warSfxDb,
    });
    for (const cue of war.cues) {
      placements.push({ file: cue.file, cue: { cue: 'impact', atMs: cue.atMs, gainDb: cue.gainDb + DUCK_DB, variant: 0 } });
    }
    writeWarCredits(workDir(sheet.meta.slug), warBeats, war);
    log.info(`sfx: ${war.cues.length} war and comedy cue(s) on their words`);
  }

  // The explainer's graphics and its subscribe plug, each on its frame.
  if (sheet.meta.mode === 'explainer') {
    placements.push(
      ...(await planExplainerSound(sheet, {
        narrationPath: resolveFromRoot(sheet.voice.audioPath),
        voiceLufs: AUDIO.narrationLufs,
      })),
    );
  }

  const narration = await narrationStem(sheet, durationMs);
  const [music, sfx] = await Promise.all([
    musicStem(sheet, durationMs),
    sfxStem(placements, durationMs),
  ]);

  const summed = await mixdown({ narration: narration.path, music, sfx }, durationMs);
  const mastered = await master(summed);

  const outputPath = path.join(dirs.out, `${sheet.meta.slug}.mp4`);
  fs.mkdirSync(dirs.out, { recursive: true });
  await ffmpeg([
    '-i', picture,
    '-i', mastered.path,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', AUDIO.aacBitrate,
    '-ar', String(AUDIO.sampleRate), '-ac', String(AUDIO.channels),
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ]);

  return {
    outputPath,
    picturePath: picture,
    durationMs,
    stems: { narration: narration.path, music, sfx },
    cues: { total: wanted.length, placed: placements.length },
    coverage: coverage(library, sheet.sfx, sheet.meta.sfxCues),
    unmatchedSamples: library.unmatched,
    narrationLoudness: narration.loudness,
    // Measured on the finished master, so this is what the file actually is.
    masterLoudness: await measureLoudness(outputPath, MASTER_TARGET),
  };
}
