import { cache } from '../cache.js';
import { MODELS } from '../config.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';

/**
 * Long-form original lore: the kind of thing people fall asleep listening to.
 *
 * The whole problem here is length. A short is a hundred and twenty words and
 * fits in one response; an hour of calm narration is around eight thousand, far
 * past what one call will write and far past what it can hold in its head
 * anyway. Asking for it in one go gets a summary of a story rather than the
 * story.
 *
 * So it is written the way a serial is: a bible first — world, names, the shape
 * of the arc — and then chapters one at a time, each shown the bible and a
 * running account of what has happened. The bible is what keeps names and
 * places from drifting, which is the failure mode that gives long generated
 * text away: a river called one thing in the first hour and another in the
 * third.
 *
 * It is written to be slept through, which is a real constraint and not a
 * softer one. No cliffhangers, no rising action, nothing that resolves loudly
 * enough to wake someone. The reader should be able to stop following at any
 * point and lose nothing.
 */

/**
 * Kokoro's actual pace at the default tempo, measured off a finished build:
 * 673 words came back as 3.58 minutes. The first guess here was 140, which is
 * roughly an audiobook read, and it made every video come out a quarter short
 * of what was asked for — a twenty-minute request landing at fifteen.
 *
 * Faster than a sleep narration ideally wants. Slowing the read is a tempo
 * change on the voice rather than a change here, and this number moves with it.
 */
const WORDS_PER_MINUTE = 187;
/** Long enough to hold a thread, short enough that the model writes prose rather than outline. */
const WORDS_PER_CHAPTER = 700;

export type Bible = {
  title: string;
  world: string;
  /** Proper nouns fixed up front, so nothing gets renamed three hours in. */
  names: string[];
  arc: string[];
};

export type Saga = {
  title: string;
  bible: Bible;
  chapters: string[];
  wordCount: number;
};

const BIBLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    world: { type: 'string' },
    names: { type: 'array', items: { type: 'string' } },
    arc: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'world', 'names', 'arc'],
};

const CHAPTER_SCHEMA = {
  type: 'object',
  properties: {
    prose: { type: 'string' },
    happened: { type: 'string' },
  },
  required: ['prose', 'happened'],
};

const VOICE = [
  'You write original lore to be listened to while falling asleep.',
  '',
  'The writing is calm, unhurried and descriptive. Long sentences. Concrete',
  'detail — weather, stone, water, distance, the work people do. The listener is',
  'not following a plot and will not remember the last ten minutes, so nothing',
  'depends on their attention.',
  '',
  'Never build tension. No cliffhangers, no violence on the page, no sudden',
  'reveals, no questions posed to the listener, no second person, no jokes. Do',
  'not address the listener at all. Do not announce chapters or say "in this',
  'part". Nothing should resolve loudly enough to wake someone.',
  '',
  'Everything you write is invented. Do not use any existing fictional world,',
  'setting, character or name from published fiction, film, games or television.',
  'Do not retell myth or scripture. The place and everyone in it are yours.',
].join('\n');

async function writeBible(topic: string, seed: number, minutes: number): Promise<Bible> {
  const { value } = await cache.json<Bible>(
    'saga-bible',
    { topic, seed, minutes, model: MODELS.llm.script },
    async () => {
      const response = await generate({
        model: MODELS.llm.script,
        systemInstruction: VOICE,
        prompt: [
          `Invent a world for a ${minutes}-minute sleep story suggested by: "${topic}".`,
          '',
          'Return:',
          '- title: a quiet, plain title. No colons, no subtitle.',
          '- world: one paragraph on the place. Geography, weather, how people live.',
          '- names: 6-10 proper nouns you will use throughout — places, rivers,',
          '  trades, orders of people. Invented, pronounceable, not borrowed.',
          '- arc: 6-10 short lines, each the subject of a stretch of the telling.',
          '  A drift through the place and its year, not a plot with a climax.',
        ].join('\n'),
        temperature: 0.9,
        seed: toInt32Seed(seed),
        maxOutputTokens: 2048,
        responseSchema: BIBLE_SCHEMA,
      });
      return JSON.parse(response.text) as Bible;
    },
  );
  return value;
}

async function writeChapter(options: {
  bible: Bible;
  subject: string;
  soFar: string;
  index: number;
  seed: number;
}): Promise<{ prose: string; happened: string }> {
  const { bible, subject, soFar, index, seed } = options;
  const { value } = await cache.json<{ prose: string; happened: string }>(
    'saga-chapter',
    { title: bible.title, subject, index, seed, model: MODELS.llm.script },
    async () => {
      const response = await generate({
        model: MODELS.llm.script,
        systemInstruction: VOICE,
        prompt: [
          `World: ${bible.world}`,
          `Names in use: ${bible.names.join(', ')}`,
          '',
          soFar === ''
            ? 'This is the opening. Begin in the middle of the place, with no preamble.'
            : `What has been told so far: ${soFar}`,
          '',
          `Now write about: ${subject}`,
          '',
          `Around ${WORDS_PER_CHAPTER} words of continuous prose. No headings, no`,
          'list, no dialogue punctuation heavier than a comma. Use only the names',
          'above; invent no new proper nouns. End mid-drift rather than on a',
          'conclusion.',
          '',
          'Also return `happened`: one sentence recording what this stretch',
          'covered, for continuity.',
        ].join('\n'),
        temperature: 0.85,
        // Each chapter gets its own seed, or they come back as variations of
        // one another.
        seed: toInt32Seed(seed + index * 7919),
        maxOutputTokens: 4096,
        responseSchema: CHAPTER_SCHEMA,
      });
      return JSON.parse(response.text) as { prose: string; happened: string };
    },
  );
  return value;
}

export async function generateSaga(options: {
  topic: string;
  seed: number;
  minutes: number;
  force: boolean;
}): Promise<Saga> {
  cache.setForce(options.force);

  const target = options.minutes * WORDS_PER_MINUTE;
  const bible = await writeBible(options.topic, options.seed, options.minutes);
  log.info(`saga: "${bible.title}" — ${bible.arc.length} movements, ${target} words wanted`);

  const chapters: string[] = [];
  const history: string[] = [];
  let words = 0;

  // The arc is a shape, not a length. It is cycled until the runtime is filled,
  // so a longer video revisits its subjects rather than inventing new ones and
  // wandering off the world the bible fixed.
  for (let index = 0; words < target; index++) {
    const subject = bible.arc[index % bible.arc.length] ?? bible.world;
    const chapter = await writeChapter({
      bible,
      subject,
      // Only the recent past: the whole history would crowd out the writing,
      // and continuity that matters is local.
      soFar: history.slice(-4).join(' '),
      index,
      seed: options.seed,
    });

    chapters.push(chapter.prose.trim());
    history.push(chapter.happened.trim());
    words += chapter.prose.split(/\s+/).length;
    log.info(`saga: chapter ${index + 1} — ${words}/${target} words`);
  }

  return { title: bible.title, bible, chapters, wordCount: words };
}

export const SAGA_WORDS_PER_MINUTE = WORDS_PER_MINUTE;
