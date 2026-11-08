import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { renderToStaticMarkup } from 'react-dom/server';
import { MODELS, env, workDir } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';
import { beatWords, type BeatSheet } from '../schema.js';
import { IMAGE_DIR } from './images.js';
import type { StickBeat } from './stickworld.js';
import { Figure, HERO, RIVAL, isOutfit, isProp } from '../remotion/stickman/figure.js';
import { Creature, creatureHeight, type CreatureName, type Gait } from '../remotion/stickman/creature.js';
import { isExpression } from '../remotion/stickman/face.js';
import { CREATURES } from '../remotion/stickman/vocab.js';

/**
 * A stick figure video's thumbnail, drawn from the video's own world.
 *
 * The picture thumbnails cut a subject out of a still and set words over it.
 * A stick figure video has no still with a subject in it -- its painted
 * places are empty sets, and the characters are drawn on top at render time --
 * so the editor's thumbnail button found "no still pictures" and did nothing.
 * So the thumbnail is composed the way the video is: the painted place from
 * the moment chosen, the hero in that moment's pose, face and uniform,
 * whoever it is up against beside it, two lines of words, and a one-word tag
 * on each of them (MILITARY, EMU) so the joke reads at thumbnail size.
 *
 * Vertical for a Short, 16:9 for a long video. One cheap text-model call
 * picks the moment and writes the words; without a key, the first moment with
 * an animal or a gag, and the title.
 */

export type Layout = 'portrait' | 'landscape';

const HALO = '#f6efe0';

/** Where everything goes, per shape. */
const GEOMETRY = {
  portrait: {
    W: 1080, H: 1920, ground: 1720, heroScale: 7, heroX: 460, soloX: 540, otherX: 830,
    heroLabel: { dy: 290, size: 40 }, otherLabelSize: 44, shade: 760,
  },
  // Words on the left, characters on the right: a widescreen frame has the
  // room to keep them apart, and a head under a headline reads as neither.
  landscape: {
    W: 1280, H: 720, ground: 700, heroScale: 4.1, heroX: 720, soloX: 900, otherX: 1050,
    heroLabel: { dy: 175, size: 26 }, otherLabelSize: 30, shade: 300,
  },
} as const;

export const shortThumbPath = (slug: string): string => path.join(workDir(slug), 'short-thumb.jpg');

/** What a thumbnail can be drawn from: a moment's words and its staging. */
export type Moment = { text: string; action: string | null; stage: StickBeat['stage'] | null };

export type Pick = { beat: number; line1: string; line2: string; heroLabel: string; otherLabel: string };

const SCHEMA = {
  type: 'object',
  properties: {
    beat: { type: 'integer' },
    line1: { type: 'string' },
    line2: { type: 'string' },
    heroLabel: { type: 'string' },
    otherLabel: { type: 'string' },
  },
  required: ['beat', 'line1', 'line2', 'heroLabel', 'otherLabel'],
};

export const caps = (text: unknown, max: number): string =>
  (typeof text === 'string' ? text : '').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);

/** The moments of a Short, from its beat sheet. */
export function momentsOfSheet(sheet: BeatSheet): Moment[] {
  return sheet.beats.map((beat) => ({
    text: beatWords(beat.lines).join(' '),
    action: beat.action ?? null,
    stage: (beat.stage as StickBeat['stage'] | null) ?? null,
  }));
}

/** The moments of a long video: each stick figure beat, with the words said during it. */
export function momentsOfScene(beats: readonly StickBeat[], lines: readonly { text: string; startMs: number; endMs: number }[]): Moment[] {
  return beats.map((beat) => ({
    text: lines
      .filter((line) => line.endMs > beat.startMs && line.startMs < beat.endMs)
      .map((line) => line.text)
      .join(' ')
      .slice(0, 300),
    action: beat.action,
    stage: beat.stage,
  }));
}

