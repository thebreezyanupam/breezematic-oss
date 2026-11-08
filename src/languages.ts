/**
 * What language a video is written and read in.
 *
 * Adding one is not a translation setting. A language reaches into four places
 * that have nothing to do with each other — who can read it aloud, which
 * transcriber can time the words, which typeface can draw them, and what the
 * script model is told — and each of those can independently refuse. So the
 * language is a record of what is actually possible rather than a label, and
 * every stage asks this file rather than testing for a string.
 *
 * The honest constraint, stated once here so nothing downstream has to
 * rediscover it: the bundled local reader is English-only. Not the Kokoro model
 * — that has voices in several languages — but the JavaScript package this
 * project uses, which ships twenty-eight voices and all of them are `af_`,
 * `am_`, `bf_` or `bm_`. Its phonemiser cannot see Devanagari at all. So Hindi
 * costs money to read where English does not, and that is a fact about the
 * dependency, not a choice made here.
 */

import type { Language as WhisperLanguage } from '@remotion/install-whisper-cpp';

/**
 * The transcriber's model names, narrowed to the multilingual half.
 *
 * Typed against the installer's own union rather than a loose string, so a
 * typo here is a build error instead of a download that 404s forty minutes
 * into a run -- and so nobody can accidentally name a `.en` model as the
 * fallback for a language that is not English, which is the exact mistake this
 * file exists to prevent.
 */
export type MultilingualModel =
  | 'tiny' | 'base' | 'small' | 'medium'
  | 'large-v1' | 'large-v2' | 'large-v3' | 'large-v3-turbo';

export const LANGUAGES = ['en', 'hi'] as const;
export type LanguageId = (typeof LANGUAGES)[number];

/** Every engine that can be asked to read. */
export type Reader = 'kokoro' | 'gemini' | 'clone' | 'elevenlabs';

export type Language = {
  id: LanguageId;
  /** In English, for the picker. */
  label: string;
  /** In itself, because that is what somebody choosing it is looking for. */
  native: string;
  /** BCP-47. Goes on the published video so the platform knows what it is. */
  code: string;
  /**
   * Engines that can read it, best first. An empty tail is not a bug: it is
   * the reason the picker has to say something when Hindi is chosen.
   */
  readers: readonly Reader[];
  whisper: {
    /** whisper.cpp's own two-letter code. */
    language: WhisperLanguage;
    /**
     * The `.en` models are English-only, so anything else needs a multilingual
     * one — which is a slower and less accurate transcriber, and since the
     * captions are word-timed that shows up on screen rather than in a log.
     */
    requiresMultilingual: boolean;
    /** The smallest multilingual model worth using for this script. */
    model: MultilingualModel;
  };
  /** Which face draws it. Latin metrics do not fit Devanagari. */
  font: 'latin' | 'devanagari';
  /** Handed to the script model. Written in the second person, as a direction. */
  instruction: string;
};

export const LANGUAGE_LIST: readonly Language[] = [
  {
    id: 'en',
    label: 'English',
    native: 'English',
    code: 'en',
    readers: ['kokoro', 'gemini', 'clone', 'elevenlabs'],
    // Never consulted: requiresMultilingual is false, so the configured
    // WHISPER_MODEL wins. Named anyway so the shape is uniform.
    whisper: { language: 'en', requiresMultilingual: false, model: 'base' },
    font: 'latin',
    instruction: 'Write in English.',
  },
  {
    id: 'hi',
    label: 'Hindi',
    native: 'हिन्दी',
    code: 'hi',
    // No kokoro. See the note at the top of this file.
    readers: ['gemini', 'clone', 'elevenlabs'],
    /**
     * `small` rather than `base`. Multilingual base is markedly worse at Hindi
     * than base.en is at English, and a transcriber that mistimes words is not
     * a quiet failure here — the captions are cut to those timings, so the
     * error lands on screen, on the beat, in front of the viewer.
     */
    whisper: { language: 'hi', requiresMultilingual: true, model: 'small' },
    font: 'devanagari',
    instruction:
      'Write in natural spoken Hindi, in Devanagari script. Do not write English ' +
      'transliterated into Devanagari, and do not translate an English sentence word ' +
      'by word — write it the way a Hindi speaker would say it out loud. Everyday ' +
      'English loanwords that Hindi speakers genuinely use in speech are fine; forced ' +
      'Sanskritised vocabulary is not.',
  },
];

const BY_ID = new Map<string, Language>(LANGUAGE_LIST.map((entry) => [entry.id, entry]));

/** Falls back to English, because an unknown language is not a reason to fail. */
export function language(id: string | null | undefined): Language {
  return BY_ID.get(id ?? 'en') ?? LANGUAGE_LIST[0]!;
}

export function isLanguage(id: string): id is LanguageId {
  return BY_ID.has(id);
}

export function canRead(id: string, reader: string): boolean {
  return (language(id).readers as readonly string[]).includes(reader);
}

/**
 * The engine to use, given what was asked for.
 *
 * Asking for a reader that cannot speak the language is not an error — it is
 * what happens every time somebody switches an English video to Hindi without
 * touching the voice setting — so this quietly returns the best one that can,
 * and the caller says so.
 */
export function readerFor(id: string, asked: string | undefined): Reader {
  const entry = language(id);
  if (asked !== undefined && canRead(id, asked)) return asked as Reader;
  return entry.readers[0] ?? 'kokoro';
}

/** True when choosing this language takes the free local reader off the table. */
export function costsMoneyToRead(id: string): boolean {
  return !canRead(id, 'kokoro');
}
