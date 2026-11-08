import fs from 'node:fs';
import path from 'node:path';
import { MODELS, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import { generateImage, isConfigured } from '../providers/flux.js';
import { IMAGE_DIR, GENERATED_LICENCE } from './images.js';
import type { CommonsImage } from './images.js';
import crypto from 'node:crypto';
import {
  drawImage,
  canDrawWithReferences,
  IMAGE_MODEL,
  APPROX_USD_PER_IMAGE,
} from '../providers/geminiimage.js';
import { sheetFor, type Sheet } from './characters.js';
import { drawChecked } from './picturecheck.js';

/**
 * Illustrated storybook panels: one drawn scene per beat, with the same
 * character in all of them.
 *
 * The character is the whole point, and it is what separates this from the
 * existing generated-image path. That one writes a shared "look" so twenty
 * pictures feel like one set — a style, not a cast. A story needs a person: the
 * boy in the green jacket in panel three has to be the boy in the green jacket
 * in panel eleven, or it is a slideshow of related images rather than a story.
 *
 * So the model writes a cast description once, and it is pasted verbatim into
 * every prompt. That is as far as this can go honestly: schnell is distilled
 * and takes no reference image, so consistency comes from words alone. Hair,
 * clothing and palette hold well across a set; a face does not. The style is
 * chosen to suit that — flat cartoon shapes, where a face is three marks and
 * there is little for the model to drift on.
 */

const WIDTH = 832;
const HEIGHT = 1472;
const PROMPT_VERSION = 5;

/** Appended to every panel, on this side of the call. */
const GUARDS = [
  'No text, no letters, no numbers, no speech bubbles, no captions,',
  'no watermark, no signature, no logo, no borders, no panel frames.',
].join(' ');

/**
 * What each named style asks the image model for.
 *
 * Written as a direction an illustrator could follow rather than as a label,
 * because that is what reaches FLUX: "anime" alone means whatever the training
 * data averaged, and the average is a glossy character portrait rather than a
 * scene. Each of these names the line, the colour and the level of detail, so
 * the style survives being drawn twenty times.
 */
export const ART_DIRECTION: Record<string, string> = {
  flat:
    'Flat vector cartoon illustration: thick even outlines, large areas of solid ' +
    'colour, simple rounded shapes, minimal shading, faces reduced to a few marks.',
  watercolour:
    'Soft watercolour storybook illustration: visible paper texture, gentle washes ' +
    'bleeding at the edges, light ink linework over the colour, muted natural palette.',
  anime:
    'Anime cel illustration: clean confident linework, flat cel shading with hard ' +
    'shadow edges, expressive eyes, restrained background detail, bright clear colour.',
  comic:
    'Western comic book illustration: heavy inked outlines, dramatic angles, bold ' +
    'primary colour, halftone dot shading, strong black shadow shapes.',
  manga:
    'Black and white manga panel: clean confident linework of varying weight, screentone ' +
    'dots and gradients for the greys, dramatic speed lines and deep blacks, expressive ' +
    'faces, fine hatching for shadow, no colour at all, no speech bubbles or lettering.',
  pencil:
    'Pencil and ink illustration: graphite hatching, visible sketch lines left in, ' +
    'limited colour used only as an accent wash, plenty of white paper showing.',
  painterly:
    'Rich painted illustration: soft edges, no outlines, visible brush strokes, ' +
    'warm directional light, deep saturated colour, painterly atmosphere.',
  retro:
    'Mid-century print illustration: limited palette of three or four flat inks, ' +
    'slight misregistration, grainy overprinted textures, simplified geometric shapes.',
};

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    cast: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, look: { type: 'string' } },
        required: ['name', 'look'],
        propertyOrdering: ['name', 'look'],
      },
    },
    look: { type: 'string' },
    book: { type: 'string' },
    panels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          moment: { type: 'string' },
          scene: { type: 'string' },
          who: { type: 'string' },
        },
        required: ['scene', 'who'],
        propertyOrdering: ['moment', 'scene', 'who'],
      },
    },
  },
  required: ['cast', 'look', 'panels'],
  propertyOrdering: ['book', 'cast', 'look', 'panels'],
};

