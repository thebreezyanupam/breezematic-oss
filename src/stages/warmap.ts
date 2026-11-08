import { GAGS, OUTFITS, SIDES } from '../remotion/stickman/vocab.js';
import { ICON_NAMES } from '../remotion/war/icons.js';
import { isSoundKind, type SoundKind } from '../assets/library.js';

/**
 * What a beat of a war video carries on top of the stick figure's staging:
 * the map, the sound effects, the editing gag, the meme sticker, and who is
 * wearing what.
 *
 * Kept apart from the plain staging because the books channel has none of it,
 * and apart from the renderer because the server has to check every field a
 * model wrote before anything is drawn with it. A coordinate out of range, an
 * arrow to a place that is not on the map, an icon the set does not have --
 * each is dropped here rather than discovered as a blank frame.
 */

export type Side = (typeof SIDES)[number];
export type Gag = (typeof GAGS)[number];

export type MapPlace = { name: string; lat: number; lon: number; icon?: string };
export type MapArrow = { from: string; to: string; side: Side; icon?: string };
export type MapHighlight = { country: string; side: Side };
export type WarMap = { title: string; places: MapPlace[]; arrows: MapArrow[]; highlight: MapHighlight[] };

/**
 * A sound, and the word it lands on. Once words have times: `atMs` is when
 * the word starts, `phraseEndMs` when the phrase it is in is finished.
 */
export type BeatSound = {
  kind: SoundKind;
  word: string;
  atMs?: number;
  phraseEndMs?: number;
  /** False when the word is not in the narration: the sound then has no true place, and is left out. */
  matched?: boolean;
};

export type WarDirection = {
  outfit: string;
  rivalOutfit: string;
  sounds: BeatSound[];
  gag: Gag;
  gagWord: string;
  gagAtMs?: number;
  /** A meme sticker: an icon and at most a few words, popped on for a moment. */
  sticker: { icon: string; text: string } | null;
  stickerAtMs?: number;
  map: WarMap | null;
};

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (list as readonly string[]).includes(value.trim().toLowerCase())
    ? (value.trim().toLowerCase() as T)
    : fallback;

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Near misses a model writes for names in the set. The icon field is free
 * text (see warSchema), so "machine gun" and "boom" have to find their way to
 * "machine-gun" and "explosion" rather than being dropped.
 */
const ICON_ALIASES: Record<string, string> = {
  boom: 'explosion', blast: 'explosion', bang: 'explosion', battle: 'crossed-swords', fight: 'crossed-swords',
  soldier: 'rally', soldiers: 'army', troops: 'army', infantry: 'army', plane: 'biplane', aircraft: 'biplane',
  ship: 'galleon', navy: 'battleship', fleet: 'warship', gun: 'rifle', guns: 'machine-gun', death: 'skull',
  dead: 'skull', king: 'crown', emperor: 'crown', victory: 'trophy', win: 'trophy', surrender: 'black-flag',
  money: 'money', cash: 'coins', fort: 'fort', city: 'castle', horse: 'cavalry', bomb: 'bomb', nuclear: 'nuke',
};

const icon = (value: unknown): string | undefined => {
  const name = text(value, 40).toLowerCase().replace(/[\s_]+/g, '-');
  if (name === '' || name === 'none') return undefined;
  if (ICON_NAMES.includes(name)) return name;
  const alias = ICON_ALIASES[name] ?? ICON_ALIASES[name.replace(/-/g, ' ')];
  return alias !== undefined && ICON_NAMES.includes(alias) ? alias : undefined;
};

const number = (value: unknown, low: number, high: number): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= low && n <= high ? n : null;
};

