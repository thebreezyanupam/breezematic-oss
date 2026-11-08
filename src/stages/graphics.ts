import { MODELS, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import { iconPaths } from '../icons.js';
import {
  GRAPHIC_KINDS,
  NO_GRAPHIC,
  graphicSchema,
  normalizeWord,
  numbersIn,
  subscribeMoment,
  type Graphic,
  type GraphicKind,
} from '../explainer.js';

/**
 * One motion graphic per beat of an explainer, chosen against the beats as
 * they were actually cut.
 *
 * After planning rather than with the script, because the planner moves the
 * cuts onto the tempo grid and a beat is rarely the sentence the writer wrote.
 * A chart chosen for a sentence that was then split across two beats is timed
 * to nothing; one chosen for the beat is timed to the words in it.
 *
 * Accuracy is checked here and not trusted. Every number a graphic would put
 * on screen has to be a number the narration says, because a counter running
 * to a figure the voice never mentions is a fact the video invented -- and
 * the one thing an explainer cannot survive is being confidently wrong in a
 * big font. A graphic that fails the check is not repaired, it is dropped:
 * the picture alone is always a true frame.
 */

const DIRECTION_VERSION = 3;

/**
 * The icons a step or a list point may carry: line drawings that read at a
 * glance on a phone and between them cover what explainers are about. Closed,
 * like the kinds, so every name the model can pick is one that draws.
 */
export const EXPLAINER_ICONS = [
  'pickaxe', 'hammer', 'wrench', 'ruler', 'scale', 'weight', 'mountain', 'waves', 'droplet', 'droplets',
  'sun', 'moon', 'cloud', 'cloud-rain', 'snowflake', 'flame', 'zap', 'wind', 'thermometer', 'globe',
  'map', 'map-pin', 'compass', 'landmark', 'building', 'factory', 'house', 'tent', 'ship', 'sailboat',
  'car', 'truck', 'train-front', 'plane', 'rocket', 'satellite', 'atom', 'dna', 'microscope',
  'flask-conical', 'brain', 'heart-pulse', 'bone', 'leaf', 'tree-pine', 'sprout', 'fish', 'bug', 'bird',
  'users', 'user', 'crown', 'swords', 'shield', 'scroll', 'book-open', 'graduation-cap', 'clock',
  'hourglass', 'calendar', 'timer', 'coins', 'banknote', 'piggy-bank', 'trending-up', 'trending-down',
  'chart-column', 'chart-pie', 'percent', 'target', 'lightbulb', 'search', 'eye', 'ear',
  'message-circle', 'phone', 'wifi', 'cpu', 'battery-charging', 'plug', 'gauge', 'layers', 'box',
  'package', 'anchor', 'gem', 'skull', 'handshake', 'recycle', 'lock', 'key', 'flag', 'award',
  'trophy', 'circle-check', 'circle-x', 'triangle-alert', 'pyramid',
] as const;

const KIND_USE: Record<GraphicKind, string> = {
  none: 'no graphic: the picture and captions carry it. Use for transitions, emotional lines and anything without data.',
  headline: 'the line set big over the picture. Only for beat 1, the hook.',
  stat: 'one key number counting up: "value" (digits only), optional "prefix" ("$", "~") and "suffix" ("%", "km", "years", "billion"), "label" saying what it measures (max 5 words), "cue" the word where the number is said.',
  compare: 'two things side by side: exactly 2 "items", each with "label" (max 3 words) and "value" if the beat gives one for each. "title" is what is being compared.',
  bars: 'a bar chart: 2-4 "items" each with "label" (max 3 words) and a numeric "value", all in the same unit, which goes in "suffix". "title" names the measure.',
  timeline: 'dated points along a line: 2-4 "items", "label" the year or date as said, "text" what happened (max 6 words), "cue" the word where it is said.',
  steps: 'a numbered process: 2-4 "items", "label" each step in at most 5 words, in order, "cue" where each is said, "icon" one icon name that pictures the step.',
  list: 'a few points under a heading: "title" (max 4 words) and 2-4 "items", "label" each point in at most 5 words, "cue" where each is said, "icon" one icon name that pictures the point.',
  map: 'a map that flies in to a country: "title" the common English name of the country exactly (e.g. "Egypt", "Japan"), "label" one short line about the place (max 7 words), and "lat"/"lon" only if the beat names a specific city, site or feature inside it whose coordinates you are certain of. For a beat about where something is.',
  term: 'a definition card: "title" the term, "label" what it means in at most 12 plain words. For the beat that names or defines a technical word.',
  callout: 'a lower-third label naming what is on screen: "title" the name (max 4 words), "label" one short fact (max 7 words). For a beat that names a place, person, object or event.',
};

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    beats: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          beat: { type: 'integer' },
          kind: { type: 'string', enum: [...GRAPHIC_KINDS] },
          title: { type: 'string' },
          value: { type: 'number', nullable: true },
          prefix: { type: 'string' },
          suffix: { type: 'string' },
          label: { type: 'string' },
          cue: { type: 'string', nullable: true },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'number', nullable: true },
                text: { type: 'string' },
                cue: { type: 'string', nullable: true },
                icon: { type: 'string', nullable: true },
              },
              required: ['label'],
            },
          },
          lat: { type: 'number', nullable: true },
          lon: { type: 'number', nullable: true },
        },
        required: ['beat', 'kind'],
        propertyOrdering: ['beat', 'kind', 'title', 'value', 'prefix', 'suffix', 'label', 'cue', 'items', 'lat', 'lon'],
      },
    },
  },
  required: ['beats'],
};

