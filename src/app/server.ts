import { PICTURE_STYLES, isPictureStyle } from '../design/signature.js';
import { makeShortThumbnail, shortThumbPath } from '../stages/shortthumb.js';
import { isConfigured as elevenConfigured, listVoices as listElevenVoices } from '../providers/elevenlabs.js';
import {
  canRemix,
  hasProject,
  loadProject,
  mixProject,
  stemInfo,
  stemPaths,
  renderProject,
  renderProjectStill,
  saveProject,
  type Project,
} from '../stages/project.js';
import { IMAGE_DIR } from '../stages/images.js';
import { writeEssayDescription } from '../stages/describe.js';
import { checkScript } from '../stages/scriptcheck.js';
import { estimateRenderMs, measuredRates } from '../stages/renderrate.js';
import { NO_TEXT } from '../stages/imagegen.js';
import { generateImage } from '../providers/flux.js';
import { drawImage } from '../providers/geminiimage.js';
import { canGoBehind, depthMapFor, depthMatte } from '../providers/localvision.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AUDIO, PLAN, ROOT, assetDirs, beatSheetPath, dirs, env, workDir } from '../config.js';
import { readJson, writeJsonAtomic } from '../json.js';
import { log } from '../log.js';
import {
  EFFECT_NAMES,
  IMAGERY_MODES,
  MUSIC_LUFS_MAX,
  MUSIC_LUFS_MIN,
  MUSIC_FADE_IN_MS,
  MUSIC_FADE_OUT_MS,
  MUSIC_FADE_MAX_MS,
  IMAGE_SOURCES,
  STYLE_NAMES,
  BeatSheetValidationError,
  parseBeatSheet,
  type EffectName,
  type ImageryMode,
  type ImageSource,
  type StyleName,
  BOARD_CONTENTS,
  BOARD_IMAGERY,
  BOARD_THEMES,
  RENDER_MODES,
  SUBTITLE_MODES,
  SFX_CUES,
  ART_STYLES,
  type BoardContent,
  type BoardImagery,
  type BoardTheme,
  type RenderMode,
  type SubtitleMode,
  type SfxCue,
  type ArtStyle,
} from '../schema.js';
import { MissingApiKeyError } from '../providers/errors.js';
import { isConfigured as imagesConfigured } from '../providers/flux.js';
import { isConfigured as freeImagesConfigured } from '../providers/cloudflare.js';
import { isConfigured as footageConfigured } from '../providers/pexels.js';
import * as youtube from '../providers/youtube.js';
import * as analytics from '../analytics.js';
import { LANGUAGES, LANGUAGE_LIST, isLanguage, readerFor } from '../languages.js';
import { VERTICALS, VERTICAL_BRIEF } from '../stages/essay.js';
import { soundAvailable } from '../stages/essaysound.js';
import { isConfigured as freesoundConfigured } from '../providers/freesound.js';
import * as facebook from '../providers/facebook.js';
import { buildFacebookMetadata, publishToFacebook } from '../stages/publishfb.js';
import {
  describeLong,
  isLongKind,
  longFacebookMetadata,
  longYouTubeMetadata,
  publishLongToFacebook,
  publishLongToYouTube,
  firstComment,
  referencesFor,
} from '../stages/longform.js';
import { forgetPost, PLATFORMS, type Platform } from '../posts.js';
import { DEFAULT_EFFECT, DEFAULT_SFX_CUES } from '../stages/pipeline.js';
import { adaptScript } from '../stages/adapt.js';
import {
  buildMetadata,
  checkEligibility,
  probeVideo,
  publishToYouTube,
  renderedFile,
} from '../stages/publish.js';
import { picturePath } from '../stages/render.js';
import { listTracks } from '../stages/music.js';
import { AMBIENCE_LABELS, AMBIENCE_NAMES } from '../stages/ambience.js';
import { SAGA_WORDS_PER_MINUTE } from '../stages/saga.js';
import { loadSfxLibrary, resolveCue } from '../sfx.js';
import { listOwn, ownDir } from '../stages/own.js';
import { isConfigured as cloneConfigured, speak as cloneSpeak } from '../providers/chatterbox.js';
import {
  READING_PASSAGES,
  addVoice,
  clipPath,
  findVoice,
  listVoices,
  removeVoice,
  renameVoice,
} from '../voiceclone.js';
import {
  checkBudget,
  estimateRun,
  freeAlternative,
  spendSummary,
  writeLimits,
} from '../spend.js';
import { ffmpeg, probeDurationMs } from '../ffmpeg.js';
import { CAPTION_SCALE, STYLES } from '../design.js';
import { CHARACTERS, accentLabel, characterFor, isCharacter } from '../voices.js';
import { DEFAULT_TONE, TONES, isTone } from '../tones.js';
import {
  BusyError,
  activeRun,
  cancelRun,
  lintSheet,
  pausedRuns,
  queuedRuns,
  resumeRun,
  startRun,
  subscribe,
  type RunKind,
} from './runs.js';
import { chooseThumbnail, loadThumbnails, makeThumbnails, rewordThumbnail } from '../stages/thumbnail.js';
import {
  MAX_SPEED,
  MIN_SPEED,
  copyPath,
  listCopies,
  mainSpeed,
  speedJob,
  startSpeedCopy,
  useAsMain,
} from '../stages/speedcopy.js';
import { CATEGORIES, CATEGORY_IDS, suggestTopics } from './topics.js';
import { deleteSeries, idFor, listSeries, putSeries } from './series.js';
import { isConfigured as supabaseConfigured, resetSupabase, SupabaseNotConfiguredError } from '../supabase/client.js';
import { KeyError, exportKeys, keyStates, parseKeysFile, saveKeys } from '../keys.js';
import { isResetKind, resetEverything } from '../reset.js';
import {
  AuthError,
  currentAccount,
  DEVICE_ID,
  fetchSheet,
  forgetProject,
  listProjects,
  readPreferences,
  signIn,
  signOut,
  signUp,
  writePreferences,
  forgetSession,
} from '../supabase/account.js';

const LANDING = path.join(ROOT, 'src', 'app', 'landing.html');
const PAGE = path.join(ROOT, 'src', 'app', 'index.html');
const FONT = path.join(ROOT, 'src', 'remotion', 'fonts', 'inter-latin-wght-normal.woff2');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STILL_RE = /^[a-z0-9-]+\.png$/;
const RUN_KINDS: readonly RunKind[] = ['plan', 'produce', 'stills', 'lore', 'book'];
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SSE_PING_MS = 15_000;

