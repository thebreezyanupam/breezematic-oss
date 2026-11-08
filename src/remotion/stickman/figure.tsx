import React from 'react';
import { RIG, poseAt, skeletonOf, type Pose } from './rig.js';
import { Face, Marks, type Expression } from './face.js';
import { OUTFITS, PROPS, PROP_ICON } from './vocab.js';
import { IconGlyph } from '../war/Icon.js';

/**
 * One character: a stick body, a round head with a face, and the things that
 * make it somebody -- a scarf or a hat, shoes with colour in them, whatever it
 * is holding.
 *
 * Every line is drawn twice: a wide pale halo first and the ink on top. That
 * outline is the channel's look as much as a practical choice -- it is what
 * lets the same figure stand in a dark cave and a bright desert and read in
 * both, and it makes the character look cut out of the world rather than lost
 * in it.
 */

export { PROPS } from './vocab.js';
export type PropName = (typeof PROPS)[number];
export type Outfit = (typeof OUTFITS)[number];
export const isOutfit = (value: unknown): value is Outfit =>
  typeof value === 'string' && (OUTFITS as readonly string[]).includes(value);
export const isProp = (value: unknown): value is PropName =>
  typeof value === 'string' && (PROPS as readonly string[]).includes(value);

export type Look = {
  /** The colour of the scarf, hat or bow: the character's colour. */
  accent: string;
  shoes: string;
  wear: 'scarf' | 'beanie' | 'cap' | 'bow' | 'hood' | 'none';
  hair: 'tuft' | 'spikes' | 'long' | 'bald';
};

/** The narrator's character: the red scarf is the channel. */
export const HERO: Look = { accent: '#e8412c', shoes: '#2b2d3a', wear: 'scarf', hair: 'tuft' };
export const FRIEND: Look = { accent: '#ffc53d', shoes: '#3a2b24', wear: 'beanie', hair: 'bald' };
export const RIVAL: Look = { accent: '#7c5cff', shoes: '#1d1b24', wear: 'hood', hair: 'spikes' };

const INK = '#1d1b24';
const SKIN = '#fff6e8';

