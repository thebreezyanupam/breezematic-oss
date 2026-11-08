import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, dirs } from '../config.js';
import { editPictures } from './pictureeditor.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { rngFor } from '../rng.js';
import type { ImageSource } from '../schema.js';

/**
 * Wikimedia Commons, because it needs no key and no signup — Openverse sits
 * behind a bot challenge and Pexels/Unsplash both want an account. Commons also
 * returns the licence and the author with every hit, which is what makes the
 * credits file possible.
 */
const API = 'https://commons.wikimedia.org/w/api.php';
const WIKI = 'https://en.wikipedia.org/w/api.php';
/** Articles pooled for pictures. Enough for a long short without drifting off-subject. */
const ARTICLES = 6;
const USER_AGENT = 'BreezeMatic/0.1 (local kinetic-typography tool; https://github.com/)';

/** Where fetched images land so Remotion's bundler can serve them to the page. */
export const IMAGE_DIR = path.join(ROOT, 'public', 'images');

const TIMEOUT_MS = 20_000;
const THUMB_WIDTH = 1280;
/** Commons throttles bursts; a short gap between fetches keeps it happy. */
const FETCH_GAP_MS = 600;
const RETRY_DELAYS_MS = [1_500, 4_000, 9_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Share-alike would make the finished video share-alike too, and the
 * non-commercial and no-derivatives clauses rule out the use outright. What is
 * left is public domain and plain attribution, which the credits file covers.
 */
const ALLOWED_LICENCE = /^(cc0|public domain|pdm|cc by [0-9.]+)$/i;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'why', 'how', 'what', 'when', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
  'you', 'your', 'we', 'our', 'they', 'their', 'it', 'its', 'this', 'that',
  'actually', 'turns', 'out', 'most', 'more', 'than', 'from', 'about',
]);

/**
 * What a generated picture puts in its `licence` field.
 *
 * Named here, and exported, because two stages produce generated pictures and
 * they wrote two different strings -- 'generated' and 'AI-generated'. The
 * credits writer tested for one of them, so everything from the other stage
 * fell through to the photographs bucket and was written out under the
 * Wikimedia Commons heading, crediting the image model as the photographer
 * under a licence it was never issued under. That is the single thing a
 * credits file exists not to say, so the test is now a function and the
 * spelling is not something a new stage has to guess.
 */
export const GENERATED_LICENCE = 'generated';

/** Both spellings, so credits files already written still read correctly. */
export const GENERATED_LICENCES = [GENERATED_LICENCE, 'AI-generated'] as const;

export function isGenerated(image: { licence: string }): boolean {
  return (GENERATED_LICENCES as readonly string[]).includes(image.licence);
}

export type CommonsImage = {
  /** Filename under public/images, referenced with staticFile(). */
  file: string;
  title: string;
  author: string;
  licence: string;
  source: string;
};

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

