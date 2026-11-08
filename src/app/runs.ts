import { isPictureStyle } from '../design/signature.js';
import { makeShortThumbnail } from '../stages/shortthumb.js';
import { workSlug } from '../workslug.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beatSheetPath } from '../config.js';
import { readJson, writeJsonAtomic } from '../json.js';
import { lintBeatSheet, type LintFinding } from '../lint.js';
import { log, onLog } from '../log.js';
import {
  beatWords,
  parseBeatSheet,
  type BeatSheet,
  type EffectName,
  type ImageryMode,
  type ImageSource,
  type StyleName,
  type SubtitleMode,
  type SfxCue,
  type ArtStyle,
  type RenderMode,
  type BoardContent,
  type BoardImagery,
  type BoardTheme,
} from '../schema.js';
import { slugify } from '../text.js';
import { firstBeatPerTemplate, produceBeatSheet } from '../stages/pipeline.js';
import { renderBeatStills, renderPicture } from '../stages/render.js';
import { mixVideo } from '../stages/mix.js';
import { produceLore } from '../stages/lore.js';
import { produceBookEssay } from '../stages/book.js';
import type { Vertical } from '../stages/essay.js';
import type { AmbienceName } from '../stages/ambience.js';
import { generateSketches } from '../stages/sketch.js';
import { recordProject, recordRender } from '../supabase/account.js';
import { setSpendContext } from '../spend.js';

export type RunKind = 'plan' | 'produce' | 'stills' | 'lore' | 'book';

export type RunStage =
  | 'script'
  | 'voice'
  | 'align'
  | 'plan'
  | 'render'
  | 'mix'
  | 'stills'
  // Long form shares only the voice; the rest of its work has no counterpart
  // in a short, so it reports its own stages rather than borrowing names.
  | 'saga'
  | 'still'
  | 'bed'
  | 'assemble'
  // A book essay shares voice, align, render and mix, and has three of its
  // own: the writing, planning the edit against the finished read, and cutting
  // out the subjects the read turns out to name.
  | 'essay'
  | 'edit'
  | 'pictures'
  | 'cutouts';

export type RunEvent =
  | { type: 'log'; level: string; line: string }
  | { type: 'stage'; stage: RunStage }
  | { type: 'done'; kind: RunKind; result: unknown }
  | { type: 'error'; message: string };

export type RunSnapshot = {
  id: string;
  kind: RunKind;
  topic: string;
  slug: string;
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';
  /** Set while a stopped run is on its way to being held rather than dropped. */
  requeue?: boolean;
};

