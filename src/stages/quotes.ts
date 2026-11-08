import crypto from 'node:crypto';
import { MODELS, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import { publicDomainText, type SourceText } from '../providers/gutenberg.js';
import type { QuoteCard, TimedWord } from './compose.js';

/**
 * Quotations, checked against the book itself.
 *
 * A language model's memory of a novel is good enough to produce a line that
 * sounds exactly like the author and is not in the book, and a channel about
 * books that misquotes the book has lost the only argument it had. With the
 * text from Project Gutenberg on hand, nothing reaches the screen as a
 * quotation unless it is on the page, word for word.
 */

/** A run of words this long, matching the book exactly, is a quotation rather than a coincidence. */
const MIN_QUOTE_WORDS = 7;
/** Longer than this and it is a reading, not a quotation, and it would not fit a card. */
const MAX_QUOTE_WORDS = 48;
/** How much of a very long book the quote picker is shown. About 150k tokens. */
const MAX_BOOK_CHARS = 600_000;

const normalise = (word: string): string =>
  word.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

type Token = { word: string; start: number; end: number };

/** The book as words, each remembering where it sits in the text. */
function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu)) {
    const word = normalise(match[0]);
    if (word === '') continue;
    tokens.push({ word, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** Every run of MIN_QUOTE_WORDS words in the book, to where it first occurs. */
function indexOf(tokens: readonly Token[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i + MIN_QUOTE_WORDS <= tokens.length; i++) {
    const key = tokens
      .slice(i, i + MIN_QUOTE_WORDS)
      .map((token) => token.word)
      .join(' ');
    if (!index.has(key)) index.set(key, i);
  }
  return index;
}

/**
 * The printed form of a run of the book's words: its own punctuation and
 * capitals, one line, without Gutenberg's _underscores_ for italics, and with
 * the full stop or closing mark that ends it.
 */
function printed(text: string, tokens: readonly Token[], from: number, to: number): string {
  let end = tokens[to]!.end;
  while (end < text.length && /[.,;:!?'"’”)]/.test(text[end]!)) end++;
  return text
    .slice(tokens[from]!.start, end)
    .replace(/_/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type BookSource = {
  source: SourceText;
  tokens: Token[];
  index: Map<string, number>;
};

/** The book's text, ready to be searched, or null when it is not public domain. */
export async function loadSource(book: string, author: string): Promise<BookSource | null> {
  const source = await publicDomainText(book, author).catch(() => null);
  if (source === null) return null;
  const tokens = tokenise(source.text);
  return { source, tokens, index: indexOf(tokens) };
}

/**
 * Where the narration quotes the book, found by matching its words against
 * the text: any run of seven or more consecutive words that appears in the
 * book exactly. Times are the narration's own, from the aligned transcript.
 */
export function findQuotations(options: {
  words: readonly TimedWord[];
  book: BookSource;
  attribution: string;
}): QuoteCard[] {
  const { words, book } = options;
  const heard = words.map((word) => normalise(word.text));
  const cards: QuoteCard[] = [];

  for (let i = 0; i + MIN_QUOTE_WORDS <= heard.length; ) {
    const key = heard.slice(i, i + MIN_QUOTE_WORDS).join(' ');
    const at = book.index.get(key);
    if (at === undefined) {
      i++;
      continue;
    }
    // As far as the narration and the page keep agreeing.
    let length = MIN_QUOTE_WORDS;
    while (
      i + length < heard.length &&
      at + length < book.tokens.length &&
      heard[i + length] === book.tokens[at + length]!.word
    ) {
      length++;
    }
    if (length <= MAX_QUOTE_WORDS) {
      cards.push({
        text: printed(book.source.text, book.tokens, at, at + length - 1),
        attribution: options.attribution,
        speakStartMs: words[i]!.startMs,
        speakEndMs: words[i + length - 1]!.endMs,
      });
    }
    i += length;
  }
  return cards;
}

/* ----------------------------------------------------------- the writer -- */

const QUOTES_SCHEMA = {
  type: 'object',
  properties: {
    quotes: { type: 'array', items: { type: 'string' } },
  },
  required: ['quotes'],
};

/**
 * Lines the essay may quote, chosen from the book and then checked against it.
 *
 * The model is shown the book and asked for lines that serve the argument,
 * copied exactly. Then every one is looked up: a line that is not on the page
 * word for word -- which happens, even with the page in front of it -- is
 * dropped, and one that is comes back in the book's own punctuation. What the
 * writer receives is only ever real.
 */
export async function chooseQuotations(options: {
  book: BookSource;
  thesis: string;
  evidence: readonly string[];
  count: number;
  seed: number;
}): Promise<string[]> {
  if (env.GEMINI_API_KEY === undefined) return [];
  const text = options.book.source.text.slice(0, MAX_BOOK_CHARS);

  const { value } = await cache.json<{ quotes: string[] }>(
    'essay-quotes',
    {
      v: 1,
      model: MODELS.llm.script,
      book: options.book.source.id,
      thesis: options.thesis,
      count: options.count,
      seed: options.seed,
    },
    async () => {
      const response = await generate({
        model: MODELS.llm.script,
        systemInstruction:
          'You choose quotations from a book for a video essay about it. You return JSON and ' +
          'nothing else.',
        prompt: [
          `The full text of "${options.book.source.title}" by ${options.book.source.author}:`,
          '"""',
          text,
          '"""',
          '',
          `The essay argues: ${options.thesis}`,
          options.evidence.length === 0 ? '' : `It rests on: ${options.evidence.join('; ')}`,
          '',
          `Choose up to ${options.count} lines from the book that the essay could quote to make`,
          'its case -- the lines a reader remembers, or the ones that prove the point. Each',
          'between eight and thirty words, one sentence or a clause of one.',
          '',
          'Copy each line EXACTLY as it is printed above, character for character. Every line',
          'is checked against the text, and one that is not found word for word is thrown away.',
        ].join('\n'),
        temperature: 0.4,
        seed: toInt32Seed(options.seed),
        maxOutputTokens: 2048,
        responseSchema: QUOTES_SCHEMA,
      });
      return JSON.parse(response.text) as { quotes: string[] };
    },
  );

  const verified: string[] = [];
  for (const line of value.quotes ?? []) {
    const words = tokenise(line).map((token) => token.word);
    if (words.length < MIN_QUOTE_WORDS) continue;
    const at = options.book.index.get(words.slice(0, MIN_QUOTE_WORDS).join(' '));
    if (at === undefined) continue;
    const agrees = words.every((word, offset) => options.book.tokens[at + offset]?.word === word);
    if (!agrees) continue;
    verified.push(printed(options.book.source.text, options.book.tokens, at, at + words.length - 1));
  }
  const dropped = (value.quotes ?? []).length - verified.length;
  log.info(
    `quotes: ${verified.length} line(s) from the book, checked word for word` +
      (dropped > 0 ? `; ${dropped} not on the page, dropped` : ''),
  );
  return verified;
}

/* ------------------------------------------------------- which book, who -- */

const IDENTIFY_SCHEMA = {
  type: 'object',
  properties: { book: { type: 'string' }, author: { type: 'string' } },
  required: ['book', 'author'],
};

/**
 * Which book a pasted script is about, and who wrote it.
 *
 * A script somebody wrote themselves arrives with a video title -- "The Book
 * That Put Oscar Wilde on Trial" -- and no book. Everything that looks the
 * book up needs the book: its text, its cover, its author's portrait. One
 * small request answers it; empty strings when the script is not about one.
 */
export async function identifyBook(prose: string, title: string): Promise<{ book: string; author: string }> {
  if (env.GEMINI_API_KEY === undefined) return { book: '', author: '' };
  const key = crypto.createHash('sha1').update(prose).digest('hex').slice(0, 16);
  try {
    const { value } = await cache.json<{ book: string; author: string }>(
      'identify-book',
      { v: 1, model: MODELS.llm.script, title, prose: key },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction: 'You identify the book a video script is about. You return JSON only.',
          prompt: [
            `Video title: ${title}`,
            '',
            'Script:',
            prose.slice(0, 8_000),
            '',
            'Which published book is this video about? Give its title exactly as published',
            '("The Picture of Dorian Gray") and its author\'s full name ("Oscar Wilde"). If the',
            'video is not about one particular book, return empty strings.',
          ].join('\n'),
          temperature: 0,
          seed: 1,
          maxOutputTokens: 256,
          responseSchema: IDENTIFY_SCHEMA,
        });
        return JSON.parse(response.text) as { book: string; author: string };
      },
    );
    return { book: value.book?.trim() ?? '', author: value.author?.trim() ?? '' };
  } catch (error) {
    log.debug(`quotes: could not identify the book (${(error as Error).message})`);
    return { book: '', author: '' };
  }
}

/* ------------------------------------------------- what the page says --- */

/** Words too common to say anything about which passage a beat is about. */
const COMMON = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'he', 'she', 'they', 'him',
  'her', 'them', 'his', 'their', 'this', 'that', 'these', 'those', 'as', 'by', 'not', 'no',
  'so', 'then', 'than', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'one',
  'you', 'your', 'we', 'our', 'i', 'me', 'my', 'has', 'have', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'up', 'out', 'down', 'about', 'into', 'over', 'after',
]);

/** How many of the book's words one passage holds, and how far apart they start. */
const CHUNK_WORDS = 90;
const CHUNK_STEP = 45;
/** Below this, the beat is about the argument rather than about a scene. */
const MIN_SCORE = 2.5;

type Chunk = { from: number; to: number; words: Set<string> };

/**
 * For each stretch of narration, the passage of the book it is talking about
 * -- or null where it is talking about nothing in particular.
 *
 * This is what makes a picture the scene rather than a scene. The picture
 * writer is given the narration and nothing else, so "before Gregor became a
 * bug, he was already living like one" became a drawing of a tired man in a
 * bed, invented from the sentence. The page says what the room holds, what
 * time it is, what he is lying on and what he can see from it -- and a
 * drawing made from that is recognisably the book.
 *
 * Passages are matched by their rarest shared words, weighted by how rare
 * they are across the book: "Gregor" and "chief clerk" decide the match,
 * "the" and "was" decide nothing. Deterministic, instant, and free -- the
 * same passage comes back on a re-run, so pictures do not change under you.
 */
export function passagesFor(
  book: BookSource,
  beats: readonly string[],
): (string | null)[] {
  const { tokens } = book;
  if (tokens.length < CHUNK_WORDS) return beats.map(() => null);

  const chunks: Chunk[] = [];
  for (let start = 0; start + CHUNK_WORDS <= tokens.length; start += CHUNK_STEP) {
    const words = new Set<string>();
    for (let i = start; i < start + CHUNK_WORDS; i++) {
      const word = tokens[i]!.word;
      if (word.length > 2 && !COMMON.has(word)) words.add(word);
    }
    chunks.push({ from: start, to: start + CHUNK_WORDS - 1, words });
  }

  // How many passages each word appears in: a word in half the book tells you
  // nothing, a word in three passages tells you exactly where you are.
  const seen = new Map<string, number>();
  for (const chunk of chunks) {
    for (const word of chunk.words) seen.set(word, (seen.get(word) ?? 0) + 1);
  }
  const weight = (word: string): number => {
    const count = seen.get(word);
    return count === undefined ? 0 : Math.log(chunks.length / count);
  };

  return beats.map((beat) => {
    const wanted = new Set(
      tokenise(beat)
        .map((token) => token.word)
        .filter((word) => word.length > 2 && !COMMON.has(word)),
    );
    if (wanted.size === 0) return null;

    let best: Chunk | null = null;
    let bestScore = 0;
    for (const chunk of chunks) {
      let score = 0;
      for (const word of wanted) if (chunk.words.has(word)) score += weight(word);
      if (score > bestScore) {
        bestScore = score;
        best = chunk;
      }
    }
    if (best === null || bestScore < MIN_SCORE) return null;
    return printed(book.source.text, tokens, best.from, best.to);
  });
}

const MOMENTS_SCHEMA = {
  type: 'object',
  properties: { moments: { type: 'array', items: { type: 'string' } } },
  required: ['moments'],
};

/**
 * The moment each picture should show, chosen from the book by reading it.
 *
 * Matching a beat to a passage by shared words does not work, and the failure
 * is instructive: "wakes up and discovers he has turned into a giant insect"
 * and "when Gregor Samsa woke from troubled dreams, he found himself
 * transformed in his bed into a horrible vermin" share almost no words --
 * woke is not wakes, vermin is not insect -- so the best lexical match for the
 * most famous opening in modern fiction was a paragraph from the middle of the
 * book. A reader has no such trouble, so the reading is done by a model with
 * the whole book in front of it.
 *
 * Everything it returns is checked against the text the same way a quotation
 * is: a passage that is not on the page word for word is dropped and the
 * lexical match used instead. One request for the whole video, a cent or two.
 */
export async function chooseMoments(options: {
  book: BookSource;
  beats: readonly string[];
  seed: number;
}): Promise<(string | null)[]> {
  const lexical = passagesFor(options.book, options.beats);
  if (env.GEMINI_API_KEY === undefined) return lexical;

  const numbered = options.beats
    .map((beat, i) => `${i + 1}. ${beat.replace(/\s+/g, ' ').slice(0, 320)}`)
    .join('\n');

  try {
    const { value } = await cache.json<{ moments: string[] }>(
      'panel-moments',
      {
        v: 1,
        model: MODELS.llm.script,
        book: options.book.source.id,
        beats: crypto.createHash('sha1').update(numbered).digest('hex').slice(0, 16),
        count: options.beats.length,
      },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction:
            'You match parts of a video script to the moments in the book they are about. ' +
            'You return JSON and nothing else.',
          prompt: [
            `The full text of "${options.book.source.title}" by ${options.book.source.author}:`,
            '"""',
            options.book.source.text.slice(0, MAX_BOOK_CHARS),
            '"""',
            '',
            'A video essay about it is being illustrated. Here are the stretches of narration,',
            'one per picture:',
            numbered,
            '',
            `Return "moments": exactly ${options.beats.length} strings, one per stretch, in order.`,
            '',
            'Each is one or two sentences COPIED EXACTLY from the book above — the moment a',
            'picture for that stretch should show. Choose the moment that is actually described,',
            'and prefer one with something to look at: a person doing something, in a place, at',
            'a time of day. Where the narration argues rather than narrates, choose the scene',
            'from the book that best shows what it is arguing, and copy that.',
            '',
            'Return an empty string only where the book contains nothing relevant at all — a',
            'stretch about the author, the publication or the reader rather than the story.',
            '',
            'Copy character for character. Every passage is checked against the text and one',
            'that is not found word for word is thrown away.',
          ].join('\n'),
          temperature: 0.3,
          seed: toInt32Seed(options.seed),
          maxOutputTokens: Math.min(16_384, 1_024 + options.beats.length * 120),
          responseSchema: MOMENTS_SCHEMA,
        });
        return JSON.parse(response.text) as { moments: string[] };
      },
    );

    let checked = 0;
    const chosen = options.beats.map((_, i) => {
      const passage = (value.moments ?? [])[i];
      if (typeof passage !== 'string' || passage.trim() === '') return lexical[i] ?? null;
      const words = tokenise(passage).map((token) => token.word);
      if (words.length < MIN_QUOTE_WORDS) return lexical[i] ?? null;
      const at = options.book.index.get(words.slice(0, MIN_QUOTE_WORDS).join(' '));
      if (at === undefined) return lexical[i] ?? null;
      const agrees = words.every((word, offset) => options.book.tokens[at + offset]?.word === word);
      if (!agrees) return lexical[i] ?? null;
      checked++;
      return printed(options.book.source.text, options.book.tokens, at, at + words.length - 1);
    });
    log.info(
      `moments: ${checked}/${options.beats.length} picture(s) matched to a passage in the book`,
    );
    return chosen;
  } catch (error) {
    log.debug(`moments: could not read the book for scenes (${(error as Error).message})`);
    return lexical;
  }
}