function buildRequest(topic: string, script: string, beats: readonly string[], plug: number | null): string {
  const kinds = GRAPHIC_KINDS.map((kind) => `- ${kind}: ${KIND_USE[kind]}`).join('\n');
  const listed = beats.map((text, index) => `${index + 1}. ${text}`).join('\n');
  return `You are the motion designer on a vertical explainer video about: ${topic}

The full narration, for context:
${script}

The video is cut into these beats, in order. Each one is on screen for two to five seconds while it is said:
${listed}

Choose one graphic for every beat from this closed list:
${kinds}

Rules:
1. Beat 1 is "headline".${plug === null ? '' : ` Beat ${plug + 1} is the subscribe line: it is "none".`}
2. A graphic illustrates its own beat. A "stat" is only for a beat whose own text contains that number; never put a number on the beat before or after the one that says it. Every number you use must appear in the narration exactly as said: never compute, convert, round, estimate or add one. If a chart would need a number the narration does not say, choose another kind. A year is a date, never a "stat".
3. Labels are short, plain and spelled exactly as in the narration where they come from it. No emoji. Title case is not needed.
4. A "cue" is one word copied verbatim from that beat's own text, the moment the item or number is spoken.
5. Give most beats a graphic: use "none" for at most a third of them, so the pictures still have room. Never give two consecutive beats the same kind, except "none".
6. Prefer the most informative graphic the beat honestly supports: a beat with two figures for two things is "compare" or "bars", a beat with one key figure is "stat", a beat that introduces a named thing is "callout", a beat that defines a word is "term".
7. Use between four and seven distinct kinds across the video.

Return {"beats": [...]} with exactly ${beats.length} entries, "beat" numbered from 1.`;
}

const trimTo = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Whether a number on screen is one the narration actually says. */
function said(value: number, spokenNumbers: ReadonlySet<number>): boolean {
  return spokenNumbers.has(value);
}

/**
 * The model's answer for one beat, made renderable or refused.
 *
 * Shape first -- the schema's enums and lengths are requests, not guarantees
 * -- then the facts: every value has to be a number the narration says, and
 * a cue has to be a word the beat contains, or it is cleared and the item
 * falls back to its scheduled moment.
 */
