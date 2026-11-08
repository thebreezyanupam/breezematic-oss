import { MODELS, PLAN, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { priceOf } from '../cost.js';
import { generate } from '../providers/gemini.js';
import { z } from 'zod';
import { wordCount } from '../text.js';

/**
 * A pasted script, made video-ready without being rewritten.
 *
 * The pipeline needs narration shaped as beats: 4 to 24 lines, each one clause
 * that fits on a card. What people paste is prose. This stage does the shaping
 * — and only the shaping. Nothing may be reworded, so every candidate is
 * checked against the original before it is accepted: the words that come out
 * have to be a subsequence of the words that went in. A model that improves the
 * writing fails that check and is thrown away in favour of the local splitter.
 *
 * Too long is the one case where words do disappear. Narration runs at roughly
 * PLAN.spokenWordsPerSecond, so anything past PLAN.pastedMaxWords cannot fit
 * under a minute; whole beats go from the end until it does, which is the
 * smallest edit that gets there.
 */

export const ADAPT_PROMPT_VERSION = 1;

export type AdaptedScript = {
  /** Beat per line, ready for draftFromText. */
  text: string;
  beats: number;
  words: number;
  estimatedMs: number;
  /** Words were dropped to fit the length limit. */
  truncated: boolean;
  /** The text differs from what was pasted (line breaks alone count). */
  changed: boolean;
  /** How the shape was decided. */
  by: 'model' | 'local' | 'unchanged';
  notes: string[];
  model: string | null;
  usd: number;
};

const EMPHASIS_MARK = /\*([^*]+)\*/g;

const SYSTEM_INSTRUCTION = [
  'You prepare a writer\'s own script for a vertical kinetic-typography video.',
  'You are not a rewriter. You may split, drop and repunctuate; you may never reword.',
  'You return JSON and nothing else. No preamble, no markdown, no code fences.',
].join(' ');

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    beats: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          emphasis_word: { type: 'string' },
        },
        required: ['text', 'emphasis_word'],
        propertyOrdering: ['text', 'emphasis_word'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['beats', 'notes'],
  propertyOrdering: ['beats', 'notes'],
};

const responseSchema = z
  .object({
    beats: z
      .array(z.object({ text: z.string(), emphasis_word: z.string() }).passthrough())
      .min(1),
    notes: z.array(z.string()).default([]),
  })
  .passthrough();

function buildPrompt(text: string, words: number): string {
  const overLong = words > PLAN.pastedMaxWords;

  return `Here is a script, exactly as its writer typed it:

"""
${text}
"""

It is ${words} words, about ${Math.round(words / PLAN.spokenWordsPerSecond)} seconds read aloud.

Split it into beats for the screen.

Rules:
1. Never change a word. No synonyms, no reordering, no added connectives, no fixed grammar, no summarising. Every word you return must appear in the script above, in the same order.
2. You may only: break the text into beats, drop whole passages when rule 5 requires it, and adjust punctuation and capitalisation at a new beat's edge.
3. Each beat is one clause or short sentence of at most ${PLAN.pastedWordsPerBeatMax} words that reads as a single unit on a card. Break at sentence ends first, then at commas, semicolons, colons, dashes, and last at "and", "but", "because", "so", "which", "that".
4. Return between ${PLAN.pastedBeatsMin} and ${PLAN.pastedBeatsMax} beats. The first beat is the hook: it must be the script's own opening, not something moved up from later.
5. ${
    overLong
      ? `The script is too long for a video under a minute. Bring the total to between ${Math.round(PLAN.pastedMaxWords * 0.8)} and ${PLAN.pastedMaxWords} words by dropping whole sentences — take them from the least load-bearing middle, keep the opening and the ending intact, and cut no more than you have to. Land near the top of that range, not the bottom.`
      : `The script already fits. Drop nothing at all.`
  }
6. "emphasis_word" is one word copied character for character from that beat's text — a number, a name, or the most surprising noun. Use an empty string if the beat has no obvious one.
7. "notes" is at most three short lines saying what you did, in plain English, e.g. "split 4 long sentences", "dropped 2 sentences to fit 55 seconds". No note if nothing was done.

Return only the JSON object.`;
}

/** Comparison form: what the writer typed, with punctuation and case removed. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * The verbatim guarantee. Dropping is allowed, so the output has to be a
 * subsequence of the input rather than a prefix of it — but nothing new may
 * appear, and the order has to hold.
 */
export function isSubsequence(candidate: readonly string[], original: readonly string[]): boolean {
  let cursor = 0;
  for (const word of candidate) {
    const at = original.indexOf(word, cursor);
    if (at === -1) return false;
    cursor = at + 1;
  }
  return true;
}

