import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { dirs } from '../config.js';
import { ffmpeg, probeDurationMs } from '../ffmpeg.js';
import { log } from '../log.js';
import {
  LIBRARY_DIR,
  SOUND_KINDS,
  type Licence,
  type SoundEntry,
  type SoundKind,
  type SoundManifest,
} from './library.js';

/**
 * Builds the sound library from sources that allow a monetised channel to use
 * them, and records exactly where each file came from.
 *
 * Three kinds of source, in order of preference:
 *
 *   packs     CC0 archives from Kenney and OpenGameArt: no attribution, no
 *             conditions, downloaded once and cut up here.
 *   Commons   single recordings from Wikimedia Commons -- mostly US military
 *             band recordings, which are public domain -- with the licence
 *             read back from the file page at fetch time. A file whose licence
 *             is not public domain, CC0 or plain attribution is refused, so a
 *             relicensed page cannot slip a share-alike file into a video.
 *   generated the cartoon sounds that are simple enough to synthesise well:
 *             a bomb whistle is a falling sine, a censor bleep is a sine, a
 *             sad trombone is four notes. Made by ffmpeg, owed to nobody.
 *
 * Some kinds are layered from the CC0 material: a firework bang is thin for a
 * war, so an explosion is a bang, a sub-bass boom and a reverb tail; a
 * machine-gun burst is single shots, fast.
 *
 * Idempotent: downloads are kept under .cache/asset-src and reused, and the
 * library is rebuilt from them in a few seconds.
 */

const SRC = path.join(dirs.cache, 'asset-src');
const RATE = 48_000;
const UA = { 'User-Agent': 'BreezeMatic asset builder (https://github.com/thebreezyanupam)' };

type Pack = { id: string; url: string; title: string; author: string; licence: Licence; page: string };

