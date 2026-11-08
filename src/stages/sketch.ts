import fs from 'node:fs';
import path from 'node:path';
import { cache } from '../cache.js';
import { MODELS, env } from '../config.js';
import { log } from '../log.js';
import { generateImage, isConfigured } from '../providers/flux.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import { IMAGE_DIR } from './images.js';

/**
 * The drawing for a whiteboard beat, as an illustration rather than a pictogram.
 *
 * The icon set carries a beat well enough to say what it is about, but a
 * twenty-four pixel glyph is not what the format is known for — the videos
 * people mean by "whiteboard" have a real drawing appearing under the hand. So
 * where an image model is configured, each beat gets one: black ink on white,
 * no shading, no colour.
 *
 * It is not traced into paths. The obvious library for that, potrace, is
 * GPL-2.0, which is not a licence to bundle into something being sold, and
 * tracing line art is the wrong shape of answer anyway: it outlines each stroke
 * rather than following it, so the pen runs up one side and back down the
 * other, and the path data for a detailed drawing would be larger than the rest
 * of the beat sheet put together. It is revealed instead, which is what the
 * commercial tools do with their own detailed art.
 *
 * The prompt is doing real work. Anything that admits grey, texture or a filled
 * background stops looking like a drawing on paper the moment it is revealed on
 * one, so the instruction is negative as much as positive.
 */

const WIDTH = 1024;
const HEIGHT = 1024;

const PROMPT_VERSION = 2;

/**
 * Appended to every prompt however it was written. These were arrived at by
 * looking at what came back — signatures, captions, emblems with lettering
 * arched over them — and they stay on this side of the call: a prompt writer
 * asked to include them tends to describe them instead of obeying them.
 */
const GUARDS = [
  'Flat black ink line drawing on pure white.',
  'No shading, no hatching, no grey, no colour, no background scenery,',
  'no border, no frame, no shadow, unlabelled and unsigned.',
].join(' ');

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    hand: { type: 'string' },
    prompts: { type: 'array', items: { type: 'string' } },
  },
  required: ['hand', 'prompts'],
};

/**
 * Gemini writes the drawing prompts, because it can read what a beat is about
 * and this file cannot.
 *
 * Stripping stopwords out of a line and handing the remainder to an image model
 * gets a picture of the words rather than of the idea: "everyone involved was
 * killed to protect it" reduces to "everyone involved killed protect", which is
 * not a thing anyone can draw. Naming the subject is a reading task, and the
 * writer that produced the script is already holding the whole script.
 *
 * It also fixes the other half. Twenty beats drawn from twenty independent
 * prompts look like twenty different illustrators; one shared hand, decided
 * once and appended to each, makes them a set.
 */
function buildPromptRequest(topic: string, script: string, beats: readonly string[]): string {
  const listed = beats.map((text, i) => `${i + 1}. ${text === '' ? '(skip)' : text}`).join('\n');
  const fence = '"'.repeat(3);

  return `A whiteboard-style short about "${topic}" needs ${beats.length} drawings.

Here is the whole narration:
${fence}
${script}
${fence}

It is divided into ${beats.length} beats, in order. Each gets one drawing:
${listed}

First decide the hand, then write the prompts.

The hand:
- One sentence of 10 to 20 words fixing what every drawing shares: stroke weight, how much detail, how figures are treated.
- Description, not commentary. "Thick even marker strokes, rounded corners, simplified figures without faces" - never "the style is...". It is appended to every prompt and drawn literally.
- No mention of artists, software, or resolution.

Each prompt:
1. Exactly ${beats.length} prompts, one per beat, same order. For a beat marked (skip), return an empty string.
2. 8 to 20 words. Name one concrete object, action or scene that stands for what the beat says.
3. Draw the idea, not the sentence. A beat about a secret being kept is a padlock, a sealed door, a finger to the lips - never the words themselves.
4. It must work as a flat black-ink line drawing. No abstractions, no diagrams, no charts, no arrows, no labels.
5. One subject per drawing, centred, filling the frame. No scenery behind it, no ground line, no border.
6. Never text, letters, numerals, signatures or symbols-that-are-writing. This rules out whole subjects, not just captions on them: no map, calendar, book, page, sign, banner, screen, poster, scroll, letter, newspaper, certificate, plaque, gravestone, label, ticket, coin face, flag or numbered clock. Anything a viewer would expect writing on is banned even if you do not ask for the writing, because the model will add it. Draw what is on the map instead of the map.
7. No recognisable real person, and no character from any published fiction, film or game. Use anonymous figures, hands, silhouettes, animals, objects, places.
8. All ${beats.length} drawings differ from one another. No two share a subject.
9. Subject only. Do not describe strokes, ink, line art, contrast, shading, colour or background in a prompt — the hand is appended to all of them and saying it twice is what makes a prompt drift.
10. Present tense, plain English, no metaphor spelled out.

Return only the JSON object.`;
}

