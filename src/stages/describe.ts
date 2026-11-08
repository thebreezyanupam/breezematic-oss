import fs from 'node:fs';
import path from 'node:path';
import { MODELS, env, workDir } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';

/**
 * What goes under the video on YouTube.
 *
 * It used to be the script, in full, followed by the credits. That is the
 * worst of both: nobody reads their way through a transcript, the first two
 * lines -- the only part shown before "more", and the part search reads --
 * were the opening sentence of the narration rather than anything describing
 * the video, and the credits sat five thousand characters down.
 *
 * So: a few lines saying what the video argues, the chapters if it has any,
 * what was used and where it came from, the copyright position, and a handful
 * of hashtags. In that order, because that is the order of how much a reader
 * cares.
 */

const MAX = 5_000;

export type Blurb = {
  /** Two or three sentences. The first is what search and the feed show. */
  summary: string;
  /** Three to five, without the hash. */
  hashtags: string[];
};

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'hashtags'],
};

const clean = (text: string): string => text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();

/** A hashtag YouTube will accept: letters and digits, no spaces, not empty. */
function tagOf(raw: string): string | null {
  const word = raw.replace(/^#/, '').replace(/[^\p{L}\p{N}]/gu, '');
  return word.length < 3 ? null : `#${word}`;
}

/**
 * The blurb, written from what the video is about rather than from its
 * script. Falls back to the title when there is no key -- a description that
 * repeats the title is thin, but it is not a transcript.
 */
export async function writeBlurb(options: {
  title: string;
  /** The argument, the topic, or whatever else says what this is. */
  about: string;
  /** A little of the narration, for flavour. Never reproduced. */
  sample?: string;
  kind: 'essay' | 'short';
  seed?: number;
}): Promise<Blurb> {
  const fallback: Blurb = {
    summary: clean(options.about) || clean(options.title),
    hashtags: [],
  };
  if (env.GEMINI_API_KEY === undefined) return fallback;

  try {
    const { value } = await cache.json<Blurb>(
      'description',
      { v: 1, model: MODELS.llm.script, title: options.title, about: options.about, kind: options.kind },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction:
            'You write the description that sits under a video on YouTube. You return JSON ' +
            'and nothing else.',
          prompt: [
            `Title: ${options.title}`,
            `What it argues: ${options.about}`,
            options.sample === undefined ? '' : `How it opens: ${options.sample.slice(0, 600)}`,
            '',
            options.kind === 'essay'
              ? 'Write "summary": two or three sentences describing this video essay to somebody deciding'
              : 'Write "summary": one or two sentences describing this short to somebody deciding',
            'whether to watch. Say what it claims and what it covers. The first sentence is the one',
            'shown in search, so it must stand alone and carry the subject.',
            '',
            'Rules: no hype, no "in this video", no "we explore", no questions to the viewer, no',
            'emoji, no hashtags in the summary, no quoting the narration, no spoiling the ending of',
            'the argument. Plain sentences.',
            '',
            'Also "hashtags": three to five words or short phrases with no spaces and no "#",',
            'naming the book, the author and the subject. Real search terms, not slogans.',
          ]
            .filter((line) => line !== '')
            .join('\n'),
          temperature: 0.5,
          seed: toInt32Seed(options.seed ?? 7),
          maxOutputTokens: 512,
          responseSchema: SCHEMA,
        });
        return JSON.parse(response.text) as Blurb;
      },
    );
    const hashtags = (value.hashtags ?? [])
      .map((tag) => tagOf(String(tag)))
      .filter((tag): tag is string => tag !== null)
      .slice(0, 5);
    return { summary: clean(value.summary ?? '') || fallback.summary, hashtags };
  } catch (error) {
    log.debug(`describe: could not write a description (${(error as Error).message})`);
    return fallback;
  }
}