/** A held thing, drawn at the grip with its long axis up (-y). */
function Held({ prop, t }: { prop: PropName; t: number }): React.ReactElement | null {
  const flicker = 1 + Math.sin(t * 23) * 0.08 + Math.sin(t * 37) * 0.05;
  switch (prop) {
    case 'book':
      return (
        <g transform="translate(-2,-6)">
          <rect x={-7} y={-5} width={14} height={10} rx={1} fill="#b8322a" stroke={INK} strokeWidth={1} />
          <rect x={-6} y={-4} width={12} height={8} fill="#fff4dc" />
          <path d="M0,-4 L0,4" stroke={INK} strokeWidth={0.8} />
          <path d="M-5,-2 L-1.5,-2 M-5,0 L-1.5,0 M1.5,-2 L5,-2 M1.5,0 L5,0" stroke="#b9ad98" strokeWidth={0.6} />
        </g>
      );
    case 'sword':
      return (
        <g>
          <path d="M-1.2,-2 L-1.2,-34 L0,-38 L1.2,-34 L1.2,-2 Z" fill="#dfe6ee" stroke={INK} strokeWidth={0.9} />
          <path d="M0,-34 L0,-4" stroke="#aab4c0" strokeWidth={0.5} />
          <rect x={-5} y={-3} width={10} height={2.2} rx={1} fill="#d8a431" stroke={INK} strokeWidth={0.8} />
          <rect x={-1.1} y={-1} width={2.2} height={5} fill="#5b3a26" stroke={INK} strokeWidth={0.6} />
        </g>
      );
    case 'torch':
      return (
        <g>
          <rect x={-1.3} y={-16} width={2.6} height={18} rx={1} fill="#7a4a2b" stroke={INK} strokeWidth={0.8} />
          <circle cx={0} cy={-20} r={10} fill="#ffb347" opacity={0.18 * flicker} />
          <path
            transform={`translate(0,-17) scale(${flicker},${flicker * 1.05})`}
            d="M0,-9 C4,-4 4,1 0,2 C-4,1 -4,-4 0,-9 Z"
            fill="#ff7a1a"
            stroke="#c2410c"
            strokeWidth={0.6}
          />
          <path transform={`translate(0,-16) scale(${flicker})`} d="M0,-5 C2,-2 2,0.5 0,1 C-2,0.5 -2,-2 0,-5 Z" fill="#ffe28a" />
        </g>
      );
    case 'lantern':
      return (
        <g transform="translate(0,6)">
          <circle cx={0} cy={4} r={13} fill="#ffcf6b" opacity={0.2 * flicker} />
          <path d="M0,-6 L0,-2" stroke={INK} strokeWidth={0.8} />
          <rect x={-4} y={-2} width={8} height={11} rx={2} fill="#ffe7a3" stroke={INK} strokeWidth={0.9} />
          <rect x={-5} y={-3} width={10} height={2} rx={1} fill="#3d3a46" />
          <rect x={-5} y={8.5} width={10} height={2} rx={1} fill="#3d3a46" />
          <circle cx={0} cy={3.6} r={2 * flicker} fill="#ff9d2e" />
        </g>
      );
    case 'phone':
      return (
        <g transform="translate(0,-5)">
          <rect x={-3.2} y={-6} width={6.4} height={11} rx={1.4} fill="#23222c" stroke={INK} strokeWidth={0.8} />
          <rect x={-2.4} y={-4.8} width={4.8} height={8.4} rx={0.6} fill="#79d7ff" opacity={0.9} />
          <circle cx={0} cy={-1} r={9} fill="#79d7ff" opacity={0.08} />
        </g>
      );
    case 'cup':
      return (
        <g transform="translate(0,-4)">
          <path d="M-3.6,-4 L3.6,-4 L3,4 L-3,4 Z" fill="#f1efe9" stroke={INK} strokeWidth={0.9} />
          <path d="M3.4,-2 C6.2,-2 6.2,2.4 3.2,2.4" fill="none" stroke={INK} strokeWidth={0.9} />
          {[0, 1].map((i) => {
            const rise = ((t * 0.7 + i * 0.5) % 1) * 8;
            return (
              <path
                key={i}
                d={`M${-1 + i * 2},${-6 - rise} q1.2,-1.5 0,-3`}
                stroke="#ffffff"
                strokeWidth={0.8}
                fill="none"
                opacity={0.7 * (1 - rise / 8)}
              />
            );
          })}
        </g>
      );
    case 'magnifier':
      return (
        <g>
          <rect x={-1} y={-9} width={2} height={10} rx={1} fill="#6b4226" stroke={INK} strokeWidth={0.7} />
          <circle cx={0} cy={-15} r={6.4} fill="#bfe9ff" fillOpacity={0.45} stroke="#c9a227" strokeWidth={1.8} />
          <path d="M-3,-17 Q-2,-19 0,-19.4" stroke="#ffffff" strokeWidth={0.9} fill="none" />
        </g>
      );
    case 'briefcase':
      return (
        <g transform="translate(0,8)">
          <path d="M-3,-4 L-3,-6 L3,-6 L3,-4" fill="none" stroke={INK} strokeWidth={1} />
          <rect x={-8} y={-4} width={16} height={11} rx={1.6} fill="#6b3f23" stroke={INK} strokeWidth={1} />
          <path d="M-8,0.5 L8,0.5" stroke="#4a2a16" strokeWidth={0.8} />
          <rect x={-1.4} y={-0.4} width={2.8} height={2} fill="#d8a431" />
        </g>
      );
    case 'flag': {
      const wave = Math.sin(t * 5);
      return (
        // A pole long enough that the flag flies above the head, not across the face.
        <g>
          <rect x={-0.8} y={-84} width={1.6} height={86} fill="#8a6a4a" stroke={INK} strokeWidth={0.5} />
          <circle cx={0} cy={-85} r={1.8} fill="#d8a431" stroke={INK} strokeWidth={0.5} />
          <path
            d={`M0.8,-83 Q9,${-86 + wave * 2} 18,-82 L18,-70 Q9,${-73 + wave * 2} 0.8,-71 Z`}
            fill="#e8412c"
            stroke={INK}
            strokeWidth={0.8}
          />
        </g>
      );
    }
    case 'scroll':
      return (
        <g transform="translate(0,-4)">
          <rect x={-3} y={-8} width={6} height={16} fill="#f3e3bd" stroke={INK} strokeWidth={0.8} />
          <rect x={-4} y={-9.5} width={8} height={2.4} rx={1.2} fill="#c9a26b" stroke={INK} strokeWidth={0.6} />
          <rect x={-4} y={7} width={8} height={2.4} rx={1.2} fill="#c9a26b" stroke={INK} strokeWidth={0.6} />
        </g>
      );
    case 'moneybag':
      return (
        <g transform="translate(0,9)">
          <path d="M-2,-6 L2,-6 L3,-3 C9,-1 9,9 0,9 C-9,9 -9,-1 -3,-3 Z" fill="#c9a24a" stroke={INK} strokeWidth={0.9} />
          <path d="M-2.6,-3.4 L2.6,-3.4" stroke={INK} strokeWidth={1} />
          <text x={0} y={5.5} fontSize={7} fontWeight={900} textAnchor="middle" fill="#6b4f12" fontFamily="Arial">$</text>
        </g>
      );
    case 'umbrella':
      return (
        <g>
          <rect x={-0.6} y={-58} width={1.2} height={58} fill="#3d3a46" />
          <path d="M-22,-56 Q0,-80 22,-56 Q16,-60 11,-56 Q5.5,-60 0,-56 Q-5.5,-60 -11,-56 Q-16,-60 -22,-56 Z" fill="#3aa0ff" stroke={INK} strokeWidth={0.9} />
          <path d="M0,0 q0,2.6 -2.4,2.6" stroke="#3d3a46" strokeWidth={1.2} fill="none" />
        </g>
      );
    case 'rifle':
    case 'musket': {
      // Drawn rather than taken from the icon set: at a hand's size the icon's
      // silhouette read as a hook, and a rifle is two shapes anyway.
      const wood = prop === 'musket' ? '#7a5230' : '#5e4128';
      return (
        <g transform="rotate(-22)">
          <rect x={-1} y={-42} width={2} height={34} rx={0.6} fill="#3a3b3d" stroke={INK} strokeWidth={0.6} />
          <path d="M-2.4,-12 L2,-12 L3.6,9 L-1.2,11 L-2.8,6 Z" fill={wood} stroke={INK} strokeWidth={0.7} strokeLinejoin="round" />
          <path d="M-2,-26 L2,-26 L2,-15 L-2,-15 Z" fill={wood} stroke={INK} strokeWidth={0.6} />
          {prop === 'rifle' ? (
            <path d="M1.6,-13 L4.6,-13 L4.6,-11" stroke="#3a3b3d" strokeWidth={1.1} fill="none" />
          ) : (
            <path d="M0,-42 L0,-54" stroke="#cfd6de" strokeWidth={1.1} strokeLinecap="round" />
          )}
        </g>
      );
    }
    case 'white-flag': {
      const wave = Math.sin(t * 5);
      return (
        <g>
          <rect x={-0.8} y={-70} width={1.6} height={72} fill="#8a6a4a" stroke={INK} strokeWidth={0.5} />
          <path
            d={`M0.8,-69 Q9,${-72 + wave * 2} 18,-68 L18,-56 Q9,${-59 + wave * 2} 0.8,-57 Z`}
            fill="#f7f4ec"
            stroke={INK}
            strokeWidth={0.8}
          />
        </g>
      );
    }
    default: {
      /**
       * Everything military comes from the icon set: a rifle, a grenade, a
       * shield. Drawn a little larger than life so it reads at a figure's
       * scale, with the same pale outline the figure has.
       */
      const held = HELD_ICON[prop];
      if (held === undefined) return null;
      return (
        <IconGlyph
          name={held.icon}
          size={held.size}
          x={held.dx}
          y={held.dy}
          rotate={held.rotate}
          fill={held.fill ?? '#3a3a38'}
          outline="#fffaf0"
          outlineWidth={28}
        />
      );
    }
  }
}