async function getJson(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`commons responded ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function meta(entry: Record<string, unknown>, key: string): string {
  const extmeta = entry['extmetadata'] as Record<string, { value?: string }> | undefined;
  const value = extmeta?.[key]?.value ?? '';
  return value.replace(/<[^>]*>/g, '').trim();
}

/** The furniture every article carries. None of it is ever the subject. */
const CHROME = /(commons-logo|wiki(pedia|media|source|quote)|question_book|edit-|ambox|padlock|folder_hexagonal|symbol_|_icon|flag_of|coat_of_arms|\.svg$|\.ogg$|\.webm$)/i;

/** Both endpoints answer in the same shape, so both are read the same way. */
/**
 * Files that are artwork about a subject rather than a photograph of it. A
 * wordmark passes every other filter -- it is bitmap, it is large enough, it
 * is public domain, and its title genuinely names the subject -- and it is
 * still a rectangle with a word in it behind a beat of narration.
 */
const NOT_A_PHOTOGRAPH = /\b(logo|wordmark|icon|emblem|favicon|watermark)\b/i;

function parsePages(pages: Record<string, Record<string, unknown>>): CommonsImage[] {
  const results: CommonsImage[] = [];
  for (const page of Object.values(pages)) {
    const info = (page['imageinfo'] as Record<string, unknown>[] | undefined)?.[0];
    if (info === undefined) continue;

    const title = String(page['title'] ?? '').replace(/^File:/, '');
    if (CHROME.test(title) || NOT_A_PHOTOGRAPH.test(title)) continue;

    const licence = meta(info, 'LicenseShortName');
    if (!ALLOWED_LICENCE.test(licence)) continue;

    const thumb = info['thumburl'];
    if (typeof thumb !== 'string' || thumb === '') continue;
    // Anything this small is a badge, not a picture.
    if (Number(info['width'] ?? 0) < 480) continue;

    const entry: CommonsImage & { thumb?: string } = {
      file: '',
      title,
      author: meta(info, 'Artist') || 'Unknown',
      licence,
      source: (info['descriptionurl'] as string) ?? thumb,
    };
    entry.thumb = thumb;
    results.push(entry);
  }
  // Stable order so a seed always picks the same images from the same results.
  return results.sort((a, b) => (a.title < b.title ? -1 : 1));
}

/** A free-text search of Commons. Broad, and only as good as the words given it. */
async function search(query: string): Promise<CommonsImage[]> {
  const url =
    `${API}?action=query&generator=search&gsrsearch=${encodeURIComponent(`filetype:bitmap ${query}`)}` +
    `&gsrnamespace=6&gsrlimit=40&prop=imageinfo&iiprop=url|size|extmetadata` +
    `&iiurlwidth=${THUMB_WIDTH}&format=json&origin=*`;

  const body = await getJson(url);
  const query_ = body['query'] as { pages?: Record<string, Record<string, unknown>> } | undefined;
  return parsePages(query_?.pages ?? {});
}

/**
 * The pictures on the Wikipedia article for the topic.
 *
 * Searching Commons for "Genghis Khan's grave" returns whatever happens to
 * carry those words in a filename, which is how a video about a burial ended
 * up illustrated with generic steppe. An article's images have already been
 * chosen by someone who read the subject — the portrait, the map, the artefact
 * — so they are specific in a way a keyword match is not, and being on Commons
 * they arrive with the same licence metadata and pass the same filter.
 */
async function articleImages(topic: string): Promise<CommonsImage[]> {
  const found = await getJson(
    `${WIKI}?action=query&list=search&srsearch=${encodeURIComponent(topic)}` +
      `&srlimit=${ARTICLES}&format=json&origin=*`,
  );
  const hits = (found['query'] as { search?: { title?: string }[] } | undefined)?.search ?? [];
  const articles = hits.map((hit) => hit.title).filter((t): t is string => typeof t === 'string');
  if (articles.length === 0) return [];

  /**
   * Several articles, not one.
   *
   * One article was too thin to illustrate a video from: "Burial place of
   * Genghis Khan" carries two usable pictures, and a twenty-beat short built
   * on two pictures repeats itself from the third beat on. The articles around
   * a subject are about the same subject -- the man, the empire, the region,
   * the campaigns -- so pooling the top few multiplies the supply without
   * loosening what it is a picture of, which a broader keyword search would.
   *
   * Titles are asked for in one request; images come one article at a time,
   * spaced, because this is the same endpoint that answers 429 under a burst.
   */
  const pooled: CommonsImage[] = [];
  const seen = new Set<string>();
  for (const [index, article] of articles.entries()) {
    if (index > 0) await sleep(FETCH_GAP_MS);
    try {
      const body = await getJson(
        `${WIKI}?action=query&generator=images&titles=${encodeURIComponent(article)}` +
          `&gimlimit=40&prop=imageinfo&iiprop=url|size|extmetadata` +
          `&iiurlwidth=${THUMB_WIDTH}&format=json&origin=*`,
      );
      const query_ = body['query'] as { pages?: Record<string, Record<string, unknown>> } | undefined;
      const found_ = parsePages(query_?.pages ?? {});
      for (const image of found_) {
        if (seen.has(image.title)) continue;
        seen.add(image.title);
        pooled.push(image);
      }
      log.debug(`images: "${article}" gave ${found_.length}`);
    } catch (error) {
      log.debug(`images: "${article}" failed (${(error as Error).message})`);
    }
  }
  log.info(`images: ${pooled.length} from ${articles.length} article(s) around "${topic}"`);
  return pooled;
}

async function download(url: string): Promise<string> {
  const name = `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}.jpg`;
  const destination = path.join(IMAGE_DIR, name);
  if (fs.existsSync(destination)) return name;

  // Fetching twenty images back to back earns a 429 from Commons, which used
  // to show up as beats silently missing their picture. Back off and retry.
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (response.status === 429 && attempt < RETRY_DELAYS_MS.length) {
        // Commons usually says how long to wait; trust it over our own guess.
        const retryAfter = Number.parseFloat(response.headers.get('retry-after') ?? '');
        const wait = Number.isFinite(retryAfter)
          ? Math.min(15_000, retryAfter * 1000)
          : (RETRY_DELAYS_MS[attempt] ?? 0);
        log.debug(`images: 429, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!response.ok) throw new Error(`image download responded ${response.status}`);
      fs.mkdirSync(IMAGE_DIR, { recursive: true });
      fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
      return name;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Returns one image per beat, or an empty array when imagery is off or the
 * search comes back with nothing usable. Never throws into the pipeline: a
 * short without pictures is still a short.
 */
