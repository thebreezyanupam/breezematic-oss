import { spawn } from 'node:child_process';
import { env } from './config.js';
import { log } from './log.js';

export type FfmpegResult = { stdout: string; stderr: string };

function run(bin: string, args: string[]): Promise<FfmpegResult> {
  log.debug(`${bin} ${args.map(quote).join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${bin} exited ${code}\n${stderr.split(/\r?\n/).slice(-15).join('\n')}`));
    });
  });
}

function quote(arg: string): string {
  return /[\s"']/.test(arg) ? `"${arg}"` : arg;
}

export async function ffmpeg(args: string[]): Promise<FfmpegResult> {
  return run(env.FFMPEG_BIN, ['-hide_banner', '-nostdin', '-y', ...args]);
}

export async function ffprobe(args: string[]): Promise<FfmpegResult> {
  return run(env.FFPROBE_BIN, args);
}

export async function probeDurationMs(file: string): Promise<number> {
  const { stdout } = await ffprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`could not read duration of ${file}`);
  return Math.round(seconds * 1000);
}

/**
 * The video stream's own length, in whole frames. The container's duration can
 * run past it — Remotion writes a silent audio track alongside the picture —
 * and the audio has to line up with the frames, not with the longest track.
 */
export async function probeVideoDurationMs(file: string): Promise<number> {
  // ffprobe prints these in its own order, not the order they were asked for.
  const { stdout } = await ffprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_frames,r_frame_rate',
    '-of', 'default=noprint_wrappers=1',
    file,
  ]);

  const fields = new Map(
    stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)] as const;
      }),
  );

  const [numerator, denominator = '1'] = (fields.get('r_frame_rate') ?? '').split('/');
  const fps = Number(numerator) / Number(denominator);
  const count = Number(fields.get('nb_frames'));

  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(count) || count <= 0) {
    return probeDurationMs(file);
  }
  return Math.round((count / fps) * 1000);
}

export const BITEXACT = ['-map_metadata', '-1', '-fflags', '+bitexact'] as const;
