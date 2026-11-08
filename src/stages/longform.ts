import { chosenThumbnail } from './thumbnail.js';
import fs from 'node:fs';
import path from 'node:path';
import { MODELS, dirs, env, workDir } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { ffmpeg, probeDurationMs } from '../ffmpeg.js';
import { hashString } from '../rng.js';
import { spentOn } from '../spend.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import type { PrivacyStatus, VideoMetadata } from '../providers/youtube.js';
import type * as facebook from '../providers/facebook.js';
import { alignWords } from './align.js';
import { requiredCredits } from './images.js';
import { sendToYouTube, type PublishResult } from './publish.js';
import { sendToFacebook, type FacebookPublishResult } from './publishfb.js';

/**
 * Posting what is not a short: book essays and long form.
 *
 * A short's metadata is built from its beat sheet, and neither of these has
 * one -- so until this existed, a finished essay or a three-hour reading could
 * be watched in the app and not posted from it. What they do have is the prose
 * on disk (title first, blank lines between paragraphs) and, for essays, the
 * aligned narration. That is enough to write what a long YouTube video is
 * expected to carry, which is not what a Short carries at all:
 *
 *   - a first line that works on its own, because it is all anyone sees above
 *     the fold and all a search result quotes;
 *   - a few sentences saying what the video is, in the channel's voice;
 *   - chapters, with timestamps, which YouTube turns into the seek bar's
 *     segments -- the single most "professional" thing a long description has;
 *   - sources and credits, which for the openly licensed material are the
 *     licence's one condition rather than a courtesy;
 *   - the synthetic-voice disclosure, and three hashtags last.
 *
 * The model writes the prose parts and the chapter names. Everything factual
 * -- the timestamps, the credits, the disclosure -- is assembled here from
 * files, never asked of the model, because a model asked for a timestamp will
 * give one and a model asked to reproduce a licence line will improve it.
 */

export const LONG_KINDS = ['essay', 'lore'] as const;
export type LongKind = (typeof LONG_KINDS)[number];

export function isLongKind(value: unknown): value is LongKind {
  return typeof value === 'string' && (LONG_KINDS as readonly string[]).includes(value);
}

export function longFile(slug: string, kind: LongKind): string {
  return path.join(dirs.out, `${slug}-${kind}.mp4`);
}

const PROSE_FILE: Record<LongKind, string> = { essay: 'essay.txt', lore: 'saga.txt' };

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const TAGS_MAX_CHARS = 450;
const NL = '\n';

/**
 * Paragraphs, the way the prose file is written and read back.
 *
 * One definition for both directions: the timeline written at render time is
 * a list indexed by paragraph, and reading it against a differently split
 * prose file would put every chapter on the wrong sentence.
 */
