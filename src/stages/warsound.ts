import fs from 'node:fs';
import path from 'node:path';
import {
  AFTER_PHRASE_MS,
  OVER_SPEECH_DB,
  SOUND_GAIN_DB,
  SOUND_LEVEL_DB,
  SOUND_TIMING,
  pickSound,
  soundCredits,
  soundPath,
  type SoundEntry,
  type SoundKind,
} from '../assets/library.js';
import { ICONS } from '../remotion/war/icons.js';
import { OUTFIT_ICONS, PROP_ICON } from '../remotion/stickman/vocab.js';
import { DUCK_DB, type Cue } from './essaysound.js';
import { narrationOf, phraseEnd, shapeOf, speechIn, wordOnset, type Narration } from '../assets/envelope.js';
import { ffmpeg } from '../ffmpeg.js';
import { log } from '../log.js';
import type { StickBeat } from './stickworld.js';

/**
 * The war channel's sound, from what the director chose for each beat.
 *
 * Every sound lands on its word. Three more are implied by the picture and
 * added here, so the director does not have to ask for them twice: a freeze
 * gets its record scratch, a shake with nothing under it gets a blast, and a
 * sticker lands with a pop. A map opens on a whoosh as it flies in.
 *
 * With the narration to hand -- which is always, now -- both the level and
 * the timing are measured rather than assumed (envelope.ts): each sound sits
 * a set distance under the voice, by how loud it actually is, and its hit
 * lands where the word actually starts in the recording, or in the actual
 * silence after the line. Without it, the old table and the transcriber's
 * times are used, a few dB further down to be safe.
 */

/** The same kind this close together is one event heard twice. */
const MIN_REPEAT_MS = 400;

/** Where in the gap after a line a reaction starts: a beat, not a pause. */
const INTO_GAP_MS = 60;

export type WarSound = { cues: Cue[]; used: SoundEntry[] };

export type WarSoundOptions = {
  /** The narration as the mix will play it, and where it starts on the video's clock. */
  narration?: { path: string; offsetMs: number };
  /** How loud the mix puts the voice, in LUFS. */
  voiceLufs?: number;
  /** The viewer's taste: every war sound up or down together, in dB. */
  trimDb?: number;
};

