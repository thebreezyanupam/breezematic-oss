import React from 'react';
import type { CREATURES } from './vocab.js';

/**
 * Animals, in the stick figure's own hand.
 *
 * History has a lot of animals in it that are the story rather than the
 * scenery -- the emus that beat an army, Hannibal's elephants, the pigeon that
 * carried the message, the bear that carried shells, the pig that started a
 * war -- and a video about the Great Emu War with no emu in it is a video about
 * a man in a field. So they are drawn, and drawn the way the figures are:
 * flat fills, a dark ink line with a pale halo round it, a big white eye, and
 * legs that actually walk.
 *
 * Two rigs, not fourteen drawings. A bird is a body on two legs with a neck
 * and a beak; a four-legged animal is a body on four with a neck and a head.
 * Everything that makes an emu an emu or a pig a pig is a number or a flag in
 * its spec, so an animal is a line in a table and they all move alike.
 *
 * Every animal is drawn facing left (-x) with its feet on y = 0, in the same
 * units as the figure, which stands about 100 tall.
 */

export type CreatureName = Exclude<(typeof CREATURES)[number], 'none'>;
/**
 * `kick` is a bird's front leg driven forward and up with the body leaning
 * back into it -- an emu's actual attack, and the one pose a thumbnail about
 * the Emu War needed. A four-legged animal has no kick and stands.
 */
export type Gait = 'stand' | 'walk' | 'run' | 'peck' | 'kick';
export type Mood = 'calm' | 'angry' | 'scared';

const INK = '#1d1b24';

type Bird = {
  rig: 'bird';
  body: [number, number];
  /** Height of the body's centre above the ground. */
  hip: number;
  /** Hip to foot, knee included. */
  leg: number;
  neck: number;
  /** Neck angle forward from upright, in degrees. */
  lean: number;
  neckWidth: number;
  head: number;
  beak: number;
  fill: string;
  neckFill: string;
  legColour: string;
  beakColour: string;
  tail: 'plume' | 'fan' | 'short';
  shaggy?: boolean;
  comb?: string;
};

type Quad = {
  rig: 'quad';
  body: [number, number];
  leg: number;
  legWidth: number;
  neck: number;
  /** Neck angle up from forward-horizontal, in degrees. */
  lift: number;
  neckWidth: number;
  head: [number, number];
  /** How far the head is turned nose-down, in degrees. */
  tilt: number;
  fill: string;
  /** Hooves, paws, feet: the colour at the bottom of each leg. */
  foot: string;
  ears: 'horse' | 'point' | 'flop' | 'round' | 'side' | 'big';
  tail: 'long' | 'thin' | 'up' | 'curl' | 'curly' | 'short' | 'tuft' | 'whip';
  snout?: 'dog' | 'disc' | 'bear';
  mane?: string;
  hump?: boolean;
  trunk?: boolean;
  horns?: 'back' | 'side';
  beard?: boolean;
  spots?: string;
};