/** How each icon prop sits in the hand: which icon, how big, how turned. */
const HOLD: Partial<Record<PropName, { size: number; dx: number; dy: number; rotate: number; fill?: string }>> = {
  pistol: { size: 18, dx: 3, dy: -4, rotate: 0 },
  grenade: { size: 20, dx: 0, dy: -8, rotate: 20, fill: '#4f5a33' },
  binoculars: { size: 18, dx: 2, dy: -6, rotate: 0 },
  shovel: { size: 40, dx: 0, dy: -14, rotate: 0, fill: '#5c5244' },
  radio: { size: 20, dx: 0, dy: -6, rotate: 0, fill: '#4f5a33' },
  shield: { size: 30, dx: -4, dy: -4, rotate: 0, fill: '#8a5a2b' },
  spear: { size: 62, dx: 0, dy: -24, rotate: 0, fill: '#5a4230' },
  axe: { size: 34, dx: 0, dy: -14, rotate: 0, fill: '#4a4a4a' },
  map: { size: 24, dx: 0, dy: -8, rotate: 0, fill: '#8a6a3a' },
  medal: { size: 16, dx: 0, dy: -4, rotate: 0, fill: '#c9a227' },
};
const HELD_ICON: Partial<Record<PropName, { icon: string; size: number; dx: number; dy: number; rotate: number; fill?: string }>> =
  Object.fromEntries(
    Object.entries(HOLD).flatMap(([prop, hold]) => (PROP_ICON[prop] === undefined ? [] : [[prop, { icon: PROP_ICON[prop]!, ...hold }]])),
  );

