import fs from 'node:fs';
import path from 'node:path';
import { SFX_GAIN_DB, SFX_LEAD_MS, assetDirs } from '../config.js';
import { loadSfxLibrary } from '../sfx.js';
import { cutAccents } from '../remotion/cinemaCuts.js';
import { titleKeystrokes } from '../remotion/titleType.js';
import { ffmpeg } from '../ffmpeg.js';
import { log } from '../log.js';
import type { EditPlan } from './edit.js';

/**
 * Sound effects for a long-form essay, placed from the edit plan.
 *
 * The shorts pipeline puts a cue on every caption, which is right at fifteen
 * cues a minute over forty seconds and intolerable over twenty-five minutes.
 * Here they mark structure instead: a swell into the hot stretch where a claim
 * lands, a hit on the claim itself, and nothing at all through the held
 * sections -- where the absence is the effect, and a single click would undo
 * it.
 *
 * Which means the count is small and deliberately so. A twenty-five minute
 * essay gets perhaps thirty cues, all of them on a seam the viewer can already
 * see. Effects that land anywhere else sound like a sound-effects library.
 */

export type Cue = {
  /**
   * 'whoosh' | 'impact' | 'riser' | 'click', matching assets/sfx -- or 'war',
   * a story sound from the library, placed on its word, which the editor can
   * switch off as one group without touching the edit's own whooshes.
   */
  kind: keyof typeof SFX_GAIN_DB | 'war';
  /** When the moment it marks happens. The lead is applied on the way out. */
  atMs: number;
  file: string;
  gainDb: number;
};

/** How much of the effects to use. */
export type SoundLevel = 'none' | 'sparse' | 'full';

/**
 * Ducked under the narration, per the brief.
 *
 * The number is not negotiable in the way a taste setting is: the product is
 * an argument, and the moment a viewer has to work to hear a word the video
 * has failed however good the edit sounded.
 */
export const DUCK_DB = -12;

function pick<T>(list: readonly T[], seed: number, salt: number): T | null {
  if (list.length === 0) return null;
  return list[Math.abs(seed + salt * 7919) % list.length] ?? null;
}

/**
 * Where the effects go.
 *
 * Every cue is tied to a segment boundary that already exists, so nothing is
 * placed on a timer and nothing needs its own notion of rhythm -- the edit
 * plan is the rhythm.
 */
export function planSound(options: {
  plan: EditPlan;
  seed: number;
  level: SoundLevel;
  /** Where the samples live. Defaults to assets/sfx. */
  dir?: string;
}): Cue[] {
  const { plan, seed, level } = options;
  if (level === 'none') return [];

  const library = loadSfxLibrary(options.dir ?? assetDirs.sfx);
  const missing = (['whoosh', 'impact', 'riser'] as const).filter(
    (kind) => library.samples[kind].length === 0,
  );
  if (missing.length > 0) {
    log.warn(
      `sound: no samples for ${missing.join(', ')} in ${path.relative(process.cwd(), library.dir)}`,
    );
  }

  const cues: Cue[] = [];
  let n = 0;

  for (const [index, segment] of plan.segments.entries()) {
    if (segment.register !== 'hot') continue;

    const previous = plan.segments[index - 1];
    const isTurn = segment.marksTurn === true;

    /**
     * A swell into the hit, but only where there is quiet to swell out of.
     * A riser that begins during another loud stretch is just more noise, and
     * the plan guarantees a cold segment before every hot one except the
     * opening -- so this is exactly the set of places it can work.
     */
    if (previous?.register === 'cold') {
      const kind = isTurn ? 'riser' : 'whoosh';
      const file = pick(library.samples[kind], seed, n++);
      if (file !== null) {
        cues.push({ kind, atMs: segment.startMs, file, gainDb: SFX_GAIN_DB[kind] });
      }
    }

    // The hit lands on the cut itself.
    const impact = pick(library.samples.impact, seed, n++);
    if (impact !== null) {
      cues.push({
        kind: 'impact',
        atMs: segment.startMs,
        file: impact,
        gainDb: SFX_GAIN_DB.impact,
      });
    }

    /**
     * Full adds a second hit partway through a long hot stretch, so a
     * ninety-second opening is not one accent and then silence. Sparse does
     * not, which is what makes it sparse.
     */
    if (level === 'full' && segment.endMs - segment.startMs > 20_000) {
      const extra = pick(library.samples.impact, seed, n++);
      if (extra !== null) {
        cues.push({
          kind: 'impact',
          atMs: Math.round((segment.startMs + segment.endMs) / 2),
          file: extra,
          gainDb: SFX_GAIN_DB.impact - 3,
        });
      }
    }
  }

  cues.sort((a, b) => a.atMs - b.atMs);
  log.info(`sound: ${cues.length} cue(s) on ${plan.segments.length} segments`);
  return cues;
}

