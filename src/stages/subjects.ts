import { MODELS, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';

/**
 * Search queries for a video about a named work — a film, a series, an anime,
 * a game, a book.
 *
 * These topics were the worst-illustrated thing this tool made, and measuring
 * why was the whole of the fix. A video about Naruto searched Commons for
 * "Naruto" and came back with a Godzilla still, a photograph of Hiroshima, the
 * Wikidata logo, a bowl of ramen and Keanu Reeves — ten "usable" images, none
 * of them about the subject. Spirited Away returned one image: a logo. With
 * nothing real to show, the storybook mode drew flat cartoons of a nameless
 * man instead, which is exactly as generic as it sounds.
 *
 * The pictures were there the whole time. Nobody was asking for them:
 *
 *   "Naruto cosplay"             30 photographs, every one CC BY
 *   "Anime Expo cosplay"         39
 *   "Blade Runner filming location"  14, including the police car and the
 *                                    chairs from the set
 *   "Hayao Miyazaki"             10, with the Ghibli Museum robot
 *
 * So this is not a different library, a key, or a licence argument. It is the
 * same Commons search asking a better question.
 *
 * The question is better because it accepts what Commons is: a collection of
 * photographs that people took and licensed. It holds no frames, no stills, no
 * posters and no official character art, because none of that is freely
 * licensed and none of it ever will be. What it holds is the real world around
 * a work — the people who made it, the buildings they made it in, the places
 * it was shot, the props behind glass, and thousands of photographs of fans
 * dressed as the characters. That last one is the surprise, and it is the one
 * that carries an anime video: a cosplay photograph shows the character's
 * design, in a real photograph, under a licence that grants the use outright.
 *
 * Which is why this path needs no fair-use argument. Fair use is a defence you
 * raise after a claim; CC BY is permission you already have. The only thing it
 * asks in return is credit, and the credits file is where that goes.
 */

const PROMPT_VERSION = 3;

/** How Commons is actually indexed, in the order these are worth asking for. */
const WHAT_COMMONS_HAS = [
  '- Cosplay photographs, by character name: "naruto uzumaki cosplay", "sailor moon cosplay".',
  '  There are thousands of these from conventions and they are the single most reliable way',
  '  to show a fictional character. Name the character, then the word cosplay.',
  '- Real people, by name: the author, director, creator, composer, the actors, the voice cast.',
  '- The places it was shot, and the real places it is set. Name the place, not the scene.',
  '- Buildings: the studio, the publisher, the museum, the cinema, the theme park.',
  '- Things on public display: statues, murals, costumes and props in exhibitions, merchandise.',
  '- Conventions and premieres: "anime expo cosplay", "comic con crowd", a film festival.',
  '- For anything made before about 1930, the work itself, which is out of copyright by now.',
].join('\n');

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    work: { type: 'string' },
    names: { type: 'array', items: { type: 'string' } },
    queries: { type: 'array', items: { type: 'string' } },
  },
  required: ['work', 'names', 'queries'],
  propertyOrdering: ['work', 'names', 'queries'],
};

/**
 * A word worth anchoring a search to: two characters or more, and not a word
 * so common that matching it means nothing.
 */
const WEAK = new Set([
  'the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'to', 'is', 'it',
  'no', 'film', 'movie', 'series', 'anime', 'manga', 'game', 'book', 'show',
  'part', 'season', 'episode', 'story', 'new', 'first', 'last',
  /*
    Places and events anchor nothing on their own. "Anime Expo" is in the name
    list for good reasons -- it is where the cosplay photographs come from --
    and on its own it let through a photograph of somebody dressed as Link, who
    is from a different series entirely, in a video about Naruto. A venue is
    not a subject: what has to match is the work, a character, or a person.
  */
  'expo', 'con', 'convention', 'comic', 'festival', 'cosplay', 'cosplayer',
  'museum', 'statue', 'building', 'shrine', 'temple', 'city', 'tokyo', 'japan',
  'japanese', 'american', 'studio', 'studios',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !WEAK.has(word));
}

export type PhotoQueries = {
  /**
   * The work this topic is about, or null when it is not about one. Null is a
   * real answer and the common one: most topics here are about the world, not
   * about a published thing, and those are better served by the ordinary
   * shot-description queries.
   */
  work: string | null;
  /** One Commons query per beat, empty where the beat wants no picture. */
  queries: string[];
  /**
   * The proper nouns this video is allowed to search on, lower case. A
   * photograph is only accepted for a beat if its own title mentions one of
   * them, which is what stops a query drifting off the subject.
   */
  names: string[];
};

