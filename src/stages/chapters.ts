import fs from 'node:fs';
import path from 'node:path';
import { MODELS, env } from '../config.js';
import { cache } from '../cache.js';
import { ffmpeg, probeDurationMs } from '../ffmpeg.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import { CHAPTER_PAUSE_MS, type ChapterCard } from './compose.js';
import type { Word } from '../schema.js';

/**
 * Chapters: where an essay stops, names what is coming, and carries on.
 *
 * Three things have to agree for that to work, and they are all here rather
 * than spread through the pipeline:
 *
 *   the reading  a real pause is cut into the narration before each chapter,
 *                so the card is silence rather than a caption over a sentence.
 *                Everything downstream is timed against the reading, so this
 *                happens before the edit is planned and the words that come
 *                back are the shifted ones.
 *   the picture  the renderer draws the card during that pause.
 *   the listing  the same titles and times go in the YouTube description.
 *
 * Where the chapters come from is the caller's decision, and the default is
 * "only where the script says". A script marks one with `# ` at the start of
 * a line, and then the chapters are exactly where the writer put them.
 *
 * Working them out from the runtime instead is possible and is no longer the
 * default. It used to be, for anything past five minutes, and it meant a
 * video came back cut into parts nobody asked for, with a card reading
 * "Opening" that the writer never wrote -- which is the software having
 * opinions about somebody else's essay.
 */

/** Below this there are no chapters unless the script asks for them. */
export const CHAPTERS_FROM_MS = 5 * 60_000;
/** Fewer than this and it is not a video in chapters, it is a video. */
const MIN_CHAPTERS = 2;
const MAX_CHAPTERS = 12;
/** Nothing shorter than this is worth stopping for. */
const MIN_CHAPTER_MS = 75_000;

/**
 * Where chapters come from.
 *
 *   script  only where the script marks them with `# `. The default: nothing
 *           appears that the writer did not ask for.
 *   auto    marks if there are any, otherwise worked out from the runtime.
 *   off     none, whatever the script says.
 */
export type ChapterMode = 'script' | 'auto' | 'off';

export type MarkedScript = {
  /** The prose, with the heading lines taken out. */
  sections: string[];
  /** Section index -> the heading that was written above it. */
  marks: Map<number, string>;
};

/**
 * Headings pulled out of a supplied script.
 *
 * `# The trap` on its own line marks the start of a chapter. The line is not
 * prose and is never spoken: it is removed here, before the script reaches
 * the reader, so a heading cannot be read aloud as a sentence.
 */
export function markChapters(sections: readonly string[]): MarkedScript {
  const out: string[] = [];
  const marks = new Map<number, string>();
  let pending: string | null = null;

  for (const section of sections) {
    const lines = section.split('\n');
    const body: string[] = [];
    for (const line of lines) {
      const heading = /^\s{0,3}#{1,3}\s+(.+?)\s*$/.exec(line);
      if (heading !== null && body.length === 0) {
        pending = heading[1]!.trim();
        continue;
      }
      body.push(line);
    }
    const text = body.join('\n').trim();
    if (text === '') continue;
    if (pending !== null) {
      marks.set(out.length, pending);
      pending = null;
    }
    out.push(text);
  }
  return { sections: out, marks };
}

/**
 * Where to break an essay that did not say, by the clock.
 *
 * Only ever at a paragraph, never closer together than MIN_CHAPTER_MS, and
 * aiming for a chapter every eighth of the runtime -- the same shape the
 * description's chapter list uses, because they are the same chapters.
 */
export function groupByTime(starts: readonly number[], durationMs: number): number[] {
  if (starts.length < MIN_CHAPTERS || durationMs < CHAPTERS_FROM_MS) return [];
  const target = Math.max(MIN_CHAPTER_MS, durationMs / 8);

  const build = (every: number): number[] => {
    const indexes = [0];
    for (let i = 1; i < starts.length; i++) {
      const at = starts[i]!;
      const last = starts[indexes[indexes.length - 1]!]!;
      // Nothing may start a chapter it cannot fill: a last chapter of twenty
      // seconds is a card with an outro behind it.
      if (at - last >= every && durationMs - at >= MIN_CHAPTER_MS) indexes.push(i);
    }
    return indexes;
  };

  let every = target;
  let indexes = build(every);
  while (indexes.length > MAX_CHAPTERS) {
    every *= 1.3;
    indexes = build(every);
  }
  return indexes.length >= MIN_CHAPTERS ? indexes : [];
}

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { titles: { type: 'array', items: { type: 'string' } } },
  required: ['titles'],
};