const PACKS: Pack[] = [
  { id: 'kenney-impact', url: 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip', title: 'Impact Sounds', author: 'Kenney', licence: 'CC0', page: 'https://kenney.nl/assets/impact-sounds' },
  { id: 'kenney-interface', url: 'https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip', title: 'Interface Sounds', author: 'Kenney', licence: 'CC0', page: 'https://kenney.nl/assets/interface-sounds' },
  { id: 'kenney-rpg', url: 'https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip', title: 'RPG Audio', author: 'Kenney', licence: 'CC0', page: 'https://kenney.nl/assets/rpg-audio' },
  { id: 'kenney-scifi', url: 'https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip', title: 'Sci-fi Sounds', author: 'Kenney', licence: 'CC0', page: 'https://kenney.nl/assets/sci-fi-sounds' },
  { id: 'kenney-casino', url: 'https://kenney.nl/media/pages/assets/casino-audio/2472606a04-1721639069/kenney_casino-audio.zip', title: 'Casino Audio', author: 'Kenney', licence: 'CC0', page: 'https://kenney.nl/assets/casino-audio' },
  { id: 'oga-bang', url: 'https://opengameart.org/sites/default/files/25-CC0-bang-sfx.zip', title: '25 CC0 bang / firework SFX', author: 'rubberduck', licence: 'CC0', page: 'https://opengameart.org/content/25-cc0-bang-firework-sfx' },
  { id: 'oga-100', url: 'https://opengameart.org/sites/default/files/100-CC0-SFX_0.zip', title: '100 CC0 SFX', author: 'rubberduck', licence: 'CC0', page: 'https://opengameart.org/content/100-cc0-sfx' },
];

/** A file out of a pack, used as it is apart from trimming and level. */
type PackPick = { kind: SoundKind; pack: string; match: RegExp; limit?: number; gainDb?: number };

const PACK_PICKS: PackPick[] = [
  { kind: 'gunshot', pack: 'oga-bang', match: /shot_0[1-3]\.ogg$/ },
  { kind: 'gunshot', pack: 'oga-100', match: /shot_01\.ogg$/ },
  { kind: 'boing', pack: 'oga-100', match: /spring_0[1-46-9]\.ogg$/ },
  { kind: 'pop', pack: 'oga-100', match: /plop_0[12]\.ogg$/ },
  { kind: 'gong', pack: 'oga-100', match: /gong_0[12]\.ogg$/ },
  { kind: 'punch', pack: 'kenney-impact', match: /impactPunch_heavy_00[0-3]\.ogg$/ },
  { kind: 'bonk', pack: 'kenney-impact', match: /impactWood_heavy_00[0-2]\.ogg$/ },
  { kind: 'bonk', pack: 'kenney-impact', match: /impactPlate_heavy_00[0-1]\.ogg$/ },
  { kind: 'wrong', pack: 'kenney-interface', match: /error_00[3-6]\.ogg$/ },
  { kind: 'correct', pack: 'kenney-interface', match: /confirmation_00[1-3]\.ogg$/ },
  { kind: 'sword-draw', pack: 'kenney-rpg', match: /drawKnife[1-3]\.ogg$/ },
  { kind: 'cash', pack: 'kenney-rpg', match: /handleCoins\.ogg$/ },
  { kind: 'cash', pack: 'kenney-casino', match: /chips-stack-[1-3]\.ogg$/ },
];

/** A recording from Wikimedia Commons, optionally cut to its useful part. */
type CommonsPick = { kind: SoundKind; file: string; start?: number; duration?: number };

const COMMONS_PICKS: CommonsPick[] = [
  { kind: 'bugle', file: 'Assembly bugle call.ogg' },
  { kind: 'bugle', file: 'Recall bugle call.ogg' },
  { kind: 'bugle', file: 'FirstCall.mp3' },
  { kind: 'bugle', file: 'Attention Bugle Call (US).oga' },
  { kind: 'taps', file: 'Taps on bugle.ogg', start: 0, duration: 15 },
  { kind: 'siren', file: 'Civil-defense-siren-waver.ogg', start: 4, duration: 9 },
  { kind: 'siren', file: 'Motorsirene - Feuerwehralarm.ogg', start: 2, duration: 8 },
  { kind: 'march', file: 'Drum - Cadence A.ogg', start: 4, duration: 8 },
  { kind: 'march', file: 'Drum - Cadence B.ogg', start: 4, duration: 8 },
  { kind: 'horses', file: 'Six Horses Galloping By.ogg', start: 6, duration: 7 },
  { kind: 'applause', file: 'Applause i.ogg', start: 1, duration: 6 },
  { kind: 'applause', file: 'Applause ii.ogg', start: 1, duration: 6 },
  { kind: 'cheer', file: 'Clapping hurray.ogg', start: 0, duration: 6 },
  { kind: 'rimshot', file: 'Kevin MacLeod assorted rimshots - Kdum-keesh.wav' },
  { kind: 'rimshot', file: 'Kevin MacLeod assorted rimshots - Bah-dum-bum-ding.wav' },
  { kind: 'rimshot', file: 'Kevin MacLeod assorted rimshots - Bah-dum.wav' },
  { kind: 'drumroll', file: 'Kevin MacLeod assorted rimshots - 4-second roll.wav' },
  { kind: 'swords', file: 'Sword Clash (Gravity Sound).mp3' },
  { kind: 'swords', file: 'Sword Clash 2 (Gravity Sound).mp3' },
  { kind: 'swords', file: 'Sword Clash 3 (Gravity Sound).mp3' },
  { kind: 'swords', file: 'Sword Clash 4 (Gravity Sound).mp3' },
];

const ALLOWED = /^(public domain|cc0|cc by(-| )?[34]\.0)$/i;

/* ------------------------------------------------------------ downloading -- */

async function download(url: string, destination: string): Promise<void> {
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return;
  const response = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

/** A pack, unpacked once into .cache/asset-src/<id>. Returns its audio files. */
async function unpack(pack: Pack): Promise<string[]> {
  const dir = path.join(SRC, pack.id);
  const zip = path.join(SRC, `${pack.id}.zip`);
  if (!fs.existsSync(dir)) {
    await download(pack.url, zip);
    const files = unzipSync(new Uint8Array(fs.readFileSync(zip)));
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('/') || !/\.(ogg|wav|mp3)$/i.test(name)) continue;
      const out = path.join(dir, path.basename(name));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(out, bytes);
    }
  }
  return fs.readdirSync(dir).map((name) => path.join(dir, name)).sort();
}

