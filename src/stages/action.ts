import { MODELS, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import { ACTION_NAMES } from '../remotion/stickman/rig.js';
import {
  COMPANIONS, CREATURES, CREATURE_COUNTS, CREATURE_ROLES, EXPRESSIONS, GAGS, OUTFITS, PROPS, SCENES, SIDES, WEATHERS,
} from '../remotion/stickman/vocab.js';
import { ICON_NAMES } from '../remotion/war/icons.js';
import { SOUND_USE, availableKinds, type SoundKind } from '../assets/library.js';
import { cleanWarDirection, type WarDirection } from './warmap.js';

/**
 * Which channel is being directed. The books channel stages a story; the war
 * channel stages military history told for laughs, which adds uniforms,
 * armies, maps, sound effects on the word and editing jokes -- none of which
 * belong in an essay about Kafka.
 */
export type Genre = 'books' | 'war';

/**
 * How each beat of a stick figure video is staged: what the figure does,
 * where, with what face, holding what, with whom, in what weather.
 *
 * Closed vocabularies rather than free text, and that is the whole design.
 * The world can draw exactly these places, faces and props; asking a model to
 * describe them in its own words would produce "a misty harbour at dawn",
 * which nothing here can draw. Choosing from lists it can see is a question
 * the model answers reliably, and every answer is guaranteed renderable.
 */

const CHOICE_VERSION = 4;

export type Staging = {
  action: string;
  scene: string;
  expression: string;
  prop: string;
  companion: string;
  companionExpression: string;
  weather: string;
  /** Animals in the beat, drawn in the figure's style: which, how many, doing what. */
  creature: string;
  creatureCount: string;
  creatureRole: string;
  /**
   * The place in words, specific to the story, for a painted background:
   * "a gaslit cobblestone street in 1890s London at night". Repeated word for
   * word while the story stays there, so one background covers the stretch.
   */
  setting: string;
  /** Only on the war channel. */
  war?: WarDirection;
};

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    beats: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTION_NAMES },
          setting: { type: 'string' },
          scene: { type: 'string', enum: [...SCENES] },
          expression: { type: 'string', enum: [...EXPRESSIONS] },
          prop: { type: 'string', enum: [...PROPS] },
          companion: { type: 'string', enum: [...COMPANIONS] },
          companionExpression: { type: 'string', enum: [...EXPRESSIONS] },
          weather: { type: 'string', enum: [...WEATHERS] },
          creature: { type: 'string', enum: [...CREATURES] },
          creatureCount: { type: 'string', enum: [...CREATURE_COUNTS] },
          creatureRole: { type: 'string', enum: [...CREATURE_ROLES] },
        },
        required: [
          'setting', 'action', 'scene', 'expression', 'prop', 'companion', 'companionExpression', 'weather',
          'creature', 'creatureCount', 'creatureRole',
        ],
        propertyOrdering: [
          'setting', 'scene', 'weather', 'action', 'expression', 'prop', 'companion', 'companionExpression',
          'creature', 'creatureCount', 'creatureRole',
        ],
      },
    },
  },
  required: ['beats'],
};

/**
 * The war beat's schema.
 *
 * Icons are plain strings, not an enum: Gemini refuses a schema whose enum
 * runs to the hundred-odd icon names ("invalid argument", nothing more), and
 * the whole staging fell back to matching words. The names are in the prompt
 * instead, and every one that comes back is checked against the set.
 */