export type AppServerOptions = {
  port: number;
  host: string;
};

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendFile(res: http.ServerResponse, file: string, mime: string): void {
  if (!fs.existsSync(file)) {
    sendJson(res, 404, { error: `not found: ${path.basename(file)}` });
    return;
  }
  const { size } = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

/** <video> seeks with Range requests; without 206 support scrubbing breaks. */
function sendVideo(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  if (!fs.existsSync(file)) {
    sendJson(res, 404, { error: `not rendered yet: ${path.basename(file)}` });
    return;
  }
  const { size } = fs.statSync(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');

  if (range === null) {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  const start = range[1] === '' ? 0 : Number.parseInt(range[1] ?? '0', 10);
  const end = range[2] === '' ? size - 1 : Number.parseInt(range[2] ?? '', 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    'Content-Type': 'video/mp4',
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Anything the page needs to do something about it. A refusal that is only
     * a sentence leaves the interface with nothing to offer but an apology.
     */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function requireSlug(value: string): string {
  if (!SLUG_RE.test(value)) throw new HttpError(400, `invalid slug "${value}"`);
  return value;
}

/** Written as characters so no editing pass can eat the escape. */
const NL = String.fromCharCode(10);

function listWorks(): unknown[] {
  if (!fs.existsSync(dirs.work)) return [];
  const works: { mtimeMs: number; entry: unknown }[] = [];

  for (const dirent of fs.readdirSync(dirs.work, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !SLUG_RE.test(dirent.name)) continue;

    const sheetFile = beatSheetPath(dirent.name);
    const sagaFile = path.join(dirs.work, dirent.name, 'saga.txt');
    const essayFile = path.join(dirs.work, dirent.name, 'essay.txt');
    const loreVideo = path.join(dirs.out, `${dirent.name}-lore.mp4`);
    const essayVideo = path.join(dirs.out, `${dirent.name}-essay.mp4`);
    const hasSheet = fs.existsSync(sheetFile);
    // Long-form writes prose and no beat sheet, so keying the library on a
    // beat sheet made every one of those videos invisible in it. A book essay
    // writes prose too, under its own name -- and without this line every one
    // of them was invisible for exactly the same reason.
    const hasSaga = fs.existsSync(sagaFile);
    const hasEssay = fs.existsSync(essayFile);
    if (!hasSheet && !hasSaga && !hasEssay) continue;

    try {
      const source = hasSheet ? sheetFile : hasEssay ? essayFile : sagaFile;
      const sheet = hasSheet
        ? (readJson(sheetFile) as {
            meta?: { topic?: string; durationMs?: number; mode?: string; series?: string | null };
          })
        : undefined;
      // The first line of the prose is the title the writer gave it, and both
      // prose formats put it there.
      const title =
        hasEssay || hasSaga
          ? (fs.readFileSync(hasEssay ? essayFile : sagaFile, 'utf8').split(NL)[0] ??
              dirent.name).trim()
          : '';

      works.push({
        mtimeMs: fs.statSync(source).mtimeMs,
        entry: {
          slug: dirent.name,
          topic: sheet?.meta?.topic ?? (title !== '' ? title : dirent.name),
          durationMs: sheet?.meta?.durationMs ?? null,
          kind: hasSheet ? (sheet?.meta?.mode ?? 'kinetic') : hasEssay ? 'essay' : 'lore',
          series: sheet?.meta?.series ?? null,
          madeAtMs: fs.statSync(source).mtimeMs,
          hasPicture: hasSheet && fs.existsSync(picturePath(dirent.name)),
          hasVideo:
            fs.existsSync(path.join(dirs.out, `${dirent.name}.mp4`)) ||
            fs.existsSync(loreVideo) ||
            fs.existsSync(essayVideo),
          // Only a video saved with a project file can be opened in the editor.
          hasProject: hasProject(dirent.name),
        },
      });
      /**
       * A folder with a short in it and a long essay as well -- two runs that
       * shared a title before folders were kept apart by kind -- is two
       * videos, and listed as two. It was one row, the short's, and the
       * essay could not be found at all.
       */
      if (hasSheet && hasEssay && fs.existsSync(essayVideo)) {
        works.push({
          mtimeMs: fs.statSync(essayVideo).mtimeMs,
          entry: {
            slug: dirent.name,
            topic: (fs.readFileSync(essayFile, 'utf8').split(NL)[0] ?? dirent.name).trim() || dirent.name,
            durationMs: null,
            kind: 'essay',
            series: null,
            madeAtMs: fs.statSync(essayVideo).mtimeMs,
            hasPicture: false,
            hasVideo: true,
            hasProject: hasProject(dirent.name),
          },
        });
      }
    } catch {
      // an unreadable sheet is not the app's problem to report here
    }
  }

  return works.sort((a, b) => b.mtimeMs - a.mtimeMs).map((work) => work.entry);
}

function listStills(slug: string): { file: string }[] {
  const directory = path.join(workDir(slug), 'stills');
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => STILL_RE.test(name))
    .sort()
    .map((name) => ({ file: name }));
}

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

function route(method: string, pattern: RegExp, handler: Handler): void {
  routes.push({ method, pattern, handler });
}

route('GET', /^\/$/, async (_req, res) => {
  sendFile(res, LANDING, 'text/html; charset=utf-8');
});

/**
 * The app is behind the account. The one exception is a server with no accounts
 * configured at all — there is no way to register on such a server, so gating it
 * would lock everyone out of a tool that otherwise runs fine.
 */
async function isLockedOut(): Promise<boolean> {
  if (!supabaseConfigured()) return false;
  return (await currentAccount()) === null;
}

route('GET', /^\/app\/?$/, async (_req, res) => {
  if (await isLockedOut()) {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }
  sendFile(res, PAGE, 'text/html; charset=utf-8');
});

/**
 * The most recent finished short, for the landing page to draw with. It is the
 * one thing on that page that is not a claim: whatever this machine made last
 * is what the field is showing. 404 until something has been produced, and the
 * page falls back to a drawn pattern.
 */
function newestRender(): string | null {
  if (!fs.existsSync(dirs.out)) return null;
  const files = fs
    .readdirSync(dirs.out)
    .filter((name) => name.endsWith('.mp4'))
    .map((name) => path.join(dirs.out, name))
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.file ?? null;
}

route('GET', /^\/api\/showreel$/, async (req, res) => {
  const file = newestRender();
  if (file === null) throw new HttpError(404, 'nothing has been produced on this machine yet');
  sendVideo(req, res, file);
});

/**
 * A picture, by name. PNG as well as JPEG: the drawn panels and every cut-out
 * subject are PNG, so an editor that could only serve JPEG could show the
 * stock photographs and none of the pictures this tool makes itself.
 */
route('GET', /^\/images\/[A-Za-z0-9_.-]+\.(jpg|jpeg|png)$/, async (_req, res, url) => {
  const file = path.basename(url.pathname);
  sendFile(res, path.join(ROOT, 'public', 'images', file), file.endsWith('.png') ? 'image/png' : 'image/jpeg');
});

/**
 * Footage, for the beat-sheet previews. Ranged like the finished video rather
 * than sent whole: these are multi-megabyte clips, and a browser asked to show
 * twenty of them at once will open twenty requests for the first second of each.
 */
route('GET', /^\/videos\/[A-Za-z0-9_-]+\.mp4$/, async (req, res, url) => {
  const file = path.basename(url.pathname);
  sendVideo(req, res, path.join(ROOT, 'public', 'videos', file));
});

/**
 * One sound-effect sample, for auditioning before a render.
 *
 * Addressed by cue and variant rather than by filename: the page has no
 * business knowing what is on this disk, and a route that takes a name is a
 * route that has to be careful about what the name contains.
 */
route('GET', /^\/api\/sfx\/[a-z]+\/[0-9]{1,2}$/, async (_req, res, url) => {
  const parts = url.pathname.split('/');
  const cue = parts[3] ?? '';
  const variant = Number(parts[4] ?? '0');
  if (!(SFX_CUES as readonly string[]).includes(cue)) throw new HttpError(404, 'no such cue');
  const file = resolveCue(loadSfxLibrary(), cue as SfxCue, variant);
  if (file === undefined) throw new HttpError(404, `no samples for ${cue}`);
  sendFile(res, file, 'audio/wav');
});

route('GET', /^\/font\.woff2$/, async (_req, res) => {
  sendFile(res, FONT, 'font/woff2');
});

/**
 * What each cue is, in the terms someone choosing between them would use.
 *
 * Named for the moment it marks rather than for the sound it makes: "whoosh"
 * says nothing about when you would want one. Two separate answers, because
 * they are two separate questions and running them together is what makes a
 * list of effects unreadable -- `sound` is what you will hear, `where` is the
 * moment in the video it will happen at.
 */
const SFX_INFO: Record<SfxCue, { label: string; sound: string; where: string }> = {
  whoosh: {
    label: 'Picture changes',
    sound: 'A rising swell of air that peaks and stops.',
    where: 'On every cut, timed so the top of the swell and the new picture are the same frame.',
  },
  impact: {
    label: 'Emphasised words',
    sound: 'A short, low, dry thud. No ring.',
    where: 'Under the one word each beat is built around, as that word is spoken.',
  },
  riser: {
    label: 'Before a turn',
    sound: 'A long low rise, about a second.',
    where: 'Leading into a beat that starts with "but", "actually" or "turns out". Rare by design.',
  },
  click: {
    label: 'Each line of type',
    sound: 'A small physical tick, like a switch.',
    where: 'As every line of text appears — which is several per beat, so there are a lot of them.',
  },
};

route('GET', /^\/api\/status$/, async (_req, res) => {
  const sfxSamples = loadSfxLibrary();
  sendJson(res, 200, {
    effects: EFFECT_NAMES,
    pictureStyles: Object.entries(PICTURE_STYLES).map(([id, style]) => ({ id, label: style.label })),
    defaultEffect: DEFAULT_EFFECT,
    tracks: listTracks().map((track) => track.name),
    tones: TONES.map((tone) => ({ id: tone.id, label: tone.label, blurb: tone.blurb })),
    defaultTone: DEFAULT_TONE,
    musicFades: { in: MUSIC_FADE_IN_MS, out: MUSIC_FADE_OUT_MS, max: MUSIC_FADE_MAX_MS },
    musicLevel: {
      min: MUSIC_LUFS_MIN,
      max: MUSIC_LUFS_MAX,
      default: AUDIO.musicLufs,
    },
    captionScale: {
      min: CAPTION_SCALE.min,
      max: CAPTION_SCALE.max,
      default: CAPTION_SCALE.default,
    },
    renderModes: RENDER_MODES,
    boardThemes: BOARD_THEMES,
    boardContents: BOARD_CONTENTS,
    boardImagery: BOARD_IMAGERY,
    imageryModes: IMAGERY_MODES,
    imageSources: IMAGE_SOURCES,
    subtitleModes: SUBTITLE_MODES,
    lore: {
      beds: AMBIENCE_NAMES.map((id) => ({ id, label: AMBIENCE_LABELS[id] })),
      wordsPerMinute: SAGA_WORDS_PER_MINUTE,
      minMinutes: 2,
      maxMinutes: 240,
    },
    artStyles: ART_STYLES,
    /*
      The cue list with what is actually on disk to play each one. A checkbox
      for a cue with no samples behind it is a switch wired to nothing, and the
      page should be able to say so rather than letting somebody turn it on and
      hear silence.
    */
    sfx: {
      cues: SFX_CUES.map((cue) => ({
        id: cue,
        ...SFX_INFO[cue],
        samples: sfxSamples.samples[cue]?.length ?? 0,
      })),
      defaults: DEFAULT_SFX_CUES,
      dir: path.relative(ROOT, sfxSamples.dir).split(path.sep).join('/'),
    },
    topicCategories: CATEGORY_IDS.map((id) => ({ id, label: CATEGORIES[id]?.label ?? id })),
    /**
     * Sent whole rather than as a list of ids, because the picker has to say
     * what choosing one costs -- which reader it forces, and whether that
     * reader is free -- and the browser has no way to know that on its own.
     */
    /** What sound effects are actually on disk, so the screen can say. */
    sfxAvailable: soundAvailable(),
    /** Whether a music search is possible at all. */
    musicSearch: freesoundConfigured(),
    /** The five book verticals, with what each one is, for the picker. */
    verticals: VERTICALS.map((id) => ({ id, brief: VERTICAL_BRIEF[id] })),
    languages: LANGUAGE_LIST.map((entry) => ({
      id: entry.id,
      label: entry.label,
      native: entry.native,
      readers: entry.readers,
      free: (entry.readers as readonly string[]).includes('kokoro'),
    })),
    imageDefaults: {
      source: env.IMAGE_SOURCE,
      count: env.FLUX_IMAGES,
      usdPerImage: env.FLUX_USD_PER_IMAGE,
    },
    // The tokens the browser needs to draw type the way the renderer will —
    // the loading preview types out real beats, and guessing at the casing
    // would make it a lie.
    styles: STYLE_NAMES.map((name) => {
      const tokens = STYLES[name];
      return {
        name,
        label: tokens?.label ?? name,
        casing: tokens?.casing ?? 'none',
        bodyWeight: tokens?.bodyWeight ?? 500,
        emphasisWeight: tokens?.emphasisWeight ?? 800,
        trackingEm: tokens?.trackingEm ?? -0.03,
        ink: tokens?.ink ?? '#f6f5f2',
        accent: tokens?.accent ?? '#ffffff',
      };
    }),
    // The engine's own voice ids stay on this side; the browser sees people.
    characters: CHARACTERS.map((character) => ({
      id: character.id,
      label: character.label,
      blurb: character.blurb,
      gender: character.gender,
      group: `${accentLabel(character.accent)} · ${character.gender}`,
    })),
    defaultCharacter: characterFor(env.VOICE_CHARACTER).id,
    scriptLimits: {
      wordsPerSecond: PLAN.spokenWordsPerSecond,
      maxWords: PLAN.pastedMaxWords,
      maxMs: PLAN.pastedMaxMs,
    },
    // Capability flags, not provider names: nothing the browser receives should
    // say which services are behind the pipeline.
    canWriteScripts: env.GEMINI_API_KEY !== undefined,
    canGenerateImages: imagesConfigured(),
    canGenerateFree: freeImagesConfigured(),
    canFetchFootage: footageConfigured(),
    voiceEngines: [
      { id: 'kokoro', label: 'Local — free, always available', hosted: false, available: true },
      {
        id: 'gemini',
        label: 'Gemini — far more natural, free tier',
        hosted: true,
        available: env.GEMINI_API_KEY !== undefined,
      },
      {
        id: 'elevenlabs',
        label: 'ElevenLabs — the most expressive',
        hosted: true,
        available: elevenConfigured(),
      },
      {
        id: 'clone',
        label: 'Cloned — your own voice',
        hosted: true,
        // Configured is not the same as usable here: the key can be there and
        // the recording missing, and those need different things saying.
        available: cloneConfigured() && listVoices().length > 0,
        needsReference: cloneConfigured() && listVoices().length === 0,
      },
    ],
    defaultVoiceEngine: env.TTS_PROVIDER,
    accountsEnabled: supabaseConfigured(),
    deviceId: DEVICE_ID,
    account: await currentAccount(),
    active: activeRun() ?? null,
    queue: queuedRuns(),
    paused: pausedRuns(),
  });
});

function credentials(body: Record<string, unknown>): { email: string; password: string } {
  const email = typeof body['email'] === 'string' ? body['email'].trim() : '';
  const password = typeof body['password'] === 'string' ? body['password'] : '';
  if (email === '' || password === '') throw new HttpError(400, 'email and password are required');
  if (password.length < 6) throw new HttpError(400, 'password must be at least 6 characters');
  return { email, password };
}

/**
 * The ElevenLabs voices this account can read with, for the picker. Names and
 * ids only -- the key stays on this side.
 */
route('GET', /^\/api\/voices\/elevenlabs$/, async (_req, res) => {
  if (!elevenConfigured()) {
    sendJson(res, 200, { voices: [], configured: false });
    return;
  }
  try {
    sendJson(res, 200, { voices: await listElevenVoices(), configured: true, defaultVoice: env.ELEVENLABS_VOICE ?? null });
  } catch (error) {
    throw new HttpError(502, (error as Error).message);
  }
});

route('POST', /^\/api\/auth\/signup$/, async (req, res) => {
  const { email, password } = credentials((await readBody(req)) as Record<string, unknown>);
  sendJson(res, 200, await signUp(email, password));
});

route('POST', /^\/api\/auth\/signin$/, async (req, res) => {
  const { email, password } = credentials((await readBody(req)) as Record<string, unknown>);
  sendJson(res, 200, { account: await signIn(email, password) });
});

route('POST', /^\/api\/auth\/signout$/, async (_req, res) => {
  await signOut();
  sendJson(res, 200, { account: null });
});

/* --------------------------------------------------------------------- keys */

/**
 * Only this computer may read or change keys. The app normally listens on
 * localhost and this is a no-op; anyone who binds it to a network address
 * gets a server whose keys still cannot be edited from another machine.
 */
function requireLocal(req: http.IncomingMessage): void {
  const from = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from)) {
    throw new HttpError(403, 'keys can only be changed from the computer the app runs on');
  }
}

route('GET', /^\/api\/keys$/, async (req, res) => {
  requireLocal(req);
  sendJson(res, 200, { keys: keyStates() });
});

route('PUT', /^\/api\/keys$/, async (req, res) => {
  requireLocal(req);
  // Signed out is fine here: with accounts on and a project that no longer
  // exists, this screen is the way back in. Being on this machine is the check.
  const body = (await readBody(req)) as Record<string, unknown>;
  let changed: string[];
  try {
    changed = saveKeys(body);
  } catch (error) {
    if (error instanceof KeyError) throw new HttpError(400, error.message);
    throw error;
  }
  if (changed.some((name) => name.startsWith('SUPABASE_'))) {
    resetSupabase();
    forgetSession();
  }
  if (changed.length > 0) log.info(`keys: updated ${changed.join(', ')}`);
  sendJson(res, 200, { changed, keys: keyStates(), accountsEnabled: supabaseConfigured() });
});

route('GET', /^\/api\/keys\/export$/, async (req, res) => {
  requireLocal(req);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': 'attachment; filename="breezematic-keys.env"',
    'Cache-Control': 'no-store',
  });
  res.end(exportKeys());
});

route('POST', /^\/api\/keys\/import$/, async (req, res) => {
  requireLocal(req);
  const body = (await readBody(req)) as Record<string, unknown>;
  const text = typeof body['text'] === 'string' ? body['text'] : '';
  let changed: string[];
  try {
    changed = saveKeys(parseKeysFile(text));
  } catch (error) {
    if (error instanceof KeyError) throw new HttpError(400, error.message);
    throw error;
  }
  if (changed.some((name) => name.startsWith('SUPABASE_'))) {
    resetSupabase();
    forgetSession();
  }
  if (changed.length > 0) log.info(`keys: imported ${changed.join(', ')}`);
  sendJson(res, 200, { changed, keys: keyStates(), accountsEnabled: supabaseConfigured() });
});

/**
 * Delete everything, by kind. Only from this computer, never while something
 * is being made (it would be writing into folders this removes), and only with
 * the phrase typed: a confirm box is one click, and this is the one action in
 * the app that cannot be taken back.
 */
route('POST', /^\/api\/reset$/, async (req, res) => {
  requireLocal(req);
  const body = (await readBody(req)) as Record<string, unknown>;
  if (String(body['confirm'] ?? '').trim().toLowerCase() !== 'delete everything') {
    throw new HttpError(400, 'type "delete everything" to confirm');
  }
  const kinds = (Array.isArray(body['kinds']) ? body['kinds'] : []).filter(isResetKind);
  if (kinds.length === 0) throw new HttpError(400, 'choose at least one thing to delete');
  if (activeRun() !== undefined || queuedRuns().length > 0) {
    throw new HttpError(409, 'a video is being made — stop it first, then delete');
  }
  const result = await resetEverything(kinds);
  if (kinds.includes('keys') || kinds.includes('channels')) {
    resetSupabase();
    forgetSession();
  }
  sendJson(res, 200, result);
});

route('GET', /^\/api\/preferences$/, async (_req, res) => {
  sendJson(res, 200, await readPreferences());
});

route('PUT', /^\/api\/preferences$/, async (req, res) => {
  const body = (await readBody(req)) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (body['theme'] === 'dark' || body['theme'] === 'light') patch['theme'] = body['theme'];
  if ((EFFECT_NAMES as readonly string[]).includes(body['effect'] as string)) {
    patch['effect'] = body['effect'];
  }
  if (typeof body['voice'] === 'string' && isCharacter(body['voice'])) {
    patch['voice'] = body['voice'];
  }
  if (Number.isInteger(body['variant'])) patch['variant'] = body['variant'];
  sendJson(res, 200, await writePreferences(patch));
});

route('GET', /^\/api\/projects$/, async (_req, res) => {
  sendJson(res, 200, { projects: await listProjects(), deviceId: DEVICE_ID });
});

/** Pulls a synced beat sheet down to this machine so it can be re-rendered. */
route('POST', /^\/api\/projects\/[a-z0-9-]+\/pull$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const raw = await fetchSheet(slug);
  if (raw === null) throw new HttpError(404, `no synced beat sheet for "${slug}"`);
  const sheet = parseBeatSheet(raw);
  writeJsonAtomic(beatSheetPath(slug), sheet);
  sendJson(res, 200, { sheet, findings: lintSheet(sheet) });
});

/** Extensions the music stage will pick up, so nothing else is worth storing. */
const TRACK_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus']);
const MAX_TRACK_BYTES = 40 * 1024 * 1024;

/**
 * Uploads land in assets/music, which is exactly where a file dropped by hand
 * would go — so an uploaded track is indistinguishable from one you copied in,
 * and the CLI sees it too.
 */
route('POST', /^\/api\/music$/, async (req, res, url) => {
  const raw = url.searchParams.get('name') ?? '';
  const name = path.basename(raw).replace(/[^A-Za-z0-9._ -]/g, '').trim();
  const extension = path.extname(name).toLowerCase();

  if (name === '' || name.startsWith('.') || !TRACK_EXT.has(extension)) {
    throw new HttpError(400, `name must be an audio file (${[...TRACK_EXT].join(' ')})`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_TRACK_BYTES) throw new HttpError(413, 'track is larger than 40 MB');
    chunks.push(chunk as Buffer);
  }
  if (total === 0) throw new HttpError(400, 'no audio in the request body');

  fs.mkdirSync(assetDirs.music, { recursive: true });
  const destination = path.join(assetDirs.music, name);
  // Written next to the target and renamed, so a half-uploaded file is never
  // visible to a plan run that starts mid-upload.
  const temporary = `${destination}.${process.pid}.part`;
  fs.writeFileSync(temporary, Buffer.concat(chunks));
  fs.renameSync(temporary, destination);

  let durationMs: number | null = null;
  try {
    durationMs = await probeDurationMs(destination);
  } catch {
    // Unreadable by ffprobe is worth reporting, but the file is still stored.
  }

  log.info(`music: stored ${name} (${(total / 1024 / 1024).toFixed(1)} MB)`);
  sendJson(res, 200, { name, durationMs, tracks: listTracks().map((track) => track.name) });
});

