import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { MODELS, dirs, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import {
  ATMOSPHERES,
  GROUNDS,
  SKIES,
  paintSceneSchema,
  type Atmosphere,
  type Ground,
  type PaintScene,
  type Sky,
} from '../painted.js';

/**
 * The art director for the painted mode: a scene for every beat.
 *
 * The model chooses, the code checks. It picks a sky, a ground and the weather
 * from closed lists, and one or two subjects by name from the whole
 * game-icons.net set -- some four thousand silhouettes, which is enough to
 * paint a salt crystal, a bank, a samurai and a whale without inventing
 * anything. The full list goes into the prompt (it is short text, and a name
 * the model can see is a name it does not have to guess). Every pick is
 * checked against the set; a name that is not in it is matched to the
 * nearest one that is, or dropped.
 *
 * Continuity is the director's other job: while the story stays in a place,
 * the sky and ground stay too, and the next beat is marked "settled" so the
 * painter does not wash the same sky in again from blank paper.
 *
 * game-icons.net is CC BY 3.0 per artist (two folders without named authors
 * are left out), so each subject carries its author, and the credits are
 * written next to the video for its description.
 */

const DIRECTION_VERSION = 2;
const ZIP_URL = 'https://github.com/game-icons/icons/archive/refs/heads/master.zip';
const SKIP_FOLDERS = new Set(['badges', 'various-artists']);
const ARTISTS: Record<string, string> = {
  lorc: 'Lorc', delapouite: 'Delapouite', 'john-colburn': 'John Colburn', felbrigg: 'Felbrigg',
  'john-redman': 'John Redman', 'carl-olsen': 'Carl Olsen', sbed: 'Sbed', priorblue: 'PriorBlue',
  willdabeast: 'Willdabeast', 'viscious-speed': 'Viscious Speed', 'lord-berandas': 'Lord Berandas',
  irongamer: 'Irongamer', 'heavenly-dog': 'HeavenlyDog', lucasms: 'Lucas', faithtoken: 'Faithtoken',
  skoll: 'Skoll', andymeneely: 'Andy Meneely', cathelineau: 'Cathelineau', 'kier-heyl': 'Kier Heyl',
  aussiesim: 'Aussiesim', sparker: 'Sparker', zeromancer: 'Zeromancer', rihlsul: 'Rihlsul', quoting: 'Quoting',
  guard13007: 'Guard13007', darkzaitzev: 'DarkZaitzev', spencerdub: 'SpencerDub', generalace135: 'GeneralAce135',
  zajkonur: 'Zajkonur', catsu: 'Catsu', starseeker: 'Starseeker', 'pepijn-poolman': 'Pepijn Poolman',
  'pierre-leducq': 'Pierre Leducq', 'caro-asercion': 'Caro Asercion', seregacthtuf: 'SeregaCthtuf',
};
/** Card faces, dice and the like: true silhouettes of nothing a story is about. */
const NOT_SUBJECTS = /^(card-|dice-|perspective-dice|rolling-dice|inverted-dice|d4|d6|d8|d10|d12|d20|chess-|abstract-|uncertainty)/;

type Icon = { paths: string[]; author: string };
let library: Map<string, Icon> | null = null;

async function iconLibrary(): Promise<Map<string, Icon>> {
  if (library !== null) return library;
  const zip = path.join(dirs.cache, 'asset-src', 'game-icons.zip');
  if (!fs.existsSync(zip)) {
    log.info('painted: fetching the game-icons.net set (about 4 MB, once)');
    const response = await fetch(ZIP_URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`game-icons download failed: ${response.status}`);
    fs.mkdirSync(path.dirname(zip), { recursive: true });
    fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  }
  const files = unzipSync(new Uint8Array(fs.readFileSync(zip)), { filter: (file) => file.name.endsWith('.svg') });
  const map = new Map<string, Icon>();
  for (const [name, bytes] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const parts = name.split('/');
    const folder = parts[parts.length - 2] ?? '';
    const base = (parts[parts.length - 1] ?? '').replace(/\.svg$/, '');
    if (SKIP_FOLDERS.has(folder) || map.has(base) || NOT_SUBJECTS.test(base)) continue;
    const paths = [...Buffer.from(bytes).toString('utf8').matchAll(/<path[^>]*\sd="([^"]+)"/g)]
      .map((match) => match[1]!)
      .filter((d) => !/^M0 0h512v512H0z$/.test(d.trim()));
    if (paths.length > 0) map.set(base, { paths, author: ARTISTS[folder] ?? folder });
  }
  library = map;
  return map;
}

/** One icon by its game-icons name, or null: for callers that compose a scene by hand. */
export async function iconNamed(name: string): Promise<{ paths: string[]; author: string } | null> {
  return (await iconLibrary()).get(name) ?? null;
}

/** The nearest real name to one the model made up: most shared words, then shortest. */
function nearest(name: string, names: readonly string[]): string | null {
  const want = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter((w) => w.length > 2);
  if (want.length === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const candidate of names) {
    const words = candidate.split('-');
    const score = want.filter((w) => words.includes(w)).length;
    if (score > bestScore || (score === bestScore && score > 0 && best !== null && candidate.length < best.length)) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    beats: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          beat: { type: 'integer' },
          sky: { type: 'string', enum: [...SKIES] },
          ground: { type: 'string', enum: [...GROUNDS] },
          atmosphere: { type: 'string', enum: [...ATMOSPHERES] },
          light: { type: 'string', enum: ['left', 'right'] },
          subjects: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                icon: { type: 'string' },
                place: { type: 'string', enum: ['ground', 'sky'] },
                x: { type: 'number' },
                y: { type: 'number' },
                size: { type: 'number' },
                color: { type: 'string' },
              },
              required: ['icon', 'place', 'x', 'size', 'color'],
            },
          },
        },
        required: ['beat', 'sky', 'ground', 'atmosphere', 'light', 'subjects'],
      },
    },
  },
  required: ['beats'],
};