const SENTENCE_END = /(?<=[.!?])\s+/;
const CLAUSE_BREAK = /(?<=[,;:—–])\s+/;
const JOINERS = /\s+(?=(?:and|but|because|so|which|that|while|though|until|when)\b)/i;

function splitLong(piece: string): string[] {
  if (wordCount(piece) <= PLAN.pastedWordsPerBeatMax) return [piece];

  for (const pattern of [CLAUSE_BREAK, JOINERS]) {
    const parts = piece.split(pattern).map((part) => part.trim()).filter((part) => part !== '');
    if (parts.length > 1) return parts.flatMap(splitLong);
  }

  // Nothing to break on: cut at the word that keeps both halves legal.
  const words = piece.split(/\s+/);
  const at = Math.ceil(words.length / 2);
  return [words.slice(0, at).join(' '), words.slice(at).join(' ')].flatMap(splitLong);
}

/** Merges beats too short to earn a card of their own into the one before. */
function coalesce(pieces: readonly string[]): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      wordCount(piece) < 3 &&
      wordCount(previous) + wordCount(piece) <= PLAN.pastedWordsPerBeatMax
    ) {
      out[out.length - 1] = `${previous} ${piece}`;
      continue;
    }
    out.push(piece);
  }
  return out;
}

/** Drops whole beats off the end until the read fits, never mid-sentence. */
function trimToBudget(pieces: readonly string[]): { beats: string[]; truncated: boolean } {
  const beats = [...pieces];
  let truncated = false;
  while (
    beats.length > PLAN.pastedBeatsMin &&
    beats.reduce((sum, beat) => sum + wordCount(beat), 0) > PLAN.pastedMaxWords
  ) {
    beats.pop();
    truncated = true;
  }
  return { beats, truncated };
}

/**
 * Line breaks mean two different things and the text does not say which. A
 * paragraph hard-wrapped at 80 columns breaks mid-sentence; a script typed one
 * beat per line breaks at the end of one. Only the first kind should be joined
 * back up, so a break is kept when the line before it ended a sentence — or
 * when nothing in the block ends a sentence at all, which is what a list of
 * beats with no full stops looks like.
 */