/**
 * Headgear, drawn in the head's own coordinates (radius about 13.4, top at
 * about -13.4). The first group is drawn by hand because the silhouettes are
 * simple and the colour matters; the second group comes from the icon set.
 */
function Headgear({ outfit, accent }: { outfit: Outfit; accent: string }): React.ReactElement | null {
  const olive = '#5d6b3a';
  switch (outfit) {
    case 'helmet':
      return (
        <g>
          <path d="M-14.5,-4 C-15,-19 15,-19 14.5,-4 Z" fill={olive} stroke={INK} strokeWidth={1.1} />
          <ellipse cx={0} cy={-4} rx={19} ry={3} fill={olive} stroke={INK} strokeWidth={1.1} />
        </g>
      );
    case 'pickelhaube':
      return (
        <g>
          <path d="M1.2,-30 L-1.2,-30 L-2.4,-16 L2.4,-16 Z" fill="#c9a227" stroke={INK} strokeWidth={0.8} />
          <path d="M-14,-4 C-14.5,-19 14.5,-19 14,-4 Z" fill="#26282b" stroke={INK} strokeWidth={1.1} />
          <path d="M-17,-4 L17,-4 L14,-1.5 L-14,-1.5 Z" fill="#26282b" stroke={INK} strokeWidth={1} />
          <circle cx={0} cy={-10} r={3.2} fill="#c9a227" stroke={INK} strokeWidth={0.6} />
        </g>
      );
    case 'kepi':
      return (
        <g transform="rotate(-6)">
          <path d="M-11,-22 L11,-22 L13,-6 L-13,-6 Z" fill={accent} stroke={INK} strokeWidth={1.1} />
          <rect x={-13} y={-8} width={26} height={3.2} fill="#2a2a2a" stroke={INK} strokeWidth={0.8} />
          <path d="M-13,-5 L-22,-3 Q-20,-6.5 -13,-7.5 Z" fill="#1d1b24" />
        </g>
      );
    case 'bicorne':
      return (
        <g>
          <path d="M-26,-6 Q-18,-12 0,-26 Q18,-12 26,-6 Q12,-10 0,-9 Q-12,-10 -26,-6 Z" fill="#1d1d22" stroke="#fffaf0" strokeWidth={0.9} />
          <circle cx={7} cy={-15} r={3.4} fill="#2e4a8a" stroke="#fffaf0" strokeWidth={0.6} />
          <circle cx={7} cy={-15} r={2} fill="#fffaf0" />
          <circle cx={7} cy={-15} r={0.9} fill="#c0392b" />
        </g>
      );
    case 'tricorne':
      return (
        <g>
          <path d="M-20,-8 L0,-22 L20,-8 Q10,-12 0,-12 Q-10,-12 -20,-8 Z" fill="#1d1d22" stroke="#fffaf0" strokeWidth={0.9} />
          <path d="M-18,-8 Q0,-4 18,-8" stroke="#d8c38a" strokeWidth={1.2} fill="none" />
        </g>
      );
    case 'officer-cap':
      return (
        <g>
          <ellipse cx={0} cy={-15} rx={17} ry={5} fill={olive} stroke={INK} strokeWidth={1.1} />
          <path d="M-12,-13 L12,-13 L13,-6 L-13,-6 Z" fill={olive} stroke={INK} strokeWidth={1} />
          <rect x={-13} y={-8.5} width={26} height={3} fill="#8a2b22" />
          <path d="M-13,-5.5 L-21,-3 Q-18,-7 -12,-7.5 Z" fill="#1d1b24" />
          <circle cx={0} cy={-11} r={1.8} fill="#c9a227" />
        </g>
      );
    case 'beret':
      return (
        <path d="M-15,-6 C-17,-17 10,-22 18,-10 C14,-7 -2,-6 -15,-6 Z" fill={accent} stroke={INK} strokeWidth={1.1} />
      );
    case 'crown':
      return <IconGlyph name="crown" size={30} y={-16} fill="#e3b341" outline={INK} outlineWidth={24} />;
    case 'spartan':
    case 'roman':
    case 'viking':
    case 'samurai':
    case 'knight':
      return <IconGlyph name={outfit} size={36} y={-11} fill={outfit === 'viking' ? '#9aa3ad' : '#b08d3a'} outline={INK} outlineWidth={22} />;
    default:
      return null;
  }
}