/** Duration for the start-point picker, without downloading the whole track. */
route('GET', /^\/api\/music\/[^/]+$/, async (_req, res, url) => {
  const name = path.basename(decodeURIComponent(url.pathname.split('/')[3] ?? ''));
  const track = listTracks().find((entry) => entry.name === name);
  if (track === undefined) throw new HttpError(404, `no track named "${name}"`);
  sendJson(res, 200, { name, durationMs: await probeDurationMs(path.resolve(ROOT, track.trackPath)) });
});

/* ---------------- media you supplied yourself ---------------- */

/**
 * Files dropped in for one video, which outrank every source the tool has.
 *
 * The tool will not go and fetch copyrighted frames or trailers, because doing
 * that automatically, inside a product other people are sold, makes a fair-use
 * judgement on behalf of strangers about scripts nobody has read. Handing the
 * folder over is the honest version of the same feature: whoever is publishing
 * the video decides what goes in it, which is where that decision belongs and
 * where every editor already makes it.
 */
const OWN_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif',
  '.mp4', '.webm', '.mov', '.m4v',
]);
const MAX_OWN_BYTES = 120 * 1024 * 1024;

route('GET', /^\/api\/own\/[a-z0-9-]+$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  sendJson(res, 200, {
    slug,
    dir: path.relative(ROOT, ownDir(slug)).split(path.sep).join('/'),
    files: listOwn(slug).map((file) => ({
      name: file.name,
      pinned: file.pinned,
      clip: file.clip,
      bytes: fs.statSync(file.source).size,
    })),
  });
});

route('POST', /^\/api\/own\/[a-z0-9-]+$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const raw = url.searchParams.get('name') ?? '';
  const name = path.basename(raw).replace(/[^A-Za-z0-9._ -]/g, '').trim();
  const extension = path.extname(name).toLowerCase();

  if (name === '' || name.startsWith('.') || !OWN_EXT.has(extension)) {
    throw new HttpError(400, `name must be an image or a clip (${[...OWN_EXT].join(' ')})`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_OWN_BYTES) throw new HttpError(413, 'file is larger than 120 MB');
    chunks.push(chunk as Buffer);
  }
  if (total === 0) throw new HttpError(400, 'no file in the request body');

  const dir = ownDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, name);
  // Written beside the target and renamed, so a run starting mid-upload never
  // sees a half-written picture.
  const temporary = `${destination}.${process.pid}.part`;
  fs.writeFileSync(temporary, Buffer.concat(chunks));
  fs.renameSync(temporary, destination);

  log.info(`own: stored ${slug}/${name} (${(total / 1024 / 1024).toFixed(1)} MB)`);
  sendJson(res, 200, { name, files: listOwn(slug).map((file) => file.name) });
});

route('POST', /^\/api\/own\/[a-z0-9-]+\/delete$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const body = (await readBody(req)) as Record<string, unknown>;
  const wanted = String(body['name'] ?? '');
  // Matched against the listing rather than trusted: the only names that can
  // be deleted are the ones this folder is already reporting.
  const file = listOwn(slug).find((entry) => entry.name === wanted);
  if (file === undefined) throw new HttpError(404, `no file named "${wanted}"`);
  fs.rmSync(file.source, { force: true });
  log.info(`own: removed ${slug}/${file.name}`);
  sendJson(res, 200, { files: listOwn(slug).map((entry) => entry.name) });
});

/* ---------------- what this has cost ---------------- */

route('GET', /^\/api\/spend$/, async (_req, res) => {
  sendJson(res, 200, spendSummary());
});

route('POST', /^\/api\/spend\/limits$/, async (req, res) => {
  const body = (await readBody(req)) as Record<string, unknown>;
  for (const field of ['dailyUsd', 'monthlyUsd'] as const) {
    const value = body[field];
    // Null is how a cap is removed, and it has to be distinguishable from
    // "left out", which is why this is checked rather than coerced.
    if (value !== null && value !== undefined && (typeof value !== 'number' || value <= 0)) {
      throw new HttpError(400, `${field} must be a positive number or null`);
    }
  }
  if (body['onExceed'] !== undefined && body['onExceed'] !== 'ask' && body['onExceed'] !== 'stop') {
    throw new HttpError(400, 'onExceed must be ask or stop');
  }
  writeLimits({
    dailyUsd: body['dailyUsd'] ?? null,
    monthlyUsd: body['monthlyUsd'] ?? null,
    onExceed: body['onExceed'] ?? 'ask',
  });
  // The whole summary back, because the limits changing is what makes the
  // numbers beside them mean something different.
  sendJson(res, 200, spendSummary());
});

/* ---------------- cloned voices ---------------- */

/**
 * A small library of voices, each one a recording somebody made.
 *
 * The clips are never served back. Every other asset here has a GET because
 * the page has to show it; a recording of a person's voice does not need to
 * travel anywhere except inside the request that reads a script, so it does
 * not get a route that would let it.
 */
const VOICE_UPLOAD_EXT = new Set([
  '.wav', '.mp3', '.m4a', '.flac', '.ogg', '.oga', '.webm',
]);
const MAX_VOICE_BYTES = 24 * 1024 * 1024;

/** A preview line, so a voice can be heard before a video is spent on it. */
const PREVIEW_TEXT =
  'This is how your videos will sound. Every line of the script, read in this voice.';

route('GET', /^\/api\/voices$/, async (_req, res) => {
  sendJson(res, 200, {
    available: cloneConfigured(),
    voices: listVoices().map((voice) => ({
      id: voice.id,
      name: voice.name,
      seconds: voice.seconds,
      createdMs: voice.createdMs,
    })),
    passages: READING_PASSAGES,
    usdPerPreview: env.CLONE_USD_PER_UNIT,
  });
});

route('POST', /^\/api\/voices$/, async (req, res, url) => {
  if (!cloneConfigured()) throw new HttpError(503, 'no fal key, so nothing can be cloned');

  const name = (url.searchParams.get('name') ?? '').trim().slice(0, 60) || 'Untitled voice';
  const extension = path.extname(url.searchParams.get('file') ?? '.wav').toLowerCase();
  if (!VOICE_UPLOAD_EXT.has(extension)) {
    throw new HttpError(400, `the recording must be audio (${[...VOICE_UPLOAD_EXT].join(' ')})`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_VOICE_BYTES) throw new HttpError(413, 'the recording is larger than 24 MB');
    chunks.push(chunk as Buffer);
  }
  if (total === 0) throw new HttpError(400, 'no audio in the request body');

  /**
   * Converted on arrival rather than stored as it came.
   *
   * A browser records webm/opus, a phone records m4a, and a dropped file is
   * whatever it is. Normalising once here means the provider only ever sees
   * one format, the duration is known, and a stray stereo 48k recording does
   * not quietly become a worse clone than a clean mono one.
   */
  fs.mkdirSync(dirs.cache, { recursive: true });
  const staged = path.join(dirs.cache, `voice-in-${process.pid}${extension}`);
  const converted = path.join(dirs.cache, `voice-out-${process.pid}.wav`);
  fs.writeFileSync(staged, Buffer.concat(chunks));

  try {
    await ffmpeg([
      '-i', staged,
      '-ac', '1',
      '-ar', '24000',
      // Level it and trim the dead air somebody leaves either side of a take.
      '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:' +
             'stop_duration=0.6:stop_threshold=-45dB,loudnorm=I=-18:TP=-2',
      converted,
    ]);
    const seconds = await probeDurationMs(converted).then((ms) => ms / 1000).catch(() => 0);
    if (seconds < 2) {
      throw new HttpError(400, 'that is under two seconds of speech — read a little more');
    }
    const voice = addVoice({ name, wav: fs.readFileSync(converted), seconds });
    sendJson(res, 200, { voice: { id: voice.id, name: voice.name, seconds: voice.seconds } });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `that recording could not be read (${(error as Error).message})`);
  } finally {
    fs.rmSync(staged, { force: true });
    fs.rmSync(converted, { force: true });
  }
});

route('POST', /^\/api\/voices\/[a-z0-9]+\/rename$/, async (req, res, url) => {
  const id = url.pathname.split('/')[3] ?? '';
  const body = (await readBody(req)) as Record<string, unknown>;
  const name = typeof body['name'] === 'string' ? body['name'] : '';
  if (name.trim() === '') throw new HttpError(400, 'name is required');
  const voice = renameVoice(id, name);
  if (voice === null) throw new HttpError(404, 'no voice with that id');
  sendJson(res, 200, { voice: { id: voice.id, name: voice.name, seconds: voice.seconds } });
});

route('POST', /^\/api\/voices\/[a-z0-9]+\/delete$/, async (_req, res, url) => {
  const id = url.pathname.split('/')[3] ?? '';
  if (!removeVoice(id)) throw new HttpError(404, 'no voice with that id');
  sendJson(res, 200, { voices: listVoices().map((voice) => ({ id: voice.id, name: voice.name })) });
});

/**
 * One line, read in a voice, sent back as audio.
 *
 * Metered like any other reading, which is why the page says what it costs
 * before it asks for one. Hearing the clone is the only way to know whether
 * the recording was good enough, and finding that out from a finished video is
 * the expensive way round.
 */
route('POST', /^\/api\/voices\/[a-z0-9]+\/preview$/, async (req, res, url) => {
  const id = url.pathname.split('/')[3] ?? '';
  const voice = findVoice(id);
  if (voice === null) throw new HttpError(404, 'no voice with that id');

  const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
  const text =
    typeof body['text'] === 'string' && body['text'].trim() !== ''
      ? body['text'].trim().slice(0, 300)
      : PREVIEW_TEXT;

  const wav = await cloneSpeak({ text, reference: clipPath(voice), seed: 7 });
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': String(wav.length),
    'Cache-Control': 'no-store',
  });
  res.end(wav);
});

route('GET', /^\/api\/series$/, async (_req, res) => {
  sendJson(res, 200, { series: listSeries() });
});

/**
 * Create or replace. The id comes from the name when one is not supplied, so
 * the page can post a new series without inventing an identifier and without a
 * round trip to ask for one.
 */
route('POST', /^\/api\/series$/, async (req, res) => {
  const body = (await readBody(req)) as Record<string, unknown>;
  const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
  if (name === '') throw new HttpError(400, 'a preset needs a name');

  const existing = listSeries();
  const id =
    typeof body['id'] === 'string' && body['id'] !== ''
      ? body['id']
      : idFor(name, existing.map((entry) => entry.id));

  try {
    const saved = putSeries({
      ...body,
      id,
      name,
      createdMs: existing.find((entry) => entry.id === id)?.createdMs ?? Date.now(),
    });
    sendJson(res, 200, { series: saved });
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
});

route('DELETE', /^\/api\/series\/[a-z0-9-]+$/, async (_req, res, url) => {
  const id = url.pathname.split('/')[3] ?? '';
  if (!deleteSeries(id)) throw new HttpError(404, `no preset "${id}"`);
  sendJson(res, 200, { deleted: id });
});

route('GET', /^\/api\/works$/, async (_req, res) => {
  sendJson(res, 200, { works: listWorks() });
});

/**
 * Deletes videos, one or many.
 *
 * POST rather than DELETE because a bulk delete needs a body and a DELETE with
 * one is unevenly supported all the way down the stack. One route serves both:
 * the single case is a list of one, and having two would mean two chances for
 * the guards below to drift apart.
 *
 * What goes: the working directory, the finished MP4s, and the project row in
 * the account. What stays: everything in .cache, which is content-addressed and
 * shared between projects — deleting one video's entries would take narration
 * and searches that other videos are still using.
 */
route('POST', /^\/api\/works\/delete$/, async (req, res) => {
  const body = (await readBody(req)) as { slugs?: unknown };
  const slugs = (Array.isArray(body.slugs) ? body.slugs : [])
    .filter((slug): slug is string => typeof slug === 'string')
    .map((slug) => requireSlug(slug));

  if (slugs.length === 0) throw new HttpError(400, 'nothing to delete');

  // A render in flight is writing into the directory this would remove.
  const busy = activeRun();
  if (busy !== undefined && slugs.includes(busy.slug)) {
    throw new HttpError(409, `"${busy.slug}" is being worked on right now`);
  }

  const deleted: string[] = [];
  const failed: { slug: string; reason: string }[] = [];

  for (const slug of slugs) {
    try {
      for (const target of [
        workDir(slug),
        path.join(dirs.out, `${slug}.mp4`),
        path.join(dirs.out, `${slug}-lore.mp4`),
      ]) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      await forgetProject(slug);
      deleted.push(slug);
      log.info(`deleted "${slug}"`);
    } catch (error) {
      failed.push({ slug, reason: (error as Error).message });
    }
  }

  sendJson(res, 200, { deleted, failed });
});

route('POST', /^\/api\/topics$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req)) as {
    count?: unknown;
    avoid?: unknown;
    category?: unknown;
    hint?: unknown;
  };
  const count = typeof body.count === 'number' && body.count >= 1 && body.count <= 12
    ? Math.floor(body.count)
    : 8;
  // What the page has already shown, so pressing again moves on rather than
  // circling the same handful of ideas.
  const avoid = Array.isArray(body.avoid)
    ? body.avoid.filter((topic): topic is string => typeof topic === 'string').slice(-24)
    : [];
  // An unknown category falls back rather than erroring: the list can change
  // under a page that is already open, and the honest answer to "a category I
  // no longer have" is a topic from anywhere, not a 400.
  const asked = typeof body.category === 'string' ? body.category : 'any';
  const category = CATEGORY_IDS.includes(asked) ? asked : 'any';
  // Capped rather than rejected: a long hint is someone pasting a paragraph,
  // and the useful part is always at the front of it.
  const hint = typeof body.hint === 'string' ? body.hint.slice(0, 200) : '';
  sendJson(res, 200, await suggestTopics(count, avoid, category, hint));
});

/**
 * The same shaping a plan run does to a pasted script, on its own, so the
 * writer can see what it will become and edit it before anything is spoken.
 */
route('POST', /^\/api\/script\/adapt$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req)) as { script?: unknown; force?: unknown; keepAll?: unknown };
  const script = typeof body.script === 'string' ? body.script : '';
  if (script.trim() === '') throw new HttpError(400, 'there is no script to prepare');
  if (script.length > 8000) throw new HttpError(400, 'script is too long (8000 characters max)');

  sendJson(res, 200, await adaptScript({ text: script, force: body.force === true, keepAll: body.keepAll === true }));
});

