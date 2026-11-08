import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { MODELS, env, imageSteps } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { priceOf } from '../cost.js';
import { generate } from '../providers/gemini.js';
import { assertConfigured, generateImage, isConfigured } from '../providers/flux.js';
import {
  CLOUDFLARE_IMAGE_MODEL,
  assertConfigured as assertFreeConfigured,
  generateImage as generateFreeImage,
} from '../providers/cloudflare.js';

/** Who draws: fal (paid, any size) or Cloudflare's free plan (square, cropped to fit). */
export type ImageEngine = 'fal' | 'cloudflare';
import { IMAGE_DIR, GENERATED_LICENCE } from './images.js';
import type { BeatImage } from '../schema.js';

/**
 * Generated backgrounds. The pictures are dealt across the beats in order, so
 * one image covers a stretch of the script rather than a single card: at six
 * images and sixteen beats each one holds for about seven seconds, which reads
 * as a scene change rather than a slideshow.
 *
 * Everything here is best-effort. A short without pictures is still a short,
 * so a provider failure warns and renders the fields alone.
 */

export const PROMPT_VERSION = 4;

/**
 * The non-negotiables, appended by us rather than asked for, so a prompt that
 * drifts can never drop them. Palette and light are deliberately *not* here —
 * those come from the look line the model writes, which is what lets a set of
 * images agree with each other and with the subject at the same time.
 */
/** What every prompt ends with, whatever else it says. */
const NO_TEXT =
  'No text, no letters, no words, no numbers, no signage, no logos, no watermark, ' +
  'no signature, no border, no collage, no split screen.';

const ART_DIRECTION = `Photograph, vertical 9:16 framing. ${NO_TEXT}`;

export { NO_TEXT };

/**
 * How the picture is framed and made, when the caller has an opinion.
 *
 * It did not used to be possible to have one. Both the art direction and the
 * system instruction said "vertical" and the size came from the environment,
 * which defaults to 864x1536 -- so the long-form landscape essay was asking
 * for portrait photographs and then centre-cropping them to 16:9, throwing
 * away two thirds of every image it paid for and composing the remainder by
 * accident.
 */
export type ArtOverride = {
  /**
   * What the picture is made of, placed at the very front of every prompt.
   *
   * Front, because that is where a text-to-image model weights hardest, and
   * because the medium is the one thing that must not be negotiable. Appended
   * at the end it lost outright: asked for an inked illustration in the last
   * clause of a prompt that opened with a described scene and a photographic
   * palette, the model returned twenty-six photoreal cinematic renders.
   */
  medium: string;
  /** Replaces the trailing art direction on every prompt. */
  direction: string;
  /** How the picture is described to the prompt writer. */
  shape: string;
  /** The noun the prompt writer uses for what it is describing. */
  noun: string;
  /**
   * Whether the medium and palette are the caller's to set.
   *
   * When they are, the writer is told to keep its hands off both. The look it
   * writes is appended to every prompt, so a look that names a palette is a
   * palette instruction competing with the locked one -- and on a channel
   * whose whole premise is a fixed visual signature, the per-video sentence
   * must not be the thing that decides how the channel looks.
   */
  lockedPalette: boolean;
  width: number;
  height: number;
};

const systemInstruction = (shape: string): string => [
  `You art-direct the background stills for ${shape}, and you write the prompts a text-to-image model renders from.`,
  'That model reads plain descriptive English rather than lists of tags: it renders what a prompt states and invents whatever it leaves out, so anything that matters has to be said.',
  'The picture is never the message — large animated words are set over it — but it must be true to the line it sits under.',
  'You return JSON and nothing else. No preamble, no markdown, no code fences.',
].join(' ');

const DEFAULT_SHAPE = 'short vertical videos';

const promptsSchema = z
  .object({
    look: z.string().min(8).max(400),
    prompts: z.array(z.string().min(20).max(600)).min(1),
  })
  .passthrough();

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    look: { type: 'string' },
    prompts: { type: 'array', items: { type: 'string' } },
  },
  required: ['look', 'prompts'],
  propertyOrdering: ['look', 'prompts'],
};