async function choose(topic: string, moments: readonly Moment[], seed: number, layout: Layout, avoid: readonly number[] = []): Promise<Pick> {
  const listed = moments.map((moment, i) => {
    const stage = moment.stage;
    const extras = [
      moment.action ?? 'stand',
      stage?.expression ?? '',
      stage?.creature ? `${stage.creatureCount ?? 'one'} ${stage.creature} (${stage.creatureRole ?? 'wild'})` : '',
      stage?.companion && stage.companion !== 'none' ? `with ${stage.companion}` : '',
      stage?.war?.gag && stage.war.gag !== 'none' ? `gag ${stage.war.gag}` : '',
      stage?.war?.map ? 'MAP (not drawable)' : '',
    ].filter(Boolean);
    return `${i}: "${moment.text}" [${extras.join(', ')}]`;
  });
  const usable = (i: number): boolean => !avoid.includes(i) && !moments[i]?.stage?.war?.map;
  const strong = moments.findIndex((m, i) => usable(i) && (m.stage?.creature !== undefined || (m.stage?.war?.gag ?? 'none') !== 'none'));
  const fallbackBeat = strong >= 0 ? strong : Math.max(0, moments.findIndex((_, i) => usable(i)));
  const fallback: Pick = { beat: fallbackBeat, line1: caps(topic.replace(/\(.*?\)/g, ''), 22), line2: '', heroLabel: '', otherLabel: '' };
  if (env.GEMINI_API_KEY === undefined) return fallback;

  try {
    const { value } = await cache.json<Pick>(
      'short-thumb',
      { v: 2, model: MODELS.llm.script, topic, beats: listed, seed, layout, avoid },
      async () => {
        const response = await generate({
          model: MODELS.llm.script,
          systemInstruction: 'You design YouTube thumbnails for a funny animated channel. You return JSON and nothing else.',
          prompt: [
            `A ${layout === 'portrait' ? 'vertical Shorts' : 'widescreen YouTube'} thumbnail for "${topic}", drawn from one of its`,
            'moments: the stick-figure hero in that moment\'s pose and face, with whoever it is up against beside it, on',
            'that moment\'s background.',
            '',
            'The moments:',
            ...listed,
            '',
            avoid.length === 0 ? '' : `Do not pick these moments, they are already used: ${avoid.join(', ')}.`,
            'Return:',
            '- beat: the index of the moment that makes the funniest, clearest thumbnail -- conflict, a reversal, an',
            '  animal or a rival on screen with the hero, a strong face. Never a MAP moment.',
            '- line1: 1 to 4 words, at most 18 characters, the setup or the hook, in capitals.',
            '- line2: 1 or 2 words, at most 12 characters, the punchline -- meme-literate and bold ("WASTED", "TO BIRDS",',
            '  "SKILL ISSUE", "HE LOST"), in capitals. Never a question.',
            '- heroLabel: one word naming who the hero is in that moment ("MILITARY", "NAPOLEON", "BRITAIN"), or "".',
            '- otherLabel: one word naming the other side ("EMU", "PIG", "USA"), or "" if nobody is with the hero.',
            'No emoji, no hashtags, no quotation marks.',
          ]
            .filter((line) => line !== '')
            .join('\n'),
          temperature: 0.7,
          seed: toInt32Seed(seed),
          maxOutputTokens: 256,
          responseSchema: SCHEMA,
        });
        return JSON.parse(response.text) as Pick;
      },
    );
    const beat = Number.isInteger(value.beat) && value.beat >= 0 && value.beat < moments.length && usable(value.beat) ? value.beat : fallback.beat;
    return {
      beat,
      line1: caps(value.line1, 18) || fallback.line1,
      line2: caps(value.line2, 12),
      heroLabel: caps(value.heroLabel, 10),
      otherLabel: caps(value.otherLabel, 10),
    };
  } catch (error) {
    log.warn(`thumbnail: the model could not pick a moment (${(error as Error).message}); using the first strong one`);
    return fallback;
  }
}

const Label: React.FC<{ x: number; y: number; text: string; size: number }> = ({ x, y, text, size }) =>
  text === '' ? null : (
    <text x={x} y={y} fontFamily="Arial Black, Impact, sans-serif" fontWeight={900} fontSize={size} fill="#ffffff"
      stroke="#111" strokeWidth={size * 0.24} paintOrder="stroke" textAnchor="middle" letterSpacing={size * 0.08}>
      {text}
    </text>
  );