route('POST', /^\/api\/runs$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req)) as Record<string, unknown>;

  const kind = body['kind'];
  if (typeof kind !== 'string' || !RUN_KINDS.includes(kind as RunKind)) {
    throw new HttpError(400, `kind must be one of ${RUN_KINDS.join(' | ')}`);
  }
  const topic = typeof body['topic'] === 'string' ? body['topic'].trim() : '';
  if (topic === '') throw new HttpError(400, 'topic is required');

  const seed = body['seed'];
  if (seed !== undefined && (!Number.isInteger(seed) || (seed as number) < 0)) {
    throw new HttpError(400, 'seed must be a non-negative integer');
  }
  const variant = body['variant'];
  if (variant !== undefined && (!Number.isInteger(variant) || (variant as number) < 0 || (variant as number) > 9)) {
    throw new HttpError(400, 'variant must be between 0 and 9');
  }
  /**
   * "none" is what the Books screen sends when no effect is chosen, and it
   * means the same as leaving it out. It was rejected, so a Books run with
   * the effect set to None -- the natural setting for the cinematic look,
   * which does not use one -- could not be started at all.
   */
  const effect = body['effect'] === 'none' ? undefined : body['effect'];
  if (effect !== undefined && !(EFFECT_NAMES as readonly string[]).includes(effect as string)) {
    throw new HttpError(400, `effect must be one of ${EFFECT_NAMES.join(' | ')}`);
  }
  const music = body['music'];
  if (music !== undefined && typeof music !== 'string') {
    throw new HttpError(400, 'music must be a string');
  }
  const imagery = body['imagery'];
  if (imagery !== undefined && !(IMAGERY_MODES as readonly string[]).includes(imagery as string)) {
    throw new HttpError(400, `imagery must be one of ${IMAGERY_MODES.join(' | ')}`);
  }
  const imageSource = body['imageSource'];
  if (
    imageSource !== undefined &&
    !(IMAGE_SOURCES as readonly string[]).includes(imageSource as string)
  ) {
    throw new HttpError(400, `imageSource must be one of ${IMAGE_SOURCES.join(' | ')}`);
  }
  const imageCount = body['imageCount'];
  if (
    imageCount !== undefined &&
    (!Number.isInteger(imageCount) || (imageCount as number) < 1 || (imageCount as number) > 16)
  ) {
    throw new HttpError(400, 'imageCount must be between 1 and 16');
  }
  const style = body['style'];
  if (style !== undefined && !(STYLE_NAMES as readonly string[]).includes(style as string)) {
    throw new HttpError(400, `style must be one of ${STYLE_NAMES.join(' | ')}`);
  }
  const character = body['character'];
  if (character !== undefined && (typeof character !== 'string' || !isCharacter(character))) {
    throw new HttpError(400, `character must be one of ${CHARACTERS.map((c) => c.id).join(' | ')}`);
  }
  const mode = body['mode'];
  if (mode !== undefined && !(RENDER_MODES as readonly string[]).includes(mode as string)) {
    throw new HttpError(400, `mode must be one of ${RENDER_MODES.join(' | ')}`);
  }

  const oneOf = (name: string, allowed: readonly string[]) => {
    const value = body[name];
    if (value !== undefined && !allowed.includes(value as string)) {
      throw new HttpError(400, `${name} must be one of ${allowed.join(' | ')}`);
    }
    return value as string | undefined;
  };
  const boardThemeIn = oneOf('boardTheme', BOARD_THEMES);
  const boardContentIn = oneOf('boardContent', BOARD_CONTENTS);
  const boardImageryIn = oneOf('boardImagery', BOARD_IMAGERY);

  const brief = body['brief'];
  if (brief !== undefined && (typeof brief !== 'string' || brief.length > 2000)) {
    throw new HttpError(400, 'brief must be text under 2000 characters');
  }

  const boardTexture = body['boardTexture'];
  if (boardTexture !== undefined && typeof boardTexture !== 'boolean') {
    throw new HttpError(400, 'boardTexture must be true or false');
  }

  const captionScale = body['captionScale'];
  if (
    captionScale !== undefined &&
    (typeof captionScale !== 'number' ||
      !Number.isFinite(captionScale) ||
      captionScale < CAPTION_SCALE.min ||
      captionScale > CAPTION_SCALE.max)
  ) {
    throw new HttpError(
      400,
      `captionScale must be between ${CAPTION_SCALE.min} and ${CAPTION_SCALE.max}`,
    );
  }

  const musicLufs = body['musicLufs'];
  if (
    musicLufs !== undefined &&
    (typeof musicLufs !== 'number' ||
      !Number.isFinite(musicLufs) ||
      musicLufs < MUSIC_LUFS_MIN ||
      musicLufs > MUSIC_LUFS_MAX)
  ) {
    throw new HttpError(400, `musicLufs must be between ${MUSIC_LUFS_MIN} and ${MUSIC_LUFS_MAX}`);
  }
  for (const field of ['musicFadeInMs', 'musicFadeOutMs', 'musicStartMs'] as const) {
    const value = body[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new HttpError(400, `${field} must be a non-negative number`);
    }
  }
  const series = body['series'];
  if (series !== undefined && series !== null && typeof series !== 'string') {
    throw new HttpError(400, 'series must be a string or null');
  }
  const artStyle = body['artStyle'];
  if (artStyle !== undefined && !(ART_STYLES as readonly string[]).includes(artStyle as string)) {
    throw new HttpError(400, `artStyle must be one of ${ART_STYLES.join(' | ')}`);
  }
  const subtitles = body['subtitles'];
  if (subtitles !== undefined && !(SUBTITLE_MODES as readonly string[]).includes(subtitles as string)) {
    throw new HttpError(400, `subtitles must be one of ${SUBTITLE_MODES.join(' | ')}`);
  }
  /**
   * Which cues stay audible. An empty list is a real answer -- "no sound
   * effects at all" -- so it is only rejected for holding something that is
   * not a cue, never for being short.
   */
  const sfxCuesIn = body['sfxCues'];
  if (sfxCuesIn !== undefined) {
    if (
      !Array.isArray(sfxCuesIn) ||
      sfxCuesIn.some((cue) => !(SFX_CUES as readonly string[]).includes(cue as string))
    ) {
      throw new HttpError(400, `sfxCues must be a list of ${SFX_CUES.join(' | ')}`);
    }
  }

  const panelTexture = body['panelTexture'];
  if (panelTexture !== undefined && typeof panelTexture !== 'boolean') {
    throw new HttpError(400, 'panelTexture must be a boolean');
  }

  /**
   * Long form only. Minutes is the one option here that changes the bill by an
   * order of magnitude -- a twenty-minute read is twenty times the speech of a
   * one-minute short -- so it is bounded here as well as in the estimate.
   */
  const minutes = body['minutes'];
  if (minutes !== undefined && (!Number.isInteger(minutes) || (minutes as number) < 2 || (minutes as number) > 240)) {
    throw new HttpError(400, 'minutes must be a whole number between 2 and 240');
  }
  const bed = body['bed'];
  if (bed !== undefined && !(AMBIENCE_NAMES as readonly string[]).includes(bed as string)) {
    throw new HttpError(400, `bed must be one of ${AMBIENCE_NAMES.join(' | ')}`);
  }
  const generatedStill = body['generatedStill'];
  if (generatedStill !== undefined && typeof generatedStill !== 'boolean') {
    throw new HttpError(400, 'generatedStill must be a boolean');
  }

  const cloneVoice = body['cloneVoice'];
  if (cloneVoice !== undefined && (typeof cloneVoice !== 'string' || !/^[a-z0-9]{0,32}$/.test(cloneVoice))) {
    throw new HttpError(400, 'cloneVoice must be a voice id');
  }

  /**
   * A book essay carries two of its own: which vertical it is, and an optional
   * steer on the reading to argue. The vertical decides the shape of the
   * argument and the evidence it looks for, so an unknown one is refused
   * rather than defaulted -- picking "endings explained" for a banned-books
   * request would produce a competent essay about the wrong thing.
   */
  const vertical = body['vertical'];
  /**
   * Only when it is going to write something.
   *
   * The vertical decides the shape of an argument this is about to construct,
   * so it is required when the writer runs and meaningless when it does not --
   * a supplied script has already made every decision the vertical exists to
   * inform. Demanding one anyway refused perfectly good scripts.
   */
  const writing = typeof body['script'] !== 'string' || body['script'].trim() === '';
  if (kind === 'book' && writing) {
    if (typeof vertical !== 'string' || !(VERTICALS as readonly string[]).includes(vertical)) {
      throw new HttpError(400, `vertical must be one of ${VERTICALS.join(', ')}`);
    }
  }
  const angle = typeof body['angle'] === 'string' ? body['angle'].trim() : '';
  const direction = typeof body['direction'] === 'string' ? body['direction'].trim() : '';
  const bookTitle = typeof body['title'] === 'string' ? body['title'].trim() : '';
  const bookPictures = typeof body['pictures'] === 'string' ? body['pictures'] : '';
  const bookSound = typeof body['sound'] === 'string' ? body['sound'] : '';
  if (bookSound !== '' && !['none', 'sparse', 'full'].includes(bookSound)) {
    throw new HttpError(400, 'sound must be none, sparse or full');
  }
  /**
   * Clamped here as well as in the composer. The composer's clamp protects the
   * render; this one keeps a nonsense request out of the run record, so what
   * is stored is what actually happened.
   */
  const clamp = (value: unknown, low: number, high: number): number | undefined =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(high, Math.max(low, value))
      : undefined;
  const effectStrength = clamp(body['effectStrength'], 0, 1);
  /**
   * How many pictures to put under the essay.
   *
   * Capped at 240 rather than left open: each one is a Gemini prompt and a FLUX
   * call, so a slipped digit is a long wait and a real bill before anything
   * appears on screen. The old cap of eighty was itself the problem at length
   * -- eighty across twenty-five minutes is one every nineteen seconds, and
   * the format wants one every five to ten, so the ceiling silently overrode
   * the setting on exactly the videos this channel exists to make.
   */
  const pictureCount = clamp(body['pictureCount'], 1, 240);
  /**
   * How many subjects get cut out and pasted over the frame.
   *
   * Capped low on purpose, and lower than the picture count. A cutting works
   * because it interrupts; twelve of them across twenty minutes is roughly one
   * every ninety seconds, which is still frequent enough that the planner's
   * own minimum spacing usually binds first. Past that the interruption is
   * just the format.
   */
  const cutoutCount = clamp(body['cutoutCount'], 0, 12);
  /**
   * Its own field, not the shorts one.
   *
   * A short's captions are already most of the frame, so their scale is capped
   * at 1 and that cap is correct. An essay's narration is a lower-third
   * caption at 44 points and wants room to grow. Sharing one field meant the
   * tighter of the two limits won for both.
   */
  const essayCaptionScale = clamp(body['essayCaptionScale'], 0.6, 1.6);
  if (bookPictures !== '' && !['none', 'ai', 'stock'].includes(bookPictures)) {
    throw new HttpError(400, 'pictures must be none, ai or stock');
  }
  const punchStyle = typeof body['punchStyle'] === 'string' ? body['punchStyle'] : '';
  /**
   * Render size arrives as a preset rather than free numbers: the only sizes
   * worth offering are ones a platform wants, and a box accepting 1919 would
   * produce a file every encoder pads.
   */
  const SIZES: Record<string, { width: number; height: number }> = {
    '1080p': { width: 1920, height: 1080 },
    '720p': { width: 1280, height: 720 },
  };
  const size = SIZES[typeof body['size'] === 'string' ? body['size'] : '1080p'] ?? SIZES['1080p']!;
  const fps = body['fps'] === 24 || body['fps'] === 30 ? body['fps'] : undefined;

  const languageId = body['language'];
  if (languageId !== undefined && (typeof languageId !== 'string' || !isLanguage(languageId))) {
    throw new HttpError(400, `language must be one of ${LANGUAGES.join(', ')}`);
  }

  const ttsProvider = body['ttsProvider'];
  if (
    ttsProvider !== undefined &&
    ttsProvider !== 'kokoro' &&
    ttsProvider !== 'gemini' &&
    ttsProvider !== 'clone' &&
    ttsProvider !== 'elevenlabs'
  ) {
    throw new HttpError(400, 'ttsProvider must be kokoro, gemini, clone or elevenlabs');
  }
  const elevenVoice = body['elevenVoice'];
  if (elevenVoice !== undefined && (typeof elevenVoice !== 'string' || !/^[A-Za-z0-9]{0,40}$/.test(elevenVoice))) {
    throw new HttpError(400, 'elevenVoice must be an ElevenLabs voice id');
  }
  const tone = body['tone'];
  if (tone !== undefined && (typeof tone !== 'string' || !isTone(tone))) {
    throw new HttpError(400, `tone must be one of ${TONES.map((t) => t.id).join(' | ')}`);
  }
  const script = body['script'];
  if (script !== undefined && typeof script !== 'string') {
    throw new HttpError(400, 'script must be a string');
  }
  /**
   * A cap for shorts only, which have to fit in under a minute. A book essay
   * or a long lore video is as long as its script, and a twenty-minute essay
   * is twenty thousand characters -- capping it at eight refused every long
   * video before anything had been made.
   */
  if (typeof script === 'string' && kind !== 'book' && kind !== 'lore' && script.length > 8000) {
    throw new HttpError(400, 'script is too long for a short (8000 characters max)');
  }

  /**
   * The budget check, before anything is spent rather than after.
   *
   * Stopping a run halfway leaves a video that cost money and does not exist,
   * so this happens here or not at all. A refusal is a 402 carrying everything
   * the page needs to offer a way forward -- what was spent, what the cap is,
   * what this run would have cost, and which of its settings have a free
   * equivalent -- because "over budget" on its own is a dead end.
   *
   * `acceptCost` is the page saying the person has seen that and wants it
   * anyway. It is only honoured when the limit is set to ask; a limit set to
   * stop is a limit.
   */
  const estimate = estimateRun({
    kind: kind as string,
    ...(typeof minutes === 'number' ? { minutes } : {}),
    ...(generatedStill === true ? { generatedStill: true } : {}),
    ...(mode !== undefined ? { mode: mode as string } : {}),
    ...(imageSource !== undefined ? { imageSource: imageSource as string } : {}),
    ...(typeof imageCount === 'number' ? { imageCount } : {}),
    /**
     * The reader the language will actually allow, not the one that was asked
     * for. Hindi has no free reader, so an estimate that priced the requested
     * kokoro at nothing would under-quote every Hindi video -- and the whole
     * point of the estimate is to be right before the money moves.
     */
    ttsProvider: readerFor(
      typeof languageId === 'string' ? languageId : 'en',
      ttsProvider as string | undefined,
    ),
    usdPerImage: env.FLUX_USD_PER_IMAGE,
    defaultImages: env.FLUX_IMAGES,
  });
  const verdict = checkBudget(estimate.usd);
  const accepted = body['acceptCost'] === true && verdict.onExceed === 'ask';
  if (!verdict.ok && !accepted) {
    throw new HttpError(402, 'this run would go over the spending limit', {
      budget: verdict,
      estimate,
      free: freeAlternative({
        ...(mode !== undefined ? { mode: mode as string } : {}),
        ...(imageSource !== undefined ? { imageSource: imageSource as string } : {}),
        ...(ttsProvider !== undefined ? { ttsProvider: ttsProvider as string } : {}),
      }),
    });
  }

  const run = startRun({
    kind: kind as RunKind,
    topic,
    ...(typeof languageId === 'string' ? { language: languageId } : {}),
    ...(typeof vertical === 'string' ? { vertical } : {}),
    ...(angle === '' ? {} : { angle }),
    ...(direction === '' ? {} : { direction }),
    ...(bookTitle === '' ? {} : { title: bookTitle }),
    ...(bookPictures === '' ? {} : { pictures: bookPictures }),
    ...(pictureCount === undefined ? {} : { pictureCount: Math.round(pictureCount) }),
    ...(cutoutCount === undefined ? {} : { cutoutCount: Math.round(cutoutCount) }),
    ...(body['imageEngine'] === 'flux' ||
    body['imageEngine'] === 'gemini' ||
    body['imageEngine'] === 'mixed'
      ? { imageEngine: body['imageEngine'] as string }
      : {}),
    ...(body['look'] === 'cinematic' || body['look'] === 'storybook' || body['look'] === 'stickman'
      ? { look: body['look'] as string }
      : {}),
    ...(body['stickWorld'] === 'ai' || body['stickWorld'] === 'drawn' ? { stickWorld: body['stickWorld'] as string } : {}),
    ...(isPictureStyle(body['pictureStyle']) ? { pictureStyle: body['pictureStyle'] } : {}),
    // Both on unless explicitly switched off.
    ...(body['chapters'] === 'auto' || body['chapters'] === 'off' || body['chapters'] === 'script'
      ? { chapters: body['chapters'] as string }
      : {}),
    ...(body['parallax'] === false ? { parallax: false } : {}),
    ...(body['realSources'] === false ? { realSources: false } : {}),
    ...(bookSound === '' ? {} : { sound: bookSound }),
    ...(effectStrength === undefined ? {} : { effectStrength }),
    ...(essayCaptionScale === undefined ? {} : { essayCaptionScale }),
    ...(punchStyle === '' ? {} : { punchStyle }),
    ...(kind === 'book' ? { width: size.width, height: size.height } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(seed !== undefined ? { seed: seed as number } : {}),
    ...(typeof script === 'string' && script.trim() !== '' ? { script } : {}),
    ...(body['adapt'] === false ? { adapt: false } : {}),
    ...(body['keepAll'] === true ? { keepAll: true } : {}),
    ...(character !== undefined ? { character: character as string } : {}),
    ...(ttsProvider !== undefined ? { ttsProvider: ttsProvider as string } : {}),
    ...(subtitles !== undefined ? { subtitles: subtitles as SubtitleMode } : {}),
    ...(sfxCuesIn !== undefined ? { sfxCues: [...new Set(sfxCuesIn as SfxCue[])] } : {}),
    ...(typeof panelTexture === 'boolean' ? { panelTexture } : {}),
    ...(typeof cloneVoice === 'string' && cloneVoice !== '' ? { cloneVoice } : {}),
    ...(typeof elevenVoice === 'string' && elevenVoice !== '' ? { elevenVoice } : {}),
    ...(typeof minutes === 'number' ? { minutes } : {}),
    ...(typeof bed === 'string' ? { bed } : {}),
    ...(typeof generatedStill === 'boolean' ? { generatedStill } : {}),
    ...(artStyle !== undefined ? { artStyle: artStyle as ArtStyle } : {}),
    ...(body['stickWorld'] === 'ai' || body['stickWorld'] === 'drawn' ? { stickWorld: body['stickWorld'] as string } : {}),
    ...(body['niche'] === 'war' || body['niche'] === 'books' ? { niche: body['niche'] as string } : {}),
    ...(typeof body['typewriter'] === 'boolean' ? { typewriter: body['typewriter'] } : {}),
    ...(typeof body['warSfx'] === 'boolean' ? { warSfx: body['warSfx'] } : {}),
    ...(typeof body['warSfxDb'] === 'number' && Number.isFinite(body['warSfxDb'])
      ? { warSfxDb: Math.max(-24, Math.min(12, Math.round(body['warSfxDb'] as number))) }
      : {}),
    ...(body['stickFinish'] === 'cinematic' || body['stickFinish'] === 'plain' ? { stickFinish: body['stickFinish'] as string } : {}),
    ...(series !== undefined ? { series: series as string | null } : {}),
    ...(effect !== undefined ? { effect: effect as EffectName } : {}),
    ...(typeof music === 'string' && music !== '' ? { music } : {}),
    ...(typeof musicLufs === 'number' ? { musicLufs } : {}),
    ...(typeof captionScale === 'number' ? { captionScale } : {}),
    ...(mode !== undefined ? { mode: mode as RenderMode } : {}),
    ...(typeof boardTexture === 'boolean' ? { boardTexture } : {}),
    ...(boardThemeIn !== undefined ? { boardTheme: boardThemeIn as BoardTheme } : {}),
    ...(boardContentIn !== undefined ? { boardContent: boardContentIn as BoardContent } : {}),
    ...(boardImageryIn !== undefined ? { boardImagery: boardImageryIn as BoardImagery } : {}),
    ...(typeof brief === 'string' && brief.trim() !== '' ? { brief: brief.trim() } : {}),
    ...(typeof body['musicFadeInMs'] === 'number' ? { musicFadeInMs: body['musicFadeInMs'] } : {}),
    ...(typeof body['musicFadeOutMs'] === 'number' ? { musicFadeOutMs: body['musicFadeOutMs'] } : {}),
    ...(typeof body['musicStartMs'] === 'number' ? { musicStartMs: body['musicStartMs'] } : {}),
    ...(typeof tone === 'string' ? { tone } : {}),
    ...(imagery !== undefined ? { imagery: imagery as ImageryMode } : {}),
    ...(imageSource !== undefined ? { imageSource: imageSource as ImageSource } : {}),
    ...(imageCount !== undefined ? { imageCount: imageCount as number } : {}),
    ...(style !== undefined ? { style: style as StyleName } : {}),
    variant: (variant as number | undefined) ?? 0,
    force: body['force'] === true,
  });
  sendJson(res, 202, { run });
});