export function paragraphsOf(prose: string): string[] {
  return prose
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

const wordsIn = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/* -------------------------------------------------------------- timeline -- */

/**
 * When each paragraph starts, in narration time, plus the lead-in that puts it
 * in video time.
 *
 * Written by the essay stage, which has the alignment in hand anyway, so
 * chapters cost nothing at publish time. `words` must be one per word of the
 * prose -- which is what alignWords returns: it reconciles what whisper heard
 * back onto the script, word for word.
 */
type Timeline = { v: 1; leadInMs: number; starts: number[] };

const timelinePath = (slug: string): string => path.join(workDir(slug), 'timeline.json');

/** When each paragraph of the prose is first spoken, in narration time. */
export function paragraphStarts(prose: string, words: readonly { startMs: number }[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const paragraph of paragraphsOf(prose)) {
    const word = words[Math.min(offset, words.length - 1)];
    starts.push(Math.max(0, Math.round(word?.startMs ?? starts[starts.length - 1] ?? 0)));
    offset += wordsIn(paragraph);
  }
  return starts;
}

export function writeTimeline(
  slug: string,
  prose: string,
  words: readonly { startMs: number }[],
  leadInMs: number,
): void {
  const starts = paragraphStarts(prose, words);
  const timeline: Timeline = { v: 1, leadInMs, starts };
  fs.writeFileSync(timelinePath(slug), `${JSON.stringify(timeline)}\n`, 'utf8');
}

function readTimeline(slug: string, paragraphs: number): Timeline | null {
  try {
    const raw = JSON.parse(fs.readFileSync(timelinePath(slug), 'utf8')) as Timeline;
    // Stale if the prose has been re-split since: every index would be off.
    return raw.v === 1 && Array.isArray(raw.starts) && raw.starts.length === paragraphs
      ? raw
      : null;
  } catch {
    return null;
  }
}

/**
 * The timeline for an essay made before timelines were written.
 *
 * Measured off the finished video, not off voice.wav, because the two do not
 * share a clock. The lead-in title card arrived after the first essays were
 * rendered, so an older file starts speaking at 0:00 and a newer one four
 * seconds in -- and assuming today's lead-in put every chapter of an old
 * essay four seconds late. The video's own audio has whatever lead-in it was
 * made with, so timing that needs no assumption at all.
 *
 * Listened to once, locally, then kept -- so the first description for an old
 * essay waits for whisper and every later one does not. Long form is not
 * measured: a three-hour reading is most of an hour of transcription for a
 * list of chapter marks, and it goes up without them instead.
 */
async function essayTimeline(slug: string, prose: string, paragraphs: number): Promise<Timeline | null> {
  const known = readTimeline(slug, paragraphs);
  if (known !== null) return known;

  const video = longFile(slug, 'essay');
  const scratch = path.join(dirs.cache, 'describe');
  fs.mkdirSync(scratch, { recursive: true });
  const heard = path.join(scratch, `${slug}.wav`);

  log.info('describe: timing the narration once, for the chapter marks');
  try {
    await ffmpeg(['-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', heard]);
    const durationMs = await probeDurationMs(heard);
    const alignment = await alignWords({ audioPath: heard, spokenText: prose, durationMs, force: false });
    writeTimeline(slug, prose, alignment.words, 0);
  } finally {
    fs.rmSync(heard, { force: true });
  }
  return readTimeline(slug, paragraphs);
}

/* -------------------------------------------------------------- chapters -- */

/** What the essay stage wrote down about the cards it put on screen. */
export type ChapterCardRecord = { atMs: number; index: number; title: string };

const chapterCardsPath = (slug: string): string => path.join(workDir(slug), 'chapters.json');

export function writeChapterCards(slug: string, cards: readonly ChapterCardRecord[]): void {
  fs.writeFileSync(chapterCardsPath(slug), `${JSON.stringify({ v: 1, cards }, null, 2)}\n`, 'utf8');
}

function readChapterCards(slug: string): ChapterCardRecord[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(chapterCardsPath(slug), 'utf8')) as {
      v?: number;
      cards?: ChapterCardRecord[];
    };
    return raw.v === 1 && Array.isArray(raw.cards) && raw.cards.length >= 2 ? raw.cards : null;
  } catch {
    return null;
  }
}

type Chapter = { atMs: number; text: string };

const CHAPTERS_FROM_MS = 180_000;

/**
 * Paragraphs grouped into chapters a viewer would actually use.
 *
 * YouTube only draws chapters when the first is at 0:00, there are at least
 * three, and each lasts ten seconds -- and a list of forty chapters for a
 * pasted script's forty one-line paragraphs is not a table of contents. So the
 * target is a chapter every eighth of the runtime, kept between one and four
 * minutes, and a break is only taken where a paragraph starts. Under three
 * minutes there are none: a ninety-second video with a table of contents reads
 * as a template, not as care.
 */