/** The box that `carry` holds in both arms. */
function Carried(): React.ReactElement {
  return (
    <g>
      <rect x={-10} y={-9} width={20} height={16} rx={1.2} fill="#c98a4b" stroke={INK} strokeWidth={1.1} />
      <path d="M-10,-4 L10,-4" stroke="#8a5a2b" strokeWidth={1} />
      <rect x={-3} y={-9} width={6} height={5} fill="#e8c28e" />
    </g>
  );
}

export const Figure: React.FC<{
  action: string;
  /** 0..1 across the beat, for one-shot actions. */
  progress: number;
  /** Seconds since the video began: loops, blinks and anything ambient. */
  t: number;
  x: number;
  groundY: number;
  /** Pixels per rig unit. */
  scale: number;
  facingRight: boolean;
  expression: Expression;
  look: Look;
  prop: PropName;
  /** The pale outline colour, chosen per scene so it never glows in a dark one. */
  halo: string;
  /** How far into the beat, 0..1, for the marks popping in. */
  appear: number;
  phase: number;
  /** Where the eyes look, -1..1 toward the front. */
  gaze?: number;
  /** Headgear over whatever the look wears: which war, which side. */
  outfit?: Outfit;
  /** A pose taken from a clip (retarget.ts), used instead of the named action. */
  posed?: Pose;
  /** Head size against the rig's own: below 1 for a figure performing a person's moves. */
  headScale?: number;
}> = ({ action, progress, t, x, groundY, scale, facingRight, expression, look, prop, halo, appear, phase, gaze = 0.6, outfit = 'none', posed, headScale = 1 }) => {
  const pose = posed ?? poseAt(action, progress, t + phase);
  // Breathing: a figure that is standing still is still alive. A pose taken
  // from a person already breathes.
  const breathe = posed === undefined ? Math.sin((t + phase) * 2.1) * 0.5 : 0;
  const skeleton = skeletonOf({ ...pose, hipY: pose.hipY + breathe });
  const { joints } = skeleton;
  // A smaller head sits closer to the neck, so it stays on the shoulders.
  const head = {
    x: joints.neck.x + (skeleton.head.x - joints.neck.x) * headScale,
    y: joints.neck.y + (skeleton.head.y - joints.neck.y) * headScale,
    r: skeleton.head.r,
  };
  const flip = facingRight ? -1 : 1;
  const feet = RIG.thigh + RIG.shin;
  const stroke = RIG.stroke * 1.12;

  // Face tilt follows the head: forward is -x in rig space.
  const tilt = -(pose.lean + pose.head);
  const scarfSway = Math.sin((t + phase) * 4.2);
  const holding = action === 'carry' ? 'box' : prop;

  const bones = skeleton.bones.map((bone, index) => (
    <line key={index} x1={bone[0]} y1={bone[1]} x2={bone[2]} y2={bone[3]} />
  ));

  return (
    <g transform={`translate(${x},${groundY - feet * scale}) scale(${scale})`}>
      {/* Contact shadow: the figure stands on the ground rather than over it. */}
      <ellipse cx={0} cy={feet + 1.2} rx={15} ry={2.6} fill="#000000" opacity={0.28} />
      <g transform={`scale(${flip},1)`}>
        {/* The scarf's tails stream behind, so they go first. */}
        {look.wear === 'scarf' ? (
          <path
            d={`M${joints.neck.x + 1},${joints.neck.y + 2} q9,${2 + scarfSway * 2} 16,${1 + scarfSway * 4} l-1,4 q-8,${1 - scarfSway * 2} -14,-1 Z`}
            fill={look.accent}
            stroke={INK}
            strokeWidth={1}
            strokeLinejoin="round"
          />
        ) : null}
        <g strokeLinecap="round" strokeLinejoin="round" fill="none">
          <g stroke={halo} strokeWidth={stroke + 3.2}>{bones}</g>
          <g stroke={INK} strokeWidth={stroke}>{bones}</g>
        </g>
        {/* Shoes, pointing forward, with the character's colour in them. */}
        {[joints.footL, joints.footR].map((foot, i) => (
          <ellipse key={i} cx={foot.x - 2} cy={foot.y + 0.4} rx={4.2} ry={2.4} fill={look.shoes} stroke={halo} strokeWidth={1.2} />
        ))}
        {/* The head: halo, skin, outline, then the face turned toward the front. */}
        <g transform={`translate(${head.x},${head.y}) rotate(${tilt}) scale(${headScale})`}>
          <circle r={head.r + 1.7} fill={halo} />
          {look.hair === 'long' ? (
            <path d="M-14,-2 C-15,-14 -8,-17 0,-17 C8,-17 15,-14 14,-2 L15,12 L9,12 L9,0 L-9,0 L-9,12 L-15,12 Z" fill="#3b2a24" stroke={INK} strokeWidth={1} />
          ) : null}
          <circle r={head.r} fill={SKIN} stroke={INK} strokeWidth={2.2} />
          {look.hair === 'tuft' && outfit === 'none' ? (
            <path d="M-3,-13.4 C-3,-19 1,-20 2,-16 C3,-21 8,-19 5,-12.6 Z" fill={INK} />
          ) : null}
          {look.hair === 'spikes' ? (
            <path d="M-12,-6 L-13,-15 L-7,-11 L-5,-19 L0,-12 L4,-19 L6,-11 L12,-15 L11,-6 C6,-12 -6,-12 -12,-6 Z" fill="#2a2140" stroke={INK} strokeWidth={0.8} />
          ) : null}
          {look.wear === 'beanie' ? (
            <g>
              <path d="M-13.4,-4 C-14,-15 -7,-19 0,-19 C7,-19 14,-15 13.4,-4 Z" fill={look.accent} stroke={INK} strokeWidth={1} />
              <rect x={-14.4} y={-6} width={28.8} height={4} rx={2} fill={look.accent} stroke={INK} strokeWidth={1} />
              <circle cx={0} cy={-20} r={3} fill={look.accent} stroke={INK} strokeWidth={0.9} />
            </g>
          ) : null}
          {look.wear === 'cap' ? (
            <g>
              <path d="M-13.4,-5 C-13.4,-15 13.4,-15 13.4,-5 Z" fill={look.accent} stroke={INK} strokeWidth={1} />
              <path d="M-13.4,-5 L-22,-4 Q-20,-7.5 -13.4,-7.5" fill={look.accent} stroke={INK} strokeWidth={1} />
            </g>
          ) : null}
          {look.wear === 'bow' ? (
            <g transform="translate(7,-12) rotate(20)">
              <path d="M0,0 L-6,-4 L-6,4 Z M0,0 L6,-4 L6,4 Z" fill={look.accent} stroke={INK} strokeWidth={0.9} />
              <circle r={1.6} fill={look.accent} stroke={INK} strokeWidth={0.8} />
            </g>
          ) : null}
          {look.wear === 'hood' ? (
            <path d="M-15.6,6 C-17,-12 -8,-18.4 0,-18.4 C8,-18.4 17,-12 15.6,6 L12.6,4 C13,-10 7,-14.4 0,-14.4 C-7,-14.4 -13,-10 -12.6,4 Z" fill={look.accent} stroke={INK} strokeWidth={1} />
          ) : null}
          <Face expression={expression} t={t} phase={phase} gaze={-gaze} skin={SKIN} />
          {outfit === 'none' ? null : <Headgear outfit={outfit} accent={look.accent} />}
        </g>
        {/* The scarf's knot, over the neck. */}
        {look.wear === 'scarf' ? (
          <ellipse cx={joints.neck.x} cy={joints.neck.y + 1} rx={5.4} ry={2.8} fill={look.accent} stroke={INK} strokeWidth={1} />
        ) : null}
        {holding === 'box' ? (
          <g transform={`translate(${(joints.handL.x + joints.handR.x) / 2},${(joints.handL.y + joints.handR.y) / 2 - 2})`}>
            <Carried />
          </g>
        ) : holding !== 'none' ? (
          // Only a blade follows the forearm. Everything else is held upright
          // whatever the arm does: a flag or an umbrella turned with an arm
          // hanging at the hip pointed at the floor.
          <g
            transform={`translate(${joints.handR.x},${joints.handR.y})${holding === 'sword' ? ` rotate(${180 - pose.armR[1]})` : ''}`}
          >
            <Held prop={holding} t={t} />
          </g>
        ) : null}
        {/* Hands last, over whatever they hold. */}
        {[joints.handL, joints.handR].map((hand, i) => (
          <circle key={i} cx={hand.x} cy={hand.y} r={2.6} fill={INK} stroke={halo} strokeWidth={1} />
        ))}
      </g>
      <g transform={`translate(${head.x * flip},${head.y})`}>
        <Marks expression={expression} t={t} appear={appear} />
      </g>
    </g>
  );
};