/**
 * Stops a run, or pauses it.
 *
 * "Pause" is a stop that keeps its place: the run goes back to the front of
 * the queue and picks up from the cache when it comes round again. There is no
 * freezing a Remotion render or a request in flight, so this is the honest
 * version of the feature rather than a button that pretends.
 */
route('POST', /^\/api\/runs\/([0-9a-f-]+)\/stop$/, async (req, res, url) => {
  const id = url.pathname.split('/')[3] ?? '';
  const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
  const stopped = cancelRun(id, body['pause'] === true);
  if (stopped === null) throw new HttpError(404, 'that run is not queued or running');
  sendJson(res, 200, { run: stopped, queue: queuedRuns(), paused: pausedRuns() });
});

route('GET', /^\/api\/runs$/, async (_req, res) => {
  sendJson(res, 200, {
    /**
     * A render started from the editor is not a run -- it never touches the
     * queue -- but it is the machine being busy, and every screen should be
     * able to say so. Without this the app looked idle for twenty minutes
     * while it was drawing sixteen thousand frames.
     */
    editor:
      editorJob !== null && (editorJob.stage === 'render' || editorJob.stage === 'mix')
        ? editorJob
        : null,
    active: activeRun() ?? null,
    queue: queuedRuns(),
    paused: pausedRuns(),
  });
});

route('POST', /^\/api\/runs\/([0-9a-f-]+)\/resume$/, async (_req, res, url) => {
  const id = url.pathname.split('/')[3] ?? '';
  const run = resumeRun(id);
  if (run === null) throw new HttpError(404, 'that run is not paused');
  sendJson(res, 200, { run, queue: queuedRuns(), paused: pausedRuns() });
});

route('GET', /^\/api\/runs\/([0-9a-f-]+)\/events$/, async (req, res, url) => {
  const id = url.pathname.split('/')[3] ?? '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':connected\n\n');

  const off = subscribe(id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  if (off === undefined) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: `unknown run ${id}` })}\n\n`);
    res.end();
    return;
  }

  const ping = setInterval(() => res.write(':ping\n\n'), SSE_PING_MS);
  req.on('close', () => {
    clearInterval(ping);
    off();
  });
});

route('GET', /^\/api\/sheet\/[a-z0-9-]+$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const file = beatSheetPath(slug);
  if (!fs.existsSync(file)) throw new HttpError(404, `no beat sheet for "${slug}"`);
  const sheet = parseBeatSheet(readJson(file));
  sendJson(res, 200, { sheet, findings: lintSheet(sheet) });
});

route('PUT', /^\/api\/sheet\/[a-z0-9-]+$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const sheet = parseBeatSheet(await readBody(req));
  if (sheet.meta.slug !== slug) {
    throw new HttpError(422, `sheet says slug "${sheet.meta.slug}" but was saved to "${slug}"`);
  }
  writeJsonAtomic(beatSheetPath(slug), sheet);
  sendJson(res, 200, { findings: lintSheet(sheet) });
});

route('GET', /^\/api\/stills\/[a-z0-9-]+$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  sendJson(res, 200, { stills: listStills(slug) });
});

route('GET', /^\/api\/stills\/[a-z0-9-]+\/[a-z0-9.-]+$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const file = path.basename(url.pathname.split('/')[4] ?? '');
  if (!STILL_RE.test(file)) throw new HttpError(400, `invalid still name "${file}"`);
  sendFile(res, path.join(workDir(slug), 'stills', file), 'image/png');
});

route('GET', /^\/api\/video\/[a-z0-9-]+$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  // Long-form writes its own file name, so the library asks for it by name
  // rather than the app guessing which of the two exists.
  /**
   * Which of the three files, asked for by name rather than guessed.
   *
   * Shorts write `<slug>.mp4`, long form `<slug>-lore.mp4`, and book essays
   * `<slug>-essay.mp4`. The route knew the first two, so a finished essay was
   * served a 404 for a short that does not exist -- the file was on disk and
   * there was no way to ask for it.
   */
  const kind = url.searchParams.get('v') ?? (url.searchParams.get('lore') === '1' ? 'lore' : '');
  const suffix = kind === 'lore' ? '-lore' : kind === 'essay' ? '-essay' : '';
  sendVideo(req, res, path.join(dirs.out, `${slug}${suffix}.mp4`));
});

/* ------------------------------------------------------------- publishing */

/**
 * A nonce tying the redirect Google sends back to the browser that started it,
 * so a link someone else crafted cannot attach their channel to this install.
 */
/**
 * Every connect started in the last quarter of an hour, not just the latest.
 * One slot meant a second click -- or a second tab -- threw away the first,
 * and finishing the first on Google then failed as a "state mismatch".
 */
const pendingOAuthStates = new Map<string, number>();
const OAUTH_STATE_MS = 15 * 60_000;

/** The address Google must redirect back to, taken from how this page was reached. */
function callbackUrl(req: http.IncomingMessage): string {
  const host = req.headers.host ?? `localhost:${env.BREEZEMATIC_APP_PORT}`;
  return `http://${host}/api/youtube/callback`;
}

route('GET', /^\/api\/youtube\/status$/, async (req, res) => {
  const connection = youtube.readConnection();
  const client = youtube.readClientConfig();
  sendJson(res, 200, {
    configured: client !== null,
    // Only ever the tail of the id, never the secret.
    clientIdHint: client === null ? null : client.clientId.slice(0, 12) + '…',
    editable: client === null || client.source === 'app',
    redirectUri: client?.redirectUri ?? callbackUrl(req),
    suggestedRedirectUri: callbackUrl(req),
    connected: connection !== null,
    // The default channel, as before, so an older page still reads it right.
    channelTitle: connection?.channelTitle ?? null,
    channelId: connection?.channelId ?? null,
    // Every connected channel, the default first.
    channels: youtube.listConnections().map((c, index) => ({
      id: c.channelId,
      title: c.channelTitle ?? c.channelId ?? 'channel',
      isDefault: index === 0,
      canComment: youtube.canComment(c),
    })),
    defaultPrivacy: env.YOUTUBE_PRIVACY,
  });
});

route('PUT', /^\/api\/youtube\/config$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req)) as Record<string, unknown>;

  const clientId = typeof body['clientId'] === 'string' ? body['clientId'].trim() : '';
  const clientSecret = typeof body['clientSecret'] === 'string' ? body['clientSecret'].trim() : '';
  const redirectUri =
    typeof body['redirectUri'] === 'string' && body['redirectUri'].trim() !== ''
      ? body['redirectUri'].trim()
      : callbackUrl(req);

  if (clientId === '' || clientSecret === '') {
    throw new HttpError(400, 'both the client ID and the client secret are required');
  }
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    throw new HttpError(400, 'that does not look like a client ID — it ends in .apps.googleusercontent.com');
  }
  if (!/^https?:\/\//.test(redirectUri)) {
    throw new HttpError(400, 'the redirect URL must start with http:// or https://');
  }

  youtube.writeClientConfig({ clientId, clientSecret, redirectUri });
  log.info('youtube: OAuth client saved');
  sendJson(res, 200, { configured: true, redirectUri });
});

route('DELETE', /^\/api\/youtube\/config$/, async (_req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  await youtube.disconnect();
  youtube.writeClientConfig(null);
  sendJson(res, 200, { configured: false });
});

route('POST', /^\/api\/youtube\/connect$/, async (_req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  if (!youtube.isConfigured()) {
    throw new HttpError(400, 'publishing is not set up on this machine');
  }
  const state = crypto.randomUUID();
  for (const [key, at] of pendingOAuthStates) if (Date.now() - at > OAUTH_STATE_MS) pendingOAuthStates.delete(key);
  pendingOAuthStates.set(state, Date.now());
  sendJson(res, 200, { url: youtube.authorizeUrl(state) });
});

