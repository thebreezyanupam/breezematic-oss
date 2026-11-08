import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { renderStill, selectComposition } from '@remotion/renderer';

import { MODELS, env, workDir } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate } from '../providers/gemini.js';
import { subjectMatte } from '../providers/localvision.js';
import { IMAGE_DIR } from './images.js';
import { CHROME_MODE, CHROMIUM, RENDER_PORT, ensureBundle, ensureBundledImages } from './render.js';
import type { Project } from './project.js';
import { loadProject } from './project.js';
import { caps, drawStickThumbnail, momentsOfScene, renderStickThumbnail, type Pick as StickPick } from './shortthumb.js';
import {
  THUMBNAIL_COMPOSITION_ID,
  THUMBNAIL_SIZE,
  type ThumbnailProps,
} from '../remotion/thumbnailProps.js';

/**
 * Three thumbnails, from pictures the video already paid for.
 *
 * Nothing is drawn. The picture is chosen from the video's own, the subject is
 * lifted out of it by the local cutout model (free, on this machine), and the
 * words are typeset over it. The only paid step is one call to the cheap text
 * model, which looks at a dozen small copies of the candidates, picks the three
 * that will read at matchbox size, and writes the words -- about a tenth of a
 * cent.
 */

export type ThumbnailOption = ThumbnailProps & {
  /** The rendered file, under the video's work folder. */
  file: string;
  /**
   * Designed by hand -- characters, labels and words composed as one image --
   * rather than typeset over a frame. Its words are part of the drawing, so it
   * cannot be reworded here: re-rendering it from its frame would throw the
   * design away.
   */
  custom?: boolean;
  /** Drawn from a stick figure moment: which one, and its tags, so rewording re-draws it. */
  stick?: StickPick;
};

export type ThumbnailSet = {
  options: ThumbnailOption[];
  chosen: number;
  /** How many times the set was made again; a new round picks new moments. */
  round?: number;
};

/** One per option, so three look different at a glance even from the same video. */
const ACCENTS = ['#ffd23f', '#ff3b30', '#3ee0ff'] as const;
/** How many candidates the picker is shown. Each small image is ~260 tokens. */
const CANDIDATES = 12;
/** Longest line, in characters, that still reads at thumbnail size. */
const MAX_LINE = 16;

const setFile = (slug: string): string => path.join(workDir(slug), 'thumbnails.json');

export function loadThumbnails(slug: string): ThumbnailSet | null {
  try {
    const raw = JSON.parse(fs.readFileSync(setFile(slug), 'utf8')) as ThumbnailSet;
    return Array.isArray(raw.options) && raw.options.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function saveThumbnails(slug: string, set: ThumbnailSet): void {
  fs.writeFileSync(setFile(slug), `${JSON.stringify(set, null, 2)}\n`, 'utf8');
}

/** The chosen thumbnail's file, if there is one on disk. */
export function chosenThumbnail(slug: string): string | null {
  const set = loadThumbnails(slug);
  const option = set?.options[set.chosen] ?? set?.options[0];
  if (option === undefined) return null;
  const file = path.join(workDir(slug), option.file);
  return fs.existsSync(file) ? file : null;
}

const isStill = (file: string): boolean => /\.(png|jpe?g|webp)$/i.test(file);

/**
 * The pictures worth showing the picker: stills only, ones the depth pass
 * already found a clear subject in first, spread across the whole video.
 */
function candidatesOf(project: Project, avoid: readonly string[] = []): string[] {
  const seen = new Set<string>(avoid);
  const plates = project.scene.plates.filter((plate) => {
    if (!isStill(plate.file) || seen.has(plate.file)) return false;
    if (!fs.existsSync(path.join(IMAGE_DIR, plate.file))) return false;
    seen.add(plate.file);
    return true;
  });
  const withSubject = plates.filter((plate) => plate.matte !== undefined);
  const pool = withSubject.length >= CANDIDATES ? withSubject : [...withSubject, ...plates.filter((p) => p.matte === undefined)];
  if (pool.length <= CANDIDATES) return pool.map((plate) => plate.file);
  const step = pool.length / CANDIDATES;
  return Array.from({ length: CANDIDATES }, (_, i) => pool[Math.floor(i * step)]!.file);
}

type Choice = { index: number; line1: string; line2: string };

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          line1: { type: 'string' },
          line2: { type: 'string' },
        },
        required: ['index', 'line1', 'line2'],
        propertyOrdering: ['index', 'line1', 'line2'],
      },
    },
  },
  required: ['picks'],
};