export async function chooseImages(options: {
  topic: string;
  seed: number;
  beatTexts: readonly string[];
  force: boolean;
  /**
   * One written search query per beat. When present, each beat is searched for
   * its own subject before the topic pool is touched.
   */
  queries?: readonly string[];
  /**
   * Take a beat's own subject or nothing, never the topic pool.
   *
   * The pool is a good safety net for a topic about the world and a bad one
   * for a topic about a named work, where it is measurably off-subject: the
   * pool for "Naruto" is a Godzilla still, a photograph of Hiroshima, a bowl
   * of ramen and Keanu Reeves, all genuinely on the pooled articles and none
   * of them about the video. A beat with no picture is better than that, and
   * where a drawing can be made instead it is better again.
   */
  ownQueryOnly?: boolean;
  /**
   * Names the picture has to be of. A hit is kept only if its own title
   * mentions one of these.
   *
   * Asking the right question is not enough on its own, because Commons
   * answers every question. "masashi kishimoto" is a properly anchored query
   * and it came back with a photograph of a bookshop in Kyoto — the search has
   * no hits for the man, so it returned the nearest thing with any of those
   * words near it. Checking the answer as well as the question is what turns
   * that into a beat that gets drawn instead.
   */
  mustMention?: readonly string[];
  /**
   * Let the picture editor place them (pictureeditor.ts): every search only
   * gathers candidates, and a model that has read the narration decides which
   * goes where. The explainer's path, where a wrong picture is a wrong fact.
   */
  edit?: { script: string };
}): Promise<(CommonsImage | null)[]> {
  const none = options.beatTexts.map(() => null);
  // Without this --force never reached the searches, so a topic looked up once
  // kept answering from the first result set no matter what changed behind it.
  cache.setForce(options.force);

  const look = async (label: string, key: string, run: () => Promise<CommonsImage[]>) => {
    try {
      const cached = await cache.json<(CommonsImage & { thumb?: string })[]>(
        'images-search',
        { key, width: THUMB_WIDTH, licence: 'pd+by', v: 2 },
        run,
      );
      return cached.value;
    } catch (error) {
      log.debug(`images: ${label} failed (${(error as Error).message})`);
      return [];
    }
  };

  const topicQuery = keywords(options.topic, 3).join(' ') || options.topic;
  // The article first: its pictures were chosen by someone who read the
  // subject, where a keyword search only knows which filenames carry the words.
  const article = await look('article lookup', `article:${options.topic}`, () =>
    articleImages(options.topic),
  );
  const broad = await look('topic search', `search:${topicQuery}`, () => search(topicQuery));

  const pool = [...article, ...broad] as (CommonsImage & { thumb?: string })[];
  if (pool.length === 0 && options.ownQueryOnly !== true) {
    log.warn(`images: nothing openly licensed for "${topicQuery}"; rendering without pictures`);
    return none;
  }
  log.info(
    `images: ${article.length} from the article, ${broad.length} from search`,
  );

  /**
   * Searching per beat on the beat's own words was tried and made this worse. A
   * beat's words are ordinary ones and Commons matches them against filenames,
   * so "conquered an empire" returned a pear cultivar called Blaisdon Conqueror
   * and "he died in 1227" returned a moth whose taxon number is 1227.
   *
   * Written queries are a different proposition, and the reason this is worth
   * revisiting. "Why time only moves forward" pooled the articles around the
   * word "time" and illustrated a video about entropy with Lionel Messi,
   * daylight-saving posters and a Thai politician -- all genuinely on the
   * pooled articles, none of them about the subject. A query naming the shot
   * ("sand falling hourglass") searches for the thing the beat is about.
   *
   * The topic pool stays underneath, in the same order as before: the article's
   * pictures were chosen by someone who read the subject, so they are spent
   * before the broad search results are touched.
   */
  const rng = rngFor(options.seed, 'images');
  const deck = [
    ...article,
    ...[...broad].sort(() => rng() - 0.5),
  ] as (CommonsImage & { thumb?: string })[];
  const used = new Set<string>();

  /** A beat's own subject, searched only when someone wrote one for it. */
  const perBeat = async (query: string): Promise<(CommonsImage & { thumb?: string })[]> => {
    if (query === '') return [];
    await sleep(FETCH_GAP_MS);
    return (await look(`beat "${query}"`, `search:${query}`, () => search(query))) as (CommonsImage & {
      thumb?: string;
    })[];
  };

  if (options.edit !== undefined) {
    const edited = await editedImages(options, article, broad, perBeat, options.edit.script);
    if (edited !== null) return edited;
  }

  const chosen: (CommonsImage | null)[] = [];
  let fromOwnQuery = 0;
  let offSubject = 0;
  for (const [index, line] of options.beatTexts.entries()) {
    // Blank means this beat is being illustrated some other way -- under "mix"
    // a clip is already going behind it -- so there is nothing to fetch and
    // nothing to spend a request on.
    if (line.trim() === '') {
      chosen.push(null);
      continue;
    }
    const own = await perBeat(options.queries?.[index] ?? '');
    const names = options.mustMention;
    const onSubject = (image: CommonsImage): boolean => {
      if (names === undefined || names.length === 0) return true;
      const words = image.title.toLowerCase().split(/[^a-z0-9]+/);
      return names.some((name) => words.includes(name));
    };
    const ownPick = own.find(
      (image) => image.thumb !== undefined && !used.has(image.title) && onSubject(image),
    );
    if (ownPick === undefined && own.length > 0 && names !== undefined) {
      offSubject++;
    }
    if (ownPick !== undefined) fromOwnQuery++;

    const pick =
      ownPick ??
      (options.ownQueryOnly === true
        ? undefined
        : (deck.find((image) => image.thumb !== undefined && !used.has(image.title)) ??
           deck.find((image) => image.thumb !== undefined)));

    if (pick?.thumb === undefined) {
      chosen.push(null);
      continue;
    }
    used.add(pick.title);

    try {
      if (index > 0) await sleep(FETCH_GAP_MS);
      // Built field by field, not spread: `thumb` is ours for fetching and the
      // beat sheet schema is strict about what it will accept.
      const file = await download(pick.thumb);
      chosen.push({
        file,
        title: pick.title,
        author: pick.author,
        licence: pick.licence,
        source: pick.source,
      });
    } catch (error) {
      log.warn(`images: ${pick.title} failed (${(error as Error).message})`);
      chosen.push(null);
    }
  }
  if (options.queries !== undefined) {
    log.info(
      `images: ${fromOwnQuery}/${chosen.length} beats matched their own subject` +
        (offSubject === 0 ? '' : `, ${offSubject} rejected as off-subject`),
    );
  }
  return chosen;
}