route('GET', /^\/api\/youtube\/callback$/, async (_req, res, url) => {
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // Said in the server's log as well as on the page: the page is gone the
  // moment somebody reloads it, and "it didn't connect" needs a record.
  const back = (message: string): void => {
    (message.startsWith('connected') ? log.info : log.warn)(`youtube: connect -- ${message}`);
    res.writeHead(302, { Location: `/app?youtube=${encodeURIComponent(message)}` });
    res.end();
  };

  if (error !== null) {
    return back(
      error === 'access_denied'
        ? 'not connected: Google refused access. If this is a new Gmail, add it as a test user ' +
            '(Google Cloud → OAuth consent screen → Test users) and try again'
        : `not connected: ${error}`,
    );
  }
  if (code === null) return back('not connected: Google returned no code');
  const started = state === null ? undefined : pendingOAuthStates.get(state);
  if (state === null || started === undefined || Date.now() - started > OAUTH_STATE_MS) {
    return back('not connected: that sign-in was started too long ago, or before the app restarted — click Connect again');
  }
  pendingOAuthStates.delete(state);

  try {
    const connection = await youtube.connectWithCode(code);
    // Reconnecting a channel on purpose -- to grant a new permission -- is a
    // success, and says so; only a reconnect that changed nothing is the
    // "you picked the same account" case.
    back(
      connection.already
        ? youtube.canComment(connection)
          ? `connected: ${connection.channelTitle ?? 'channel'} — reconnected, and it can post comments now`
          : `already connected: ${connection.channelTitle ?? 'channel'}. To add a different channel, ` +
            'click Connect another channel and choose "Use another account" on Google\'s screen'
        : `connected: ${connection.channelTitle ?? 'channel'}`,
    );
  } catch (failure) {
    back(`not connected: ${failure instanceof Error ? failure.message : 'connection failed'}`);
  }
});

/** Disconnect one channel -- the one named, or the default -- and leave the others. */
route('POST', /^\/api\/youtube\/disconnect$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
  const channelId = typeof body['channelId'] === 'string' && body['channelId'] !== '' ? body['channelId'] : undefined;
  await youtube.disconnect(channelId);
  sendJson(res, 200, { connected: youtube.isConnected(), channels: youtube.listConnections().length });
});

/** Which channel an upload goes to when it does not say. */
route('POST', /^\/api\/youtube\/default$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req)) as Record<string, unknown>;
  const channelId = typeof body['channelId'] === 'string' ? body['channelId'] : '';
  if (!youtube.isConnected(channelId)) throw new HttpError(404, 'that channel is not connected');
  youtube.setActiveChannel(channelId);
  sendJson(res, 200, { channelId });
});

/** What would be sent, without sending it. */
route('POST', /^\/api\/youtube\/preview$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req)) as Record<string, unknown>;
  const slug = requireSlug(typeof body['slug'] === 'string' ? body['slug'] : '');

  // An essay or a long reading has no beat sheet; its metadata is written from
  // its prose instead, chapters and all.
  if (isLongKind(body['kind'])) {
    const described = await describeLong(slug, body['kind']);
    sendJson(res, 200, {
      metadata: longYouTubeMetadata(described, publishOverrides(body)),
      eligibility: checkEligibility(await probeVideo(described.file)),
      sizeBytes: fs.statSync(described.file).size,
      chapters: described.chapters,
      comment: described.comment,
    });
    return;
  }

  const sheet = parseBeatSheet(readJson(beatSheetPath(slug)));
  const file = renderedFile(slug);

  if (!fs.existsSync(file)) throw new HttpError(409, 'render the video before publishing it');

  const eligibility = checkEligibility(await probeVideo(file));
  // The subject, not the working title: "(short)" and "v3" are how the topic
  // was told apart from its other versions, and they send a search elsewhere.
  const subject = sheet.meta.topic.replace(/\(.*?\)/g, ' ').replace(/\bv\d+\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const reference = (await referencesFor(slug, [subject]).catch(() => []))[0];
  sendJson(res, 200, {
    metadata: await buildMetadata(sheet, publishOverrides(body)),
    eligibility,
    sizeBytes: fs.statSync(file).size,
    comment: firstComment({ reference, war: sheet.beats.some((beat) => beat.stage?.war !== undefined) }),
  });
});

/** A Short's vertical thumbnail, for the publish card. */
route('GET', /^\/api\/short-thumb\/[a-z0-9-]+$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const file = shortThumbPath(slug);
  if (!fs.existsSync(file)) throw new HttpError(404, 'no thumbnail yet');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});

/** Another thumbnail for a Short: a different moment, different words. */
route('POST', /^\/api\/short-thumb\/[a-z0-9-]+$/, async (_req, res, url) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const sheet = parseBeatSheet(readJson(beatSheetPath(slug)));
  shortThumbVariants.set(slug, (shortThumbVariants.get(slug) ?? 0) + 1);
  const file = await makeShortThumbnail(sheet, { variant: shortThumbVariants.get(slug)!, replaceCustom: true });
  if (file === null) throw new HttpError(409, 'only a stick figure Short gets a drawn thumbnail');
  sendJson(res, 200, { ok: true });
});
const shortThumbVariants = new Map<string, number>();

/** The first comment, when the page sends one. */
function firstCommentOf(body: Record<string, unknown>): { comment?: string } {
  const comment = body['comment'];
  return typeof comment === 'string' && comment.trim() !== '' ? { comment: comment.slice(0, 9000) } : {};
}

/** The categories the page offers. Anything else is ignored rather than sent. */
const YOUTUBE_CATEGORIES = new Set(['1', '22', '23', '24', '27', '28']);

function publishOverrides(body: Record<string, unknown>): {
  privacyStatus?: 'private' | 'unlisted' | 'public';
  title?: string;
  description?: string;
  categoryId?: string;
} {
  const privacy = body['privacyStatus'];
  const title = body['title'];
  const description = body['description'];
  const category = body['categoryId'];
  return {
    ...(typeof category === 'string' && YOUTUBE_CATEGORIES.has(category) ? { categoryId: category } : {}),
    ...(privacy === 'private' || privacy === 'unlisted' || privacy === 'public'
      ? { privacyStatus: privacy }
      : {}),
    ...(typeof title === 'string' && title.trim() !== '' ? { title: title.trim() } : {}),
    ...(typeof description === 'string' && description.trim() !== ''
      ? { description: description.trim() }
      : {}),
  };
}

route('POST', /^\/api\/youtube\/upload$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');

  const body = (await readBody(req)) as Record<string, unknown>;
  /**
   * Which channel, said by the page. A channel it names that is not connected
   * is refused rather than quietly swapped for the default: the war video
   * going up on the books channel is not a fallback, it is the accident.
   */
  const channelId = typeof body['channelId'] === 'string' && body['channelId'] !== '' ? body['channelId'] : undefined;
  if (!youtube.isConnected(channelId)) {
    throw new HttpError(409, channelId === undefined ? 'no channel is connected' : 'that channel is no longer connected — connect it again');
  }
  const slug = requireSlug(typeof body['slug'] === 'string' ? body['slug'] : '');

  // The page has to say so explicitly. An upload cannot be taken back, only
  // deleted afterwards, so it is never the default outcome of a request.
  if (body['confirm'] !== true) throw new HttpError(400, 'confirm must be true to upload');

  if (isLongKind(body['kind'])) {
    sendJson(res, 200, await publishLongToYouTube({ slug, kind: body['kind'], ...publishOverrides(body), ...(channelId === undefined ? {} : { channelId }), ...firstCommentOf(body) }));
    return;
  }

  const sheet = parseBeatSheet(readJson(beatSheetPath(slug)));
  const result = await publishToYouTube({ sheet, ...publishOverrides(body), ...(channelId === undefined ? {} : { channelId }), ...firstCommentOf(body) });
  sendJson(res, 200, result);
});

/* --------------------------------------------------------------- facebook */

/**
 * The same shape as the YouTube routes next door, with one extra step in the
 * middle: a Google account has one channel, a Facebook account can admin any
 * number of Pages, so connecting and choosing where to post are two separate
 * decisions and two separate routes.
 */
let pendingFacebookState: string | null = null;

function facebookCallbackUrl(req: http.IncomingMessage): string {
  const host = req.headers.host ?? `localhost:${env.BREEZEMATIC_APP_PORT}`;
  return `http://${host}/api/facebook/callback`;
}

route('GET', /^\/api\/facebook\/status$/, async (req, res) => {
  const connection = facebook.readConnection();
  const client = facebook.readClientConfig();
  sendJson(res, 200, {
    configured: client !== null,
    // Only ever the head of the app id, never the secret.
    appIdHint: client === null ? null : client.appId.slice(0, 8) + '…',
    editable: client === null || client.source === 'app',
    redirectUri: client?.redirectUri ?? facebookCallbackUrl(req),
    suggestedRedirectUri: facebookCallbackUrl(req),
    signedIn: connection !== null,
    connected: facebook.isConnected(),
    page: facebook.connectedPage(),
    defaultPublished: env.FACEBOOK_PUBLISHED,
  });
});

route('PUT', /^\/api\/facebook\/config$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req)) as Record<string, unknown>;

  const appId = typeof body['appId'] === 'string' ? body['appId'].trim() : '';
  const appSecret = typeof body['appSecret'] === 'string' ? body['appSecret'].trim() : '';
  const redirectUri =
    typeof body['redirectUri'] === 'string' && body['redirectUri'].trim() !== ''
      ? body['redirectUri'].trim()
      : facebookCallbackUrl(req);

  if (appId === '' || appSecret === '') {
    throw new HttpError(400, 'both the app id and the app secret are needed');
  }
  facebook.writeClientConfig({ appId, appSecret, redirectUri });
  log.info('facebook: Meta app saved');
  sendJson(res, 200, { configured: true });
});

route('DELETE', /^\/api\/facebook\/config$/, async (_req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  await facebook.disconnect();
  facebook.writeClientConfig(null);
  sendJson(res, 200, { configured: false, connected: false });
});

route('POST', /^\/api\/facebook\/connect$/, async (_req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  if (!facebook.isConfigured()) {
    throw new HttpError(400, 'the Meta app is not set up on this machine');
  }
  pendingFacebookState = crypto.randomUUID();
  sendJson(res, 200, { url: facebook.authorizeUrl(pendingFacebookState) });
});

route('GET', /^\/api\/facebook\/callback$/, async (_req, res, url) => {
  const back = (message: string): void => {
    res.writeHead(302, { Location: `/app?facebook=${encodeURIComponent(message)}` });
    res.end();
  };

  const state = url.searchParams.get('state');
  // The nonce ties the redirect to the browser that started it, so a link
  // somebody else crafted cannot attach their Page to this install.
  if (state === null || state !== pendingFacebookState) return back('the sign-in did not match');
  pendingFacebookState = null;

  const code = url.searchParams.get('code');
  if (code === null) return back(url.searchParams.get('error_description') ?? 'no code came back');

  try {
    const connection = await facebook.connectWithCode(code);
    back(
      connection.pageName === null
        ? 'connected — now choose a Page'
        : `connected: ${connection.pageName}`,
    );
  } catch (failure) {
    back(failure instanceof Error ? failure.message : 'connection failed');
  }
});

route('GET', /^\/api\/facebook\/pages$/, async (_req, res) => {
  if (facebook.readConnection() === null) throw new HttpError(409, 'not signed in to Facebook');
  sendJson(res, 200, { pages: await facebook.listPages(), selected: facebook.connectedPage() });
});

route('POST', /^\/api\/facebook\/page$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req)) as Record<string, unknown>;
  const pageId = typeof body['pageId'] === 'string' ? body['pageId'] : '';
  if (pageId === '') throw new HttpError(400, 'pageId is required');
  const connection = await facebook.selectPage(pageId);
  sendJson(res, 200, { page: { id: connection.pageId, name: connection.pageName } });
});

route('POST', /^\/api\/facebook\/disconnect$/, async (_req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  await facebook.disconnect();
  sendJson(res, 200, { connected: false });
});

function facebookOverrides(body: Record<string, unknown>): {
  published?: boolean;
  title?: string;
  description?: string;
} {
  return {
    ...(typeof body['published'] === 'boolean' ? { published: body['published'] } : {}),
    ...(typeof body['title'] === 'string' && body['title'].trim() !== ''
      ? { title: body['title'].trim() }
      : {}),
    ...(typeof body['description'] === 'string' && body['description'].trim() !== ''
      ? { description: body['description'].trim() }
      : {}),
  };
}

route('POST', /^\/api\/facebook\/preview$/, async (req, res) => {
  const body = (await readBody(req)) as Record<string, unknown>;
  const slug = requireSlug(typeof body['slug'] === 'string' ? body['slug'] : '');

  if (isLongKind(body['kind'])) {
    const described = await describeLong(slug, body['kind']);
    const longProbe = await probeVideo(described.file);
    sendJson(res, 200, {
      metadata: longFacebookMetadata(described, facebookOverrides(body)),
      probe: longProbe,
      page: facebook.connectedPage(),
      couldBeReel: longProbe.durationMs <= 90_000 && longProbe.height > longProbe.width,
    });
    return;
  }

  const file = renderedFile(slug);
  if (!fs.existsSync(file)) throw new HttpError(409, 'render the video before publishing it');

  const sheet = parseBeatSheet(readJson(beatSheetPath(slug)));
  const probe = await probeVideo(file);
  sendJson(res, 200, {
    metadata: buildFacebookMetadata(sheet, facebookOverrides(body)),
    probe,
    page: facebook.connectedPage(),
    // Said so the form can offer it, not so the upload can refuse.
    couldBeReel: probe.durationMs <= 90_000 && probe.height > probe.width,
  });
});

route('POST', /^\/api\/facebook\/upload$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  if (!facebook.isConnected()) throw new HttpError(409, 'no Page is connected');

  const body = (await readBody(req)) as Record<string, unknown>;
  const slug = requireSlug(typeof body['slug'] === 'string' ? body['slug'] : '');

  // The page has to say so explicitly. A post cannot be taken back, only
  // deleted afterwards, so it is never the default outcome of a request.
  if (body['confirm'] !== true) throw new HttpError(400, 'confirm must be true to upload');

  if (isLongKind(body['kind'])) {
    sendJson(res, 200, await publishLongToFacebook({ slug, kind: body['kind'], ...facebookOverrides(body) }));
    return;
  }

  const sheet = parseBeatSheet(readJson(beatSheetPath(slug)));
  const result = await publishToFacebook({ sheet, ...facebookOverrides(body) });
  sendJson(res, 200, result);
});

/* ------------------------------------------------------------------ music */

/**
 * Removing a track. Uploading one is handled above, where it always was.
 */
route('DELETE', /^\/api\/music\/.+$/, async (_req, res, url) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  // Resolved and checked, not merely joined: the name came off a URL.
  const file = path.resolve(assetDirs.music, name);
  if (!file.startsWith(path.resolve(assetDirs.music) + path.sep) || !fs.existsSync(file)) {
    throw new HttpError(404, `no track called ${name}`);
  }
  fs.rmSync(file, { force: true });
  log.info(`music: removed ${name}`);
  sendJson(res, 200, { tracks: listTracks().map((track) => track.name) });
});

/* ----------------------------------------------------------------- drafts */

/**
 * Half-written videos, kept.
 *
 * A twenty-five minute essay is written over more than one sitting, and until
 * now closing the tab lost the script, the direction and every setting chosen
 * with them. Stored on the machine rather than in the browser because the
 * script is the valuable part and browser storage is cleared by things nobody
 * remembers doing.
 */