export type StartOptions = {
  kind: RunKind;
  topic: string;
  seed?: number;
  variant: number;
  force: boolean;
  /** Hand-written narration for plan runs; produce and stills read from disk. */
  script?: string;
  adapt?: boolean;
  character?: string;
  ttsProvider?: string;
  /** What it is written and read in; 'en' when unsaid. */
  language?: string;
  effect?: EffectName;
  music?: string;
  musicLufs?: number;
  captionScale?: number;
  subtitles?: SubtitleMode;
  sfxCues?: SfxCue[];
  /** The war sounds' level against where they sit under the voice, in dB. */
  warSfxDb?: number;
  /** Whether the war channel's sounds are mixed in at all. */
  warSfx?: boolean;
  cloneVoice?: string;
  /** Which ElevenLabs voice reads it, by id, when the engine is 'elevenlabs'. */
  elevenVoice?: string;
  /** Long form only: how many minutes to write for, and what plays under it. */
  minutes?: number;
  /** Book essays: which of the five verticals, and an optional steer. */
  vertical?: string;
  angle?: string;
  /** Art direction for the whole video, and a title when the script is yours. */
  direction?: string;
  title?: string;
  /** Caption treatments: held, and swapped in on a punch. */
  punchStyle?: string;
  /** Where the pictures under the type come from, and how many. */
  pictures?: string;
  pictureCount?: number;
  /**
   * How many subjects get cut out and pasted over the frame.
   *
   * This type is the whole contract between the route and the pipeline, and
   * nothing checks that the two agree: the route builds its options with
   * spreads, and an excess property in a spread is not a type error. So a
   * setting missing from here is not a compile failure, it is a control that
   * silently does nothing -- which is exactly what happened to this one on its
   * first run.
   */
  cutoutCount?: number;
  /** Which model draws the pictures: flux, gemini or mixed. */
  imageEngine?: string;
  /** The whole look: cinematic, storybook or stickman. */
  look?: string;
  /** The stick figure's world: drawn (free) or painted for the story's places. */
  stickWorld?: string;
  /** Which channel a book run is for: 'books' or 'war'. */
  niche?: string;
  /** Typed titles and chapter names, or faded in. */
  typewriter?: boolean;
  /** Stickman: 'cinematic' (bars, grade, grain) or 'plain'. */
  stickFinish?: string;
  /** What a book essay's pictures are made of; see PICTURE_STYLES. */
  pictureStyle?: string;
  /** Where chapters come from: script, auto or off. */
  chapters?: string;
  /** Depth parallax on the cinematic pictures. On unless false. */
  parallax?: boolean;
  /** Real portraits and the book's own text, where public domain. On unless false. */
  realSources?: boolean;
  /** Sound effects: none, sparse or full. */
  sound?: string;
  /** How strongly the field sits over a picture, and how big essay type is. */
  effectStrength?: number;
  essayCaptionScale?: number;
  /** Render size. The only real lever on how long it takes. */
  width?: number;
  height?: number;
  fps?: number;
  bed?: string;
  generatedStill?: boolean;
  panelTexture?: boolean;
  artStyle?: ArtStyle;
  series?: string | null;
  mode?: RenderMode;
  brief?: string;
  boardTexture?: boolean;
  boardTheme?: BoardTheme;
  boardContent?: BoardContent;
  boardImagery?: BoardImagery;
  musicFadeInMs?: number;
  musicFadeOutMs?: number;
  musicStartMs?: number;
  tone?: string;
  imagery?: ImageryMode;
  imageSource?: ImageSource;
  imageCount?: number;
  style?: StyleName;
};

type RunRecord = RunSnapshot & {
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  options: StartOptions;
  /** Set when somebody asked it to stop; the work notices at its next check. */
  cancelled: boolean;
};

/**
 * Kept for the one caller that still means it -- the CLI, which really can only
 * do one thing at a time. The app queues instead.
 */
export class BusyError extends Error {
  constructor(active: RunSnapshot) {
    super(`a ${active.kind} run for "${active.topic}" is already in progress`);
    this.name = 'BusyError';
  }
}

/**
 * Thrown out of a stage callback when a run has been asked to stop.
 *
 * Cancellation is cooperative and it has to be: a Gemini request is in flight,
 * Remotion is a child process, ffmpeg is a child process, and none of those can
 * be frozen and thawed. What can be done is to stop between units of work --
 * between two stages, or between two sentences of a reading -- and that is
 * enough, because the pipeline is built on a content-addressed cache. Whatever
 * finished is on disk under a key derived from its own inputs, so starting the
 * same run again does not repeat it.
 */
export class CancelledError extends Error {
  constructor() {
    super('stopped');
    this.name = 'CancelledError';
  }
}

const MAX_EVENTS = 2000;

const runs = new Map<string, RunRecord>();
let active: RunRecord | undefined;
/**
 * Waiting their turn, in order.
 *
 * One at a time is still right -- two Remotion renders on one machine are
 * slower than two in sequence, and the spend ledger attributes charges to the
 * run that is current. What was wrong was making that the user's problem:
 * being unable to *ask* for a second video for forty-five minutes is not a
 * resource constraint, it is an interface refusing to take a note.
 */
const queue: RunRecord[] = [];

/** Throws if this run has been stopped. Called wherever it is safe to stop. */
function checkpoint(run: RunRecord): void {
  if (run.cancelled) throw new CancelledError();
}