export const CREATURE_SPECS: Record<CreatureName, Bird | Quad> = {
  emu: {
    rig: 'bird', body: [25, 16], hip: 58, leg: 46, neck: 36, lean: 16, neckWidth: 6, head: 6, beak: 7,
    fill: '#5f4c3d', neckFill: '#72849c', legColour: '#6f6a63', beakColour: '#2f2a26', tail: 'plume', shaggy: true,
  },
  chicken: {
    rig: 'bird', body: [11, 9], hip: 15, leg: 11, neck: 7, lean: 18, neckWidth: 6, head: 5, beak: 3.5,
    fill: '#f3ecdf', neckFill: '#f3ecdf', legColour: '#e2a033', beakColour: '#e2a033', tail: 'fan', comb: '#d8342c',
  },
  pigeon: {
    rig: 'bird', body: [9, 6], hip: 9, leg: 6, neck: 5, lean: 26, neckWidth: 5, head: 3.8, beak: 2.6,
    fill: '#8f99a8', neckFill: '#5f8f80', legColour: '#d0625a', beakColour: '#3a3a40', tail: 'short',
  },
  goose: {
    rig: 'bird', body: [16, 10], hip: 18, leg: 11, neck: 19, lean: 6, neckWidth: 4.5, head: 4.6, beak: 5.5,
    fill: '#f3f1ec', neckFill: '#f3f1ec', legColour: '#ef8a2c', beakColour: '#ef8a2c', tail: 'short',
  },
  horse: {
    rig: 'quad', body: [34, 14], leg: 44, legWidth: 7, neck: 30, lift: 52, neckWidth: 12, head: [14, 6.5], tilt: 58,
    fill: '#7b4a2c', foot: '#2b2320', ears: 'horse', tail: 'long', mane: '#2b1d17',
  },
  camel: {
    rig: 'quad', body: [34, 13], leg: 54, legWidth: 7, neck: 34, lift: 58, neckWidth: 9, head: [11, 5.5], tilt: 14,
    fill: '#c69a5d', foot: '#8a6a45', ears: 'side', tail: 'thin', hump: true,
  },
  elephant: {
    rig: 'quad', body: [44, 29], leg: 36, legWidth: 17, neck: 0, lift: 0, neckWidth: 0, head: [21, 21], tilt: 0,
    fill: '#8b919b', foot: '#6f747d', ears: 'big', tail: 'thin', trunk: true,
  },
  dog: {
    rig: 'quad', body: [18, 8], leg: 17, legWidth: 4.5, neck: 9, lift: 48, neckWidth: 7, head: [8, 6], tilt: 8,
    fill: '#b87a40', foot: '#b87a40', ears: 'flop', tail: 'up', snout: 'dog',
  },
  cat: {
    rig: 'quad', body: [14, 6.5], leg: 11, legWidth: 3.6, neck: 5, lift: 50, neckWidth: 5, head: [6.5, 6], tilt: 0,
    fill: '#e38b3a', foot: '#e38b3a', ears: 'point', tail: 'curl',
  },
  bear: {
    rig: 'quad', body: [31, 18], leg: 21, legWidth: 12, neck: 8, lift: 22, neckWidth: 16, head: [12, 11], tilt: 8,
    fill: '#5a3a26', foot: '#3d271a', ears: 'round', tail: 'short', snout: 'bear',
  },
  goat: {
    rig: 'quad', body: [19, 10], leg: 21, legWidth: 4.5, neck: 12, lift: 56, neckWidth: 7, head: [9, 5], tilt: 32,
    fill: '#e9e2d3', foot: '#4a4038', ears: 'side', tail: 'short', horns: 'back', beard: true,
  },
  cow: {
    rig: 'quad', body: [33, 16], leg: 26, legWidth: 8, neck: 10, lift: 22, neckWidth: 14, head: [12, 8], tilt: 30,
    fill: '#f4f0e8', foot: '#2b2320', ears: 'side', tail: 'tuft', horns: 'side', spots: '#2b2728',
  },
  pig: {
    rig: 'quad', body: [22, 13], leg: 9, legWidth: 6, neck: 4, lift: 10, neckWidth: 14, head: [10, 9.5], tilt: 0,
    fill: '#f2a7ad', foot: '#c9747c', ears: 'point', tail: 'curly', snout: 'disc',
  },
  rat: {
    rig: 'quad', body: [8, 4.5], leg: 3.5, legWidth: 2, neck: 2, lift: 10, neckWidth: 5, head: [5.5, 3.2], tilt: 6,
    fill: '#7c767a', foot: '#e6a3a8', ears: 'round', tail: 'whip',
  },
};

/** How wide an animal is, nose to tail, in figure units: what the spacing of a herd is made of. */
export function creatureWidth(name: CreatureName): number {
  const spec = CREATURE_SPECS[name];
  if (spec.rig === 'bird') return spec.body[0] * 2 + spec.neck * 0.4 + spec.beak + 10;
  return spec.body[0] * 2 + spec.neck * Math.cos((spec.lift * Math.PI) / 180) + spec.head[0] * 1.6 + 8;
}

/** How tall an animal stands, in figure units. */
export function creatureHeight(name: CreatureName): number {
  const spec = CREATURE_SPECS[name];
  if (spec.rig === 'bird') return spec.hip + spec.body[1] + spec.neck * Math.cos((spec.lean * Math.PI) / 180) + spec.head;
  return spec.leg + spec.body[1] * 2 + spec.neck * Math.sin((spec.lift * Math.PI) / 180) + spec.head[1];
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * A two-part leg from hip to foot, with the knee where a leg of that length
 * would have to put it. `bend` is which way the knee goes: 1 forward (-x),
 * -1 back -- a bird's and a hind leg's "knee" is really an ankle, and points
 * backwards, which is half of what makes a bird walk look like a bird.
 */
function limb(hx: number, hy: number, fx: number, fy: number, length: number, bend: 1 | -1): string {
  let dx = fx - hx;
  let dy = fy - hy;
  const reach = Math.hypot(dx, dy);
  if (reach > length * 0.98) {
    dx *= (length * 0.98) / reach;
    dy *= (length * 0.98) / reach;
  }
  const d = Math.hypot(dx, dy) || 1;
  const half = length / 2;
  const h = Math.sqrt(Math.max(0, half * half - (d / 2) * (d / 2)));
  const kx = hx + dx / 2 + (-dy / d) * h * bend;
  const ky = hy + dy / 2 + (dx / d) * h * bend;
  return `M${hx.toFixed(2)},${hy.toFixed(2)} L${kx.toFixed(2)},${ky.toFixed(2)} L${(hx + dx).toFixed(2)},${(hy + dy).toFixed(2)}`;
}

/** A filled tube -- neck, trunk, a thick leg -- as halo, ink, then fill. */
function Tube({ d, width, fill, halo, outline = 2 }: { d: string; width: number; fill: string; halo: string; outline?: number }): React.ReactElement {
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} stroke={halo} strokeWidth={width + outline * 2 + 3} />
      <path d={d} stroke={INK} strokeWidth={width + outline * 2} />
      <path d={d} stroke={fill} strokeWidth={width} />
    </g>
  );
}