export type GeneratedImages = {
  /** One entry per beat, or null where nothing usable came back. */
  images: (BeatImage | null)[];
  prompts: string[];
  /** Images actually paid for; cached files cost nothing. */
  generated: number;
  usd: number;
};

/** Beats split into as many consecutive sections as there are images. */
function sections(beatTexts: readonly string[], count: number): string[] {
  const groups: string[][] = Array.from({ length: count }, () => []);
  for (const [index, text] of beatTexts.entries()) {
    const slot = Math.min(count - 1, Math.floor((index * count) / Math.max(1, beatTexts.length)));
    groups[slot]?.push(text);
  }
  return groups.map((group) => group.join(' ').trim());
}

function buildPrompt(
  topic: string,
  script: string,
  parts: readonly string[],
  noun = 'photographs',
  lockedPalette = false,
): string {
  const listed = parts
    .map((text, index) => `${index + 1}. ${text === '' ? '(no lines)' : text}`)
    .join('\n');

  return `A video about "${topic}" needs ${parts.length} background ${noun}.

Here is the whole narration, so you know what is being claimed:
"""
${script}
"""

It is divided into ${parts.length} sections, in order. Each one gets one picture:
${listed}

First decide the look, then write the prompts.

The look:
${
    lockedPalette
      ? '- One sentence of 15 to 30 words fixing what every one of these pictures has in common:\n' +
        '  the period, the kind of place, the weather, the time of day, and the mood.\n' +
        '- The medium and the palette are already fixed and are not yours to choose. Do not name a\n' +
        '  medium, a colour, a palette, a film look or a rendering style anywhere in the look or in\n' +
        '  any prompt. Every word you write is appended to an instruction that already settles all\n' +
        '  of that, so a colour here is a second, contradictory instruction and the pictures come\n' +
        '  back as an average of the two.'
      : '- One sentence of 15 to 30 words fixing what every one of these pictures has in common: the palette, the quality and direction of the light, the period, and the kind of place.'
  }
- Take it from the subject matter. A video about Victorian railways does not look like one about deep sea fish.
- Write it as description, not as commentary about style. ${
    lockedPalette
      ? '"A humid August dusk on a wealthy shoreline, still water and long lawns" —'
      : '"Warm low sunlight on soot-stained brick and weathered wood, muted sepia palette" —'
  } never "the aesthetic features…" or "the style is…". It is appended to every prompt and rendered literally, so a sentence about the images is a sentence the model will try to draw.
- Do not mention cameras, lenses, film stock, artists, or resolution.

Each prompt:
1. Return exactly ${parts.length} prompts, one per section, in the same order.
2. 25 to 45 words of plain descriptive English — sentences, not comma-separated tags. Say the subject and what it is doing, where it is, how it is lit, and how it is framed.
3. **It must show what its own section says.** If the section names a thing, a place, a trade, a year or a number, the photograph shows that thing, in that place, in that period. Do not fall back on illustrating the topic in general — each section gets its own specific scene.
4. Name concrete things. "a brass pocket watch left open on a station bench" — not "a symbol of timekeeping". If you cannot picture it yourself, it is too vague to render.
5. Get the period and the place right. Objects, clothing, architecture and materials all have to belong to the era the narration is talking about.
6. Leave one broad calm area across the middle of the frame — open sky, a blank wall, still water, deep shadow, fog — and put the subject low, high, or to one side. Describe that area as part of the scene. Never say what it is for, and never write the word "text" or "title" or "copy space" into a prompt: every word you write is rendered.
7. No readable words or letters anywhere in the picture. Avoid scenes whose subject is inherently lettered — an open book, a newspaper, a shop front, a poster, a screen.
8. Never a named or recognisable real person. Prefer hands, backs, silhouettes at distance, objects, interiors, architecture, landscape.
9. All ${parts.length} scenes are different from each other. No two share a subject.
10. Present tense, no metaphors spelled out, no captions, no mention of the camera.
11. Do not restate the look inside a prompt. It is added to every one of them afterwards, and saying it twice is what makes an image look like a pastiche of itself.

Return only the JSON object.`;
}

function stripFences(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`model response contains no JSON object: ${raw.slice(0, 200)}`);
  }
  return text.slice(start, end + 1);
}

