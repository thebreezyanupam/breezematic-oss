import React from 'react';
import { AmbientLife, ambienceFor } from './stickman/ambience.js';
import { Chair, Crate } from './stickman/furniture.js';
import { Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { RENDER } from '../design.js';
import { beatRng } from '../rng.js';
import { DepthPlate, type Parallax } from './DepthPlate.js';
import { Figure, FRIEND, HERO, RIVAL, isOutfit, isProp, type Look, type Outfit, type PropName } from './stickman/figure.js';
import { MapScene } from './war/MapScene.js';
import { COMPANIONS, CREATURES, CREATURE_ROLES } from './stickman/vocab.js';
import { Creature, type CreatureName } from './stickman/creature.js';
import { creatureLayout } from './stickman/herd.js';
import { Sticker } from './war/Sticker.js';
import type { WarDirection } from '../stages/warmap.js';
import { isExpression, type Expression } from './stickman/face.js';
import { GROUND, H, HALO, Scene, W, WeatherLayer, WeatherTint, isScene, isWeather, type SceneName } from './stickman/scenes.js';

/**
 * The stick figure world.
 *
 * It used to be one white stick figure on an empty dark stage. Now it is a
 * place: a city, a forest, a library, a castle -- drawn in flat 2D layers with
 * things moving in them -- and the figure has a face that shows what the
 * narration is feeling, holds things, and is sometimes not alone. The
 * direction for each beat (where, what face, what it holds, who else is there,
 * the weather) comes with the beat; anything missing falls back to something
 * sensible for the action, so an old sheet still renders.
 *
 * Everything is drawn in one SVG at the frame's own size, which keeps the
 * figure, its props and the world in one coordinate system.
 */

export type StageDirection = {
  /** The painted background's depth map, and how near its floor is. */
  depth?: string;
  floor?: number;
  /** A painted background under public/images, used instead of the drawn scene. */
  background?: string;
  scene?: string;
  expression?: string;
  prop?: string;
  companion?: string;
  companionExpression?: string;
  weather?: string;
  /** The place in words, which also says what moves in it (ambience.tsx). */
  setting?: string;
  /** Animals in the beat: which, how many, and what they are doing. */
  creature?: string;
  creatureCount?: string;
  creatureRole?: string;
  /** The war channel's extras: map, gags, stickers, uniforms. */
  war?: WarDirection;
};

/** The two sides, as a soldier in the ranks wears them. */
const SIDE_LOOK: Record<'ours' | 'theirs', Look> = {
  ours: { accent: '#3f5f8f', shoes: '#2b2d3a', wear: 'none', hair: 'bald' },
  theirs: { accent: '#9a3a2e', shoes: '#2b2d3a', wear: 'none', hair: 'bald' },
};

/** The face an action wears when the direction does not say. */
const FACE_FOR: Record<string, Expression> = {
  run: 'determined',
  walk: 'neutral',
  fall: 'shocked',
  jump: 'happy',
  think: 'thinking',
  search: 'confused',
  point: 'surprised',
  reach: 'determined',
  push: 'determined',
  carry: 'tired',
  celebrate: 'laughing',
  sit: 'tired',
  shrug: 'confused',
  wave: 'happy',
  talk: 'happy',
  cower: 'scared',
  read: 'thinking',
  facepalm: 'tired',
  kneel: 'sad',
  proud: 'smug',
  stand: 'neutral',
};

const PROP_FOR: Record<string, PropName> = { search: 'magnifier', read: 'book', carry: 'box' };

/** Rig units to pixels: the figure stands a bit under a third of the frame. */
const FIGURE_SCALE = 5.4;

/** Confetti for celebrate: falling, spinning, many colours. */
const Confetti: React.FC<{ seed: number; t: number; since: number }> = ({ seed, t, since }) => {
  const r = beatRng(seed, 'confetti');
  const colours = ['#e8412c', '#ffc53d', '#3aa0ff', '#4fbf8a', '#ff8fa3', '#9b6bff'];
  return (
    <g>
      {Array.from({ length: 70 }, (_, i) => {
        const x = r() * W + Math.sin(t * 2 + i) * 30;
        const y = -60 + ((r() * 600 + since * (260 + r() * 200)) % (H + 100));
        return (
          <rect key={i} x={x} y={y} width={16} height={9} fill={colours[i % colours.length]} transform={`rotate(${t * 300 + i * 37} ${x + 8} ${y + 4})`} />
        );
      })}
    </g>
  );
};

/** Speed lines behind a runner, and puffs of dust at its heels. */
const SpeedLines: React.FC<{ x: number; facingRight: boolean; t: number }> = ({ x, facingRight, t }) => {
  const behind = facingRight ? -1 : 1;
  return (
    <g>
      {Array.from({ length: 7 }, (_, i) => {
        const y = GROUND - 80 - i * 55;
        const len = 120 + ((i * 53 + Math.floor(t * 20) * 17) % 90);
        const start = x + behind * (90 + (i % 3) * 20);
        return <path key={i} d={`M${start},${y} L${start + behind * len},${y}`} stroke="#ffffff" strokeWidth={6} strokeLinecap="round" opacity={0.55} />;
      })}
      {[0, 1, 2].map((i) => {
        const phase = (t * 3 + i / 3) % 1;
        return (
          <circle key={i} cx={x + behind * (40 + phase * 120)} cy={GROUND - 10 - phase * 30} r={14 + phase * 20} fill="#d8cfc0" opacity={0.55 * (1 - phase)} />
        );
      })}
    </g>
  );
};

/** Stars and a burst where something landed hard. */
const Impact: React.FC<{ x: number; y: number; t: number; strength: number }> = ({ x, y, t, strength }) => (
  <g opacity={strength}>
    {Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2;
      return <path key={i} d={`M${x + Math.cos(a) * 60},${y + Math.sin(a) * 30} L${x + Math.cos(a) * 110},${y + Math.sin(a) * 60}`} stroke="#ffd23f" strokeWidth={7} strokeLinecap="round" />;
    })}
    {[0, 1, 2].map((i) => {
      const a = t * 4 + (i / 3) * Math.PI * 2;
      const sx = x + Math.cos(a) * 70;
      const sy = y - 120 + Math.sin(a) * 20;
      return <path key={i} transform={`translate(${sx},${sy}) scale(1.4)`} d="M0,-10 L3,-3 L10,-3 L4,2 L6,10 L0,5 L-6,10 L-4,2 L-10,-3 L-3,-3 Z" fill="#ffe86b" stroke="#1d1b24" strokeWidth={1.5} />;
    })}
  </g>
);