/**
 * A whoosh under the cinematic cuts that are marked -- the flashes and the
 * light leaks.
 *
 * Not under every cut: a picture changes every seven seconds, and a whoosh
 * every seven seconds for twenty-five minutes is a metronome. The marked cuts
 * are about two in five, chosen by the same function the renderer uses to
 * draw them, so the sound and the flash can never disagree about which cut is
 * which. Quieter than a punch's whoosh, because a cut is a cut and the punch
 * is the event; and never within half a second of a punch's own hit, where
 * two sounds would land as one smear.
 */
export function planCutSound(options: {
  cuts: readonly { atMs: number; file: string; heldMs: number }[];
  seed: number;
  level: SoundLevel;
  /** Moments already carrying a sound. */
  avoid: readonly number[];
  dir?: string;
}): Cue[] {
  if (options.level === 'none') return [];
  const library = loadSfxLibrary(options.dir ?? assetDirs.sfx);
  const cues: Cue[] = [];
  let n = 1000;
  for (const cut of options.cuts) {
    const accents = cutAccents(cut.file, cut.heldMs);
    if (!accents.flashes && !accents.leaks) continue;
    if (options.avoid.some((at) => Math.abs(at - cut.atMs) < 500)) continue;
    const file = pick(library.samples.whoosh, options.seed, n++);
    if (file === null) continue;
    cues.push({ kind: 'whoosh', atMs: cut.atMs, file, gainDb: SFX_GAIN_DB.whoosh - 5 });
  }
  log.info(`sound: ${cues.length} whoosh(es) under the cinematic cuts`);
  return cues;
}

/**
 * One key strike, synthesised rather than sampled.
 *
 *   a sharp noise click     the key going down
 *   a second, later click   the type bar hitting the platen, 11 ms on
 *   a low body              the thunk of the carriage, 120-215 Hz
 *   a faint ping            the metal, 2.4-3.6 kHz
 *
 * Made with ffmpeg because the library has no single key strikes (only a
 * teletype loop, which cannot be put under individual letters), and
 * synthesised keys cost nothing, carry no licence, and sound the same on
 * every machine.
 */
const KEYS = [
  { body: 190, ping: 3300, snap: 700 },
  { body: 215, ping: 2900, snap: 760 },
  { body: 170, ping: 3600, snap: 650 },
] as const;
const SPACE_KEY = { body: 120, ping: 2400, snap: 420 } as const;

