import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { AUDIO, ROOT, assetDirs, dirs, workDir } from '../config.js';
import { ffmpeg } from '../ffmpeg.js';
import { log } from '../log.js';
import { loudnormFilter, measureLoudness } from '../loudness.js';
import { seamlessLoop } from './loop.js';
import { soundFilter, type Cue } from './essaysound.js';
import { recordRender } from './renderrate.js';
import { forgetSpeedCopies } from './speedcopy.js';
import { LEAD_IN_MS, type EssayScene } from './compose.js';
import {
  ensureBundle,
  ensureBundledImages,
  CHROMIUM,
  CHROME_MODE,
  RENDER_PORT,
} from './render.js';

/**
 * A finished video, in a form it can be rebuilt from.
 *
 * Everything before the render -- writing, reading aloud, aligning, planning
 * the edit, drawing the pictures -- is slow, and most of it costs money. The
 * render and the mix are neither: ten minutes of a laptop's time and nothing
 * else. So a video is saved at exactly the seam between the two, and anything
 * on this side of it can be changed and rebuilt for free.
 *
 * That is what the editor edits. It never re-runs the pipeline; it changes
 * this file and renders it again.
 */

export const PROJECT_VERSION = 1;

export type Project = {
  version: number;
  slug: string;
  /** Everything the renderer draws. The editable heart of the file. */
  scene: EssayScene;
  render: { width: number; height: number; fps: number };
  audio: {
    /** The narration, as read. Never re-read, so this is always on disk. */
    voice: string;
    /** A file in assets/music, or 'none'. */
    music: string;
    /** How loud the bed sits under the narration. */
    musicLufs: number;
    /**
     * The sound cues, already placed. Kept rather than re-planned because
     * their placement depends on the edit plan, which is upstream of here --
     * and because a cue the editor switched off should stay off.
     */
    cues: Cue[];
    /**
     * Kinds of cue switched off in the editor -- 'whoosh', 'impact', 'riser',
     * 'click'. Kept as a list of what is off rather than by deleting the cues,
     * so switching one back on does not mean planning it again.
     */
    cuesOff?: string[];
  };
  /** What the pictures are made of, so a redrawn one matches the rest. */
  pictureStyle: string;
  /**
   * The settings this video was made with.
   *
   * Kept so a change that cannot be made by re-rendering -- a different voice,
   * which re-times every caption, cut and cutting -- can be made by running
   * the same video again with one setting altered. Everything else comes back
   * from the cache, so it costs a render and nothing more.
   */
  options?: Record<string, unknown>;
  /** For the editor's title bar. */
  title: string;
};

export const projectPath = (slug: string): string => path.join(workDir(slug), 'project.json');

/** The editor's preview stems: narration with cues, and the music alone. */
export function stemPaths(slug: string): { voice: string; music: string; info: string } {
  const dir = workDir(slug);
  return {
    voice: path.join(dir, 'stem-voice.m4a'),
    music: path.join(dir, 'stem-music.m4a'),
    info: path.join(dir, 'stems.json'),
  };
}

/** What the stems on disk were mixed with, or null if there are none. */
export function stemInfo(slug: string): { music: string; musicLufs: number; hasMusic: boolean } | null {
  const stems = stemPaths(slug);
  if (!fs.existsSync(stems.voice) || !fs.existsSync(stems.info)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(stems.info, 'utf8')) as { music: string; musicLufs: number };
    return { ...info, hasMusic: fs.existsSync(stems.music) };
  } catch {
    return null;
  }
}

export function hasProject(slug: string): boolean {
  return fs.existsSync(projectPath(slug));
}

export function loadProject(slug: string): Project | null {
  const file = projectPath(slug);
  if (!fs.existsSync(file)) return null;
  try {
    const project = JSON.parse(fs.readFileSync(file, 'utf8')) as Project;
    return project.version === PROJECT_VERSION ? project : null;
  } catch {
    return null;
  }
}