function groupChapters(paragraphs: readonly string[], timeline: Timeline, videoMs: number): Chapter[] | null {
  if (videoMs < CHAPTERS_FROM_MS || paragraphs.length < 3) return null;

  const at = (i: number): number => timeline.leadInMs + (timeline.starts[i] ?? 0);
  const build = (target: number): Chapter[] => {
    const chapters: Chapter[] = [{ atMs: 0, text: paragraphs[0] ?? '' }];
    for (let i = 1; i < paragraphs.length; i++) {
      const current = chapters[chapters.length - 1]!;
      const start = at(i);
      if (start - current.atMs >= target && videoMs - start >= 30_000) {
        chapters.push({ atMs: start, text: paragraphs[i] ?? '' });
      } else {
        current.text += `${NL}${NL}${paragraphs[i] ?? ''}`;
      }
    }
    return chapters;
  };

  let target = Math.min(240_000, Math.max(60_000, videoMs / 8));
  let chapters = build(target);
  while (chapters.length > 15) {
    target *= 1.3;
    chapters = build(target);
  }
  if (chapters.length < 3) chapters = build(Math.max(20_000, videoMs / 4));
  return chapters.length >= 3 ? chapters : null;
}

export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/* --------------------------------------------------------------- writing -- */

type Written = {
  hook: string;
  summary: string;
  chapterTitles: string[];
  tags: string[];
  hashtags: string[];
  /** One question for the comments, about this video's subject. */
  commentPrompt: string;
};

// 2: a question for the comments, and hashtags chosen for reach.
const PROMPT_VERSION = 2;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    hook: { type: 'string' },
    summary: { type: 'string' },
    chapterTitles: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    hashtags: { type: 'array', items: { type: 'string' } },
    commentPrompt: { type: 'string' },
  },
  required: ['hook', 'summary', 'chapterTitles', 'tags', 'hashtags', 'commentPrompt'],
};

const KIND_NOTE: Record<LongKind, string> = {
  essay:
    'a narrated video essay that makes an argument about a book, film or story. Viewers come ' +
    'for the argument; spoilers for the work discussed are expected and may be named.',
  lore:
    'a long, calm, narrated original story set in an invented world, made for listening -- ' +
    'late at night, to fall asleep to, or in the background. Describe the world and the mood, ' +
    'not the plot twists.',
};

function buildPrompt(input: {
  kind: LongKind;
  /** The war channel: military history told for laughs, not a book essay. */
  war?: boolean;
  title: string;
  book: string;
  author: string;
  durationMs: number;
  chapters: readonly Chapter[] | null;
  prose: string;
}): string {
  const body =
    input.chapters === null
      ? `TRANSCRIPT (may be cut short):${NL}${input.prose.slice(0, 9000)}`
      : `THE VIDEO, IN ${input.chapters.length} CHAPTERS:${NL}` +
        input.chapters
          .map(
            (chapter, i) =>
              `--- chapter ${i + 1} at ${clock(chapter.atMs)} ---${NL}` +
              chapter.text.slice(0, Math.max(600, Math.floor(11000 / input.chapters!.length))),
          )
          .join(NL + NL);

  return [
    `Write the YouTube metadata for ${
      input.war === true
        ? 'a narrated, animated military history video told with wit and humour but historically ' +
          'accurate. Viewers come for the true story and the jokes.'
        : KIND_NOTE[input.kind]
    }`,
    '',
    `TITLE: ${input.title}`,
    input.book === '' ? '' : `ABOUT: ${input.book}${input.author === '' ? '' : ` by ${input.author}`}`,
    `LENGTH: ${clock(input.durationMs)}`,
    '',
    body,
    '',
    'Return JSON with:',
    '- hook: one or two sentences, under 150 characters. It is the only text shown above the ' +
      '"more" fold and the text search results quote, so it must stand alone and say ' +
      'specifically what this video argues or is. Confident and plain. No emoji, no hashtags, ' +
      'no questions, no ALL CAPS, and do not start with "In this video".',
    '- summary: two to four sentences, under 600 characters, in the voice of a serious ' +
      'channel describing its own work: what the video covers and why it is worth the time. ' +
      'No emoji, no calls to like or subscribe, no hype words such as "shocking" or "insane".',
    input.chapters === null
      ? '- chapterTitles: an empty array.'
      : `- chapterTitles: exactly ${input.chapters.length} titles, one per chapter in order. ` +
        'Two to six words each, Title Case, naming what that part is about. No numbers, no ' +
        'timestamps, no ending punctuation. Call the first "Introduction" only if it is one.',
    '- tags: 8 to 15 search terms, lower case, most specific first: the work, its author, ' +
      'the characters or people named, then the themes. No "#".',
    '- hashtags: exactly 4, CamelCase, no spaces and no "#", chosen for reach: the first is the ' +
      'most specific subject people actually search (the event, work or person), the second the ' +
      'broad high-traffic category it belongs to (History, MilitaryHistory, BookReview, VideoEssay), ' +
      'the third and fourth the most-searched related terms (a country, an era, the author). Real ' +
      'search terms people type, never slogans or made-up tags.',
    '- commentPrompt: one short, specific question inviting viewers to comment, about this ' +
      "video's subject -- something people will have an opinion on. Under 120 characters, no emoji.",
  ]
    .filter((line) => line !== '')
    .join(NL);
}

