import { ffmpeg } from './ffmpeg.js';

export type LoudnessTarget = {
  lufs: number;
  truePeakDb: number;
};

export type Loudness = {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
  thresholdLufs: number;
  targetOffsetDb: number;
};

export const LOUDNORM_LRA = 11;

function loudnormBase(target: LoudnessTarget): string {
  return `I=${target.lufs}:TP=${target.truePeakDb}:LRA=${LOUDNORM_LRA}`;
}

/**
 * Pass one of EBU R128 normalisation: analyse the whole file so pass two can
 * apply a single linear gain instead of riding the level dynamically.
 */
export async function measureLoudness(file: string, target: LoudnessTarget): Promise<Loudness> {
  const { stderr } = await ffmpeg([
    '-i', file,
    '-af', `loudnorm=${loudnormBase(target)}:print_format=json`,
    '-f', 'null', '-',
  ]);
  return parseMeasurement(file, stderr);
}

export function loudnormFilter(measured: Loudness, target: LoudnessTarget): string {
  return [
    `loudnorm=${loudnormBase(target)}`,
    `measured_I=${measured.integratedLufs}`,
    `measured_TP=${measured.truePeakDb}`,
    `measured_LRA=${measured.lra}`,
    `measured_thresh=${measured.thresholdLufs}`,
    `offset=${measured.targetOffsetDb}`,
    'linear=true',
    'print_format=summary',
  ].join(':');
}

function parseMeasurement(file: string, stderr: string): Loudness {
  const open = stderr.lastIndexOf('{');
  const close = stderr.lastIndexOf('}');
  if (open < 0 || close < open) {
    throw new Error(`loudnorm printed no measurement for ${file}`);
  }

  const raw = JSON.parse(stderr.slice(open, close + 1)) as Record<string, string>;
  const read = (key: string): number => {
    const text = raw[key];
    if (text === '-inf' || text === 'inf') {
      throw new Error(`${file} is silent: loudnorm reported ${key}=${text}`);
    }
    const value = Number.parseFloat(text ?? '');
    if (!Number.isFinite(value)) {
      throw new Error(`loudnorm measurement for ${file} is missing "${key}"`);
    }
    return value;
  };

  return {
    integratedLufs: read('input_i'),
    truePeakDb: read('input_tp'),
    lra: read('input_lra'),
    thresholdLufs: read('input_thresh'),
    targetOffsetDb: read('target_offset'),
  };
}

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/**
 * sidechaincompress reduces gain by `over * (1 - 1/ratio)` once the key signal
 * sits `over` dB above the threshold, so the ratio that yields a chosen duck
 * depth falls out of the assumed overshoot.
 */
export function duckRatio(duckDb: number, overshootDb: number): number {
  if (duckDb <= 0) return 1;
  if (duckDb >= overshootDb) {
    throw new Error(`duckDb ${duckDb} must stay under the assumed overshoot ${overshootDb}dB`);
  }
  return 1 / (1 - duckDb / overshootDb);
}