/** The painted place of a moment, or the nearest moment that has one. */
function backgroundFor(moments: readonly Moment[], index: number): string | undefined {
  return (
    moments[index]?.stage?.background ??
    moments.slice(index).find((m) => m.stage?.background)?.stage?.background ??
    moments.find((m) => m.stage?.background)?.stage?.background
  );
}

/** Draws one thumbnail for a pick, to a file. */
export async function renderStickThumbnail(moments: readonly Moment[], pick: Pick, layout: Layout, file: string): Promise<void> {
  const g = GEOMETRY[layout];
  const { W, H } = g;
  const GROUND = g.ground;
  const moment = moments[pick.beat]!;
  const stage = moment.stage ?? ({} as NonNullable<Moment['stage']>);

  const background = backgroundFor(moments, pick.beat);
  const backgroundFile = background === undefined ? null : path.join(IMAGE_DIR, background);
  const bg = backgroundFile !== null && fs.existsSync(backgroundFile)
    ? `data:image/jpeg;base64,${(await sharp(backgroundFile).resize(W, H, { fit: 'cover' }).jpeg({ quality: 88 }).toBuffer()).toString('base64')}`
    : null;

  const war = stage.war;
  const outfit = isOutfit(war?.outfit) ? war.outfit : 'none';
  const expression = isExpression(stage.expression) ? stage.expression : 'shocked';
  const prop = isProp(stage.prop) ? stage.prop : 'none';
  const creature: CreatureName | null =
    typeof stage.creature === 'string' && stage.creature !== 'none' && (CREATURES as readonly string[]).includes(stage.creature)
      ? (stage.creature as CreatureName)
      : null;
  const rival = creature === null && stage.companion === 'rival';
  const pair = creature !== null || rival;
  // Clear of the edge: a leaning pose reaches a third of its height sideways.
  const heroX = pair ? g.heroX : g.soloX;
  const otherX = g.otherX;
  // A pose that holds still on a thumbnail; walking and running read as blur.
  const action = ['walk', 'run'].includes(moment.action ?? '') ? 'point' : (moment.action ?? 'stand');
  const role = stage.creatureRole ?? 'wild';
  const gait: Gait = role === 'enemy' ? 'kick' : role === 'fleeing' ? 'run' : 'stand';
  const creatureScale = creature === null ? 0 : g.heroScale * Math.min(2, Math.max(1, 32 / creatureHeight(creature))) * 0.95;
  // The tag sits on the body, not the neck: a bit under halfway up the animal.
  const otherLabelY = creature === null ? GROUND - g.heroLabel.dy - 60 : GROUND - creatureHeight(creature) * creatureScale * 0.42;

  const words =
    layout === 'portrait' ? (
      <>
        <text x={W / 2} y={300} fontFamily="Impact, Arial Black, sans-serif" fontSize={pick.line1.length > 12 ? 118 : 150}
          fill="#ffffff" stroke="#111" strokeWidth={12} paintOrder="stroke" textAnchor="middle" letterSpacing={2}>
          {pick.line1}
        </text>
        {pick.line2 === '' ? null : (
          <text x={W / 2} y={pick.line1.length > 12 ? 490 : 520} fontFamily="Impact, Arial Black, sans-serif"
            fontSize={pick.line2.length > 8 ? 170 : 210} fill="#ff3b30" stroke="#111" strokeWidth={14} paintOrder="stroke"
            textAnchor="middle" letterSpacing={3}>
            {pick.line2}
          </text>
        )}
      </>
    ) : (
      <>
        <text x={48} y={108} fontFamily="Impact, Arial Black, sans-serif" fontSize={pick.line1.length > 14 ? 66 : 80}
          fill="#ffffff" stroke="#111" strokeWidth={7} paintOrder="stroke" letterSpacing={2}>
          {pick.line1}
        </text>
        {pick.line2 === '' ? null : (
          <text x={48} y={216} fontFamily="Impact, Arial Black, sans-serif" fontSize={pick.line2.length > 8 ? 96 : 116}
            fill="#ff3b30" stroke="#111" strokeWidth={10} paintOrder="stroke" letterSpacing={2}>
            {pick.line2}
          </text>
        )}
      </>
    );

  const svg = renderToStaticMarkup(
    <svg xmlns="http://www.w3.org/2000/svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.7" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="vig" cx="0.5" cy="0.6" r="0.85">
          <stop offset="0.55" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.55" />
        </radialGradient>
      </defs>
      {bg === null ? <rect width={W} height={H} fill="#2a2a33" /> : <image href={bg} x={0} y={0} width={W} height={H} />}
      <rect width={W} height={H} fill="url(#vig)" />
      <rect width={W} height={g.shade} fill="url(#top)" />

      <Figure action={action} progress={0.6} t={0.3} x={heroX} groundY={GROUND} scale={g.heroScale} facingRight={pair}
        expression={expression} look={HERO} prop={prop} halo={HALO} appear={1} phase={0} outfit={outfit} />
      {creature === null ? null : (
        <Creature name={creature} x={otherX} groundY={GROUND} scale={creatureScale} facingRight={false} gait={gait}
          mood={role === 'enemy' ? 'angry' : role === 'fleeing' ? 'scared' : 'calm'} t={0.2} phase={0} halo={HALO} />
      )}
      {rival ? (
        <Figure action="proud" progress={0.5} t={0.3} x={otherX} groundY={GROUND} scale={g.heroScale} facingRight={false}
          expression={isExpression(stage.companionExpression) ? stage.companionExpression : 'smug'} look={RIVAL} prop="none"
          halo={HALO} appear={1} phase={0} outfit={isOutfit(war?.rivalOutfit) ? war.rivalOutfit : 'none'} />
      ) : null}

      <Label x={heroX} y={GROUND - g.heroLabel.dy} text={pick.heroLabel} size={g.heroLabel.size} />
      {pair ? <Label x={otherX + (creature === null ? 0 : layout === 'portrait' ? 30 : 20)} y={otherLabelY} text={pick.otherLabel} size={g.otherLabelSize} /> : null}
      {words}
    </svg>,
  );

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // YouTube's limit is 2 MB; a JPEG this size is a few hundred KB.
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(file);
}