type Found = CommonsImage & { thumb?: string };

/**
 * The editor's path through the same searches: gather, let it place, download.
 *
 * Null when the editor could not run, so the caller falls back to placing by
 * search order exactly as before. A beat the editor left empty takes the next
 * unused picture from the topic's own articles -- chosen by someone who read
 * the subject -- and never one from a keyword search, which is where every
 * off-subject picture came from.
 */
async function editedImages(
  options: { topic: string; seed: number; beatTexts: readonly string[]; queries?: readonly string[] },
  article: readonly Found[],
  broad: readonly Found[],
  perBeat: (query: string) => Promise<Found[]>,
  script: string,
): Promise<(CommonsImage | null)[] | null> {
  const seen = new Set<string>();
  const candidates: Found[] = [];
  const add = (image: Found): void => {
    if (image.thumb === undefined || seen.has(image.title) || candidates.length >= 110) return;
    seen.add(image.title);
    candidates.push(image);
  };
  /**
   * The topic's own search before the per-beat ones, and the article capped.
   *
   * In the other order the list filled before the topic search was reached:
   * "why the Dead Sea is so salty" pooled sixty-four pictures from articles
   * about salinity and seventy-five from beat searches, and the twenty actual
   * photographs of the Dead Sea were cut off at the limit -- so the editor,
   * correctly choosing the best of what it was shown, illustrated the Dead
   * Sea with Bolivian salt pans.
   */
  article.slice(0, 45).forEach(add);
  broad.slice(0, 30).forEach(add);
  for (const [index, line] of options.beatTexts.entries()) {
    if (line.trim() === '') continue;
    (await perBeat(options.queries?.[index] ?? '')).slice(0, 4).forEach(add);
  }
  article.slice(45).forEach(add);

  const picks = await editPictures({
    topic: options.topic,
    script,
    beatTexts: options.beatTexts,
    candidates,
    seed: options.seed,
  });
  if (picks === null) return null;

  const fromArticle = new Set(article.map((image) => image.title));
  const used = new Set(picks.filter((pick): pick is number => pick !== null).map((pick) => candidates[pick]?.title));
  const spare = candidates.filter((image) => fromArticle.has(image.title) && !used.has(image.title));
  const downloaded = new Map<string, string>();
  const chosen: (CommonsImage | null)[] = [];

  for (const [index, line] of options.beatTexts.entries()) {
    if (line.trim() === '') {
      chosen.push(null);
      continue;
    }
    const pick = picks[index];
    const image = pick === null || pick === undefined ? spare.shift() : candidates[pick];
    if (image?.thumb === undefined) {
      chosen.push(null);
      continue;
    }
    try {
      let file = downloaded.get(image.title);
      if (file === undefined) {
        if (downloaded.size > 0) await sleep(FETCH_GAP_MS);
        file = await download(image.thumb);
        downloaded.set(image.title, file);
      }
      chosen.push({ file, title: image.title, author: image.author, licence: image.licence, source: image.source });
    } catch (error) {
      log.warn(`images: ${image.title} failed (${(error as Error).message})`);
      chosen.push(null);
    }
  }
  return chosen;
}

