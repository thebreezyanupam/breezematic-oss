import fs from 'node:fs';
import path from 'node:path';
import { assetDirs } from '../config.js';

/**
 * The sound library: every effect a video may use, by what it is.
 *
 * The four cues the shorts use (whoosh, impact, riser, click) are a mix
 * vocabulary -- they mark edits. These are a story vocabulary: things that
 * happen in the narration. A cannon fires, a bugle sounds, a joke lands and
 * the rimshot follows. The director picks from this list by name, so the
 * list is closed: a sound the library does not have cannot be asked for.
 *
 * Built by `pnpm cli assets` into assets/sfx/library, with a manifest that
 * records where every file came from and under what licence. Nothing here is
 * fetched at render time.
 */

export const SOUND_KINDS = [
  // war
  'explosion', 'cannon', 'gunshot', 'machine-gun', 'bomb-whistle', 'ricochet',
  'siren', 'bugle', 'taps', 'march', 'drumroll', 'horses', 'swords', 'sword-draw',
  'plane', 'applause', 'cheer',
  // comedy
  'rimshot', 'sad-trombone', 'dun-dun', 'airhorn', 'record-scratch', 'boing', 'pop',
  'bonk', 'punch', 'gong', 'ding', 'wrong', 'correct', 'bleep', 'crickets',
  'heartbeat', 'morse', 'clock', 'cash', 'whoosh', 'slide-up', 'slide-down',
] as const;

export type SoundKind = (typeof SOUND_KINDS)[number];

export const isSoundKind = (value: unknown): value is SoundKind =>
  typeof value === 'string' && (SOUND_KINDS as readonly string[]).includes(value);

/**
 * What each one is for, in the words the director is shown. The list is the
 * whole of what the model knows about the library, so each entry says when to
 * use the sound, not what it is made of.
 */
export const SOUND_USE: Record<SoundKind, string> = {
  explosion: 'a big blast: shells landing, a bomb going off, something blowing up',
  cannon: 'artillery or a ship\'s gun firing, an old-fashioned cannon',
  gunshot: 'a single shot from a rifle or pistol',
  'machine-gun': 'automatic fire, a burst of machine-gun fire',
  'bomb-whistle': 'a bomb or shell falling, the whistle before the hit',
  ricochet: 'a bullet pinging off something, a near miss',
  siren: 'an air-raid warning, alarm, panic',
  bugle: 'a military bugle call: an army assembling, a charge, reveille',
  taps: 'a mournful bugle: a death, a defeat, a funeral (use rarely)',
  march: 'soldiers marching, a drum cadence, an army on the move',
  drumroll: 'suspense before a reveal, "and the winner is"',
  horses: 'cavalry, horses galloping, a charge on horseback',
  swords: 'blades clashing, melee fighting, a duel',
  'sword-draw': 'a sword being drawn, getting ready to fight',
  plane: 'an aircraft flying over, a bomber, a fighter',
  applause: 'people clapping, approval, a ceremony',
  cheer: 'a crowd cheering, victory, hurray',
  rimshot: 'ba-dum-tss: after a joke or a pun lands',
  'sad-trombone': 'wah-wah-waah: a failure, a plan going wrong, a humiliating loss',
  'dun-dun': 'dun dun DUNNN: a dramatic, ominous reveal, played for comedy',
  airhorn: 'meme air horn: an absurd triumph or a ridiculous boast',
  'record-scratch': 'the record stops: "wait, what?" -- a sudden reversal or an absurd detail',
  boing: 'a cartoon spring: something bouncing, a silly failure',
  pop: 'a small pop: something appearing, an idea, an icon arriving',
  bonk: 'a cartoon hit on the head, a clumsy blunder',
  punch: 'a punch, a hard hit, a brawl',
  gong: 'a gong: an announcement, the end of an era, an Asian empire\'s court',
  ding: 'a ding: an idea, a lightbulb moment, the right answer',
  wrong: 'an error buzzer: a wrong decision, a mistake',
  correct: 'a success chime: the plan worked',
  bleep: 'a censor bleep: something unprintable was said',
  crickets: 'awkward silence, nobody came, nothing happened',
  heartbeat: 'tension, fear, waiting for something terrible',
  morse: 'telegraph or radio: a message, a codebreaker, orders coming in',
  clock: 'a clock ticking: a deadline, time running out',
  cash: 'money: a war budget, a bribe, a costly mistake',
  whoosh: 'fast movement, a swipe, a quick transition',
  'slide-up': 'a slide whistle going up: something rising, a rapid promotion',
  'slide-down': 'a slide whistle going down: something falling, a morale collapse',
};