/** A thin inked line with its halo, for legs of birds and tails. */
function Line({ d, width, halo, colour = INK }: { d: string; width: number; halo: string; colour?: string }): React.ReactElement {
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} stroke={halo} strokeWidth={width + 3} />
      <path d={d} stroke={INK} strokeWidth={colour === INK ? width : width + 1.6} />
      {colour === INK ? null : <path d={d} stroke={colour} strokeWidth={width} />}
    </g>
  );
}

/**
 * The eye does the acting. Every animal gets the same big white eye as the
 * figures' faces have, and the mood is in the pupil and the brow: an angry emu
 * is a flat brow over a pinprick, a scared one is all white.
 */
function Eye({ x, y, r, mood }: { x: number; y: number; r: number; mood: Mood }): React.ReactElement {
  const pupil = mood === 'scared' ? r * 0.3 : r * 0.55;
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill="#ffffff" stroke={INK} strokeWidth={Math.max(0.6, r * 0.28)} />
      <circle cx={x - r * 0.28} cy={y + (mood === 'angry' ? r * 0.12 : 0)} r={pupil} fill={INK} />
      {mood === 'angry' ? (
        <path d={`M${x - r * 1.3},${y - r * 0.55} L${x + r * 1.1},${y - r * 1.35}`} stroke={INK} strokeWidth={Math.max(0.9, r * 0.45)} strokeLinecap="round" />
      ) : null}
      {mood === 'scared' ? (
        <path d={`M${x - r * 1.1},${y - r * 1.5} Q${x},${y - r * 2.1} ${x + r * 1.1},${y - r * 1.4}`} fill="none" stroke={INK} strokeWidth={Math.max(0.7, r * 0.3)} strokeLinecap="round" />
      ) : null}
    </g>
  );
}

/** Where a foot is in its step: `p` in cycles. Forward is -x; the foot lifts as it swings forward. */
function step(p: number, stride: number, lift: number): [number, number] {
  const a = p * Math.PI * 2;
  return [-Math.sin(a) * stride, -Math.max(0, Math.cos(a)) * lift];
}

function strideOf(gait: Gait, leg: number): { stride: number; lift: number; rate: number } {
  // Small animals take quicker steps; a pigeon walking at an emu's cadence
  // looks like a slowed-down film.
  const pace = Math.min(2.4, Math.max(0.7, Math.sqrt(40 / Math.max(3, leg))));
  if (gait === 'run') return { stride: leg * 0.55, lift: leg * 0.3, rate: 2.6 * pace };
  if (gait === 'walk') return { stride: leg * 0.3, lift: leg * 0.16, rate: 1.3 * pace };
  return { stride: 0, lift: 0, rate: 0 };
}