function emit(run: RunRecord, event: RunEvent): void {
  run.events.push(event);
  if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  for (const listener of run.listeners) listener(event);
}

export function snapshot(run: RunRecord): RunSnapshot {
  return { id: run.id, kind: run.kind, topic: run.topic, slug: run.slug, status: run.status };
}

export function activeRun(): RunSnapshot | undefined {
  return active === undefined ? undefined : snapshot(active);
}

export function queuedRuns(): RunSnapshot[] {
  return queue.map(snapshot);
}

/** Stopped on purpose, waiting to be told to carry on. */
export function pausedRuns(): RunSnapshot[] {
  return [...runs.values()].filter((run) => run.status === 'paused').map(snapshot);
}

/**
 * Puts a paused run back in the queue.
 *
 * Pausing deliberately does not do this for you. The first version requeued at
 * the front and the pump picked it straight back up, so "pause" meant "start
 * again from the cache" -- busy work that looked like a loop and let nothing
 * else through, which is the opposite of what the button is for. A paused run
 * now waits until somebody says so.
 */
export function resumeRun(id: string): RunSnapshot | null {
  const run = runs.get(id);
  if (run === undefined || run.status !== 'paused') return null;
  run.status = 'queued';
  run.cancelled = false;
  queue.push(run);
  emit(run, { type: 'log', level: 'info', line: 'resuming where it stopped' });
  pump();
  return snapshot(run);
}

/**
 * Stops a run, whether it is going or waiting.
 *
 * A queued one simply leaves the queue. A running one is flagged and stops at
 * its next checkpoint -- which on the stage that takes half an hour is between
 * two sentences, and everywhere else is between two stages. Requeueing puts it
 * back at the front, which is what "pause this and do that first" means: the
 * other one goes ahead of it, and this one carries on afterwards from whatever
 * the cache already holds.
 */
export function cancelRun(id: string, requeue = false): RunSnapshot | null {
  const waiting = queue.findIndex((run) => run.id === id);
  if (waiting >= 0) {
    const [run] = queue.splice(waiting, 1);
    if (run === undefined) return null;
    run.status = 'cancelled';
    emit(run, { type: 'error', message: 'stopped before it started' });
    return snapshot(run);
  }

  if (active?.id === id) {
    // Asking twice is not an error and must not be a second stop: the first
    // one is already on its way and re-flagging it after it requeues would
    // stop the resumed run too.
    if (active.cancelled) return snapshot(active);
    active.cancelled = true;
    active.requeue = requeue;
    log.info(`run: stopping "${active.topic}"${requeue ? ' and holding it' : ''}`);
    return snapshot(active);
  }
  return null;
}

