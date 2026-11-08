import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { ROOT, dirs } from '../config.js';
import { log } from '../log.js';

/**
 * The icon set: silhouettes from game-icons.net, picked for military history
 * told for laughs.
 *
 * game-icons.net is CC BY 3.0 (a few artists CC0), credited per artist, which
 * suits a video: the credit goes in the description, generated from the icons
 * a video actually used. Two folders are left out -- `badges` and
 * `various-artists` -- because they do not say who drew them, and a credit
 * that cannot name the author cannot satisfy the licence.
 *
 * The names on the left are the vocabulary the director chooses from, so they
 * say what the thing is in the story ("nuke", "trench") rather than what the
 * file is called ("mushroom-cloud", "trench-assault").
 */
export const ICON_SOURCES: readonly (readonly [string, string])[] = [
  // armour, guns, bombs
  ['tank', 'battle-tank'], ['ww1-tank', 'great-war-tank'], ['jeep', 'jeep'], ['truck', 'truck'],
  ['rifle', 'rifle'], ['musket', 'musket'], ['pistol', 'pistol-gun'], ['machine-gun', 'machine-gun'],
  ['cannon', 'cannon'], ['cannonball', 'cannon-ball'], ['shell', 'artillery-shell'], ['grenade', 'stick-grenade'],
  ['bomb', 'falling-bomb'], ['bombing-run', 'bombing-run'], ['nuke', 'mushroom-cloud'], ['rocket', 'rocket'],
  ['land-mine', 'land-mine'], ['dynamite', 'dynamite'], ['time-bomb', 'time-bomb'], ['bullets', 'bullets'],
  ['explosion', 'bright-explosion'], ['fire', 'flame'], ['flamethrower', 'flamethrower-soldier'],
  // trenches and kit
  ['barbed-wire', 'barbed-wire'], ['trench', 'trench-assault'], ['shovel', 'trench-spade'], ['gas-mask', 'gas-mask'],
  ['helmet', 'brodie-helmet'], ['spartan', 'spartan-helmet'], ['samurai', 'samurai-helmet'], ['viking', 'viking-helmet'],
  ['roman', 'centurion-helmet'], ['knight', 'black-knight-helm'], ['crown', 'crown'], ['binoculars', 'binoculars'],
  ['compass', 'compass'], ['map', 'treasure-map'], ['radio', 'pocket-radio'], ['radio-tower', 'radio-tower'],
  // air and sea
  ['biplane', 'biplane'], ['bomber', 'bomber'], ['fighter', 'jet-fighter'], ['helicopter', 'helicopter'],
  ['parachute', 'parachute'], ['submarine', 'submarine'], ['battleship', 'battleship'], ['warship', 'iron-hulled-warship'],
  ['galleon', 'galleon'], ['caravel', 'caravel'], ['sinking-ship', 'sinking-ship'], ['shipwreck', 'ship-wreck'], ['anchor', 'anchor'],
  // older wars
  ['cavalry', 'cavalry'], ['horse', 'horse-head'], ['mounted-knight', 'mounted-knight'], ['catapult', 'catapult'],
  ['trebuchet', 'trebuchet'], ['siege-tower', 'siege-tower'], ['castle', 'castle'], ['fort', 'military-fort'],
  ['ruins', 'castle-ruins'], ['tower-falls', 'tower-fall'], ['crossed-swords', 'crossed-swords'], ['sword', 'broadsword'],
  ['shield', 'round-shield'], ['spears', 'spears'], ['bow', 'bow-arrow'], ['crossbow', 'crossbow'], ['axe', 'battle-axe'],
  // outcomes
  ['medal', 'medal'], ['star-medal', 'star-medal'], ['trophy', 'laurels-trophy'], ['flag', 'flying-flag'],
  ['black-flag', 'black-flag'], ['peace', 'peace-dove'], ['skull', 'skull-crossed-bones'], ['coffin', 'coffin'],
  ['grave', 'tombstone'], ['graveyard', 'graveyard'], ['army', 'meeple-army'], ['rally', 'rally-the-troops'],
  // life at war
  ['newspaper', 'newspaper'], ['letter', 'envelope'], ['scroll', 'scroll-unfurled'], ['money', 'money-stack'],
  ['coins', 'coins'], ['bread', 'bread'], ['tin-can', 'opened-food-can'], ['stopwatch', 'stopwatch'],
  ['hourglass', 'hourglass'], ['calendar', 'calendar'], ['train', 'subway-train'], ['elephant', 'elephant'],
  ['camel', 'camel'], ['rat', 'rat'], ['chess-king', 'chess-king'], ['chess-pawn', 'chess-pawn'], ['fist', 'fist'],
  // weather
  ['snow', 'snowflake-1'], ['cold', 'thermometer-cold'], ['hot', 'thermometer-hot'], ['sun', 'sun'],
  ['storm', 'lightning-storm'], ['cloud', 'fluffy-cloud'],
  // reactions
  ['idea', 'light-bulb'], ['brain', 'brain'],
  ['sleep', 'night-sleep'], ['shock', 'surprised-skull'], ['cool', 'sunglasses'], ['money-please', 'take-my-money'],
  ['broken-heart', 'broken-heart'], ['tears', 'tear-tracks'], ['party', 'party-flags'], ['dove', 'dove'],
];