/**
 * Attribution the licences require, written next to the video. Generated
 * pictures have no licence to satisfy, but the prompt that made them is the
 * only record of what is on screen, so it is written down the same way.
 */
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;

const PEXELS_HEADING =
  'Footage via Pexels, under the Pexels License.' +
  String.fromCharCode(10) +
  'Free for commercial use. Attribution is not required; it is given anyway.';

const OWN_HEADING =
  'Media supplied by hand, from assets/own.' +
  String.fromCharCode(10) +
  'Not sourced or licensed by this tool; whoever added these files knows where they came from.';

const COMMONS_HEADING =
  'Images via Wikimedia Commons.' +
  String.fromCharCode(10) +
  'Public domain and CC BY only; share-alike, non-commercial and no-derivatives are excluded.';

const pexelsEntry = (image: CommonsImage): string =>
  [image.title, `  by ${image.author}`, `  ${image.source}`, ''].join(String.fromCharCode(10));

const commonsEntry = (image: CommonsImage): string =>
  [image.title, `  by ${image.author}`, `  ${image.licence}`, `  ${image.source}`, ''].join(
    String.fromCharCode(10),
  );

export function writeCredits(
  slug: string,
  images: readonly (CommonsImage | null)[],
): void {
  const used = new Map<string, CommonsImage>();
  for (const image of images) {
    if (image !== null) used.set(image.title, image);
  }
  const file = path.join(dirs.work, slug, 'credits.txt');
  if (used.size === 0) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    return;
  }

  /**
   * Each picture says what it is, and the file is built from that.
   *
   * It used to be built from the sheet's picture source, with "mix" splitting
   * on the file extension. That held only while the two halves of a mix were a
   * clip and a photograph. An illustrated video about a named work is now a
   * set of photographs and a set of drawings, both of them .jpg, and splitting
   * those by extension would have filed generated pictures under a Commons
   * heading -- a false statement about a licence, which is the one thing a
   * credits file exists not to make.
   */
  const all = [...used.values()];
  /**
   * Supplied media is credited to nobody, because this file cannot know who to
   * credit: somebody chose those files and only they know where they came
   * from. Listing them under the Commons heading would be a false statement
   * about a licence, and listing them at all is still worth doing — it is the
   * record of which beats are somebody's own material rather than the tool's.
   */
  const own = all.filter((image) => image.licence === 'supplied');
  const rest = all.filter((image) => image.licence !== 'supplied');
  const clips = rest.filter((image) => VIDEO_EXT.test(image.file));
  const made = rest.filter((image) => !VIDEO_EXT.test(image.file) && isGenerated(image));
  const photos = rest.filter((image) => !VIDEO_EXT.test(image.file) && !isGenerated(image));

  const madeHeading =
    `Images generated with ${made[0]?.author ?? 'an image model'}.` +
    String.fromCharCode(10) +
    'No photographer to credit; the prompt behind each one is listed instead.';

  const lines = [
    ...(own.length === 0
      ? []
      : [
          OWN_HEADING,
          '',
          ...own.map((image) => `${image.source}${String.fromCharCode(10)}`),
          '',
        ]),
    ...(clips.length === 0 ? [] : [PEXELS_HEADING, '', ...clips.map(pexelsEntry), '']),
    ...(photos.length === 0 ? [] : [COMMONS_HEADING, '', ...photos.map(commonsEntry), '']),
    ...(made.length === 0
      ? []
      : [madeHeading, '', ...made.map((image) => `${image.file}\n  ${image.title}\n`)]),
  ];

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  const kinds = [
    own.length === 0 ? '' : `${own.length} supplied`,
    clips.length === 0 ? '' : `${clips.length} clip(s)`,
    photos.length === 0 ? '' : `${photos.length} photograph(s)`,
    made.length === 0 ? '' : `${made.length} generated`,
  ].filter((part) => part !== '');
  log.info(`credits: ${kinds.join(', ')} listed in work/${slug}/credits.txt`);
}