/**
 * "no mention of style inside a prompt" is the one rule the writer will not
 * keep. Measured on a twenty-beat sheet: twenty of twenty prompts ended with
 * their own style clause, which then got the hand appended after it, so every
 * prompt described its stroke weight twice in slightly different words.
 *
 * So it is taken off here rather than asked for. Trailing comma-clauses are
 * dropped while they are about how the thing is drawn instead of what it is.
 */
const STYLE_WORDS =
  /\b(marker|line ?art|lineart|linework|stroke|strokes|ink|inked|shading|shaded|hatching|contrast|monochrome|black and white|greyscale|grayscale|minimal(ist)?|flat|clean|crisp|bold|thick|thin|even|uniform|consistent|rounded|simplified|detail|weight|negative space|sketch(y)?|drawing|illustration|doodle|outline[sd]?|silhouettes|white background|no faces?|vector|clipart|clip art)\b/i;

function subjectOnly(prompt: string): string {
  const parts = prompt.replace(/\.\s*$/, '').split(/\s*,\s*/);
  // Short and about the drawing rather than the thing. The length cap is what
  // keeps a real trailing clause -- "with no one wearing it" -- off the pile.
  const isStyle = (clause: string): boolean =>
    clause.split(/\s+/).length <= 6 && STYLE_WORDS.test(clause);
  while (parts.length > 1 && isStyle(parts[parts.length - 1]!)) parts.pop();
  const kept = parts.join(', ').trim();
  return kept === '' ? prompt : `${kept}.`;
}

/**
 * One drawing prompt per beat, written by the model that wrote the script.
 * Falls back to the mechanical prompt when there is no key or the call fails:
 * a worse drawing is better than no drawing.
 */
async function writePrompts(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
}): Promise<string[]> {
  const plain = options.beatTexts.map((line) =>
    line.trim() === '' ? '' : promptFor(options.topic, line),
  );
  if (env.GEMINI_API_KEY === undefined) {
    log.info('sketch: no key for prompt writing; describing the beats plainly');
    return plain;
  }

  try {
    const { value } = await cache.json<{ hand: string; prompts: string[] }>(
      'sketch-prompts',
      {
        v: PROMPT_VERSION,
        model: MODELS.llm.script,
        topic: options.topic,
        script: options.script,
        seed: options.seed,
        count: options.beatTexts.length,
      },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction:
            'You direct the drawings for whiteboard explainer videos. You return JSON and ' +
            'nothing else. No preamble, no markdown, no code fences.',
          prompt: buildPromptRequest(options.topic, options.script, options.beatTexts),
          temperature: 0.7,
          seed: toInt32Seed(options.seed),
          maxOutputTokens: 4096,
          responseSchema: RESPONSE_SCHEMA,
        });
        return JSON.parse(response.text) as { hand: string; prompts: string[] };
      },
    );

    const hand = value.hand.trim();
    log.info(`sketch: hand - ${hand}`);

    return options.beatTexts.map((line, index) => {
      if (line.trim() === '') return '';
      const written = value.prompts[index]?.trim();
      if (written === undefined || written === '') return plain[index] ?? '';
      // The negatives stay ours. They were arrived at by watching what came
      // back, and a prompt writer asked to include them tends to describe them.
      return `${subjectOnly(written)} ${hand} ${GUARDS}`;
    });
  } catch (error) {
    log.warn(`sketch: prompt writing failed (${(error as Error).message}); describing plainly`);
    return plain;
  }
}