/**
 * Names for chapters the writer did not name.
 *
 * Short, plain and about that part of the argument. The fallback is "Part
 * two" and so on, which is dull and correct -- a chapter card with a wrong
 * name on it is worse than one with a dull name.
 */
async function nameChapters(options: {
  slug: string;
  title: string;
  texts: readonly string[];
  seed: number;
}): Promise<string[]> {
  const plain = options.texts.map((_, i) => (i === 0 ? 'Opening' : `Part ${i + 1}`));
  if (env.GEMINI_API_KEY === undefined) return plain;

  try {
    const { value } = await cache.json<{ titles: string[] }>(
      'chapter-titles',
      { v: 1, model: MODELS.llm.script, title: options.title, texts: options.texts },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction:
            'You name the chapters of a narrated video essay. You return JSON and nothing else. ' +
            'No preamble, no markdown, no code fences.',
          prompt: [
            `The essay is called "${options.title}". It is in ${options.texts.length} parts.`,
            '',
            ...options.texts.map(
              (text, i) => `--- part ${i + 1} ---\n${text.slice(0, Math.floor(9000 / options.texts.length))}`,
            ),
            '',
            `Return JSON with "titles": exactly ${options.texts.length} chapter titles, one per part, in order.`,
            'Two to five words each, Title Case, naming what that part is about. They are typed on',
            'screen one at a time, so they are headings, not sentences: no numbers, no punctuation',
            'at the end, no "Part one", no colons.',
          ].join('\n'),
          temperature: 0.5,
          seed: toInt32Seed(options.seed),
          maxOutputTokens: 1024,
          responseSchema: RESPONSE_SCHEMA,
        });
        return JSON.parse(response.text) as { titles: string[] };
      },
    );
    const titles = value.titles ?? [];
    return titles.length === options.texts.length
      ? titles.map((title, i) => title.trim().replace(/[.:;]+$/, '') || plain[i]!)
      : plain;
  } catch (error) {
    log.warn(`chapters: could not name them (${(error as Error).message}); numbering instead`);
    return plain;
  }
}

export type ChapteredReading = {
  /** The narration with the pauses cut into it. */
  audioPath: string;
  durationMs: number;
  /** The same words, moved by the pauses in front of them. */
  words: Word[];
  cards: ChapterCard[];
};

/**
 * The reading, stopped where the chapters are.
 *
 * A pause goes in front of every chapter including the first, which is what
 * gives the opening card its own silence after the title. The words are moved
 * by however much silence now precedes them, so everything timed against them
 * afterwards -- the cuts, the captions, the cuttings, the quotations -- lands
 * where it did relative to the speech.
 */
/**
 * How far before the first word of a chapter to make the cut.
 *
 * Cutting exactly on the word's reported start left the first consonant of
 * the new chapter at the tail of the old one -- a syllable, then three and a
 * half seconds of silence, then the same word again. Aligners report a word
 * start a little after its true onset, and a plosive begins before anybody
 * says it does. So the cut goes back into the gap the reader left, never past
 * the previous word.
 */
const CUT_LEAD_MS = 220;
/** How far from the intended break a real pause may be and still be used. */
const SNAP_WINDOW_MS = 900;
/** Quieter than this, for this long, is the reader breathing rather than speaking. */
const SILENCE_DB = -38;
const SILENCE_MS = 110;
/** Never closer than this to the previous word, so nothing is clipped off it. */
const CUT_KEEP_MS = 60;

/**
 * The quiet stretches in the reading, measured rather than inferred.
 *
 * Word timings put the cut a few milliseconds late and the first consonant of
 * the new chapter was left behind -- measured on a nine-minute essay, the
 * 150ms before every one of its five cuts was speech at -11 to -21 dB, where
 * it should have been silence. The reader's own pauses are in the audio, so
 * they are read off the audio.
 */
