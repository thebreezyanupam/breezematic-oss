import { ESSAY_WORDS_PER_MINUTE } from './essay.js';
import { plainSpeech } from './plaintext.js';

/**
 * Is this script ready to be made into a video?
 *
 * Everything here is read off the text in a few milliseconds and costs
 * nothing. That is the point: the expensive half of a run -- reading it
 * aloud, drawing twenty pictures -- happens after the script is accepted, so
 * anything wrong with the script is cheapest to find now. A line that was
 * meant as a heading and gets read aloud as a sentence is a nine-minute
 * narration and a full render before anybody hears it.
 *
 * Three levels, and the distinction matters:
 *
 *   stop   this will produce a broken video
 *   check  this will produce a video, and probably not the one intended
 *   note   worth knowing, nothing wrong
 */

export type Finding = {
  level: 'stop' | 'check' | 'note';
  message: string;
  /** The offending text, where quoting it is clearer than describing it. */
  quote?: string;
};

export type ScriptReport = {
  words: number;
  /** How long it will run once read aloud, at the house pace. */
  estimatedMs: number;
  paragraphs: number;
  chapters: string[];
  findings: Finding[];
  /** False only when something will actually break. */
  ready: boolean;
};

const MIN_WORDS = 40;
/** Past this a sentence is longer than one breath and reads as a run-on. */
const LONG_SENTENCE_WORDS = 45;
/** One picture covers one stretch; past this the picture cannot be about it. */
const LONG_PARAGRAPH_WORDS = 220;

const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** A line that looks like a heading somebody forgot to mark with `#`. */
function looksLikeHeading(line: string): boolean {
  // Judged as it will be read: "It was **Megumi.**" ends in a full stop once the
  // asterisks are gone, and is a sentence, not a heading.
  const text = plainSpeech(line).trim();
  if (text === '' || text.startsWith('#')) return false;
  const words = countWords(text);
  if (words > 9) return false;
  if (/^(chapter|part|section)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(text)) return true;
  if (/^[^a-z]*$/.test(text) && /[A-Z]{3,}/.test(text)) return true;
  /**
   * A heading carries no punctuation at the end of it.
   *
   * The colon is the one that mattered. "He became obsessed with one idea:"
   * is a sentence leading into the next line, and it was reported as a
   * heading somebody had forgotten to mark -- advice that would have had a
   * writer delete a line meant to be read aloud.
   */
  if (/[.,:;!?—-]$/.test(text)) return false;
  return /^[A-Z]/.test(text) && words <= 6;
}