/**
 * How loud each kind sits in the mix, in dB relative to its normalised file,
 * before the mix's own duck under the narration. Weapons are loud because
 * they are the scene; comedy stingers are loud because they are the joke and
 * a joke under the voice is not a joke; beds and textures sit well down.
 */
export const SOUND_GAIN_DB: Record<SoundKind, number> = {
  explosion: 4, cannon: 3, gunshot: 1, 'machine-gun': 0, 'bomb-whistle': -1, ricochet: -2,
  siren: -8, bugle: -4, taps: -6, march: -5, drumroll: -3, horses: -4, swords: -1, 'sword-draw': -1,
  plane: -3, applause: -6, cheer: -4,
  rimshot: 0, 'sad-trombone': -1, 'dun-dun': 0, airhorn: -4, 'record-scratch': 0, boing: -2,
  pop: -4, bonk: -1, punch: 0, gong: -3, ding: -4, wrong: -3, correct: -4, bleep: -2,
  crickets: -8, heartbeat: -4, morse: -8, clock: -8, cash: -3, whoosh: -4,
  'slide-up': -3, 'slide-down': -3,
};

/**
 * How loud each kind sits against the narration, in dB, measured the same way
 * for both (envelope.ts): 0 would be as loud as the voice while it speaks.
 *
 * Everything is under the voice. The first mix put weapons level with it on
 * the theory that an explosion quieter than the word "boom" is backwards; on
 * a phone speaker it was just loud, and a video that makes you reach for the
 * volume is one you scroll past. The joke still lands a few dB down. Textures
 * -- crickets, a clock, morse -- are a bed, not an event, and sit well under.
 */
export const SOUND_LEVEL_DB: Record<SoundKind, number> = {
  explosion: -8, cannon: -8, gunshot: -8, 'machine-gun': -9, 'bomb-whistle': -11, ricochet: -12,
  siren: -17, bugle: -11, taps: -13, march: -15, drumroll: -12, horses: -13, swords: -10, 'sword-draw': -11,
  plane: -12, applause: -14, cheer: -13,
  rimshot: -8, 'sad-trombone': -9, 'dun-dun': -8, airhorn: -11, 'record-scratch': -7, boing: -10,
  pop: -13, bonk: -9, punch: -8, gong: -11, ding: -13, wrong: -11, correct: -13, bleep: -7,
  crickets: -17, heartbeat: -13, morse: -17, clock: -17, cash: -11, whoosh: -13,
  'slide-up': -11, 'slide-down': -11,
};

/** More off a sound that lands while the voice is still talking: never step on a word. */
export const OVER_SPEECH_DB = -4;

/**
 * Where a sound goes relative to the word it was put on.
 *
 *   on      starts with the word: the gunshot on "fired", the bonk on "hit"
 *   after   follows the phrase the word ends: a sting is the reaction to a
 *           line, and a rimshot that starts on the first syllable of the
 *           punchline plays over it -- which is exactly the "slightly off" a
 *           viewer hears without being able to say why
 *   end-on  finishes as the word begins: the whistle that ends in the blast,
 *           the drumroll that ends on the reveal
 *   centre  its middle on the word: the plane passes overhead as it is said
 */
export type SoundTiming = 'on' | 'after' | 'end-on' | 'centre';

export const SOUND_TIMING: Record<SoundKind, SoundTiming> = {
  explosion: 'on', cannon: 'on', gunshot: 'on', 'machine-gun': 'on', 'bomb-whistle': 'end-on', ricochet: 'on',
  siren: 'on', bugle: 'on', taps: 'after', march: 'on', drumroll: 'end-on', horses: 'on', swords: 'on',
  'sword-draw': 'on', plane: 'centre', applause: 'after', cheer: 'after',
  rimshot: 'after', 'sad-trombone': 'after', 'dun-dun': 'after', airhorn: 'after', 'record-scratch': 'on',
  boing: 'on', pop: 'on', bonk: 'on', punch: 'on', gong: 'after', ding: 'on', wrong: 'after', correct: 'after',
  bleep: 'on', crickets: 'after', heartbeat: 'on', morse: 'on', clock: 'on', cash: 'on', whoosh: 'centre',
  'slide-up': 'on', 'slide-down': 'on',
};

/** How long after a phrase ends an "after" sound comes in: a beat, not a gap. */
export const AFTER_PHRASE_MS = 120;

