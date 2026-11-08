/**
 * Who reads the short.
 *
 * The engine ships far more voices than are worth offering — the roster runs
 * from convincing to obviously synthetic — so this is a curated list rather
 * than a dump of every id. Each character pairs a voice with a pace, because
 * the two together are what makes a read sound like a person: the same voice
 * at 0.97 and at 1.14 is a storyteller and a friend talking fast.
 *
 * Honest about the limit: this is a text-to-speech model with fixed voices, so
 * a character changes timbre, accent and speed. It does not change vocabulary
 * or phrasing — that is the script's job, not the voice's.
 */

export type VoiceGender = 'female' | 'male';
export type VoiceAccent = 'american' | 'british';

export type Character = {
  id: string;
  label: string;
  /** One line, shown under the picker. */
  blurb: string;
  /** The local engine's voice id. */
  voice: string;
  /**
   * The nearest voice on the hosted engine. Matched on gender and register, not
   * by name: the two engines share no ids, and a character has to survive a
   * change of provider or the roster means something different depending on a
   * setting the reader never sees.
   */
  geminiVoice: string;
  gender: VoiceGender;
  accent: VoiceAccent;
  /** Multiplier on the house narration tempo. */
  pace: number;
  /**
   * The delivery note the hosted engine is given for this character, when the
   * house note is not what the character is for. The voice alone does not make
   * a read relaxing -- the same voice asked for "a documentary narrator" lands
   * every emphasis, which is the opposite of something to fall asleep to.
   */
  geminiStyle?: string;
};

export const CHARACTERS: readonly Character[] = [
  {
    id: 'rae',
    label: 'Rae',
    blurb: 'warm and level — the house read',
    voice: 'af_heart',
    geminiVoice: 'Kore',
    gender: 'female',
    accent: 'american',
    pace: 1,
  },
  {
    id: 'bella',
    label: 'Bella',
    blurb: 'brighter, more colour on the emphasis word',
    voice: 'af_bella',
    geminiVoice: 'Aoede',
    gender: 'female',
    accent: 'american',
    pace: 1.03,
  },
  {
    id: 'nova',
    label: 'Nova',
    blurb: 'quick and bright, reads young',
    voice: 'af_nova',
    geminiVoice: 'Leda',
    gender: 'female',
    accent: 'american',
    pace: 1.12,
  },
  {
    id: 'sky',
    label: 'Sky',
    blurb: 'light and fast — the most offhand of them',
    voice: 'af_sky',
    geminiVoice: 'Zephyr',
    gender: 'female',
    accent: 'american',
    pace: 1.15,
  },
  {
    id: 'nico',
    label: 'Nico',
    blurb: 'close and soft, almost confided',
    voice: 'af_nicole',
    geminiVoice: 'Vindemiatrix',
    gender: 'female',
    accent: 'american',
    pace: 0.97,
  },
  {
    id: 'miles',
    label: 'Miles',
    blurb: 'plain and steady, gets out of the way',
    voice: 'am_michael',
    geminiVoice: 'Charon',
    gender: 'male',
    accent: 'american',
    pace: 1,
  },
  {
    id: 'puck',
    label: 'Puck',
    blurb: 'fast and playful, reads young',
    voice: 'am_puck',
    geminiVoice: 'Puck',
    gender: 'male',
    accent: 'american',
    pace: 1.12,
  },
  {
    id: 'fenrir',
    label: 'Fenrir',
    blurb: 'deeper, more weight on every line',
    voice: 'am_fenrir',
    geminiVoice: 'Fenrir',
    gender: 'male',
    accent: 'american',
    pace: 0.98,
  },
  {
    id: 'onyx',
    label: 'Onyx',
    blurb: 'low and close, the trailer voice',
    voice: 'am_onyx',
    geminiVoice: 'Orus',
    gender: 'male',
    accent: 'american',
    pace: 0.94,
  },
  {
    id: 'eric',
    label: 'Eric',
    blurb: 'bright and direct, sounds like an explainer',
    voice: 'am_eric',
    geminiVoice: 'Iapetus',
    gender: 'male',
    accent: 'american',
    pace: 1.06,
  },
  {
    id: 'emma',
    label: 'Emma',
    blurb: 'measured and dry',
    voice: 'bf_emma',
    geminiVoice: 'Callirrhoe',
    gender: 'female',
    accent: 'british',
    pace: 0.99,
  },
  {
    id: 'lewis',
    label: 'Lewis',
    blurb: 'clipped and wry, dry British delivery',
    voice: 'bm_lewis',
    geminiVoice: 'Algieba',
    gender: 'male',
    accent: 'british',
    pace: 1.02,
  },
  {
    id: 'george',
    label: 'George',
    blurb: 'unhurried, tells it like a story',
    voice: 'bm_george',
    geminiVoice: 'Rasalgethi',
    gender: 'male',
    accent: 'british',
    pace: 0.97,
  },
  /**
   * Two made for long listening. Both slower than the house pace and both
   * given a calm delivery note rather than the documentary one, so a
   * twenty-minute essay reads as somebody telling it, not presenting it.
   */
  {
    id: 'atlas',
    label: 'Atlas',
    blurb: 'deep and slow, a late-night storyteller',
    voice: 'am_onyx',
    geminiVoice: 'Algenib',
    gender: 'male',
    accent: 'american',
    pace: 0.9,
    geminiStyle: 'Read the following aloud as a calm late-night storyteller: a deep, warm, relaxed voice, slow and unhurried, soft but clear, with natural pauses between sentences',
  },
  {
    id: 'ember',
    label: 'Ember',
    blurb: 'soft and breathy, made to fall asleep to',
    voice: 'am_michael',
    geminiVoice: 'Enceladus',
    gender: 'male',
    accent: 'american',
    pace: 0.9,
    geminiStyle: 'Read the following aloud as a calm late-night storyteller: a deep, warm, relaxed voice, slow and unhurried, soft but clear, with natural pauses between sentences',
  },
];

export const DEFAULT_CHARACTER = 'rae';

const BY_ID = new Map(CHARACTERS.map((character) => [character.id, character]));

export function isCharacter(id: string): boolean {
  return BY_ID.has(id);
}

export function characterFor(id: string | undefined): Character {
  return (id === undefined ? undefined : BY_ID.get(id)) ?? BY_ID.get(DEFAULT_CHARACTER) ?? CHARACTERS[0]!;
}

/** Used when reading an older sheet that recorded a voice but not who owned it. */
export function characterForVoice(voice: string): Character | undefined {
  return CHARACTERS.find((character) => character.voice === voice);
}

/** How the picker groups them. */
export function accentLabel(accent: VoiceAccent): string {
  return accent === 'british' ? 'British' : 'American';
}