const BirdBody: React.FC<{ spec: Bird; gait: Gait; t: number; halo: string; mood: Mood }> = ({ spec, gait, t, halo, mood }) => {
  const { stride, lift, rate } = strideOf(gait === 'peck' || gait === 'kick' ? 'stand' : gait, spec.leg);
  const p = t * rate;
  const [rx, ry] = spec.body;
  // The body rides the steps: two bobs a cycle, deeper at a run.
  const bob = gait === 'run' ? -Math.abs(Math.sin(p * Math.PI * 2)) * spec.leg * 0.12 : gait === 'walk' ? -Math.abs(Math.sin(p * Math.PI * 2)) * spec.leg * 0.04 : Math.sin(t * 2.2) * 0.4;
  const cy = -spec.hip + bob;
  // Running, a bird leans into it and stretches its neck out.
  const pitch = gait === 'run' ? 14 : gait === 'kick' ? -14 : 0;
  const hipX = rx * 0.15;
  const hipY = cy + ry * 0.45;
  // A little longer than hip to ground, so even standing the leg has a bend in it.
  const legLength = (spec.hip - ry * 0.45) * 1.1;

  const legs = [0, 0.5].map((offset, i) => {
    const [fx, fy] =
      gait === 'kick'
        ? i === 0
          ? [-spec.leg * 0.95, -spec.leg * 0.55]
          : [spec.leg * 0.12, 0]
        : gait === 'stand' || gait === 'peck'
          ? [(i === 0 ? -1 : 1) * spec.leg * 0.08, 0]
          : step(p + offset, stride, lift);
    return (
      <Line
        key={i}
        d={limb(hipX + (i === 0 ? -1.5 : 1.5), hipY, hipX + fx, fy, legLength, -1)}
        width={Math.max(1.4, spec.leg * 0.055)}
        halo={halo}
        colour={i === 0 ? spec.legColour : shade(spec.legColour)}
      />
    );
  });
  // Toes: three short strokes forward from each foot.
  const feet = [0, 0.5].map((offset, i) => {
    const [fx, fy] =
      gait === 'kick'
        ? i === 0
          ? [-spec.leg * 0.95, -spec.leg * 0.55]
          : [spec.leg * 0.12, 0]
        : gait === 'stand' || gait === 'peck'
          ? [(i === 0 ? -1 : 1) * spec.leg * 0.08, 0]
          : step(p + offset, stride, lift);
    const x = hipX + fx;
    const toe = Math.max(2, spec.leg * 0.12);
    return (
      <path
        key={`toe${i}`}
        d={`M${x},${fy} l${-toe},0 M${x},${fy} l${-toe * 0.8},${toe * 0.3} M${x},${fy} l${toe * 0.5},0`}
        stroke={INK}
        strokeWidth={Math.max(1, spec.leg * 0.04)}
        strokeLinecap="round"
      />
    );
  });

  // The neck: swings with the stride, and pecks -- the head drops to the
  // ground and comes back, the one thing every bird does all day.
  const peckCycle = gait === 'peck' ? Math.pow(Math.max(0, Math.sin(t * 2.6)), 6) : 0;
  const neckLean = spec.lean + pitch * 2 + (gait === 'walk' ? Math.sin(p * Math.PI * 4) * 6 : 0) + peckCycle * (120 - spec.lean);
  const baseX = -rx * 0.62;
  const baseY = cy - ry * 0.35;
  const endX = baseX - Math.sin(rad(neckLean)) * spec.neck;
  const endY = baseY - Math.cos(rad(neckLean)) * spec.neck;
  const neck = `M${baseX},${baseY} Q${baseX - 1},${(baseY + endY) / 2} ${endX},${endY}`;

  return (
    <g>
      <ellipse cx={0} cy={0.8} rx={rx * 0.9} ry={Math.max(1.2, ry * 0.18)} fill="#000000" opacity={0.26} />
      {legs}
      {feet}
      <g transform={`rotate(${-pitch},0,${cy})`}>
        {/* Tail first: it sits behind the body. */}
        {spec.tail === 'plume' ? (
          <path
            d={`M${rx * 0.6},${cy - ry * 0.4} q${rx * 0.7},${ry * 0.2} ${rx * 0.5},${ry * 1.3} q${-rx * 0.3},${-ry * 0.5} ${-rx * 0.6},${-ry * 0.4} Z`}
            fill={shade(spec.fill)}
            stroke={INK}
            strokeWidth={1.4}
            strokeLinejoin="round"
          />
        ) : spec.tail === 'fan' ? (
          <path
            d={`M${rx * 0.6},${cy} l${rx * 0.55},${-ry * 1.3} l${rx * 0.15},${ry * 0.5} l${rx * 0.25},${-ry * 0.2} l${-rx * 0.2},${ry * 1.2} Z`}
            fill={spec.comb === undefined ? shade(spec.fill) : '#3b3a3f'}
            stroke={INK}
            strokeWidth={1}
            strokeLinejoin="round"
          />
        ) : (
          <path d={`M${rx * 0.7},${cy - ry * 0.2} l${rx * 0.55},${ry * 0.15} l${-rx * 0.1},${ry * 0.5} Z`} fill={shade(spec.fill)} stroke={INK} strokeWidth={0.8} />
        )}
        <Tube d={neck} width={spec.neckWidth} fill={spec.neckFill} halo={halo} outline={Math.max(0.8, spec.neckWidth * 0.2)} />
        <ellipse cx={0} cy={cy} rx={rx + 1.8} ry={ry + 1.8} fill={halo} />
        <ellipse cx={0} cy={cy} rx={rx} ry={ry} fill={spec.fill} stroke={INK} strokeWidth={Math.max(1, ry * 0.12)} />
        {/* An emu is a haystack on legs: the shag hangs off the bottom edge. */}
        {spec.shaggy
          ? [-0.6, -0.3, 0, 0.3, 0.6].map((f, i) => (
              <path
                key={i}
                d={`M${rx * f},${cy + ry * Math.sqrt(1 - f * f) * 0.85} q${rx * 0.06},${ry * 0.4} ${rx * 0.14},${ry * 0.55}`}
                stroke={INK}
                strokeWidth={1.3}
                fill="none"
                strokeLinecap="round"
              />
            ))
          : null}
        {spec.shaggy
          ? [-0.4, 0, 0.35].map((f, i) => (
              <path key={`s${i}`} d={`M${rx * f},${cy - ry * 0.3} q${rx * 0.12},${ry * 0.25} ${rx * 0.3},${ry * 0.2}`} stroke={shade(spec.fill)} strokeWidth={1.6} fill="none" strokeLinecap="round" />
            ))
          : null}
        {/* A folded wing, for the birds that are not haystacks. */}
        {spec.shaggy ? null : (
          <path d={`M${-rx * 0.35},${cy - ry * 0.2} q${rx * 0.6},${-ry * 0.1} ${rx * 1.0},${ry * 0.35} q${-rx * 0.5},${ry * 0.35} ${-rx * 1.0},${-ry * 0.35} Z`} fill={shade(spec.fill)} stroke={INK} strokeWidth={0.9} strokeLinejoin="round" />
        )}
        <g transform={`translate(${endX},${endY}) rotate(${peckCycle * 70 + pitch})`}>
          <circle r={spec.head + 1.6} fill={halo} />
          {spec.comb === undefined ? null : (
            <path d={`M${-spec.head * 0.6},${-spec.head * 0.7} q${spec.head * 0.1},${-spec.head * 0.9} ${spec.head * 0.5},${-spec.head * 0.3} q${spec.head * 0.2},${-spec.head * 0.8} ${spec.head * 0.6},${spec.head * 0.1} Z`} fill={spec.comb} stroke={INK} strokeWidth={0.7} />
          )}
          <path d={`M${-spec.head * 0.8},${-spec.head * 0.25} L${-spec.head * 0.8 - spec.beak},${spec.head * 0.15} L${-spec.head * 0.75},${spec.head * 0.45} Z`} fill={spec.beakColour} stroke={INK} strokeWidth={Math.max(0.6, spec.head * 0.14)} strokeLinejoin="round" />
          <circle r={spec.head} fill={spec.neckFill} stroke={INK} strokeWidth={Math.max(0.8, spec.head * 0.2)} />
          {spec.comb === undefined ? null : (
            <path d={`M${-spec.head * 0.9},${spec.head * 0.5} q${-spec.head * 0.2},${spec.head * 0.7} ${spec.head * 0.3},${spec.head * 0.6}`} fill={spec.comb} stroke={INK} strokeWidth={0.6} />
          )}
          <Eye x={-spec.head * 0.25} y={-spec.head * 0.15} r={spec.head * 0.48} mood={mood} />
        </g>
      </g>
    </g>
  );
};

