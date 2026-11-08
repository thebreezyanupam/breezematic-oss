import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MODELS, ROOT, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import { downloadClip, isConfigured, searchClips, type StockClip } from '../providers/pexels.js';
import type { CommonsImage } from './images.js';

/**
 * Live footage behind the type, from Pexels.
 *
 * The still path and this one return the same shape, because from the beat
 * sheet's point of view they are the same thing: a file under public/ that the
 * beat shows. What differs is the extension, and the renderer branches on that.
 *
 * Videos are not put in public/images. That directory is already served, cached
 * and cleaned as images, and a 12 MB mp4 sitting in it would be swept up by
 * anything that assumes otherwise.
 */
export const VIDEO_DIR = path.join(ROOT, 'public', 'videos');

/** Our frame is 1080 wide, so anything narrower is being upscaled on screen. */
const MIN_WIDTH = 1080;
/**
 * The floor under the clip length. The real minimum is the longest beat, passed
 * in by the caller: OffthreadVideo cannot loop, so a clip shorter than its beat
 * freezes on its last frame partway through. Asking for length up front is the
 * only place that can be prevented.
 */
const MIN_DURATION_FLOOR_SEC = 4;
/** Beyond this the library thins out enough that beats start sharing clips. */
const MAX_DURATION_ASK_SEC = 30;
/** Per query. Enough to still have an unused one after the earlier beats took theirs. */
const PER_QUERY = 12;
const QUERY_VERSION = 2;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { queries: { type: 'array', items: { type: 'string' } } },
  required: ['queries'],
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'why', 'how', 'what', 'when', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
  'you', 'your', 'we', 'our', 'they', 'their', 'it', 'its', 'this', 'that',
  'actually', 'turns', 'out', 'most', 'more', 'than', 'from', 'about', 'so',
  'just', 'even', 'been', 'has', 'have', 'had', 'his', 'her', 'him', 'she', 'he',
]);

function keywords(text: string, limit: number): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    const word = raw.replace(/'s$/, '');
    if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
    if (words.length >= limit) break;
  }
  return words;
}

/**
 * What makes this accurate is that the query is not the beat.
 *
 * A stock library is indexed by what is visible in the shot — "rain on a
 * window", "hands typing" — and searching it with a line of narration matches
 * on incidental words. "He died in 1227" returns nothing about anything; the
 * shot that belongs under it is an hourglass, or a candle going out, and
 * deciding that is a reading task. So the model that wrote the script writes
 * the queries too, exactly as it does for the drawings.
 *
 * Two to four words, because stock search is a tag match: a long query narrows
 * to nothing and silently falls back to whatever shares one word with it.
 */
function buildQueryRequest(topic: string, script: string, beats: readonly string[]): string {
  const listed = beats.map((text, i) => `${i + 1}. ${text === '' ? '(skip)' : text}`).join('\n');
  const fence = '"'.repeat(3);

  return `A vertical short about "${topic}" needs one stock video clip behind each beat.

Here is the whole narration:
${fence}
${script}
${fence}

The ${beats.length} beats, in order:
${listed}

Write one stock-footage search query per beat.

1. Exactly ${beats.length} queries, same order. Empty string for a beat marked (skip).
2. Two to four words. A stock library matches tags, so a sentence narrows to nothing and quietly returns something unrelated.
3. Describe what is visible in the shot, not what the beat means. "Candle flame close up", "empty desert horizon", "hands digging soil".
4. It must be a shot that exists in a general stock library: places, weather, nature, objects, hands, anonymous people, cities, textures, machinery.
5. Never name a real person, a public figure, a brand, a film, a game, or a character. Never a historical event by name. Ask for the kind of place or action instead.
6. Nothing with writing on it, and that rules out whole subjects rather than just captions: no map, calendar, book, page, sign, banner, screen, poster, scroll, letter, newspaper, gravestone, plaque, label or clock face. A stock clip of any of those is a clip of the writing on it.
7. Prefer motion over a static subject: something in the shot should be moving, since this is footage rather than a photograph.
8. All ${beats.length} queries differ. Do not ask for the same shot twice.
9. Plain lowercase English, no punctuation, no quotes.

Return only the JSON object.`;
}

/**
 * One search query per beat, blank where the beat wants no picture.
 *
 * Exported because the stills path needs the same thing. Written once per
 * video and handed to both, so a mixed sheet is searched by one set of
 * decisions rather than two that disagree.
 */