type CommonsInfo = { url: string; licence: string; author: string; page: string };

/** The file's download URL, licence and author, from the Commons API. */
async function commonsInfo(file: string): Promise<CommonsInfo> {
  const url =
    'https://commons.wikimedia.org/w/api.php?' +
    new URLSearchParams({
      action: 'query',
      format: 'json',
      titles: `File:${file}`,
      prop: 'imageinfo',
      iiprop: 'url|extmetadata',
    }).toString();
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: UA });
    const text = await response.text();
    if (text.startsWith('{')) {
      const data = JSON.parse(text) as {
        query?: { pages?: Record<string, { imageinfo?: { url: string; descriptionurl: string; extmetadata?: Record<string, { value?: string }> }[] }> };
      };
      const info = Object.values(data.query?.pages ?? {})[0]?.imageinfo?.[0];
      if (info === undefined) throw new Error(`no such file on Commons: ${file}`);
      const plain = (html: string | undefined): string => (html ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      return {
        url: info.url,
        licence: plain(info.extmetadata?.['LicenseShortName']?.value),
        author: plain(info.extmetadata?.['Artist']?.value) || 'Wikimedia Commons contributor',
        page: info.descriptionurl,
      };
    }
    // Rate limited: the API answers in plain text.
    if (attempt >= 4) throw new Error(`Commons would not answer for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000 * (attempt + 1)));
  }
}

/* -------------------------------------------------------------- shaping -- */

const WAV_OUT = ['-ar', String(RATE), '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav'];

/** Loudest sample, in dBFS. */
async function peakOf(file: string): Promise<number> {
  const { stderr } = await ffmpeg(['-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const found = /max_volume: (-?[\d.]+) dB/.exec(stderr);
  return found === null ? 0 : Number(found[1]);
}

/**
 * Trimmed of dead air at both ends, faded out so nothing clicks off, and
 * brought to a peak of -1 dBFS -- one level for the whole library, so the mix
 * gains in SOUND_GAIN_DB mean the same thing for every file.
 */
async function finish(input: string, out: string, options: { start?: number; duration?: number; keepTail?: boolean } = {}): Promise<number> {
  const tmp = `${out}.tmp.wav`;
  const edge = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02';
  const cut = [
    ...(options.start !== undefined ? ['-ss', String(options.start)] : []),
    ...(options.duration !== undefined ? ['-t', String(options.duration)] : []),
  ];
  const trimEnd = options.keepTail === true ? '' : `,areverse,${edge},areverse`;
  const length = options.duration ?? 0;
  const fade = options.duration !== undefined ? `,afade=t=out:st=${Math.max(0, length - 0.6)}:d=0.6` : ',afade=t=out:st=0:d=0.001';
  await ffmpeg([...cut, '-i', input, '-af', `${edge}${trimEnd}${options.duration !== undefined ? fade : ''}`, ...WAV_OUT, tmp]);
  const peak = await peakOf(tmp);
  await ffmpeg(['-i', tmp, '-af', `volume=${(-1 - peak).toFixed(2)}dB`, ...WAV_OUT, out]);
  fs.rmSync(tmp, { force: true });
  return probeDurationMs(out);
}

/** Runs an ffmpeg graph with lavfi sources and/or files into a finished file. */
async function build(out: string, args: string[]): Promise<number> {
  const tmp = `${out}.raw.wav`;
  await ffmpeg([...args, ...WAV_OUT, tmp]);
  const duration = await finish(tmp, out, { keepTail: true });
  fs.rmSync(tmp, { force: true });
  return duration;
}

/* ------------------------------------------------------------ synthesis -- */

/** A glide from f0 to f1 over T seconds, exponential, as an ffmpeg phase expression. */
const glide = (f0: number, f1: number, T: number): string => {
  const r = f1 / f0;
  return `2*PI*${f0}*${T}/${Math.log(r).toFixed(6)}*(pow(${r.toFixed(6)},t/${T})-1)`;
};

/** A brassy tone: harmonics falling off as 1/n, with an optional vibrato. */
const brass = (f: number, harmonics = 7, vibrato = 0): string => {
  const phase = vibrato === 0 ? `2*PI*${f}*t` : `2*PI*${f}*(t-${(vibrato / (2 * Math.PI * 5.5)).toFixed(6)}*cos(2*PI*5.5*t))`;
  return Array.from({ length: harmonics }, (_, i) => `${(1 / (i + 1)).toFixed(3)}*sin(${i + 1}*${phase})`).join('+');
};

const src = (expr: string, seconds: number): string[] => [
  '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=${RATE}:d=${seconds}`,
];

/** Notes played one after another, each its own expression, then joined. */
async function sequence(out: string, notes: { expr: string; seconds: number; gap?: number }[], post = ''): Promise<number> {
  const inputs: string[] = [];
  const parts: string[] = [];
  let index = 0;
  const labels: string[] = [];
  for (const note of notes) {
    inputs.push(...src(note.expr, note.seconds));
    parts.push(`[${index}:a]afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, note.seconds - 0.06)}:d=0.06[n${index}]`);
    labels.push(`[n${index}]`);
    index++;
    if (note.gap !== undefined && note.gap > 0) {
      inputs.push('-f', 'lavfi', '-t', String(note.gap), '-i', `anullsrc=r=${RATE}:cl=mono`);
      labels.push(`[${index}:a]`);
      index++;
    }
  }
  const graph = `${parts.join(';')};${labels.join('')}concat=n=${labels.length}:v=0:a=1${post === '' ? '' : `,${post}`}[out]`;
  return build(out, [...inputs, '-filter_complex', graph, '-map', '[out]']);
}

type Synth = { kind: SoundKind; name: string; make: (out: string) => Promise<number> };

const SYNTHS: Synth[] = [
  {
    kind: 'bomb-whistle',
    name: 'falling whistle',
    make: (out) => build(out, [...src(`0.6*sin(${glide(2400, 520, 2.4)})*(0.85+0.15*sin(2*PI*7*t))*min(1,t/0.2)`, 2.4)]),
  },
  {
    kind: 'bomb-whistle',
    name: 'falling whistle, short',
    make: (out) => build(out, [...src(`0.6*sin(${glide(2000, 600, 1.5)})*(0.85+0.15*sin(2*PI*8*t))*min(1,t/0.1)`, 1.5)]),
  },
  {
    kind: 'ricochet',
    name: 'ricochet',
    make: (out) => build(out, [...src(`0.7*sin(${glide(3400, 1300, 0.55)})*exp(-2.5*t)`, 0.6)]),
  },
  {
    kind: 'slide-up',
    name: 'slide whistle up',
    make: (out) => build(out, [...src(`0.6*sin(${glide(380, 1500, 0.7)})*(0.9+0.1*sin(2*PI*6*t))*min(1,t/0.05)`, 0.75)]),
  },
  {
    kind: 'slide-down',
    name: 'slide whistle down',
    make: (out) => build(out, [...src(`0.6*sin(${glide(1500, 330, 0.8)})*(0.9+0.1*sin(2*PI*6*t))*min(1,t/0.05)`, 0.85)]),
  },
  {
    kind: 'sad-trombone',
    name: 'sad trombone',
    make: (out) =>
      sequence(
        out,
        [
          { expr: `0.22*(${brass(311.13)})*(1-0.25*t/0.42)`, seconds: 0.42, gap: 0.06 },
          { expr: `0.22*(${brass(293.66)})*(1-0.25*t/0.42)`, seconds: 0.42, gap: 0.06 },
          { expr: `0.22*(${brass(277.18)})*(1-0.25*t/0.42)`, seconds: 0.42, gap: 0.06 },
          { expr: `0.22*(${brass(261.63, 7, 0.018)})*min(1,t/0.05)*(1-0.5*t/1.5)`, seconds: 1.5 },
        ],
        'lowpass=f=1900,aecho=0.8:0.5:40:0.2',
      ),
  },
  {
    kind: 'dun-dun',
    name: 'dun dun dunnn',
    make: (out) => {
      const chord = (a: number, b: number, c: number, amp: number): string =>
        `${amp}*((${brass(a, 6)})+(${brass(b, 6)})+(${brass(c, 6)}))/3+0.5*sin(2*PI*55*t)*exp(-6*t)`;
      return sequence(
        out,
        [
          { expr: `${chord(146.83, 174.61, 220, 0.3)}*exp(-2.2*t)`, seconds: 0.34, gap: 0.12 },
          { expr: `${chord(146.83, 174.61, 220, 0.3)}*exp(-2.2*t)`, seconds: 0.34, gap: 0.14 },
          { expr: `${chord(116.54, 146.83, 174.61, 0.34)}*(0.85+0.15*sin(2*PI*6*t))*exp(-0.9*t)`, seconds: 2.2 },
        ],
        'lowpass=f=2200,aecho=0.8:0.6:70|150:0.3|0.18',
      );
    },
  },
  {
    kind: 'airhorn',
    name: 'air horn',
    make: (out) => {
      const horn = `(${brass(466, 9)})+(${brass(470.5, 9)})*0.8+(${brass(698, 6)})*0.5`;
      return sequence(
        out,
        [
          { expr: `0.14*(${horn})`, seconds: 0.2, gap: 0.07 },
          { expr: `0.14*(${horn})`, seconds: 0.2, gap: 0.07 },
          { expr: `0.14*(${horn})`, seconds: 1.0 },
        ],
        'acrusher=bits=8:mix=0.25,highpass=f=250,lowpass=f=4200',
      );
    },
  },
  {
    kind: 'record-scratch',
    name: 'record scratch',
    make: (out) =>
      sequence(
        out,
        [
          { expr: `0.35*(sin(${glide(90, 520, 0.13)})+0.5*sin(2*${glide(90, 520, 0.13)})+0.3*sin(3*${glide(90, 520, 0.13)}))`, seconds: 0.13 },
          { expr: `0.35*(sin(${glide(520, 70, 0.2)})+0.5*sin(2*${glide(520, 70, 0.2)})+0.3*sin(3*${glide(520, 70, 0.2)}))`, seconds: 0.2 },
        ],
        'acrusher=bits=6:mix=0.35,highpass=f=120',
      ),
  },
  {
    kind: 'bleep',
    name: 'censor bleep',
    make: (out) => build(out, [...src('0.5*sin(2*PI*1000*t)*min(1,t/0.005)*min(1,(0.45-t)/0.005)', 0.45)]),
  },
  {
    kind: 'ding',
    name: 'ding',
    make: (out) =>
      build(out, [...src('0.5*sin(2*PI*1318.5*t)*exp(-3*t)+0.25*sin(2*PI*2637*t)*exp(-4.5*t)+0.12*sin(2*PI*3955*t)*exp(-7*t)', 1.6)]),
  },
  {
    kind: 'crickets',
    name: 'crickets',
    make: (out) =>
      build(out, [
        ...src(
          '0.25*sin(2*PI*4450*t)*(0.5+0.5*sin(2*PI*30*t))*lt(mod(t,0.62),0.15)' +
            '+0.18*sin(2*PI*4020*t)*(0.5+0.5*sin(2*PI*26*t))*lt(mod(t+0.3,0.81),0.13)',
          3.6,
        ),
      ]),
  },
  {
    kind: 'heartbeat',
    name: 'heartbeat',
    make: (out) =>
      build(out, [
        ...src(
          'sin(2*PI*52*mod(t,0.9))*exp(-26*mod(t,0.9))' +
            '+0.75*sin(2*PI*46*(mod(t,0.9)-0.24))*exp(-26*(mod(t,0.9)-0.24))*gt(mod(t,0.9),0.24)',
          3.6,
        ),
        '-af', 'lowpass=f=160,volume=4',
      ]),
  },
  {
    kind: 'morse',
    name: 'telegraph',
    make: (out) => {
      // "- . .-. ." and so on: dots and dashes at a sending speed, then a rest.
      const pattern = '1110101110100010111011101000111010100010101';
      const unit = 0.07;
      const gate = [...pattern]
        .map((bit, i) => (bit === '1' ? `between(t,${(i * unit).toFixed(3)},${((i + 1) * unit).toFixed(3)})` : ''))
        .filter(Boolean)
        .join('+');
      return build(out, [...src(`0.4*sin(2*PI*760*t)*min(1,${gate})`, pattern.length * unit + 0.2)]);
    },
  },
  {
    kind: 'clock',
    name: 'clock ticking',
    make: (out) =>
      build(out, [
        ...src('0.6*sin(2*PI*if(lt(mod(t,1),0.5),2900,2100)*t)*exp(-140*mod(t,0.5))', 4),
      ]),
  },
  {
    kind: 'whoosh',
    name: 'whoosh',
    make: (out) =>
      build(out, [
        '-f', 'lavfi', '-i', `anoisesrc=color=pink:d=0.8:r=${RATE}:a=0.6`,
        '-af', 'highpass=f=350,lowpass=f=3200,afade=t=in:d=0.38:curve=qsin,afade=t=out:st=0.38:d=0.42:curve=qsin,flanger=delay=2:depth=6',
      ]),
  },
  {
    kind: 'plane',
    name: 'propeller plane flying over',
    make: (out) => {
      const f = '(96*(1.07-0.14*t/5))';
      const engine = [1, 2, 3, 4, 5, 6].map((n) => `${(1 / n).toFixed(2)}*sin(2*PI*${n}*${f}*t)`).join('+');
      return build(out, [
        ...src(`0.22*(${engine})*(0.7+0.3*sin(2*PI*21*t))*exp(-pow((t-2.4)/1.35,2))`, 5),
        '-af', 'lowpass=f=1800,aecho=0.8:0.4:60:0.2',
      ]);
    },
  },
];

/* --------------------------------------------------------------- layers -- */

/** Kinds built out of pack material, layered. */
async function layered(files: (pack: string, match: RegExp) => string[]): Promise<{ kind: SoundKind; name: string; make: (out: string) => Promise<number>; from: string[] }[]> {
  const bangs = files('oga-bang', /bang_(01|03|06|10)\.ogg$/);
  const cannons = files('oga-bang', /cannon_0[1-5]\.ogg$/);
  const shots = files('oga-bang', /shot_0[1-3]\.ogg$/);
  const subs = files('kenney-scifi', /lowFrequency_explosion_00[01]\.ogg$/);
  const crunch = files('kenney-scifi', /explosionCrunch_00[1-4]\.ogg$/);
  const out: { kind: SoundKind; name: string; make: (o: string) => Promise<number>; from: string[] }[] = [];

  bangs.forEach((bang, i) => {
    const sub = subs[i % subs.length]!;
    out.push({
      kind: 'explosion',
      name: `explosion ${i + 1}`,
      from: ['oga-bang', 'kenney-scifi'],
      make: (o) =>
        build(o, [
          '-i', bang, '-i', sub,
          '-filter_complex',
          '[0:a]aresample=48000,volume=1.0[b];[1:a]aresample=48000,lowpass=f=180,volume=1.6[s];' +
            '[b][s]amix=inputs=2:duration=longest:normalize=0,aecho=0.8:0.55:90|220|420:0.4|0.25|0.12,lowpass=f=6000[out]',
          '-map', '[out]',
        ]),
    });
  });
  crunch.forEach((file, i) =>
    out.push({
      kind: 'explosion',
      name: `explosion crunch ${i + 1}`,
      from: ['kenney-scifi'],
      make: (o) => build(o, ['-i', file, '-af', 'aecho=0.8:0.5:120|300:0.3|0.15,lowpass=f=7000']),
    }),
  );
  cannons.forEach((file, i) =>
    out.push({
      kind: 'cannon',
      name: `cannon ${i + 1}`,
      from: ['oga-bang', 'kenney-scifi'],
      make: (o) =>
        build(o, [
          '-i', file, '-i', subs[0]!,
          '-filter_complex',
          '[0:a]aresample=48000[c];[1:a]aresample=48000,lowpass=f=140,volume=0.9[s];' +
            '[c][s]amix=inputs=2:duration=longest:normalize=0,aecho=0.8:0.6:160|520:0.35|0.2[out]',
          '-map', '[out]',
        ]),
    }),
  );
  // Bursts: single shots, fast, each a little different in level and tone.
  for (const [name, count, every] of [['burst', 9, 0.075], ['long burst', 18, 0.068]] as const) {
    out.push({
      kind: 'machine-gun',
      name: `machine-gun ${name}`,
      from: ['oga-bang'],
      make: (o) => {
        const inputs = shots.flatMap((shot) => ['-i', shot]);
        const parts: string[] = [];
        const labels: string[] = [];
        for (let i = 0; i < count; i++) {
          const src = i % shots.length;
          const at = Math.round(i * every * 1000 + ((i * 37) % 11));
          parts.push(`[${src}:a]aresample=48000,atrim=0:0.2,volume=${(0.75 + ((i * 53) % 25) / 100).toFixed(2)},adelay=${at}|${at}[g${i}]`);
          labels.push(`[g${i}]`);
        }
        // Each source can feed several branches only through asplit.
        const splits = shots
          .map((_, s) => {
            const uses = labels.filter((_, i) => i % shots.length === s).length;
            return `[${s}:a]asplit=${uses}${Array.from({ length: uses }, (_, u) => `[in${s}_${u}]`).join('')}`;
          })
          .join(';');
        const used = new Map<number, number>();
        const branches = parts.map((part, i) => {
          const s = i % shots.length;
          const u = used.get(s) ?? 0;
          used.set(s, u + 1);
          return part.replace(`[${s}:a]`, `[in${s}_${u}]`);
        });
        return build(o, [
          ...inputs,
          '-filter_complex',
          `${splits};${branches.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0,aecho=0.8:0.4:60:0.25[out]`,
          '-map', '[out]',
        ]);
      },
    });
  }
  return out;
}

/* ---------------------------------------------------------------- build -- */

export async function buildSoundLibrary(options: { only?: SoundKind[] } = {}): Promise<SoundManifest> {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  const sounds: SoundEntry[] = [];
  const counter = new Map<SoundKind, number>();
  const wanted = (kind: SoundKind): boolean => options.only === undefined || options.only.includes(kind);
  const next = (kind: SoundKind): string => {
    const n = (counter.get(kind) ?? 0) + 1;
    counter.set(kind, n);
    return `${kind}-${String(n).padStart(2, '0')}.wav`;
  };

  // Clear the old files of the kinds being rebuilt, so a removed source does
  // not leave an orphan the manifest no longer describes.
  for (const name of fs.readdirSync(LIBRARY_DIR)) {
    const kind = name.replace(/-\d+\.wav$/, '');
    if (name.endsWith('.wav') && (SOUND_KINDS as readonly string[]).includes(kind) && wanted(kind as SoundKind)) {
      fs.rmSync(path.join(LIBRARY_DIR, name), { force: true });
    }
  }
  if (options.only !== undefined) {
    // Keep what was already built for the other kinds.
    try {
      const previous = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, 'manifest.json'), 'utf8')) as SoundManifest;
      for (const entry of previous.sounds) {
        if (!wanted(entry.kind)) {
          sounds.push(entry);
          const n = Number(/-(\d+)\.wav$/.exec(entry.file)?.[1] ?? 0);
          counter.set(entry.kind, Math.max(counter.get(entry.kind) ?? 0, n));
        }
      }
    } catch {
      // Nothing to keep.
    }
  }

  const packFiles = new Map<string, string[]>();
  for (const pack of PACKS) {
    try {
      packFiles.set(pack.id, await unpack(pack));
      log.info(`assets: ${pack.title} (${pack.author}, ${pack.licence})`);
    } catch (error) {
      log.warn(`assets: could not fetch ${pack.title} (${(error as Error).message})`);
      packFiles.set(pack.id, []);
    }
  }
  const files = (pack: string, match: RegExp): string[] => (packFiles.get(pack) ?? []).filter((file) => match.test(file));
  const packOf = (id: string): Pack => PACKS.find((pack) => pack.id === id)!;

  for (const pick of PACK_PICKS) {
    if (!wanted(pick.kind)) continue;
    const pack = packOf(pick.pack);
    for (const file of files(pick.pack, pick.match).slice(0, pick.limit ?? 99)) {
      const name = next(pick.kind);
      const durationMs = await finish(file, path.join(LIBRARY_DIR, name));
      sounds.push({ kind: pick.kind, file: name, durationMs, title: `${pack.title}: ${path.basename(file)}`, author: pack.author, licence: pack.licence, source: pack.page });
    }
  }

  for (const layer of await layered(files)) {
    if (!wanted(layer.kind)) continue;
    const name = next(layer.kind);
    const durationMs = await layer.make(path.join(LIBRARY_DIR, name));
    const from = layer.from.map(packOf);
    sounds.push({
      kind: layer.kind,
      file: name,
      durationMs,
      title: `${layer.name}, layered from ${from.map((pack) => pack.title).join(' and ')}`,
      author: [...new Set(from.map((pack) => pack.author))].join(', '),
      licence: 'CC0',
      source: from.map((pack) => pack.page).join(' ; '),
    });
  }

  for (const pick of COMMONS_PICKS) {
    if (!wanted(pick.kind)) continue;
    try {
      const info = await commonsInfo(pick.file);
      if (!ALLOWED.test(info.licence)) {
        log.warn(`assets: skipping "${pick.file}" -- licence is ${info.licence || 'unknown'}`);
        continue;
      }
      const raw = path.join(SRC, 'commons', pick.file.replace(/[^\w.() -]/g, '_'));
      await download(info.url, raw);
      const name = next(pick.kind);
      const durationMs = await finish(raw, path.join(LIBRARY_DIR, name), {
        ...(pick.start !== undefined ? { start: pick.start } : {}),
        ...(pick.duration !== undefined ? { duration: pick.duration } : {}),
      });
      const licence: Licence = /cc0/i.test(info.licence)
        ? 'CC0'
        : /public domain/i.test(info.licence)
          ? 'Public domain'
          : /4\.0/.test(info.licence)
            ? 'CC BY 4.0'
            : 'CC BY 3.0';
      sounds.push({ kind: pick.kind, file: name, durationMs, title: pick.file, author: info.author.slice(0, 120), licence, source: info.page });
      // Be gentle with the API.
      await new Promise((resolve) => setTimeout(resolve, 600));
    } catch (error) {
      log.warn(`assets: could not fetch "${pick.file}" (${(error as Error).message})`);
    }
  }

  for (const synth of SYNTHS) {
    if (!wanted(synth.kind)) continue;
    try {
      const name = next(synth.kind);
      const durationMs = await synth.make(path.join(LIBRARY_DIR, name));
      sounds.push({ kind: synth.kind, file: name, durationMs, title: synth.name, author: 'generated by BreezeMatic', licence: 'Generated', source: 'synthesised with ffmpeg' });
    } catch (error) {
      log.warn(`assets: could not make "${synth.name}" (${(error as Error).message.split('\n').slice(-3).join(' ')})`);
    }
  }

  sounds.sort((a, b) => (a.file < b.file ? -1 : 1));
  const manifest: SoundManifest = { v: 1, builtAt: new Date().toISOString(), sounds };
  fs.writeFileSync(path.join(LIBRARY_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(LIBRARY_DIR, 'CREDITS.txt'),
    `${sounds
      .map((s) => `${s.file}\t${s.licence}\t${s.author}\t${s.title}\t${s.source}`)
      .join('\n')}\n`,
    'utf8',
  );

  const byKind = new Map<string, number>();
  for (const sound of sounds) byKind.set(sound.kind, (byKind.get(sound.kind) ?? 0) + 1);
  const missing = SOUND_KINDS.filter((kind) => !byKind.has(kind));
  log.info(`assets: ${sounds.length} sounds in ${byKind.size} kinds${missing.length === 0 ? '' : `; missing ${missing.join(', ')}`}`);
  return manifest;
}
