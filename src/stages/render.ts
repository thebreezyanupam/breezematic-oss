import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { ROOT, dirs, workDir } from '../config.js';
import { COMPOSITION_ID, RENDER } from '../design.js';
import { log } from '../log.js';
import { webpackOverride } from '../remotion/webpack.js';
import { IMAGE_DIR } from './images.js';
import { VIDEO_DIR } from './footage.js';
import type { BeatSheet } from '../schema.js';

const ENTRY = path.join(ROOT, 'src', 'remotion', 'index.ts');

// The shader backgrounds need a real WebGL context. Chrome now refuses its
// software fallback unless launched with --enable-unsafe-swiftshader, which
// Remotion 4 only passes under a v5 flag, so headless-shell renders every
// field black. Chrome for Testing can reach the GPU and does not need it.
/**
 * Which graphics backend the render runs on.
 *
 * Measured on this project's machine, 200 frames at 720p, eight tabs:
 *
 *   vulkan      17.4 frames a second
 *   angle       15.8
 *   angle-egl   11.7
 *   swangle      2.3   (software: the depth shader has no GPU to run on)
 *
 * Vulkan wins and draws every frame correctly, so it is the default. It is
 * still a driver, and a driver can be missing -- BREEZEMATIC_GL=angle puts
 * the previous one back without a rebuild.
 */
export const CHROMIUM = {
  gl: (process.env['BREEZEMATIC_GL'] ?? 'vulkan') as 'vulkan' | 'angle' | 'angle-egl' | 'swangle',
} as const;

/**
 * The backend for one sheet. The explainer draws its pictures through
 * Remotion's canvas effects (zoom blur, channel split, light leaks), which
 * need a WebGL2 context in every tab; under vulkan eight tabs could not all
 * get one and the render died on its first frames. ANGLE is what Remotion
 * documents for those effects, and measured above at ten per cent slower.
 */
export function chromiumFor(sheet: BeatSheet): { gl: (typeof CHROMIUM)['gl'] } {
  if (process.env['BREEZEMATIC_GL'] !== undefined) return CHROMIUM;
  // The painted mode paints through WebGL2 (p5.brush) too.
  return sheet.meta.mode === 'explainer' || sheet.meta.mode === 'painted' ? { gl: 'angle' } : CHROMIUM;
}
/**
 * Which browser draws the frames.
 *
 * Measured on this machine, 300 frames at 720p, eight tabs, same project:
 *
 *   headless-shell       44.3 frames a second
 *   chrome-for-testing   18.2
 *
 * Two and a half times, for a browser built to do exactly this and nothing
 * else -- no window, no profile, no extension machinery. The depth shader
 * still runs: the frames the two produce are identical, SSIM 1.000000, and
 * neither logged a WebGL failure.
 *
 * BREEZEMATIC_CHROME=chrome-for-testing goes back to the full browser, which
 * is worth having when something needs to be watched rather than rendered.
 */
export const CHROME_MODE = (process.env['BREEZEMATIC_CHROME'] ?? 'headless-shell') as
  | 'headless-shell'
  | 'chrome-for-testing';

/**
 * The port Remotion serves the bundle on, pinned rather than left to it.
 *
 * Unset, it starts looking at 3000 -- which is where every Next and Vite dev
 * server in the world also starts. With one of those already up, Remotion
 * pointed Chrome at the *other* project's page, found no
 * `window.getStaticCompositions` on it, and killed the run at
 * `selectComposition` -- after the writing, the reading and the alignment had
 * all been paid for. Its message says the page looks "foreign", which is true
 * and reads like a bug in Remotion rather than a busy port.
 *
 * A port nothing else defaults to costs nothing and removes the whole class.
 */
export const RENDER_PORT = 4757;

export function picturePath(slug: string): string {
  return path.join(workDir(slug), 'picture.mp4');
}

let bundlePromise: Promise<string> | undefined;
let bundledImages = '';

/**
 * Which pictures were on disk when the bundle was made. Names only — the files
 * are content-addressed, so a name that already exists holds the same bytes.
 *
 * Footage counts the same as stills. Watching only public/images would have
 * reproduced this exact bug for every video-backed run: new clips on disk, a
 * stale bundle without them, and a blank frame where staticFile() 404s with
 * nothing in any log to say why.
 */
function imageState(): string {
  const names: string[] = [];
  for (const directory of [IMAGE_DIR, VIDEO_DIR]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      names.push(`${path.basename(directory)}/${name}`);
    }
  }
  return names.sort().join('\n');
}

/**
 * Bundling copies public/ into the output, once. That was fine while every run
 * was its own CLI process, and wrong the moment the app server started holding
 * one process open across runs: the first topic's pictures were copied, every
 * later topic downloaded new ones into public/images, and the bundle still held
 * the old set. staticFile() then pointed at a file the bundle did not have, and
 * a 404 behind an <img> is a blank frame — which is exactly what it looked
 * like, with no error anywhere to say so.
 *
 * So the picture set is part of what identifies the bundle. Same set, same
 * bundle; new pictures, rebuild. Planning downloads them before rendering ever
 * asks for the bundle, so by this point the set is settled.
 */