export async function writeShotQueries(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
}): Promise<string[]> {
  const topicWords = keywords(options.topic, 3).join(' ') || options.topic;
  const plain = options.beatTexts.map((line) => {
    if (line.trim() === '') return '';
    const own = keywords(line, 2).join(' ');
    return own === '' ? topicWords : own;
  });

  if (env.GEMINI_API_KEY === undefined) {
    log.info('footage: no key for query writing; searching on the beat words');
    return plain;
  }

  try {
    const { value } = await cache.json<{ queries: string[] }>(
      'footage-queries',
      {
        v: QUERY_VERSION,
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
            'You choose stock footage for vertical short videos. You return JSON and nothing ' +
            'else. No preamble, no markdown, no code fences.',
          prompt: buildQueryRequest(options.topic, options.script, options.beatTexts),
          temperature: 0.6,
          seed: toInt32Seed(options.seed),
          maxOutputTokens: 2048,
          responseSchema: RESPONSE_SCHEMA,
        });
        return JSON.parse(response.text) as { queries: string[] };
      },
    );

    return options.beatTexts.map((line, index) => {
      if (line.trim() === '') return '';
      const written = value.queries[index]?.trim().toLowerCase().replace(/["'.,]/g, '');
      return written === undefined || written === '' ? (plain[index] ?? '') : written;
    });
  } catch (error) {
    log.warn(`footage: query writing failed (${(error as Error).message}); using the beat words`);
    return plain;
  }
}

function fileNameFor(url: string): string {
  return `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}.mp4`;
}

/**
 * One clip per beat, in beat order, null where none could be found.
 *
 * Never throws into the pipeline. A beat with no footage falls back to the
 * generated field behind it, which is what it would have had anyway.
 */
export async function chooseFootage(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
  force: boolean;
  /** The longest beat, in ms. No clip shorter than this is accepted. */
  longestBeatMs: number;
  /** Written already, when a caller is sharing them with the stills path. */
  queries?: readonly string[];
}): Promise<(CommonsImage | null)[]> {
  const none = options.beatTexts.map(() => null);
  if (!isConfigured()) {
    log.warn('footage: PEXELS_API_KEY is not set; rendering without footage');
    return none;
  }
  cache.setForce(options.force);
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  const minDurationSec = Math.min(
    MAX_DURATION_ASK_SEC,
    Math.max(MIN_DURATION_FLOOR_SEC, Math.ceil(options.longestBeatMs / 1000)),
  );
  log.debug(`footage: asking for clips of ${minDurationSec}s or longer`);

  const queries = options.queries ?? (await writeShotQueries(options));

  /**
   * The topic pool is the safety net. A beat whose own query returns nothing
   * usable -- or returns only clips an earlier beat already took -- gets one
   * from a broad search on the topic rather than nothing at all, because a
   * repeated clip is still better than a beat that suddenly loses its picture.
   */
  const topicQuery = keywords(options.topic, 3).join(' ') || options.topic;
  const pool = await lookUp(`topic:${topicQuery}`, topicQuery, minDurationSec);

  const used = new Set<number>();
  const chosen: (CommonsImage | null)[] = [];

  for (const [index, line] of options.beatTexts.entries()) {
    const query = queries[index] ?? '';
    if (line.trim() === '' || query === '') {
      chosen.push(null);
      continue;
    }

    const found = await lookUp(`q:${query}`, query, minDurationSec);
    const pick =
      found.find((clip) => !used.has(clip.id)) ??
      pool.find((clip) => !used.has(clip.id)) ??
      found[0] ??
      pool[0];

    if (pick === undefined) {
      log.debug(`footage: beat ${index + 1} found nothing for "${query}"`);
      chosen.push(null);
      continue;
    }
    used.add(pick.id);

    try {
      const file = fileNameFor(pick.url);
      const destination = path.join(VIDEO_DIR, file);
      if (!fs.existsSync(destination)) await downloadClip(pick.url, destination);
      chosen.push({
        file,
        title: query,
        author: pick.author,
        licence: 'Pexels License',
        source: pick.page,
      });
    } catch (error) {
      log.warn(`footage: beat ${index + 1} failed (${(error as Error).message})`);
      chosen.push(null);
    }
  }

  const got = chosen.filter((clip) => clip !== null).length;
  log.info(`footage: ${got}/${chosen.length} beats have a clip`);
  return chosen;
}

async function lookUp(key: string, query: string, minDurationSec: number): Promise<StockClip[]> {
  try {
    const { value } = await cache.json<StockClip[]>(
      'footage-search',
      { key, minWidth: MIN_WIDTH, minDurationSec, v: 3 },
      () => searchClips({ query, minWidth: MIN_WIDTH, minDurationSec, count: PER_QUERY }),
    );
    return value;
  } catch (error) {
    log.debug(`footage: "${query}" failed (${(error as Error).message})`);
    return [];
  }
}