/**
 * The attribution, as a block to paste under a published video.
 *
 * CC BY is permission granted in advance, and the thing it asks in return is
 * credit "in a manner reasonable to the medium". For a video that medium is
 * the description: a text file sitting in a working directory on the machine
 * that made it is not seen by anyone who watches the thing, so on its own it
 * does not discharge the condition. This is the same information, shortened to
 * what a description can carry, so publishing can append it.
 *
 * Returns an empty string when nothing in the video needs crediting.
 */
/**
 * Only the credits a licence actually obliges.
 *
 * `creditBlock` is the whole record, which is right for a YouTube description
 * -- it sits under a fold and costs nothing. A Facebook post has no fold: the
 * description is the text above the video in the feed, and the generated-image
 * section of that record is a list of every prompt under a heading that says,
 * in so many words, that there is nobody to credit. Publishing a wall of
 * prompts as the opening line of a post discharges no condition and is read by
 * nobody.
 *
 * So this keeps the photographs and the footage, whose licences ask for credit
 * in a manner suited to the medium, and drops the sections that only ever
 * existed as working notes. An empty result means nothing in the video is
 * subject to an attribution condition, which is a real answer rather than a
 * missing one.
 */
export function requiredCredits(slug: string): string {
  const file = path.join(dirs.work, slug, 'credits.txt');
  if (!fs.existsSync(file)) return '';
  const body = fs.readFileSync(file, 'utf8');

  const kept: string[] = [];
  for (const heading of [PEXELS_HEADING, COMMONS_HEADING]) {
    const at = body.indexOf(heading);
    if (at === -1) continue;
    // Each section runs to the next heading, whichever that turns out to be.
    const rest = body.slice(at);
    const ends = [OWN_HEADING, PEXELS_HEADING, COMMONS_HEADING, 'Images generated with ']
      .map((other) => rest.indexOf(other, heading.length))
      .filter((index) => index !== -1);
    kept.push(rest.slice(0, ends.length === 0 ? undefined : Math.min(...ends)).trim());
  }

  return kept.length === 0 ? '' : kept.join(String.fromCharCode(10, 10));
}

