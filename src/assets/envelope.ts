import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { env } from '../config.js';
import { LIBRARY_DIR, soundPath, type SoundEntry } from './library.js';

/**
 * Where the sound is inside a file, and how loud it is while it is sounding.
 *
 * The war sounds were placed by the start of the file and levelled by its
 * peak, and both are the wrong number. A file starts before its sound does --
 * a few milliseconds of air, or a whole whistle before the blast -- so a
 * gunshot put "on" a word landed after it. And every file is normalised to
 * the same peak, so a two-second explosion and a twenty-millisecond click
 * went in at the same level and the explosion sounded several times louder,
 * roughly as loud as the voice it was meant to sit under.
 *
 * So both are measured. One meter for everything -- mean power over the
 * frames that are actually sounding -- applied to the sound files and to the
 * narration alike, so "six decibels under the voice" means what it says.
 */

const RATE = 16_000;
export const FRAME_MS = 10;
const FRAME = (RATE * FRAME_MS) / 1000;

/** A file as mono floats at 16 kHz. */
function decode(file: string): Float32Array {
  const raw = execFileSync(
    env.FFMPEG_BIN,
    ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
    { maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
}

/** Level per 10 ms frame, in dBFS. */
export function framesOf(samples: Float32Array): Float32Array {
  const count = Math.floor(samples.length / FRAME);
  const out = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += samples[i]! * samples[i]!;
    out[f] = 10 * Math.log10(sum / FRAME + 1e-12);
  }
  return out;
}

/** Mean power of the frames within `window` dB of the loudest, in dB. */
function activeLevel(frames: Float32Array, window: number): number {
  let peak = -Infinity;
  for (const db of frames) peak = Math.max(peak, db);
  let sum = 0;
  let n = 0;
  for (const db of frames) {
    if (db < peak - window) continue;
    sum += 10 ** (db / 10);
    n++;
  }
  return n === 0 ? -120 : 10 * Math.log10(sum / n);
}

export type SoundShape = {
  /** Where the sound starts: the first frame within 20 dB of its peak. */
  onsetMs: number;
  /** Its loudest moment -- the blast at the end of a whistle, the crash at the end of a roll. */
  peakMs: number;
  /** The middle of its energy, for a sound that passes by. */
  centreMs: number;
  /** How loud it is while it sounds. */
  activeDb: number;
};

const SHAPES = path.join(LIBRARY_DIR, 'shapes.json');
let shapes: Record<string, SoundShape & { size: number }> | null = null;

/** A sound file's shape, measured once and kept next to the library. */
export function shapeOf(entry: SoundEntry): SoundShape {
  if (shapes === null) {
    try {
      shapes = JSON.parse(fs.readFileSync(SHAPES, 'utf8')) as Record<string, SoundShape & { size: number }>;
    } catch {
      shapes = {};
    }
  }
  const file = soundPath(entry);
  const size = fs.statSync(file).size;
  const known = shapes[entry.file];
  if (known !== undefined && known.size === size) return known;

  const frames = framesOf(decode(file));
  let peak = -Infinity;
  let peakAt = 0;
  frames.forEach((db, i) => {
    if (db > peak) {
      peak = db;
      peakAt = i;
    }
  });
  const onset = frames.findIndex((db) => db >= peak - 20);
  let weight = 0;
  let moment = 0;
  frames.forEach((db, i) => {
    if (db < peak - 30) return;
    const power = 10 ** (db / 10);
    weight += power;
    moment += power * i;
  });
  const shape: SoundShape = {
    onsetMs: Math.max(0, onset) * FRAME_MS,
    peakMs: peakAt * FRAME_MS,
    centreMs: Math.round(weight === 0 ? peakAt : moment / weight) * FRAME_MS,
    activeDb: activeLevel(frames, 30),
  };
  shapes[entry.file] = { ...shape, size };
  try {
    fs.writeFileSync(SHAPES, JSON.stringify(shapes, null, 1));
  } catch {
    // A read-only library still works; it is only measured again next time.
  }
  return shape;
}

export type Narration = {
  frames: Float32Array;
  /** How loud the voice is while it speaks, on the same meter as the sounds. */
  activeDb: number;
  /** Below this a frame is a pause, not speech. */
  speechDb: number;
  /** Added to the narration's own clock to reach the video's. */
  offsetMs: number;
};

/** The narration, measured: its level, and where it is speaking. */
export function narrationOf(file: string, offsetMs: number): Narration {
  const frames = framesOf(decode(file));
  const sorted = [...frames].sort((a, b) => a - b);
  // The loud end of speech, ignoring the odd plosive spike.
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? -30;
  return { frames, activeDb: activeLevel(frames, 30), speechDb: loud - 28, offsetMs };
}

const frameAt = (narration: Narration, videoMs: number): number =>
  Math.round((videoMs - narration.offsetMs) / FRAME_MS);

/**
 * Where a word actually starts, near where the transcriber said it did.
 *
 * Transcribed word times are an estimate -- measured on this machine's
 * transcriber, often a tenth of a second or more off -- and a gunshot a tenth
 * late reads as a reaction rather than the shot. The start of a word is where
 * the level jumps: the sharpest rise into speech within a short window of the
 * estimate. With nothing convincing there, the estimate stands.
 */
export function wordOnset(narration: Narration, videoMs: number): number {
  const { frames } = narration;
  const centre = frameAt(narration, videoMs);
  let best = -1;
  let bestRise = 6;
  for (let i = Math.max(3, centre - 12); i <= Math.min(frames.length - 1, centre + 15); i++) {
    if (frames[i]! < narration.speechDb) continue;
    const before = Math.min(frames[i - 1]!, frames[i - 2]!, frames[i - 3]!);
    // Nearer the estimate wins a tie: the transcriber is roughly right.
    const rise = frames[i]! - before - Math.abs(i - centre) * 0.05;
    if (rise > bestRise) {
      bestRise = rise;
      best = i;
    }
  }
  return best < 0 ? videoMs : best * FRAME_MS + narration.offsetMs;
}

/**
 * Where the voice actually stops after a phrase: the first stretch of at
 * least 120 ms below speech, starting near where the transcriber put the end.
 * A reaction sting belongs in that gap, not over the last syllable.
 */
export function phraseEnd(narration: Narration, videoMs: number): number {
  const { frames } = narration;
  const from = Math.max(0, frameAt(narration, videoMs) - 20);
  const to = Math.min(frames.length, frameAt(narration, videoMs) + 60);
  let run = 0;
  for (let i = from; i < to; i++) {
    run = frames[i]! < narration.speechDb ? run + 1 : 0;
    if (run >= 12) return (i - run + 1) * FRAME_MS + narration.offsetMs;
  }
  return videoMs;
}

/** The share of a span, in video time, the narration spends speaking. */
export function speechIn(narration: Narration, fromMs: number, toMs: number): number {
  const a = Math.max(0, frameAt(narration, fromMs));
  const b = Math.min(narration.frames.length, frameAt(narration, toMs));
  if (b <= a) return 0;
  let speaking = 0;
  for (let i = a; i < b; i++) if (narration.frames[i]! >= narration.speechDb) speaking++;
  return speaking / (b - a);
}
