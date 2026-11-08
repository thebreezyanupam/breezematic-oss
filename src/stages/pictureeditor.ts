import { MODELS, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';

/**
 * Which picture goes behind which beat, chosen by someone who has read both.
 *
 * The stock path matches beats to pictures by search, and search answers every
 * question: "each block weighed 2.5 tons" came back as a sea cliff in Crimea,
 * "watering the sand reduced friction" as an eighteenth-century chart of the
 * Bay of Bengal. Both were genuinely what Commons returned for the words, and
 * both were in a video about the Great Pyramid. Meanwhile the topic's own
 * articles had supplied fifty pictures of the pyramids, quarries, tools and
 * Khufu, and most of them went unused.
 *
 * So for the explainer, where a wrong picture is a wrong fact, the searching
 * only gathers candidates and this decides. Commons titles are descriptive --
 * "Great Pyramid of Kheops showing entrance on north side" -- which is enough
 * for a text model to tell a picture of the subject from a picture of the
 * words. A picture of the subject reused is preferred over a stranger: the
 * second appearance of the pyramid is a cutaway, the Black Sea is an error.
 */

const EDITOR_VERSION = 2;

/** No picture more often than this: a third showing is a slideshow on a loop. */
const MAX_USES = 2;

export type Candidate = { title: string };

export async function editPictures(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  candidates: readonly Candidate[];
  seed: number;
}): Promise<(number | null)[] | null> {
  if (env.GEMINI_API_KEY === undefined || options.candidates.length === 0) return null;

  const listed = options.candidates
    .map((candidate, index) => `${index + 1}. ${candidate.title.replace(/\.(jpe?g|png|tiff?|webp)$/i, '')}`)
    .join('\n');
  const beats = options.beatTexts.map((text, index) => `${index + 1}. ${text}`).join('\n');

  try {
    const { value } = await cache.json<{ picks: { beat: number; picture: number }[] }>(
      'picture-editor',
      { v: EDITOR_VERSION, model: MODELS.llm.script, topic: options.topic, beats: options.beatTexts, candidates: listed, seed: options.seed },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction:
            'You are the picture editor on a factual explainer video. You only put a picture on screen ' +
            'if it shows what the narration is about. You return JSON and nothing else.',
          prompt: `The video is about: ${options.topic}

Narration, cut into beats:
${beats}

Candidate pictures, by their archive titles:
${listed}

Choose a picture for every beat.
Rules:
1. The picture must show the video's subject or the specific thing the beat names (a person, place, object, tool, process). Judge by what the title says the picture is.
2. Never choose a picture of something unrelated that merely shares a word with the beat: a different place, era, country or object is wrong, however close the words. A picture of a different lake, river, salt flat, mountain or city is wrong even if it looks similar.
3. When the subject is a named place or thing, most beats should show that place or thing itself. A beat about a general process (evaporation, pressure) still takes a picture of the subject if no picture shows that process at the subject.
4. Prefer a picture that matches the beat's own content; otherwise use the best general picture of the subject.
5. Use each picture at most ${MAX_USES} times, and not on two beats in a row. Reuse a picture of the subject before choosing an unrelated one.
6. Use 0 only if no candidate shows anything connected to the subject.

Return {"picks": [{"beat": 1, "picture": n}, ...]} with exactly ${options.beatTexts.length} entries.`,
          temperature: 0.2,
          seed: toInt32Seed(options.seed),
          maxOutputTokens: 4000,
          responseSchema: {
            type: 'object',
            properties: {
              picks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { beat: { type: 'integer' }, picture: { type: 'integer' } },
                  required: ['beat', 'picture'],
                },
              },
            },
            required: ['picks'],
          },
        });
        return JSON.parse(response.text) as { picks: { beat: number; picture: number }[] };
      },
    );

    const byBeat = new Map<number, number>();
    for (const pick of Array.isArray(value.picks) ? value.picks : []) {
      if (Number.isInteger(pick.beat) && !byBeat.has(pick.beat)) byBeat.set(pick.beat, pick.picture);
    }

    // The limits are checked, not trusted: overuse and back-to-back repeats
    // fall back to null, and the caller fills those from the subject pool.
    const uses = new Map<number, number>();
    let previous: number | null = null;
    const picks = options.beatTexts.map((_, index): number | null => {
      const chosen = byBeat.get(index + 1);
      if (chosen === undefined || !Number.isInteger(chosen) || chosen < 1 || chosen > options.candidates.length) {
        previous = null;
        return null;
      }
      const at = chosen - 1;
      if ((uses.get(at) ?? 0) >= MAX_USES || at === previous) {
        previous = null;
        return null;
      }
      uses.set(at, (uses.get(at) ?? 0) + 1);
      previous = at;
      return at;
    });
    log.info(`pictures: the editor placed ${picks.filter((pick) => pick !== null).length}/${picks.length} beats from ${options.candidates.length} candidates`);
    return picks;
  } catch (error) {
    log.warn(`pictures: the editor failed (${(error as Error).message.slice(0, 120)}); placing by search order`);
    return null;
  }
}
