import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { ROOT } from '../config.js';
import { RENDER } from '../design.js';
import { log } from '../log.js';
import { MIMIC_COMPOSITION_ID, type MimicProps } from '../remotion/Mimic.js';
import { isScene, type SceneName } from '../remotion/stickman/scenes.js';
import { extractMotion } from './motion.js';
import { CHROMIUM, CHROME_MODE, RENDER_PORT, ensureBundle } from './render.js';
import { retarget } from './retarget.js';

/**
 * A reference clip in, an animation of its movement out.
 *
 * Clips come from a file or a URL. A URL is downloaded once into
 * work/_ref, named by its hash, so trying a second scene or look on the same
 * clip does not fetch it again (and the motion cache, keyed on the file, hits).
 */

const REF_DIR = path.join(ROOT, 'work', '_ref');

async function localClip(clip: string): Promise<string> {
  if (!/^https?:\/\//i.test(clip)) {
    if (!fs.existsSync(clip)) throw new Error(`no such clip: ${clip}`);
    return path.resolve(clip);
  }
  const name = `${crypto.createHash('sha256').update(clip).digest('hex').slice(0, 16)}.mp4`;
  const file = path.join(REF_DIR, name);
  if (fs.existsSync(file)) return file;
  log.info(`mimic: downloading ${clip}`);
  const response = await fetch(clip, { headers: { 'User-Agent': 'Mozilla/5.0 (breezematic)' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`could not download the clip: HTTP ${response.status}`);
  fs.mkdirSync(REF_DIR, { recursive: true });
  const partial = `${file}.part`;
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(partial, file);
  return file;
}

export async function mimic(options: { clip: string; scene?: string; seed?: number; out?: string }): Promise<string> {
  const clip = await localClip(options.clip);
  const scene: SceneName = isScene(options.scene) ? options.scene : 'stage';
  const track = await extractMotion(clip);
  const frames = retarget(track, RENDER);
  const props: MimicProps = { frames, scene, seed: options.seed ?? 7 };

  const serveUrl = await ensureBundle();
  const composition = await selectComposition({
    serveUrl,
    id: MIMIC_COMPOSITION_ID,
    inputProps: props,
    chromiumOptions: CHROMIUM,
    chromeMode: CHROME_MODE,
    port: RENDER_PORT,
    timeoutInMilliseconds: RENDER.frameTimeoutMs,
  });

  const output = path.resolve(options.out ?? path.join(ROOT, 'out', `mimic-${path.basename(clip, path.extname(clip))}-${scene}.mp4`));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  log.info(`mimic: rendering ${composition.durationInFrames} frames in the ${scene} scene`);
  let lastLogged = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: output,
    inputProps: props,
    muted: true,
    crf: 18,
    concurrency: Math.min(RENDER.maxConcurrency, os.cpus().length),
    chromiumOptions: CHROMIUM,
    chromeMode: CHROME_MODE,
    port: RENDER_PORT,
    timeoutInMilliseconds: RENDER.frameTimeoutMs,
    onProgress: ({ progress }) => {
      const percent = Math.round(progress * 100);
      if (percent >= lastLogged + 20) {
        lastLogged = percent;
        log.info(`render ${percent}%`);
      }
    },
  });
  log.info(`mimic: wrote ${output}`);
  return output;
}