function warSchema(sounds: readonly SoundKind[]): Record<string, unknown> {
  const beat = (RESPONSE_SCHEMA['properties'] as Record<string, { items: Record<string, unknown> }>)['beats']!.items;
  const properties = beat['properties'] as Record<string, unknown>;
  const place = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      lat: { type: 'number' },
      lon: { type: 'number' },
      icon: { type: 'string' },
    },
    required: ['name', 'lat', 'lon', 'icon'],
  };
  return {
    type: 'object',
    properties: {
      beats: {
        type: 'array',
        items: {
          ...beat,
          properties: {
            beat: { type: 'integer' },
            ...properties,
            outfit: { type: 'string', enum: [...OUTFITS] },
            rivalOutfit: { type: 'string', enum: [...OUTFITS] },
            sounds: {
              type: 'array',
              items: {
                type: 'object',
                properties: { sound: { type: 'string', enum: [...sounds] }, word: { type: 'string' } },
                required: ['sound', 'word'],
              },
            },
            gag: { type: 'string', enum: [...GAGS] },
            gagWord: { type: 'string' },
            sticker: {
              type: 'object',
              properties: { icon: { type: 'string' }, text: { type: 'string' } },
              required: ['icon', 'text'],
            },
            map: {
              type: 'object',
              properties: {
                show: { type: 'boolean' },
                title: { type: 'string' },
                places: { type: 'array', items: place },
                arrows: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      from: { type: 'string' },
                      to: { type: 'string' },
                      side: { type: 'string', enum: [...SIDES] },
                      icon: { type: 'string' },
                    },
                    required: ['from', 'to', 'side', 'icon'],
                  },
                },
                highlight: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { country: { type: 'string' }, side: { type: 'string', enum: [...SIDES] } },
                    required: ['country', 'side'],
                  },
                },
              },
              // All of it, every time -- empty lists when there is no map. With
              // only "show" required the model sent six maps that were titles
              // and nothing else, and every one was rightly thrown away.
              required: ['show', 'title', 'places', 'arrows', 'highlight'],
              propertyOrdering: ['show', 'title', 'places', 'arrows', 'highlight'],
            },
          },
          required: ['beat', ...(beat['required'] as string[]), 'outfit', 'rivalOutfit', 'sounds', 'gag', 'gagWord', 'sticker', 'map'],
          propertyOrdering: [
            'beat',
            ...(beat['propertyOrdering'] as string[]),
            'outfit', 'rivalOutfit', 'sounds', 'gag', 'gagWord', 'sticker', 'map',
          ],
        },
      },
    },
    required: ['beats'],
  };
}

/**
 * What the war channel asks of the director on top of the staging: how a
 * comedic animated history video is actually cut. The proportions are the
 * point -- a gag every beat is not comedy, it is noise.
 */