export function creditBlock(slug: string): string {
  const file = path.join(dirs.work, slug, 'credits.txt');
  if (!fs.existsSync(file)) return '';
  const body = fs.readFileSync(file, 'utf8').trim();
  return body === '' ? '' : `Credits${String.fromCharCode(10)}${'-'.repeat(7)}${String.fromCharCode(10)}${body}`;
}

/* ------------------------------------------------------------- portraits -- */

const WIKIDATA = 'https://www.wikidata.org/w/api.php';

type Claim = { mainsnak?: { datavalue?: { value?: unknown } } };
type Entity = { claims?: Record<string, Claim[]>; descriptions?: { en?: { value?: string } } };

/**
 * A real, openly licensed portrait of a real person, from their Wikidata
 * entry.
 *
 * Wikidata rather than a Commons search, because "Oscar Wilde" on Commons
 * returns his grave, his house, a statue and a caricature before it returns
 * him -- while his Wikidata entry names exactly one image, the one editors
 * chose to represent him, which is almost always the famous photograph. Only
 * entries that are a human (P31 = Q5) with an image (P18) count, so a book, a
 * film or a ship with the same name is passed over.
 *
 * The licence filter is the same as every other Commons picture here: public
 * domain, CC0 or plain attribution. Most portraits of anyone who died before
 * the twentieth century pass it; most photographs of living people are
 * share-alike and do not, and for them this answers null and the caller
 * draws instead.
 */
