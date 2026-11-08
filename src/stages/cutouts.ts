import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { MODELS, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { ffmpeg } from '../ffmpeg.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import { generateImage, isConfigured as canGenerate } from '../providers/flux.js';
import { IMAGE_DIR, portraitsOf, type CommonsImage } from './images.js';
import { APPROX_USD_PER_IMAGE, IMAGE_MODEL, canDrawWithReferences, drawImage } from '../providers/geminiimage.js';
import { checkPicture, correction, drawChecked } from './picturecheck.js';
import { cutOutSubject } from '../providers/localvision.js';
import { ILLUSTRATION_MEDIUM } from '../design/signature.js';
import { findSheet, sameCharacter, type Sheet } from './characters.js';
import type { Cutout, CutoutKind } from './compose.js';

/**
 * Cut and paste.
 *
 * The oldest trick in the format and still the one that reads fastest: the
 * narration names a person and the person is suddenly there, stuck onto the
 * frame with a hard edge and a shadow. It works because the edge is hard. A
 * subject faded into a photograph is a composite and the eye treats it as
 * scenery; a subject cut out and slapped down is an interruption, and an
 * interruption is what the word "cutout" is describing.
 *
 * Two kinds of thing arrive that way here, and they get there by completely
 * different routes:
 *
 *   A person or an object is generated against a flat green field and keyed
 *   out. Nothing segments the picture, because nothing has to -- we are
 *   commissioning the image, so we can commission it already isolated, and a
 *   chroma key on a field we chose is exact where a matting model is a
 *   guess. It is also free, offline, and already installed: ffmpeg has done
 *   this since before any of the models existed.
 *
 *   A book is not generated at all. The whole channel is about real books and
 *   a plausible-looking cover for a real book is a small lie told confidently,
 *   which is the one thing this pipeline is not allowed to do. So covers are
 *   fetched, and if the real one cannot be found the cutout is dropped. A
 *   missing cover costs a moment of screen time; an invented one costs the
 *   channel.
 */

/**
 * The green we ask for, and it is a request rather than a fact.
 *
 * Measured: the model never actually draws it. The same prompt at four seeds
 * produced backdrops of #2aa025, #46bc13, #03a815 and #4bad24 -- every one a
 * yellower green than the #00B140 requested, because the medium prepended to
 * the prompt asks for a restrained palette and the model applies that to the
 * backdrop along with everything else.
 *
 * That drift turned out not to matter, which is worth recording because it was
 * my first theory and it was wrong. `chromakey` compares in YUV chroma space,
 * so 0.15 tolerance swallows a lot of hue: the same drawing hue-shifted sixty
 * degrees, to a backdrop of #199394, still keyed at 59% against this fixed
 * colour. An off-hue green was never the failure.
 *
 * So "the key cleared 0% of the frame" means what it says -- there was no
 * green backdrop at all, because the model drew a scene instead. That is
 * prompt non-compliance, it is per-seed, and a retry is the right answer to
 * it.
 *
 * The key is sampled off the drawing regardless, for two reasons that are
 * about diagnosis rather than yield: it separates "the corners disagree, so
 * there is a room behind the subject" from "the backdrop is grey, not green",
 * where a fixed key reports both as the same useless 0%; and it removes a
 * silent dependency on a tolerance that happens to be generous enough.
 */
const KEY_COLOUR = '0x00B140';

/** How far two corners may differ and still count as the same flat backdrop. */
const CORNER_TOLERANCE = 48;
/**
 * How far from the key colour still counts as background, and how wide the
 * blend to full opacity is.
 *
 * Measured against a deliberately awkward test frame -- a noisy, blurred green
 * field with a subject wearing a dark green shirt -- rather than picked to
 * look right on an easy one:
 *
 *   similarity   background   subject   green shirt
 *   0.10         gone         intact    intact
 *   0.15         gone         intact    intact
 *   0.18         gone         intact    half dissolved
 *   0.22         gone         intact    gone
 *   0.26         gone         eroding   gone
 *   0.30         gone         gone      gone
 *
 * So the useful range ends at 0.15, and it ends because of the subject, not
 * because of the background -- even a noisy field keys out completely by 0.10.
 * That is the whole reason this is a chroma key rather than a matting model:
 * the background is ours to specify, so the only question left is how much
 * margin the subject needs, and the answer is "all of it".
 *
 * Blend matters more than it looks. At 0.08 with a loose similarity the
 * subject came back uniformly half-transparent -- not a soft edge, a ghost --
 * because the blend ramp is a distance band and a loose band reaches the
 * middle of the figure. Narrow is correct; the edge softness that is actually
 * wanted comes from the source image being antialiased already.
 */
const KEY_SIMILARITY = 0.15;
const KEY_BLEND = 0.03;

/**
 * How much of the frame the key has to remove for the result to be a cutting.
 *
 * Measured across the first eight real ones. The seven that worked came back
 * 22% to 58% transparent; the one that failed came back 10.8%, because the
 * model had ignored the instruction and drawn a rope on a plain pale
 * background instead of on green. Nothing about that is detectable from the
 * prompt or the response -- only from the picture.
 *
 * Below this the key removed a fringe and left a rectangle, and a rectangle
 * pasted over the frame with a drop shadow does not read as a cutting. It
 * reads as a mistake, which is what it is.
 */
const MIN_KEYED_SHARE = 15;

/**
 * The smallest a trimmed cutting may be before it is not worth pasting.
 *
 * The two failures compound: a key that removes almost nothing leaves a
 * subject the trim cannot find, so the crop collapses to a small square. That
 * rope arrived 176 pixels across and was then drawn at 56% of a 720-line
 * frame -- a four-times upscale of a thumbnail.
 */
const MIN_EDGE_PX = 320;

const PROMPT_VERSION = 3;
const COVER_TIMEOUT_MS = 15_000;

/** How long a cutout stays when the writer did not say where the talk about it ends. */
const HOLD_MS = 4_500;
/** Never shorter than this: under it a cutting is a flash, not a picture. */
const MIN_HOLD_MS = 2_600;
/** Never longer: past this it has become part of the background. */
const MAX_HOLD_MS = 11_000;
/** Two arrivals closer than this are one interruption, so the second is dropped. */
const MIN_ARRIVAL_GAP_MS = 1_200;
/** A cutting made to leave by a newcomer has been up at least this long. */
const MIN_SHOWN_MS = 1_800;
/** The cover is not shown over the title card, which already names the book. */
const COVER_EARLIEST_MS = 8_000;
/** Long enough to read the cover. */
const COVER_HOLD_MS = 5_000;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    cutouts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          phrase: { type: 'string' },
          until: { type: 'string' },
          kind: { type: 'string', enum: ['character', 'person', 'book', 'object'] },
          name: { type: 'string' },
          look: { type: 'string' },
          pose: { type: 'string' },
        },
        required: ['phrase', 'until', 'kind', 'name', 'look', 'pose'],
        propertyOrdering: ['phrase', 'until', 'kind', 'name', 'look', 'pose'],
      },
    },
  },
  required: ['cutouts'],
};