function warBrief(sounds: readonly SoundKind[]): string {
  return `
"beat" -- the number of the beat this entry stages, exactly as listed above. One entry per beat,
  every beat, in order; never two entries for one beat.

THIS IS A MILITARY HISTORY CHANNEL, told for laughs: witty, deadpan and meme-literate, but
historically accurate. The hero (red scarf) is the narrator's avatar and plays whoever the
narration is about -- a general, a private, a king, a whole country -- and the "rival" is the other
side. Direct it like a comedic animated history video: every beat either shows what happened or
lands a joke, and the edit is part of the joke.

Paint the settings in their real era: the actual terrain, fortifications, ships, trenches, palaces
and weather of that war.

"outfit" -- the hero's headgear, the uniform of whoever it plays in THIS beat: ${OUTFITS.join(', ')}.
  helmet = WW1/WW2 soldier; pickelhaube = Imperial Germany; kepi = French army, US Civil War;
  bicorne = Napoleonic officer; tricorne = 18th century; officer-cap = a general or an officer;
  beret = paratroopers, commandos, modern; crown = a king or emperor; spartan, roman, viking,
  samurai, knight = those eras; none = a civilian or a modern politician.
"rivalOutfit" -- the same, for the rival and the enemy ranks.

"companion" may also be "army" (the hero's troops in ranks behind it), "enemy-army" (the other side
  across the field) or "armies" (both: a battle). Use them for battles, marches and invasions.

"prop" may also be ${['rifle', 'musket', 'pistol', 'grenade', 'binoculars', 'shovel', 'radio', 'shield', 'spear', 'axe', 'white-flag', 'map', 'medal'].join(', ')}.
  "white-flag" for a surrender, "binoculars" for scouting, "map" for planning, "medal" for glory.

"sounds" -- zero to two sound effects for this beat, each with the "word" it lands on, copied
  exactly from THIS beat's text. The sounds:
${sounds.map((kind) => `  ${kind}: ${SOUND_USE[kind]}`).join('\n')}
  The "word" is the one the sound belongs ON, not the first word of the sentence: "fire" in "open
  fire", "jams" in "gun jams after twelve", the last word of the punchline for a rimshot. It must
  appear in this beat's text exactly as written there; a word that is not in the narration gets no
  sound at all.
  Use them for what happens (a shot, an explosion, a charge, a plane) and for comic timing
  (rimshot after a punchline, record-scratch on a reversal, sad-trombone on a failure, crickets
  when nothing happened). About half the beats have one. Never the same comedy sting twice in a
  row; no more than a few stings a minute. "taps" and "siren" rarely.

"gag" -- ${GAGS.join(', ')}, with "gagWord" (copied from this beat's text). zoom = a punchline or a
  realisation; freeze = the "yep, that's me -- you might be wondering how I got here" moment,
  usually with a record-scratch on the same word; shake = an explosion or a shock. At most one
  beat in four; "none" otherwise, with gagWord "".

"sticker" -- a meme reaction slapped on screen: an "icon" and 1 to 3 words of "text" in the
  internet's voice ("emotional damage", "big brain", "task failed successfully", "not stonks",
  "he's cooked"). At most one beat in five, and never when the beat is about death or suffering
  itself -- joke about the blunders, the egos and the absurdity, never the victims. Otherwise
  icon "none", text "".
  Icons: ${ICON_NAMES.join(', ')}.

"map" -- when the beat is about WHERE (a campaign, a front, an invasion, a route, where a battle
  was, how big an empire got), make it a map beat:
  {"show": true, "title": "Place, year", "places": [{"name", "lat", "lon", "icon"}],
   "arrows": [{"from", "to", "side", "icon"}], "highlight": [{"country", "side"}]}
  -- real coordinates in decimal degrees, 1 to 6 places, arrows only between places you listed
  (armies, fleets, retreats; "icon" rides the arrow: tank, cavalry, galleon, bomber...), countries
  by their MODERN name (for the USSR say Russia, for Prussia say Germany), sides "red" and "blue"
  consistent for the whole video. About one beat in six is a map, the first within the first four
  beats; never two maps in a row. Otherwise {"show": false}.`;
}

/** The comedy stings: sounds that are the joke rather than the scene. */
const STINGS = new Set<SoundKind>([
  'rimshot', 'sad-trombone', 'dun-dun', 'airhorn', 'record-scratch', 'boing', 'crickets',
  'bleep', 'slide-up', 'slide-down', 'gong', 'wrong', 'correct', 'ding',
]);

/** Beats per request on the war channel. */
const WAR_BATCH = 14;

/**
 * The war channel's staging, a batch at a time.
 *
 * One request for a whole video asks a small model for sixty beats that each
 * carry a setting, a map, sounds, a gag and a sticker -- and it does not end
 * well: measured, it wrote 257,000 characters, ran into the output limit
 * mid-string and returned JSON nobody could read, and the whole video fell
 * back to matching words. A batch of fourteen is a request it finishes.
 *
 * Every batch sees the whole narration, so the jokes are placed knowing where
 * the story goes. What batches cannot see is each other, so the two things
 * that must carry across are passed along: the place the last beat was in (so
 * a setting is repeated word for word and keeps its painting), and which side
 * is red and which is blue on the maps.
 *
 * A batch that fails twice is staged plainly and the rest carry on: one bad
 * batch costs fourteen beats their jokes, not the video its direction.
 */