/** Picks a moment and draws it. `avoid` keeps several options on different moments. */
export async function drawStickThumbnail(options: {
  topic: string;
  moments: readonly Moment[];
  seed: number;
  layout: Layout;
  file: string;
  avoid?: readonly number[];
}): Promise<Pick | null> {
  if (!options.moments.some((moment) => moment.stage !== null)) return null;
  const pick = await choose(options.topic, options.moments, options.seed, options.layout, options.avoid ?? []);
  await renderStickThumbnail(options.moments, pick, options.layout, options.file);
  log.info(`thumbnail: "${pick.line1}${pick.line2 === '' ? '' : ` / ${pick.line2}`}" from moment ${pick.beat + 1}`);
  return pick;
}

/* ------------------------------------------------------------------ Shorts */

/** Whether the Short's thumbnail was made by hand, which nothing automatic replaces. */
export function shortThumbIsCustom(slug: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(workDir(slug), 'short-thumb.json'), 'utf8')) as { custom?: boolean }).custom === true;
  } catch {
    return false;
  }
}

/**
 * A Short's vertical thumbnail. `variant` picks again -- another moment,
 * other words -- for "New thumbnail". `replaceCustom` is only ever true when a
 * person asked for a new one.
 */
export async function makeShortThumbnail(
  sheet: BeatSheet,
  options: { variant?: number; replaceCustom?: boolean } = {},
): Promise<string | null> {
  const slug = sheet.meta.slug;
  if (options.replaceCustom !== true && shortThumbIsCustom(slug) && fs.existsSync(shortThumbPath(slug))) {
    return shortThumbPath(slug);
  }
  const pick = await drawStickThumbnail({
    topic: sheet.meta.topic,
    moments: momentsOfSheet(sheet),
    seed: (sheet.meta.seed + (options.variant ?? 0) * 7919) >>> 0,
    layout: 'portrait',
    file: shortThumbPath(slug),
  });
  if (pick === null) return null;
  fs.writeFileSync(path.join(workDir(slug), 'short-thumb.json'), `${JSON.stringify({ ...pick, custom: false }, null, 2)}\n`);
  return shortThumbPath(slug);
}
