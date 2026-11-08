import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generateImage, isConfigured as canPaint } from '../providers/flux.js';
import { IMAGE_DIR } from './images.js';
import { drawChecked } from './picturecheck.js';
import sharp from 'sharp';
import { depthMapFor } from '../providers/localvision.js';
import { directStickman, type Genre, type Staging } from './action.js';
import { wordSpan, wordTime, type WarDirection } from './warmap.js';
import { CREATURE_PLURAL } from '../remotion/stickman/vocab.js';
import { AFTER_PHRASE_MS, SOUND_TIMING } from '../assets/library.js';

/**
 * The stick figure's world, painted for the story.
 *
 * The drawn scenes are free and always there, but there are thirteen of them:
 * a video about Kafka's Prague and one about a Tokyo high school both end up
 * in "city". A painted background is the place the narration is actually in.
 * One picture per place, not per beat -- the director repeats a setting word
 * for word while the story stays somewhere, and every beat in that stretch
 * shares the painting -- so a short has a handful and a long video a few
 * dozen, on the cheap image model: about a third of a cent each.
 */

export type StickWorld = 'drawn' | 'ai';

/** A beat of a stick figure video, however it came to be timed. */
export type StickBeat = {
  id: string;
  startMs: number;
  endMs: number;
  action: string;
  stage: {
    scene: string;
    expression: string;
    prop: string;
    companion: string;
    companionExpression: string;
    weather: string;
    /** Animals, drawn: which, how many, and what they are doing. */
    creature?: string;
    creatureCount?: string;
    creatureRole?: string;
    setting?: string;
    /** A painted background under public/images, when the world is painted. */
    background?: string;
    /** Its depth map, white near, so the camera can move through it. */
    depth?: string;
    /** How near the floor the figure stands on is, 0 far to 1 near. */
    floor?: number;
    /** The war channel's extras: map, sounds, gags, stickers, uniforms. */
    war?: WarDirection;
  };
};

/**
 * The longest one painting stays up while the story stays in one place.
 *
 * The director repeats a setting word for word while the story stays put, and
 * that was the whole rule -- so a long stretch in one trench was one painting
 * for a minute and a half, which is exactly the boring single background the
 * parallax exists to avoid. Past this, the same place is painted again from
 * another view.
 */
export const MAX_HOLD_MS = 18_000;

/** Other views of the same place, in the order they are asked for. */
const VIEWS = [
  'seen from closer in, a different angle on the same place',
  'a wider view of the same place, more of its surroundings',
  'the same place seen from the other side, looking back',
  'the same place a little later, the light and sky changed',
];

/**
 * How a painting is asked for, per channel. The books channel's world is a
 * children's-series set; the war channel's is a history documentary's, in the
 * period's own terrain and palette -- not generic cartoon land with a tank in it.
 */
const ART: Record<Genre, string> = {
  books:
    'Eye-level wide shot with open, clear flat ground across the bottom quarter of the picture where a ' +
    'character will stand. Clean vector shapes, rich vivid colours, soft even light, gentle depth, ' +
    'detailed but uncluttered, children\'s animated series background art.',
  // Terrain and buildings only. Asked for "equipment for the era" as well,
  // the model filled a 1932 wheat field with tanks and a helicopter.
  war:
    'Eye-level wide shot with open, clear flat ground across the bottom quarter of the picture where ' +
    'characters will stand. Historically accurate terrain, buildings and fortifications for the era, and ' +
    'nothing else: no vehicles, no aircraft, no weapons, no machinery, nothing modern. 2D animated history ' +
    'documentary background: bold flat shapes with a painterly texture, a ' +
    'muted period palette of olive, khaki, slate and rust with warm light accents, a dramatic sky, ' +
    'gentle depth, cinematic but uncluttered.',
};

const WEATHER_WORDS: Record<string, string> = {
  rain: 'in heavy rain, wet reflective ground',
  storm: 'in a dark thunderstorm',
  snow: 'in falling snow, snow on the ground',
  fog: 'in thick fog',
  embers: 'with smoke and glowing embers in the air',
  leaves: 'in autumn with falling leaves',
};

/**
 * Words a setting should not carry into a painting: anything that brings
 * people or writing with it. "Glowing shop signs" came back as a street of
 * gibberish lettering with two pedestrians in it.
 */