async function stageInBatches(
  options: { topic: string; script: string; beatTexts: readonly string[]; seed: number },
  sounds: readonly SoundKind[],
): Promise<Partial<Staging>[]> {
  const all: Partial<Staging>[] = [];
  let lastSetting = '';
  const sides = new Map<string, string>();

  for (let from = 0; from < options.beatTexts.length; from += WAR_BATCH) {
    const slice = options.beatTexts.slice(from, from + WAR_BATCH);
    const context = [
      from === 0
        ? ''
        : `These are beats ${from + 1} to ${from + slice.length} of ${options.beatTexts.length}; the ones before are ` +
          'already staged. The first-map rule is about the start of the video, which is behind you.',
      lastSetting === '' ? '' : `The beat just before these was set in: "${lastSetting}". Repeat it word for word while the story stays there.`,
      sides.size === 0 ? '' : `Map colours already used: ${[...sides.entries()].map(([c, side]) => `${c} is ${side}`).join(', ')}. Keep them.`,
    ].filter(Boolean);

    let beats: Partial<Staging>[] | null = null;
    for (let attempt = 0; attempt < 2 && beats === null; attempt++) {
      try {
        const { value } = await cache.json<{ beats: Partial<Staging>[] }>(
          'stickman-staging',
          {
            v: CHOICE_VERSION,
            model: MODELS.llm.script,
            topic: options.topic,
            script: options.script,
            seed: options.seed + attempt * 7919,
            beats: slice,
            from,
            context,
            genre: 'war',
            war: 4,
            sounds: sounds.join(','),
            icons: ICON_NAMES.length,
          },
          async () => {
            const response = await generate({
              model: MODELS.llm.script,
              systemInstruction:
                'You direct a 2D stick-figure animation: where each beat happens and how the ' +
                'character acts and feels. You return JSON and nothing else.',
              prompt: `${buildRequest(options.topic, options.script, slice, 'war', sounds)}\n\n${context.join('\n')}`,
              temperature: 0.65,
              seed: toInt32Seed(options.seed + attempt * 7919),
              maxOutputTokens: 16000,
              responseSchema: warSchema(sounds),
            });
            return JSON.parse(response.text) as { beats: Partial<Staging>[] };
          },
        );
        beats = Array.isArray(value.beats) ? value.beats : null;
      } catch (error) {
        log.warn(`stickman: beats ${from + 1}-${from + slice.length} (${(error as Error).message.slice(0, 80)})${attempt === 0 ? '; trying again' : '; staged plainly'}`);
      }
    }

    /**
     * Matched by number, not by position. A batch of fourteen once came back
     * with twenty-nine entries; taken in order, every beat after the first
     * extra one was staged with the next beat's action and joke, and a minute
     * and a half of the video acted out the wrong sentences. Each entry says
     * which beat it is for; one without a number that fits is not trusted.
     */
    const byNumber = new Map<number, Partial<Staging>>();
    for (const entry of beats ?? []) {
      const n = Number((entry as { beat?: unknown }).beat);
      if (Number.isInteger(n) && n >= 1 && n <= slice.length && !byNumber.has(n)) byNumber.set(n, entry);
    }
    // A batch that numbered nothing but has exactly one entry per beat is in order.
    const ordered = byNumber.size === 0 && (beats?.length ?? 0) === slice.length;
    if (!ordered && beats !== null && byNumber.size < slice.length) {
      log.warn(`stickman: beats ${from + 1}-${from + slice.length}: ${beats.length} entries, ${byNumber.size} matched by number; the rest staged plainly`);
    }
    for (let i = 0; i < slice.length; i++) all.push((ordered ? beats?.[i] : byNumber.get(i + 1)) ?? {});
    const last = beats?.[slice.length - 1];
    if (typeof last?.setting === 'string' && last.setting.trim() !== '') lastSetting = last.setting.trim();
    for (const beat of beats ?? []) {
      const map = (beat as { map?: { highlight?: { country?: unknown; side?: unknown }[] } }).map;
      for (const item of map?.highlight ?? []) {
        if (typeof item.country === 'string' && typeof item.side === 'string' && !sides.has(item.country)) {
          sides.set(item.country, item.side);
        }
      }
    }
  }
  log.info(`stickman: staged ${options.beatTexts.length} war beats in ${Math.ceil(options.beatTexts.length / WAR_BATCH)} batch(es)`);
  return all;
}