function request(topic: string, script: string, beats: readonly string[], names: readonly string[]): string {
  return `You are art-directing a vertical watercolour storybook video. Every beat of the narration is one painted scene: a sky, a ground, the weather, and one or two subjects painted as watercolour silhouettes with ink outlines.

The video is about: ${topic}

The whole narration:
${script}

The beats, in order:
${beats.map((text, i) => `${i + 1}. ${text}`).join('\n')}

For every beat choose:
- sky: ${SKIES.join(' | ')} ("interior" for indoor scenes)
- ground: ${GROUNDS.join(' | ')}
- atmosphere: ${ATMOSPHERES.join(' | ')}
- light: left | right (which side the light comes from)
- subjects: one, or two when the beat is about two things. Each:
  - icon: EXACTLY one name from the list below. It must show the concrete thing the beat is about (a person, animal, object, building, vehicle, tool). Never a name that only shares a word with the beat.
  - place: "ground" for things that stand, sit or float on water; "sky" for things that fly or hang.
  - x: 0.2 to 0.8 across (two subjects: about 0.3 and 0.7)
  - y: 0.15 to 0.45 for sky subjects (ignored for ground)
  - size: 0.6 to 0.8 for one subject, 0.36 to 0.5 each for two
  - color: a natural watercolour colour for that thing as a #rrggbb hex: earthy, slightly muted, never pure black, never close to the sky behind it.

Rules:
1. Keep the same sky and ground while the story stays in one place. Change them when it moves, or when the time of day changes.
2. Prefer one big subject. The subject is what the viewer should look at while hearing that beat. When the story has a protagonist (an animal, a person, a ship), show the protagonist doing the thing more often than a prop.
3. Pick by meaning, never by a shared word: "bees fan their wings" is a bee, not a fan; "the market crashed" is a falling chart or coins, not a car crash.
4. Abstract beats (an idea, a feeling, a number) still get a concrete, recognisable object that stands for them (a light bulb, a broken heart, coins, an hourglass). Never arrows, diagrams, symbols or UI icons.
5. Do not use the same subject on two beats in a row.
6. Every beat has at least one subject.

Icon names you may use:
${names.join(', ')}

Return {"beats": [...]} with exactly ${beats.length} entries, numbered from 1.`;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const HEX = /^#[0-9a-fA-F]{6}$/;
const FALLBACK_COLORS = ['#b9805a', '#7a5a8c', '#4f7a8c', '#a84f3c', '#6f8a4a', '#8c6a3c'];

/** Without a model: subjects by matching the beat's words to icon names. */
function plainScene(text: string, index: number, names: readonly string[], icons: Map<string, Icon>): Omit<PaintScene, 'settled'> {
  const words = text.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  const hit = words.map((w) => (icons.has(w) ? w : null)).find((w) => w !== null) ?? nearest(words.join('-'), names);
  const icon = hit === null || hit === undefined ? null : icons.get(hit);
  return {
    sky: 'day',
    ground: 'hills',
    atmosphere: 'none',
    light: index % 2 === 0 ? 'left' : 'right',
    subjects: icon === undefined || icon === null || hit === null || hit === undefined
      ? []
      : [{ icon: hit, author: icon.author, paths: icon.paths, x: 0.5, y: 0.3, place: 'ground', size: 0.62, color: FALLBACK_COLORS[index % FALLBACK_COLORS.length]!, flip: false }],
  };
}

export async function directPainting(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
  force: boolean;
}): Promise<PaintScene[]> {
  const icons = await iconLibrary();
  const names = [...icons.keys()];

  let raw: Record<string, unknown>[] = [];
  if (env.GEMINI_API_KEY === undefined) {
    log.info('painted: no key for the art director; subjects matched from the words');
  } else {
    cache.setForce(options.force);
    try {
      const { value } = await cache.json<{ beats: Record<string, unknown>[] }>(
        'paint-direction',
        { v: DIRECTION_VERSION, model: MODELS.llm.script, topic: options.topic, script: options.script, beats: options.beatTexts, seed: options.seed, icons: names.length },
        async () => {
          const response = await generate({
            model: MODELS.llm.script,
            systemInstruction: 'You are the art director of a hand-painted storybook video. You return JSON and nothing else.',
            prompt: request(options.topic, options.script, options.beatTexts, names),
            temperature: 0.5,
            seed: toInt32Seed(options.seed),
            maxOutputTokens: 12000,
            responseSchema: RESPONSE_SCHEMA,
          });
          return JSON.parse(response.text) as { beats: Record<string, unknown>[] };
        },
      );
      raw = Array.isArray(value.beats) ? value.beats : [];
    } catch (error) {
      log.warn(`painted: the art director failed (${(error as Error).message.slice(0, 140)}); matching from the words`);
    }
  }

  const byBeat = new Map<number, Record<string, unknown>>();
  for (const entry of raw) {
    const at = Number(entry['beat']);
    if (Number.isInteger(at) && !byBeat.has(at)) byBeat.set(at, entry);
  }

  let repaired = 0;
  let previous: PaintScene | null = null;
  const scenes = options.beatTexts.map((text, index): PaintScene => {
    const entry = byBeat.get(index + 1);
    let scene: Omit<PaintScene, 'settled'>;
    if (entry === undefined) {
      scene = plainScene(text, index, names, icons);
    } else {
      const pick = <T extends string>(value: unknown, list: readonly T[], fallback: T): T =>
        (list as readonly string[]).includes(String(value)) ? (value as T) : fallback;
      const sky = pick<Sky>(entry['sky'], SKIES, previous?.sky ?? 'day');
      const ground = pick<Ground>(entry['ground'], GROUNDS, previous?.ground ?? 'hills');
      const atmosphere = pick<Atmosphere>(entry['atmosphere'], ATMOSPHERES, 'none');
      const light = entry['light'] === 'right' ? 'right' : 'left';
      const wanted = (Array.isArray(entry['subjects']) ? entry['subjects'] : []).slice(0, 2) as Record<string, unknown>[];
      const subjects = wanted.flatMap((s, i) => {
        let name = String(s['icon'] ?? '').trim().toLowerCase();
        if (!icons.has(name)) {
          const near = nearest(name, names);
          if (near === null) return [];
          repaired++;
          name = near;
        }
        const icon = icons.get(name)!;
        const two = wanted.length > 1;
        const size = clamp(Number(s['size']) || (two ? 0.4 : 0.62), two ? 0.28 : 0.42, two ? 0.5 : 0.78);
        const x = clamp(Number(s['x']) || (two ? (i === 0 ? 0.3 : 0.7) : 0.5), size / 2 + 0.02, 1 - size / 2 - 0.02);
        const color = typeof s['color'] === 'string' && HEX.test(s['color']) ? s['color'] : FALLBACK_COLORS[(index + i) % FALLBACK_COLORS.length]!;
        return [{
          icon: name,
          author: icon.author,
          paths: icon.paths,
          x,
          y: clamp(Number(s['y']) || 0.3, 0.12, 0.5),
          place: s['place'] === 'sky' ? ('sky' as const) : ('ground' as const),
          size,
          color,
          // Facing into the frame: a subject on the right looks left.
          flip: x > 0.55,
        }];
      });
      scene = { sky, ground, atmosphere, light, subjects };
    }
    const settled = previous !== null && previous.sky === scene.sky && previous.ground === scene.ground;
    const result = paintSceneSchema.parse({ ...scene, settled });
    previous = result;
    return result;
  });

  const painted = scenes.filter((scene) => scene.subjects.length > 0).length;
  log.info(`painted: ${painted}/${scenes.length} beats with a subject` + (repaired > 0 ? `, ${repaired} icon name(s) matched to the nearest real one` : ''));
  return scenes;
}

/** "Icons made by ..." for the icons a painted video used, next to it for the description. */
export function writePaintCredits(dir: string, scenes: readonly PaintScene[]): void {
  const artists = [...new Set(scenes.flatMap((scene) => scene.subjects.map((s) => s.author)).filter((a) => a !== ''))];
  const file = path.join(dir, 'paint-credits.txt');
  const lines = ['Painted with p5.brush by Alejandro Campos Uribe (MIT) https://github.com/acamposuribe/p5.brush'];
  if (artists.length > 0) {
    const named = artists.length === 1 ? artists[0]! : `${artists.slice(0, -1).join(', ')} and ${artists[artists.length - 1]}`;
    lines.push(`Icons made by ${named} from game-icons.net (CC BY 3.0) https://game-icons.net`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}
