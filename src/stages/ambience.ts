import { cache } from '../cache.js';
import { log } from '../log.js';
import { rngFor } from '../rng.js';
import { writeWavPcm16 } from '../wav.js';

/**
 * Beds for long-form listening: rain, wind, surf, and a low drone.
 *
 * Synthesised rather than sourced, for the same reason the pen was drawn
 * rather than photographed — a recording someone else made carries a licence
 * into a video being sold, and the good free ones are mostly share-alike,
 * which would make the finished video share-alike too.
 *
 * All four are the same trick: shaped noise. Rain is broadband noise with the
 * bottom taken out and grit sprinkled over it; wind is the same noise with
 * everything except the bottom taken out, and a slow swell; surf is wind with
 * a much longer swell and a hiss that rises with it. That they share a
 * skeleton is the point — it is one filter and one envelope, and the character
 * comes from where the corner sits and how slowly the envelope breathes.
 *
 * Nothing here uses Math.random. A bed has to be the same bed on a re-run or
 * the cache is lying, so every noise sample comes off a seeded stream.
 */

const SAMPLE_RATE = 44_100;

export const AMBIENCE_NAMES = ['rain', 'wind', 'surf', 'drone'] as const;
export type AmbienceName = (typeof AMBIENCE_NAMES)[number];

export const AMBIENCE_LABELS: Record<AmbienceName, string> = {
  rain: 'Rain',
  wind: 'Wind',
  surf: 'Surf',
  drone: 'Low drone',
};

/**
 * A one-pole filter, run repeatedly. Two passes of a gentle slope sound far
 * more like weather than one pass of a steep one, which whistles.
 */
function onePole(cut: number): { low: (x: number) => number; high: (x: number) => number } {
  const a = Math.exp((-2 * Math.PI * cut) / SAMPLE_RATE);
  let z = 0;
  return {
    low: (x) => {
      z = x * (1 - a) + z * a;
      return z;
    },
    high: (x) => {
      z = x * (1 - a) + z * a;
      return x - z;
    },
  };
}

function renderBed(kind: AmbienceName, durationMs: number, seed: number): Float32Array {
  const total = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const out = new Float32Array(total);
  const rng = rngFor(seed, `ambience-${kind}`);

  // Two stages each way, so the slope is gentle and nothing resonates.
  const hp1 = onePole(kind === 'rain' ? 420 : 30);
  const hp2 = onePole(kind === 'rain' ? 700 : 40);
  const lp1 = onePole(kind === 'rain' ? 9_000 : kind === 'wind' ? 520 : 800);
  const lp2 = onePole(kind === 'rain' ? 12_000 : kind === 'wind' ? 700 : 1_100);

  // How slowly the bed breathes, in cycles per second.
  const swell = kind === 'surf' ? 0.055 : kind === 'wind' ? 0.09 : 0.03;
  const swellDepth = kind === 'surf' ? 0.62 : kind === 'wind' ? 0.42 : 0.12;
  const drift = rng() * Math.PI * 2;

  // Drone runs two detuned partials under the noise rather than over it.
  const root = 55 + Math.floor(rng() * 6);

  let droplet = 0;
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    let sample = rng() * 2 - 1;

    sample = hp2.high(hp1.high(sample));
    sample = lp2.low(lp1.low(sample));

    if (kind === 'rain') {
      // Individual drops, sparse and short. Without them filtered noise is a
      // hiss; with them it is rain.
      if (rng() < 0.0016) droplet = (rng() * 2 - 1) * 0.5;
      droplet *= 0.9993;
      sample = sample * 0.55 + droplet;
    }

    if (kind === 'drone') {
      const a = Math.sin(2 * Math.PI * root * t);
      const b = Math.sin(2 * Math.PI * (root * 1.5 + 0.13) * t);
      sample = sample * 0.16 + (a + b * 0.6) * 0.22;
    }

    const breathe = 1 - swellDepth + swellDepth * (0.5 + 0.5 * Math.sin(2 * Math.PI * swell * t + drift));
    out[i] = sample * breathe;
  }

  // Peak normalise, then hold well down: this sits under a voice for hours and
  // has to be something you stop hearing.
  let peak = 0;
  for (const value of out) peak = Math.max(peak, Math.abs(value));
  const gain = peak > 0 ? 0.5 / peak : 1;

  // A long fade at each end so a loop join never clicks.
  const edge = Math.min(Math.floor(SAMPLE_RATE * 2.5), Math.floor(total / 2));
  for (let i = 0; i < total; i++) {
    let shape = 1;
    if (i < edge) shape = 0.5 - 0.5 * Math.cos((i / edge) * Math.PI);
    else if (i > total - edge) shape = 0.5 - 0.5 * Math.cos(((total - i) / edge) * Math.PI);
    out[i] = (out[i] ?? 0) * gain * shape;
  }
  return out;
}

/** A bed of the given kind, written once and cached by what defines it. */
export async function generateAmbience(options: {
  kind: AmbienceName;
  seed: number;
  durationMs: number;
  force?: boolean;
}): Promise<string> {
  if (options.force === true) cache.setForce(true);
  log.info(`ambience: ${AMBIENCE_LABELS[options.kind].toLowerCase()} bed, ${Math.round(options.durationMs / 1000)}s`);

  const { path } = await cache.file(
    'ambience',
    { kind: options.kind, seed: options.seed, durationMs: options.durationMs, rate: SAMPLE_RATE, v: 1 },
    '.wav',
    async (destination) => {
      writeWavPcm16(destination, renderBed(options.kind, options.durationMs, options.seed), SAMPLE_RATE);
    },
  );
  return path;
}