async function silences(audioPath: string): Promise<{ startMs: number; endMs: number }[]> {
  try {
    const { stderr } = await ffmpeg([
      '-i', audioPath,
      '-af', `silencedetect=noise=${SILENCE_DB}dB:d=${(SILENCE_MS / 1000).toFixed(3)}`,
      '-f', 'null', '-',
    ]);
    const found: { startMs: number; endMs: number }[] = [];
    let open: number | null = null;
    for (const line of stderr.split('\n')) {
      const start = /silence_start:\s*([0-9.]+)/.exec(line);
      if (start !== null) open = Number(start[1]) * 1000;
      const end = /silence_end:\s*([0-9.]+)/.exec(line);
      if (end !== null && open !== null) {
        found.push({ startMs: open, endMs: Number(end[1]) * 1000 });
        open = null;
      }
    }
    return found;
  } catch (error) {
    log.debug(`chapters: could not measure the pauses (${(error as Error).message})`);
    return [];
  }
}

/** The middle of the reader's own pause nearest the break, if there is one. */
function snapToSilence(quiet: readonly { startMs: number; endMs: number }[], at: number): number | null {
  let best: { startMs: number; endMs: number } | null = null;
  let closest = Infinity;
  for (const gap of quiet) {
    // How far the break is from this pause: zero when it falls inside it.
    const distance = at < gap.startMs ? gap.startMs - at : at > gap.endMs ? at - gap.endMs : 0;
    if (distance < closest && distance <= SNAP_WINDOW_MS) {
      closest = distance;
      best = gap;
    }
  }
  return best === null ? null : Math.round((best.startMs + best.endMs) / 2);
}

function cutPoint(words: readonly Word[], at: number): number {
  if (at <= 0) return 0;
  let previousEnd = 0;
  for (const word of words) {
    if (word.endMs > at) break;
    if (word.endMs > previousEnd) previousEnd = word.endMs;
  }
  const gap = at - previousEnd;
  if (gap <= CUT_KEEP_MS) return Math.max(0, at - CUT_KEEP_MS / 2);
  // As early as the lead allows, but always inside the reader's own pause.
  return Math.round(Math.max(previousEnd + CUT_KEEP_MS, at - CUT_LEAD_MS));
}