type Planned = {
  phrase: string;
  /** Where the talk about it ends, copied from the narration; may be empty. */
  until?: string;
  kind: CutoutKind;
  name: string;
  look: string;
  /** What it is doing at this moment, so each appearance is a different drawing. */
  pose?: string;
};

export type CutoutPlan = {
  cutouts: Cutout[];
  /** Covers taken from Open Library, for the credits file. */
  covers: { name: string; url: string }[];
  /** Real portraits taken from Wikimedia Commons, for the credits file. */
  portraits: CommonsImage[];
  generated: number;
  usd: number;
};

const EMPTY: CutoutPlan = { cutouts: [], covers: [], portraits: [], generated: 0, usd: 0 };

/* -------------------------------------------------------------- writing --- */

function buildRequest(options: {
  title: string;
  book: string;
  author: string;
  prose: string;
  count: number;
  castNames?: readonly string[];
}): string {
  const fence = '"'.repeat(3);

  return `A long-form video essay about the book "${options.book}" by ${options.author} needs
${options.count} cutouts: subjects that appear suddenly over the frame at the moment the
narration names them, the way a scrapbook cutting is pasted onto a page.

The narration:
${fence}
${options.prose}
${fence}

Choose the ${options.count} moments where a cutout would land hardest, and for each one give:

"phrase" — three to six words copied EXACTLY from the narration above, at the moment the
subject is named. Copy the words character for character, in the order they appear. This is
matched against the spoken audio to place the cutout in time, so a paraphrase places it
nowhere and the cutout is thrown away.

"until" — three to six words copied EXACTLY from the narration, a little later, where the talk
about this subject ends: the last words of the sentence or two about them. The cutout stays on
screen until then. Empty when the subject is only named in passing.

"kind" — one of:
  "book"      the book itself, or another real published book named in the narration.
  "person"    somebody who really lived: the author, a critic, a judge, a historical
              figure. Their real photograph or painted portrait is used, so "name" must
              be their full name as an encyclopedia titles them -- "Oscar Wilde",
              "Edward Carson" -- never a role like "the prosecutor".
  "character" somebody in the story itself, who is drawn.
  "object"    a thing that matters to the argument — a manuscript, a weapon, a machine,
              a door, a letter, a piece of clothing.

"name" — what it is. For a book, the title and author as they would appear on a cover.${
    options.castNames === undefined || options.castNames.length === 0
      ? ''
      : `
For a "character", "name" must be exactly one of these, spelled exactly like this, because
these are the characters already drawn for this video and the cutout is taken from that
drawing: ${options.castNames.map((name) => `"${name}"`).join(', ')}. A character who is not in
that list may still be chosen, under their own name.`
  }

"look" — one sentence describing the subject alone, to be drawn. Say what it looks like:
body, face, age, clothing, posture, expression, era. For a person, always the whole figure
from head to toe, standing — a cropped portrait is pasted at half the height of the frame
and arrives as a head with no body. Do not describe a scene, a background,
a mood or a camera — the subject is drawn on an empty field and anything else in the
sentence becomes clutter that has to be cut back off. Be exact and faithful: the age, clothes,
build and objects the book and its period give them, never a detail the story contradicts, never
anything modern in a period story. Leave this empty for a "book": real covers are photographed,
never drawn.

"pose" — what the subject is doing at THIS moment of the narration, as one body pose and one
expression: "kneeling by the bed, head bowed", "arms folded, glaring sideways", "reaching out,
pleading". It must match what the narration says at that moment. The same subject chosen twice
gets two different poses. Empty for a "book".

Rules:
1. Spread them across the whole essay. ${options.count} cutouts in the first two minutes is a
   title sequence, not an edit.
2. At most one "book" for the main book. It is the subject of the whole video, so it earns
   one appearance, early, and then it stops being news.
3. Prefer people. A face arriving over the frame is the strongest version of this and the
   one a viewer reads instantly.
4. Never choose a moment where the narration is being abstract. A cutout of an idea is a
   stock photograph, and it looks like one.
5. Pairs. When the narration brings two people together — a meeting, a rivalry, a marriage, a
   quarrel, a comparison — choose BOTH, each at the phrase where it is named. The second joins
   the first on screen, on the other side, so the viewer sees the two of them together. Aim for
   about a third of the cutouts to be in pairs like this.
6. Variety. The same subject at most twice, and never twice in the same pose.

Return only the JSON object.`;
}

async function writePlan(options: {
  title: string;
  book: string;
  author: string;
  prose: string;
  count: number;
  seed: number;
  castNames?: readonly string[];
}): Promise<Planned[]> {
  if (env.GEMINI_API_KEY === undefined) {
    log.info('cutouts: no key for choosing subjects; going without');
    return [];
  }

  const { value } = await cache.json<{ cutouts: Planned[] }>(
    'essay-cutouts',
    {
      v: PROMPT_VERSION,
      model: MODELS.llm.script,
      book: options.book,
      prose: options.prose,
      count: options.count,
      seed: options.seed,
      cast: options.castNames ?? [],
    },
    async () => {
      const response = await generate({
        model: MODELS.llm.script,
        systemInstruction:
          'You choose subjects to cut out and paste over a video essay. You return JSON ' +
          'and nothing else. No preamble, no markdown, no code fences.',
        prompt: buildRequest(options),
        temperature: 0.6,
        seed: toInt32Seed(options.seed),
        maxOutputTokens: 2048,
        responseSchema: RESPONSE_SCHEMA,
      });
      return JSON.parse(response.text) as { cutouts: Planned[] };
    },
  );

  return (value.cutouts ?? []).filter(
    (item): item is Planned =>
      typeof item?.phrase === 'string' &&
      item.phrase.trim() !== '' &&
      (item.kind === 'character' ||
        item.kind === 'person' ||
        item.kind === 'book' ||
        item.kind === 'object'),
  );
}