/** Integrated loudness of a file, in LUFS. */
export async function lufsOf(file: string): Promise<number> {
  const { stderr } = await ffmpeg(['-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']);
  const found = [...stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  return found === undefined ? Number.NaN : Number(found[1]);
}

export async function planWarSound(
  beats: readonly StickBeat[],
  seed: number,
  options: WarSoundOptions = {},
): Promise<WarSound> {
  const cues: Cue[] = [];
  const used: SoundEntry[] = [];
  const occurrence = new Map<SoundKind, number>();
  const last = new Map<SoundKind, number>();
  const trim = options.trimDb ?? 0;

  let voice: Narration | null = null;
  // What the mix does to the narration's level, so the sounds can follow it.
  let voiceGain = 0;
  if (options.narration !== undefined && fs.existsSync(options.narration.path)) {
    try {
      voice = narrationOf(options.narration.path, options.narration.offsetMs);
      const measured = await lufsOf(options.narration.path);
      voiceGain = Number.isFinite(measured) && options.voiceLufs !== undefined ? options.voiceLufs - measured : 0;
    } catch (error) {
      log.warn(`sound: could not measure the narration (${(error as Error).message}); placing war sounds by the transcript`);
      voice = null;
    }
  }

  /**
   * `wordMs` is when the word starts; `phraseEndMs` when its phrase ends,
   * both as transcribed. Where the sound actually goes depends on what kind
   * of sound it is -- see SOUND_TIMING -- and on where the sound is inside
   * its own file, which is why it is decided here and not upstream.
   */
  const add = (kind: SoundKind, wordMs: number, extraDb = 0, phraseEndMs = wordMs): void => {
    const n = occurrence.get(kind) ?? 0;
    const entry = pickSound(kind, seed, n);
    if (entry === null) return;
    const timing = SOUND_TIMING[kind];

    let atMs: number;
    let gainDb: number;
    if (voice !== null) {
      const shape = shapeOf(entry);
      const onset = wordOnset(voice, wordMs);
      atMs =
        timing === 'after'
          ? phraseEnd(voice, Math.max(wordMs, phraseEndMs)) + INTO_GAP_MS - shape.onsetMs
          : timing === 'end-on'
            ? onset - shape.peakMs
            : timing === 'centre'
              ? onset - shape.centreMs
              : onset - shape.onsetMs;
      // A set distance under the voice, by how loud each actually is.
      gainDb = voice.activeDb + voiceGain + SOUND_LEVEL_DB[kind] - shape.activeDb + extraDb + trim;
      const sounding = atMs + shape.onsetMs;
      if (speechIn(voice, sounding, sounding + Math.min(500, entry.durationMs)) > 0.4) gainDb += OVER_SPEECH_DB;
      // Files are normalised to -1 dBFS: never push one past the point it clips.
      gainDb = Math.min(gainDb, 0);
    } else {
      atMs =
        timing === 'after'
          ? Math.max(wordMs, phraseEndMs) + AFTER_PHRASE_MS
          : timing === 'end-on'
            ? wordMs - entry.durationMs
            : timing === 'centre'
              ? wordMs - entry.durationMs / 2
              : wordMs;
      gainDb = SOUND_GAIN_DB[kind] - 10 + extraDb + trim;
    }

    const previous = last.get(kind);
    if (previous !== undefined && Math.abs(atMs - previous) < MIN_REPEAT_MS) return;
    occurrence.set(kind, n + 1);
    last.set(kind, atMs);
    used.push(entry);
    // Stored against the essay mix's convention, which ducks every cue by DUCK_DB.
    cues.push({ kind: 'war', atMs: Math.max(0, Math.round(atMs)), file: soundPath(entry), gainDb: gainDb - DUCK_DB });
  };

  let dropped = 0;
  for (const beat of beats) {
    const war = beat.stage.war;
    if (war === undefined) continue;
    for (const sound of war.sounds) {
      // A sound whose word is not in the narration has nowhere true to go.
      // Placed a third of the way into the beat it was early or late by a
      // second, which is worse than no sound.
      if (sound.matched === false) {
        dropped++;
        continue;
      }
      add(sound.kind, sound.atMs ?? beat.startMs, 0, sound.phraseEndMs ?? sound.atMs ?? beat.startMs);
    }

    if (war.gag === 'freeze' && typeof war.gagAtMs === 'number') {
      if (!war.sounds.some((sound) => sound.kind === 'record-scratch')) add('record-scratch', war.gagAtMs);
    }
    if (war.gag === 'shake' && typeof war.gagAtMs === 'number' && war.sounds.length === 0) {
      add('explosion', war.gagAtMs);
    }
    if (war.sticker !== null && typeof war.stickerAtMs === 'number') add('pop', war.stickerAtMs, -2);
    if (war.map !== null) add('whoosh', beat.startMs, -4);
  }
  if (dropped > 0) log.info(`sound: ${dropped} war sound(s) dropped -- their word is not in the narration`);
  if (voice !== null) log.info('sound: war sounds levelled under the voice and placed on the recording');

  cues.sort((a, b) => a.atMs - b.atMs);
  return { cues, used };
}

/** The icons a video actually drew, by name. */
function iconsUsed(beats: readonly StickBeat[]): string[] {
  const names = new Set<string>();
  for (const beat of beats) {
    const icon = PROP_ICON[beat.stage.prop];
    if (icon !== undefined) names.add(icon);
    const war = beat.stage.war;
    if (war === undefined) continue;
    for (const outfit of [war.outfit, war.rivalOutfit]) if (OUTFIT_ICONS.includes(outfit)) names.add(outfit);
    if (war.sticker !== null) names.add(war.sticker.icon);
    for (const place of war.map?.places ?? []) if (place.icon !== undefined) names.add(place.icon);
    for (const arrow of war.map?.arrows ?? []) if (arrow.icon !== undefined) names.add(arrow.icon);
  }
  return [...names].filter((name) => ICONS[name] !== undefined);
}

/**
 * The credits a war video owes, written next to it for the description:
 * the sound effects it used, the icon artists it used (the licence asks for
 * "Icons made by {author}"), and the map data when there was a map.
 */
export function writeWarCredits(dir: string, beats: readonly StickBeat[], sound: WarSound): void {
  const parts: string[] = [];

  const sounds = soundCredits(sound.used);
  if (sounds !== '') parts.push(sounds);

  const icons = iconsUsed(beats);
  if (icons.length > 0) {
    const byArtist = new Map<string, string[]>();
    for (const name of icons) {
      const icon = ICONS[name]!;
      const list = byArtist.get(icon.author) ?? [];
      list.push(name);
      byArtist.set(icon.author, list);
    }
    // The licence's own wording is "Icons made by {author}", with the site.
    const artists = [...byArtist.keys()];
    const named = artists.length <= 1 ? artists.join('') : `${artists.slice(0, -1).join(', ')} and ${artists[artists.length - 1]}`;
    parts.push(`Icons made by ${named} from game-icons.net (CC BY 3.0) https://game-icons.net`);
  }

  if (beats.some((beat) => beat.stage.war?.map !== null && beat.stage.war?.map !== undefined)) {
    parts.push('Map data: Natural Earth (public domain) https://www.naturalearthdata.com');
  }

  const file = path.join(dir, 'war-credits.txt');
  if (parts.length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, `${parts.join('\n\n')}\n`, 'utf8');
}