export function checkScript(options: { script: string; minutes?: number }): ScriptReport {
  const script = options.script.replace(/\r\n/g, '\n');
  const findings: Finding[] = [];
  const add = (level: Finding['level'], message: string, quote?: string): void => {
    findings.push({ level, message, ...(quote === undefined ? {} : { quote }) });
  };

  const lines = script.split('\n');
  const paragraphs = script.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== '');
  const chapters = lines
    .map((line) => /^\s{0,3}#{1,3}\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
    .filter((title): title is string => title !== undefined && title !== '');

  const spoken = lines.filter((line) => !/^\s{0,3}#{1,3}\s+/.test(line)).join('\n');
  const words = countWords(spoken);
  const estimatedMs = Math.round((words / ESSAY_WORDS_PER_MINUTE) * 60_000);

  /* ------------------------------------------------------------- length */

  if (words === 0) {
    add('stop', 'There is nothing to read: the script is empty.');
  } else if (words < MIN_WORDS) {
    add('stop', `Only ${words} words — too short to make a video from.`);
  }

  if (options.minutes !== undefined && words >= MIN_WORDS) {
    const wanted = options.minutes * 60_000;
    const off = (estimatedMs - wanted) / wanted;
    /**
     * A wide tolerance, because the estimate is a guess and says so.
     *
     * Words per minute is a property of the reader, not of the script: the
     * same thousand words came out at 199 a minute in one voice and 120 in
     * another, which is five minutes against nine. Worth flagging when the
     * gap is large, not worth arguing about when it is not.
     */
    if (Math.abs(off) > 0.35) {
      const minutes = (estimatedMs / 60_000).toFixed(1);
      add(
        'check',
        `This reads as roughly ${minutes} minutes against the ${options.minutes} the length is set ` +
          'to. The script decides the real length, and the reader you pick moves it either way; ' +
          'the setting only matters when the writing is left to the tool.',
      );
    }
  }

  /* ------------------------------------------------------------- shape */

  if (paragraphs.length === 1 && words > 150) {
    add(
      'check',
      'It is all one paragraph. Blank lines separate the stretches a picture is chosen for, ' +
        'so one block means one picture for the whole video.',
    );
  }
  for (const paragraph of paragraphs) {
    const size = countWords(paragraph);
    if (size > LONG_PARAGRAPH_WORDS) {
      add(
        'check',
        `One paragraph runs to ${size} words. Each gets a single picture, so it will sit on ` +
          'screen for a long stretch.',
        `${paragraph.slice(0, 60)}…`,
      );
      break;
    }
  }

  for (const sentence of spoken.split(/(?<=[.!?])\s+/)) {
    if (countWords(sentence) > LONG_SENTENCE_WORDS) {
      add('check', `A sentence of ${countWords(sentence)} words will be read without a breath.`, `${sentence.trim().slice(0, 70)}…`);
      break;
    }
  }

  /* ------------------------------------------- things that get read aloud */

  for (const line of lines) {
    if (looksLikeHeading(line)) {
      add(
        'check',
        'This line looks like a heading but is not marked as one, so it will be read aloud as a ' +
          'sentence. Put # in front of it to make it a chapter instead.',
        line.trim(),
      );
      break;
    }
  }

  const noise: [RegExp, string][] = [
    [/\[[^\]]{1,40}\]/, 'Square brackets are read aloud word for word.'],
    [/\((?:beat|pause|laughs?|sigh|music|sfx)[^)]*\)/i, 'Stage directions in brackets are read aloud.'],
    [/https?:\/\/\S+|www\.\S+/i, 'A web address will be read out character by character.'],
    [/\S+@\S+\.\S+/, 'An email address will be read out character by character.'],
    // A list number is one or two digits; "1984." is a year and a full stop.
    // Asterisks, bold and bullets are stripped before reading (plainSpeech);
    // a numbered list is not, because the number is a word someone meant.
    [/^\s*\d{1,2}\.\s+\S/m, 'A numbered list: the numbers will be read aloud.'],
    [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'Emoji are skipped or read as their names.'],
    [/^\s*[A-Z][a-z]+\s*:\s*\S/m, 'A speaker label like "Narrator:" is read aloud.'],
    [/\b[A-Z]{4,}\b/, 'A word in capitals may be spelled out letter by letter.'],
  ];
  for (const [pattern, message] of noise) {
    const hit = pattern.exec(spoken);
    if (hit !== null) add('check', message, hit[0].trim().slice(0, 50));
  }

  if (/\*[^*\n]+\*|\*\*|(^|\s)_[^_\n]+_/m.test(spoken)) {
    add('note', 'Markdown (*, **, _) is taken out before reading and captioning, so it will not be read aloud.');
  }

  /* -------------------------------------------------------------- notes */

  if (chapters.length > 0) {
    add('note', `${chapters.length} chapter${chapters.length === 1 ? '' : 's'}: ${chapters.join(' · ')}`);
    /**
     * Chapters written into a script are taken exactly as given, however many
     * -- so it is worth saying when there are a lot. Each card stops the
     * reading for three and a half seconds, which is the part nobody expects:
     * eight of them add half a minute of silence to the runtime.
     */
    const everyMs = estimatedMs / chapters.length;
    if (everyMs < 75_000) {
      add(
        'check',
        `A chapter card every ${Math.round(everyMs / 1000)} seconds. Each one pauses the reading ` +
          `for 3.6s, so these add about ${Math.round(chapters.length * 3.6)}s of silence to the ` +
          'video. Three or four cards reads better than eight.',
      );
    }
  } else if (estimatedMs > 5 * 60_000) {
    add(
      'note',
      'No chapters. Put # in front of a line to mark one — a long video is easier to watch with them.',
    );
  }

  return {
    words,
    estimatedMs,
    paragraphs: paragraphs.length,
    chapters,
    findings,
    ready: !findings.some((finding) => finding.level === 'stop'),
  };
}