export function cleanGraphic(
  raw: Record<string, unknown>,
  beatText: string,
  /** Numbers said in this beat or the ones either side, for a chart built across a sentence break. */
  spokenNumbers: ReadonlySet<number>,
): Graphic {
  const kind = (GRAPHIC_KINDS as readonly string[]).includes(String(raw['kind']))
    ? (raw['kind'] as GraphicKind)
    : 'none';
  if (kind === 'none') return NO_GRAPHIC;

  const beatWords = new Set(beatText.split(/\s+/).map(normalizeWord).filter((word) => word.length > 0));
  const cueOf = (value: unknown): string | null => {
    const text = trimTo(value, 48);
    if (text === '') return null;
    const first = normalizeWord(text.split(/\s+/)[0] ?? '');
    return [...beatWords].some((word) => word === first || (first.length >= 3 && word.startsWith(first)))
      ? text
      : null;
  };
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const items = (Array.isArray(raw['items']) ? raw['items'] : [])
    .slice(0, 4)
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      // An icon the set does not have is simply left off: the step still reads.
      const wanted = typeof item['icon'] === 'string' ? item['icon'].trim().toLowerCase() : '';
      const icon = (EXPLAINER_ICONS as readonly string[]).includes(wanted) ? wanted : null;
      const paths = icon === null ? null : iconPaths(icon);
      return {
        label: trimTo(item['label'], 48),
        value: number(item['value']),
        text: trimTo(item['text'], 72),
        cue: cueOf(item['cue']),
        icon: paths === null ? null : icon,
        paths: paths ?? [],
      };
    })
    .filter((item) => item.label.length > 0);

  const graphic: Graphic = {
    kind,
    title: trimTo(raw['title'], 64),
    value: number(raw['value']),
    prefix: trimTo(raw['prefix'], 4),
    suffix: trimTo(raw['suffix'], 14),
    label: trimTo(raw['label'], 96),
    cue: cueOf(raw['cue']),
    items,
    // Both or neither: half a coordinate is a pin dropped in the sea.
    ...((): { lat: number | null; lon: number | null } => {
      const lat = number(raw['lat']);
      const lon = number(raw['lon']);
      return kind === 'map' && lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? { lat, lon }
        : { lat: null, lon: null };
    })(),
  };

  const values = [graphic.value, ...items.map((item) => item.value)].filter(
    (value): value is number => value !== null,
  );
  if (values.some((value) => !said(value, spokenNumbers))) return NO_GRAPHIC;
  // A counter is about the line it is on: its number has to be said in that
  // beat, or it counts up while the voice is talking about something else.
  if (kind === 'stat' && graphic.value !== null && !numbersIn(beatText).includes(graphic.value)) return NO_GRAPHIC;

  const ok = ((): boolean => {
    switch (kind) {
      case 'headline':
        return true;
      case 'stat':
        return graphic.value !== null && graphic.value >= 0;
      case 'compare':
        return items.length === 2;
      case 'bars':
        return items.length >= 2 && items.every((item) => item.value !== null && item.value >= 0)
          && items.some((item) => (item.value ?? 0) > 0);
      case 'timeline':
      case 'steps':
      case 'list':
        return items.length >= 2;
      case 'term':
        return graphic.title.length > 0 && graphic.label.length > 0;
      case 'callout':
      case 'map':
        return graphic.title.length > 0;
    }
  })();
  return ok ? graphicSchema.parse(graphic) : NO_GRAPHIC;
}

/**
 * Without a model: the hook as a headline and a counter on any beat with a
 * single number in it. Plain, and true, which is the order of priority.
 */
function plainGraphics(beatTexts: readonly string[], plug: number | null): Graphic[] {
  return beatTexts.map((text, index): Graphic => {
    if (index === 0) return { ...NO_GRAPHIC, kind: 'headline' };
    if (index === plug) return NO_GRAPHIC;
    const numbers = numbersIn(text).filter((value) => value < 1_000_000_000_000);
    if (numbers.length !== 1) return NO_GRAPHIC;
    const value = numbers[0]!;
    // A year is a date, not a quantity: counting up to 1969 is a joke.
    if (Number.isInteger(value) && value >= 1000 && value <= 2100 && !/,/.test(text)) return NO_GRAPHIC;
    const after = /\d[\d,.]*\s*(%|percent|km|miles|years|million|billion|trillion|degrees|kg|tons|metres|meters|feet|times)?/i.exec(text);
    const unit = after?.[1] ?? '';
    return {
      ...NO_GRAPHIC,
      kind: 'stat',
      value,
      suffix: unit.toLowerCase() === 'percent' ? '%' : unit,
      prefix: /\$\s*\d/.test(text) ? '$' : '',
      cue: (after?.[0] ?? '').split(/\s+/)[0] ?? null,
    };
  });
}

