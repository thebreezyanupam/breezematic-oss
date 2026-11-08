import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, env } from '../config.js';
import { cache } from '../cache.js';
import { ffprobe } from '../ffmpeg.js';
import { log } from '../log.js';

/**
 * How a person in a clip moves, and nothing else about them.
 *
 * A reference clip goes in, a skeleton per frame comes out: seventeen points
 * (nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles) with a
 * confidence each. The pixels are read once and thrown away -- what the video
 * borrows from a clip is its choreography and its timing, and the picture is
 * drawn from scratch around them (see retarget.ts and remotion/Mimic.tsx).
 *
 * The model is RTMO-l (OpenMMLab, Apache-2.0): a one-stage pose model, so it
 * finds people and their joints in one pass with no separate detector, and it
 * runs on a laptop CPU through onnxruntime at a few frames a second. It is the
 * ONNX export from the mmpose model zoo, kept in assets/models/rtmo.
 *
 * Several people can be in a frame. The one followed is the most prominent
 * person on the first frame, and from then on whoever is nearest to where
 * that person last was -- a dancer does not teleport, a passer-by is not them.
 */

const MODEL_DIR = path.join(ROOT, 'assets', 'models', 'rtmo');
const MODEL_FILE = path.join(MODEL_DIR, 'end2end.onnx');
const MODEL_URL =
  'https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/rtmo-l_16xb16-600e_body7-640x640-b37118ce_20231211.zip';
const INPUT = 640;
const PAD = 114;
const MOTION_VERSION = 1;

/** COCO order, which is what the model emits. */
export const KEYPOINTS = [
  'nose', 'eyeL', 'eyeR', 'earL', 'earR',
  'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR',
  'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR',
] as const;

/** One frame's skeleton: x, y (0..1 of the frame) and confidence, per keypoint. */
export type Skeleton2D = number[];

export type MotionTrack = {
  source: string;
  width: number;
  height: number;
  fps: number;
  /** null where nobody was found. */
  frames: (Skeleton2D | null)[];
};

async function ensureModel(): Promise<void> {
  if (fs.existsSync(MODEL_FILE)) return;
  log.info('motion: fetching the pose model (RTMO-l, about 165 MB, once)');
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const zip = path.join(MODEL_DIR, 'rtmo-l.zip');
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`could not fetch the pose model: HTTP ${response.status}`);
  fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  // The archive holds end2end.onnx and its pipeline notes; tar reads zips on
  // Windows 10+ and every Linux the Dockerfile builds on.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xf', zip, '-C', MODEL_DIR], { windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
  fs.rmSync(zip, { force: true });
  if (!fs.existsSync(MODEL_FILE)) throw new Error('the pose model archive did not contain end2end.onnx');
}

async function probe(file: string): Promise<{ width: number; height: number; fps: number }> {
  const { stdout } = await ffprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:stream_side_data=rotation',
    '-of', 'json',
    file,
  ]);
  const stream = (JSON.parse(stdout) as { streams: { width: number; height: number; r_frame_rate: string; side_data_list?: { rotation?: number }[] }[] }).streams[0];
  if (stream === undefined) throw new Error(`${file} has no video stream`);
  const [num, den] = stream.r_frame_rate.split('/').map(Number);
  const fps = num !== undefined && den !== undefined && den > 0 ? num / den : 30;
  // A phone clip stored sideways is decoded upright by ffmpeg; the size must be too.
  const rotation = Math.abs(stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0);
  const sideways = rotation === 90 || rotation === 270;
  return { width: sideways ? stream.height : stream.width, height: sideways ? stream.width : stream.height, fps };
}

/** Frames as raw BGR, scaled so the long side is the model's input size. */
async function* decode(file: string, width: number, height: number): AsyncGenerator<Buffer> {
  const child = spawn(
    env.FFMPEG_BIN,
    ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-vf', `scale=${width}:${height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
    { windowsHide: true },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const size = width * height * 3;
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= size) {
      yield pending.subarray(0, size);
      pending = pending.subarray(size);
    }
  }
  const code: number | null = await new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.on('close', resolve)));
  if (code !== 0) throw new Error(`ffmpeg could not decode ${file}: ${stderr.slice(-300)}`);
}

