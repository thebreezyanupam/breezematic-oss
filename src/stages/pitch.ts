import { readWavPcm16 } from '../wav.js';

/**
 * Whose voice is this, in the one number that tells two speakers apart.
 *
 * The hosted reader occasionally hands back a passage in somebody else's
 * voice -- a different man for a stretch, or a woman for a few seconds in the
 * middle of a read asked for in Fenrir. Loudness and brightness do not see
 * that; the speaking pitch does. A male narrator sits around 90-140 Hz and a
 * female one around 170-240, which is ten semitones apart, while one person
 * reading expressively moves their stretch-by-stretch average by two or three.
 *
 * Plain autocorrelation on the samples: no model, no dependency, a few hundred
 * milliseconds for a minute of speech.
 */

/** Analysed at half the source rate: pitch lives far below 6 kHz. */
const HOP_MS = 30;
const FRAME_MS = 40;
const MIN_HZ = 65;
const MAX_HZ = 400;
/** How sure the autocorrelation has to be before a frame counts as voiced. */
const VOICED = 0.55;
/** The stretch a switch of speaker is judged over. */
export const WINDOW_MS = 2500;
/** Fewer voiced frames than this in a window and its pitch means little. */
const MIN_FRAMES = 20;

export type PitchProfile = {
  /** Median speaking pitch over the whole file, in Hz; NaN if nothing voiced. */
  medianHz: number;
  /** Median pitch of each stretch of WINDOW_MS, NaN where too little was voiced. */
  windowsHz: number[];
};

const median = (values: number[]): number => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : sorted[Math.floor(sorted.length / 2)]!;
};

export function pitchProfile(file: string): PitchProfile {
  const { samples: source, rate: sourceRate } = readWavPcm16(file);
  // Halve the rate by averaging pairs: cheap, and enough of a low-pass here.
  const rate = sourceRate / 2;
  const samples = new Float32Array(Math.floor(source.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = (source[2 * i]! + source[2 * i + 1]!) / 2;

  const frame = Math.round((rate * FRAME_MS) / 1000);
  const hop = Math.round((rate * HOP_MS) / 1000);
  const minLag = Math.floor(rate / MAX_HZ);
  const maxLag = Math.ceil(rate / MIN_HZ);

  // Only the loud frames are speech worth measuring; the quiet ones are
  // breaths, consonants and room.
  const energies: number[] = [];
  for (let at = 0; at + frame + maxLag < samples.length; at += hop) {
    let sum = 0;
    for (let i = at; i < at + frame; i++) sum += samples[i]! * samples[i]!;
    energies.push(Math.sqrt(sum / frame));
  }
  const loud = [...energies].sort((a, b) => a - b)[Math.floor(energies.length * 0.9)] ?? 0;
  const floor = loud * 0.25;

  const frames: { ms: number; hz: number }[] = [];
  const scores = new Float32Array(maxLag + 1);
  energies.forEach((energy, index) => {
    if (energy < floor || energy === 0) return;
    const at = index * hop;
    let energyA = 0;
    for (let i = at; i < at + frame; i++) energyA += samples[i]! * samples[i]!;
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0;
      let energyB = 0;
      for (let i = at; i < at + frame; i++) {
        const b = samples[i + lag]!;
        cross += samples[i]! * b;
        energyB += b * b;
      }
      const score = cross / Math.sqrt(energyA * energyB + 1e-12);
      scores[lag] = score;
      if (score > best) best = score;
    }
    if (best < VOICED) return;
    // The shortest period that scores nearly as well as the best: a strong
    // peak at twice the period is the same note an octave down, not a lower voice.
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (scores[lag]! >= best * 0.9) {
        frames.push({ ms: (at / rate) * 1000, hz: rate / lag });
        return;
      }
    }
  });

  const windows: number[][] = [];
  for (const { ms, hz } of frames) (windows[Math.floor(ms / WINDOW_MS)] ??= []).push(hz);
  const windowsHz = Array.from(windows, (hz) =>
    hz !== undefined && hz.length >= MIN_FRAMES ? median(hz) : Number.NaN,
  );
  return { medianHz: median(frames.map((f) => f.hz)), windowsHz };
}

/** Distance between two pitches in semitones, always positive. */
export const semitones = (a: number, b: number): number => Math.abs(12 * Math.log2(a / b));
