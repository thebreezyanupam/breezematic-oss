import React from 'react';
import { EXPRESSIONS } from './vocab.js';

/**
 * A face, in head-local rig units: the head is a circle of radius 14 centred on
 * the origin, +y down.
 *
 * Built from a handful of parts -- eyes, lids, brows, mouth, cheeks -- because
 * an expression is not one drawing but a combination: "scared" is wide eyes,
 * small pupils, brows up in the middle and a wobbling mouth, and each of those
 * parts alone reads as something else. Everything is flat 2D and outlined, the
 * way a hand-drawn character is, and it is all vector so it stays crisp at any
 * size.
 */

export { EXPRESSIONS } from './vocab.js';
export type Expression = (typeof EXPRESSIONS)[number];

export const isExpression = (value: unknown): value is Expression =>
  typeof value === 'string' && (EXPRESSIONS as readonly string[]).includes(value);

const INK = '#1d1b24';
const PINK = '#ff8fa3';

type Brow = { lift: number; tilt: number };

/** Brow height and tilt: positive tilt drops the inner end, which is anger. */
const BROWS: Record<Expression, [Brow, Brow]> = {
  neutral: [{ lift: 0, tilt: 0 }, { lift: 0, tilt: 0 }],
  happy: [{ lift: 1, tilt: -4 }, { lift: 1, tilt: -4 }],
  laughing: [{ lift: 1.5, tilt: -8 }, { lift: 1.5, tilt: -8 }],
  sad: [{ lift: 0.5, tilt: -22 }, { lift: 0.5, tilt: -22 }],
  crying: [{ lift: 1, tilt: -28 }, { lift: 1, tilt: -28 }],
  angry: [{ lift: -1.2, tilt: 26 }, { lift: -1.2, tilt: 26 }],
  surprised: [{ lift: 3, tilt: -6 }, { lift: 3, tilt: -6 }],
  shocked: [{ lift: 3.8, tilt: -10 }, { lift: 3.8, tilt: -10 }],
  scared: [{ lift: 2.4, tilt: -24 }, { lift: 2.4, tilt: -24 }],
  thinking: [{ lift: 2.2, tilt: -8 }, { lift: -0.4, tilt: 8 }],
  smug: [{ lift: 1.6, tilt: -10 }, { lift: -0.6, tilt: 10 }],
  tired: [{ lift: -0.8, tilt: -8 }, { lift: -0.8, tilt: -8 }],
  determined: [{ lift: -0.8, tilt: 14 }, { lift: -0.8, tilt: 14 }],
  confused: [{ lift: 2.6, tilt: -12 }, { lift: -0.8, tilt: 12 }],
  love: [{ lift: 1.2, tilt: -8 }, { lift: 1.2, tilt: -8 }],
};

/** The mouth, as a path and whether it is an open (filled) shape. */
function mouth(expression: Expression, t: number): { d: string; open: boolean; tongue?: boolean; teeth?: boolean } {
  switch (expression) {
    case 'happy':
      return { d: 'M-5,4.2 Q0,10.5 5,4.2 Z', open: true, teeth: true };
    case 'laughing': {
      const jaw = 12 + Math.sin(t * 18) * 1.6;
      return { d: `M-6,3.4 Q0,${jaw} 6,3.4 Z`, open: true, tongue: true };
    }
    case 'love':
      return { d: 'M-4.6,4.6 Q0,9.4 4.6,4.6', open: false };
    case 'sad':
      return { d: 'M-4.2,8 Q0,4 4.2,8', open: false };
    case 'crying': {
      const wail = 2.5 + Math.sin(t * 9) * 0.8;
      return { d: `M-4.8,8.4 Q0,${wail} 4.8,8.4 Q0,7 -4.8,8.4 Z`, open: true };
    }
    case 'angry':
      return { d: 'M-5,4.6 L5,4.6 L4.4,8.6 L-4.4,8.6 Z', open: true, teeth: true };
    case 'surprised':
      return { d: 'M-2.4,6.4 a2.4,3.1 0 1,0 4.8,0 a2.4,3.1 0 1,0 -4.8,0', open: true };
    case 'shocked':
      return { d: 'M-3.4,6.8 a3.4,4.6 0 1,0 6.8,0 a3.4,4.6 0 1,0 -6.8,0', open: true, tongue: true };
    case 'scared': {
      const w = Math.sin(t * 26) * 0.6;
      return { d: `M-5,6.6 q1.25,${-1.6 + w} 2.5,0 t2.5,0 t2.5,0 t2.5,0`, open: false };
    }
    case 'thinking':
      return { d: 'M-1.4,6.8 Q1.2,5.4 3.2,6.6', open: false };
    case 'smug':
      return { d: 'M-4.2,6 Q1.4,8.8 4.8,4.2', open: false };
    case 'tired':
      return { d: 'M-2.8,6.8 Q0,7.6 2.8,6.8', open: false };
    case 'determined':
      return { d: 'M-4.4,6.8 L4.4,5.8', open: false };
    case 'confused':
      return { d: 'M-4.4,6.4 Q-1.6,4.6 0.6,6.4 T4.6,5.6', open: false };
    default:
      return { d: 'M-3.6,6.4 Q0,7.4 3.6,6.4', open: false };
  }
}