/**
 * The fallback when there is no key. Crude by design — it matches on words the
 * beat happens to contain, which is exactly the failure mode the model exists
 * to avoid, but a figure doing roughly the right thing beats one standing still
 * for twenty beats.
 */
const KEYWORDS: readonly (readonly [RegExp, string])[] = [
  [/\b(run|ran|race|rush|chase|flee|escap)/i, 'run'],
  [/\b(walk|walked|step|journey|travel|wander|path)/i, 'walk'],
  [/\b(fall|fell|collaps|drop|crash|sank|sink)/i, 'fall'],
  [/\b(jump|leap|spring|launch|soar)/i, 'jump'],
  [/\b(think|thought|wonder|imagine|question|why|puzzl|mystery)/i, 'think'],
  [/\b(look|search|find|found|discover|explor|seek)/i, 'search'],
  [/\b(read|book|page|wrote|writ|novel|story)/i, 'read'],
  [/\b(point|show|reveal|here|there|this)/i, 'point'],
  [/\b(reach|grab|touch|stretch|grasp)/i, 'reach'],
  [/\b(push|force|press|strain|struggl|heav)/i, 'push'],
  [/\b(carry|hold|lift|burden|weight)/i, 'carry'],
  [/\b(afraid|fear|terr|horror|scar)/i, 'cower'],
  [/\b(win|won|celebrat|succeed|triumph|finally|amazing)/i, 'celebrate'],
  [/\b(sit|sat|rest|wait|still|quiet)/i, 'sit'],
  [/\b(no one|nobody|unknown|never|shrug|unclear)/i, 'shrug'],
];

function guess(line: string): string {
  for (const [pattern, name] of KEYWORDS) {
    if (pattern.test(line)) return name;
  }
  return 'stand';
}

const plainStaging = (line: string): Staging => ({
  action: guess(line),
  scene: 'city',
  expression: 'neutral',
  prop: 'none',
  companion: 'none',
  companionExpression: 'neutral',
  weather: 'clear',
  creature: 'none',
  creatureCount: 'one',
  creatureRole: 'wild',
  setting: '',
});