export async function portraitOf(name: string): Promise<CommonsImage | null> {
  const query = name.trim();
  if (query === '') return null;

  const { value: found } = await cache.json<(CommonsImage & { thumb?: string }) | null>(
    'portrait',
    { name: query.toLowerCase(), v: 1 },
    async () => {
      const search = await getJson(
        `${WIKIDATA}?action=wbsearchentities&search=${encodeURIComponent(query)}` +
          '&language=en&type=item&limit=6&format=json&origin=*',
      );
      const ids = ((search['search'] as { id?: string }[] | undefined) ?? [])
        .map((hit) => hit.id)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) return null;

      const body = await getJson(
        `${WIKIDATA}?action=wbgetentities&ids=${ids.join('|')}` +
          '&props=claims|descriptions&languages=en&format=json&origin=*',
      );
      const entities = (body['entities'] as Record<string, Entity> | undefined) ?? {};

      // In search order: the first hit is the best-known person of that name.
      for (const id of ids) {
        const entity = entities[id];
        const human = (entity?.claims?.['P31'] ?? []).some((claim) => {
          const value = claim.mainsnak?.datavalue?.value as { id?: string } | undefined;
          return value?.id === 'Q5';
        });
        const image = entity?.claims?.['P18']?.[0]?.mainsnak?.datavalue?.value;
        if (!human || typeof image !== 'string') continue;

        await sleep(FETCH_GAP_MS);
        const info = await getJson(
          `${API}?action=query&titles=${encodeURIComponent(`File:${image}`)}` +
            `&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=${THUMB_WIDTH}&format=json&origin=*`,
        );
        const pages = (info['query'] as { pages?: Record<string, Record<string, unknown>> } | undefined)?.pages;
        const description = entity?.descriptions?.en?.value ?? '';
        const usable = parsePages(pages ?? {})[0] ?? (await portraitSearch(query));
        if (usable === undefined) {
          log.info(`images: no openly licensed portrait of ${query} large enough to cut out`);
          return null;
        }
        log.info(`images: portrait of ${query}${description === '' ? '' : ` (${description})`} — ${usable.title}`);
        return usable as CommonsImage & { thumb?: string };
      }
      return null;
    },
  );

  if (found === null || found.thumb === undefined) return null;
  const file = await download(found.thumb);
  return { file, title: found.title, author: found.author, licence: found.licence, source: found.source };
}

/**
 * More than one picture of a real person, for a video that names them more
 * than once.
 *
 * The same photograph pasted three times reads as a loop; a second portrait
 * from another year reads as research. The Wikidata portrait comes first, and
 * after it only Commons files whose own title names the person in full -- every
 * part of the name, not the surname, because "Wilde" alone also finds Cornel
 * Wilde and a street in Dublin, and a wrong face is worse than a repeated one.
 */
export async function portraitsOf(name: string, limit = 3): Promise<CommonsImage[]> {
  const first = await portraitOf(name);
  const parts = name
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((part) => part.length >= 3);
  if (parts.length < 2) return first === null ? [] : [first];

  const { value: more } = await cache.json<(CommonsImage & { thumb?: string })[]>(
    'portraits-more',
    { name: name.trim().toLowerCase(), v: 1 },
    async () => {
      await sleep(FETCH_GAP_MS);
      const found = await search(`${name} portrait`).catch(() => []);
      return found
        .filter((image) => {
          const title = image.title.toLowerCase();
          return parts.every((part) => title.includes(part)) && !NOT_THE_PERSON.test(image.title);
        })
        .slice(0, limit + 1) as (CommonsImage & { thumb?: string })[];
    },
  );

  const out: CommonsImage[] = first === null ? [] : [first];
  for (const entry of more) {
    if (out.length >= limit) break;
    if (entry.thumb === undefined || out.some((have) => have.title === entry.title)) continue;
    try {
      const file = await download(entry.thumb);
      out.push({ file, title: entry.title, author: entry.author, licence: entry.licence, source: entry.source });
    } catch {
      // One missing alternative costs variety, not the person.
    }
  }
  return out;
}

/** Pictures of a person that are about them rather than of them. */
const NOT_THE_PERSON =
  /(grave|tomb|statue|bust|monument|memorial|plaque|house|home|signature|stamp|museum|street|coin|banknote|caricature|mural)/i;

/**
 * The fallback when a person's chosen Wikidata image will not do -- too small
 * to cut out (Kafka's is 330 pixels wide) or not openly licensed. A Commons
 * search for their portrait, kept only where the file is named for them and is
 * not a picture of their grave, their house or their statue.
 */
async function portraitSearch(name: string): Promise<(CommonsImage & { thumb?: string }) | undefined> {
  const surname = name.split(/\s+/).pop()?.toLowerCase() ?? '';
  if (surname.length < 3) return undefined;
  await sleep(FETCH_GAP_MS);
  const found = await search(`${name} portrait photograph`);
  return found.find(
    (image) => image.title.toLowerCase().includes(surname) && !NOT_THE_PERSON.test(image.title),
  ) as (CommonsImage & { thumb?: string }) | undefined;
}
