import fs from 'node:fs';
import { SFX_GAIN_DB } from '../config.js';
import {
  OVER_SPEECH_DB,
  SOUND_GAIN_DB,
  SOUND_LEVEL_DB,
  pickSound,
  soundPath,
  type SoundKind,
} from '../assets/library.js';
import { narrationOf, shapeOf, speechIn, type Narration } from '../assets/envelope.js';
import {
  SUBSCRIBE_TIMING,
  cueTime,
  itemTimes,
  subscribeMoment,
  type TimedWord,
} from '../explainer.js';
import { log } from '../log.js';
import { loadSfxLibrary, resolveCue, type Placement } from '../sfx.js';
import type { BeatSheet } from '../schema.js';
import { lufsOf } from './warsound.js';

/**
 * The explainer's sound design: a sound under every graphic event, on the
 * frame the picture does it.
 *
 * Everything is derived from what the renderer will draw and when, using the
 * same timing functions (explainer.ts), so the pop and the item it belongs to
 * cannot drift apart: a list item arrives on its word and so does its pop.
 * Nothing here is chosen by a model -- the graphic was, and its sound follows.
 *
 *   stat       a ding as the counter lands, or the till for money
 *   compare    the VS badge's pop, and each side's arrival
 *   bars       a pop per bar as it grows
 *   timeline   a pop per point
 *   steps      a pop per step
 *   list       a pop per item
 *   term       a ding as the card opens
 *   callout    a whoosh as the lower third wipes on
 *   subscribe  the card's pop, the mouse click, the bell
 *
 * The cut sounds -- the whoosh on each transition, the riser into the turn --
 * are the sheet's own cues and are mixed with the rest. This adds only what
 * the graphics imply.
 */

/** Two of one kind closer than this are heard as one, so the second is dropped. */
const MIN_REPEAT_MS = 260;

type Event = { kind: SoundKind | 'click'; atMs: number; extraDb?: number };

function eventsOf(sheet: BeatSheet): Event[] {
  const events: Event[] = [];
  for (const beat of sheet.beats) {
    const graphic = beat.graphic;
    const words: TimedWord[] = beat.captions ?? [];
    if (graphic === null || graphic.kind === 'none') continue;
    const start = beat.startMs;
    const items = (): number[] => itemTimes(graphic.items, words, start, beat.endMs);
    switch (graphic.kind) {
      case 'headline':
        break;
      case 'stat': {
        const said = cueTime(graphic.cue, words, start);
        // Matches the renderer: the counter lands four frames after the word.
        const land = Math.max(start + 500, (said ?? start + (beat.endMs - start) * 0.5) + 130);
        events.push({ kind: graphic.prefix.includes('$') ? 'cash' : 'ding', atMs: land });
        break;
      }
      case 'compare':
        events.push({ kind: 'pop', atMs: start + 200, extraDb: 1 });
        for (const at of items()) events.push({ kind: 'whoosh', atMs: at, extraDb: -3 });
        break;
      case 'bars':
      case 'timeline':
      case 'steps':
      case 'list':
        for (const at of items()) events.push({ kind: 'pop', atMs: at });
        break;
      case 'term':
        events.push({ kind: 'ding', atMs: start + 120 });
        break;
      case 'callout':
        events.push({ kind: 'whoosh', atMs: start + 200, extraDb: -2 });
        break;
      case 'map':
        // The flight in, and the pin landing (MapGraphic: frames 2-24, pin at 26).
        events.push({ kind: 'whoosh', atMs: start + 260, extraDb: -1 });
        events.push({ kind: 'pop', atMs: start + 900, extraDb: 1 });
        break;
    }
  }

  const plug = subscribeMoment(sheet.beats.flatMap((beat) => beat.captions ?? []));
  if (plug !== null) {
    const open = Math.max(0, plug - SUBSCRIBE_TIMING.leadMs);
    events.push({ kind: 'pop', atMs: open + 60, extraDb: 2 });
    events.push({ kind: 'click', atMs: open + SUBSCRIBE_TIMING.leadMs + SUBSCRIBE_TIMING.clickMs });
    events.push({ kind: 'ding', atMs: open + SUBSCRIBE_TIMING.leadMs + SUBSCRIBE_TIMING.bellMs, extraDb: 1 });
  }
  return events.sort((a, b) => a.atMs - b.atMs);
}

export async function planExplainerSound(
  sheet: BeatSheet,
  options: { narrationPath: string; voiceLufs: number },
): Promise<Placement[]> {
  const events = eventsOf(sheet);
  if (events.length === 0) return [];

  let voice: Narration | null = null;
  let voiceGain = 0;
  if (fs.existsSync(options.narrationPath)) {
    try {
      voice = narrationOf(options.narrationPath, 0);
      const measured = await lufsOf(options.narrationPath);
      voiceGain = Number.isFinite(measured) ? options.voiceLufs - measured : 0;
    } catch (error) {
      log.warn(`sound: could not measure the narration (${(error as Error).message}); graphic sounds at table levels`);
      voice = null;
    }
  }

  const sfx = loadSfxLibrary();
  const placements: Placement[] = [];
  const occurrence = new Map<string, number>();
  const last = new Map<string, number>();
  let missing = 0;

  for (const event of events) {
    const previous = last.get(event.kind);
    if (previous !== undefined && event.atMs - previous < MIN_REPEAT_MS) continue;
    const n = occurrence.get(event.kind) ?? 0;

    if (event.kind === 'click') {
      // The mouse click is the shorts' own click cue, not a library sound.
      const file = resolveCue(sfx, 'click', n);
      if (file === undefined) {
        missing++;
        continue;
      }
      placements.push({ file, cue: { cue: 'click', atMs: Math.round(event.atMs), gainDb: SFX_GAIN_DB.click + 8, variant: n } });
    } else {
      const entry = pickSound(event.kind, sheet.meta.seed, n);
      if (entry === null) {
        missing++;
        continue;
      }
      const shape = voice === null ? null : shapeOf(entry);
      // The hit, not the file's first sample, goes on the moment.
      const atMs = Math.max(0, Math.round(event.atMs - (shape?.onsetMs ?? 0)));
      let gainDb: number;
      if (voice !== null && shape !== null) {
        gainDb = voice.activeDb + voiceGain + SOUND_LEVEL_DB[event.kind] - shape.activeDb + (event.extraDb ?? 0);
        if (speechIn(voice, atMs + shape.onsetMs, atMs + shape.onsetMs + Math.min(400, entry.durationMs)) > 0.4) {
          gainDb += OVER_SPEECH_DB;
        }
        gainDb = Math.min(gainDb, 0);
      } else {
        gainDb = SOUND_GAIN_DB[event.kind] - 12 + (event.extraDb ?? 0);
      }
      placements.push({ file: soundPath(entry), cue: { cue: 'impact', atMs, gainDb, variant: 0 } });
    }
    occurrence.set(event.kind, n + 1);
    last.set(event.kind, event.atMs);
  }

  if (missing > 0) log.warn(`sfx: ${missing} graphic sound(s) had no sample in the library (run "breezematic assets")`);
  log.info(`sfx: ${placements.length} graphic and plug sound(s) on their frames`);
  return placements;
}
