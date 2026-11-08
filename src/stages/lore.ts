import fs from 'node:fs';
import { workSlug } from '../workslug.js';
import path from 'node:path';
import { AUDIO, ROOT, dirs, workDir } from '../config.js';
import { ffmpeg, probeDurationMs } from '../ffmpeg.js';
import { log } from '../log.js';
import { slugify } from '../text.js';
import { hashString } from '../rng.js';
import { generateSaga, SAGA_WORDS_PER_MINUTE } from './saga.js';
import { generateScore } from './score.js';
import { generateAmbience, AMBIENCE_LABELS, type AmbienceName } from './ambience.js';
import { synthesizeVoice } from './voice.js';
import { generateStill } from './still.js';

/**
 * The long-form path, as a function the app can drive rather than a command
 * that prints.
 *
 * It was written as a CLI action: do a thing, `out()` a line, do the next
 * thing. That is fine for a terminal and useless to anything else, which is
 * why the only way to make a three-hour video was to type a command — the
 * engine had been finished for weeks and nothing could reach it.
 *
 * So the work is here and reports through `onStage`, the way the beat-sheet
 * pipeline does, and the command becomes a printer for what this returns.
 */

const FPS = 24;
/**
 * How far the still is enlarged before zoompan crops into it.
 *
 * zoompan truncates its crop origin to whole SOURCE pixels, so the upscale
 * decides how finely the pan can be positioned: at 2x one source pixel is half
 * an output pixel. It was 4x, and 4x is smoother -- but zoompan re-reads the
 * whole enlarged frame every frame, so the cost is linear in its area, and 4x
 * is four times the area of 2x. Measured, encoding 30s of output:
 *
 *     4x source    36.1s        2x source    12.4s
 *
 * Which is 23 minutes against 8 for a twenty-minute video. The drift itself
 * moves 0.58 output pixels per frame whatever the upscale -- only its
 * quantisation changes -- so 2x rounds a half-pixel motion to the half pixel,
 * on an image chosen to be soft and atmospheric. Pre-scaling the still once
 * instead of per frame was tried and changes nothing: the cost is in the
 * reading, not the scaling.
 */
const DRIFT_UPSCALE = 2;
const WIDTH = 1920;
const HEIGHT = 1080;

/**
 * Four minutes rather than two. Every loop join is a moment a listener can
 * notice, and halving how often it comes round halves the chances -- which
 * matters a great deal more across three hours than across three minutes.
 */
const BED_LOOP_MS = 240_000;

export type LoreStage = 'saga' | 'voice' | 'still' | 'bed' | 'assemble';

export type LoreOptions = {
  topic: string;
  minutes: number;
  seed?: number;
  character?: string;
  ttsProvider?: string;
  cloneVoice?: string;
  /** Which ElevenLabs voice reads it, by id, when the engine is 'elevenlabs'. */
  elevenVoice?: string;
  generated?: boolean;
  bed?: AmbienceName;
  force: boolean;
  onStage?: (stage: LoreStage) => void;
  /** Line-by-line, because the reading is most of the wait. */
  onProgress?: (done: number, total: number) => void;
};

export type LoreResult = {
  slug: string;
  title: string;
  words: number;
  chapters: number;
  /** What it actually came out at, which is never quite what was asked for. */
  durationMs: number;
  /** Words per minute achieved, against the pace the writing assumed. */
  wpm: number;
  assumedWpm: number;
  bed: string;
  output: string;
  sizeBytes: number;
};

/**
 * The whole reason a three-hour video is affordable.
 *
 * A short is rendered a frame at a time through headless Chrome, which is right
 * when every frame differs. Here almost nothing moves: one still, drifting.
 * Rendering that as 260,000 individual frames would take longer than the video
 * lasts, so it is not rendered at all -- ffmpeg zooms one image and encodes the
 * result, which costs the same at ten minutes as at three hours.
 *
 * zoompan runs on a frame counter, so the drift is expressed per frame rather
 * than per second, and the input is upscaled first: zoompan samples its output
 * from the source pixel grid, and zooming a 1920-wide still directly leaves
 * visible stepping as the crop window creeps.
 */