export async function ensureBundle(): Promise<string> {
  const images = imageState();
  if (bundlePromise === undefined || images !== bundledImages) {
    if (bundlePromise !== undefined) log.debug('images changed since the last bundle; rebuilding');
    bundledImages = images;
    log.info('bundling Remotion composition');
    bundlePromise = bundle({
      entryPoint: ENTRY,
      publicDir: path.join(ROOT, 'public'),
      outDir: path.join(dirs.cache, 'remotion-bundle'),
      webpackOverride,
      onProgress: (percent) => {
        if (percent % 25 === 0) log.debug(`bundle ${percent}%`);
      },
    });
  }
  return bundlePromise;
}

/**
 * Makes sure the bundle really holds the pictures a scene is about to ask for.
 *
 * `ensureBundle` already rebuilds when the picture set changes, and for the run
 * that failed it did rebuild -- the log says so. The render still spent the
 * rest of its life retrying one `ai-*.jpg` that 404ed, stalled at 44%, and
 * died without writing a file. That image is in the bundle now and is
 * byte-identical to the one on disk, which means the copy finished after the
 * render started asking for it: `bundle()` resolved before its public folder
 * was fully written.
 *
 * I could not establish that from Remotion's internals, so this does not try
 * to. It checks the one thing that actually matters -- is the file there, at
 * the size it should be -- and copies it if not. A few stat calls against a
 * ten-minute render, and the failure mode becomes self-healing instead of a
 * silent hang.
 *
 * A 404 behind an `<Img>` is the worst shape of bug this pipeline has: the
 * only symptom is a blank frame or a stall, and nothing in any log names the
 * cause.
 */
export function ensureBundledImages(serveUrl: string, files: readonly string[]): void {
  // A serve URL can be a real URL; only a directory can be patched up.
  if (/^https?:/.test(serveUrl)) return;

  let copied = 0;
  for (const file of new Set(files)) {
    if (file === '') continue;
    for (const directory of [IMAGE_DIR, VIDEO_DIR]) {
      const source = path.join(directory, file);
      if (!fs.existsSync(source)) continue;

      const target = path.join(serveUrl, 'public', path.basename(directory), file);
      const want = fs.statSync(source).size;
      const have = fs.existsSync(target) ? fs.statSync(target).size : -1;
      if (have === want) break;

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied += 1;
      break;
    }
  }

  if (copied > 0) {
    log.info(`render: copied ${copied} picture(s) the bundle was missing`);
  }
}

async function composition(sheet: BeatSheet) {
  const serveUrl = await ensureBundle();
  return {
    serveUrl,
    composition: await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps: { sheet },
      chromiumOptions: chromiumFor(sheet),
      chromeMode: CHROME_MODE,
      port: RENDER_PORT,
      timeoutInMilliseconds: RENDER.frameTimeoutMs,
    }),
  };
}

export async function renderPicture(sheet: BeatSheet): Promise<string> {
  const { serveUrl, composition: comp } = await composition(sheet);
  const output = picturePath(sheet.meta.slug);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  log.info(`rendering ${comp.durationInFrames} frames at ${comp.width}x${comp.height}`);

  let lastLogged = -1;
  await renderMedia({
    composition: comp,
    serveUrl,
    codec: 'h264',
    outputLocation: output,
    inputProps: { sheet },
    audioCodec: null,
    // Without this Remotion still muxes a silent AAC track, which makes the
    // container outlast the frames it holds.
    muted: true,
    crf: 18,
    concurrency: Math.min(RENDER.maxConcurrency, os.cpus().length),
    chromiumOptions: chromiumFor(sheet),
    chromeMode: CHROME_MODE,
    port: RENDER_PORT,
    timeoutInMilliseconds: RENDER.frameTimeoutMs,
    onProgress: ({ progress }) => {
      const percent = Math.round(progress * 100);
      if (percent >= lastLogged + 10) {
        lastLogged = percent;
        log.info(`render ${percent}%`);
      }
    },
  });

  return output;
}

export async function renderBeatStills(sheet: BeatSheet, beatIds: readonly string[]): Promise<string[]> {
  const { serveUrl, composition: comp } = await composition(sheet);
  const directory = path.join(workDir(sheet.meta.slug), 'stills');
  fs.mkdirSync(directory, { recursive: true });

  // Cleared first. Still filenames carry the beat id, and beat ids move every
  // time the script is regenerated — so a stale PNG from an earlier plan sits
  // in the directory looking exactly like current output. That is a trap for
  // anyone reviewing a change, and it cost real time before it was noticed.
  for (const stale of fs.readdirSync(directory)) {
    if (stale.endsWith('.png')) fs.rmSync(path.join(directory, stale), { force: true });
  }

  const written: string[] = [];
  for (const id of beatIds) {
    const beat = sheet.beats.find((entry) => entry.id === id);
    if (beat === undefined) continue;

    const midMs = beat.startMs + (beat.endMs - beat.startMs) * 0.55;
    const frame = Math.min(
      comp.durationInFrames - 1,
      Math.round((midMs / 1000) * sheet.meta.fps),
    );
    const output = path.join(directory, `${id}-${beat.template}.png`);

    await renderStill({
      composition: comp,
      serveUrl,
      output,
      frame,
      inputProps: { sheet },
      overwrite: true,
      chromiumOptions: chromiumFor(sheet),
      chromeMode: CHROME_MODE,
      port: RENDER_PORT,
      onBrowserLog: ({ type, text }) => log.debug(`page ${type}: ${text}`),
      timeoutInMilliseconds: RENDER.frameTimeoutMs,
    });
    written.push(output);
    log.info(`still ${beat.id} (${beat.template}) at frame ${frame}`);
  }
  return written;
}