const clean = (line: string): string =>
  line.toUpperCase().replace(/[^\p{L}\p{N}'!?.,&\- ]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);

/** Words from the title alone, when there is no key to ask for better ones. */
function fallbackWords(title: string): Choice['line1'] {
  const words = title.toUpperCase().split(/\s+/).filter((word) => word.length > 3);
  return words.slice(0, 2).join(' ') || title.toUpperCase().slice(0, MAX_LINE);
}

async function choose(project: Project, files: readonly string[], opening: string): Promise<Choice[]> {
  if (env.GEMINI_API_KEY === undefined) {
    return files.slice(0, 3).map((_, index) => ({ index, line1: fallbackWords(project.title), line2: '' }));
  }
  const images = await Promise.all(
    files.map(async (file) => ({
      bytes: await sharp(path.join(IMAGE_DIR, file)).resize({ width: 384 }).jpeg({ quality: 70 }).toBuffer(),
      mime: 'image/jpeg',
    })),
  );
  const { value } = await cache.json<{ picks: Choice[] }>(
    'thumbnail-picks',
    { v: 2, files, title: project.title, opening, model: MODELS.llm.script },
    async () => {
      const response = await generate({
        model: MODELS.llm.script,
        systemInstruction:
          'You design YouTube thumbnails for a channel about the characters inside books and manga. ' +
          'You return JSON only.',
        prompt: `The video is titled "${project.title}". It opens:
"""
${opening}
"""
Above are ${files.length} pictures from the video, numbered 0 to ${files.length - 1} in order.

Choose the 3 that will make the best thumbnails, best first. A good one has ONE character, big in
the frame, with a readable, intense face -- fear, rage, grief, shock, menace -- clear against its
background, and nothing cluttered or tiny. Three different pictures.

For each, write the words that go on it: "line1" of 1 to 3 words and an optional "line2" of 1 to 3
words, each at most ${MAX_LINE} characters, in capitals. They must make someone who sees only the
picture and the title need to click: a claim, a twist, a question, an emotion. Never repeat the
title's words, never explain, no hashtags, no emoji. Grammatical English. Three different angles for
the three.`,
        temperature: 0.7,
        seed: 0,
        maxOutputTokens: 600,
        responseSchema: SCHEMA,
        images,
      });
      return JSON.parse(response.text) as { picks: Choice[] };
    },
  );
  const picks = (value.picks ?? []).filter(
    (pick, i, all) =>
      Number.isInteger(pick.index) &&
      pick.index >= 0 &&
      pick.index < files.length &&
      all.findIndex((other) => other.index === pick.index) === i,
  );
  // Never fewer than three pictures, whatever came back.
  for (let i = 0; picks.length < Math.min(3, files.length) && i < files.length; i++) {
    if (!picks.some((pick) => pick.index === i)) picks.push({ index: i, line1: fallbackWords(project.title), line2: '' });
  }
  return picks.slice(0, 3);
}

/** How the picture is framed around its subject, and the matte to lift it with. */
async function frame(
  image: string,
  lines: readonly string[],
): Promise<Pick<ThumbnailProps, 'matte' | 'focus' | 'subjectTop' | 'zoom' | 'textTop'>> {
  // v2: hardened, see below.
  const name = `thumbmatte2-${crypto.createHash('sha1').update(image).digest('hex').slice(0, 16)}.png`;
  const destination = path.join(IMAGE_DIR, name);
  const infoFile = `${destination}.json`;
  let info: { share: number; box: { top: number; bottom: number }; centre: { x: number; y: number } } | null = null;
  if (fs.existsSync(destination) && fs.existsSync(infoFile)) {
    info = JSON.parse(fs.readFileSync(infoFile, 'utf8')) as typeof info;
  } else {
    const result = await subjectMatte(path.join(IMAGE_DIR, image), destination);
    if (result.ok) {
      /**
       * Hardened: the model is unsure at hair and at a head against a busy
       * ground, and an unsure matte is half transparent -- which in front of
       * the words reads as a figure with its head missing. Pushed towards
       * solid, a head is either in front or it is not.
       */
      const { width = 1, height = 1 } = await sharp(destination).metadata();
      const solid = await sharp(destination).extractChannel(3).linear(2, -70).png().toBuffer();
      const hard = await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
        .joinChannel(solid)
        .png()
        .toBuffer();
      fs.writeFileSync(destination, hard);
      info = { share: result.share, box: result.box, centre: result.centre };
      fs.writeFileSync(infoFile, JSON.stringify(info));
    } else {
      log.info(`thumbnail: no subject lifted from ${image} (${result.why})`);
    }
  }
  // A matte that is a speck or the whole frame gives no depth, only a mess.
  if (info === null || info.share < 0.04 || info.share > 0.85) {
    return { focus: { x: 0.5, y: 0.45 }, subjectTop: 0.25, zoom: 1.05 };
  }
  const tall = Math.max(0.1, info.box.bottom - info.box.top);
  const framing = {
    focus: info.centre,
    subjectTop: info.box.top,
    // Pushed in until the subject is about three quarters of the frame tall.
    zoom: Math.min(1.45, Math.max(1, 0.75 / tall)),
  };

  /**
   * Where the words can still be read.
   *
   * The subject in front of the words is the whole look, and it fails two
   * ways: a crowd lifted as one "subject" hid the words almost completely, and
   * a figure standing in front of a short word took a whole letter -- "HERO"
   * came out as "ERO". So every height inside the bars is tried, letter by
   * letter: a long word can lose a letter or two to a head and still read, a
   * short word cannot lose any. Of the heights that pass, the one nearest the
   * top of the subject wins, since the head coming up in front of the words
   * is the point. If none pass, the words go in front of the subject instead.
   */
  const alpha = await sharp(destination).extractChannel(3).resize(128, 72, { fit: 'fill' }).raw().toBuffer();
  const coverOf = (x0: number, x1: number, y0: number, y1: number): number => {
    let hit = 0;
    for (let gy = 0; gy < 6; gy++) {
      for (let gx = 0; gx < 6; gx++) {
        const sx = x0 + ((x1 - x0) * (gx + 0.5)) / 6;
        const sy = y0 + ((y1 - y0) * (gy + 0.5)) / 6;
        // Screen to picture: the push-in scales about the focus.
        const px = framing.focus.x + (sx - framing.focus.x) / framing.zoom;
        const py = framing.focus.y + (sy - framing.focus.y) / framing.zoom;
        if (px < 0 || px >= 1 || py < 0 || py >= 1) continue;
        if (alpha[Math.floor(py * 72) * 128 + Math.floor(px * 128)]! > 128) hit++;
      }
    }
    return hit / 36;
  };

  /**
   * Letter by letter, at each letter's own width: Inter at weight 900 in
   * capitals is not monospaced -- an I is a third of an M -- and an average
   * width put the judged letters a whole letter away from the drawn ones by
   * the end of a long word.
   */
  const advance = (character: string): number =>
    character === ' ' ? 0.26 : character === 'I' ? 0.32 : character === "'" ? 0.28 : character === 'J' ? 0.6
      : character === 'M' ? 0.93 : character === 'W' ? 1.02 : /[0-9]/.test(character) ? 0.68 : 0.72;
  const widthOf = (line: string): number => [...line].reduce((sum, c) => sum + advance(c) - 0.02, 0);
  const widest = Math.max(0.5, ...lines.map(widthOf));
  const maxShare = lines.length > 1 ? 0.27 : 0.36;
  const font = Math.min(maxShare * 720, (0.9 * 1280) / widest) / 720;
  const em = (font * 720) / 1280;
  const block = font * 0.9 * Math.max(1, lines.length);
  const judge = (top: number): { ok: boolean; cover: number } => {
    let ok = true;
    let cover = 0;
    lines.forEach((line, row) => {
      // The capitals occupy roughly the middle three quarters of the line box.
      const y0 = top + row * font * 0.9 + font * 0.12;
      const y1 = y0 + font * 0.72;
      /**
       * Judged word by word, not line by line: "THE HERO" as one line of seven
       * letters could lose two, and it lost the E of THE -- a short word with
       * a letter gone is a different word. So: up to four letters, lose none;
       * up to seven, one; longer, two.
       */
      let x = 0.5 - (widthOf(line) * em) / 2;
      for (const word of line.split(' ')) {
        let lost = 0;
        for (const character of word) {
          const w = (advance(character) - 0.02) * em;
          const hidden = coverOf(x, x + w, y0, y1);
          cover += hidden;
          if (hidden > 0.4) lost++;
          x += w;
        }
        const allowed = word.length <= 4 ? 0 : word.length <= 7 ? 1 : 2;
        if (lost > allowed) ok = false;
        x += (advance(' ') - 0.02) * em;
      }
    });
    return { ok, cover };
  };

  /**
   * When the words have to go in front, they must not go across the face.
   * The face is almost always in the top fifth of the subject, so that band
   * counts four times over when choosing where the words go.
   */
  const toScreen = (y: number): number => framing.focus.y + (y - framing.focus.y) * framing.zoom;
  const faceTop = toScreen(info.box.top);
  const faceBottom = toScreen(info.box.top + (info.box.bottom - info.box.top) * 0.22);
  const overFace = (top: number): number =>
    Math.max(0, Math.min(top + block, faceBottom) - Math.max(top, faceTop)) / Math.max(0.01, faceBottom - faceTop);

  const bar = (720 - 1280 / 2.39) / 2 / 720;
  const wanted = framing.subjectTop + (framing.subjectTop - framing.focus.y) * (framing.zoom - 1) + 0.06;
  let best: { top: number; score: number } | null = null;
  let fallback = { top: wanted, score: Number.POSITIVE_INFINITY };
  for (let top = bar + 0.03; top + block <= 1 - bar - 0.04 + 1e-6; top += 0.02) {
    const verdict = judge(top);
    const frontScore = verdict.cover + 4 * overFace(top) * 20;
    if (frontScore < fallback.score) fallback = { top, score: frontScore };
    if (!verdict.ok) continue;
    const score = Math.abs(top - wanted) + 0.02 * verdict.cover;
    if (best === null || score < best.score) best = { top, score };
  }
  if (best === null) {
    log.info('thumbnail: the subject would hide too much of the words; words in front of it');
    return { ...framing, textTop: fallback.top };
  }
  return { ...framing, matte: name, textTop: best.top };
}

async function renderOne(slug: string, props: ThumbnailProps, file: string): Promise<void> {
  const serveUrl = await ensureBundle();
  ensureBundledImages(serveUrl, [props.image, ...(props.matte === undefined ? [] : [props.matte])]);
  const composition = await selectComposition({
    serveUrl,
    id: THUMBNAIL_COMPOSITION_ID,
    inputProps: props,
    chromiumOptions: CHROMIUM,
    chromeMode: CHROME_MODE,
    port: RENDER_PORT,
  });
  await renderStill({
    composition: { ...composition, ...THUMBNAIL_SIZE, durationInFrames: 1 },
    serveUrl,
    output: path.join(workDir(slug), file),
    frame: 0,
    inputProps: props,
    imageFormat: 'jpeg',
    jpegQuality: 90,
    chromiumOptions: CHROMIUM,
    chromeMode: CHROME_MODE,
    port: RENDER_PORT,
    overwrite: true,
  });
}

/**
 * Makes the three, or returns the three already made.
 *
 * Never throws into a pipeline that called it for free: a video without a
 * thumbnail is the video it was yesterday.
 */
export async function makeThumbnails(
  project: Project,
  options: { force?: boolean } = {},
): Promise<ThumbnailSet | null> {
  const existing = loadThumbnails(project.slug);
  if (existing !== null && options.force !== true) return existing;

  /**
   * Made again means made from other pictures: the same candidates would get
   * the same picks back from the cache, which is no choice at all. The
   * pictures already used are left out, as long as enough others remain.
   */
  const used = options.force === true && existing !== null ? existing.options.map((option) => option.image) : [];
  let files = candidatesOf(project, used);
  if (files.length < 3) files = candidatesOf(project);
  if (files.length === 0) {
    // A stick figure video has no stills with a subject in them: its
    // thumbnails are drawn from its moments instead.
    if ((project.scene.stickman ?? []).length > 0) return makeStickThumbnails(project, existing, options.force === true);
    log.info('thumbnail: the video has no still pictures to make one from');
    return null;
  }
  const opening = project.scene.lines
    .map((line) => line.text)
    .join(' ')
    .split(/\s+/)
    .slice(0, 120)
    .join(' ');

  const picks = await choose(project, files, opening);
  const made: ThumbnailOption[] = [];
  for (const [i, pick] of picks.entries()) {
    const image = files[pick.index]!;
    let lines = [clean(pick.line1), clean(pick.line2)].filter((line) => line !== '');
    if (lines.length === 0) lines = [fallbackWords(project.title)];
    const props: ThumbnailProps = {
      image,
      lines,
      accent: ACCENTS[i % ACCENTS.length]!,
      bars: true,
      ...(await frame(image, lines)),
    };
    const file = `thumb-${i + 1}.jpg`;
    await renderOne(project.slug, props, file);
    made.push({ ...props, file });
    log.info(`thumbnail ${i + 1}: "${props.lines.join(' / ')}" on ${image}`);
  }
  const set: ThumbnailSet = { options: made, chosen: existing?.chosen ?? 0 };
  if (set.chosen >= made.length) set.chosen = 0;
  saveThumbnails(project.slug, set);
  return set;
}

/**
 * Three drawn thumbnails for a stick figure video, from three different
 * moments. Made again, a new round picks new moments and new words.
 */
async function makeStickThumbnails(project: Project, existing: ThumbnailSet | null, again: boolean): Promise<ThumbnailSet | null> {
  const moments = momentsOfScene(project.scene.stickman ?? [], project.scene.lines);
  const round = again ? (existing?.round ?? 0) + 1 : 0;
  const base = Number.parseInt(crypto.createHash('sha1').update(project.slug).digest('hex').slice(0, 8), 16);
  const made: ThumbnailOption[] = [];
  const used: number[] = [];
  for (let i = 0; i < 3; i++) {
    const file = `thumb-${i + 1}.jpg`;
    const pick = await drawStickThumbnail({
      topic: project.title,
      moments,
      seed: (base + round * 104729 + i * 7919) >>> 0,
      layout: 'landscape',
      file: path.join(workDir(project.slug), file),
      avoid: used,
    });
    if (pick === null) break;
    used.push(pick.beat);
    made.push({
      image: moments[pick.beat]?.stage?.background ?? '',
      lines: [pick.line1, pick.line2].filter((line) => line !== ''),
      accent: '#ff3b30',
      focus: { x: 0.5, y: 0.6 },
      subjectTop: 0.4,
      zoom: 1,
      bars: false,
      file,
      stick: pick,
    });
  }
  if (made.length === 0) return null;
  const set: ThumbnailSet = { options: made, chosen: 0, round };
  saveThumbnails(project.slug, set);
  return set;
}

/** One option again with new words: free, no model involved. */
export async function rewordThumbnail(slug: string, index: number, lines: readonly string[]): Promise<ThumbnailSet> {
  const set = loadThumbnails(slug);
  const option = set?.options[index];
  if (set === null || option === undefined) throw new Error('no such thumbnail');
  if (option.custom === true) throw new Error('this thumbnail was designed by hand; its words are part of the picture');
  if (option.stick !== undefined) {
    // Re-drawn with the new words, same moment and tags: free, no model.
    const project = loadProject(slug);
    if (project === null) throw new Error('no project to draw from');
    const words = lines.map((line) => caps(line, 18)).filter((line) => line !== '').slice(0, 2);
    if (words.length === 0) throw new Error('a thumbnail needs at least one word');
    const pick = { ...option.stick, line1: words[0]!, line2: words[1] ?? '' };
    await renderStickThumbnail(momentsOfScene(project.scene.stickman ?? [], project.scene.lines), pick, 'landscape', path.join(workDir(slug), option.file));
    set.options[index] = { ...option, lines: words, stick: pick };
    saveThumbnails(slug, set);
    return set;
  }
  const cleaned = lines.map(clean).filter((line) => line !== '').slice(0, 2);
  if (cleaned.length === 0) throw new Error('a thumbnail needs at least one word');
  const { matte: _old, textTop: _top, ...rest } = option;
  const next: ThumbnailOption = { ...rest, lines: cleaned, ...(await frame(option.image, cleaned)) };
  const { file, ...props } = next;
  await renderOne(slug, props, file);
  set.options[index] = next;
  saveThumbnails(slug, set);
  return set;
}

export function chooseThumbnail(slug: string, index: number): ThumbnailSet {
  const set = loadThumbnails(slug);
  if (set === null || set.options[index] === undefined) throw new Error('no such thumbnail');
  set.chosen = index;
  saveThumbnails(slug, set);
  return set;
}