/**
 * The subject, not the sentence. Handing the model a line of narration
 * complete with its question mark invites it to letter the line into the
 * picture, which is exactly what it did.
 */
function subjectOf(line: string): string {
  return line
    .replace(/[?!.,;:"'()]/g, ' ')
    .replace(/\b(and|but|so|then|that|which|what|why|how|when|if|is|are|was|were|has|have|had|been|the|a|an|of|to|in|on|for|with|it|its|his|her|their|they|we|you)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function promptFor(topic: string, line: string): string {
  /**
   * It is not a drawing. Every word for one — drawing, illustration, sketch,
   * artwork — describes a thing an artist made, and the images behind those
   * words are signed, captioned and titled, so the model supplies a signature
   * and a caption along with the picture. That is where the stray marks were
   * coming from, and no amount of "no text" removes them, because schnell is
   * distilled and takes no negative prompt.
   *
   * Three wordings measured, on the same beat and seed:
   *
   *   "hand-drawn whiteboard explainer illustration"  -> two gibberish sentences
   *   "rubber stamp or pictorial road sign"           -> one stray word
   *   "public signage symbol, airport wayfinding"     -> a circular emblem with
   *                                                     "GENGHIS KHAN'S" arched
   *                                                     over the top of it
   *
   * The third was an attempt to escape signed artwork and went the wrong way:
   * signs and seals are labelled by definition, so it swapped one textual
   * category for a worse one. The second is what is here. Wording moves this
   * but does not settle it, and the remaining fixes are not prompt-shaped --
   * a model that takes a real negative prompt, or a detect-and-retry pass.
   */
  return [
    `A minimal black ink line drawing of ${subjectOf(line)}.`,
    `Subject matter: ${topic}.`,
    'Drawn as a single wordless pictogram in the style of a rubber stamp or a',
    'pictorial road sign: one clear subject, silhouette-simple, centred, with',
    'plenty of empty white around it.',
    'Even-weight black strokes. Flat and wordless.',
    GUARDS,
  ].join(' ');
}

/**
 * One drawing per beat, in beat order, with null where none could be made.
 * Never throws into the pipeline: a whiteboard beat with no drawing is still a
 * whiteboard beat, and the icon underneath it is a fair second choice.
 */
export async function generateSketches(options: {
  topic: string;
  beatTexts: readonly string[];
  seed: number;
  force: boolean;
  /** The whole narration, so the prompts can be about the idea of each beat. */
  script?: string;
}): Promise<(string | null)[]> {
  const none = options.beatTexts.map(() => null);
  if (!isConfigured()) {
    log.info('sketch: no image model configured, beats will draw their icon instead');
    return none;
  }

  cache.setForce(options.force);
  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  const written = await writePrompts({
    topic: options.topic,
    script: options.script ?? options.beatTexts.join(' '),
    beatTexts: options.beatTexts,
    seed: options.seed,
  });

  const out: (string | null)[] = [];
  for (const [index, line] of options.beatTexts.entries()) {
    // Empty means this beat shows no drawing, so there is nothing to pay for.
    if (line.trim() === '') {
      out.push(null);
      continue;
    }
    const prompt = written[index] ?? promptFor(options.topic, line);
    // Per beat, so one failure does not cost the whole set.
    const seed = options.seed + index * 1013;
    try {
      const { path: cached } = await cache.file(
        'whiteboard-sketch',
        { prompt, seed, model: env.FLUX_MODEL, size: `${WIDTH}x${HEIGHT}` },
        '.jpg',
        async (destination) => {
          const result = await generateImage({ prompt, seed, width: WIDTH, height: HEIGHT });
          fs.writeFileSync(destination, result.bytes);
        },
      );

      // Copied under public/ because that is what the renderer can reach.
      const file = `sketch-${path.basename(cached)}`;
      const served = path.join(IMAGE_DIR, file);
      if (!fs.existsSync(served)) fs.copyFileSync(cached, served);
      out.push(file);
    } catch (error) {
      log.warn(`sketch: beat ${index + 1} failed (${(error as Error).message}); using its icon`);
      out.push(null);
    }
  }

  log.info(`sketch: ${out.filter((f) => f !== null).length}/${out.length} beats drew an illustration`);
  return out;
}