export function saveProject(project: Project): void {
  fs.mkdirSync(workDir(project.slug), { recursive: true });
  fs.writeFileSync(projectPath(project.slug), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

/** Every picture file the renderer will ask the bundle for. */
function assetsOf(scene: EssayScene): string[] {
  return [
    ...scene.plates.map((plate) => plate.file),
    ...scene.plates.flatMap((plate) => (plate.depth === undefined ? [] : [plate.depth])),
    ...scene.cutouts.map((cutout) => cutout.file),
    // The stick figure's painted places, when its world is painted.
    ...(scene.stickman ?? []).flatMap((beat) => [
      ...(beat.stage.background === undefined ? [] : [beat.stage.background]),
      ...(beat.stage.depth === undefined ? [] : [beat.stage.depth]),
    ]),
  ];
}

function framesOf(project: Project): number {
  return Math.max(1, Math.round((project.scene.durationMs / 1000) * project.render.fps));
}

/**
 * One frame, for the editor to look at before committing to a render.
 *
 * Seconds rather than minutes, which is what makes an edit worth trying: a
 * replaced picture can be checked at the moment it appears without rendering
 * the two minutes around it.
 */
export async function renderProjectStill(project: Project, atMs: number): Promise<string> {
  const serveUrl = await ensureBundle();
  ensureBundledImages(serveUrl, assetsOf(project.scene));
  const composition = await selectComposition({
    serveUrl,
    id: 'breezematic-essay',
    inputProps: project.scene,
    chromiumOptions: CHROMIUM,
    chromeMode: CHROME_MODE,
    port: RENDER_PORT,
  });
  const dir = workDir(project.slug);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'preview.png');
  const { width, height, fps } = project.render;
  await renderStill({
    composition: { ...composition, width, height, fps, durationInFrames: framesOf(project) },
    serveUrl,
    output: out,
    frame: Math.max(0, Math.min(framesOf(project) - 1, Math.round((atMs / 1000) * fps))),
    inputProps: project.scene,
    chromiumOptions: CHROMIUM,
    chromeMode: CHROME_MODE,
    port: RENDER_PORT,
    overwrite: true,
  });
  return out;
}

/**
 * The picture, then the sound: the tail of the pipeline, and the whole of
 * what the editor re-runs.
 *
 * The book pipeline calls this too, so there is one implementation of "how a
 * video is put together" rather than a second one that drifts -- an editor
 * that mixes slightly differently from the pipeline is an editor that changes
 * a video the moment it is opened.
 */
export type RenderProgress = {
  percent: number;
  /** Frames finished, and how many there are. The honest units. */
  frames: number;
  total: number;
  /** Milliseconds left at the rate measured so far, or null too early to say. */
  etaMs: number | null;
};

export async function renderProject(options: {
  project: Project;
  onStage?: (stage: 'render' | 'mix') => void;
  onProgress?: (progress: RenderProgress) => void;
}): Promise<{ output: string; sizeBytes: number }> {
  const { project } = options;
  const { scene } = project;
  const dir = workDir(project.slug);
  fs.mkdirSync(dir, { recursive: true });

  options.onStage?.('render');
  const serveUrl = await ensureBundle();
  /**
   * Checked rather than assumed. One run died at 44% retrying a picture that
   * was on disk, in the bundle by the time anyone looked, and 404 at the
   * moment the frame needed it.
   */
  ensureBundledImages(serveUrl, assetsOf(scene));
  const composition = await selectComposition({
    serveUrl,
    id: 'breezematic-essay',
    inputProps: scene,
    chromiumOptions: CHROMIUM,
    chromeMode: CHROME_MODE,
    port: RENDER_PORT,
  });

  const { width, height, fps } = project.render;
  const silent = path.join(dir, 'picture.mp4');
  const frames = framesOf(project);
  log.info(`render: ${frames} frames at ${width}x${height} @${fps}`);

  /**
   * Reported every one per cent, with the frame count and an estimate.
   *
   * It used to report every five, which on a forty-second short is constant
   * and on a nine-minute essay is eight hundred frames -- minutes of a bar
   * that does not move, where a slow render and a dead one look identical.
   * One per cent, and the numbers underneath, so the difference is visible.
   */
  const started = Date.now();
  let logged = -1;
  await renderMedia({
    composition: { ...composition, width, height, fps, durationInFrames: frames },
    serveUrl,
    codec: 'h264',
    outputLocation: silent,
    inputProps: scene,
    audioCodec: null,
    muted: true,
    crf: 20,
    concurrency: Math.min(8, os.cpus().length),
    chromiumOptions: CHROMIUM,
    chromeMode: CHROME_MODE,
    port: RENDER_PORT,
    onProgress: ({ progress, renderedFrames }) => {
      const percent = Math.round(progress * 100);
      if (percent <= logged) return;
      logged = percent;
      const done = renderedFrames ?? Math.round(progress * frames);
      const elapsed = Date.now() - started;
      // Only once there is enough of a rate to be worth quoting.
      const etaMs =
        done > 0 && progress > 0.02 ? Math.round((elapsed / done) * (frames - done)) : null;
      log.info(
        `render ${percent}% — frame ${done} of ${frames}` +
          (etaMs === null ? '' : `, ~${Math.max(1, Math.round(etaMs / 60000))} min left`),
      );
      options.onProgress?.({ percent, frames: done, total: frames, etaMs });
    },
  });

  // What this machine actually managed, so the next estimate is measured.
  recordRender({ pixels: width * height, frames, ms: Date.now() - started });
  // Which scene this picture is of, so a sound-only change can reuse it.
  fs.writeFileSync(pictureStamp(project.slug), JSON.stringify({ scene: sceneHash(scene) }), 'utf8');

  options.onStage?.('mix');
  return mixProject(project);
}

/** Where the record of which scene picture.mp4 shows is kept. */
const pictureStamp = (slug: string): string => path.join(workDir(slug), 'picture.json');

/**
 * The scene, minus anything that is sound: two scenes with the same hash have
 * the same picture, so the picture already rendered can be reused.
 */
function sceneHash(scene: EssayScene): string {
  return crypto.createHash('sha1').update(JSON.stringify(scene)).digest('hex');
}

/**
 * Whether the sound can be changed without rendering the picture again: the
 * picture is on disk, and it is a picture of the scene as it now stands.
 */
export function canRemix(project: Project): { ok: true } | { ok: false; why: string } {
  const picture = path.join(workDir(project.slug), 'picture.mp4');
  if (!fs.existsSync(picture)) {
    return { ok: false, why: 'there is no rendered picture to mix onto yet; render it once first' };
  }
  try {
    const stamp = JSON.parse(fs.readFileSync(pictureStamp(project.slug), 'utf8')) as { scene?: string };
    if (stamp.scene !== sceneHash(project.scene)) {
      return { ok: false, why: 'the pictures, captions or cuts changed since the last render; render it to see them' };
    }
  } catch {
    // Rendered before the stamp existed: trust the picture, which is what
    // every earlier version did.
  }
  return { ok: true };
}

/**
 * The sound, laid onto the rendered picture: narration, cues and music.
 *
 * The whole of a sound change. The picture is copied, not encoded, so this is
 * seconds where a render is minutes -- which is what lets the editor treat
 * the music level like a fader rather than like an export.
 *
 * It also writes two stems next to the video -- the narration with its cues,
 * and the music on its own at the level it was mixed at -- which the editor
 * plays in sync with the picture so a level can be heard while it is dragged.
 */
export async function mixProject(project: Project): Promise<{ output: string; sizeBytes: number }> {
  const { scene } = project;
  const dir = workDir(project.slug);
  const silent = path.join(dir, 'picture.mp4');
  if (!fs.existsSync(silent)) throw new Error('there is no rendered picture to mix onto');
  const output = path.join(dirs.out, `${project.slug}-essay.mp4`);
  // Speed copies of the last mix show a video that is about to be replaced.
  forgetSpeedCopies(project.slug);
  fs.mkdirSync(dirs.out, { recursive: true });

  let bedPath: string | null = null;
  const wanted = project.audio.music;
  if (wanted !== 'none' && wanted !== '' && wanted !== 'auto') {
    const file = path.isAbsolute(wanted) ? wanted : path.join(assetDirs.music, wanted);
    if (fs.existsSync(file)) bedPath = file;
    else log.warn(`music: ${wanted} is not in assets/music; going without`);
  }

  // Folded before it is looped, or every repeat lands a click under the voice.
  if (bedPath !== null) {
    try {
      bedPath = await seamlessLoop(bedPath);
    } catch (error) {
      log.warn(`music: could not fold the loop (${(error as Error).message}); using it as it is`);
    }
  }

  const inputs: string[] = ['-i', silent, '-i', project.audio.voice];
  const voiceInput = 1;
  let nextInput = 2;
  let bedInput = -1;
  if (bedPath !== null) {
    inputs.push('-stream_loop', '-1', '-i', bedPath);
    bedInput = nextInput++;
  }

  /**
   * The narration is delayed by the same lead-in the picture was, from the
   * same constant -- the shape of every lip-sync bug is two offsets that
   * agree today.
   */
  const loudnorm =
    `adelay=${LEAD_IN_MS}|${LEAD_IN_MS},` +
    `loudnorm=I=${AUDIO.masterLufs}:TP=${AUDIO.truePeakDb}:LRA=11`;
  const off = project.audio.cuesOff ?? [];
  const sound = soundFilter({
    cues: project.audio.cues.filter((cue) => !off.includes(cue.kind) && fs.existsSync(cue.file)),
    voiceInput,
    firstCueInput: nextInput,
    loudnorm,
  });
  inputs.push(...sound.inputs);

  let bedFilter = '';
  if (bedPath !== null) {
    const target = { lufs: project.audio.musicLufs, truePeakDb: -3 };
    const measured = await measureLoudness(bedPath, target);
    log.info(`music: ${measured.integratedLufs} -> ${target.lufs} LUFS under the narration`);
    const endsAt = scene.durationMs / 1000;
    bedFilter =
      `[${bedInput}:a]${loudnormFilter(measured, target)},aresample=${AUDIO.sampleRate},` +
      'afade=t=in:st=0:d=2,' +
      `afade=t=out:st=${Math.max(0, endsAt - 8)}:d=8[bed]`;
  }

  /**
   * Held under the ceiling whether or not there is music. A voice mastered to
   * its true-peak limit with a cannon on top of it can only go over -- and
   * without music there was nothing here to stop it.
   */
  const chain =
    bedPath === null
      ? `${sound.filter};[a]asplit=2[a1][stemvoice];[a1]alimiter=limit=0.89:level=false[out]`
      : `${sound.filter};${bedFilter};[a]asplit=2[a1][stemvoice];[bed]asplit=2[bed1][stemmusic];` +
        '[a1][bed1]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.89:level=false[out]';
  const outLabel = '[out]';
  const stems = stemPaths(project.slug);

  await ffmpeg([
    ...inputs,
    '-filter_complex', chain,
    '-map', '0:v', '-map', outLabel,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO.sampleRate),
    '-shortest',
    '-movflags', '+faststart',
    '-y', output,
    // The stems, for the editor's live preview. Same length as the video.
    '-map', '[stemvoice]', '-c:a', 'aac', '-b:a', '128k', '-t', String(scene.durationMs / 1000), '-y', stems.voice,
    ...(bedPath === null
      ? []
      : ['-map', '[stemmusic]', '-c:a', 'aac', '-b:a', '128k', '-t', String(scene.durationMs / 1000), '-y', stems.music]),
  ]);
  if (bedPath === null) fs.rmSync(stems.music, { force: true });
  fs.writeFileSync(
    stems.info,
    JSON.stringify({ music: bedPath === null ? 'none' : project.audio.music, musicLufs: project.audio.musicLufs }),
    'utf8',
  );

  return {
    output: path.relative(ROOT, output).split(path.sep).join('/'),
    sizeBytes: fs.statSync(output).size,
  };
}