/** One recurring figure: what to call them, and what they look like. */
export type CastMember = { name: string; look: string };

/**
 * Which model draws the pictures.
 *
 *   flux    every picture from words. A third of a cent each; a face drifts.
 *   gemini  every picture by the model that can be shown a reference, and
 *           every character drawn from their sheet. About four cents each.
 *   mixed   the reference model only where a face is close enough to be
 *           recognised, FLUX for the rest -- wide shots, places, objects,
 *           where a figure is small enough that drift cannot be seen.
 */
export type ImageEngine = 'flux' | 'gemini' | 'mixed';

/**
 * Close enough that a face is readable, which is where drift shows.
 *
 * Read from the scene the writer produced, because the writer is told to say
 * how close every panel is. A wide shot with a silhouette in it does not need
 * the expensive model; the same character in a close-up does.
 */
function isCloseShot(scene: string): boolean {
  if (/\b(wide|long|distant|aerial|establishing|far|over[- ]the[- ]shoulder|from behind|silhouette)\b/i.test(scene)) {
    return false;
  }
  /*
   * Close-ups and waist-up shots only. "Medium" and "mid-shot" were in this
   * list and should not have been: on a 16:9 frame they keep a face small
   * enough that a word-drawn one does not visibly drift. With them in, mixed
   * sent five of six essay panels to the expensive model -- which is not a
   * mix, it is the expensive model with extra steps.
   */
  return /\b(close|close-up|closeup|waist|waist-up|portrait|face|head and shoulders|bust)\b/i.test(scene);
}

/**
 * How a caller other than a vertical short wants its panels.
 *
 * The book essays reuse this stage because it is the one that draws the story
 * rather than the mood of it. Asked to illustrate The Metamorphosis, the essay
 * image stage wrote twenty-three prompts and not one of them showed the
 * insect -- a coin purse, some boots, an empty bowl, a steam train, "a large
 * dark shape behind a curtain" -- while a short on the same book, through
 * this stage, drew "a monstrous insect face with multifaceted eyes". The
 * difference is the cast: this stage decides who the story is about and puts
 * them in the picture.
 */
export type PanelFrame = {
  width: number;
  height: number;
  orientation: 'landscape' | 'portrait';
  /** What the video is, for the writer: "long-form video essay". */
  kind: string;
  /** The fixed medium, put first in every prompt. */
  medium: string;
};

type Written = {
  /** The published work the video is about, by its own title. */
  book?: string;
  cast: CastMember[];
  look: string;
  panels: { scene: string; who: string; moment?: string }[];
};