const QuadBody: React.FC<{ spec: Quad; gait: Gait; t: number; halo: string; mood: Mood }> = ({ spec, gait, t, halo, mood }) => {
  const { stride, lift, rate } = strideOf(gait === 'peck' || gait === 'kick' ? 'stand' : gait, spec.leg);
  const p = t * rate;
  const [rx, ry] = spec.body;
  const bob = gait === 'run' ? -Math.abs(Math.sin(p * Math.PI * 2)) * spec.leg * 0.1 : gait === 'walk' ? -Math.abs(Math.sin(p * Math.PI * 2)) * spec.leg * 0.03 : Math.sin(t * 1.8) * 0.3;
  const cy = -(spec.leg + ry * 0.55) + bob;
  const shoulderX = -rx * 0.62;
  const hipX = rx * 0.62;
  const legTop = cy + ry * 0.35;
  const legLength = -legTop + 0.5;

  /**
   * A diagonal gait: near-front with far-hind, far-front with near-hind. The
   * far pair is drawn first and a shade darker, which is all the depth four
   * legs on a flat animal need.
   */
  const legPairs: { x: number; offset: number; far: boolean; bend: 1 | -1 }[] = [
    { x: shoulderX + 3, offset: 0.5, far: true, bend: 1 },
    { x: hipX + 3, offset: 0, far: true, bend: -1 },
    { x: shoulderX, offset: 0, far: false, bend: 1 },
    { x: hipX, offset: 0.5, far: false, bend: -1 },
  ];
  const legs = legPairs.map((leg, i) => {
    const [fx, fy] = gait === 'stand' || gait === 'peck' || gait === 'kick' ? [(leg.far ? 2 : -1), 0] : step(p + leg.offset, stride, lift);
    const d = limb(leg.x, legTop, leg.x + fx, fy, legLength + (gait === 'run' ? 2 : 1), leg.bend);
    const fill = leg.far ? shade(spec.fill) : spec.fill;
    return (
      <g key={i}>
        <Tube d={d} width={spec.legWidth} fill={fill} halo={halo} outline={Math.max(0.8, spec.legWidth * 0.18)} />
        <ellipse cx={leg.x + fx - 0.5} cy={fy - spec.legWidth * 0.12} rx={spec.legWidth * 0.62} ry={Math.max(1, spec.legWidth * 0.3)} fill={spec.foot} stroke={INK} strokeWidth={Math.max(0.6, spec.legWidth * 0.14)} />
      </g>
    );
  });

  // Grazing: the head goes down to the ground and comes back up.
  const graze = gait === 'peck' ? Math.pow(Math.max(0, Math.sin(t * 1.3)), 3) : 0;
  const neckLift = spec.lift - graze * (spec.lift + 40) + (gait === 'run' ? -14 : 0) + (gait === 'walk' ? Math.sin(p * Math.PI * 4) * 3 : 0);
  const baseX = -rx * 0.78;
  const baseY = cy - ry * 0.25;
  const endX = baseX - Math.cos(rad(neckLift)) * spec.neck;
  const endY = baseY - Math.sin(rad(neckLift)) * spec.neck;
  const [hx, hy] = spec.head;
  const tilt = spec.tilt + graze * 40;
  // The head hangs off the end of the neck, its back at the joint.
  const headX = spec.neck === 0 ? -rx * 0.95 : endX - Math.cos(rad(tilt)) * hx * 0.55;
  const headY = spec.neck === 0 ? cy - ry * 0.35 + graze * 8 : endY + Math.sin(rad(tilt)) * hx * 0.55;
  const wag = Math.sin(t * (spec.tail === 'up' ? 9 : 2.2));

  const tailRoot = { x: rx * 0.95, y: cy - ry * 0.3 };
  const tail = ((): React.ReactElement => {
    const { x, y } = tailRoot;
    switch (spec.tail) {
      case 'long':
        return <path d={`M${x},${y} q${rx * 0.35},${ry * 0.2 + wag} ${rx * 0.3},${ry * 2.2} q${-rx * 0.12},${-ry * 0.2} ${-rx * 0.2},${-ry * 1.6} Z`} fill={spec.mane ?? shade(spec.fill)} stroke={INK} strokeWidth={1.2} strokeLinejoin="round" />;
      case 'up':
        return <Line d={`M${x},${y} q${rx * 0.4},${-ry * 0.4} ${rx * 0.35 + wag * 3},${-ry * 1.4}`} width={Math.max(1.6, spec.legWidth * 0.5)} halo={halo} colour={spec.fill} />;
      case 'curl':
        return <Line d={`M${x},${y} q${rx * 0.5},${ry * 0.2} ${rx * 0.45},${-ry * 1.2} q${-rx * 0.05},${-ry * 0.8} ${-rx * 0.3 + wag},${-ry * 0.9}`} width={Math.max(1.6, spec.legWidth * 0.55)} halo={halo} colour={spec.fill} />;
      case 'curly':
        return <path d={`M${x},${y} c${rx * 0.25},${-ry * 0.2} ${rx * 0.3},${ry * 0.3} ${rx * 0.12},${ry * 0.25} c${-rx * 0.12},0 ${-rx * 0.05},${-ry * 0.35} ${rx * 0.12},${-ry * 0.3}`} fill="none" stroke={INK} strokeWidth={1.3} strokeLinecap="round" />;
      case 'whip':
        return <path d={`M${x},${y + ry * 0.4} q${rx * 0.8},${ry * 1.4} ${rx * 1.6 + wag * 2},${ry * 0.9}`} fill="none" stroke={spec.foot} strokeWidth={1.1} strokeLinecap="round" />;
      case 'tuft':
      case 'thin':
        return (
          <g>
            <path d={`M${x},${y} q${rx * 0.12 + wag},${ry * 0.6} ${rx * 0.06},${ry * 1.5}`} fill="none" stroke={INK} strokeWidth={Math.max(1, spec.legWidth * 0.18)} strokeLinecap="round" />
            <ellipse cx={x + rx * 0.06} cy={y + ry * 1.6} rx={Math.max(1.2, rx * 0.04)} ry={Math.max(2, ry * 0.18)} fill={INK} />
          </g>
        );
      default:
        return <ellipse cx={x + 1} cy={y} rx={Math.max(1.5, rx * 0.08)} ry={Math.max(1.2, ry * 0.12)} fill={shade(spec.fill)} stroke={INK} strokeWidth={0.8} />;
    }
  })();

  const ears = ((): React.ReactElement | null => {
    switch (spec.ears) {
      case 'horse':
      case 'point':
        return <path d={`M${hx * 0.05},${-hy * 0.7} l${hx * 0.12},${-hy * 0.95} l${hx * 0.3},${hy * 0.85} Z`} fill={spec.fill} stroke={INK} strokeWidth={0.9} strokeLinejoin="round" />;
      case 'flop':
        return <path d={`M${hx * 0.1},${-hy * 0.8} q${hx * 0.55},${-hy * 0.1} ${hx * 0.45},${hy * 1.1} q${-hx * 0.3},${-hy * 0.1} ${-hx * 0.35},${-hy * 0.9} Z`} fill={shade(spec.fill)} stroke={INK} strokeWidth={0.9} />;
      case 'round':
        return <circle cx={hx * 0.3} cy={-hy * 0.82} r={Math.max(1.4, hy * 0.3)} fill={spec.fill} stroke={INK} strokeWidth={0.9} />;
      case 'side':
        return <ellipse cx={hx * 0.55} cy={-hy * 0.55} rx={hx * 0.3} ry={hy * 0.2} transform={`rotate(-20,${hx * 0.55},${-hy * 0.55})`} fill={spec.fill} stroke={INK} strokeWidth={0.9} />;
      default:
        return null;
    }
  })();

  return (
    <g>
      <ellipse cx={0} cy={0.8} rx={rx * 1.05} ry={Math.max(1.2, ry * 0.14)} fill="#000000" opacity={0.26} />
      {legs.slice(0, 2)}
      {tail}
      {spec.neck === 0 ? null : (
        <Tube d={`M${baseX + spec.neckWidth * 0.2},${baseY + spec.neckWidth * 0.2} L${endX},${endY}`} width={spec.neckWidth} fill={spec.fill} halo={halo} outline={Math.max(0.9, spec.neckWidth * 0.12)} />
      )}
      {spec.mane === undefined ? null : (
        <path d={`M${baseX + 4},${baseY - spec.neckWidth * 0.55} L${endX + 2},${endY - spec.neckWidth * 0.55}`} stroke={spec.mane} strokeWidth={spec.neckWidth * 0.45} strokeLinecap="round" />
      )}
      <ellipse cx={0} cy={cy} rx={rx + 1.8} ry={ry + 1.8} fill={halo} />
      <ellipse cx={0} cy={cy} rx={rx} ry={ry} fill={spec.fill} stroke={INK} strokeWidth={Math.max(1.1, ry * 0.08)} />
      {spec.hump ? (
        <path d={`M${-rx * 0.45},${cy - ry * 0.8} q${rx * 0.35},${-ry * 2.1} ${rx * 0.8},${0}`} fill={spec.fill} stroke={INK} strokeWidth={1.2} />
      ) : null}
      {spec.spots === undefined
        ? null
        : [[-0.3, -0.2, 0.22], [0.35, 0.1, 0.26], [0.05, 0.35, 0.16]].map(([fx, fy, fr], i) => (
            <ellipse key={i} cx={rx * fx!} cy={cy + ry * fy!} rx={rx * fr!} ry={ry * fr! * 1.3} fill={spec.spots} opacity={0.9} />
          ))}
      {legs.slice(2)}
      {/* The head, turned nose-down by its tilt; forward is -x. */}
      <g transform={`translate(${headX},${headY}) rotate(${-tilt})`}>
        {spec.ears === 'big' ? (
          <path d={`M${hx * 0.2},${-hy * 0.8} q${hx * 1.1},${-hy * 0.2} ${hx * 0.9},${hy * 0.9} q${-hx * 0.3},${hy * 0.5} ${-hx * 0.8},${hy * 0.1} Z`} fill={shade(spec.fill)} stroke={INK} strokeWidth={1.4} strokeLinejoin="round" />
        ) : null}
        {spec.horns === 'back' ? (
          <path d={`M${hx * 0.1},${-hy * 0.8} q${hx * 0.5},${-hy * 1.6} ${hx * 1.1},${-hy * 0.6}`} fill="none" stroke="#6a5a48" strokeWidth={Math.max(1.4, hy * 0.35)} strokeLinecap="round" />
        ) : null}
        {spec.horns === 'side' ? (
          <path d={`M${hx * 0.2},${-hy * 0.8} q${-hx * 0.1},${-hy * 0.6} ${-hx * 0.35},${-hy * 0.7}`} fill="none" stroke="#e8dcc0" strokeWidth={Math.max(1.4, hy * 0.28)} strokeLinecap="round" />
        ) : null}
        <ellipse cx={0} cy={0} rx={hx + 1.6} ry={hy + 1.6} fill={halo} />
        <ellipse cx={0} cy={0} rx={hx} ry={hy} fill={spec.fill} stroke={INK} strokeWidth={Math.max(1, hy * 0.16)} />
        {ears}
        {spec.snout === 'dog' ? (
          <g>
            <ellipse cx={-hx * 0.85} cy={hy * 0.2} rx={hx * 0.45} ry={hy * 0.45} fill={spec.fill} stroke={INK} strokeWidth={0.9} />
            <circle cx={-hx * 1.25} cy={hy * 0.05} r={Math.max(1, hy * 0.2)} fill={INK} />
          </g>
        ) : spec.snout === 'bear' ? (
          <g>
            <ellipse cx={-hx * 0.8} cy={hy * 0.25} rx={hx * 0.4} ry={hy * 0.32} fill="#b08a6a" stroke={INK} strokeWidth={0.9} />
            <circle cx={-hx * 1.12} cy={hy * 0.12} r={Math.max(1, hy * 0.14)} fill={INK} />
          </g>
        ) : spec.snout === 'disc' ? (
          <g>
            <ellipse cx={-hx * 0.98} cy={hy * 0.2} rx={hx * 0.2} ry={hy * 0.32} fill={shade(spec.fill)} stroke={INK} strokeWidth={0.9} />
            <circle cx={-hx * 1.0} cy={hy * 0.08} r={0.8} fill={INK} />
            <circle cx={-hx * 1.0} cy={hy * 0.34} r={0.8} fill={INK} />
          </g>
        ) : spec.trunk ? null : (
          <circle cx={-hx * 0.85} cy={hy * 0.15} r={Math.max(0.7, hy * 0.12)} fill={INK} />
        )}
        {spec.trunk ? (
          <g>
            <Tube d={`M${-hx * 0.7},${hy * 0.2} q${-hx * 0.45},${hy * 0.5} ${-hx * 0.35 + wag * 2},${hy * 1.35} q${0},${hy * 0.3} ${-hx * 0.25},${hy * 0.3}`} width={hx * 0.32} fill={spec.fill} halo={halo} outline={1.1} />
            <path d={`M${-hx * 0.45},${hy * 0.45} q${-hx * 0.35},${hy * 0.25} ${-hx * 0.6},${-hy * 0.05}`} fill="none" stroke="#f3eee2" strokeWidth={hx * 0.1} strokeLinecap="round" />
          </g>
        ) : null}
        {spec.beard ? <path d={`M${-hx * 0.45},${hy * 0.8} l${hx * 0.08},${hy * 0.9} l${hx * 0.2},${-hy * 0.8} Z`} fill="#cfc6b4" stroke={INK} strokeWidth={0.7} /> : null}
        <Eye x={-hx * (spec.trunk ? 0.35 : 0.3)} y={-hy * 0.25} r={Math.max(1.3, Math.min(hx, hy) * (spec.trunk ? 0.17 : 0.3))} mood={mood} />
      </g>
    </g>
  );
};

/** A colour a step darker, for the far side of a thing. */
function shade(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const k = 0.72;
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export const Creature: React.FC<{
  name: CreatureName;
  x: number;
  groundY: number;
  scale: number;
  facingRight: boolean;
  gait: Gait;
  mood: Mood;
  t: number;
  phase: number;
  halo: string;
  appear?: number;
}> = ({ name, x, groundY, scale, facingRight, gait, mood, t, phase, halo, appear = 1 }) => {
  const spec = CREATURE_SPECS[name];
  return (
    <g transform={`translate(${x},${groundY}) scale(${facingRight ? -scale : scale},${scale})`} opacity={appear}>
      {spec.rig === 'bird' ? (
        <BirdBody spec={spec} gait={gait} t={t + phase} halo={halo} mood={mood} />
      ) : (
        <QuadBody spec={spec} gait={gait} t={t + phase} halo={halo} mood={mood} />
      )}
    </g>
  );
};