async function drawKey(file: string, key: { body: number; ping: number; snap: number }): Promise<void> {
  const expr =
    `0.9*(random(0)*2-1)*exp(-t*${key.snap})` +
    '+0.55*gte(t,0.011)*(random(1)*2-1)*exp(-(t-0.011)*900)' +
    `+0.45*sin(2*PI*${key.body}*t)*exp(-t*55)` +
    `+0.12*sin(2*PI*${key.ping}*t)*exp(-t*160)`;
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=0.14`,
    '-af', 'highpass=f=90,lowpass=f=8500', '-c:a', 'pcm_s16le', file,
  ]);
}

/**
 * The typewriter under the cinematic title: one strike per character, on the
 * same clock the title is typed on.
 *
 * Laid down as a single track and returned as one cue, rather than forty cues,
 * so the mix graph stays the size it was. Each strike picks a key by position
 * and wanders a decibel or two, because forty identical clicks are a machine
 * gun, not a typist.
 */
export async function planTitleTyping(options: {
  title: string;
  dir: string;
  level: SoundLevel;
  /** When the typing starts. The title's is the start of the video. */
  atMs?: number;
  /** Where the keys are written, so two cards do not overwrite each other. */
  name?: string;
}): Promise<Cue | null> {
  if (options.level === 'none') return null;
  const strokes = titleKeystrokes(options.title);
  if (strokes.length === 0) return null;

  const folder = path.join(options.dir, options.name ?? 'typing');
  fs.mkdirSync(folder, { recursive: true });
  const keyFiles = KEYS.map((_, i) => path.join(folder, `key-${i}.wav`));
  const spaceFile = path.join(folder, 'space.wav');
  for (const [i, key] of KEYS.entries()) await drawKey(keyFiles[i]!, key);
  await drawKey(spaceFile, SPACE_KEY);

  const inputs = [...keyFiles, spaceFile].flatMap((file) => ['-i', file]);
  const uses: number[][] = [[], [], [], []];
  strokes.forEach((stroke, i) => {
    (uses[stroke.space ? 3 : (i * 7 + 3) % 3] ?? []).push(i);
  });

  const parts: string[] = [];
  const labels: string[] = [];
  uses.forEach((strokeIndexes, input) => {
    if (strokeIndexes.length === 0) return;
    const splits = strokeIndexes.map((i) => `[s${i}]`).join('');
    parts.push(`[${input}:a]asplit=${strokeIndexes.length}${splits}`);
    for (const i of strokeIndexes) {
      const stroke = strokes[i]!;
      const wander = ((i * 37) % 5) - 2;
      parts.push(`[s${i}]adelay=${stroke.atMs}|${stroke.atMs},volume=${wander}dB[k${i}]`);
      labels.push(`[k${i}]`);
    }
  });
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[out]`);

  const file = path.join(folder, 'typing.wav');
  const atMs = options.atMs ?? 0;
  await ffmpeg([
    '-y', ...inputs, '-filter_complex', parts.join(';'), '-map', '[out]',
    '-ac', '2', '-c:a', 'pcm_s16le', file,
  ]);
  log.debug(`sound: ${strokes.length} typewriter key(s) typed at ${atMs}ms`);
  return { kind: 'click', atMs, file, gainDb: TYPING_GAIN_DB };
}

/**
 * The title is typed before the first word, over nothing but the bed, so the
 * keys sit well above the other effects: a strike peaks near -15 dBFS after
 * the duck, crisp without being a jump scare.
 */
const TYPING_GAIN_DB = 2;

/**
 * The ffmpeg filter chain that lays the cues under the narration.
 *
 * Each cue is delayed to its own moment, minus its lead. A swell peaks at its
 * end rather than its start, so a file that begins on the frame it marks
 * arrives late and reads as a reaction to the cut instead of part of it --
 * which is exactly what the lead table is for.
 */
export function soundFilter(options: {
  cues: readonly Cue[];
  /** Input index of the narration in the ffmpeg command. */
  voiceInput: number;
  /** Input index of the first cue; they follow in order. */
  firstCueInput: number;
  loudnorm: string;
}): { inputs: string[]; filter: string; label: string } {
  const { cues, voiceInput, firstCueInput, loudnorm } = options;
  if (cues.length === 0) {
    return { inputs: [], filter: `[${voiceInput}:a]${loudnorm}[a]`, label: '[a]' };
  }

  const inputs: string[] = [];
  const parts: string[] = [];
  const labels: string[] = [];

  for (const [i, cue] of cues.entries()) {
    inputs.push('-i', cue.file);
    const at = Math.max(0, cue.atMs - ((SFX_LEAD_MS as Record<string, number>)[cue.kind] ?? 0));
    const label = `c${i}`;
    parts.push(
      `[${firstCueInput + i}:a]adelay=${at}|${at},volume=${cue.gainDb + DUCK_DB}dB[${label}]`,
    );
    labels.push(`[${label}]`);
  }

  parts.push(
    `[${voiceInput}:a]${loudnorm}[voice]`,
    `[voice]${labels.join('')}amix=inputs=${cues.length + 1}:duration=first:normalize=0[a]`,
  );

  return { inputs, filter: parts.join(';'), label: '[a]' };
}

/** What is actually available, for the screen to report honestly. */
export function soundAvailable(dir: string = assetDirs.sfx): {
  dir: string;
  counts: Record<string, number>;
  total: number;
} {
  if (!fs.existsSync(dir)) return { dir, counts: {}, total: 0 };
  const library = loadSfxLibrary(dir);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const [kind, files] of Object.entries(library.samples)) {
    counts[kind] = files.length;
    total += files.length;
  }
  return { dir, counts, total };
}
