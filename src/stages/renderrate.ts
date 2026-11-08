import fs from 'node:fs';
import path from 'node:path';
import { dirs } from '../config.js';
import { log } from '../log.js';

/**
 * How fast this machine draws frames, measured rather than guessed.
 *
 * "About twenty minutes" is only useful if it is true on the computer it is
 * said on, and frame rate varies by a factor of four between a 720p essay
 * with flat pictures and a 1080p one with a depth shader on every plate. So
 * every render records what it actually managed, and the estimate is the
 * median of what this machine has done at that size.
 *
 * The seeded defaults are what this project measured before any run had been
 * recorded: 16,853 frames at 1920x1080 in 21 minutes is 13 frames a second.
 */

const FILE = (): string => path.join(dirs.work, 'render-rate.json');
/** Enough to have a median that is not one bad afternoon. */
const KEEP = 24;

type Sample = { pixels: number; frames: number; ms: number };

/** Frames a second, at a given frame size, before anything has been measured. */
const SEEDED: { pixels: number; fps: number }[] = [
  { pixels: 1280 * 720, fps: 26 },
  { pixels: 1920 * 1080, fps: 13 },
];

function read(): Sample[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as { samples?: Sample[] };
    return Array.isArray(raw.samples) ? raw.samples : [];
  } catch {
    return [];
  }
}

/** One finished render, remembered. Never throws: this is a nicety. */
export function recordRender(sample: Sample): void {
  if (sample.frames <= 0 || sample.ms <= 0) return;
  try {
    fs.mkdirSync(dirs.work, { recursive: true });
    const samples = [...read(), sample].slice(-KEEP);
    fs.writeFileSync(FILE(), `${JSON.stringify({ samples }, null, 2)}\n`, 'utf8');
    log.debug(`render: ${(sample.frames / (sample.ms / 1000)).toFixed(1)} frames a second`);
  } catch {
    // A missing rate file costs an estimate, not a video.
  }
}

const median = (values: number[]): number =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/**
 * Frames a second at this frame size: from what this machine has done at the
 * same size, then from what it has done at any size scaled by area, then from
 * the seeded numbers.
 */
export function framesPerSecond(pixels: number): number {
  const samples = read();
  const here = samples.filter((sample) => Math.abs(sample.pixels - pixels) / pixels < 0.1);
  if (here.length > 0) return median(here.map((s) => s.frames / (s.ms / 1000)));
  if (samples.length > 0) {
    // Frame rate falls roughly with area, which is the only part of the cost
    // that is not the same work per frame.
    const scaled = samples.map((s) => (s.frames / (s.ms / 1000)) * (s.pixels / pixels));
    return median(scaled);
  }
  const seeded = SEEDED.reduce((best, entry) =>
    Math.abs(entry.pixels - pixels) < Math.abs(best.pixels - pixels) ? entry : best,
  );
  return seeded.fps * (seeded.pixels / pixels);
}

/** Roughly how long a render of this shape will take, in milliseconds. */
export function estimateRenderMs(options: {
  durationMs: number;
  fps: number;
  width: number;
  height: number;
}): number {
  const frames = Math.max(1, (options.durationMs / 1000) * options.fps);
  const rate = Math.max(1, framesPerSecond(options.width * options.height));
  return Math.round((frames / rate) * 1000);
}

/** What the screens show: the measured rate per frame size, if any. */
export function measuredRates(): { pixels: number; fps: number }[] {
  const samples = read();
  const sizes = [...new Set(samples.map((sample) => sample.pixels))];
  return sizes.map((pixels) => ({ pixels, fps: Number(framesPerSecond(pixels).toFixed(1)) }));
}