function driftFilter(frames: number): string {
  return [
    `scale=${WIDTH * DRIFT_UPSCALE}:-1`,
    `zoompan=z='min(1.0006*zoom,1.18)':d=${frames}` +
      `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    // A little grain, or a slow gradient over a flat sky bands badly at this bitrate.
    'noise=alls=6:allf=t',
    'format=yuv420p',
  ].join(',');
}

export async function produceLore(options: LoreOptions): Promise<LoreResult> {
  const slug = workSlug('lore', options.topic);
  const seed = options.seed ?? hashString(slug);
  const dir = workDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const stage = (name: LoreStage): void => options.onStage?.(name);

  stage('saga');
  const saga = await generateSaga({
    topic: options.topic,
    seed,
    minutes: options.minutes,
    force: options.force,
  });
  const prose = saga.chapters.join('\n\n');
  fs.writeFileSync(path.join(dir, 'saga.txt'), `${saga.title}\n\n${prose}`, 'utf8');

  /**
   * The picture before the reading, because of what it costs to be wrong.
   *
   * This used to run after the voice, which is the natural reading order and
   * exactly the wrong execution order: finding a picture takes seconds and can
   * fail, reading takes half an hour and rarely does. A topic with no usable
   * photograph therefore failed forty-five minutes in, having thrown away
   * everything. Whatever is going to go wrong here goes wrong two minutes in
   * now.
   */
  stage('still');
  const still = await generateStill({
    topic: options.topic,
    world: saga.bible.world,
    seed,
    force: options.force,
    slug,
    ...(options.generated === true ? { generated: true } : {}),
  });

  stage('voice');
  // Already chunks by sentence and concatenates, so length is not its problem.
  const voice = await synthesizeVoice({
    spokenText: prose,
    slug,
    force: options.force,
    ...(options.character !== undefined ? { character: options.character } : {}),
    ...(options.ttsProvider !== undefined ? { provider: options.ttsProvider } : {}),
    ...(options.cloneVoice !== undefined ? { cloneVoice: options.cloneVoice } : {}),
    ...(options.elevenVoice !== undefined ? { elevenVoice: options.elevenVoice } : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    seed,
  });
  const narrationMs = await probeDurationMs(voice.audioPath);

  stage('bed');
  const kind = options.bed ?? 'rain';
  const bed =
    kind === 'drone'
      ? await generateScore({ seed, durationMs: BED_LOOP_MS, force: options.force })
      : await generateAmbience({ kind, seed, durationMs: BED_LOOP_MS, force: options.force });

  stage('assemble');
  const frames = Math.ceil((narrationMs / 1000) * FPS);
  const output = path.join(dirs.out, `${slug}-lore.mp4`);
  fs.mkdirSync(dirs.out, { recursive: true });

  log.info(`assembling ${(narrationMs / 60000).toFixed(1)} min at ${FPS}fps`);
  await ffmpeg([
    '-loop', '1', '-i', still,
    '-i', voice.audioPath,
    '-stream_loop', '-1', '-i', bed,
    '-filter_complex',
    [
      `[0:v]${driftFilter(frames)}[v]`,
      // The bed sits well under a voice mastered to -16, and ducking would
      // pump audibly across an hour. It is simply quiet, and fades out at the end.
      `[2:a]volume=-26dB,afade=t=out:st=${(narrationMs - 12_000) / 1000}:d=12[bed]`,
      `[1:a][bed]amix=inputs=2:duration=first:dropout_transition=0,` +
        `loudnorm=I=${AUDIO.masterLufs}:TP=${AUDIO.truePeakDb}:LRA=11[a]`,
    ].join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-r', String(FPS),
    // Pinned, because it was not. The bed and the narration arrive at whatever
    // rate their own stages chose, loudnorm happily hands on 96kHz, and the
    // encoder took it -- so a three-hour file was carrying a sample rate no
    // player wants and every platform resamples away.
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO.sampleRate),
    '-t', String(narrationMs / 1000),
    '-movflags', '+faststart',
    '-y', output,
  ]);

  return {
    slug,
    title: saga.title,
    words: saga.wordCount,
    chapters: saga.chapters.length,
    durationMs: narrationMs,
    wpm: Math.round(saga.wordCount / (narrationMs / 60000)),
    assumedWpm: SAGA_WORDS_PER_MINUTE,
    bed: AMBIENCE_LABELS[kind],
    output: path.relative(ROOT, output).split(path.sep).join('/'),
    sizeBytes: fs.statSync(output).size,
  };
}