/** Replays history, then streams. Returns undefined when the run id is unknown. */
export function subscribe(
  id: string,
  listener: (event: RunEvent) => void,
): (() => void) | undefined {
  const run = runs.get(id);
  if (run === undefined) return undefined;
  for (const event of run.events) listener(event);
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

/**
 * The sheet a produce or stills run consumes comes from disk, not from
 * regeneration: the whole point of the checkpoint is that edits made between
 * plan and render are what gets rendered.
 */
/**
 * Settings that describe how a sheet is drawn, never what is in it. None moves
 * a cut, retimes a word or changes which picture belongs to which beat.
 */
const PRESENTATION = [
  'effect',
  'style',
  'captionScale',
  'subtitles',
  // Which cues are audible is a mix decision, not a plan one: the sheet holds
  // every cue either way, so switching the clicks on is a re-produce rather
  // than a rebuild of the beats.
  'sfxCues',
  // A mix decision too: the level is applied when the sound is placed, at produce.
  'warSfxDb',
  // Purely how the panels are drawn, so it applies on a re-render like the
  // board's texture does, without planning the video again.
  'panelTexture',
  'mode',
  'boardTexture',
  'boardTheme',
  'boardContent',
  'boardImagery',
] as const;

/**
 * Whether a run is actually asking for something different from what the sheet
 * already says. `!==` is wrong for the one presentation key that is a list --
 * two equal arrays are never the same object, so sfxCues would be reported as
 * changed on every render that touched it.
 */
function differs(current: unknown, given: unknown): boolean {
  if (Array.isArray(current) && Array.isArray(given)) {
    return JSON.stringify(current) !== JSON.stringify(given);
  }
  return current !== given;
}

function sheetFromDisk(slug: string, options?: StartOptions): BeatSheet {
  const file = beatSheetPath(slug);
  if (!fs.existsSync(file)) {
    throw new Error(`no beat sheet for "${slug}" yet — run plan first`);
  }

  /**
   * The sheet keeps its beats, and the run gets its look.
   *
   * Stills and produce read the sheet straight off disk, so everything about
   * appearance was frozen at plan time: choosing a slate board and pressing
   * render gave back the paper one the sheet had been planned with, silently.
   * Only the presentation keys are taken, and only where the run actually
   * differs, so a render with nothing to say still draws the sheet as written.
   */
  const raw = readJson(file) as { meta?: Record<string, unknown> };
  if (options !== undefined && raw.meta !== undefined) {
    const given = options as unknown as Record<string, unknown>;
    const changed: string[] = [];
    for (const key of PRESENTATION) {
      if (given[key] === undefined || !differs(raw.meta[key], given[key])) continue;
      raw.meta[key] = given[key];
      changed.push(key);
    }
    if (changed.length > 0) log.info(`sheet: applying ${changed.join(', ')} from this run`);
  }
  return parseBeatSheet(raw);
}

export function lintSheet(sheet: BeatSheet): LintFinding[] {
  return lintBeatSheet(sheet);
}

async function executePlan(run: RunRecord, options: StartOptions): Promise<unknown> {
  const result = await produceBeatSheet({
    topic: options.topic,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.script !== undefined ? { script: options.script } : {}),
    ...(options.adapt !== undefined ? { adapt: options.adapt } : {}),
    ...(options.character !== undefined ? { character: options.character } : {}),
    ...(options.ttsProvider !== undefined ? { ttsProvider: options.ttsProvider } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.effect !== undefined ? { effect: options.effect } : {}),
    ...(options.music !== undefined ? { music: options.music } : {}),
    ...(options.musicLufs !== undefined ? { musicLufs: options.musicLufs } : {}),
    ...(options.musicFadeInMs !== undefined ? { musicFadeInMs: options.musicFadeInMs } : {}),
    ...(options.musicFadeOutMs !== undefined ? { musicFadeOutMs: options.musicFadeOutMs } : {}),
    ...(options.musicStartMs !== undefined ? { musicStartMs: options.musicStartMs } : {}),
    ...(options.tone !== undefined ? { tone: options.tone } : {}),
    ...(options.imagery !== undefined ? { imagery: options.imagery } : {}),
    ...(options.imageSource !== undefined ? { imageSource: options.imageSource } : {}),
    ...(options.imageCount !== undefined ? { imageCount: options.imageCount } : {}),
    ...(options.style !== undefined ? { style: options.style } : {}),
    ...(options.captionScale !== undefined ? { captionScale: options.captionScale } : {}),
    ...(options.subtitles !== undefined ? { subtitles: options.subtitles } : {}),
    ...(options.sfxCues !== undefined ? { sfxCues: options.sfxCues } : {}),
    ...(options.cloneVoice !== undefined ? { cloneVoice: options.cloneVoice } : {}),
    ...(options.elevenVoice !== undefined ? { elevenVoice: options.elevenVoice } : {}),
    ...(options.panelTexture !== undefined ? { panelTexture: options.panelTexture } : {}),
    ...(options.artStyle !== undefined ? { artStyle: options.artStyle } : {}),
    ...(options.stickWorld === 'ai' || options.stickWorld === 'drawn' ? { stickWorld: options.stickWorld } : {}),
    ...(options.niche === 'war' || options.niche === 'books' ? { niche: options.niche } : {}),
    ...(options.series !== undefined ? { series: options.series } : {}),
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.brief !== undefined ? { brief: options.brief } : {}),
    ...(options.boardTexture !== undefined ? { boardTexture: options.boardTexture } : {}),
    ...(options.boardTheme !== undefined ? { boardTheme: options.boardTheme } : {}),
    ...(options.boardContent !== undefined ? { boardContent: options.boardContent } : {}),
    ...(options.boardImagery !== undefined ? { boardImagery: options.boardImagery } : {}),
    variant: options.variant,
    force: options.force,
    onStage: (stage) => { checkpoint(run); emit(run, { type: 'stage', stage }); },
    // Called per line of the reading -- the one place a long run can be
    // stopped without losing half an hour, now that lines are cached.
    onProgress: () => checkpoint(run),
  });
  writeJsonAtomic(beatSheetPath(run.slug), result.sheet);
  // History is written at plan time so the sheet is safe as soon as it exists,
  // not only once something has been rendered. No-ops when signed out.
  await recordProject(result.sheet);
  return {
    slug: run.slug,
    sheet: result.sheet,
    findings: lintBeatSheet(result.sheet),
    snapped: result.snapped,
    snapAttempts: result.snapAttempts,
  };
}