/** Seconds until the next blink repeat, and how long a blink lasts. */
const BLINK_EVERY = 3.4;
const BLINK_FOR = 0.14;

export const Face: React.FC<{
  expression: Expression;
  /** Seconds since the video began, for blinking and anything that moves. */
  t: number;
  /** A per-figure number so two figures do not blink in step. */
  phase: number;
  /** Which way the eyes look, -1..1 across; the face turns a little with it. */
  gaze: number;
  skin: string;
}> = ({ expression, t, phase, gaze, skin }) => {
  // The features sit toward the side the figure faces: a three-quarter turn,
  // which is what makes a round head read as a head rather than a plate.
  const turn = -2.2;
  const cycle = (t + phase) % BLINK_EVERY;
  const blinking = cycle < BLINK_FOR && expression !== 'laughing' && expression !== 'happy';
  const open = blinking ? 0.12 : 1;

  const big = expression === 'surprised' || expression === 'shocked' || expression === 'scared';
  const eyeRx = big ? 3.6 : 3.1;
  const eyeRy = (big ? 4.6 : 3.9) * open;
  const pupilR = expression === 'shocked' || expression === 'scared' ? 1.1 : 1.9;
  const tremble = expression === 'scared' ? Math.sin(t * 40) * 0.35 : 0;
  const lookX = gaze * 1.2 + tremble;
  const lookY = expression === 'sad' || expression === 'crying' || expression === 'tired' ? 0.9 : expression === 'thinking' ? -1.1 : 0;

  const eyes = [-5.4 + turn, 5.4 + turn].map((x, side) => {
    if (expression === 'happy' || expression === 'laughing') {
      return (
        <path
          key={side}
          d={`M${x - 3},${0.6} Q${x},${-3.4} ${x + 3},${0.6}`}
          stroke={INK}
          strokeWidth={1.8}
          fill="none"
          strokeLinecap="round"
        />
      );
    }
    if (expression === 'love') {
      const s = 1 + Math.sin(t * 6) * 0.08;
      return (
        <path
          key={side}
          transform={`translate(${x},-0.2) scale(${s})`}
          d="M0,3 C-4.6,-0.2 -3,-4.6 0,-2 C3,-4.6 4.6,-0.2 0,3 Z"
          fill="#ff3b5c"
          stroke={INK}
          strokeWidth={0.9}
        />
      );
    }
    // Lids: a band of skin over the top of the eye, tilted by the mood.
    const lid =
      expression === 'tired'
        ? { cover: 0.55, tilt: 0 }
        : expression === 'angry'
          ? { cover: 0.42, tilt: side === 0 ? 18 : -18 }
          : expression === 'determined'
            ? { cover: 0.3, tilt: side === 0 ? 10 : -10 }
            : expression === 'sad' || expression === 'crying'
              ? { cover: 0.34, tilt: side === 0 ? -16 : 16 }
              : expression === 'smug'
                ? { cover: 0.46, tilt: 0 }
                : null;
    const clip = `eye-${side}-${Math.round(phase * 1000)}`;
    return (
      <g key={side}>
        <clipPath id={clip}>
          <ellipse cx={x} cy={0} rx={eyeRx} ry={Math.max(0.3, eyeRy)} />
        </clipPath>
        <ellipse cx={x} cy={0} rx={eyeRx} ry={Math.max(0.3, eyeRy)} fill="#ffffff" stroke={INK} strokeWidth={1.1} />
        {open > 0.5 ? (
          <g clipPath={`url(#${clip})`}>
            <circle cx={x + lookX} cy={lookY + 0.4} r={pupilR} fill={INK} />
            <circle cx={x + lookX + 0.7} cy={lookY - 0.5} r={pupilR * 0.36} fill="#ffffff" />
            {lid === null ? null : (
              <rect
                x={x - eyeRx - 1}
                y={-eyeRy - 1}
                width={eyeRx * 2 + 2}
                height={(eyeRy * 2 + 2) * lid.cover}
                fill={skin}
                stroke={INK}
                strokeWidth={1}
                transform={`rotate(${lid.tilt} ${x} 0)`}
              />
            )}
          </g>
        ) : null}
      </g>
    );
  });

  const brows = BROWS[expression].map((brow, side) => {
    const x = (side === 0 ? -5.4 : 5.4) + turn;
    const y = -6.2 - brow.lift - (big ? 1.2 : 0);
    // Inner end is toward the middle: tilt rotates about the eye centre.
    const tilt = side === 0 ? brow.tilt : -brow.tilt;
    return (
      <path
        key={side}
        d={`M${x - 3},${y + 0.3} Q${x},${y - 1} ${x + 3},${y + 0.3}`}
        transform={`rotate(${tilt} ${x} ${y})`}
        stroke={INK}
        strokeWidth={1.7}
        strokeLinecap="round"
        fill="none"
      />
    );
  });

  const m = mouth(expression, t);
  const blush =
    expression === 'happy' || expression === 'laughing' || expression === 'love' || expression === 'smug';

  return (
    <g>
      {blush ? (
        <g opacity={0.55}>
          <ellipse cx={-8.4 + turn} cy={4} rx={2.6} ry={1.5} fill={PINK} />
          <ellipse cx={8.4 + turn} cy={4} rx={2.6} ry={1.5} fill={PINK} />
        </g>
      ) : null}
      {eyes}
      {brows}
      <g transform={`translate(${turn},0)`}>
        {m.open ? (
          <g>
            <path d={m.d} fill="#5a1f2b" stroke={INK} strokeWidth={1.2} strokeLinejoin="round" />
            {m.tongue ? <ellipse cx={0} cy={9} rx={2.4} ry={1.4} fill="#ff7a8a" /> : null}
            {m.teeth ? <path d="M-4.2,4.7 L4.2,4.7 L3.9,5.9 L-3.9,5.9 Z" fill="#ffffff" /> : null}
          </g>
        ) : (
          <path d={m.d} fill="none" stroke={INK} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        )}
      </g>
      {/* Tears: a streak down each cheek, falling in a loop. */}
      {expression === 'crying' || expression === 'sad'
        ? [-5.4 + turn, 5.4 + turn].slice(0, expression === 'sad' ? 1 : 2).map((x, i) => {
            const fall = ((t * 1.3 + i * 0.5) % 1) * 9;
            return (
              <g key={i}>
                <path d={`M${x},3.4 L${x},${4 + fall}`} stroke="#6cc8ff" strokeWidth={1.6} strokeLinecap="round" opacity={0.9} />
                <circle cx={x} cy={4.6 + fall} r={1.3} fill="#6cc8ff" />
              </g>
            );
          })
        : null}
    </g>
  );
};