const DRAFTS_FILE = (): string => path.join(dirs.work, 'drafts.json');

type Draft = { id: string; title: string; savedAt: string; body: Record<string, unknown> };

function readDrafts(): Draft[] {
  try {
    const raw = readJson(DRAFTS_FILE()) as { drafts?: Draft[] };
    return Array.isArray(raw.drafts) ? raw.drafts : [];
  } catch {
    return [];
  }
}

route('GET', /^\/api\/drafts$/, async (_req, res) => {
  sendJson(res, 200, {
    drafts: readDrafts()
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
      .map((draft) => ({ id: draft.id, title: draft.title, savedAt: draft.savedAt })),
  });
});

route('GET', /^\/api\/drafts\/[a-z0-9-]+$/, async (_req, res, url) => {
  const id = url.pathname.split('/').pop() ?? '';
  const draft = readDrafts().find((entry) => entry.id === id);
  if (draft === undefined) throw new HttpError(404, 'no draft with that id');
  sendJson(res, 200, draft);
});

route('PUT', /^\/api\/drafts$/, async (req, res) => {
  const body = (await readBody(req)) as Record<string, unknown>;
  const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
  if (title === '') throw new HttpError(400, 'a draft needs a title to be found again');

  const id = typeof body['id'] === 'string' && body['id'] !== '' ? body['id'] : crypto.randomUUID();
  const drafts = readDrafts().filter((entry) => entry.id !== id);
  drafts.push({
    id,
    title: title.slice(0, 120),
    savedAt: new Date().toISOString(),
    body: (body['body'] ?? {}) as Record<string, unknown>,
  });

  // Oldest first out. A drafts list nobody prunes becomes a list nobody reads.
  const kept = drafts.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)).slice(0, 50);
  writeJsonAtomic(DRAFTS_FILE(), { drafts: kept });
  sendJson(res, 200, { id, saved: true });
});

route('DELETE', /^\/api\/drafts\/[a-z0-9-]+$/, async (_req, res, url) => {
  const id = url.pathname.split('/').pop() ?? '';
  const left = readDrafts().filter((entry) => entry.id !== id);
  writeJsonAtomic(DRAFTS_FILE(), { drafts: left });
  sendJson(res, 200, { deleted: id });
});

/* -------------------------------------------------------------- performance */

/**
 * The numbers, and the going and getting of them, kept apart.
 *
 * Reading is free and instant because it is a file; refreshing costs an API
 * call against a quota. Two routes rather than one so that opening the screen,
 * switching to it and back, or leaving it open does not spend the allowance --
 * only pressing the button does.
 */
route('GET', /^\/api\/analytics$/, async (_req, res) => {
  sendJson(res, 200, analytics.overview());
});

route('POST', /^\/api\/analytics\/refresh$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
  const { updated, errors } = await analytics.refresh({ force: body['force'] === true });
  sendJson(res, 200, { updated, errors, ...analytics.overview() });
});

route('POST', /^\/api\/analytics\/import$/, async (_req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  if (!youtube.isConnected()) throw new HttpError(409, 'no channel is connected');
  const imported = await analytics.importFromYouTube();
  await analytics.refresh({ force: true });
  sendJson(res, 200, { ...imported, ...analytics.overview() });
});

route('POST', /^\/api\/analytics\/forget$/, async (req, res) => {
  if (await isLockedOut()) throw new HttpError(401, 'sign in to continue');
  const body = (await readBody(req)) as Record<string, unknown>;
  const platform = String(body['platform'] ?? '');
  const remoteId = String(body['remoteId'] ?? '');
  if (!(PLATFORMS as readonly string[]).includes(platform) || remoteId === '') {
    throw new HttpError(400, 'platform and remoteId are both required');
  }
  sendJson(res, 200, {
    forgotten: forgetPost(platform as Platform, remoteId),
    ...analytics.overview(),
  });
});

/* ------------------------------------------------------------- the door */

/** Set when the server starts: whether it only listens on this machine. */
let loopbackOnly = true;

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Who may talk to this server.
 *
 * It is a local app with no login when accounts are off, so the browser is
 * the only thing between it and every website the user visits. Two attacks
 * matter, and both are closed here rather than route by route:
 *
 *   Cross-site requests. Any page can POST to localhost: a "simple" request
 *   (text/plain, no-cors) needs no preflight, and the body would still be read
 *   as JSON -- enough to delete videos, reset everything, import keys or start
 *   a paid run. The page cannot read the answer, but the damage is done. So a
 *   request that changes anything must come from this app's own pages: the
 *   browser's Sec-Fetch-Site and Origin headers say where it came from.
 *
 *   DNS rebinding. A hostile domain that re-points itself at 127.0.0.1 makes
 *   the browser treat this server as that domain, reads included -- so it
 *   could fetch the keys export. The Host header gives it away: a server that
 *   listens only on this machine answers only to this machine's names.
 */
function refused(req: http.IncomingMessage): string | null {
  const host = (req.headers.host ?? '').toLowerCase();
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? '';
  if (loopbackOnly && !LOOPBACK_NAMES.has(hostname) && !hostname.endsWith('.localhost')) {
    return 'this app only answers to localhost';
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return 'requests from other websites are refused';
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null') return 'requests from other websites are refused';
    try {
      if (new URL(origin).host.toLowerCase() !== host) return 'requests from other websites are refused';
    } catch {
      return 'requests from other websites are refused';
    }
  }
  return null;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://breezematic.local');

  const reason = refused(req);
  if (reason !== null) {
    sendJson(res, 403, { error: reason });
    return;
  }

  for (const entry of routes) {
    if (entry.method !== req.method || !entry.pattern.test(url.pathname)) continue;
    try {
      await entry.handler(req, res, url);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        log.error(error instanceof Error ? error : String(error));
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, ...(error.detail ?? {}) });
      } else if (error instanceof BusyError) {
        sendJson(res, 409, { error: error.message });
      } else if (error instanceof BeatSheetValidationError) {
        sendJson(res, 422, {
          error: 'beat sheet failed schema validation',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      } else if (error instanceof AuthError) {
        sendJson(res, 401, { error: error.message });
      } else if (error instanceof SupabaseNotConfiguredError) {
        sendJson(res, 501, { error: error.message });
      } else if (error instanceof MissingApiKeyError) {
        sendJson(res, 503, { error: error.message });
      } else if (error instanceof youtube.YouTubeNotConnectedError) {
        sendJson(res, 409, { error: error.message, youtube: 'disconnected' });
      } else if (error instanceof youtube.YouTubeApiError) {
        // Its own status, and a flag the page can act on: a connection that
        // has just been thrown away means the publish card is showing a
        // channel that is not there any more.
        sendJson(res, error.status, {
          error: error.message,
          ...(error.oauthError === 'invalid_grant' ? { youtube: 'disconnected' } : {}),
        });
      } else {
        log.error(error instanceof Error ? error : String(error));
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return;
  }

  sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
}

/**
 * What is off, said once at start. Every key can be added from Settings in the
 * app (or .env) and takes effect without a restart.
 */
function reportConfiguration(): void {
  if (!supabaseConfigured()) {
    log.info('accounts are off: everything is kept on this computer (optional: add a Supabase project in Settings)');
  }
  if (env.GEMINI_API_KEY === undefined) {
    log.warn('script writing is off: add a Gemini key in Settings, or write your own narration under Advanced');
  }
  if (!imagesConfigured()) {
    log.info('generated pictures are off: openly licensed stock still works; add a fal.ai key in Settings for generated ones');
  }
}

export function startAppServer(options: AppServerOptions): Promise<http.Server> {
  reportConfiguration();
  // Bound to all interfaces (Docker), the Host check would refuse the port
  // mapping's own name; the cross-site check still applies.
  loopbackOnly = LOOPBACK_NAMES.has(options.host.toLowerCase());

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  // A produce run holds its SSE stream open for the length of a render; the
  // default 5-minute request timeout would cut it off mid-run.
  server.requestTimeout = 0;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/* ---------------------------------------------------------------- editor */

/**
 * The editor's API.
 *
 * It works on one file -- work/<slug>/project.json -- which holds everything
 * the renderer draws and everything the mixer lays under it. Reading it is
 * free, changing it is free, and rendering it again costs ten minutes of this
 * machine and nothing else, because the writing, the reading aloud and the
 * drawing all happened upstream and are not repeated.
 */

type EditorJob = {
  slug: string;
  stage: 'render' | 'mix' | 'done' | 'failed';
  percent: number;
  /** Frames finished and how many there are, so the page can say both. */
  frames: number;
  total: number;
  /** Milliseconds left at the measured rate, or null too early to say. */
  etaMs: number | null;
  /**
   * When progress last moved. A page can then tell a slow render from a
   * stopped one, which is the whole difference between waiting and worrying.
   */
  updatedAt: number;
  error: string | null;
  startedAt: number;
};

let editorJob: EditorJob | null = null;

function projectOr404(slug: string): Project {
  const project = loadProject(slug);
  if (project === null) {
    throw new HttpError(
      404,
      'that video has no project file; only videos made since the editor existed have one',
    );
  }
  return project;
}

/** Music the editor can choose between: whatever is in assets/music. */
function musicChoices(): string[] {
  if (!fs.existsSync(assetDirs.music)) return [];
  return fs
    .readdirSync(assetDirs.music)
    .filter((file) => /\.(mp3|wav|m4a|ogg|flac)$/i.test(file))
    .sort();
}

route('GET', /^\/editor$/, async (_req, res) => {
  sendFile(res, path.join(ROOT, 'src', 'app', 'editor.html'), 'text/html; charset=utf-8');
});

route('GET', /^\/api\/edit\/[a-z0-9-]+$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const project = projectOr404(slug);
  sendJson(res, 200, {
    project,
    music: musicChoices(),
    job: editorJob !== null && editorJob.slug === slug ? editorJob : null,
  });
});

/**
 * The edited scene, saved.
 *
 * The whole scene comes back rather than a list of changes: the page already
 * holds it, the file is small, and a patch language for "this cutout moved
 * 400ms" is a second way to be wrong about what the video is. The shape is
 * checked because a scene missing its arrays renders a black video rather
 * than an error.
 */
route('PUT', /^\/api\/edit\/[a-z0-9-]+$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const project = projectOr404(slug);
  const body = (await readBody(req)) as { scene?: unknown; audio?: unknown };

  if (body.scene !== undefined) {
    const scene = body.scene as Record<string, unknown>;
    for (const field of ['lines', 'plates', 'cutouts', 'quotes', 'chapters']) {
      if (!Array.isArray(scene[field])) {
        throw new HttpError(400, `the scene is missing its "${field}"`);
      }
    }
    if (typeof scene['durationMs'] !== 'number' || !Number.isFinite(scene['durationMs'])) {
      throw new HttpError(400, 'the scene has no runtime');
    }
    project.scene = scene as unknown as Project['scene'];
  }
  if (body.audio !== undefined) {
    const audio = body.audio as Partial<Project['audio']>;
    if (typeof audio.music === 'string') project.audio.music = audio.music;
    if (typeof audio.musicLufs === 'number' && Number.isFinite(audio.musicLufs)) {
      project.audio.musicLufs = Math.max(-40, Math.min(-8, audio.musicLufs));
    }
    if (Array.isArray(audio.cuesOff)) {
      project.audio.cuesOff = audio.cuesOff.filter(
        (kind): kind is string => typeof kind === 'string',
      );
    }
  }
  saveProject(project);
  sendJson(res, 200, { project });
});

/** One frame at the playhead, with the edits as they stand. */
route('POST', /^\/api\/edit\/[a-z0-9-]+\/still$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const project = projectOr404(slug);
  const body = (await readBody(req)) as { atMs?: unknown };
  const atMs = typeof body.atMs === 'number' && Number.isFinite(body.atMs) ? body.atMs : 0;
  if (editorJob !== null && (editorJob.stage === 'render' || editorJob.stage === 'mix')) {
    throw new HttpError(409, 'a render is using the browser pool; try the preview after it finishes');
  }
  await renderProjectStill(project, Math.max(0, atMs));
  sendJson(res, 200, { url: `/api/edit/${slug}/preview.png?t=${Date.now()}` });
});

route('GET', /^\/api\/edit\/[a-z0-9-]+\/preview\.png$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  sendFile(res, path.join(workDir(slug), 'preview.png'), 'image/png');
});

/* ------------------------------------------------------------ fast sound -- */

/**
 * The music level, the music track and the sound effects, applied in seconds:
 * mixed onto the picture that is already rendered, the picture copied rather
 * than encoded. Refused, with the reason, when the picture itself has changed
 * since it was rendered -- new sound on an old picture is not the edit.
 */
let remixing = false;

function stemView(slug: string): Record<string, unknown> {
  const info = stemInfo(slug);
  const stamp = Date.now();
  return {
    stems:
      info === null
        ? null
        : {
            // The track the stems were mixed with, by name, and where to fetch them.
            track: info.music,
            musicLufs: info.musicLufs,
            voiceUrl: `/api/edit/${slug}/stem/voice.m4a?t=${stamp}`,
            musicUrl: info.hasMusic ? `/api/edit/${slug}/stem/music.m4a?t=${stamp}` : null,
          },
  };
}

route('GET', /^\/api\/edit\/[a-z0-9-]+\/stems$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const project = projectOr404(slug);
  const remix = canRemix(project);
  sendJson(res, 200, { ...stemView(slug), canRemix: remix.ok, why: remix.ok ? null : remix.why });
});