async function executeProduce(run: RunRecord, options: StartOptions): Promise<unknown> {
  const sheet = await fillDrawings(sheetFromDisk(run.slug, options), options);
  emit(run, { type: 'stage', stage: 'render' });
  await renderPicture(sheet);
  emit(run, { type: 'stage', stage: 'mix' });
  const mix = await mixVideo(sheet, { force: options.force });
  await recordRender(run.slug);
  // A stick figure Short gets its vertical thumbnail from its own moments. A
  // thumbnail is a garnish: failing to make one never fails the video.
  if (sheet.meta.mode === 'stickman') {
    try {
      await makeShortThumbnail(sheet);
    } catch (error) {
      log.warn(`thumbnail: none made (${(error as Error).message})`);
    }
  }
  return {
    slug: run.slug,
    durationMs: mix.durationMs,
    narration: mix.narrationLoudness,
    master: mix.masterLoudness,
    cues: mix.cues,
    coverage: mix.coverage,
    unmatchedSamples: mix.unmatchedSamples,
    musicMixed: mix.stems.music !== undefined,
  };
}

/**
 * Fills in drawings a sheet does not have yet.
 *
 * Illustrations are made at plan time, so a sheet planned with the icon set
 * carries icons and nothing else. Switching the control to "illustrated" and
 * pressing render then changed nothing at all -- the setting looked live and
 * did nothing, which is the worst of both. Rendering tops the sheet up
 * instead, and only for beats that will show one.
 */
async function fillDrawings(sheet: BeatSheet, options: StartOptions): Promise<BeatSheet> {
  if (sheet.meta.mode !== 'whiteboard') return sheet;
  if ((options.imageSource ?? sheet.meta.imageSource) !== 'ai') return sheet;

  // Every beat without an image, whether or not it matched an icon. Measured
  // across twelve sheets, only 35% of beats matched one -- so topping up just
  // those left two thirds of each video with nothing drawn, which is exactly
  // what it looked like.
  const wanted = sheet.beats.some((b) => b.illustration === null || b.illustration.file === null);
  if (!wanted) return sheet;

  log.info('sketch: this sheet has no illustrations yet, drawing them now');
  const files = await generateSketches({
    topic: sheet.meta.topic,
    beatTexts: sheet.beats.map((b) =>
      b.illustration?.file != null ? '' : beatWords(b.lines).join(' '),
    ),
    // Every beat, including the ones already drawn: a beat topped up here still
    // has to belong to the same video as the ones it sits between.
    script: sheet.beats.map((b) => beatWords(b.lines).join(' ')).join(' '),
    seed: sheet.meta.seed,
    force: options.force,
  });

  const filled = parseBeatSheet({
    ...sheet,
    beats: sheet.beats.map((beat, index) => {
      const file = files[index];
      if (file == null) return beat;
      // A beat that matched nothing still gets the picture; the icon strokes
      // it never had stay empty behind it.
      const base = beat.illustration ?? { name: 'illustration', paths: [] };
      return { ...beat, illustration: { ...base, file } };
    }),
  });
  writeJsonAtomic(beatSheetPath(sheet.meta.slug), filled);
  return filled;
}