/**
 * What is written when the model cannot be asked.
 *
 * Plain rather than clever: the title, the opening of the prose, numbered
 * parts. A description without a key is still a valid, honest one -- chapters
 * named "Part 2" are dull, not wrong.
 */
function fallback(title: string, book: string, author: string, prose: string, chapters: number): Written {
  const first = paragraphsOf(prose)[0] ?? '';
  const sentences = first.match(/[^.!?]+[.!?]+/g) ?? [first];
  const summary = sentences.slice(0, 3).join(' ').trim().slice(0, 500);
  const words = `${title} ${book} ${author}`
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 3);
  const camel = (text: string): string =>
    text
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  return {
    hook: title,
    summary,
    chapterTitles: Array.from({ length: chapters }, (_, i) => (i === 0 ? 'Introduction' : `Part ${i + 1}`)),
    tags: [...new Set([book.toLowerCase(), author.toLowerCase(), ...words].filter(Boolean))],
    hashtags: [camel(book || title), camel(author), 'VideoEssay'].filter(Boolean).slice(0, 3),
    commentPrompt: 'What did you think? Tell us in the comments.',
  };
}

async function write(input: Parameters<typeof buildPrompt>[0] & { slug: string }): Promise<Written> {
  const chapters = input.chapters?.length ?? 0;
  const safe = fallback(input.title, input.book, input.author, input.prose, chapters);
  if (env.GEMINI_API_KEY === undefined) return safe;

  try {
    const { value } = await cache.json<Written>(
      'long-describe',
      {
        v: PROMPT_VERSION,
        model: MODELS.llm.script,
        kind: input.kind,
        war: input.war === true,
        title: input.title,
        book: input.book,
        author: input.author,
        prose: input.prose,
        marks: input.chapters?.map((chapter) => chapter.atMs) ?? [],
      },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction:
            'You write YouTube titles, descriptions and tags for a professional narrated-video ' +
            'channel. You return JSON and nothing else. No preamble, no markdown, no code fences.',
          prompt: buildPrompt(input),
          temperature: 0.4,
          seed: toInt32Seed(hashString(input.slug)),
          maxOutputTokens: 2048,
          responseSchema: RESPONSE_SCHEMA,
        });
        return JSON.parse(response.text) as Written;
      },
    );

    // Trusted for prose, checked for shape: a title list one short would put
    // every later name on the wrong chapter.
    const titles =
      Array.isArray(value.chapterTitles) && value.chapterTitles.length === chapters
        ? value.chapterTitles
        : safe.chapterTitles;
    return {
      hook: typeof value.hook === 'string' && value.hook.trim() !== '' ? value.hook : safe.hook,
      summary: typeof value.summary === 'string' ? value.summary : safe.summary,
      chapterTitles: titles,
      tags: Array.isArray(value.tags) ? value.tags : safe.tags,
      hashtags: Array.isArray(value.hashtags) ? value.hashtags : safe.hashtags,
      commentPrompt:
        typeof value.commentPrompt === 'string' && value.commentPrompt.trim() !== ''
          ? value.commentPrompt.trim()
          : safe.commentPrompt,
    };
  } catch (error) {
    log.warn(`describe: the model could not write it (${(error as Error).message}); using a plain one`);
    return safe;
  }
}

