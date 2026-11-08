import { z } from 'zod';

/**
 * The explainer's motion graphics, as data.
 *
 * Shared by the three places that have to agree on them: the director that
 * chooses one per beat, the renderer that draws it, and the mix that puts a
 * sound under it. Nothing in here touches Node or the browser, so all three
 * import the same file and cannot drift on what a "bars" graphic is or on
 * which word a counter lands.
 *
 * The vocabulary is closed for the same reason the stick figure's is. Every
 * kind here has a renderer written for it; a model asked to "design a
 * graphic" in its own words describes things nothing can draw.
 *
 *   headline  the line itself, set big -- the hook, and nothing else
 *   stat      one number counting up to its value as it is said
 *   compare   two things side by side, with a value each
 *   bars      two to four values as a bar chart
 *   timeline  two to four dated points along a line
 *   steps     a numbered process, two to four steps
 *   list      two to four short points under a title
 *   term      a word and what it means, as a definition card
 *   callout   a lower third naming what the picture shows
 *   map       the camera flies in to a country, which lights up, and a pin drops
 *   none      the picture alone, so the frame can breathe
 */
export const GRAPHIC_KINDS = [
  'none', 'headline', 'stat', 'compare', 'bars', 'timeline', 'steps', 'list', 'term', 'callout', 'map',
] as const;

export type GraphicKind = (typeof GRAPHIC_KINDS)[number];

export const graphicItemSchema = z
  .object({
    label: z.string().min(1).max(48),
    /** A number shown with the item: a bar's length, a side's figure. */
    value: z.number().finite().nullable().default(null),
    /** A line under the label: a timeline point's event. */
    text: z.string().max(72).default(''),
    /** The word in the narration this item arrives on, copied from the beat. */
    cue: z.string().max(48).nullable().default(null),
    /**
     * A line icon beside a step or a list point: its Lucide name, and its
     * stroke geometry resolved when the graphic was chosen, so the renderer
     * draws it without an icon library of its own.
     */
    icon: z.string().max(48).nullable().default(null),
    paths: z.array(z.string().min(1)).max(16).default([]),
  })
  .strict();

export const graphicSchema = z
  .object({
    kind: z.enum(GRAPHIC_KINDS),
    /** A heading: the list's title, the term being defined, the chart's subject. */
    title: z.string().max(64).default(''),
    /** The stat's number. */
    value: z.number().finite().nullable().default(null),
    prefix: z.string().max(4).default(''),
    suffix: z.string().max(14).default(''),
    /** What the number is of, the definition, or the callout's second line. */
    label: z.string().max(96).default(''),
    /** The word the graphic lands on: where the counter stops, the card opens. */
    cue: z.string().max(48).nullable().default(null),
    items: z.array(graphicItemSchema).max(4).default([]),
    /** Map only: where the pin drops, when the beat names a place inside the country. */
    lat: z.number().min(-90).max(90).nullable().default(null),
    lon: z.number().min(-180).max(180).nullable().default(null),
  })
  .strict();

export type Graphic = z.infer<typeof graphicSchema>;
export type GraphicItem = z.infer<typeof graphicItemSchema>;

export const NO_GRAPHIC: Graphic = {
  kind: 'none', title: '', value: null, prefix: '', suffix: '', label: '', cue: null, items: [], lat: null, lon: null,
};

export type TimedWord = { readonly text: string; readonly startMs: number; readonly endMs: number };

/** Case, accents and punctuation off, so "Everest," finds "everest". */
export function normalizeWord(word: string): string {
  return word
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * When a cue is said, within a beat's words.
 *
 * A cue is a word or a short phrase copied from the beat. It is found by its
 * first word that is long enough to mean something, matched as a prefix both
 * ways so "8,849" finds "8849" and "pyramid" finds "pyramids". Null when the
 * narration never says it, which every caller treats as "use the fallback" --
 * a graphic landing a second early is worse than one landing on a schedule.
 */
export function cueTime(cue: string | null, words: readonly TimedWord[], fromMs = 0): number | null {
  if (cue === null) return null;
  const parts = cue.split(/\s+/).map(normalizeWord).filter((part) => part.length > 0);
  const key = parts.find((part) => part.length >= 3 || /\d/.test(part)) ?? parts[0];
  if (key === undefined) return null;
  for (const word of words) {
    if (word.startMs < fromMs) continue;
    const said = normalizeWord(word.text);
    if (said.length === 0) continue;
    if (said === key || (key.length >= 3 && (said.startsWith(key) || key.startsWith(said)) && said.length >= 3)) {
      return word.startMs;
    }
  }
  return null;
}

/**
 * When each item of a list-like graphic arrives, in ms from the video start.
 *
 * On its cue word where the narration says it, and otherwise spread through
 * the first two thirds of the beat, so the last item is up while there is
 * still time to read it. Never earlier than the item before it: a cue word
 * that happens to be said early must not make the third step land first.
 */
export function itemTimes(
  items: readonly GraphicItem[],
  words: readonly TimedWord[],
  startMs: number,
  endMs: number,
): number[] {
  const lead = 180;
  const span = Math.max(1, (endMs - startMs) * 0.62);
  const out: number[] = [];
  let floor = startMs + lead;
  items.forEach((item, index) => {
    const scheduled = startMs + lead + (span * index) / Math.max(1, items.length);
    const said = cueTime(item.cue, words, startMs);
    const at = Math.max(floor, said ?? scheduled);
    out.push(Math.min(at, endMs - 300));
    floor = at + 160;
  });
  return out;
}

/**
 * The moment the subscribe ask is said, if it is.
 *
 * Read from the narration rather than chosen by anyone: wherever the script
 * says "subscribe", the plug plays, on that word, the same way in every video.
 * A pasted script gets it by saying the word; a generated one is asked to.
 */
const SUBSCRIBE = /^(subscrib|सब्सक्राइब)/i;

export function subscribeMoment(words: readonly TimedWord[]): number | null {
  for (const word of words) {
    if (SUBSCRIBE.test(normalizeWord(word.text)) || SUBSCRIBE.test(word.text.trim())) return word.startMs;
  }
  return null;
}

/** How long the plug stays up, and when inside it the button is pressed. */
export const SUBSCRIBE_TIMING = {
  /** It opens a little before the word, so the button is there when it is said. */
  leadMs: 350,
  clickMs: 900,
  bellMs: 1_250,
  holdMs: 2_900,
} as const;

/** How long an explainer script runs: about 55-70 seconds at the reader's measured pace. */
export const EXPLAINER_WORDS = { min: 150, max: 195 } as const;

/** The quiet after the last word: the frame settles instead of cutting off. */
export const OUTRO_MS = 1_100;

/**
 * Explainer beats are held longer than a short's: a chart needs time to be
 * read, and a beat is a whole sentence. Six seconds is a sixteen-word line at
 * the reader's pace; anything longer is split at its most natural pause.
 */
export const EXPLAINER_BEAT_MS = { min: 2_000, max: 6_000 } as const;

/** Every number in a piece of text, as digits: "8,849 m" gives 8849. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((match) => Number(match[0].replace(/,/g, '')))
    .filter((value) => Number.isFinite(value));
}

/**
 * How a value is printed: thousands grouped, decimals kept only as far as the
 * value has them, so a counter running to 4.2 does not pass through 4.1999.
 */
export function formatValue(value: number, decimals: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function decimalsOf(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(2, text.length - dot - 1);
}