function buildRequest(
  topic: string,
  script: string,
  beats: readonly string[],
  art: string,
  frame?: PanelFrame,
  /** The passage of the book each beat is about, where there is one. */
  passages: readonly (string | null)[] = [],
  source?: { title: string; author: string },
): string {
  // Beats that already carry a photograph are marked rather than dropped: the
  // model needs the whole story to write a cast that holds across it, and a
  // list with holes in it silently renumbers everything after the first hole.
  /**
   * Each beat, and under it the passage of the book that beat is about.
   *
   * This is the difference between a picture of a scene and a picture of the
   * scene. Given the narration alone, "before Gregor became a bug he was
   * already living like one" becomes an invented man in an invented bed. The
   * page says what the room holds, what the weather is doing and what he can
   * see from where he lies, and a drawing made from that is recognisably the
   * book a viewer has read.
   */
  const listed = beats
    .map((text, i) => {
      const head = `${i + 1}. ${text === '' ? '(skip)' : text}`;
      const passage = passages[i];
      return passage === undefined || passage === null || text === ''
        ? head
        : `${head}\n   FROM THE BOOK: ${passage}`;
    })
    .join('\n');
  const fence = '"'.repeat(3);

  const style = frame === undefined ? ART_DIRECTION[art] : frame.medium;
  return `An illustrated ${frame?.kind ?? 'short'} about "${topic}" needs ${beats.length} panels, like a picture book read aloud.

Here is the whole narration:
${fence}
${script}
${fence}

The ${beats.length} beats, in order:
${listed}

Decide the cast, then the look, then write the panels.

First, "book": the title of the published book, film or series this video is about, exactly as
it is published and nothing else -- "The Metamorphosis", not "The Real Horror of The
Metamorphosis". Empty if the video is not about one.

The cast — one to four figures, in "cast". Each has a "name" and a "look". Use each character's
full name as the story gives it -- "Gregor Samsa", not "Gregor".

The "name" is whatever the narration calls them. If this video is about a story that has
characters in it, use their actual names. Otherwise invent a plain label — "the reader",
"the engineer" — for whoever appears throughout.

The "look" is two or three sentences of pure visual description, and getting this right is
the whole job. The illustrator has never heard of this character, cannot look anything up,
and will draw exactly and only what your sentences say. Everything that makes them
recognisable on sight has to be in there:

- Hair: colour, length, and how it sits. "Spiky blond hair standing up in points", not "messy hair".
- Face: eye colour and shape, skin tone, age, and any marking — scars, whiskers, freckles, a tattoo.
- Build and height.
- Clothing: the colours first, then the shapes. A named garment means nothing; "a bright
  orange jacket with a high black collar and a round red spiral on the back" means something.
- Anything they always carry or wear: a headband, goggles, a weapon, glasses, a cloak.

Write it so that somebody who knows this character would recognise the drawing, and somebody
who does not would still draw the same person twice. Describe appearance only — no history,
no personality, no powers, nothing that cannot be seen in a still picture.

The look — one sentence of 10 to 25 words:
${
  style === undefined
    ? `- The illustration style every panel shares: line quality, how colour is used, how much detail, the palette.
- Flat, drawn and simple beats painterly and intricate here: it has to survive being redrawn twenty times.`
    : `- The style is already decided, and it is this: ${style}
- Your sentence adds only what suits this particular subject — the weather, the period, the time of day. Do not change the medium, the linework, the palette or the level of detail.`
}
- No artist names, no software names, no resolution.

Each panel:
1. Exactly ${beats.length} panels, one per beat, same order. For a beat marked (skip), return an empty "scene" and an empty "who": that beat already has a picture and is not being drawn.
2. "scene" is 12 to 30 words: what is happening in the frame, where it is, and what the figure is doing.
3. "who" is the name of the one cast member in that panel, spelled exactly as you spelled it in "cast". Their description gets pasted into the prompt, so refer to them in the scene as "he", "she" or "they" rather than repeating what they look like. Leave "who" empty for a panel with nobody in it — a landscape, an object, a place.
4. ${
    frame?.orientation === 'landscape'
      ? 'Widescreen 16:9 framing, and say how close. Put the subject in the upper two thirds and keep the bottom third of the frame quiet — captions sit there.'
      : 'Vertical framing, and say how close.'
  } Vary it across the panels; twenty mid shots in a row is a slideshow.
${
    frame === undefined
      ? ''
      : `11. When the story is about a character, show that character. If the protagonist is not human — an insect, an animal, a creature, a machine — draw them as what they are, plainly and often. Hinting at them with shadows, silhouettes behind curtains, or objects they left behind is the failure this rule exists for: a video about a man turned into an insect in which the insect is never shown.
12. Most panels have somebody in them. Empty rooms and still-lifes are allowed for at most one panel in five.`
  }
5. Frame away from what the model draws badly. Hands and full figures are where it fails — a whole body at a distance comes back with the wrong number of fingers, an arm growing from a hip, a leg ending in a hand. So:
   - Prefer waist-up, over-the-shoulder, from behind, or the figure small and far in a landscape.
   - Where hands matter, put them holding one large simple object, or out of frame.
   - A wide shot is for a place. If the panel is wide, the figure is a silhouette in it, not the subject of it.
6. A moment, not a summary. The character doing one thing in one place. Name it in "moment":
   the scene as a reader would refer to it — "Gregor first sees his own body", "the chief clerk
   flees down the stairs". Where a beat is about an idea rather than a scene, choose the scene
   from the story that shows that idea, and draw that scene.
${
    source === undefined
      ? ''
      : `6b. Beats marked FROM THE BOOK carry the passage of ${source.title} they are about. Where
   one is given, the panel shows THAT moment, and every detail in it comes from the passage
   rather than from your own idea of the scene: the same room, the same objects, the same
   weather, the same time of day, the same posture. If the passage says rain is beating on the
   window panes, it is raining in the picture. A viewer who has read the book can tell.
`
  }
7. No text, signs, screens, books or anything lettered — the model draws gibberish on them.
8. The panels you do write differ in place, action or framing. No two are the same picture.
9. Do not restate the cast or the look inside a scene. Both are added to every panel afterwards, and repeating them costs you words you need for the action.
10. Keep one figure per panel. Two described characters in one prompt is where the illustrator blends them into one person wearing half of each outfit.

Return only the JSON object.`;
}