/* ------------------------------------------------------------ assembling -- */

/** Every credit file an essay or reading leaves behind, in the order they read best. */
function creditsFor(slug: string, options: { withSources?: boolean } = {}): string {
  const dir = workDir(slug);
  const files = [
    ...(options.withSources === false ? [] : ['sources.txt']),
    'portraits.txt', 'covers.txt', 'music-credit.txt', 'war-credits.txt',
  ];
  const parts = files
    .map((name) => path.join(dir, name))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8').trim())
    .filter((text) => text !== '');
  const images = tidyImageCredits(requiredCredits(slug));
  if (images !== '') parts.push(images);
  return parts.join(NL + NL);
}

/**
 * The credits file, as a viewer should read it.
 *
 * Its section headings carry a second line written for whoever runs this tool
 * -- which licences the search admits, that Pexels does not require credit --
 * and in a public description those read as a disclaimer nobody asked for.
 * The attribution itself (title, author, licence, link) is left exactly as
 * written; only the notes go, and ".jpg" comes off the end of a title.
 */
function tidyImageCredits(text: string): string {
  const note = /^(Public domain and CC BY only;|Free for commercial use\. Attribution is not required)/;
  const extension = /\.(jpe?g|png|tiff?|webp|gif|svg)$/i;
  return text
    .split(NL)
    .filter((line) => !note.test(line))
    .map((line) => (/^\S/.test(line) ? line.replace(extension, '') : line))
    .join(NL)
    .trim();
}

/**
 * What the viewer is told was made by a machine, as specifically as is known.
 *
 * The voice always is. The pictures are said to be generated only when the
 * spend log shows they were paid for on this video; when there is no record
 * either way -- a video older than the log -- it says they may be, because
 * claiming nothing was generated is the one wrong answer that matters.
 */
function disclosure(slug: string, hasCredits: boolean): string {
  const voice = 'Narrated with an AI-generated voice.';
  if (spentOn(slug, 'pictures')) {
    return `${voice} Illustrations are AI-generated${hasCredits ? ', except where credited above' : ''}.`;
  }
  return hasCredits ? voice : `${voice} Some visuals may be AI-generated.`;
}

const clean = (text: string): string => text.replace(/[<>]/g, '').replace(/[ \t]+\n/g, NL).trim();

/**
 * The first comment under a video: where to read more, a way to subscribe, and
 * a question to answer. "{subscribe}" is filled with the channel's own link at
 * upload, since which channel is only known then.
 */
export function firstComment(options: { reference?: string | undefined; war?: boolean; question?: string }): string {
  const link = options.reference === undefined ? null : /(https?:\/\/\S+)$/.exec(options.reference)?.[1] ?? null;
  const subject = options.reference?.replace(/\s*\(Wikipedia\).*$/, '') ?? '';
  return [
    link === null ? '' : `📚 Want the full story? Read more about ${subject}:${NL}${link}`,
    `🔔 Subscribe for more ${options.war === true ? 'ridiculous (but 100% true) history, told the fun way' : 'stories like this'}: {subscribe}`,
    `${options.question ?? 'What should we cover next?'} 👇`,
  ]
    .filter(Boolean)
    .join(NL + NL);
}

const readText = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');

/**
 * The copyright position. The fair-use paragraph is the statute's own terms --
 * section 107 names criticism, comment, teaching, scholarship and research --
 * followed by what the video is and a way to reach the channel, because a
 * rights holder who can see a way to sort something out usually takes it.
 */