export async function cutChapterPauses(options: {
  audioPath: string;
  dir: string;
  /** Paragraph start times in the original reading. */
  starts: readonly number[];
  /** Which paragraphs begin a chapter, in order. */
  indexes: readonly number[];
  titles: readonly string[];
  words: readonly Word[];
  durationMs: number;
  sampleRate: number;
}): Promise<ChapteredReading> {
  const quiet = await silences(options.audioPath);
  const breaks = options.indexes
    .map((index) => {
      const at = Math.max(0, Math.round(options.starts[index] ?? 0));
      // The reader's own pause where there is one; the word timings otherwise.
      return snapToSilence(quiet, at) ?? cutPoint(options.words, at);
    })
    .filter((at, i, all) => i === 0 || at > all[i - 1]!);
  log.info(`chapters: ${breaks.length} break(s), ${quiet.length} pause(s) found in the reading`);

  const out = path.join(options.dir, 'voice-chapters.wav');
  const pause = CHAPTER_PAUSE_MS / 1000;

  /**
   * One trim per stretch of speech, one silence per chapter, concatenated.
   * `asetpts` after each trim because atrim keeps the source timestamps, and
   * concat on streams that all start at zero is the only way it lines up.
   */
  const inputs: string[] = ['-i', options.audioPath];
  const parts: string[] = [];
  const labels: string[] = [];
  const edges = [...breaks, options.durationMs];
  for (const [i, at] of breaks.entries()) {
    inputs.push('-f', 'lavfi', '-t', pause.toFixed(3), '-i', `anullsrc=r=${options.sampleRate}:cl=mono`);
    const silence = i + 1;
    if (i === 0 && at > 0) {
      parts.push(`[0:a]atrim=start=0:end=${(at / 1000).toFixed(3)},asetpts=N/SR/TB[t${i}]`);
      labels.push(`[t${i}]`);
    }
    labels.push(`[${silence}:a]`);
    const end = edges[i + 1]!;
    parts.push(
      `[0:a]atrim=start=${(at / 1000).toFixed(3)}${end >= options.durationMs ? '' : `:end=${(end / 1000).toFixed(3)}`},` +
        `asetpts=N/SR/TB[s${i}]`,
    );
    labels.push(`[s${i}]`);
  }
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`);

  await ffmpeg([
    ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[out]',
    '-ac', '1',
    '-ar', String(options.sampleRate),
    '-f', 'wav',
    out,
  ]);

  // How much silence now sits in front of any given moment of the old reading.
  const shiftAt = (ms: number): number =>
    breaks.reduce((sum, at) => (ms >= at ? sum + CHAPTER_PAUSE_MS : sum), 0);

  const words = options.words.map((word) => ({
    ...word,
    startMs: word.startMs + shiftAt(word.startMs),
    endMs: word.endMs + shiftAt(word.startMs),
  }));

  const cards: ChapterCard[] = breaks.map((at, i) => ({
    // The card owns the silence: it starts where the speech stopped.
    atMs: at + i * CHAPTER_PAUSE_MS,
    index: i + 1,
    title: options.titles[i] ?? `Part ${i + 1}`,
  }));

  const durationMs = await probeDurationMs(out);
  log.info(
    `chapters: ${cards.length} — ${cards.map((card) => `${card.index}. ${card.title}`).join(', ')}`,
  );
  return { audioPath: out, durationMs, words, cards };
}

/**
 * Everything above, for one essay: decide the chapters, name them, and cut
 * the pauses in. Returns null when this essay has none, which is the ordinary
 * case for anything short.
 */
export async function planChapters(options: {
  slug: string;
  dir: string;
  title: string;
  seed: number;
  sections: readonly string[];
  marks: ReadonlyMap<number, string>;
  starts: readonly number[];
  words: readonly Word[];
  audioPath: string;
  durationMs: number;
  sampleRate: number;
  /** Defaults to 'script': nothing appears that the script did not ask for. */
  mode?: ChapterMode;
}): Promise<ChapteredReading | null> {
  const mode = options.mode ?? 'script';
  if (mode === 'off') return null;

  let indexes: number[];
  let titles: string[];

  if (options.marks.size > 0) {
    // Written into the script: taken exactly as given, however long the essay.
    indexes = [...options.marks.keys()].sort((a, b) => a - b);
    titles = indexes.map((index) => options.marks.get(index)!);
    /**
     * No invented opening card.
     *
     * Prose before the first heading simply has no card over it, which is
     * what a writer who put their first `#` on page two asked for. The
     * description still lists 0:00 as the start, because YouTube requires a
     * chapter there and that list is not the same thing as a card on screen.
     */
  } else {
    if (mode !== 'auto') return null;
    indexes = groupByTime(options.starts, options.durationMs);
    if (indexes.length < MIN_CHAPTERS) return null;
    const texts = indexes.map((start, i) =>
      options.sections.slice(start, indexes[i + 1] ?? options.sections.length).join('\n\n'),
    );
    titles = await nameChapters({ slug: options.slug, title: options.title, texts, seed: options.seed });
  }

  if (indexes.length < MIN_CHAPTERS) return null;
  return cutChapterPauses({
    audioPath: options.audioPath,
    dir: options.dir,
    starts: options.starts,
    indexes,
    titles,
    words: options.words,
    durationMs: options.durationMs,
    sampleRate: options.sampleRate,
  });
}

/** True when the script itself asked for chapters. */
export function hasMarkers(text: string): boolean {
  return /(^|\n)\s{0,3}#{1,3}\s+\S/.test(text);
}

/** Kept for the description, so both lists are the same list. */
export function chapterCardsFile(dir: string): string {
  return path.join(dir, 'chapters.json');
}

export function forgetChapterCards(dir: string): void {
  fs.rmSync(chapterCardsFile(dir), { force: true });
}