/* ------------------------------------------------------------- anchoring --- */

/**
 * Words as they compare, rather than as they were written.
 *
 * The narration is punctuated and capitalised; the aligned transcript is what
 * a recogniser heard. Comparing those two directly fails on the apostrophe in
 * "didn't" and on nothing else, which is the most annoying possible way for a
 * feature to half-work.
 */
function normalise(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

/* ---------------------------------------------------------------- covers --- */

type Cover = { url: string; bytes: Buffer };

/**
 * The real cover of a real book, from Open Library.
 *
 * Searched by title and author together and then checked against the author,
 * because the title alone reliably returns a study guide: asking for "1984
 * Orwell" puts SparkNotes third, and a video essay that illustrates Orwell
 * with a revision aid has said something about itself.
 */
async function fetchCover(name: string, author: string): Promise<Cover | null> {
  const query = `${name} ${author}`.trim();
  const url =
    'https://openlibrary.org/search.json?q=' +
    encodeURIComponent(query) +
    '&fields=title,author_name,cover_i,first_publish_year&limit=8';

  const search = await withTimeout(url);
  if (search === null) return null;

  const docs = (JSON.parse(search) as {
    docs?: { title?: string; author_name?: string[]; cover_i?: number }[];
  }).docs;
  if (!Array.isArray(docs)) return null;

  const wanted = normalise(author);
  const match =
    docs.find(
      (doc) =>
        typeof doc.cover_i === 'number' &&
        (wanted === '' ||
          (doc.author_name ?? []).some((written) => normalise(written).includes(wanted))),
    ) ?? docs.find((doc) => typeof doc.cover_i === 'number');
  if (match?.cover_i === undefined) return null;

  const coverUrl = `https://covers.openlibrary.org/b/id/${match.cover_i}-L.jpg`;
  const bytes = await withTimeout(coverUrl, 'buffer');
  if (bytes === null || typeof bytes === 'string') return null;

  // Open Library answers a missing cover with a 1x1 rather than a 404.
  if (bytes.length < 3_000) {
    log.debug(`cutouts: Open Library has no real cover for "${query}"`);
    return null;
  }
  return { url: coverUrl, bytes };
}

async function withTimeout(url: string, want: 'text'): Promise<string | null>;
async function withTimeout(url: string, want: 'buffer'): Promise<Buffer | null>;
async function withTimeout(url: string): Promise<string | null>;
async function withTimeout(
  url: string,
  want: 'text' | 'buffer' = 'text',
): Promise<string | Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COVER_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'BreezeMatic/0.1 (local video tool)' },
    });
    if (!response.ok) return null;
    return want === 'buffer'
      ? Buffer.from(await response.arrayBuffer())
      : await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------------- keying -- */

/**
 * What a subject is drawn on, and the instructions that keep it keyable.
 *
 * Appended rather than left to the sentence the writer produced, because the
 * background is not a creative decision here -- it is the thing that has to be
 * exactly one flat colour for the next step to work at all.
 */
const ISOLATION =
  'Isolated on a completely flat, uniform chroma-key green background (#00B140), ' +
  'filling the frame edge to edge behind the subject. No scenery, no floor, no horizon, ' +
  'no cast shadow on the background, no green light spilling onto the subject. ' +
  'Even, soft studio lighting. The entire subject is inside the frame with a small margin ' +
  'of green on every side. Sharp focus, clean silhouette.';

/**
 * Key out the green and trim to what is left.
 *
 * The trim is the half that makes it read as a cutting. Keyed and untrimmed,
 * the subject sits inside a large transparent rectangle, and every rule about
 * where the cutout goes and how big it is ends up describing the empty box
 * instead of the person -- so a figure asked to stand two-thirds of the frame
 * high arrives a third of that, floating, in the wrong place.
 */
type Rgb = { r: number; g: number; b: number };

/**
 * The average colour of a small patch in each corner of the drawing.
 *
 * Corners because the prompt asks for a margin of backdrop on every side, so
 * they are the only part of the frame the subject is asked to stay out of.
 */
async function corners(file: string): Promise<Rgb[]> {
  const spots: [string, string][] = [
    ['0', '0'],
    ['iw-24', '0'],
    ['0', 'ih-24'],
    ['iw-24', 'ih-24'],
  ];
  const found: Rgb[] = [];

  for (const [x, y] of spots) {
    const raw = `${file}.px`;
    // Averaged down to one pixel, so a little ink texture in the backdrop
    // does not decide the answer.
    await ffmpeg([
      '-i', file,
      '-vf', `crop=24:24:${x}:${y},scale=1:1`,
      '-frames:v', '1',
      '-pix_fmt', 'rgb24',
      '-f', 'rawvideo',
      raw,
    ]);
    const bytes = fs.readFileSync(raw);
    fs.rmSync(raw, { force: true });
    found.push({ r: bytes[0] ?? 0, g: bytes[1] ?? 0, b: bytes[2] ?? 0 });
  }
  return found;
}

const distance = (a: Rgb, b: Rgb): number =>
  Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

/**
 * The backdrop's actual colour, or null when there isn't one.
 *
 * Three of the four corners have to agree before this will call anything a
 * backdrop. That is the check that still catches the real failure -- a drawing
 * with a room behind the subject -- now that a merely wrong shade of green no
 * longer counts as one. And it has to be green: a subject on a grey studio
 * sweep is not a cutting, and keying grey out of an inked drawing would eat
 * every shadow in it.
 */