/** Used when nothing can write prompts for us. Plain, but it still generates. */
function fallbackPrompts(topic: string, count: number): string[] {
  const moods = [
    'an empty room at dawn, one object catching the light',
    'a close view of a worn surface, texture filling the frame',
    'a lone figure seen from behind at distance, wide empty ground',
    'hands at work on a table, everything else in shadow',
    'a window-lit interior at dusk, long shadows across the floor',
    'a horizon under heavy cloud, a single dark shape against it',
  ];
  return Array.from({ length: count }, (_unused, index) => {
    const mood = moods[index % moods.length] ?? moods[0] ?? '';
    return `A scene suggesting ${topic}: ${mood}.`;
  });
}

async function writePrompts(options: {
  topic: string;
  script: string;
  parts: readonly string[];
  seed: number;
  shape: string;
  noun: string;
  lockedPalette: boolean;
}): Promise<{ prompts: string[]; look: string; usd: number }> {
  const { topic, parts } = options;
  const plain = fallbackPrompts(topic, parts.length);

  if (env.GEMINI_API_KEY === undefined) {
    log.warn('images: no key for prompt writing; using plain prompts built from the topic');
    return { prompts: plain, look: '', usd: 0 };
  }

  type Cached = { raw: string; model: string; inputTokens: number; outputTokens: number };

  const { value, hit } = await cache.json<Cached>(
    'image-prompts',
    {
      promptVersion: PROMPT_VERSION,
      model: MODELS.llm.script,
      topic,
      script: options.script,
      seed: options.seed,
      count: parts.length,
      // Part of the key: a landscape illustration and a vertical photograph
      // are different prompts, and without this the first one written wins
      // for both.
      shape: options.shape,
      noun: options.noun,
      locked: options.lockedPalette,
    },
    async () => {
      const response = await generate({
        model: MODELS.llm.script,
        systemInstruction: systemInstruction(options.shape),
        prompt: buildPrompt(
          topic,
          options.script,
          parts,
          options.noun,
          options.lockedPalette,
        ),
        // Lower than the script stage: this is a description of something
        // specific, and invention is exactly what makes it wrong.
        temperature: 0.55,
        seed: options.seed,
        maxOutputTokens: 3072,
        responseSchema: RESPONSE_SCHEMA,
      });
      return {
        raw: response.text,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      };
    },
  );

  const usd = hit ? 0 : priceOf(value.model, value.inputTokens, value.outputTokens);
  const spent = Number.isFinite(usd) ? usd : 0;

  let written;
  try {
    written = promptsSchema.parse(JSON.parse(stripFences(value.raw)));
  } catch (error) {
    log.warn(`images: prompt writing came back unusable (${(error as Error).message})`);
    return { prompts: plain, look: '', usd: spent };
  }

  // Short of the count, the tail falls back rather than the whole set.
  const filled = plain.map((standby, index) => written.prompts[index]?.trim() ?? standby);
  return { prompts: filled, look: written.look.trim(), usd: spent };
}

/**
 * Whether a prompt has already said what the look says. Compared on the long
 * words alone: the writer tends to paraphrase rather than paste, so matching
 * the whole sentence would never fire.
 */
function repeats(prompt: string, look: string): boolean {
  if (look === '') return false;
  const words = (text: string): string[] =>
    text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((word) => word.length > 5);

  const wanted = new Set(words(look));
  if (wanted.size === 0) return false;
  const seen = new Set(words(prompt));

  let shared = 0;
  for (const word of wanted) if (seen.has(word)) shared += 1;
  return shared / wanted.size > 0.6;
}

function fileNameFor(prompt: string, seed: number, width: number, height: number, engine: ImageEngine = 'fal'): string {
  const model = engine === 'cloudflare' ? CLOUDFLARE_IMAGE_MODEL : `${env.FLUX_MODEL}|${imageSteps()}`;
  const key = crypto
    .createHash('sha256')
    .update(`${model}|${width}x${height}|${seed}|${prompt}`)
    .digest('hex')
    .slice(0, 24);
  return `ai-${key}.jpg`;
}