/**
 * Long form. Nothing here touches a beat sheet: it writes prose, reads it,
 * finds one picture and lets ffmpeg drift across it for however long the
 * reading came out at.
 */
async function executeLore(run: RunRecord, options: StartOptions): Promise<unknown> {
  return produceLore({
    topic: options.topic,
    minutes: options.minutes ?? 20,
    force: options.force,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.character !== undefined ? { character: options.character } : {}),
    ...(options.ttsProvider !== undefined ? { ttsProvider: options.ttsProvider } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.cloneVoice !== undefined ? { cloneVoice: options.cloneVoice } : {}),
    ...(options.elevenVoice !== undefined ? { elevenVoice: options.elevenVoice } : {}),
    ...(options.bed !== undefined ? { bed: options.bed as AmbienceName } : {}),
    ...(options.generatedStill === true ? { generated: true } : {}),
    onStage: (stage) => { checkpoint(run); emit(run, { type: 'stage', stage }); },
    // Called per line of the reading -- the one place a long run can be
    // stopped without losing half an hour, now that lines are cached.
    onProgress: () => checkpoint(run),
  });
}

async function executeBook(run: RunRecord, options: StartOptions): Promise<unknown> {
  return produceBookEssay({
    book: options.topic,
    vertical: (options.vertical ?? 'ending') as Vertical,
    minutes: options.minutes ?? 25,
    force: options.force,
    ...(options.angle !== undefined ? { angle: options.angle } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.character !== undefined ? { character: options.character } : {}),
    ...(options.ttsProvider !== undefined ? { ttsProvider: options.ttsProvider } : {}),
    ...(options.cloneVoice !== undefined ? { cloneVoice: options.cloneVoice } : {}),
    ...(options.elevenVoice !== undefined ? { elevenVoice: options.elevenVoice } : {}),
    ...(options.script !== undefined ? { script: options.script } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.direction !== undefined ? { direction: options.direction } : {}),
    ...(options.effect !== undefined ? { effect: options.effect } : {}),
    ...(options.music !== undefined ? { music: options.music } : {}),
    ...(options.musicLufs !== undefined ? { musicLufs: options.musicLufs } : {}),
    ...(options.punchStyle !== undefined ? { punchStyle: options.punchStyle } : {}),
    ...(options.pictures !== undefined
      ? { pictures: options.pictures as 'none' | 'ai' | 'stock' }
      : {}),
    ...(options.pictureCount !== undefined ? { pictureCount: options.pictureCount } : {}),
    ...(options.cutoutCount !== undefined ? { cutoutCount: options.cutoutCount } : {}),
    ...(options.imageEngine === 'flux' ||
    options.imageEngine === 'gemini' ||
    options.imageEngine === 'mixed'
      ? { imageEngine: options.imageEngine }
      : {}),
    ...(options.look === 'cinematic' || options.look === 'storybook' || options.look === 'stickman'
      ? { look: options.look }
      : {}),
    ...(options.stickWorld === 'ai' || options.stickWorld === 'drawn' ? { stickWorld: options.stickWorld } : {}),
    ...(options.niche === 'war' || options.niche === 'books' ? { niche: options.niche } : {}),
    ...(typeof options.warSfxDb === 'number' ? { warSfxDb: options.warSfxDb } : {}),
    ...(typeof options.warSfx === 'boolean' ? { warSfx: options.warSfx } : {}),
    ...(typeof options.typewriter === 'boolean' ? { typewriter: options.typewriter } : {}),
    ...(options.stickFinish === 'cinematic' || options.stickFinish === 'plain' ? { stickFinish: options.stickFinish } : {}),
    ...(isPictureStyle(options.pictureStyle) ? { pictureStyle: options.pictureStyle } : {}),
    ...(options.chapters === 'auto' || options.chapters === 'off' || options.chapters === 'script'
      ? { chapters: options.chapters }
      : {}),
    ...(options.parallax === false ? { parallax: false } : {}),
    ...(options.realSources === false ? { realSources: false } : {}),
    ...(options.sound !== undefined
      ? { sound: options.sound as 'none' | 'sparse' | 'full' }
      : {}),
    ...(options.effectStrength !== undefined
      ? { effectStrength: options.effectStrength }
      : {}),
    ...(options.essayCaptionScale !== undefined
      ? { captionScale: options.essayCaptionScale }
      : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    ...(options.fps !== undefined ? { fps: options.fps } : {}),
    onStage: (stage) => { checkpoint(run); emit(run, { type: 'stage', stage }); },
    // Per section while writing and per line while reading: the two places a
    // twenty-five minute run can be stopped without losing all of it.
    onProgress: () => checkpoint(run),
  });
}

async function executeStills(run: RunRecord, options: StartOptions): Promise<unknown> {
  const sheet = await fillDrawings(sheetFromDisk(run.slug, options), options);
  const picks = firstBeatPerTemplate(sheet);
  emit(run, { type: 'stage', stage: 'stills' });
  const files = await renderBeatStills(sheet, picks.map((pick) => pick.id));
  return {
    slug: run.slug,
    stills: files.map((file) => ({ file: path.basename(file) })),
  };
}

/**
 * Puts a run in the queue and makes sure something is working on it.
 *
 * It used to refuse outright while anything was running, which is where the
 * complaint came from: one long video meant forty-five minutes of not being
 * able to so much as describe the next one. Nothing about the machine required
 * that -- only the bookkeeping did.
 */
export function startRun(options: StartOptions): RunSnapshot {
  const run: RunRecord = {
    id: crypto.randomUUID(),
    kind: options.kind,
    topic: options.topic,
    // The same folder rule the stage itself uses, so the run and the work agree.
    slug: workSlug(options.kind === 'book' ? 'book' : options.kind === 'lore' ? 'lore' : 'short', options.topic),
    status: 'queued',
    events: [],
    listeners: new Set(),
    options,
    cancelled: false,
  };
  runs.set(run.id, run);
  queue.push(run);
  pump();
  return snapshot(run);
}

/** Starts the next run if nothing is going. Safe to call whenever. */
function pump(): void {
  if (active !== undefined) return;
  const next = queue.shift();
  if (next === undefined) return;

  active = next;
  next.status = 'running';
  // Everything a provider charges for from here on belongs to this video.
  setSpendContext(next.slug);

  const offLog = onLog((level, line) => emit(next, { type: 'log', level, line }));

  void (async () => {
    try {
      const result =
        next.kind === 'plan'
          ? await executePlan(next, next.options)
          : next.kind === 'produce'
            ? await executeProduce(next, next.options)
            : next.kind === 'lore'
              ? await executeLore(next, next.options)
              : next.kind === 'book'
                ? await executeBook(next, next.options)
              : await executeStills(next, next.options);
      next.status = 'done';
      emit(next, { type: 'done', kind: next.kind, result });
    } catch (error) {
      if (error instanceof CancelledError) {
        /**
         * Held, not requeued. The work it finished is in the cache under keys
         * made from its own inputs, so resuming costs whatever was in flight
         * when it stopped -- on a long reading, one sentence -- and the queue
         * is free for whatever it was paused to make room for.
         */
        if (next.requeue === true) {
          next.status = 'paused';
          next.requeue = false;
          emit(next, { type: 'log', level: 'info', line: 'paused — resume it when you like' });
        } else {
          next.status = 'cancelled';
          emit(next, { type: 'error', message: 'stopped' });
        }
      } else {
        next.status = 'error';
        emit(next, {
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      offLog();
      active = undefined;
      // Whatever happened, something else may be waiting.
      pump();
    }
  })();
}