/**
 * What part of the world the frame shows. A short sees all of it, sky to
 * floor. A long video is landscape, so it sees a band of the same world
 * around the floor -- the figure a little smaller, the ground in the same
 * place -- which is why one set of drawings serves both.
 */
function viewFor(orientation: 'portrait' | 'landscape'): { x: number; y: number; w: number; h: number; scale: number } {
  if (orientation === 'portrait') return { x: 0, y: 0, w: W, h: H, scale: 1 };
  const h = (W * 9) / 16;
  // The figure about half the frame tall, standing low: the top third is the
  // captions', and a head up in it had the words running across its face.
  return { x: 0, y: GROUND - h * 0.86, w: W, h, scale: 0.46 };
}

export const Stickman: React.FC<{
  /** The beat's identity and where it starts on the video's clock. */
  beat: { id: string; startMs: number };
  action: string;
  seed: number;
  durationInFrames: number;
  direction?: StageDirection | null;
  /** The scene of the beat before, so a change of place can be shown as one. */
  previousScene?: string | null;
  orientation?: 'portrait' | 'landscape';
}> = ({ beat, action, seed, durationInFrames, direction, previousScene, orientation = 'portrait' }) => {
  const live = useCurrentFrame();
  const { fps, width: frameWidth, height: frameHeight } = useVideoConfig();
  const war = direction?.war;
  const gagFrame =
    war !== undefined && war.gag !== 'none' && typeof war.gagAtMs === 'number'
      ? Math.max(0, Math.round(((war.gagAtMs - beat.startMs) / 1000) * fps))
      : null;
  /**
   * A freeze-frame holds everything -- figure, camera, weather -- at the
   * frame the word lands on, which is what makes it read as the edit stopping
   * rather than the character standing still.
   */
  const frozen = war?.gag === 'freeze' && gagFrame !== null && live > gagFrame;
  const frame = frozen ? gagFrame : live;
  const progress = durationInFrames <= 1 ? 0 : frame / (durationInFrames - 1);
  // Time since the video began, so clouds and loops carry on across beats
  // instead of restarting at every cut.
  const t = beat.startMs / 1000 + frame / fps;
  const since = frame / fps;
  const view = viewFor(orientation);
  const background = typeof direction?.background === 'string' && direction.background !== '' ? direction.background : null;

  const rng = beatRng(seed, `${beat.id}-stage`);
  const scene: SceneName = isScene(direction?.scene) ? direction.scene : 'city';
  const expression: Expression = isExpression(direction?.expression) ? direction.expression : (FACE_FOR[action] ?? 'neutral');
  const prop: PropName = isProp(direction?.prop) && direction.prop !== 'none' ? direction.prop : (PROP_FOR[action] ?? 'none');
  const weather = isWeather(direction?.weather) ? direction.weather : 'clear';
  const companion = (COMPANIONS as readonly string[]).includes(direction?.companion ?? '')
    ? (direction!.companion as (typeof COMPANIONS)[number])
    : 'none';
  const companionFace: Expression = isExpression(direction?.companionExpression) ? direction.companionExpression : 'neutral';
  const halo = HALO[scene];
  const creature: CreatureName | null =
    typeof direction?.creature === 'string' && direction.creature !== 'none' && (CREATURES as readonly string[]).includes(direction.creature)
      ? (direction.creature as CreatureName)
      : null;
  const creatureRole: (typeof CREATURE_ROLES)[number] = (CREATURE_ROLES as readonly string[]).includes(direction?.creatureRole ?? '')
    ? (direction!.creatureRole as (typeof CREATURE_ROLES)[number])
    : 'wild';
  const creatureCount = direction?.creatureCount === 'herd' ? 7 : direction?.creatureCount === 'few' ? 3 : 1;
  // Animals that come at the hero or run from it need it facing them, off to one side.
  const facesCreatures = creature !== null && (creatureRole === 'enemy' || creatureRole === 'fleeing');

  /**
   * Where everyone stands. Alone, the hero takes the middle with a little
   * seeded drift; with somebody, the two face each other across the frame.
   * Walking and running cross the stage as the beat goes on.
   */
  const paired = companion === 'friend' || companion === 'rival';
  const facingRight = paired ? true : rng() < 0.5 || facesCreatures;
  const travel = action === 'walk' ? 160 : action === 'run' ? 320 : 0;
  // With animals at its side the hero stands forward, so they have room behind it.
  const alliesBehind = creature !== null && creatureRole === 'ally';
  const heroX =
    (paired || facesCreatures
      ? W * 0.34
      : alliesBehind
        ? (facingRight ? W * 0.64 : W * 0.36)
        : W * (0.5 + (rng() * 2 - 1) * 0.07)) +
    (facingRight ? 1 : -1) * travel * (progress - 0.5);

  // The camera drifts, so the world has depth even when nobody moves.
  // Wide enough that the layers visibly slide past each other: far hills a
  // little, near trees more, the floor and the figure not at all.
  const pan = Math.sin(t * 0.15) * 70 - progress * 30;

  /**
   * The camera in a painted place, moving through its depth.
   *
   * On the video's clock, not the beat's, so a stretch of beats in one place
   * is one continuous move rather than a camera that jumps back at every cut:
   * a slow sway side to side and a slow push in and out, on periods that do
   * not line up, so it never visibly repeats. The amounts sit inside what the
   * long-form parallax uses; past them the shader has to invent what was
   * behind things, and invented background gives the effect away.
   */
  const depthFile = typeof direction?.depth === 'string' && direction.depth !== '' ? direction.depth : null;
  const floor = typeof direction?.floor === 'number' ? direction.floor : 0.85;
  const phaseOf = (background ?? '').split('').reduce((sum, c) => sum + c.charCodeAt(0), 0) % 628 / 100;
  const parallax: Parallax = {
    shift: [0.075 * Math.sin((t * Math.PI * 2) / 15 + phaseOf), 0],
    zoom: 0.14 * (0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 23 + phaseOf * 1.7)),
  };
  const plateScale = 1.08;
  /**
   * Where the floor under the figure goes when the camera moves: the same
   * formula the shader uses for a surface at the floor's depth, so the
   * characters stay standing on it instead of sliding across it.
   */
  const k = floor - 0.5;
  const footX = 0.5;
  const footY = (GROUND - view.y) / view.h;
  const floorDx = depthFile === null ? 0 : ((footX - 0.5) * parallax.zoom * k + parallax.shift[0] * k) * plateScale * view.w;
  const floorDy = depthFile === null ? 0 : (footY - 0.5) * parallax.zoom * k * plateScale * view.h;

  // A change of place arrives as a quick camera whip rather than a hard cut.
  const changed = previousScene !== undefined && previousScene !== null && previousScene !== scene;
  const whip = changed
    ? interpolate(frame, [0, 10], [1, 0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) })
    : 0;

  const appear = interpolate(frame, [4, 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  if (war?.map !== undefined && war.map !== null) {
    return (
      <div style={{ position: 'absolute', inset: 0 }}>
        <MapScene map={war.map} durationInFrames={durationInFrames} outfit={war.outfit} t={t} />
        {war.sticker === null || typeof war.stickerAtMs !== 'number' ? null : (
          <Sticker icon={war.sticker.icon} text={war.sticker.text} fromFrame={Math.round(((war.stickerAtMs - beat.startMs) / 1000) * fps)} />
        )}
        {/* The words' band across the top, darkened as it is over the world. */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '34%', background: 'linear-gradient(#000000a8, #00000000)' }} />
      </div>
    );
  }

  /**
   * The editing jokes, on the word they belong to.
   *
   * A zoom snaps in on the face in four frames and holds, the way a reaction
   * shot is cut; a shake is violent and brief and decays; a freeze goes grey
   * and pushes in a touch. All three move the whole world, not just the
   * figure, because they are the camera doing something, not the character.
   */
  const gagSince = gagFrame === null ? -1 : live - gagFrame;
  const zoomAmount =
    war?.gag === 'zoom' && gagSince >= 0
      ? interpolate(gagSince, [0, 4, 4 + fps * 1.1, 4 + fps * 1.5], [1, 1.5, 1.5, 1], {
          extrapolateRight: 'clamp',
          easing: Easing.out(Easing.cubic),
        })
      : 1;
  const shake =
    war?.gag === 'shake' && gagSince >= 0 && gagSince < fps * 0.7 ? Math.pow(1 - gagSince / (fps * 0.7), 2) : 0;
  const shakeX = shake * Math.sin(gagSince * 1.9) * 26;
  const shakeY = shake * Math.cos(gagSince * 2.7) * 18;
  const freezeZoom = frozen ? 1.06 : 1;
  const heroOutfit: Outfit = isOutfit(war?.outfit) ? war.outfit : 'none';
  const rivalOutfit: Outfit = isOutfit(war?.rivalOutfit) ? war.rivalOutfit : 'none';
  const settle = interpolate(frame, [0, 7], [18, 0], { extrapolateRight: 'clamp' });

  const figureAt = (x: number, right: boolean, look: Look, face: Expression, act: string, held: PropName, phase: number, scale = FIGURE_SCALE, ground = GROUND, outfit: Outfit = 'none'): React.ReactElement => (
    <Figure
      outfit={outfit}
      action={act}
      progress={progress}
      t={t}
      x={x}
      groundY={ground}
      scale={scale * view.scale}
      facingRight={right}
      expression={face}
      look={look}
      prop={held}
      halo={halo}
      appear={appear}
      phase={phase}
    />
  );

  // Where the hero's face is on screen, so a zoom lands on it.
  const faceX = ((heroX - view.x) / view.w) * 100;
  const faceY = orientation === 'landscape' ? 52 : 58;

  return (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: '#0b0b10', overflow: 'hidden' }}>
    <div
      style={{
        position: 'absolute',
        inset: 0,
        transform: `translate(${shakeX}px,${shakeY}px) scale(${zoomAmount * freezeZoom})`,
        transformOrigin: `${faceX}% ${faceY}%`,
        filter: frozen ? 'grayscale(1) contrast(1.15)' : undefined,
      }}
    >
      {/* A painted place, when there is one: an <Img> so the frame waits for it to load. */}
      {background === null ? null : (
        depthFile === null ? (
          <Img
            src={staticFile(`images/${background}`)}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: `translateX(${(whip * 360 * frameWidth) / view.w}px) scale(${1.04 + Math.sin(t * 0.12) * 0.01})`,
              opacity: 1 - whip * 0.5,
            }}
          />
        ) : (
          <DepthPlate
            key={background}
            src={staticFile(`images/${background}`)}
            depthSrc={staticFile(`images/${depthFile}`)}
            parallax={parallax}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: `translateX(${(whip * 360 * frameWidth) / view.w}px) scale(${plateScale})`,
              opacity: 1 - whip * 0.5,
            }}
          />
        )
      )}
      <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} width={frameWidth} height={frameHeight} style={{ position: 'absolute', inset: 0 }}>
        <g transform={`translate(${whip * 360},0)`} opacity={1 - whip * 0.5}>
          {background === null ? <Scene name={scene} seed={seed} t={t} pan={pan} /> : null}
          <WeatherTint weather={weather} />
          {/* What moves in the place: birds, smoke on the horizon, dust in a room. */}
          <AmbientLife kinds={ambienceFor({ ...direction, scene })} t={t} seed={seed} id={background ?? scene} view={view} />

          {/* Everyone and everything standing on the floor moves with it. */}
          <g transform={`translate(${floorDx},${floorDy})`}>
          {/* A crowd further back: the world has other people in it. */}
          {companion === 'crowd'
            ? [0, 1, 2, 3].map((i) => {
                const r = beatRng(seed, `${beat.id}-crowd-${i}`);
                const looks: Look[] = [
                  { accent: '#4fbf8a', shoes: '#2b2d3a', wear: 'cap', hair: 'bald' },
                  { accent: '#ff8fa3', shoes: '#2b2d3a', wear: 'bow', hair: 'long' },
                  { accent: '#3aa0ff', shoes: '#2b2d3a', wear: 'beanie', hair: 'bald' },
                  { accent: '#f08a3c', shoes: '#2b2d3a', wear: 'none', hair: 'spikes' },
                ];
                const x = [140, 360, 720, 940][i]!;
                const acts = ['talk', 'stand', 'point', 'shrug'];
                return (
                  <g key={i} opacity={0.92}>
                    {figureAt(x, x < W / 2, looks[i]!, companionFace, acts[Math.floor(r() * acts.length)]!, 'none', i * 0.7 + 1, 3.1, GROUND - 70)}
                  </g>
                );
              })
            : null}

          {/* Animals minding their own business go at the back, behind everyone. */}
          {creature !== null && creatureRole === 'wild'
            ? creatureLayout({ name: creature, role: 'wild', count: creatureCount, heroX, facingRight, progress, seed, id: beat.id, scale: FIGURE_SCALE * view.scale })
                .map((c, i) => (
                  <Creature key={`wild${i}`} name={creature} x={c.x} groundY={c.ground} scale={c.scale} facingRight={c.right} gait={c.gait} mood="calm" t={t} phase={i * 0.37} halo={halo} appear={appear} />
                ))
            : null}

          {/* Ranks: the hero's side behind it on the left, the enemy across the field. */}
          {companion === 'army' || companion === 'armies'
            ? [0, 1, 2, 3, 4].map((i) =>
                <g key={`ours${i}`} opacity={0.95}>
                  {figureAt(70 + i * 105, true, SIDE_LOOK.ours, i % 2 === 0 ? 'determined' : 'neutral', 'walk', 'rifle', i * 0.37, 3.3, GROUND - 60 - (i % 2) * 18, heroOutfit === 'none' ? 'helmet' : heroOutfit)}
                </g>)
            : null}
          {companion === 'enemy-army' || companion === 'armies'
            ? [0, 1, 2, 3, 4].map((i) =>
                <g key={`theirs${i}`} opacity={0.95}>
                  {figureAt(W - 70 - i * 105, false, SIDE_LOOK.theirs, i % 2 === 0 ? 'angry' : 'smug', 'walk', 'rifle', i * 0.41 + 0.2, 3.3, GROUND - 60 - (i % 2) * 18, rivalOutfit === 'none' ? 'pickelhaube' : rivalOutfit)}
                </g>)
            : null}
          {/* Animals in the story: charging the hero, marching with it, or running away. */}
          {creature !== null && creatureRole !== 'wild'
            ? creatureLayout({ name: creature, role: creatureRole, count: creatureCount, heroX, facingRight, progress, seed, id: beat.id, scale: FIGURE_SCALE * view.scale })
                .map((c, i) => (
                  <Creature
                    key={`beast${i}`}
                    name={creature}
                    x={c.x}
                    groundY={c.ground}
                    scale={c.scale}
                    facingRight={c.right}
                    gait={c.gait}
                    mood={creatureRole === 'enemy' ? 'angry' : creatureRole === 'fleeing' ? 'scared' : 'calm'}
                    t={t}
                    phase={i * 0.29}
                    halo={halo}
                  />
                ))
            : null}
          {action === 'sit' ? <Chair x={heroX} groundY={GROUND} scale={FIGURE_SCALE * view.scale} facingRight={facingRight} /> : null}
          {action === 'push' ? <Crate x={heroX + (facingRight ? 1 : -1) * 46 * FIGURE_SCALE * view.scale} groundY={GROUND} scale={FIGURE_SCALE * view.scale} /> : null}
          {action === 'run' ? <SpeedLines x={heroX} facingRight={facingRight} t={t} /> : null}

          {paired
            ? figureAt(W * 0.72, false, companion === 'rival' ? RIVAL : FRIEND, companionFace, companion === 'rival' ? 'proud' : 'talk', 'none', 1.7, FIGURE_SCALE, GROUND, companion === 'rival' ? rivalOutfit : 'none')
            : null}

          <g transform={`translate(0,${settle})`}>{figureAt(heroX, facingRight, HERO, expression, action, prop, 0, FIGURE_SCALE, GROUND, heroOutfit)}</g>

          {action === 'fall' && progress > 0.7 ? (
            <Impact x={heroX} y={GROUND - 40} t={t} strength={Math.min(1, (progress - 0.7) / 0.1)} />
          ) : null}
          </g>
          {action === 'celebrate' ? <Confetti seed={seed} t={t} since={since} /> : null}

          <WeatherLayer weather={weather} seed={seed} t={t} />
        </g>

        {/* The top of the frame belongs to the words: darkened, so type in light
            ink reads over a bright sky as well as a night one. */}
        <defs>
          <linearGradient id="caption-scrim" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#000000" stopOpacity={0.62} />
            <stop offset="0.3" stopColor="#000000" stopOpacity={0.42} />
            <stop offset="0.52" stopColor="#000000" stopOpacity={0} />
          </linearGradient>
          <radialGradient id="vignette" cx="0.5" cy="0.55" r="0.75">
            <stop offset="0.6" stopColor="#000000" stopOpacity={0} />
            <stop offset="1" stopColor="#000000" stopOpacity={0.45} />
          </radialGradient>
        </defs>
        <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="url(#caption-scrim)" />
        <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="url(#vignette)" />
      </svg>
    </div>
      {war?.sticker === null || war?.sticker === undefined || typeof war.stickerAtMs !== 'number' ? null : (
        <Sticker icon={war.sticker.icon} text={war.sticker.text} fromFrame={Math.round(((war.stickerAtMs - beat.startMs) / 1000) * fps)} />
      )}
    </div>
  );
};