const COPYRIGHT = [
  'COPYRIGHT AND FAIR USE',
  'Copyright Disclaimer under Section 107 of the Copyright Act of 1976: allowance is made for "fair ' +
    'use" for purposes such as criticism, comment, news reporting, teaching, scholarship and ' +
    'research. Fair use is a use permitted by copyright statute that might otherwise be infringing.',
  'This video is an original work of commentary and education. Any third-party material shown ' +
    'belongs to its respective owners and is used under fair use; openly licensed material is ' +
    'credited above. If you own something shown here and would like it credited differently or ' +
    'removed, contact the channel and it will be sorted out.',
].join(NL);

/**
 * Real pages about the subject, for "further reading".
 *
 * Asked of Wikipedia's own search and kept only when the article it finds is
 * plainly the subject -- most of its title's words are in what was asked --
 * so every link printed is a page that exists and is about this. A model
 * asked for references writes plausible ones, and a plausible reference that
 * does not exist under a video about history is the worst thing it could say.
 */
export async function referencesFor(slug: string, subjects: readonly string[]): Promise<string[]> {
  const words = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !['the', 'and', 'that', 'this', 'with', 'from', 'why', 'how'].includes(word));
  const found: string[] = [];
  const seen = new Set<string>();
  for (const subject of subjects) {
    if (subject.trim() === '') continue;
    try {
      const { value } = await cache.json<{ title: string } | null>('wiki-reference', { v: 1, q: subject }, async () => {
        const url =
          'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=' +
          encodeURIComponent(subject);
        const res = await fetch(url, {
          headers: { 'User-Agent': 'BreezeMatic/1.0 (video descriptions)' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { query?: { search?: { title: string }[] } };
        const hit = body.query?.search?.[0];
        return hit === undefined ? null : { title: hit.title };
      });
      if (value === null || seen.has(value.title)) continue;
      const theirs = words(value.title);
      const ours = new Set(words(subject));
      const shared = theirs.filter((word) => ours.has(word)).length;
      if (theirs.length === 0 || shared / theirs.length < 0.6) continue;
      seen.add(value.title);
      found.push(`${value.title} (Wikipedia) https://en.wikipedia.org/wiki/${encodeURIComponent(value.title.replace(/ /g, '_'))}`);
    } catch (error) {
      log.debug(`describe: no reference for "${subject}" (${(error as Error).message})`);
    }
    if (found.length >= 3) break;
  }
  void slug;
  return found;
}

export type LongDescription = {
  kind: LongKind;
  file: string;
  title: string;
  description: string;
  tags: string[];
  /** The Facebook post: no chapters, which a Page video cannot use. */
  facebookText: string;
  chapters: number;
  durationMs: number;
  /** A draft first comment: further reading, subscribe, a question. */
  comment: string;
};

/**
 * One description per video at a time.
 *
 * Opening a finished essay asks for the YouTube card and the Facebook card at
 * once, and both need this. For an older essay that means a whisper pass of a
 * minute or two -- and two requests arriving together would each start their
 * own, and each pay for their own model call, before either had cached a
 * thing. So a second caller waits on the first one's answer.
 */
const inflight = new Map<string, Promise<LongDescription>>();

export function describeLong(slug: string, kind: LongKind): Promise<LongDescription> {
  const key = `${kind}:${slug}`;
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  const job = describeOnce(slug, kind).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function describeOnce(slug: string, kind: LongKind): Promise<LongDescription> {
  const file = longFile(slug, kind);
  if (!fs.existsSync(file)) throw new Error('render the video before publishing it');
  const proseFile = path.join(workDir(slug), PROSE_FILE[kind]);
  if (!fs.existsSync(proseFile)) throw new Error(`no ${PROSE_FILE[kind]} for "${slug}"`);

  const [firstLine = slug, ...rest] = fs.readFileSync(proseFile, 'utf8').split(NL);
  const title = firstLine.trim() || slug;
  const prose = rest.join(NL).trim();
  const paragraphs = paragraphsOf(prose);

  let book = '';
  let author = '';
  if (kind === 'essay') {
    try {
      const brief = JSON.parse(fs.readFileSync(path.join(workDir(slug), 'case.json'), 'utf8')) as {
        book?: string;
        author?: string;
      };
      // A supplied script's "book" is its own title; that is not a subject.
      book = brief.book !== undefined && brief.book !== title ? brief.book : '';
      author = brief.author ?? '';
    } catch {
      // No brief is fine: the title carries the subject.
    }
  }

  const videoMs = await probeDurationMs(file);

  /**
   * The chapters the video itself was cut into, when it has them.
   *
   * Written by the essay stage, which puts a card on screen at each one, so
   * the description's contents and the video's own chapters are the same list
   * rather than two guesses at the same thing.
   */
  const onScreen = readChapterCards(slug);
  /**
   * Chapters only when the video has them: the cards it shows on screen.
   *
   * A video without cards used to get chapters anyway -- cut from the
   * transcript and named by the model -- so the description promised
   * sections the video never marked. The list below the video and the video
   * are now the same thing, or there is no list.
   */
  const chapters =
    onScreen !== null && videoMs >= CHAPTERS_FROM_MS
      // YouTube draws no chapters at all unless the first is at 0:00, and the
      // title card in front of chapter one is part of chapter one.
      ? onScreen.map((card, i) => ({ atMs: i === 0 ? 0 : card.atMs, text: '' }))
      : null;
  void paragraphs;

  // Titles the video already shows are not for the model to rename.
  // The war channel leaves its credits file; nothing else writes one.
  const war = fs.existsSync(path.join(workDir(slug), 'war-credits.txt'));
  const written = await write({
    slug,
    kind,
    war,
    title,
    book,
    author,
    durationMs: videoMs,
    chapters: onScreen === null ? chapters : null,
    prose,
  });
  const chapterTitles = onScreen === null ? written.chapterTitles : onScreen.map((card) => card.title);

  const hashtags = written.hashtags
    .map((tag) => tag.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .filter((tag, i, all) => all.findIndex((t) => t.toLowerCase() === tag.toLowerCase()) === i)
    .slice(0, 4)
    .map((tag) => `#${tag}`)
    .join(' ');

  /**
   * The description, as a professional channel lays one out.
   *
   *   hook              above the "more" fold: what search and the feed show
   *   about             what the video covers
   *   chapters          only when the video has them -- YouTube builds the
   *                     chapter bar from this list, and a list it rejects is
   *                     worse than none
   *   references        real pages about the subject, checked to exist
   *   credits           everything the video used that someone else made
   *   AI disclosure     the voice and pictures, said plainly
   *   copyright         the fair-use position, section 107
   *   thanks            watch, like, share, subscribe, and a real question
   *   hashtags          four, last, where YouTube reads them
   *
   * Headings are capitals on their own line: they survive every screen the
   * description is read on, which emoji and box-drawing do not.
   */
  const section = (heading: string, body: string): string => (body.trim() === '' ? '' : `${heading}${NL}${body.trim()}`);
  const chapterBlock =
    chapters === null
      ? ''
      : section('CHAPTERS', chapters.map((chapter, i) => `${clock(chapter.atMs)} ${chapterTitles[i] ?? ''}`.trim()).join(NL));
  const references = await referencesFor(slug, [title, book, author]);
  const sources = readText(path.join(workDir(slug), 'sources.txt'));
  const credits = creditsFor(slug, { withSources: false });
  const thanks = section(
    'THANKS FOR WATCHING',
    'If you enjoyed this, give it a like, share it with someone who would love it, and subscribe ' +
      `so you do not miss the next one.${NL}${written.commentPrompt} Tell us in the comments.`,
  );

  const tail = [
    chapterBlock,
    section('SOURCES AND FURTHER READING', [sources, ...references].filter(Boolean).join(NL)),
    section('CREDITS', credits),
    disclosure(slug, credits !== ''),
    COPYRIGHT,
    thanks,
    hashtags,
  ].filter((block) => block !== '');
  const tailText = tail.join(NL + NL);
  // The summary is what gives way, never the chapters, the credits or the notice.
  const about = section('ABOUT THIS VIDEO', written.summary);
  const room = DESCRIPTION_MAX - tailText.length - written.hook.length - 8;
  const aboutFits = about.length <= room ? about : room > 40 ? about.slice(0, room) : '';
  const description = clean([written.hook, aboutFits, tailText].filter(Boolean).join(NL + NL)).slice(0, DESCRIPTION_MAX);

  const facebookText = clean(
    [
      written.hook,
      written.summary,
      section('SOURCES AND FURTHER READING', [sources, ...references].filter(Boolean).join(NL)),
      section('CREDITS', credits),
      disclosure(slug, credits !== ''),
      COPYRIGHT,
      thanks,
      hashtags,
    ]
      .filter(Boolean)
      .join(NL + NL),
  ).slice(0, DESCRIPTION_MAX);

  const tags: string[] = [];
  let budget = TAGS_MAX_CHARS;
  for (const raw of written.tags) {
    const tag = raw.replace(/[<>#,"]/g, '').trim().toLowerCase();
    if (tag === '' || tags.includes(tag) || tag.length + 1 > budget) continue;
    tags.push(tag);
    budget -= tag.length + 1;
  }

  return {
    kind,
    file,
    title: clean(title).slice(0, TITLE_MAX),
    description,
    tags,
    facebookText,
    chapters: chapters?.length ?? 0,
    durationMs: videoMs,
    comment: firstComment({ reference: references[0], war, question: written.commentPrompt }),
  };
}

/* -------------------------------------------------------------- posting -- */

export function longYouTubeMetadata(
  described: LongDescription,
  options: { privacyStatus?: PrivacyStatus; title?: string; description?: string; categoryId?: string } = {},
): VideoMetadata {
  return {
    title: (options.title ?? described.title).replace(/[<>]/g, '').slice(0, TITLE_MAX),
    description: (options.description ?? described.description).replace(/[<>]/g, '').slice(0, DESCRIPTION_MAX),
    tags: described.tags,
    categoryId: options.categoryId ?? env.YOUTUBE_CATEGORY_ID,
    privacyStatus: options.privacyStatus ?? env.YOUTUBE_PRIVACY,
    // The voice is synthesised on every render, so this is never not true.
    containsSyntheticMedia: true,
  };
}

export function longFacebookMetadata(
  described: LongDescription,
  options: { published?: boolean; title?: string; description?: string } = {},
): facebook.VideoMetadata {
  return {
    title: (options.title ?? described.title).slice(0, 255),
    description: (options.description ?? described.facebookText).slice(0, DESCRIPTION_MAX),
    containsSyntheticMedia: true,
    published: options.published ?? env.FACEBOOK_PUBLISHED,
  };
}

export async function publishLongToYouTube(options: {
  slug: string;
  kind: LongKind;
  privacyStatus?: PrivacyStatus;
  title?: string;
  description?: string;
  categoryId?: string;
  /** Which connected channel it goes to. Absent: the default. */
  channelId?: string | null;
  /** The first comment, as the card last showed it. */
  comment?: string;
}): Promise<PublishResult> {
  const described = await describeLong(options.slug, options.kind);
  return sendToYouTube({
    ...(options.comment !== undefined ? { comment: options.comment } : {}),
    ...(options.channelId !== undefined ? { channelId: options.channelId } : {}),
    slug: options.slug,
    topic: described.title,
    file: described.file,
    metadata: longYouTubeMetadata(described, options),
    shortForm: false,
    // The one picked in the editor, or the first of the three made for it.
    thumbnail: chosenThumbnail(options.slug),
  });
}

export async function publishLongToFacebook(options: {
  slug: string;
  kind: LongKind;
  published?: boolean;
  title?: string;
  description?: string;
}): Promise<FacebookPublishResult> {
  const described = await describeLong(options.slug, options.kind);
  return sendToFacebook({
    slug: options.slug,
    topic: described.title,
    file: described.file,
    metadata: longFacebookMetadata(described, options),
  });
}