const SKIP_FOLDERS = new Set(['badges', 'various-artists']);
const CC0_FOLDERS = new Set(['viscious-speed', 'zeromancer']);

/** Folder to how the artist asks to be credited. */
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

const ZIP_URL = 'https://github.com/game-icons/icons/archive/refs/heads/master.zip';
const OUT_MODULE = path.join(ROOT, 'src', 'remotion', 'war', 'icons.ts');

export async function buildIcons(): Promise<number> {
  const zip = path.join(dirs.cache, 'asset-src', 'game-icons.zip');
  if (!fs.existsSync(zip)) {
    const response = await fetch(ZIP_URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`game-icons download failed: ${response.status}`);
    fs.mkdirSync(path.dirname(zip), { recursive: true });
    fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  }
  const files = unzipSync(new Uint8Array(fs.readFileSync(zip)), {
    filter: (file) => file.name.endsWith('.svg'),
  });
  // basename -> [folder, contents], first non-skipped folder wins.
  const byName = new Map<string, { folder: string; svg: string }>();
  for (const [name, bytes] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const parts = name.split('/');
    const folder = parts[parts.length - 2] ?? '';
    if (SKIP_FOLDERS.has(folder)) continue;
    const base = (parts[parts.length - 1] ?? '').replace(/\.svg$/, '');
    if (!byName.has(base)) byName.set(base, { folder, svg: Buffer.from(bytes).toString('utf8') });
  }

  const icons: Record<string, { paths: string[]; author: string; licence: string; file: string }> = {};
  const missing: string[] = [];
  for (const [name, file] of ICON_SOURCES) {
    const found = byName.get(file);
    if (found === undefined) {
      missing.push(file);
      continue;
    }
    // Every path except the black square the glyph is drawn on.
    const paths = [...found.svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)]
      .map((match) => match[1]!)
      .filter((d) => !/^M0 0h512v512H0z$/.test(d.trim()));
    if (paths.length === 0) {
      missing.push(file);
      continue;
    }
    icons[name] = {
      paths,
      author: ARTISTS[found.folder] ?? found.folder,
      licence: CC0_FOLDERS.has(found.folder) ? 'CC0' : 'CC BY 3.0',
      file: `${found.folder}/${file}.svg`,
    };
  }

  const body = [
    '/**',
    ' * Generated by `pnpm cli assets` from game-icons.net (https://game-icons.net).',
    ' * CC BY 3.0 unless marked CC0; credit "Icons made by {author}" -- the video',
    ' * pipeline writes those credits for the icons each video used. Do not edit;',
    ' * change ICON_SOURCES in src/assets/icons.ts and rebuild.',
    ' */',
    '',
    'export type WarIcon = { paths: readonly string[]; author: string; licence: string; file: string };',
    '',
    `export const ICONS: Record<string, WarIcon> = ${JSON.stringify(icons)};`,
    '',
    `export const ICON_NAMES: readonly string[] = ${JSON.stringify(Object.keys(icons))};`,
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(OUT_MODULE), { recursive: true });
  fs.writeFileSync(OUT_MODULE, body, 'utf8');
  log.info(
    `assets: ${Object.keys(icons).length} icons from game-icons.net` +
      (missing.length === 0 ? '' : `; not found: ${missing.join(', ')}`),
  );
  return Object.keys(icons).length;
}