export function unwrap(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .flatMap((paragraph) => {
      const lines = paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length <= 1) return lines;

      const anyTerminal = lines.some((line) => /[.!?…]["'’”)]?$/.test(line));
      if (!anyTerminal) return lines;

      const joined: string[] = [];
      for (const line of lines) {
        const previous = joined[joined.length - 1];
        if (previous === undefined || /[.!?…]["'’”)]?$/.test(previous)) joined.push(line);
        else joined[joined.length - 1] = `${previous} ${line}`;
      }
      return joined;
    })
    .filter((block) => block !== '');
}

/**
 * The splitter that runs with no model at all, and the arbiter when a model
 * comes back having rewritten something. Deterministic and offline.
 */
export function adaptLocally(text: string): { beats: string[]; truncated: boolean } {
  const sentences = unwrap(text).flatMap((block) =>
    block.split(SENTENCE_END).map((piece) => piece.trim()).filter((piece) => piece !== ''),
  );

  let pieces = coalesce(sentences.flatMap(splitLong));

  // Under the floor, the longest beats give up a break until there are enough.
  while (pieces.length > 0 && pieces.length < PLAN.pastedBeatsMin) {
    const longest = pieces.reduce(
      (best, piece, index) => (wordCount(piece) > wordCount(pieces[best] ?? '') ? index : best),
      0,
    );
    const target = pieces[longest] ?? '';
    const words = target.split(/\s+/);
    if (words.length < 2) break;
    const at = Math.ceil(words.length / 2);
    pieces = [
      ...pieces.slice(0, longest),
      words.slice(0, at).join(' '),
      words.slice(at).join(' '),
      ...pieces.slice(longest + 1),
    ];
  }

  const { beats, truncated } = trimToBudget(pieces);
  return { beats: beats.slice(0, PLAN.pastedBeatsMax), truncated: truncated || beats.length > PLAN.pastedBeatsMax };
}

/** `*word*` is how draftFromText carries an emphasis hint through. */
function mark(beat: string, emphasis: string): string {
  const wanted = emphasis.trim().replace(/[^A-Za-z0-9'$%.-]/g, '');
  if (wanted === '') return beat;
  const pattern = new RegExp(`\\b${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const found = pattern.exec(beat);
  if (found === null) return beat;
  return `${beat.slice(0, found.index)}*${found[0]}*${beat.slice(found.index + found[0].length)}`;
}

function estimateMs(words: number): number {
  return Math.round((words / PLAN.spokenWordsPerSecond) * 1000);
}

function assemble(
  beats: readonly string[],
  meta: Omit<AdaptedScript, 'text' | 'beats' | 'words' | 'estimatedMs'>,
): AdaptedScript {
  const text = beats.join('\n');
  const words = beats.reduce((sum, beat) => sum + wordCount(beat), 0);
  return { ...meta, text, beats: beats.length, words, estimatedMs: estimateMs(words) };
}

export async function adaptScript(options: {
  text: string;
  force: boolean;
}): Promise<AdaptedScript> {
  const original = options.text.replace(/\r\n/g, '\n').trim();
  // The marks are the writer's own hints; they are not words, and comparing
  // with them in place would fail the subsequence check on the first beat.
  const bare = original.replace(EMPHASIS_MARK, '$1');
  const source = tokens(bare);
  const words = source.length;

  if (words === 0) throw new Error('there is no script to prepare');

  const local = adaptLocally(bare);
  const localResult = assemble(local.beats, {
    truncated: local.truncated,
    changed: local.beats.join('\n') !== original,
    by: 'local',
    notes: local.truncated
      ? [`trimmed to ${PLAN.pastedMaxWords} words so the read stays under a minute`]
      : [],
    model: null,
    usd: 0,
  });

  if (env.GEMINI_API_KEY === undefined) {
    log.info(`script: shaped into ${localResult.beats} beats without a model`);
    return localResult;
  }

  type Cached = { raw: string; model: string; inputTokens: number; outputTokens: number };

  let cached: { value: Cached; hit: boolean };
  try {
    cache.setForce(options.force);
    cached = await cache.json<Cached>(
      'script-adapt',
      { promptVersion: ADAPT_PROMPT_VERSION, model: MODELS.llm.script, text: bare },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction: SYSTEM_INSTRUCTION,
          prompt: buildPrompt(bare, words),
          // Shaping, not writing: the same script should shape the same way.
          temperature: 0.2,
          seed: 7,
          maxOutputTokens: 4096,
          responseSchema: RESPONSE_SCHEMA,
        });
        return {
          raw: response.text,
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
        };
      },
    );
  } catch (error) {
    log.warn(`script: preparation call failed (${(error as Error).message}); split it here instead`);
    return localResult;
  }

  const usd = cached.hit ? 0 : priceOf(cached.value.model, cached.value.inputTokens, cached.value.outputTokens);
  const spent = Number.isFinite(usd) ? usd : 0;

  let beats: string[];
  let notes: string[];
  try {
    const parsed = responseSchema.parse(JSON.parse(stripFences(cached.value.raw)));
    beats = parsed.beats
      .map((beat) => beat.text.replace(/\s+/g, ' ').trim())
      .filter((beat) => beat !== '');
    notes = parsed.notes.map((note) => note.trim()).filter((note) => note !== '').slice(0, 3);

    const marked = parsed.beats.map((beat, index) =>
      mark(beats[index] ?? '', typeof beat.emphasis_word === 'string' ? beat.emphasis_word : ''),
    );

    const failures = check(beats, source, words);
    if (failures.length > 0) {
      log.warn(`script: preparation rejected (${failures.join('; ')}); split it here instead`);
      return { ...localResult, usd: spent };
    }

    const kept = beats.reduce((sum, beat) => sum + wordCount(beat), 0);
    return assemble(marked.filter((beat) => beat.trim() !== ''), {
      truncated: kept < words,
      changed: beats.join('\n') !== original,
      by: 'model',
      notes:
        kept < words && notes.length === 0
          ? [`dropped ${words - kept} words to keep the read under a minute`]
          : notes,
      model: cached.value.model,
      usd: spent,
    });
  } catch (error) {
    log.warn(`script: preparation came back unusable (${(error as Error).message})`);
    return { ...localResult, usd: spent };
  }
}

/** Everything that disqualifies a model's shaping, named so the log can say why. */
function check(beats: readonly string[], source: readonly string[], words: number): string[] {
  const failures: string[] = [];
  const produced = beats.flatMap((beat) => tokens(beat));

  if (beats.length < PLAN.pastedBeatsMin) failures.push(`only ${beats.length} beats`);
  if (beats.length > PLAN.pastedBeatsMax) failures.push(`${beats.length} beats, over the limit`);
  if (!isSubsequence(produced, source)) failures.push('the wording was changed');
  if (produced.length > PLAN.pastedMaxWords) {
    failures.push(`${produced.length} words, still over ${PLAN.pastedMaxWords}`);
  }
  // Dropping more than a third of a script that was never too long to begin
  // with is not shaping, whatever the words themselves say.
  if (words <= PLAN.pastedMaxWords && produced.length < words * 0.85) {
    failures.push(`${words - produced.length} words dropped from a script that already fitted`);
  }
  return failures;
}

function stripFences(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`model response contains no JSON object: ${raw.slice(0, 200)}`);
  }
  return text.slice(start, end + 1);
}