/** Never the same kind twice running; the second of a pair becomes a plain frame. */
function noRepeats(graphics: Graphic[]): Graphic[] {
  return graphics.map((graphic, index) =>
    index > 0 && graphic.kind !== 'none' && graphics[index - 1]?.kind === graphic.kind ? NO_GRAPHIC : graphic,
  );
}

export async function directGraphics(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
  force: boolean;
}): Promise<Graphic[]> {
  // The plug's beat, read the same way the renderer reads it.
  const plugIndex = options.beatTexts.findIndex(
    (text) => subscribeMoment(text.split(/\s+/).map((word) => ({ text: word, startMs: 0, endMs: 1 }))) !== null,
  );
  const plug = plugIndex === -1 ? null : plugIndex;
  const plain = plainGraphics(options.beatTexts, plug);

  if (env.GEMINI_API_KEY === undefined) {
    log.info('graphics: no key for the motion designer; counters on the numbers only');
    return plain;
  }

  cache.setForce(options.force);

  try {
    const { value } = await cache.json<{ beats: Record<string, unknown>[] }>(
      'explainer-graphics',
      {
        v: DIRECTION_VERSION,
        model: MODELS.llm.script,
        topic: options.topic,
        script: options.script,
        beats: options.beatTexts,
        seed: options.seed,
      },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction:
            'You are a motion designer choosing on-screen graphics for an explainer video. ' +
            'You only show facts the narration states. You return JSON and nothing else.',
          prompt: buildRequest(options.topic, options.script, options.beatTexts, plug),
          temperature: 0.4,
          seed: toInt32Seed(options.seed),
          maxOutputTokens: 8000,
          responseSchema: RESPONSE_SCHEMA,
        });
        return JSON.parse(response.text) as { beats: Record<string, unknown>[] };
      },
    );

    // Matched by number, not position: a dropped entry must not shift the rest.
    const byBeat = new Map<number, Record<string, unknown>>();
    for (const entry of Array.isArray(value.beats) ? value.beats : []) {
      const at = Number(entry['beat']);
      if (Number.isInteger(at) && !byBeat.has(at)) byBeat.set(at, entry);
    }

    let dropped = 0;
    const chosen = options.beatTexts.map((text, index): Graphic => {
      if (index === 0) return { ...NO_GRAPHIC, kind: 'headline' };
      if (index === plug) return NO_GRAPHIC;
      const raw = byBeat.get(index + 1);
      if (raw === undefined) return plain[index] ?? NO_GRAPHIC;
      // A headline anywhere but the hook is the line twice: once big, once as a caption.
      if (raw['kind'] === 'headline') return NO_GRAPHIC;
      const nearby = new Set(
        [options.beatTexts[index - 1], text, options.beatTexts[index + 1]].flatMap((line) => numbersIn(line ?? '')),
      );
      const graphic = cleanGraphic(raw, text, nearby);
      if (graphic.kind === 'none' && raw['kind'] !== 'none') dropped++;
      return graphic;
    });

    const final = noRepeats(chosen);
    const counts = new Map<string, number>();
    for (const graphic of final) counts.set(graphic.kind, (counts.get(graphic.kind) ?? 0) + 1);
    log.info(
      `graphics: ${[...counts].map(([kind, count]) => `${count} ${kind}`).join(', ')}` +
        (dropped > 0 ? ` (${dropped} refused: a number the narration does not say, or nothing to draw)` : ''),
    );
    return final;
  } catch (error) {
    log.warn(`graphics: the motion designer failed (${(error as Error).message.slice(0, 120)}); counters on the numbers only`);
    return plain;
  }
}
