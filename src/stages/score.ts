import { AUDIO, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { rngFor } from '../rng.js';
import { writeWavPcm16 } from '../wav.js';

/**
 * A generated music bed, so a video has a score without anyone having to go
 * and find one. A real file dropped in assets/music always wins; this is what
 * plays when there is nothing there.
 *
 * It is written sample by sample rather than assembled out of FFmpeg sources
 * because the envelopes are the whole difference between a chord pad and a
 * bank of test tones. Everything is seeded, so a topic always scores the same.
 */

const SAMPLE_RATE = AUDIO.sampleRate;

/** Semitones above the root, and whether the triad is minor. */
type Chord = { offset: number; minor: boolean };

/** Natural-minor progressions that sit under narration without pulling focus. */
const PROGRESSIONS: ReadonlyArray<readonly Chord[]> = [
  // i - VI - III - VII
  [{ offset: 0, minor: true }, { offset: 8, minor: false }, { offset: 3, minor: false }, { offset: 10, minor: false }],
  // i - iv - VI - VII
  [{ offset: 0, minor: true }, { offset: 5, minor: true }, { offset: 8, minor: false }, { offset: 10, minor: false }],
  // i - VII - VI - VII
  [{ offset: 0, minor: true }, { offset: 10, minor: false }, { offset: 8, minor: false }, { offset: 10, minor: false }],
  // i - III - VII - iv
  [{ offset: 0, minor: true }, { offset: 3, minor: false }, { offset: 10, minor: false }, { offset: 5, minor: true }],
];

/** Roots low enough to stay under a voice. A2 through E3. */
const ROOTS = [45, 47, 48, 50, 52];

const MINOR_TRIAD = [0, 3, 7];
const MAJOR_TRIAD = [0, 4, 7];

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * A saw thinned to its first few harmonics — warmer than a sine, far softer
 * than a real saw, and it will not alias at these pitches.
 */
function voice(phase: number): number {
  return (
    Math.sin(phase) +
    Math.sin(phase * 2) * 0.5 +
    Math.sin(phase * 3) * 0.28 +
    Math.sin(phase * 4) * 0.14 +
    Math.sin(phase * 5) * 0.07
  );
}

/** Raised cosine in and out, so no chord change ever clicks. */
function window(position: number, attack: number, release: number): number {
  if (position <= 0 || position >= 1) return 0;
  if (position < attack) return 0.5 - 0.5 * Math.cos((position / attack) * Math.PI);
  if (position > 1 - release) {
    return 0.5 - 0.5 * Math.cos(((1 - position) / release) * Math.PI);
  }
  return 1;
}

export type ScoreOptions = {
  seed: number;
  durationMs: number;
  bpm?: number;
  force?: boolean;
};

export async function generateScore(options: ScoreOptions): Promise<string> {
  const bpm = options.bpm ?? env.MUSIC_BPM;
  const rng = rngFor(options.seed, 'score');

  const progression = PROGRESSIONS[Math.floor(rng() * PROGRESSIONS.length)] ?? PROGRESSIONS[0]!;
  const root = ROOTS[Math.floor(rng() * ROOTS.length)] ?? 45;
  const progressionIndex = PROGRESSIONS.indexOf(progression);

  const key = {
    bpm,
    root,
    progressionIndex,
    durationMs: options.durationMs,
    rate: SAMPLE_RATE,
    version: 1,
  };

  cache.setForce(options.force === true);
  const result = await cache.file('score', key, '.wav', async (destination) => {
    log.info(`score: generating a ${bpm} bpm bed in ${noteName(root)} minor`);
    // A fresh stream off the same seed, so the noise layer is reproducible too.
    const noiseRng = rngFor(options.seed, 'score-air');
    writeWavPcm16(
      destination,
      render(root, progression, bpm, options.durationMs, noiseRng),
      SAMPLE_RATE,
    );
  });

  return result.path;
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(midi: number): string {
  return NOTES[midi % 12] ?? '?';
}

function render(
  root: number,
  progression: readonly Chord[],
  bpm: number,
  durationMs: number,
  noiseRng: () => number,
): Float32Array {
  const secondsPerBeat = 60 / bpm;
  // Two bars a chord: long enough to feel like harmony rather than a riff.
  const chordSeconds = secondsPerBeat * 8;
  // A tail past the end so the mix stage never runs out of bed to duck.
  const totalSeconds = durationMs / 1000 + 2;
  const length = Math.ceil(totalSeconds * SAMPLE_RATE);

  const out = new Float32Array(length);
  const chordCount = Math.ceil(totalSeconds / chordSeconds) + 1;
  const overlap = Math.min(1.2, chordSeconds * 0.35);

  // ---- pad -----------------------------------------------------------------
  for (let index = 0; index < chordCount; index++) {
    const chord = progression[index % progression.length]!;
    const triad = chord.minor ? MINOR_TRIAD : MAJOR_TRIAD;
    const start = index * chordSeconds - overlap;
    const span = chordSeconds + overlap * 2;

    const from = Math.max(0, Math.floor(start * SAMPLE_RATE));
    const to = Math.min(length, Math.ceil((start + span) * SAMPLE_RATE));

    for (const step of triad) {
      const midi = root + chord.offset + step;
      const hz = midiToHz(midi);
      // Two oscillators a few cents apart: the beating between them is what
      // stops a held chord sounding like an organ test tone.
      const a = (2 * Math.PI * hz * 0.997) / SAMPLE_RATE;
      const b = (2 * Math.PI * hz * 1.003) / SAMPLE_RATE;

      for (let i = from; i < to; i++) {
        const position = (i / SAMPLE_RATE - start) / span;
        const envelope = window(position, 0.35, 0.4);
        if (envelope === 0) continue;
        const sample = voice(i * a) + voice(i * b);
        out[i] = (out[i] ?? 0) + sample * envelope * 0.05;
      }
    }
  }

  // ---- sub pulse on the beat ----------------------------------------------
  const beatSamples = Math.round(secondsPerBeat * SAMPLE_RATE);
  const subDecay = 0.32 * SAMPLE_RATE;
  for (let beat = 0; beat * beatSamples < length; beat++) {
    const chord = progression[Math.floor(beat / 8) % progression.length]!;
    const hz = midiToHz(root + chord.offset - 12);
    const step = (2 * Math.PI * hz) / SAMPLE_RATE;
    const at = beat * beatSamples;
    // Downbeats carry; the beats between them only breathe.
    const strength = beat % 4 === 0 ? 0.3 : 0.12;

    for (let i = 0; i < subDecay && at + i < length; i++) {
      const envelope = Math.exp(-i / (subDecay * 0.32)) * strength;
      out[at + i] = (out[at + i] ?? 0) + Math.sin(i * step) * envelope;
    }
  }

  // ---- air ----------------------------------------------------------------
  // Lowpassed noise, barely audible, but it stops the bed sounding synthetic.
  let noise = 0;
  for (let i = 0; i < length; i++) {
    noise += (noiseRng() * 2 - 1 - noise) * 0.02;
    const fade = window(i / length, 0.06, 0.12);
    out[i] = (out[i] ?? 0) + noise * 0.16 * fade;
  }

  // ---- master --------------------------------------------------------------
  let peak = 0;
  for (let i = 0; i < length; i++) {
    // Soft clip before measuring, so the loudest moments round over rather
    // than square off.
    out[i] = Math.tanh((out[i] ?? 0) * 1.2);
    const magnitude = Math.abs(out[i]!);
    if (magnitude > peak) peak = magnitude;
  }
  const gain = peak > 0 ? 0.55 / peak : 1;
  for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) * gain;

  return out;
}