/**
 * The copyright position, stated plainly.
 *
 * Two separate things, because they are two separate claims: what this video
 * is (an original work of commentary), and why somebody else's material may
 * appear inside it (criticism and review). The last line is there because a
 * rightsholder who can see a way to sort something out usually takes it
 * rather than filing a claim.
 */
const NOTICE = [
  'Copyright and fair use',
  // One paragraph, unwrapped: YouTube wraps the description to the reader's
  // own width, so lines broken here break again there, in the wrong places.
  'This video is an original work of criticism and commentary. Any book covers, quotations, ' +
    'photographs or other material that appear belong to their respective owners and are used ' +
    'for the purposes of criticism, review, teaching and scholarship — fair use under section ' +
    '107 of the US Copyright Act. Public-domain and openly licensed material is credited above. ' +
    'If you hold rights in anything shown here and would like the credit changed, get in touch.',
].join('\n');

const timestamp = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

/** The credits a book essay leaves in its working directory, gathered up. */
function essayCredits(slug: string): string[] {
  const dir = workDir(slug);
  const lines: string[] = [];
  const read = (name: string): string[] => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  };

  const sources = read('sources.txt');
  if (sources.length > 0) lines.push(sources.join(' '));
  for (const portrait of read('portraits.txt').slice(1)) lines.push(portrait);
  for (const cover of read('covers.txt').slice(2)) lines.push(cover);
  const music = read('music-credit.txt');
  if (music.length > 0) lines.push(`Music: ${music[0]}`);
  // The war channel's sounds, icons and map data, one line each.
  for (const line of read('war-credits.txt')) lines.push(line);
  // The painted mode's brush library and icon artists.
  for (const line of read('paint-credits.txt')) lines.push(line);
  return lines;
}

/**
 * The whole description, assembled. Everything is optional except the blurb
 * and the notice: a video with no chapters and no borrowed material still
 * gets a description that reads like somebody wrote it.
 */
export function assembleDescription(parts: {
  blurb: Blurb;
  chapters?: readonly { title: string; atMs: number }[];
  credits?: readonly string[];
  /** Added to the hashtags, for a short. */
  extraTags?: readonly string[];
}): string {
  const blocks: string[] = [parts.blurb.summary];

  const chapters = parts.chapters ?? [];
  if (chapters.length > 0) {
    blocks.push(
      ['Chapters', '0:00 Opening']
        .concat(chapters.map((card) => `${timestamp(card.atMs)} ${clean(card.title)}`))
        .join('\n'),
    );
  }

  const credits = (parts.credits ?? []).filter((line) => line.trim() !== '');
  if (credits.length > 0) {
    blocks.push(['Sources and credits', ...credits.map((line) => clean(line))].join('\n'));
  }

  blocks.push(NOTICE);

  const tags = [...(parts.extraTags ?? []), ...parts.blurb.hashtags]
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 6);
  if (tags.length > 0) blocks.push(tags.join(' '));

  return blocks.join('\n\n').replace(/[<>]/g, '').slice(0, MAX);
}

/** The description for a book essay, written next to the video as a file. */
export async function writeEssayDescription(options: {
  slug: string;
  title: string;
  thesis: string;
  book: string;
  author: string;
  sample: string;
  chapters?: readonly { title: string; atMs: number }[];
  seed?: number;
}): Promise<string> {
  const blurb = await writeBlurb({
    title: options.title,
    about: [options.thesis, options.book === '' ? '' : `The book: ${options.book} by ${options.author}`]
      .filter(Boolean)
      .join('. '),
    sample: options.sample,
    kind: 'essay',
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });

  const text = assembleDescription({
    blurb,
    ...(options.chapters === undefined ? {} : { chapters: options.chapters }),
    credits: essayCredits(options.slug),
  });
  fs.mkdirSync(workDir(options.slug), { recursive: true });
  fs.writeFileSync(path.join(workDir(options.slug), 'description.txt'), `${text}\n`, 'utf8');
  return text;
}
