import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { dirs, env } from '../config.js';
import { log } from '../log.js';
import { probeDurationMs } from '../ffmpeg.js';

/**
 * A copy of a finished video, a little faster or slower.
 *
 * Done to the finished file, not by rendering again: the picture's timestamps
 * are stretched and the sound is time-stretched with its pitch kept, so a
 * narration at 0.92x sounds like the same person speaking more slowly, not a
 * tape running down. Everything on screen stays in step because it all moves
 * together -- captions, cuts and voice are one file by now. A few minutes of
 * encoding on this machine, and nothing paid for.
 *
 * The original is never touched. The copy sits next to it, and can be made
 * the one that gets uploaded.
 */

export const MIN_SPEED = 0.75;
export const MAX_SPEED = 1.25;

export type SpeedJob = {
  speed: number;
  state: 'running' | 'done' | 'failed';
  percent: number;
  file: string;
  error?: string;
};

const jobs = new Map<string, SpeedJob>();

const label = (speed: number): string => `${speed.toFixed(2)}x`;
export const mainFile = (slug: string): string => path.join(dirs.out, `${slug}-essay.mp4`);
const copyFile = (slug: string, speed: number): string => path.join(dirs.out, `${slug}-essay-${label(speed)}.mp4`);
/** The untouched render, kept aside the first time a copy is made the main file. */
const originalFile = (slug: string): string => path.join(dirs.out, `${slug}-essay-original.mp4`);

export function speedJob(slug: string): SpeedJob | null {
  return jobs.get(slug) ?? null;
}

/** Copies already on disk, slowest first. */
export function listCopies(slug: string): { speed: number; name: string; bytes: number }[] {
  if (!fs.existsSync(dirs.out)) return [];
  const prefix = `${slug}-essay-`;
  return fs
    .readdirSync(dirs.out)
    .filter((name) => name.startsWith(prefix) && /-essay-\d\.\d\dx\.mp4$/.test(name))
    .map((name) => ({
      speed: Number(name.slice(prefix.length, -'x.mp4'.length)),
      name,
      bytes: fs.statSync(path.join(dirs.out, name)).size,
    }))
    .filter((copy) => Number.isFinite(copy.speed))
    .sort((a, b) => a.speed - b.speed);
}

export function copyPath(slug: string, name: string): string | null {
  if (!/^[a-z0-9-]+-essay-\d\.\d\dx\.mp4$/.test(name) || !name.startsWith(`${slug}-essay-`)) return null;
  const file = path.join(dirs.out, name);
  return fs.existsSync(file) ? file : null;
}

/**
 * Starts a copy, or returns the one already running for this video. Never
 * throws for the encode itself -- a failure is reported in the job.
 */
export async function startSpeedCopy(slug: string, requested: number): Promise<SpeedJob> {
  const running = jobs.get(slug);
  if (running?.state === 'running') return running;

  const speed = Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, requested)) * 100) / 100;
  if (Math.abs(speed - 1) < 0.005) throw new Error('that is the speed it already has');
  // From the untouched render when one has been set aside, so a copy of a
  // copy never stacks two speed changes.
  const source = fs.existsSync(originalFile(slug)) ? originalFile(slug) : mainFile(slug);
  if (!fs.existsSync(source)) throw new Error('render the video first; there is no finished file to copy');

  const output = copyFile(slug, speed);
  const temp = `${output}.part.mp4`;
  const job: SpeedJob = { speed, state: 'running', percent: 0, file: path.basename(output) };
  jobs.set(slug, job);

  const totalMs = await probeDurationMs(source).catch(() => 0);
  const outMs = totalMs / speed;

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', source,
    '-filter_complex', `[0:v]setpts=PTS/${speed}[v];[0:a]atempo=${speed}[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    temp,
  ];
  log.info(`speed: making a ${label(speed)} copy of ${path.basename(source)}`);

  const child = spawn(env.FFMPEG_BIN, args, { windowsHide: true });
  let tail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    tail = (tail + text).slice(-2000);
    // ffmpeg reports how far into the output it is as time=HH:MM:SS.xx
    const found = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
    if (found !== undefined && outMs > 0) {
      const at = (Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3])) * 1000;
      job.percent = Math.min(99, Math.round((at / outMs) * 100));
    }
  });
  child.on('close', (code) => {
    if (code === 0 && fs.existsSync(temp)) {
      fs.renameSync(temp, output);
      job.state = 'done';
      job.percent = 100;
      log.info(`speed: ${path.basename(output)} ready`);
    } else {
      fs.rmSync(temp, { force: true });
      job.state = 'failed';
      job.error = tail.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' ').slice(0, 300);
      log.warn(`speed: the ${label(speed)} copy failed (${job.error})`);
    }
  });
  child.on('error', (error) => {
    job.state = 'failed';
    job.error = error.message;
  });
  return job;
}

/**
 * Makes a copy the file that gets uploaded and played as the video.
 *
 * The original render is set aside once, as `-essay-original.mp4`, and every
 * later copy is made from it -- so choosing 0.9x and then 1.1x gives 1.1x of
 * the original, not of the slowed one. Choosing 1.00x puts the original back.
 */
export function useAsMain(slug: string, speed: number): void {
  const main = mainFile(slug);
  const original = originalFile(slug);
  if (!fs.existsSync(original)) {
    if (!fs.existsSync(main)) throw new Error('there is no finished video');
    fs.copyFileSync(main, original);
  }
  if (Math.abs(speed - 1) < 0.005) {
    fs.copyFileSync(original, main);
    return;
  }
  const copy = copyFile(slug, speed);
  if (!fs.existsSync(copy)) throw new Error(`there is no ${label(speed)} copy yet`);
  fs.copyFileSync(copy, main);
}

/** The speed the main file currently plays at, as far as this module knows. */
export function mainSpeed(slug: string): number {
  const main = mainFile(slug);
  const original = originalFile(slug);
  if (!fs.existsSync(main) || !fs.existsSync(original)) return 1;
  const size = fs.statSync(main).size;
  if (size === fs.statSync(original).size) return 1;
  return listCopies(slug).find((copy) => copy.bytes === size)?.speed ?? 1;
}

/**
 * Called when the video is rendered again: the old original and every copy
 * made from it now show a video that no longer exists, so they go.
 */
export function forgetSpeedCopies(slug: string): void {
  if (!fs.existsSync(dirs.out)) return;
  const prefix = `${slug}-essay-`;
  for (const name of fs.readdirSync(dirs.out)) {
    if (name.startsWith(prefix) && (/-essay-\d\.\d\dx\.mp4$/.test(name) || name.endsWith('-essay-original.mp4'))) {
      fs.rmSync(path.join(dirs.out, name), { force: true });
    }
  }
  jobs.delete(slug);
}