function backdrop(
  found: readonly Rgb[],
  mode: 'green' | 'plain' = 'green',
): { hex: string; why?: undefined } | { hex?: undefined; why: string } {
  let best: Rgb[] = [];
  for (const anchor of found) {
    const near = found.filter((other) => distance(anchor, other) <= CORNER_TOLERANCE);
    if (near.length > best.length) best = near;
  }
  if (best.length < 3) {
    return { why: 'the corners of the drawing do not agree, so there is no flat backdrop' };
  }

  const mean: Rgb = {
    r: Math.round(best.reduce((sum, c) => sum + c.r, 0) / best.length),
    g: Math.round(best.reduce((sum, c) => sum + c.g, 0) / best.length),
    b: Math.round(best.reduce((sum, c) => sum + c.b, 0) / best.length),
  };

  if (mode === 'green' && (mean.g - mean.r < 25 || mean.g - mean.b < 25)) {
    const shown = `#${[mean.r, mean.g, mean.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    return { why: `the backdrop is ${shown}, which is not a green screen` };
  }

  const hex = `0x${[mean.r, mean.g, mean.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return { hex };
}

type Keyed = { ok: true } | { ok: false; why: string };

const capitalise = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * The cast member a cutout names, matched loosely.
 *
 * The two writers do not agree on names: one says "Gregor Samsa", the other
 * "Gregor"; one "The Narrator", the other "the narrator". A shared word of
 * four letters or more is enough, because casts are small and their names are
 * distinct.
 */
function castFor(
  cast: readonly { name: string; look: string }[],
  name: string,
): { name: string; look: string } | undefined {
  // The same rule as the sheets, so a cutting's description and its drawing
  // can never be of two different people.
  return cast.find((member) => sameCharacter(member.name, name));
}

/**
 * Keys a plain backdrop by colour distance rather than by chroma.
 *
 * `chromakey` compares hue and saturation only, which is right for a vivid
 * green screen and wrong for everything else: a muted or pale backdrop has
 * almost no chroma, so it sits next to every grey and brown in the figure and
 * the key takes those too. Measured on a sage-green backdrop behind a figure in
 * grey: `chromakey` cleared 100% of the frame, figure included. `colorkey`
 * works in RGB, where the backdrop and the dress differ in brightness even
 * when they share a hue -- 66% to 75% cleared, flat across tolerances from
 * 0.08 to 0.20, which is the sign that it stopped at the figure's edge.
 */
const PLAIN_SIMILARITY = 0.12;
const PLAIN_BLEND = 0.06;

/**
 * More than this cleared and the key took the subject with it. A cutting is a
 * figure on a backdrop; a frame that is almost entirely backdrop afterwards is
 * a frame that had no figure left in it.
 */
const MAX_KEYED_SHARE = 94;

async function keyAndTrim(
  source: string,
  destination: string,
  mode: 'green' | 'plain' = 'green',
): Promise<Keyed> {
  const measured = backdrop(await corners(source), mode);
  if (measured.hex === undefined) return { ok: false, why: measured.why };

  const keyed = `${destination}.keyed.png`;
  await ffmpeg([
    '-i', source,
    '-vf',
    mode === 'green'
      ? `chromakey=${measured.hex}:${KEY_SIMILARITY}:${KEY_BLEND},` +
          'despill=type=green:mix=0.5:expand=0.35,format=rgba'
      : `colorkey=${measured.hex}:${PLAIN_SIMILARITY}:${PLAIN_BLEND},format=rgba`,
    '-frames:v', '1',
    keyed,
  ]);

  /**
   * Did the key actually do anything?
   *
   * `blackframe` reports the share of pixels below a threshold, and run over
   * the alpha channel that is exactly the share of the frame that became
   * transparent. It is the only evidence available that the background was
   * the colour we asked for, and it costs one more pass over a single still.
   */
  let cleared = 0;
  try {
    const { stderr } = await ffmpeg([
      '-i', keyed,
      '-vf', 'format=rgba,alphaextract,blackframe=amount=0:threshold=32',
      '-frames:v', '1',
      '-f', 'null', '-',
    ]);
    cleared = Number(/pblack:(\d+)/.exec(stderr)?.[1] ?? '0');
  } catch (error) {
    log.debug(`cutouts: could not measure the key (${(error as Error).message})`);
  }

  if (cleared < MIN_KEYED_SHARE) {
    fs.rmSync(keyed, { force: true });
    return {
      ok: false,
      why: `the key cleared only ${cleared}% of the frame, so it was not drawn on green`,
    };
  }
  if (cleared > MAX_KEYED_SHARE) {
    fs.rmSync(keyed, { force: true });
    return {
      ok: false,
      why: `the key cleared ${cleared}% of the frame, which means it took the subject too`,
    };
  }

  /**
   * cropdetect reads luminance, so the alpha channel is handed to it as a
   * picture. Black is transparent, white is the subject, and the bounding box
   * of the bright part is exactly the bounding box of the cutting.
   */
  let crop = '';
  try {
    const { stderr } = await ffmpeg([
      '-i', keyed,
      '-vf', // skip=0 because cropdetect ignores the first two frames by default, and
      // a still image has exactly one -- so it measured nothing at all and
      // silently reported no crop, leaving every cutting untrimmed.
      'alphaextract,cropdetect=mode=black:limit=24:round=2:reset=0:skip=0',
      '-frames:v', '1',
      '-f', 'null', '-',
    ]);
    crop = /crop=(\d+:\d+:\d+:\d+)/.exec(stderr)?.[1] ?? '';
  } catch (error) {
    log.debug(`cutouts: could not measure the cutting (${(error as Error).message})`);
  }

  if (crop === '') {
    fs.renameSync(keyed, destination);
    return { ok: true };
  }

  const [width = 0, height = 0] = crop.split(':').map(Number);
  if (Math.max(width, height) < MIN_EDGE_PX) {
    fs.rmSync(keyed, { force: true });
    return { ok: false, why: `what survived the key is only ${width}x${height}` };
  }

  await ffmpeg(['-i', keyed, '-vf', `crop=${crop}`, '-frames:v', '1', destination]);
  fs.rmSync(keyed, { force: true });
  return { ok: true };
}

/**
 * The paper edge round a cut-out figure, as a share of its height: about
 * seven pixels on a figure standing half the frame tall at 720p. Enough to
 * read as scissors, not so much it reads as a sticker sheet.
 */
const PAPER_EDGE = 0.018;

/**
 * The local model first, the colour key only if it cannot run.
 *
 * The model finds the subject whatever it stands on, which is what the key
 * could never do: it failed on every photoreal figure, and on any figure that
 * shared a colour with its backdrop. The key stays as the fallback for a
 * machine where the model has not been fetched yet and cannot be.
 */
async function cutOut(source: string, destination: string, mode: 'green' | 'plain'): Promise<Keyed> {
  const cut = await cutOutSubject(source, destination, { border: PAPER_EDGE });
  if (cut.ok) return { ok: true };
  if (cut.why.startsWith('the cutout model could not run')) {
    log.debug(`cutouts: ${cut.why}; keying by colour instead`);
    return keyAndTrim(source, destination, mode);
  }
  return { ok: false, why: cut.why };
}

/* ------------------------------------------------------------------ plan --- */

/**
 * Keyed subjects are PNG because they carry alpha; covers are the JPEG bytes
 * Open Library served, and naming those `.png` left the renderer relying on
 * content sniffing to display them.
 */
function nameFor(seed: string, extension: 'png' | 'jpg' = 'png'): string {
  const key = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 20);
  return `cut-${key}.${extension}`;
}

/**
 * Where each cutting is pasted, and how it arrives.
 *
 * Sides are decided by what is already on screen rather than by alternation
 * alone: a cutting that joins another takes the other side, so two people
 * named together stand on either side of the frame together. The rest is
 * variety -- size, height, lean and the way it arrives -- drawn from the seed,
 * because the same rise on the same side at the same size five times in a row
 * is what made the cuttings read as one photo pasted over and over.
 *
 * The lean always tips the top of the figure toward the middle of the frame:
 * two cuttings leaning away from each other read as two stickers, leaning in
 * they read as a pair.
 */
const ENTRANCES = ['rise', 'slide', 'drop', 'flip'] as const;

function placement(
  index: number,
  kind: CutoutKind,
  side: 'left' | 'right',
  seed: number,
  previous: Cutout['entrance'] | undefined,
): Pick<Cutout, 'side' | 'tilt' | 'scale' | 'entrance' | 'lift'> {
  const roll = (salt: number): number => {
    const x = Math.sin((seed % 100_000) * 0.013 + index * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const lean = 1.5 + roll(1) * 2.8;
  const tilt = (side === 'right' ? -1 : 1) * lean;
  const base = kind === 'book' ? 0.4 : kind === 'object' ? 0.44 : kind === 'person' ? 0.54 : 0.6;
  const scale = base + (roll(2) - 0.5) * 0.1;
  const lift = 0.26 + roll(3) * 0.06;
  // Never the same way in twice running.
  const choices = ENTRANCES.filter((entrance) => index === 0 || entrance !== (previous ?? 'rise'));
  const entrance = kind === 'book' ? 'drop' : (choices[Math.floor(roll(4) * choices.length)] ?? 'rise');
  return { side, tilt, scale, lift, entrance };
}

/** Where a phrase is spoken, start and end, at or after a moment. */
function findSpan(
  words: readonly { text: string; startMs: number; endMs: number }[],
  phrase: string,
  afterMs = 0,
): { startMs: number; endMs: number } | null {
  const wanted = phrase.split(/\s+/).map(normalise).filter((word) => word !== '');
  if (wanted.length === 0) return null;
  const heard = words.map((word) => normalise(word.text));
  for (let start = 0; start + wanted.length <= heard.length; start++) {
    if (words[start]!.startMs < afterMs) continue;
    let hit = true;
    for (let offset = 0; offset < wanted.length; offset++) {
      if (heard[start + offset] !== wanted[offset]) {
        hit = false;
        break;
      }
    }
    if (hit) return { startMs: words[start]!.startMs, endMs: words[start + wanted.length - 1]!.endMs };
  }
  return null;
}

const sameSubject = (a: Planned, b: Planned): boolean =>
  a.kind === b.kind &&
  (a.kind === 'character' || a.kind === 'person'
    ? sameCharacter(a.name, b.name)
    : normalise(a.name) === normalise(b.name));

const fingerprintOf = (bytes: Buffer): string =>
  crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16);

/**
 * Subjects to paste over the essay, timed to the words that name them.
 *
 * Never throws into the pipeline. Every path out of here that fails returns
 * fewer cutouts, because the video without them is the video this tool made
 * last week and it was fine.
 */
export async function planCutouts(options: {
  /** The picture writer's cast, so a cutting matches the frames around it. */
  cast?: readonly { name: string; look: string }[];
  /** Reference sheets, so a cutting of a character is that character. */
  sheets?: readonly Sheet[];
  /** What a drawn cutting is made of, so it matches the pictures under it. */
  medium?: string;
  /**
   * Which kinds may be pasted; all of them when absent. The cinematic look
   * used to allow only the book, because a photographic figure would not
   * colour-key -- it punched holes through the faces. The local cutout model
   * does not have that problem, so the restriction is gone.
   */
  kinds?: readonly CutoutKind[];
  /**
   * Real people shown by their real portraits from Wikimedia Commons. Off,
   * or when no openly licensed portrait exists, they are drawn like a
   * character.
   */
  realSources?: boolean;
  /**
   * The picture engine chosen for the video. 'flux' is the cheap one, and a
   * character with a sheet is then cut from the sheet rather than redrawn in a
   * new pose -- free, but the same drawing each time, mirrored for variety.
   */
  engine?: 'flux' | 'gemini' | 'mixed';
  title: string;
  book: string;
  author: string;
  prose: string;
  words: readonly { text: string; startMs: number; endMs: number }[];
  durationMs: number;
  count: number;
  seed: number;
  force?: boolean;
}): Promise<CutoutPlan> {
  if (options.count <= 0) return EMPTY;

  let planned: Planned[];
  try {
    planned = await writePlan({
      title: options.title,
      book: options.book,
      author: options.author,
      prose: options.prose.slice(0, 12_000),
      count: options.count,
      seed: options.seed,
      castNames: (options.cast ?? []).map((member) => member.name.trim()),
    });
  } catch (error) {
    // The cover below does not depend on the writer, so it still comes.
    log.warn(`cutouts: choosing subjects failed (${(error as Error).message}); only the cover`);
    planned = [];
  }
  if (options.kinds !== undefined) {
    const allowed = options.kinds;
    planned = planned.filter((item) => allowed.includes(item.kind));
  }

  /* -- when ------------------------------------------------------------- */

  /**
   * On from the words that name it, off when the talk about it ends.
   *
   * A fixed three seconds meant a person named at the start of a sentence
   * about them had gone before the sentence was over. The writer now says
   * where the talk about each subject ends; where that cannot be found in
   * the audio, a default hold stands in.
   */
  type Timed = Planned & { startMs: number; endMs: number; side: 'left' | 'right' };
  const candidates: (Planned & { startMs: number; endMs: number; must?: boolean })[] = [];
  let unplaced = 0;

  for (const item of planned) {
    const span = findSpan(options.words, item.phrase);
    if (span === null) {
      unplaced++;
      continue;
    }
    // The last seconds are the outro; a face arriving there is a jump scare.
    if (span.startMs > options.durationMs - MIN_HOLD_MS - 2_000) continue;
    let endMs = span.startMs + HOLD_MS;
    const until = item.until?.trim() ?? '';
    if (until !== '') {
      const stop = findSpan(options.words, until, span.startMs);
      if (stop !== null) endMs = stop.endMs + 350;
    }
    endMs = Math.max(span.startMs + MIN_HOLD_MS, Math.min(span.startMs + MAX_HOLD_MS, endMs));
    candidates.push({ ...item, startMs: span.startMs, endMs: Math.min(options.durationMs - 500, endMs) });
  }
  /**
   * The cover, always.
   *
   * A channel about books shows the book. Left to the writer it was chosen in
   * some videos and not in others -- a Jujutsu Kaisen video went out with
   * seven characters pasted over it and never once the manga -- so when the
   * plan has no cover, one is added: at the first time the title is spoken
   * after the title card, or a tenth of the way in if it never is. It is fetched
   * like any cover, so a book with no real cover on record still gets none;
   * an invented cover is worse than a missing one.
   */
  const wantsCover = options.kinds === undefined || options.kinds.includes('book');
  if (wantsCover && options.book.trim() !== '' && !candidates.some((item) => item.kind === 'book')) {
    const title = options.book
      .split(/\s+/)
      .map(normalise)
      .filter((word) => word !== '' && !['the', 'a', 'an'].includes(word))
      .slice(0, 3)
      .join(' ');
    const spoken = title === '' ? null : findSpan(options.words, title, COVER_EARLIEST_MS);
    const fallback = options.words.find((word) => word.startMs >= Math.max(COVER_EARLIEST_MS, options.durationMs * 0.1));
    const startMs = spoken?.startMs ?? fallback?.startMs;
    if (startMs !== undefined && startMs < options.durationMs - MIN_HOLD_MS - 2_000) {
      candidates.push({
        phrase: '',
        until: '',
        kind: 'book',
        name: options.book,
        look: '',
        pose: '',
        startMs,
        endMs: Math.min(options.durationMs - 500, startMs + COVER_HOLD_MS),
        must: true,
      });
      log.info(`cutouts: the cover of ${options.book} at ${Math.round(startMs / 1000)}s${spoken === null ? '' : ', where the title is said'}`);
    }
  }
  candidates.sort((a, b) => a.startMs - b.startMs);

  /**
   * Two at most, side by side.
   *
   * A second subject named while the first is still up joins it on the other
   * side instead of replacing it -- Victor on the left, Reed arriving on the
   * right -- which is the difference between a list of faces and a picture of
   * two people in the same story. A third makes the oldest leave, from the
   * side the newcomer takes. The same subject named again while it is still
   * up simply stays longer.
   */
  const timed: Timed[] = [];
  let lastSide: 'left' | 'right' = 'left';
  for (const item of candidates) {
    const up = timed.filter((other) => other.endMs > item.startMs);
    const again = up.find((other) => sameSubject(other, item));
    if (again !== undefined) {
      again.endMs = Math.max(again.endMs, item.endMs);
      continue;
    }
    const previous = timed[timed.length - 1];
    // The cover is never crowded out: it waits its turn instead.
    const nudge = (earliest: number): void => {
      const hold = item.endMs - item.startMs;
      item.startMs = earliest;
      item.endMs = Math.min(options.durationMs - 500, earliest + hold);
    };
    if (previous !== undefined && item.startMs - previous.startMs < MIN_ARRIVAL_GAP_MS) {
      if (item.must !== true) continue;
      nudge(previous.startMs + MIN_ARRIVAL_GAP_MS);
    }

    let side: 'left' | 'right';
    if (up.length >= 2) {
      const oldest = [...up].sort((a, b) => a.startMs - b.startMs)[0]!;
      if (item.startMs - oldest.startMs < MIN_SHOWN_MS) {
        if (item.must !== true) continue;
        nudge(oldest.startMs + MIN_SHOWN_MS);
      }
      oldest.endMs = item.startMs;
      side = oldest.side;
    } else if (up.length === 1) {
      side = up[0]!.side === 'left' ? 'right' : 'left';
    } else {
      side = lastSide === 'left' ? 'right' : 'left';
    }
    lastSide = side;
    timed.push({ ...item, side });
  }

  if (unplaced > 0) {
    log.info(`cutouts: ${unplaced} subject(s) named words that were never spoken; dropped`);
  }
  if (timed.length === 0) {
    log.info('cutouts: nothing landed on a real moment; going without');
    return EMPTY;
  }

  /* -- what ------------------------------------------------------------- */

  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const cutouts: Cutout[] = [];
  const covers: { name: string; url: string }[] = [];
  const portraits: CommonsImage[] = [];
  let generated = 0;
  let usd = 0;
  const engine = options.engine ?? 'mixed';
  const canReference = engine !== 'flux' && canDrawWithReferences();
  /** How many times each subject has been pasted so far, for picking a different take. */
  const seen = new Map<string, number>();
  const appearance = (item: Planned): number => {
    const key = `${item.kind}|${normalise(item.name)}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count;
  };
  let previousEntrance: Cutout['entrance'];

  /**
   * One figure drawn on a plain ground, checked, and cut out.
   *
   * Drawn by the reference model when a sheet has to be matched (and for
   * everything, when it is the chosen engine); by flux otherwise, on green,
   * because the cheap model honours a plain ground less reliably than a green
   * one. Either way the picture is looked at before it is cut: a cutting with
   * six fingers is pasted over the frame at half its height, and there is
   * nowhere for the mistake to hide.
   */
  const drawFigure = async (job: {
    label: string;
    prompt: string;
    brief: string;
    must: string;
    reference?: Sheet['reference'];
    useGemini: boolean;
    seed: number;
    destination: string;
  }): Promise<boolean> => {
    if (job.useGemini) {
      let chosen: string;
      try {
        chosen = await drawChecked({
          label: `cutout ${job.label}`,
          brief: job.brief,
          must: job.must,
          draw: async (fix, take) => {
            const asked = `${job.prompt}${fix}`;
            const { path: drawn, hit } = await cache.file(
              'cutout-draw',
              {
                prompt: asked,
                take,
                model: IMAGE_MODEL,
                ref: job.reference === undefined ? 'none' : fingerprintOf(job.reference.bytes),
              },
              '.png',
              async (destination) => {
                const result = await drawImage({
                  prompt: asked,
                  references: job.reference === undefined ? [] : [job.reference],
                  aspectRatio: '3:4',
                  detail: `cutout: ${job.label}${take > 0 ? ' (redraw)' : ''}`,
                });
                fs.writeFileSync(destination, result.bytes);
              },
            );
            if (hit !== true) {
              generated += 1;
              usd += APPROX_USD_PER_IMAGE;
            }
            return { file: drawn, fresh: hit !== true };
          },
        });
      } catch (error) {
        log.info(`cutouts: ${job.label} could not be drawn (${(error as Error).message})`);
        return false;
      }
      const cut = await cutOut(chosen, job.destination, 'plain');
      if (!cut.ok) log.info(`cutouts: ${job.label} would not cut out (${cut.why})`);
      return cut.ok;
    }

    if (!canGenerate()) return false;
    /**
     * Three attempts, each looked at and then cut. Measured over seven
     * subjects, a single flux draw came back without its green ground about
     * two times in five; a draw that shows the wrong thing is now a failed
     * attempt too, and the next one is told what was wrong.
     */
    let fix = '';
    for (const attempt of [0, 1, 2]) {
      const raw = `${job.destination}.raw.png`;
      const tried = (job.seed + attempt * 104_729) >>> 0;
      const prompt = `${job.prompt} ${ISOLATION}${fix}`;
      const result = await generateImage({ prompt, seed: tried, width: env.FLUX_WIDTH, height: env.FLUX_HEIGHT });
      fs.writeFileSync(raw, result.bytes);
      generated += 1;
      usd += MODELS.image.usdPerImage;

      const verdict = await checkPicture({ file: raw, brief: job.brief, must: job.must });
      if (!verdict.ok) {
        fix = correction(verdict.problems);
        fs.rmSync(raw, { force: true });
        log.info(`cutouts: ${job.label} redrawn — ${verdict.problems.join('; ')}`);
        continue;
      }
      const keyed = await cutOut(raw, job.destination, 'green');
      if (keyed.ok) {
        fs.rmSync(raw, { force: true });
        return true;
      }
      const kept = path.join(IMAGE_DIR, `${path.basename(job.destination)}.unkeyed-${attempt}.png`);
      fs.renameSync(raw, kept);
      log.info(`cutouts: ${job.label} came back unkeyable — ${keyed.why}; the drawing is at ${path.basename(kept)}`);
    }
    return false;
  };

  for (const [index, item] of timed.entries()) {
    const place = placement(cutouts.length, item.kind, item.side, options.seed, previousEntrance);
    const common = {
      kind: item.kind,
      name: item.name,
      startMs: item.startMs,
      endMs: item.endMs,
      ...place,
    };
    const push = (file: string, extra: Partial<Cutout> = {}): void => {
      cutouts.push({ file, ...common, ...extra });
      previousEntrance = place.entrance;
    };
    const take = appearance(item);
    const pose = item.pose?.trim() ?? '';
    // Looking into the frame: a figure on the right faces left.
    const facing =
      item.side === 'right'
        ? 'The figure is turned three-quarters toward the left side of the picture.'
        : 'The figure is turned three-quarters toward the right side of the picture.';

    try {
      if (item.kind === 'book') {
        const file = nameFor(`cover|${item.name}|${options.author}`, 'jpg');
        const destination = path.join(IMAGE_DIR, file);

        if (options.force === true || !fs.existsSync(destination)) {
          const cover = await fetchCover(item.name, options.author);
          if (cover === null) {
            log.info(`cutouts: no cover found for "${item.name}"; dropped`);
            continue;
          }
          fs.writeFileSync(destination, cover.bytes);
          covers.push({ name: item.name, url: cover.url });
          log.info(`cutouts: cover for "${item.name}" — ${cover.url}`);
        }
        push(file);
        continue;
      }

      /**
       * A real person, by their real portrait -- and by a different one each
       * time they come back, where Commons has more than one that is surely
       * them. Never mirrored: a real face flipped is a small falsehood, and
       * any writing in the picture reads backwards.
       */
      if (item.kind === 'person' && options.realSources !== false) {
        const found = await portraitsOf(item.name).catch(() => [] as CommonsImage[]);
        const shift = found.length === 0 ? 0 : take % found.length;
        const ordered = [...found.slice(shift), ...found.slice(0, shift)];
        let placed = false;
        for (const portrait of ordered) {
          const file = nameFor(`portrait|${portrait.file}`);
          const destination = path.join(IMAGE_DIR, file);
          if (options.force === true || !fs.existsSync(destination)) {
            const cut = await cutOutSubject(path.join(IMAGE_DIR, portrait.file), destination, {
              border: PAPER_EDGE,
            });
            if (!cut.ok) log.info(`cutouts: ${item.name}'s portrait would not cut out (${cut.why})`);
          }
          if (fs.existsSync(destination)) {
            log.info(`cutouts: ${item.name} from their portrait — ${portrait.title}`);
            if (!portraits.some((have) => have.file === portrait.file)) portraits.push(portrait);
            push(file);
            placed = true;
            break;
          }
        }
        if (placed) continue;
      }

      /**
       * The cast's description where there is one.
       *
       * The cutout writer and the picture writer each described Gregor
       * independently, so the Gregor pasted over the frame and the Gregor in
       * the frame were two different drawings of two different ideas of him.
       * The picture writer's cast is the canonical one; the cutting borrows it.
       */
      const member = castFor(options.cast ?? [], item.name);
      const look = member === undefined ? item.look.trim() : `${member.name}: ${member.look.trim()}`;
      const medium = capitalise(options.medium ?? ILLUSTRATION_MEDIUM);
      const must =
        item.kind === 'object'
          ? 'one single object, whole and inside the frame, alone on a plain empty background, no scenery'
          : 'one single person, the whole figure visible from head to foot, alone on a plain empty ' +
            'background, no scenery and no other people';
      const brief =
        `${item.name}. ${look}${pose === '' ? '' : ` Pose: ${pose}.`} ` +
        `(From "${options.book}" by ${options.author}.)`;
      const sheet = item.kind === 'character' ? findSheet(options.sheets ?? [], item.name) : undefined;
      const seed = (options.seed + index * 6151) >>> 0;

      /**
       * A character with a sheet, redrawn in this moment's pose.
       *
       * Cutting the sheet itself was free and exact, and it was the complaint:
       * the same standing drawing every time the character was named. Shown
       * the sheet, the reference model draws the same person doing what the
       * narration says they are doing, facing into the frame.
       */
      if (sheet !== undefined && canReference) {
        const file = nameFor(`pose|${fingerprintOf(sheet.reference.bytes)}|${pose}|${item.side}|${seed}`);
        const destination = path.join(IMAGE_DIR, file);
        if (options.force === true || !fs.existsSync(destination)) {
          const prompt =
            `The ${sheet.name} in the reference image is a recurring character. Draw the same ` +
            `${sheet.name} -- the same face, hair, build, clothes and colours -- as one full-length ` +
            `figure, head to foot${pose === '' ? '' : `: ${pose}`}. ${facing} ${medium}. ` +
            'Alone on a completely plain, flat, pale background: no scenery, no floor, no cast ' +
            'shadow, no text. The whole figure inside the frame with a margin on every side. ' +
            `Only one ${sheet.name}.`;
          await drawFigure({
            label: sheet.name,
            prompt,
            brief,
            must,
            reference: sheet.reference,
            useGemini: true,
            seed,
            destination,
          });
        }
        if (fs.existsSync(destination)) {
          log.info(`cutouts: ${item.name}${pose === '' ? '' : ` — ${pose}`}`);
          push(file);
          continue;
        }
      }

      /**
       * The sheet itself, when redrawing is off or failed: identical to every
       * panel by construction, and free. Mirrored on alternate appearances, so
       * it is at least not the same image twice running.
       */
      if (sheet !== undefined) {
        const file = nameFor(`sheet|${fingerprintOf(sheet.reference.bytes)}`);
        const destination = path.join(IMAGE_DIR, file);
        if (options.force === true || !fs.existsSync(destination)) {
          const raw = `${destination}.raw.png`;
          fs.writeFileSync(raw, sheet.reference.bytes);
          const keyed = await cutOut(raw, destination, 'plain');
          fs.rmSync(raw, { force: true });
          if (!keyed.ok) log.info(`cutouts: ${sheet.name}'s sheet would not cut out (${keyed.why})`);
        }
        if (fs.existsSync(destination)) {
          log.info(`cutouts: ${item.name} cut from their sheet`);
          push(file, { mirror: take % 2 === 1 });
          continue;
        }
      }

      /**
       * Everything else is drawn from its description. A real person without
       * an openly licensed portrait goes to the reference model when it is on,
       * because it knows what a famous face looks like where flux guesses.
       */
      const file = nameFor(`subject|${item.name}|${look}|${pose}|${item.side}|${seed}|${PROMPT_VERSION}`);
      const destination = path.join(IMAGE_DIR, file);
      if (options.force === true || !fs.existsSync(destination)) {
        const who =
          item.kind === 'person' ? `${item.name}, the real historical person, drawn as they really looked. ` : '';
        const useGemini = canReference && (engine === 'gemini' || item.kind === 'person');
        // The ground first for flux: it weights the front of a prompt hardest,
        // and said last, the green screen was ignored often enough to matter.
        const prompt =
          `${medium}, showing a single ${item.kind === 'object' ? 'object' : 'figure'} and nothing else` +
          `${useGemini ? '. ' : ', against a solid chroma-green screen. '}` +
          `${who}${look}${pose === '' ? '' : ` ${capitalise(pose)}.`}` +
          `${item.kind === 'object' ? '' : ` Whole figure, head to foot. ${facing}`}`;
        const ok = await drawFigure({
          label: item.name,
          prompt: useGemini
            ? `${prompt} Alone on a completely plain, flat, pale background: no scenery, no floor, ` +
              'no shadow, no text. Entirely inside the frame with a margin on every side.'
            : prompt,
          brief,
          must,
          useGemini,
          seed,
          destination,
        });
        if (!ok) {
          log.info(`cutouts: "${item.name}" dropped`);
          continue;
        }
        log.info(`cutouts: drew ${item.name}${pose === '' ? '' : ` — ${pose}`}`);
      }
      push(file);
    } catch (error) {
      log.warn(`cutouts: "${item.name}" failed (${(error as Error).message}); dropped`);
    }
  }

  const together = cutouts.filter((cut, i) =>
    cutouts.some((other, j) => j !== i && other.startMs < cut.endMs && cut.startMs < other.endMs),
  ).length;
  log.info(
    `cutouts: ${cutouts.length} pasted over the essay` +
      `${together > 0 ? `, ${together} of them sharing the screen` : ''}`,
  );
  return { cutouts, covers, portraits, generated, usd };
}