export function cleanMap(raw: unknown): WarMap | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value['show'] === false) return null;

  const places: MapPlace[] = [];
  for (const item of Array.isArray(value['places']) ? value['places'] : []) {
    const place = item as Record<string, unknown>;
    const name = text(place['name'], 32);
    const lat = number(place['lat'], -85, 85);
    const lon = number(place['lon'], -180, 180);
    if (name === '' || lat === null || lon === null) continue;
    if (places.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
    const glyph = icon(place['icon']);
    places.push({ name, lat, lon, ...(glyph === undefined ? {} : { icon: glyph }) });
    if (places.length >= 8) break;
  }

  const named = new Set(places.map((place) => place.name.toLowerCase()));
  const arrows: MapArrow[] = [];
  for (const item of Array.isArray(value['arrows']) ? value['arrows'] : []) {
    const arrow = item as Record<string, unknown>;
    const from = text(arrow['from'], 32);
    const to = text(arrow['to'], 32);
    // An arrow is between two places on this map, or it is not drawn.
    if (!named.has(from.toLowerCase()) || !named.has(to.toLowerCase()) || from.toLowerCase() === to.toLowerCase()) continue;
    const glyph = icon(arrow['icon']);
    arrows.push({ from, to, side: oneOf(SIDES, arrow['side'], 'red'), ...(glyph === undefined ? {} : { icon: glyph }) });
    if (arrows.length >= 6) break;
  }

  const highlight: MapHighlight[] = [];
  for (const item of Array.isArray(value['highlight']) ? value['highlight'] : []) {
    const entry = item as Record<string, unknown>;
    const country = text(entry['country'], 48);
    if (country === '') continue;
    highlight.push({ country, side: oneOf(SIDES, entry['side'], 'neutral') });
    if (highlight.length >= 10) break;
  }

  // A map with nothing on it is not a map beat.
  if (places.length === 0 && highlight.length === 0) return null;
  return { title: text(value['title'], 48), places, arrows, highlight };
}

export function cleanWarDirection(raw: unknown, available: readonly SoundKind[]): WarDirection {
  const value = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sounds: BeatSound[] = [];
  for (const item of Array.isArray(value['sounds']) ? value['sounds'] : []) {
    const sound = item as Record<string, unknown>;
    const kind = text(sound['sound'], 24).toLowerCase();
    if (!isSoundKind(kind) || !available.includes(kind)) continue;
    sounds.push({ kind, word: text(sound['word'], 40) });
    if (sounds.length >= 2) break;
  }
  const stickerRaw = value['sticker'] as Record<string, unknown> | null | undefined;
  const stickerIcon = icon(stickerRaw?.['icon']);
  const stickerText = text(stickerRaw?.['text'], 28);
  return {
    outfit: oneOf(OUTFITS, value['outfit'], 'none'),
    rivalOutfit: oneOf(OUTFITS, value['rivalOutfit'], 'none'),
    sounds,
    gag: oneOf(GAGS, value['gag'], 'none'),
    gagWord: text(value['gagWord'], 40),
    sticker: stickerIcon === undefined ? null : { icon: stickerIcon, text: stickerText },
    map: cleanMap(value['map']),
  };
}

/** Words as they compare: the model copies a word, the captions punctuate it. */
const norm = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * When a word the model picked is said, inside a beat.
 *
 * The captions carry a start time for every word, so the sound can land on
 * the word rather than on the beat -- the difference between a rimshot after
 * the punchline and a rimshot somewhere near it. A word that is not found in
 * the beat lands a third of the way in, which is where a beat's point usually
 * is, rather than at its start, where it would step on the last one.
 */
export function wordTime(
  word: string,
  beat: { startMs: number; endMs: number },
  lines: readonly { text: string; startMs: number; endMs: number; wordStarts?: number[] }[],
): number {
  return wordSpan(word, beat, lines).startMs;
}

/**
 * The word's start and the end of the phrase it sits in -- the caption line,
 * which is how the narration is phrased. When the word is not found, both
 * fall a third of the way into the beat.
 */
export function wordSpan(
  word: string,
  beat: { startMs: number; endMs: number },
  lines: readonly { text: string; startMs: number; endMs: number; wordStarts?: number[] }[],
): { startMs: number; phraseEndMs: number; found: boolean } {
  const wanted = norm(word.split(/\s+/)[0] ?? '');
  if (wanted !== '') {
    /**
     * Exact first, then near: the model writes "emus" where the captions say
     * "emus'", or "gun" for "guns". A near match must share the start of the
     * word and be most of it, so "war" does not find "warm".
     */
    const near = (candidate: string): boolean =>
      candidate.length >= 3 &&
      wanted.length >= 3 &&
      (candidate.startsWith(wanted) || wanted.startsWith(candidate)) &&
      Math.min(candidate.length, wanted.length) / Math.max(candidate.length, wanted.length) >= 0.7;
    for (const test of [(c: string) => c === wanted, near]) {
      for (const line of lines) {
        if (line.endMs <= beat.startMs || line.startMs >= beat.endMs) continue;
        const words = line.text.split(/\s+/);
        for (let i = 0; i < words.length; i++) {
          if (!test(norm(words[i] ?? ''))) continue;
          const at = line.wordStarts?.[i] ?? line.startMs;
          if (at >= beat.startMs && at < beat.endMs) return { startMs: at, phraseEndMs: line.endMs, found: true };
        }
      }
    }
  }
  const third = Math.round(beat.startMs + (beat.endMs - beat.startMs) / 3);
  return { startMs: third, phraseEndMs: third, found: false };
}