function buildRequest(topic: string, script: string, beats: readonly string[], genre: Genre = 'books', sounds: readonly SoundKind[] = []): string {
  const listed = beats.map((text, i) => `${i + 1}. ${text}`).join('\n');
  const fence = '"'.repeat(3);

  return `A 2D animated short about "${topic}" is acted out by a stick figure with a round, expressive
face (the hero, who wears a red scarf) in a drawn world. Stage every beat.

Here is the whole narration:
${fence}
${script}
${fence}

The ${beats.length} beats, in order:
${listed}

For each beat write:

"setting" -- the exact place this beat happens, in 8 to 16 words, specific to THIS story: its era,
  country, building or landscape, time of day. "the cramped attic bedroom of a Prague apartment,
  1912, grey morning light" -- not "a room". Only the place: never people, crowds, signs, posters,
  screens or anything with writing on it, because it will be painted and they come out as
  gibberish. While the
  story stays in one place, repeat the setting WORD FOR WORD; write a new one only when the story
  moves to another place or time.

and choose, only from these lists:

"scene" -- where it happens: ${SCENES.join(', ')}.
  Pick the place the story is in: a story set in an old castle is "castle", one about writing or
  a book is "library" or "room", science is "lab", a journey is "forest", "desert" or "mountains",
  a city life is "city" or "night_city", the cosmos is "space", a big dramatic reveal can be
  "stage". Keep the SAME scene for 2 to 5 beats in a row and change it only when the story moves
  to another place or time; a new place every beat is dizzying.

"weather": ${WEATHERS.join(', ')}. Mostly "clear". "rain" or "storm" for grief, danger or
  despair; "snow" for cold and loneliness; "fog" for mystery; "embers" for war, fire, rage;
  "leaves" for change and time passing. Weather that fits the scene: no snow in "space".

"action" -- what the hero does: ${ACTION_NAMES.join(', ')}.
  Act the idea of the beat, not a word in it. Vary it: no action for two beats in a row, none
  more than three times in the video. "stand" only when nothing else fits. The first beat is the
  hook and should move.

"expression" -- the hero's face: ${EXPRESSIONS.join(', ')}.
  The feeling of THIS beat, as a viewer should feel it. Faces are what make it lively: use the
  whole range, and strong ones (shocked, crying, angry, laughing, scared) where the narration is
  strong.

"prop" -- what the hero holds: ${PROPS.join(', ')}. "none" unless it helps tell the beat: a
  "book" for reading or writing, "sword" for battle, "torch" or "lantern" in the dark, "moneybag"
  for wealth, "phone" for modern life, "scroll" for old documents, "umbrella" in rain.

"companion" -- who else is there: ${COMPANIONS.join(', ')}. "friend" or "rival" when the beat is
  about another person (a lover, a parent, an enemy, a teacher); "crowd" for society, people,
  an audience; otherwise "none". About a third of the beats should have someone.
"companionExpression" -- their face, from the same expression list ("neutral" if none).

"creature" -- an animal in the beat, drawn in the same style as the hero: ${CREATURES.join(', ')}.
  Use it whenever the story is about an animal or an animal is part of what happened: the emus of
  the Great Emu War, Hannibal's elephants, a carrier pigeon, a war dog, cavalry horses, a camel
  corps, a mascot bear, the pig that started a war, rats in the trenches. When animals ARE the
  story, they belong in most of its beats -- a video about the Emu War with no emus in it has
  failed. Otherwise "none".
"creatureCount" -- ${CREATURE_COUNTS.join(', ')}. "herd" for a flock or a whole army of them.
"creatureRole" -- what they are doing: enemy (charging in and squaring up to the hero -- when an
  animal is the opponent, use this instead of an enemy army), ally (at the hero's side), wild
  (wandering and grazing in the background), fleeing (running away: scattered, routed, escaping).
  Change it as the story changes: the emus charge, then scatter when the guns fire, then graze
  smugly while the soldiers give up.

${genre === 'war' ? warBrief(sounds) : ''}

Exactly ${beats.length} entries, in order. Return only the JSON object.`;
}