export type Licence = 'CC0' | 'Public domain' | 'CC BY 3.0' | 'CC BY 4.0' | 'Generated';

export type SoundEntry = {
  kind: SoundKind;
  /** Under assets/sfx/library. */
  file: string;
  durationMs: number;
  title: string;
  author: string;
  licence: Licence;
  source: string;
};

export type SoundManifest = { v: 1; builtAt: string; sounds: SoundEntry[] };

export const LIBRARY_DIR = path.join(assetDirs.sfx, 'library');
const MANIFEST = path.join(LIBRARY_DIR, 'manifest.json');

let loaded: { at: number; manifest: SoundManifest } | null = null;

/** The manifest, re-read if the library was rebuilt since. */
export function soundLibrary(): SoundManifest {
  try {
    const at = fs.statSync(MANIFEST).mtimeMs;
    if (loaded === null || loaded.at !== at) {
      loaded = { at, manifest: JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as SoundManifest };
    }
    return loaded.manifest;
  } catch {
    return { v: 1, builtAt: '', sounds: [] };
  }
}

export function soundsOf(kind: SoundKind): SoundEntry[] {
  return soundLibrary().sounds.filter((sound) => sound.kind === kind);
}

/** The kinds the library can actually play, which is what the director is offered. */
export function availableKinds(): SoundKind[] {
  const have = new Set(soundLibrary().sounds.map((sound) => sound.kind));
  return SOUND_KINDS.filter((kind) => have.has(kind));
}

/**
 * One file for a cue, chosen by seed so a re-render hears the same take, and
 * rotated by occurrence so the fourth explosion is not the first one again.
 */
export function pickSound(kind: SoundKind, seed: number, occurrence: number): SoundEntry | null {
  const takes = soundsOf(kind);
  if (takes.length === 0) return null;
  return takes[(seed + occurrence * 7) % takes.length] ?? null;
}

export function soundPath(entry: SoundEntry): string {
  return path.join(LIBRARY_DIR, entry.file);
}

/**
 * The credit lines for the sounds a video used, for its description.
 *
 * Every licence is listed, including the ones that do not require it: CC0 and
 * public domain ask for nothing, and naming them anyway costs a line and
 * answers the question "where is that sound from" before anybody asks it.
 */
export function soundCredits(used: readonly SoundEntry[]): string {
  const seen = new Map<string, SoundEntry>();
  for (const entry of used) {
    if (entry.licence === 'Generated') continue;
    seen.set(`${entry.title}|${entry.author}`, entry);
  }
  if (seen.size === 0) return '';

  /**
   * Read by viewers, so it reads like credits rather than a manifest.
   *
   * CC BY asks for title, author, licence and a link, per work, and gets
   * exactly that, one line each. CC0 and public domain ask for nothing, so
   * they are thanked in one line by who made them and where -- a dozen lines
   * of "plop_02.ogg -- CC0" buried the credits that are actually owed.
   */
  const title = (entry: SoundEntry): string =>
    entry.title.replace(/\.(wav|ogg|mp3|flac)$/i, '').replace(/^Kevin MacLeod assorted rimshots - /, '');
  const author = (entry: SoundEntry): string => entry.author.replace(/(Unknown author)+/i, '').trim();
  const host = (entry: SoundEntry): string => {
    try {
      return new URL(entry.source).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };

  const owed = [...seen.values()].filter((entry) => entry.licence.startsWith('CC BY'));
  const free = [...seen.values()].filter((entry) => !entry.licence.startsWith('CC BY'));
  const lines = owed.map(
    (entry) => `"${title(entry)}" by ${author(entry) || 'unknown'} (${entry.licence}) ${entry.source}`,
  );
  if (free.length > 0) {
    // Grouped by where they came from, named the way people know the site.
    const SITES: Record<string, string> = { 'commons.wikimedia.org': 'Wikimedia Commons', 'kenney.nl': 'Kenney.nl', 'opengameart.org': 'OpenGameArt' };
    const bySite = new Map<string, Set<string>>();
    for (const entry of free) {
      const site = SITES[host(entry)] ?? host(entry);
      const who = bySite.get(site) ?? new Set<string>();
      const name = author(entry);
      if (name !== '' && name !== site.replace('.nl', '')) who.add(name);
      bySite.set(site, who);
    }
    const parts = [...bySite.entries()].map(([site, who]) => (who.size === 0 ? site : `${site} (${[...who].join(', ')})`));
    lines.push(`Public domain and CC0 sounds from ${parts.join('; ')}`);
  }
  return ['Sound effects', ...lines].join('\n');
}