/** The cast, the look, and one panel description per beat. */
async function writePanels(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
  art: string;
  frame?: PanelFrame;
  /** What the book says about each beat, where the book could be read. */
  passages?: readonly (string | null)[];
  source?: { title: string; author: string };
}): Promise<Written> {
  const fallback: Written = {
    cast: [],
    look:
      ART_DIRECTION[options.art] ??
      'flat cartoon illustration, clean outlines, soft muted colour, simple shapes, little detail',
    panels: options.beatTexts.map((line) => ({ scene: line.trim(), who: '' })),
  };

  if (env.GEMINI_API_KEY === undefined) {
    log.info('storybook: no key for panel writing; drawing the beat lines plainly');
    return fallback;
  }

  try {
    const { value } = await cache.json<Written>(
      'storybook-panels',
      {
        v: PROMPT_VERSION,
        model: MODELS.llm.script,
        topic: options.topic,
        script: options.script,
        seed: options.seed,
        count: options.beatTexts.length,
        art: options.art,
        ...(options.frame === undefined
          ? {}
          : { frame: `${options.frame.orientation}|${options.frame.kind}|${options.frame.medium}`, v2: 3 }),
        // Panels written from the book are different panels, so they cache apart.
        ...((options.passages ?? []).some((passage) => passage !== null)
          ? { grounded: (options.passages ?? []).map((passage) => (passage === null ? 0 : 1)).join('') }
          : {}),
      },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction:
            'You art-direct illustrated short videos. You return JSON and nothing else. ' +
            'No preamble, no markdown, no code fences.',
          prompt: buildRequest(
            options.topic,
            options.script,
            options.beatTexts,
            options.art,
            options.frame,
            options.passages ?? [],
            options.source,
          ),
          temperature: 0.75,
          seed: toInt32Seed(options.seed),
          // A short has a dozen panels; a long essay can have two hundred, and
          // 4096 tokens truncates the JSON a third of the way through them.
          maxOutputTokens: Math.min(32_768, 2_048 + options.beatTexts.length * 90),
          responseSchema: RESPONSE_SCHEMA,
        });
        return JSON.parse(response.text) as Written;
      },
    );

    for (const member of value.cast) {
      log.info(`storybook: ${member.name.trim()} — ${member.look.trim()}`);
    }
    log.info(`storybook: look — ${value.look.trim()}`);
    /**
     * The moments, in the log, because this is the one thing worth reading
     * before a video is drawn: twenty lines saying which scene each picture
     * is, where a wrong one is obvious at a glance and costs nothing to fix.
     */
    const grounded = (options.passages ?? []).filter((passage) => passage !== null).length;
    if (grounded > 0) {
      log.info(`storybook: ${grounded} panel(s) written from the book itself`);
    }
    for (const [i, panel] of (value.panels ?? []).entries()) {
      const moment = (panel.moment ?? '').trim();
      if (moment !== '') log.info(`storybook: ${i + 1}. ${moment}`);
    }
    return value;
  } catch (error) {
    log.warn(`storybook: panel writing failed (${(error as Error).message}); drawing plainly`);
    return fallback;
  }
}

/**
 * One illustration per beat. Never throws into the pipeline: a panel that fails
 * leaves the beat without a picture rather than taking the video down.
 */