/** One staging per beat, always renderable. */
export async function directStickman(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
  genre?: Genre;
}): Promise<Staging[]> {
  const plain = options.beatTexts.map(plainStaging);
  const genre = options.genre ?? 'books';
  const sounds = genre === 'war' ? availableKinds() : [];

  if (env.GEMINI_API_KEY === undefined) {
    log.info('stickman: no key for staging; matching on the beat words');
    return plain;
  }

  try {
    const { value } =
      genre === 'war'
        ? { value: { beats: await stageInBatches(options, sounds) } }
        : await cache.json<{ beats: Partial<Staging>[] }>(
      'stickman-staging',
      {
        v: CHOICE_VERSION,
        model: MODELS.llm.script,
        topic: options.topic,
        script: options.script,
        seed: options.seed,
        count: options.beatTexts.length,
        vocabulary: [ACTION_NAMES, SCENES, EXPRESSIONS, PROPS, WEATHERS].map((list) => list.join(',')).join('|'),
      },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction:
            'You direct a 2D stick-figure animation: where each beat happens and how the ' +
            'character acts and feels. You return JSON and nothing else.',
          prompt: buildRequest(options.topic, options.script, options.beatTexts),
          temperature: 0.6,
          seed: toInt32Seed(options.seed),
          // A long video is sixty beats or more, each with a setting in words.
          maxOutputTokens: 20000,
          responseSchema: RESPONSE_SCHEMA,
        });
        return JSON.parse(response.text) as { beats: Partial<Staging>[] };
      },
    );

    // The enums in the schema are a request, not a guarantee, so each is checked.
    const pick = <T extends string>(list: readonly T[], wanted: unknown, fallback: T): T =>
      typeof wanted === 'string' && (list as readonly string[]).includes(wanted.trim().toLowerCase())
        ? (wanted.trim().toLowerCase() as T)
        : fallback;
    const staged = options.beatTexts.map((_, index): Staging => {
      const chosen = value.beats?.[index] ?? {};
      const fallback = plain[index]!;
      return {
        action: pick(ACTION_NAMES, chosen.action, fallback.action),
        scene: pick(SCENES, chosen.scene, (index > 0 ? undefined : 'city') ?? 'city'),
        expression: pick(EXPRESSIONS, chosen.expression, 'neutral'),
        prop: pick(PROPS, chosen.prop, 'none'),
        companion: pick(COMPANIONS, chosen.companion, 'none'),
        companionExpression: pick(EXPRESSIONS, chosen.companionExpression, 'neutral'),
        weather: pick(WEATHERS, chosen.weather, 'clear'),
        creature: pick(CREATURES, chosen.creature, 'none'),
        creatureCount: pick(CREATURE_COUNTS, chosen.creatureCount, 'one'),
        creatureRole: pick(CREATURE_ROLES, chosen.creatureRole, 'wild'),
        setting: typeof chosen.setting === 'string' ? chosen.setting.trim().slice(0, 200) : '',
        ...(genre === 'war' ? { war: cleanWarDirection(chosen, sounds) } : {}),
      };
    });

    /**
     * The proportions, enforced rather than hoped for. The model is told a
     * gag at most every fourth beat and a map never twice running, and mostly
     * does as it is told; these make "mostly" into "always".
     */
    if (genre === 'war') {
      let lastGag = -99;
      let lastSticker = -99;
      for (let i = 0; i < staged.length; i++) {
        const war = staged[i]!.war!;
        if (war.gag !== 'none') {
          if (i - lastGag < 3) war.gag = 'none';
          else lastGag = i;
        }
        if (war.sticker !== null) {
          if (i - lastSticker < 4) war.sticker = null;
          else lastSticker = i;
        }
        if (war.map !== null && i > 0 && staged[i - 1]!.war!.map !== null) war.map = null;
      }

      /**
       * Sound, thinned. Asked for on about half the beats, the first long run
       * came back with sound on 41 of 47 -- which is not timing, it is a
       * soundboard. A comedy sting needs room around it to be a joke, so there
       * are three beats between them; and the same effect on two beats running
       * is one effect heard twice.
       */
      let lastSting = -99;
      for (let i = 0; i < staged.length; i++) {
        const war = staged[i]!.war!;
        const previous = new Set(i > 0 ? staged[i - 1]!.war!.sounds.map((sound) => sound.kind) : []);
        let stung = false;
        war.sounds = war.sounds.filter((sound) => {
          if (STINGS.has(sound.kind)) {
            if (stung || i - lastSting < 3) return false;
            stung = true;
            lastSting = i;
            return true;
          }
          return !previous.has(sound.kind);
        });
      }
    }
    // A beat whose scene was unreadable stays where the last one was.
    for (let i = 1; i < staged.length; i++) {
      if (!(SCENES as readonly string[]).includes(String(value.beats?.[i]?.scene ?? ''))) {
        staged[i]!.scene = staged[i - 1]!.scene;
      }
    }

    if (genre === 'war') {
      const count = (test: (w: WarDirection) => boolean): number => staged.filter((stage) => stage.war !== undefined && test(stage.war)).length;
      log.info(
        `stickman: war -- ${count((w) => w.map !== null)} map(s), ${count((w) => w.sounds.length > 0)} beat(s) with sound, ` +
          `${count((w) => w.gag !== 'none')} gag(s), ${count((w) => w.sticker !== null)} sticker(s)`,
      );
    }
    const places = new Set(staged.map((stage) => stage.scene));
    const faces = new Set(staged.map((stage) => stage.expression));
    log.info(
      `stickman: ${new Set(staged.map((s) => s.action)).size} actions, ${faces.size} expressions, ` +
        `${places.size} places (${[...places].join(', ')}) across ${staged.length} beats`,
    );
    return staged;
  } catch (error) {
    log.warn(`stickman: staging failed (${(error as Error).message}); matching on words`);
    return plain;
  }
}