export async function generateBeatImages(options: {
  topic: string;
  script: string;
  seed: number;
  beatTexts: readonly string[];
  count: number;
  force: boolean;
  /** Framing, making and size, for a caller whose video is not a short. */
  art?: ArtOverride;
  /** Defaults to fal; "cloudflare" draws on the free plan instead. */
  engine?: ImageEngine;
}): Promise<GeneratedImages> {
  const none = options.beatTexts.map(() => null);
  const engine = options.engine ?? 'fal';
  if (engine === 'cloudflare') assertFreeConfigured();
  else assertConfigured();

  const count = Math.max(1, Math.min(options.count, options.beatTexts.length));
  const parts = sections(options.beatTexts, count);

  let prompts: string[];
  let look = '';
  let usd = 0;
  try {
    const written = await writePrompts({
      topic: options.topic,
      script: options.script,
      parts,
      seed: options.seed,
      shape: options.art?.shape ?? DEFAULT_SHAPE,
      noun: options.art?.noun ?? 'photographs',
      lockedPalette: options.art?.lockedPalette ?? false,
    });
    prompts = written.prompts;
    look = written.look;
    usd += written.usd;
  } catch (error) {
    log.warn(`images: prompt writing failed (${(error as Error).message})`);
    prompts = fallbackPrompts(options.topic, count);
  }
  if (look !== '') log.info(`images: look — ${look}`);

  const made: (BeatImage | null)[] = [];
  let generated = 0;

  for (const [index, prompt] of prompts.entries()) {
    // Scene, then the look they all share, then the rules none of them may
    // break. The order matters: the model weights the front of a prompt most.
    // Asked not to, the writer still sometimes ends a prompt with the look, and
    // saying it twice is worse than not saying it at all.
    const direction = options.art?.direction ?? ART_DIRECTION;
    const width = options.art?.width ?? env.FLUX_WIDTH;
    const height = options.art?.height ?? env.FLUX_HEIGHT;

    // Medium first, then the scene, then the shared look, then the rules.
    const full = [
      options.art?.medium ?? '',
      prompt,
      repeats(prompt, look) ? '' : look,
      direction,
    ]
      .filter((part) => part !== '')
      .join(' ');
    const seed = (options.seed + index * 7919) >>> 0;
    const name = fileNameFor(full, seed, width, height, engine);
    const destination = path.join(IMAGE_DIR, name);

    if (!options.force && fs.existsSync(destination)) {
      log.debug(`images: ${name} already generated`);
      made.push(asBeatImage(name, prompt));
      continue;
    }

    try {
      log.debug(`images: ${index + 1}/${prompts.length} — ${prompt}`);
      const result = await (engine === 'cloudflare' ? generateFreeImage : generateImage)({
        prompt: full,
        seed,
        width,
        height,
      });
      fs.mkdirSync(IMAGE_DIR, { recursive: true });
      fs.writeFileSync(destination, result.bytes);
      generated += 1;
      if (engine === 'fal') usd += MODELS.image.usdPerImage;
      log.info(`images: generated ${index + 1}/${prompts.length}` + (engine === 'cloudflare' ? ' (free)' : ''));
      made.push(asBeatImage(name, prompt, result.model));
    } catch (error) {
      log.warn(`images: generation ${index + 1} failed (${(error as Error).message})`);
      made.push(null);
      // The free plan's daily allowance does not come back mid-run: stop asking.
      if (engine === 'cloudflare' && /allowance used up/.test((error as Error).message)) break;
    }
  }

  if (made.every((image) => image === null)) {
    log.warn('images: nothing generated; rendering without pictures');
    return { images: none, prompts, generated, usd };
  }

  // One image covers a run of consecutive beats, in the order they were written
  // for, so the picture turns over with the argument rather than with the cut.
  const images = options.beatTexts.map((_text, index) => {
    const slot = Math.min(
      made.length - 1,
      Math.floor((index * made.length) / Math.max(1, options.beatTexts.length)),
    );
    return made[slot] ?? null;
  });

  return { images, prompts, generated, usd };
}

function asBeatImage(file: string, prompt: string, model: string = MODELS.image.model): BeatImage {
  return {
    file,
    title: prompt.length > 160 ? `${prompt.slice(0, 157)}...` : prompt,
    author: model,
    licence: GENERATED_LICENCE,
    source: '',
  };
}

export { isConfigured as canGenerateImages };