route('POST', /^\/api\/edit\/[a-z0-9-]+\/remix$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const project = projectOr404(slug);
  if (editorJob !== null && (editorJob.stage === 'render' || editorJob.stage === 'mix')) {
    throw new HttpError(409, 'a render is running; the sound goes on when it finishes');
  }
  if (remixing) throw new HttpError(409, 'the sound is already being mixed');
  const remix = canRemix(project);
  if (!remix.ok) throw new HttpError(409, remix.why);
  remixing = true;
  const started = Date.now();
  try {
    await mixProject(project);
  } finally {
    remixing = false;
  }
  log.info(`editor: sound mixed onto the picture in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  sendJson(res, 200, { ...stemView(slug), ms: Date.now() - started });
});

route('GET', /^\/api\/edit\/[a-z0-9-]+\/stem\/(voice|music)\.m4a$/, async (req, res, url) => {
  const parts = url.pathname.split('/');
  const slug = requireSlug(parts[3] ?? '');
  const stems = stemPaths(slug);
  const file = parts[5] === 'music.m4a' ? stems.music : stems.voice;
  if (!fs.existsSync(file)) throw new HttpError(404, 'no stem yet');
  sendVideo(req, res, file);
});

/* ------------------------------------------------------------- speed copy -- */

/**
 * The finished video, a touch faster or slower, without rendering it again:
 * ffmpeg stretches the picture and the sound together, the voice keeping its
 * pitch. Shown with the copies already made and which one plays as the video.
 */
function speedView(slug: string): Record<string, unknown> {
  return {
    job: speedJob(slug),
    copies: listCopies(slug).map((copy) => ({
      ...copy,
      url: `/api/edit/${slug}/speed/${copy.name}`,
    })),
    main: mainSpeed(slug),
    min: MIN_SPEED,
    max: MAX_SPEED,
  };
}

route('GET', /^\/api\/edit\/[a-z0-9-]+\/speed$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  sendJson(res, 200, speedView(slug));
});

route('POST', /^\/api\/edit\/[a-z0-9-]+\/speed$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const body = (await readBody(req)) as { speed?: unknown };
  const speed = typeof body.speed === 'number' && Number.isFinite(body.speed) ? body.speed : NaN;
  if (!(speed >= MIN_SPEED && speed <= MAX_SPEED)) {
    throw new HttpError(400, `speed must be between ${MIN_SPEED} and ${MAX_SPEED}`);
  }
  if (editorJob !== null && (editorJob.stage === 'render' || editorJob.stage === 'mix')) {
    throw new HttpError(409, 'a render is running; make the copy after it finishes');
  }
  try {
    await startSpeedCopy(slug, speed);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  sendJson(res, 202, speedView(slug));
});

/** Make a copy the video that plays and uploads; 1 puts the original back. */
route('POST', /^\/api\/edit\/[a-z0-9-]+\/speed\/use$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const body = (await readBody(req)) as { speed?: unknown };
  const speed = typeof body.speed === 'number' ? body.speed : NaN;
  if (!Number.isFinite(speed)) throw new HttpError(400, 'speed must be a number');
  try {
    useAsMain(slug, speed);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  sendJson(res, 200, speedView(slug));
});

route('GET', /^\/api\/edit\/[a-z0-9-]+\/speed\/[a-z0-9.-]+\.mp4$/, async (req, res, url) => {
  const parts = url.pathname.split('/');
  const slug = requireSlug(parts[3] ?? '');
  const file = copyPath(slug, parts[5] ?? '');
  if (file === null) throw new HttpError(404, 'no such copy');
  sendVideo(req, res, file);
});

/* ------------------------------------------------------------ thumbnails -- */

/** The three thumbnails as the page shows them: a URL each, and which is chosen. */
function thumbnailView(slug: string): { options: { url: string; lines: string[] }[]; chosen: number } | null {
  const set = loadThumbnails(slug);
  if (set === null) return null;
  const stamp = Date.now();
  return {
    options: set.options.map((option, index) => ({
      url: `/api/edit/${slug}/thumb/${index}.jpg?t=${stamp}`,
      lines: option.lines,
    })),
    chosen: set.chosen,
  };
}

route('GET', /^\/api\/edit\/[a-z0-9-]+\/thumbnails$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  sendJson(res, 200, { thumbnails: thumbnailView(slug) });
});

/**
 * Make them, or make them again from other pictures. Free apart from one call
 * to the cheap text model; the pictures are the video's own.
 */
route('POST', /^\/api\/edit\/[a-z0-9-]+\/thumbnails$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const project = projectOr404(slug);
  const body = (await readBody(req)) as { force?: unknown };
  if (editorJob !== null && (editorJob.stage === 'render' || editorJob.stage === 'mix')) {
    throw new HttpError(409, 'a render is using the browser pool; make thumbnails after it finishes');
  }
  await makeThumbnails(project, { force: body.force === true });
  sendJson(res, 200, { thumbnails: thumbnailView(slug) });
});

/** New words on one of them. No model involved, so no cost. */
route('PUT', /^\/api\/edit\/[a-z0-9-]+\/thumbnails\/\d$/, async (req, res, url) => {
  const parts = url.pathname.split('/');
  const slug = requireSlug(parts[3] ?? '');
  const index = Number(parts[5]);
  const body = (await readBody(req)) as { lines?: unknown };
  const lines = Array.isArray(body.lines) ? body.lines.filter((line): line is string => typeof line === 'string') : [];
  try {
    await rewordThumbnail(slug, index, lines);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  sendJson(res, 200, { thumbnails: thumbnailView(slug) });
});

/** Which one goes up with the video. */
route('POST', /^\/api\/edit\/[a-z0-9-]+\/thumbnails\/\d\/choose$/, async (_req, res, url) => {
  const parts = url.pathname.split('/');
  const slug = requireSlug(parts[3] ?? '');
  try {
    chooseThumbnail(slug, Number(parts[5]));
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  sendJson(res, 200, { thumbnails: thumbnailView(slug) });
});

route('GET', /^\/api\/edit\/[a-z0-9-]+\/thumb\/\d\.jpg$/, async (_req, res, url) => {
  const parts = url.pathname.split('/');
  const slug = requireSlug(parts[3] ?? '');
  const option = loadThumbnails(slug)?.options[Number(parts[5]?.replace('.jpg', ''))];
  if (option === undefined) throw new HttpError(404, 'no such thumbnail');
  sendFile(res, path.join(workDir(slug), option.file), 'image/jpeg');
});

/**
 * A picture, replaced: uploaded from disk, drawn to a description, or one of
 * the pictures already in this video reused. Whatever arrives gets a depth
 * map, so a replacement moves like everything around it.
 */
route('POST', /^\/api\/edit\/[a-z0-9-]+\/picture$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const project = projectOr404(slug);
  const body = (await readBody(req)) as {
    plate?: unknown;
    mode?: unknown;
    dataUrl?: unknown;
    prompt?: unknown;
    engine?: unknown;
    file?: unknown;
  };

  const index = Number(body.plate);
  const plate = project.scene.plates[index];
  if (plate === undefined) throw new HttpError(400, 'there is no picture at that position');

  let file: string;
  if (body.mode === 'reuse') {
    const named = String(body.file ?? '');
    if (
      !/^[A-Za-z0-9_.-]+\.(png|jpe?g)$/.test(named) ||
      !fs.existsSync(path.join(IMAGE_DIR, named))
    ) {
      throw new HttpError(400, 'that picture is not on this machine');
    }
    file = named;
  } else if (body.mode === 'upload') {
    const dataUrl = String(body.dataUrl ?? '');
    const match = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(dataUrl);
    if (match === null) throw new HttpError(400, 'that file is not a PNG or JPEG');
    const bytes = Buffer.from(match[2] ?? '', 'base64');
    if (bytes.length < 1_000) throw new HttpError(400, 'that file is empty');
    const extension = match[1] === 'png' ? 'png' : 'jpg';
    file = `edit-${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 20)}.${extension}`;
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMAGE_DIR, file), bytes);
  } else {
    const prompt = String(body.prompt ?? '').trim();
    if (prompt === '') throw new HttpError(400, 'say what the picture should be');
    const style = PICTURE_STYLES[project.pictureStyle as keyof typeof PICTURE_STYLES];
    const medium = style?.medium ?? '';
    const full =
      `${medium.charAt(0).toUpperCase()}${medium.slice(1)}. ${style?.not ?? ''}. ` +
      `${prompt}. ${NO_TEXT}`;
    const seed = (Date.now() >>> 0) % 2_000_000;
    const drawn =
      body.engine === 'flux'
        ? await generateImage({ prompt: full, seed, width: 1344, height: 768 })
        : await drawImage({ prompt: full, aspectRatio: '16:9', detail: `editor: ${slug}` });
    file = `edit-${crypto.createHash('sha1').update(drawn.bytes).digest('hex').slice(0, 20)}.png`;
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMAGE_DIR, file), drawn.bytes);
  }

  // Depth, and whether a caption can pass behind what is in it -- the same two
  // answers every picture in the pipeline gets.
  const next: Record<string, unknown> = {
    ...plate,
    file,
    motion: /\.(mp4|webm|mov)$/i.test(file),
  };
  delete next['depth'];
  delete next['matte'];
  const depth = await depthMapFor(path.join(IMAGE_DIR, file));
  if (depth !== null) {
    next['depth'] = depth;
    const matte = await depthMatte(path.join(IMAGE_DIR, depth));
    if (matte !== null && canGoBehind(matte)) next['matte'] = matte.threshold;
  }
  project.scene.plates[index] = next as unknown as Project['scene']['plates'][number];
  saveProject(project);
  sendJson(res, 200, { plate: project.scene.plates[index] });
});

/**
 * The description for this video, written if it has not been written yet.
 *
 * Kept next to the video rather than uploaded, because long-form is not
 * published from here yet -- so this is the text to paste under it.
 */
route('GET', /^\/api\/edit\/[a-z0-9-]+\/description$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const project = projectOr404(slug);
  const file = path.join(workDir(slug), 'description.txt');
  // The upload's own text when the video is there to describe; the older
  // builder only for a project whose video has not been rendered yet.
  if (!fs.existsSync(file) && fs.existsSync(path.join(dirs.out, `${slug}-essay.mp4`))) {
    const described = await describeLong(slug, 'essay');
    fs.writeFileSync(file, `${described.description}${NL}`, 'utf8');
  }
  if (!fs.existsSync(file)) {
    const brief = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(workDir(slug), 'case.json'), 'utf8')) as {
          thesis?: string;
          book?: string;
          author?: string;
        };
      } catch {
        return {};
      }
    })();
    const essay = path.join(workDir(slug), 'essay.txt');
    await writeEssayDescription({
      slug,
      title: project.title,
      thesis: brief.thesis ?? project.title,
      book: brief.book ?? '',
      author: brief.author ?? '',
      sample: fs.existsSync(essay) ? fs.readFileSync(essay, 'utf8').slice(0, 600) : '',
      chapters: project.scene.chapters,
    });
  }
  sendJson(res, 200, { text: fs.readFileSync(file, 'utf8') });
});

route('POST', /^\/api\/edit\/[a-z0-9-]+\/render$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const project = projectOr404(slug);
  // `undefined`, not null: an idle queue has no active run at all.
  if (activeRun() !== undefined) {
    throw new HttpError(409, 'a video is being made; wait for it to finish');
  }
  if (editorJob !== null && (editorJob.stage === 'render' || editorJob.stage === 'mix')) {
    throw new HttpError(409, 'that render is already running');
  }

  const job: EditorJob = {
    slug,
    stage: 'render',
    percent: 0,
    frames: 0,
    total: 0,
    etaMs: null,
    updatedAt: Date.now(),
    error: null,
    startedAt: Date.now(),
  };
  editorJob = job;
  void renderProject({
    project,
    onStage: (stage) => {
      job.stage = stage;
    },
    onProgress: ({ percent, frames, total, etaMs }) => {
      job.percent = percent;
      job.frames = frames;
      job.total = total;
      job.etaMs = etaMs;
      job.updatedAt = Date.now();
    },
  })
    .then(() => {
      job.stage = 'done';
      job.percent = 100;
      job.updatedAt = Date.now();
      log.info(`editor: re-rendered "${project.title}"`);
    })
    .catch((error: unknown) => {
      job.stage = 'failed';
      job.error = (error as Error).message;
      job.updatedAt = Date.now();
      log.warn(`editor: render failed (${job.error})`);
    });

  sendJson(res, 202, { job });
});

route('GET', /^\/api\/edit\/[a-z0-9-]+\/render$/, async (_req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  sendJson(res, 200, { job: editorJob !== null && editorJob.slug === slug ? editorJob : null });
});

/**
 * A different voice for a video that already exists.
 *
 * This is the one edit that cannot be a re-render. The voice decides the
 * timing of every word, and every caption, cut, cutting and quotation card is
 * placed against those timings -- so a new reading has to go back through
 * alignment and the edit plan. What it does not have to go back through is
 * the writing or the pictures: those are cached under keys made from the
 * script, so they come back instantly and cost nothing.
 *
 * It runs through the ordinary queue rather than the editor's own job, because
 * it is a run: the whole pipeline, one setting different.
 */
route('POST', /^\/api\/edit\/[a-z0-9-]+\/voice$/, async (req, res, url) => {
  const slug = requireSlug(url.pathname.split('/')[3] ?? '');
  const project = projectOr404(slug);
  const body = (await readBody(req)) as { character?: unknown; ttsProvider?: unknown };

  const saved = project.options;
  if (saved === undefined || typeof saved['book'] !== 'string') {
    throw new HttpError(
      409,
      'this video was made before its settings were saved, so it cannot be re-narrated from here — ' +
        'make it again from the Books screen to pick up the new voice',
    );
  }
  if (activeRun() !== undefined) throw new HttpError(409, 'something is already running');
  if (editorJob !== null && (editorJob.stage === 'render' || editorJob.stage === 'mix')) {
    throw new HttpError(409, 'a render is running; wait for it to finish');
  }

  const character = String(body.character ?? '');
  if (!isCharacter(character)) {
    throw new HttpError(400, `character must be one of ${CHARACTERS.map((c) => c.id).join(' | ')}`);
  }
  const provider = typeof body.ttsProvider === 'string' ? body.ttsProvider : undefined;

  const run = startRun({
    ...(saved as unknown as Parameters<typeof startRun>[0]),
    kind: 'book',
    topic: String(saved['book'] ?? project.title),
    variant: 0,
    force: false,
    character,
    ...(provider === undefined || provider === '' ? {} : { ttsProvider: provider }),
  });
  log.info(`editor: re-narrating "${project.title}" as ${character}`);
  sendJson(res, 202, { run });
});

/**
 * Is this script ready? Read off the text, instantly and for nothing, so the
 * answer arrives before the expensive half of a run rather than after it.
 */
route('POST', /^\/api\/script\/check$/, async (req, res) => {
  const body = (await readBody(req)) as { script?: unknown; minutes?: unknown };
  const script = typeof body.script === 'string' ? body.script : '';
  const minutes = typeof body.minutes === 'number' && Number.isFinite(body.minutes) ? body.minutes : undefined;
  sendJson(res, 200, checkScript({ script, ...(minutes === undefined ? {} : { minutes }) }));
});

/**
 * How long this will take to make, on this machine.
 *
 * Measured rather than promised: every render records what it managed, and
 * this is the median of those. Before the first one it uses numbers measured
 * while the feature was built, and says which it is using.
 */
route('GET', /^\/api\/estimate$/, async (_req, res, url) => {
  const number = (name: string, fallback: number): number => {
    const value = Number(url.searchParams.get(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const minutes = number('minutes', 3);
  const width = number('width', 1280);
  const height = number('height', 720);
  const fps = number('fps', 24);
  const durationMs = minutes * 60_000;

  sendJson(res, 200, {
    /** The video itself. */
    runtimeMs: durationMs,
    /** Drawing every frame, which is nearly all of the wait. */
    renderMs: estimateRenderMs({ durationMs, fps, width, height }),
    frames: Math.round((durationMs / 1000) * fps),
    measured: measuredRates(),
  });
});