function buildRequest(topic: string, script: string, beats: readonly string[]): string {
  const listed = beats.map((text, i) => `${i + 1}. ${text === '' ? '(skip)' : text}`).join('\n');
  const fence = '"'.repeat(3);

  return `A vertical short about "${topic}" needs one photograph behind each beat, and they are
being searched for on Wikimedia Commons.

Here is the whole narration:
${fence}
${script}
${fence}

The ${beats.length} beats, in order:
${listed}

First, decide whether this video is about a specific named published work — a film, a
television series, an anime, a manga, a comic, a game, a book, an album. Put its title in
"work". If it is not about one — if it is about history, science, an idea, an event, a
person, or anything else — put an empty string, and do not strain to find one.

Then list, in "names", the proper nouns this video could be illustrated with: the title
itself, the characters by name, the people who made it, the studio, the real places. Ten at
most, each one a name somebody could have photographed something of.

Then write ${beats.length} Commons search queries, one per beat, in order.

Commons is photographs that people took and licensed for reuse. It does not have film
stills, screenshots, frames, posters, box art or official character artwork, and it never
will, because none of that is freely licensed. Asking for any of them returns a logo or
nothing at all. What it does have:

${WHAT_COMMONS_HAS}

So every query names a real, photographable thing. For a beat about what a character does,
ask for that character in cosplay. For a beat about how a work was made, ask for the person
who made it, or the studio. For a beat about where it happens, ask for the real place.

Rules:
1. Exactly ${beats.length} queries, same order. Empty string for a beat marked (skip).
2. Two to five words, lower case, no punctuation. Commons matches words in filenames and
   descriptions, so a sentence narrows to nothing and quietly returns something unrelated.
3. Name things. Real names are what this library is indexed by, and a vague query is what
   returns the wrong subject — "ninja village" gets a tourist attraction, "naruto uzumaki
   cosplay" gets the character.
4. Never ask for a frame, still, screenshot, poster, scene, artwork, illustration, panel or
   cover. Those are the things Commons does not have.
5. Nothing whose subject is writing: no sign, page, book cover, screen, banner or plaque.
6. Vary them. Twenty queries for the same character return the same four photographs, so
   move between the characters, the people who made it, the places and the objects.
7. Every query names something from "names". A query that names nothing is the one way this
   goes badly wrong: "japanese fox statue" returned a statue of an eighteenth-century British
   politician called Fox, and "glowing blue light" returned a photograph of a nebula. Commons
   will always match something, and without a name it matches the wrong thing.
8. If a beat is abstract and no name fits it, return an empty string. That beat gets a drawing
   instead, which is a better picture of an idea than a stranger's holiday photograph. Empty is
   a good answer and you should expect to use it several times.

Return only the JSON object.`;
}

/**
 * Per-beat Commons queries, and whether this topic is about a named work.
 *
 * Never throws into the pipeline: without a key, or on a failure, it reports
 * no work, and the caller falls back to the shot-description queries it would
 * have used before this existed.
 */
export async function writePhotoQueries(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
}): Promise<PhotoQueries> {
  const empty: PhotoQueries = { work: null, queries: options.beatTexts.map(() => ''), names: [] };

  if (env.GEMINI_API_KEY === undefined) {
    log.debug('subjects: no key for subject writing; leaving the queries to the shot writer');
    return empty;
  }

  try {
    const { value } = await cache.json<{ work: string; names: string[]; queries: string[] }>(
      'photo-subjects',
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
            'You find openly licensed photographs for short videos. You return JSON and ' +
            'nothing else. No preamble, no markdown, no code fences.',
          prompt: buildRequest(options.topic, options.script, options.beatTexts),
          temperature: 0.5,
          seed: toInt32Seed(options.seed),
          maxOutputTokens: 2048,
          responseSchema: RESPONSE_SCHEMA,
        });
        return JSON.parse(response.text) as {
          work: string;
          names: string[];
          queries: string[];
        };
      },
    );

    const work = value.work.trim();
    if (work === '') return empty;

    /**
     * The rule is enforced here as well as asked for.
     *
     * A prompt can say "name something from the work" and get "glowing blue
     * light" back anyway, and the cost of that is not a weak picture — it is a
     * confidently wrong one, because Commons always matches something. So a
     * query survives only if it mentions a name, and the ones that do not are
     * blanked rather than searched.
     */
    const names = [...new Set([...tokens(work), ...value.names.flatMap(tokens)])];
    let dropped = 0;

    const queries = options.beatTexts.map((line, index) => {
      if (line.trim() === '') return '';
      const written = value.queries[index]?.trim().toLowerCase().replace(/["'.,]/g, '') ?? '';
      if (written === '') return '';
      if (tokens(written).some((word) => names.includes(word))) return written;
      log.debug(`subjects: dropped "${written}" — names nothing from ${work}`);
      dropped++;
      return '';
    });

    const written = queries.filter((query) => query !== '').length;
    log.info(
      `subjects: "${work}" — ${written} anchored subject(s) to photograph` +
        (dropped === 0 ? '' : `, ${dropped} unanchored query(s) left to be drawn`),
    );
    return { work, queries, names };
  } catch (error) {
    log.warn(`subjects: subject writing failed (${(error as Error).message}); using shot queries`);
    return empty;
  }
}

/**
 * The subject queries where there are any, and the shot queries everywhere
 * else.
 *
 * Per beat rather than all-or-nothing: a video about a film has beats about
 * the film and beats about the world it came out into, and the second kind is
 * better served by a described shot than by a forced name.
 */
export function preferSubjects(
  subjects: readonly string[],
  shots: readonly string[],
): string[] {
  return shots.map((shot, index) => {
    const subject = subjects[index]?.trim() ?? '';
    return subject === '' ? shot : subject;
  });
}