export async function generatePanels(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
  force: boolean;
  /** A key from ART_STYLES; "auto" lets the writer choose. */
  art?: string;
  /** Shape, size and medium for a caller that is not a vertical short. */
  frame?: PanelFrame;
  /**
   * The book the characters belong to, which turns on character memory:
   * each cast member is drawn once as a reference sheet and every panel they
   * appear in is drawn from it. Absent, panels are drawn from words alone.
   *
   * A fallback only. The writer names the book itself, and that name wins,
   * because what a caller has is often a video title -- and memory keyed on a
   * title is memory for one video.
   */
  memory?: string;
  /** Kept apart per look, since a reference drawing is a style reference too. */
  memoryVariant?: string;
  /** Which model draws. Defaults to gemini when there is a memory, flux without. */
  engine?: ImageEngine;
  /**
   * The passage of the book each beat is about, in the same order as the
   * beats, with null where the beat is about no particular scene. Given
   * these, panels are drawn from the page rather than from the narration's
   * impression of it.
   */
  passages?: readonly (string | null)[];
  /** The book those passages come from, for the writer to be told. */
  source?: { title: string; author: string };
}): Promise<{
  images: (CommonsImage | null)[];
  usd: number;
  cast: CastMember[];
  sheets: Sheet[];
}> {
  const none = options.beatTexts.map(() => null);
  if (!isConfigured()) {
    log.warn('storybook: no image model configured; this mode has nothing to draw with');
    return { images: none, usd: 0, cast: [], sheets: [] };
  }
  const width = options.frame?.width ?? WIDTH;
  const height = options.frame?.height ?? HEIGHT;

  cache.setForce(options.force);
  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  const written = await writePanels({ ...options, art: options.art ?? 'auto' });
  const look = written.look.trim();
  /**
   * The cast, by name, so a panel can say who is in it.
   *
   * There used to be one anonymous figure for the whole video, and for a video
   * about a story with more than one person in it that was never right: the
   * beat about the mentor and the beat about the student were drawn as the
   * same stranger.
   */
  const cast = new Map(
    written.cast
      .filter((member) => member.name.trim() !== '' && member.look.trim() !== '')
      .map((member) => [member.name.trim().toLowerCase(), member]),
  );

  const out: (CommonsImage | null)[] = [];
  let spent = 0;

  /**
   * One sheet per cast member, drawn the first time they are needed.
   *
   * Lazily, so a character the writer listed but never put in a panel is not
   * drawn at all, and memoised, so forty panels of Gregor cost one sheet.
   */
  const sheets = new Map<string, Sheet | null>();
  const medium = options.frame?.medium.replace(/[.\s]+$/, '') ?? '';
  const engine: ImageEngine = options.engine ?? (options.memory !== undefined ? 'gemini' : 'flux');
  const canReference = options.frame !== undefined && canDrawWithReferences();
  const useMemory = options.memory !== undefined && canReference && engine !== 'flux';
  let byGemini = 0;
  let byFlux = 0;

  /**
   * The folder a cast lives in: the book the writer named, not the video.
   *
   * Pasted scripts arrive with only a title, so the key used to be "The Real
   * Horror of The Metamorphosis" -- and the next video on the same book, under
   * any other title, drew a new Gregor. The writer knows which book it just
   * read.
   */
  const memoryKey =
    `${(written.book ?? '').trim() || options.memory || ''}` +
    `${options.memoryVariant === undefined || options.memoryVariant === '' ? '' : ` ${options.memoryVariant}`}`;

  /**
   * In flight as well as finished.
   *
   * Panels are drawn several at a time, and two of them wanting the same
   * character at the same moment would each find no sheet on record and each
   * draw one -- the same person, twice, at four cents a time, with the second
   * overwriting the first. Sharing the promise means the first asker draws and
   * the rest wait for it.
   */
  const drawing = new Map<string, Promise<Sheet | null>>();

  async function sheetOf(member: CastMember): Promise<Sheet | null> {
    const key = member.name.trim().toLowerCase();
    if (sheets.has(key)) return sheets.get(key) ?? null;
    const already = drawing.get(key);
    if (already !== undefined) return already;
    const started = drawOneSheet(member, key);
    drawing.set(key, started);
    return started;
  }

  async function drawOneSheet(member: CastMember, key: string): Promise<Sheet | null> {
    let sheet: Sheet | null = null;
    try {
      sheet = await sheetFor({
        book: memoryKey,
        name: member.name.trim(),
        look: member.look.trim(),
        medium,
      });
    } catch (error) {
      log.warn(
        `storybook: could not draw a reference for ${member.name} ` +
          `(${(error as Error).message}); their panels fall back to words`,
      );
    }
    sheets.set(key, sheet);
    return sheet;
  }

  /**
   * One panel, drawn.
   *
   * Pulled out of the loop so several can be in flight at once: every one of
   * them is a request to somebody else's machine, and waiting for them one at
   * a time was the single slowest stretch of making a video that was not the
   * render. Forty-six panels at five seconds each is four minutes of doing
   * nothing.
   */
  const drawPanel = async (index: number, line: string): Promise<CommonsImage | null> => {
    if (line.trim() === '') {
      return null;
    }
    const panel = written.panels[index];
    const scene = panel?.scene.trim() ?? line.trim();
    /**
     * The name as well as the description. The description is what carries a
     * character the image model has never seen; the name is free, and where the
     * model does know one it pulls the drawing closer than words alone can.
     */
    const member = cast.get((panel?.who ?? '').trim().toLowerCase());
    const who =
      member === undefined ? '' : `${member.name.trim()}: ${member.look.trim()} `;
    // Medium first where the caller fixed one: said last, it loses to the scene.
    const lead = medium === '' ? '' : `${medium}. `;
    const prompt = `${lead}${scene} ${who}${look} ${GUARDS}`;
    // Per beat, so one failure costs one panel rather than the whole set.
    const seed = options.seed + index * 1013;
    /**
     * What the picture is checked against once drawn: the scene, who is in
     * it, and the words of the book it illustrates. Style is left out on
     * purpose -- the check is for what is wrong, not for what is ugly.
     */
    const moment = (panel?.moment ?? '').trim();
    const brief =
      `${scene}${who === '' ? '' : ` Character: ${who.trim()}`}` +
      `${moment === '' ? '' : ` The moment in the book: "${moment}"`}`;

    /**
     * A panel with a character in it is drawn from their sheet.
     *
     * The sheet is shown to the model and the scene is described around it,
     * so what carries from panel to panel is the drawing itself rather than a
     * paragraph about it. Anything that goes wrong here drops back to the
     * words-only path below rather than losing the panel.
     */
    const wantsGemini =
      canReference &&
      (engine === 'gemini' ||
        (engine === 'mixed' && member !== undefined && isCloseShot(scene)));
    const sheet =
      wantsGemini && useMemory && member !== undefined ? await sheetOf(member) : null;
    if (wantsGemini) {
      try {
        const framing =
          options.frame?.orientation === 'landscape'
            ? 'Widescreen 16:9, the subject in the upper two thirds, the bottom third of the frame quiet.'
            : '';
        const referenced =
          sheet !== null && member !== undefined
            ? `The ${member.name.trim()} in the reference image is a recurring character. Draw the ` +
              `same ${member.name.trim()} -- the same face, the same hair or shape, the same clothes ` +
              `and colours -- in this scene: ${scene} ${lead}${look} ${framing} ` +
              `Only one ${member.name.trim()} in the picture. ${GUARDS}`
            : `${lead}${scene} ${who}${look} ${framing} ${GUARDS}`;
        const fingerprint =
          sheet === null
            ? 'none'
            : crypto.createHash('sha1').update(sheet.reference.bytes).digest('hex').slice(0, 16);
        const cached = await drawChecked({
          label: `panel ${index + 1}`,
          brief,
          draw: async (fix, take) => {
            const asked = `${referenced}${fix}`;
            const { path: drawnPath, hit } = await cache.file(
              'storybook-panel',
              // The first take keeps the key it always had, so pictures
              // already drawn are not drawn again.
              take === 0
                ? { prompt: referenced, seed, model: IMAGE_MODEL, sheet: fingerprint }
                : { prompt: asked, seed, model: IMAGE_MODEL, sheet: fingerprint, take },
              '.png',
              async (destination) => {
                const drawn = await drawImage({
                  prompt: asked,
                  references: sheet === null ? [] : [sheet.reference],
                  aspectRatio: options.frame?.orientation === 'landscape' ? '16:9' : '9:16',
                  detail: `panel ${index + 1}${member === undefined ? '' : `: ${member.name.trim()}`}${take > 0 ? ' (redraw)' : ''}`,
                });
                fs.writeFileSync(destination, drawn.bytes);
              },
            );
            // The running total said $0.000 for a run of eight of these.
            if (hit !== true) spent += APPROX_USD_PER_IMAGE;
            return { file: drawnPath, fresh: hit !== true };
          },
        });
        byGemini += 1;
        const file = `panel-${path.basename(cached)}`;
        const served = path.join(IMAGE_DIR, file);
        if (!fs.existsSync(served)) fs.copyFileSync(cached, served);
        return ({
          file,
          title: scene,
          author: IMAGE_MODEL,
          licence: GENERATED_LICENCE,
          source: referenced,
        });
      } catch (error) {
        log.warn(
          `storybook: panel ${index + 1} could not be drawn by the reference model ` +
            `(${(error as Error).message}); drawing it with flux`,
        );
      }
    }

    try {
      const cached = await drawChecked({
        label: `panel ${index + 1}`,
        brief,
        draw: async (fix, take) => {
          const asked = `${prompt}${fix}`;
          // A new seed as well as the correction: the same seed with a few
          // more words tends to redraw the same mistake.
          const tried = take === 0 ? seed : seed + 7919 * take;
          const { path: drawnPath, hit } = await cache.file(
            'storybook-panel',
            take === 0
              ? { prompt, seed, model: env.FLUX_MODEL, size: `${width}x${height}` }
              : { prompt: asked, seed: tried, model: env.FLUX_MODEL, size: `${width}x${height}`, take },
            '.jpg',
            async (destination) => {
              const result = await generateImage({ prompt: asked, seed: tried, width, height });
              fs.writeFileSync(destination, result.bytes);
            },
          );
          if (hit !== true) spent += env.FLUX_USD_PER_IMAGE;
          return { file: drawnPath, fresh: hit !== true };
        },
      });
      byFlux += 1;

      const file = `panel-${path.basename(cached)}`;
      const served = path.join(IMAGE_DIR, file);
      if (!fs.existsSync(served)) fs.copyFileSync(cached, served);
      return ({
        file,
        title: scene,
        author: env.FLUX_MODEL,
        licence: GENERATED_LICENCE,
        source: prompt,
      });
    } catch (error) {
      log.warn(`storybook: panel ${index + 1} failed (${(error as Error).message})`);
      return null;
    }

    return null;
  };

  /**
   * A few at a time, in order.
   *
   * Four rather than all of them: the picture services rate-limit, and a
   * burst of forty-six is how a run earns a 429 and loses panels it has
   * already paid for.
   */
  const PANELS_AT_ONCE = 4;
  const results: (CommonsImage | null)[] = new Array(options.beatTexts.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PANELS_AT_ONCE, options.beatTexts.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= options.beatTexts.length) return;
        results[index] = await drawPanel(index, options.beatTexts[index] ?? '');
      }
    }),
  );
  out.push(...results);

  const drawn = out.filter((panel) => panel !== null).length;
  log.info(`storybook: ${drawn}/${out.length} panels drawn, about $${spent.toFixed(3)}`);
  if (options.frame !== undefined) {
    log.info(`storybook: ${engine} engine — ${byGemini} by gemini, ${byFlux} by flux`);
  }
  const kept = [...sheets.values()].filter((sheet): sheet is Sheet => sheet !== null);
  if (kept.length > 0) {
    log.info(`storybook: ${kept.length} character(s) drawn from memory — ${kept.map((sheet) => sheet.name).join(', ')}`);
  }
  return { images: out, usd: spent, cast: [...cast.values()], sheets: kept };
}