type Person = { box: [number, number, number, number]; score: number; points: number[] };

/** Picks this frame's person: the most prominent at first, then whoever is nearest. */
function follow(people: Person[], previous: Person | null): Person | null {
  const candidates = people.filter((person) => person.score > 0.3);
  if (candidates.length === 0) return null;
  const centre = (p: Person) => [(p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2] as const;
  const area = (p: Person) => (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]);
  if (previous === null) return candidates.reduce((best, p) => (area(p) * p.score > area(best) * best.score ? p : best));
  const [px, py] = centre(previous);
  return candidates.reduce((best, p) => {
    const [bx, by] = centre(best);
    const [cx, cy] = centre(p);
    return Math.hypot(cx - px, cy - py) < Math.hypot(bx - px, by - py) ? p : best;
  });
}

export async function extractMotion(clip: string): Promise<MotionTrack> {
  const absolute = path.resolve(clip);
  const stat = fs.statSync(absolute);
  const { value, hit } = await cache.json<MotionTrack>(
    'motion',
    { v: MOTION_VERSION, model: 'rtmo-l', file: absolute, size: stat.size, mtime: Math.round(stat.mtimeMs) },
    async () => {
      await ensureModel();
      const { width, height, fps } = await probe(absolute);
      const ratio = INPUT / Math.max(width, height);
      // Even sizes: some pixel formats refuse odd ones.
      const w = Math.max(2, Math.round((width * ratio) / 2) * 2);
      const h = Math.max(2, Math.round((height * ratio) / 2) * 2);

      const ort = await import('onnxruntime-node');
      const session = await ort.InferenceSession.create(MODEL_FILE, { graphOptimizationLevel: 'all' });
      const plane = INPUT * INPUT;
      const tensorData = new Float32Array(3 * plane);

      const frames: (Skeleton2D | null)[] = [];
      let previous: Person | null = null;
      const started = Date.now();
      for await (const frame of decode(absolute, w, h)) {
        tensorData.fill(PAD);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const at = (y * w + x) * 3;
            const to = y * INPUT + x;
            tensorData[to] = frame[at]!;
            tensorData[plane + to] = frame[at + 1]!;
            tensorData[2 * plane + to] = frame[at + 2]!;
          }
        }
        const output = await session.run({ input: new ort.Tensor('float32', tensorData, [1, 3, INPUT, INPUT]) });
        const dets = output['dets']!.data as Float32Array;
        const keypoints = output['keypoints']!.data as Float32Array;
        const count = output['dets']!.dims[1] ?? 0;
        const people: Person[] = [];
        for (let i = 0; i < count; i++) {
          const points: number[] = [];
          for (let k = 0; k < KEYPOINTS.length; k++) {
            const at = (i * KEYPOINTS.length + k) * 3;
            points.push(keypoints[at]! / w, keypoints[at + 1]! / h, keypoints[at + 2]!);
          }
          people.push({
            box: [dets[i * 5]! / w, dets[i * 5 + 1]! / h, dets[i * 5 + 2]! / w, dets[i * 5 + 3]! / h],
            score: dets[i * 5 + 4]!,
            points,
          });
        }
        const person = follow(people, previous);
        if (person !== null) previous = person;
        frames.push(person === null ? null : person.points.map((n) => Math.round(n * 10000) / 10000));
        if (frames.length % 100 === 0) log.info(`motion: ${frames.length} frames read`);
      }
      const found = frames.filter((f) => f !== null).length;
      log.info(`motion: ${found}/${frames.length} frames with a person (${((Date.now() - started) / 1000).toFixed(0)}s)`);
      return { source: path.basename(absolute), width, height, fps, frames };
    },
  );
  if (hit) log.info(`motion: ${value.frames.length} frames from the cache`);
  return value;
}