/**
 * The marks around a head that manga uses for feelings: drawn in screen
 * orientation, outside the flipped figure, because a question mark or an
 * exclamation mark must never come out backwards.
 */
export const Marks: React.FC<{ expression: Expression; t: number; appear: number }> = ({ expression, t, appear }) => {
  const pop = Math.min(1, appear * 1.4);
  const scale = pop < 1 ? 0.6 + 0.4 * pop + Math.sin(pop * Math.PI) * 0.25 : 1;
  const bob = Math.sin(t * 3) * 0.8;
  const glyph = (text: string, x: number, y: number, size: number, fill: string, rotate = 0): React.ReactNode => (
    <text
      x={x}
      y={y + bob}
      fontSize={size}
      fontWeight={900}
      fontFamily="InterVariable, Arial, sans-serif"
      textAnchor="middle"
      fill={fill}
      stroke={INK}
      strokeWidth={1.1}
      paintOrder="stroke"
      transform={`rotate(${rotate} ${x} ${y})`}
    >
      {text}
    </text>
  );
  let mark: React.ReactNode = null;
  switch (expression) {
    case 'surprised':
      mark = glyph('!', 15, -16, 16, '#ffd23f', 10);
      break;
    case 'shocked':
      mark = (
        <g>
          {glyph('!', 13, -17, 17, '#ff5a3c', 8)}
          {glyph('!', 21, -13, 13, '#ff5a3c', 18)}
        </g>
      );
      break;
    case 'confused':
      mark = glyph('?', 16, -15, 15, '#7fd6ff', 12);
      break;
    case 'tired':
      mark = (
        <g opacity={0.9}>
          {[0, 1, 2].map((i) => {
            const rise = ((t * 0.5 + i / 3) % 1) * 14;
            return glyph('z', 14 + i * 4, -10 - rise, 7 + i * 2, '#e8e2ff');
          })}
        </g>
      );
      break;
    case 'angry': {
      // The cross-shaped vein: four little curved ticks, throbbing.
      const s = 1 + Math.sin(t * 8) * 0.12;
      mark = (
        <g transform={`translate(13,-12) scale(${s})`} stroke="#ff2d3c" strokeWidth={1.8} fill="none" strokeLinecap="round">
          <path d="M-4,-1 Q-1,-1 -1,-4" />
          <path d="M1,-4 Q1,-1 4,-1" />
          <path d="M4,1 Q1,1 1,4" />
          <path d="M-1,4 Q-1,1 -4,1" />
        </g>
      );
      break;
    }
    case 'scared':
      mark = (
        <path
          d="M15,-8 C12,-3 12.5,1 15,1.6 C17.5,1 18,-3 15,-8 Z"
          fill="#9ee0ff"
          stroke={INK}
          strokeWidth={0.9}
          transform={`translate(0,${((t * 0.8) % 1) * 3})`}
        />
      );
      break;
    case 'thinking':
      mark = (
        <g>
          <circle cx={13} cy={-12} r={1.5} fill="#ffffff" stroke={INK} strokeWidth={0.8} />
          <circle cx={17} cy={-17} r={2.3} fill="#ffffff" stroke={INK} strokeWidth={0.8} />
          <ellipse cx={25} cy={-27} rx={9} ry={6.5} fill="#ffffff" stroke={INK} strokeWidth={0.9} />
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={21.5 + i * 3.5} cy={-27} r={1} fill={INK} opacity={(Math.floor(t * 3) % 4) > i ? 1 : 0.2} />
          ))}
        </g>
      );
      break;
    case 'love':
      mark = (
        <g>
          {[0, 1].map((i) => {
            const rise = ((t * 0.6 + i * 0.5) % 1) * 16;
            return (
              <path
                key={i}
                transform={`translate(${12 + i * 7},${-10 - rise}) scale(0.9)`}
                d="M0,3 C-4.6,-0.2 -3,-4.6 0,-2 C3,-4.6 4.6,-0.2 0,3 Z"
                fill="#ff3b5c"
                opacity={1 - rise / 20}
              />
            );
          })}
        </g>
      );
      break;
    case 'determined':
      mark = (
        <g stroke="#ffd23f" strokeWidth={1.4} strokeLinecap="round" opacity={0.5 + 0.5 * Math.abs(Math.sin(t * 4))}>
          <path d="M16,-10 L20,-13" />
          <path d="M17,-5 L22,-6" />
          <path d="M15,-15 L17,-19" />
        </g>
      );
      break;
    default:
      mark = null;
  }
  if (mark === null) return null;
  return <g transform={`scale(${scale})`}>{mark}</g>;
};