const clean = (setting: string): string =>
  setting
    .replace(/\b(with\s+)?(glowing\s+|neon\s+)?(shop\s+)?(signs?|signage|posters?|billboards?|banners?|menus?|newspapers?)\b/gi, '')
    .replace(/\b(people|crowds?|shoppers|pedestrians|students|passers-?by|figures?|customers|workers)\b/gi, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/[,\s]+$/, '')
    .trim();

const size = (orientation: 'portrait' | 'landscape'): { width: number; height: number } =>
  orientation === 'portrait' ? { width: 768, height: 1344 } : { width: 1344, height: 768 };

/**
 * Backgrounds for every beat, one per distinct setting in a row.
 *
 * Never throws: a setting that cannot be painted keeps its drawn scene, which
 * is a complete look on its own.
 */
export async function paintSettings(options: {
  beats: StickBeat[];
  orientation: 'portrait' | 'landscape';
  seed: number;
  topic: string;
  genre?: Genre;
}): Promise<{ painted: number; usd: number }> {
  const art = ART[options.genre ?? 'books'];
  if (!canPaint()) {
    log.warn('stickman: no image key, so the world stays drawn');
    return { painted: 0, usd: 0 };
  }
  const { width, height } = size(options.orientation);
  let usd = 0;
  let painted = 0;
  const byPlace = new Map<string, string | null>();

  /**
   * Depth for each painting, on this machine and for free, so the camera can
   * move through the place: near things slide past far ones. And the depth of
   * the floor where the figure stands, so the figure moves with the floor
   * under its feet instead of sliding across it.
   */
  const depthOf = new Map<string, { depth: string; floor: number }>();
  const withDepth = async (file: string): Promise<void> => {
    if (depthOf.has(file)) return;
    const depth = await depthMapFor(path.join(IMAGE_DIR, file));
    if (depth === null) return;
    // The floor strip the figure stands on: the middle of the frame, low down.
    const { data, info } = await sharp(path.join(IMAGE_DIR, depth))
      .extractChannel(0)
      .resize(64, 64, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const row = Math.round(info.height * (options.orientation === 'portrait' ? 0.8 : 0.86));
    const samples: number[] = [];
    for (let y = row - 2; y <= row + 2; y++) {
      for (let x = Math.round(info.width * 0.3); x < Math.round(info.width * 0.7); x++) {
        samples.push(data[y * info.width + x]! / 255);
      }
    }
    samples.sort((a, b) => a - b);
    depthOf.set(file, { depth, floor: samples[Math.floor(samples.length / 2)] ?? 0.8 });
  };

  let run = '';
  let runStart = 0;
  let view = 0;
  /**
   * Animals far off in the painting, decided once per painting rather than
   * per beat: a stretch where the drawn emus come and go should not have the
   * sky behind them repainted every time they do.
   */
  let herd = '';
  for (const beat of options.beats) {
    // A map is its own picture.
    if (beat.stage.war?.map !== undefined && beat.stage.war.map !== null) continue;
    const setting = (beat.stage.setting ?? '').trim();
    if (setting === '') continue;
    const weather = WEATHER_WORDS[beat.stage.weather] ?? '';
    const place = `${setting.toLowerCase()}|${weather}`;
    const animals =
      beat.stage.creature !== undefined && beat.stage.creature !== 'none' && beat.stage.creatureRole !== 'ally'
        ? (CREATURE_PLURAL[beat.stage.creature] ?? '')
        : '';
    if (place !== run) {
      run = place;
      runStart = beat.startMs;
      view = 0;
      herd = animals;
    } else if (beat.startMs - runStart >= MAX_HOLD_MS) {
      view += 1;
      runStart = beat.startMs;
      herd = animals;
    }
    const key = `${view === 0 ? place : `${place}|view${view}`}${herd === '' ? '' : `|${herd}`}`;
    const angle = view === 0 ? '' : `, ${VIEWS[(view - 1) % VIEWS.length]}`;
    if (byPlace.has(key)) {
      const file = byPlace.get(key);
      if (file !== null && file !== undefined) {
        Object.assign(beat.stage, { background: file, ...(depthOf.get(file) ?? {}) });
      }
      continue;
    }

    /**
     * Built for a character to be put into it: empty, eye level, with open
     * floor across the bottom where the figure stands, and in flat colour so a
     * drawn stick figure belongs in it rather than looking pasted onto a
     * photograph.
     */
    // Emptiness first: the cheap model weights the front of a prompt hardest,
    // and said last, "no people" still came back with a passer-by in it.
    const prompt =
      `Deserted and empty, nobody there. Flat 2D cartoon background painting for an animated show: ${clean(setting)}` +
      `${weather === '' ? '' : `, ${weather}`}${angle}. ` +
      (herd === ''
        ? 'An empty set: no people, no characters, no animals, no text, no letters, no signs, no posters. '
        : `A few ${herd} small in the far distance, and otherwise empty: no people, no characters, no text, ` +
          'no letters, no signs, no posters, and nothing in the foreground. ') +
      art;
    const seed = (options.seed + crypto.createHash('sha1').update(key).digest().readUInt32LE(0)) >>> 0;

    try {
      const file = await drawChecked({
        label: `background "${setting.slice(0, 40)}"`,
        brief: `${setting}${weather === '' ? '' : `, ${weather}`}${angle}${herd === '' ? '' : `, ${herd} far away`}`,
        must:
          herd === ''
            ? 'an empty place with no people, no characters and no written text, with open ground at the bottom'
            : `a place with no people and no written text, open ground at the bottom, and any ${herd} small and far away`,
        draw: async (fix, take) => {
          const asked = `${prompt}${fix}`;
          const tried = take === 0 ? seed : (seed + 7919 * take) >>> 0;
          const { path: drawn, hit } = await cache.file(
            'stick-background',
            { prompt: asked, seed: tried, width, height, model: env.FLUX_MODEL },
            '.jpg',
            async (destination) => {
              const result = await generateImage({ prompt: asked, seed: tried, width, height });
              fs.writeFileSync(destination, result.bytes);
            },
          );
          if (hit !== true) {
            usd += env.FLUX_USD_PER_IMAGE;
            painted += 1;
          }
          return { file: drawn, fresh: hit !== true };
        },
      });
      const served = `stickbg-${path.basename(file)}`;
      const target = path.join(IMAGE_DIR, served);
      if (!fs.existsSync(target)) fs.copyFileSync(file, target);
      byPlace.set(key, served);
      await withDepth(served);
      Object.assign(beat.stage, { background: served, ...(depthOf.get(served) ?? {}) });
      log.info(`stickman: painted "${setting}"`);
    } catch (error) {
      byPlace.set(key, null);
      log.warn(`stickman: could not paint "${setting}" (${(error as Error).message}); it stays drawn`);
    }
  }
  log.info(`stickman: ${byPlace.size} place(s), ${painted} newly painted, about $${usd.toFixed(3)}`);
  return { painted, usd };
}

/**
 * A long video's stick figure beats, from its captions.
 *
 * The captions already carry exact times, so the beats are runs of them: a
 * new beat roughly every seven seconds, always starting where a line starts,
 * so the figure changes what it is doing as the sentence changes rather than
 * in the middle of a word.
 */
export function beatsFromLines(
  lines: readonly { text: string; startMs: number; endMs: number }[],
  durationMs: number,
  everyMs = 7_000,
): { id: string; startMs: number; endMs: number; text: string }[] {
  // A pause in the narration (a chapter card) is not a beat's worth of words.
  lines = lines.filter((line) => line.text.trim() !== '');
  const beats: { id: string; startMs: number; endMs: number; text: string }[] = [];
  let current: { startMs: number; text: string[] } | null = null;
  for (const line of lines) {
    if (current === null) current = { startMs: line.startMs, text: [] };
    current.text.push(line.text);
    if (line.endMs - current.startMs >= everyMs) {
      beats.push({ id: `stick-${beats.length}`, startMs: current.startMs, endMs: line.endMs, text: current.text.join(' ') });
      current = null;
    }
  }
  if (current !== null) {
    beats.push({ id: `stick-${beats.length}`, startMs: current.startMs, endMs: durationMs, text: current.text.join(' ') });
  }
  // Gaps between beats belong to the beat before, so nothing is ever blank.
  for (let i = 0; i < beats.length; i++) {
    const next = beats[i + 1];
    beats[i]!.endMs = next === undefined ? durationMs : next.startMs;
  }
  if (beats[0] !== undefined) beats[0].startMs = 0;
  return beats;
}

/** Stages a long video end to end: timing, direction, and the painted world. */
export async function stageLongStickman(options: {
  topic: string;
  script: string;
  lines: readonly { text: string; startMs: number; endMs: number; wordStarts?: number[] }[];
  durationMs: number;
  seed: number;
  world: StickWorld;
  genre?: Genre;
}): Promise<StickBeat[]> {
  const genre = options.genre ?? 'books';
  // The war channel cuts faster: a joke needs the next beat to land on.
  const timed = beatsFromLines(options.lines, options.durationMs, genre === 'war' ? 5_500 : 7_000);
  const staging: Staging[] = await directStickman({
    topic: options.topic,
    script: options.script,
    beatTexts: timed.map((beat) => beat.text),
    seed: options.seed,
    genre,
  });
  const beats: StickBeat[] = timed.map((beat, index) => {
    const stage = staging[index]!;
    return {
      id: beat.id,
      startMs: beat.startMs,
      endMs: beat.endMs,
      action: stage.action,
      stage: {
        scene: stage.scene,
        expression: stage.expression,
        prop: stage.prop,
        companion: stage.companion,
        companionExpression: stage.companionExpression,
        weather: stage.weather,
        ...(stage.creature === 'none'
          ? {}
          : { creature: stage.creature, creatureCount: stage.creatureCount, creatureRole: stage.creatureRole }),
        setting: stage.setting,
        ...(stage.war === undefined ? {} : { war: timedWar(stage.war, beat, options.lines) }),
      },
    };
  });
  if (options.world === 'ai') {
    await paintSettings({ beats, orientation: 'landscape', seed: options.seed, topic: options.topic, genre });
  }
  return beats;
}

/**
 * A short's words as the phrases a sound can follow.
 *
 * Long form has caption lines with word starts; a short has one list of timed
 * words. Cut at the end of each sentence, that list becomes the same shape --
 * so a rimshot after a punchline waits for the sentence to finish in a short
 * exactly as it does in an essay.
 */
export function phrasesOf(
  words: readonly { text: string; startMs: number; endMs: number }[],
): { text: string; startMs: number; endMs: number; wordStarts: number[] }[] {
  const phrases: { text: string; startMs: number; endMs: number; wordStarts: number[] }[] = [];
  let current: { text: string; startMs: number; endMs: number }[] = [];
  const close = (): void => {
    if (current.length === 0) return;
    phrases.push({
      text: current.map((word) => word.text).join(' '),
      startMs: current[0]!.startMs,
      endMs: current[current.length - 1]!.endMs,
      wordStarts: current.map((word) => word.startMs),
    });
    current = [];
  };
  for (const word of words) {
    current.push(word);
    if (/[.!?…]["”’)]*$/.test(word.text)) close();
  }
  close();
  return phrases;
}

/**
 * The war extras, put on the clock: every sound and gag lands on the word the
 * director picked, found in the captions' own word timings. The sticker lands
 * with the beat's first sound if it has one -- the joke and its sting arrive
 * together -- and a third of the way in if not.
 */
export function timedWar(
  war: WarDirection,
  beat: { startMs: number; endMs: number },
  lines: readonly { text: string; startMs: number; endMs: number; wordStarts?: number[] }[],
): WarDirection {
  const sounds = war.sounds.map((sound) => {
    const span = wordSpan(sound.word, beat, lines);
    return { ...sound, atMs: span.startMs, phraseEndMs: span.phraseEndMs, matched: span.found };
  });
  // The sticker arrives with its sound: after the phrase if the sound is a
  // reaction, on the word if it is part of the action.
  const first = sounds[0];
  const stickerAt =
    first === undefined
      ? wordTime('', beat, lines)
      : SOUND_TIMING[first.kind] === 'after'
        ? first.phraseEndMs + AFTER_PHRASE_MS
        : first.atMs;
  return {
    ...war,
    sounds,
    ...(war.gag === 'none' ? {} : { gagAtMs: wordTime(war.gagWord, beat, lines) }),
    ...(war.sticker === null ? {} : { stickerAtMs: stickerAt }),
  };
}
