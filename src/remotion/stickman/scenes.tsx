import React from 'react';
import { mulberry32, hashString } from '../../rng.js';
import { SCENES, WEATHERS } from './vocab.js';

/**
 * The world the figure lives in.
 *
 * Drawn, not generated: every setting is layers of flat shapes -- sky, far
 * silhouettes, middle ground, floor -- built from the seed so the same place
 * looks the same every time it comes back, and each has something moving in
 * it. A still background behind a moving figure reads as a slide; clouds that
 * drift, windows that flicker and fireflies that wander read as a place.
 *
 * All of it is flat 2D in a limited palette per scene, lit from one direction,
 * which is what keeps a busy frame from turning into noise at phone size.
 */

export const W = 1080;
export const H = 1920;
/** Where the floor is: feet stand on this line. */
export const GROUND = 1500;

export { SCENES, WEATHERS } from './vocab.js';
export type SceneName = (typeof SCENES)[number];
export const isScene = (value: unknown): value is SceneName =>
  typeof value === 'string' && (SCENES as readonly string[]).includes(value);

export type Weather = (typeof WEATHERS)[number];
export const isWeather = (value: unknown): value is Weather =>
  typeof value === 'string' && (WEATHERS as readonly string[]).includes(value);

/** The outline colour that reads against each scene. */
export const HALO: Record<SceneName, string> = {
  city: '#fffaf0',
  night_city: '#f4efe6',
  forest: '#fffaf0',
  room: '#fffaf0',
  office: '#fffaf0',
  library: '#fff4df',
  desert: '#fffaf0',
  beach: '#ffffff',
  mountains: '#ffffff',
  space: '#eef0ff',
  castle: '#fff4df',
  lab: '#f0fbff',
  stage: '#fff6e0',
};

type Rng = () => number;
const rngFor = (seed: number, key: string): Rng => mulberry32((seed ^ hashString(key)) >>> 0);
const wrap = (value: number, span: number): number => ((value % span) + span) % span;

/* ------------------------------------------------------------ pieces --- */

const Sky: React.FC<{ id: string; top: string; bottom: string }> = ({ id, top, bottom }) => (
  <>
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={top} />
        <stop offset="1" stopColor={bottom} />
      </linearGradient>
    </defs>
    <rect x={0} y={0} width={W} height={H} fill={`url(#${id})`} />
  </>
);

const Cloud: React.FC<{ x: number; y: number; s: number; fill: string; opacity?: number }> = ({ x, y, s, fill, opacity = 1 }) => (
  <g transform={`translate(${x},${y}) scale(${s})`} opacity={opacity} fill={fill}>
    <circle cx={-40} cy={10} r={30} />
    <circle cx={0} cy={-8} r={42} />
    <circle cx={42} cy={8} r={32} />
    <rect x={-70} y={10} width={140} height={30} rx={15} />
  </g>
);

const Clouds: React.FC<{ rng: Rng; t: number; fill: string; count: number; top: number; bottom: number; opacity?: number }> = ({ rng, t, fill, count, top, bottom, opacity }) => (
  <g>
    {Array.from({ length: count }, (_, i) => {
      const speed = 6 + rng() * 10;
      const x = wrap(rng() * (W + 400) + t * speed, W + 400) - 200;
      const y = top + rng() * (bottom - top);
      return <Cloud key={i} x={x} y={y} s={0.6 + rng() * 0.9} fill={fill} opacity={opacity ?? 0.9} />;
    })}
  </g>
);

const Stars: React.FC<{ rng: Rng; t: number; count: number; bottom: number }> = ({ rng, t, count, bottom }) => (
  <g>
    {Array.from({ length: count }, (_, i) => {
      const x = rng() * W;
      const y = rng() * bottom;
      const r = 0.8 + rng() * 2.2;
      const tw = 0.45 + 0.55 * Math.abs(Math.sin(t * (0.6 + rng() * 1.6) + rng() * 6));
      return <circle key={i} cx={x} cy={y} r={r} fill="#fffbe8" opacity={tw} />;
    })}
  </g>
);

/** A row of buildings with lit windows, some of which change as time passes. */
const Skyline: React.FC<{ rng: Rng; t: number; base: number; minH: number; maxH: number; color: string; lit: string; dark: string; litShare: number; pan: number }> = ({ rng, t, base, minH, maxH, color, lit, dark, litShare, pan }) => {
  const buildings: React.ReactNode[] = [];
  let x = -60;
  let i = 0;
  while (x < W + 60) {
    const w = 90 + rng() * 120;
    const h = minH + rng() * (maxH - minH);
    const top = base - h;
    const cols = Math.max(2, Math.floor((w - 20) / 26));
    const rows = Math.max(2, Math.floor((h - 30) / 38));
    const windows: React.ReactNode[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const seed = rng();
        // A few windows switch on or off every few seconds.
        const flicker = seed > 0.93 ? Math.floor(t * 0.4 + seed * 10) % 2 === 0 : true;
        const on = seed < litShare && flicker;
        windows.push(
          <rect
            key={`${r}-${c}`}
            x={x + 12 + c * ((w - 24) / cols)}
            y={top + 18 + r * 38}
            width={(w - 24) / cols - 8}
            height={22}
            fill={on ? lit : dark}
            opacity={on ? 0.95 : 0.6}
          />,
        );
      }
    }
    buildings.push(
      <g key={i}>
        <rect x={x} y={top} width={w} height={h + 400} fill={color} />
        {rng() > 0.6 ? <rect x={x + w * 0.3} y={top - 26} width={w * 0.12} height={26} fill={color} /> : null}
        {windows}
      </g>,
    );
    x += w + 8 + rng() * 20;
    i++;
  }
  return <g transform={`translate(${pan},0)`}>{buildings}</g>;
};

const Hills: React.FC<{ rng: Rng; y: number; amp: number; color: string; pan?: number }> = ({ rng, y, amp, color, pan = 0 }) => {
  const a = rng() * 6;
  const b = rng() * 6;
  const points: string[] = [];
  for (let x = -100; x <= W + 100; x += 30) {
    points.push(`${x},${y - Math.sin(x / 260 + a) * amp - Math.sin(x / 110 + b) * amp * 0.35}`);
  }
  return <path transform={`translate(${pan},0)`} d={`M-100,${H} L${points.join(' L')} L${W + 100},${H} Z`} fill={color} />;
};

const Pine: React.FC<{ x: number; y: number; h: number; color: string; trunk: string; sway: number }> = ({ x, y, h, color, trunk, sway }) => (
  <g transform={`translate(${x},${y}) skewX(${sway})`}>
    <rect x={-h * 0.04} y={-h * 0.18} width={h * 0.08} height={h * 0.2} fill={trunk} />
    <path d={`M0,${-h} L${h * 0.22},${-h * 0.62} L${-h * 0.22},${-h * 0.62} Z`} fill={color} />
    <path d={`M0,${-h * 0.8} L${h * 0.3},${-h * 0.36} L${-h * 0.3},${-h * 0.36} Z`} fill={color} />
    <path d={`M0,${-h * 0.58} L${h * 0.38},${-h * 0.14} L${-h * 0.38},${-h * 0.14} Z`} fill={color} />
  </g>
);

const RoundTree: React.FC<{ x: number; y: number; h: number; leaf: string; light: string; trunk: string; sway: number }> = ({ x, y, h, leaf, light, trunk, sway }) => (
  <g transform={`translate(${x},${y})`}>
    <path d={`M${-h * 0.05},0 L${-h * 0.035},${-h * 0.5} L${h * 0.035},${-h * 0.5} L${h * 0.05},0 Z`} fill={trunk} />
    <g transform={`rotate(${sway} 0 ${-h * 0.5})`}>
      <circle cx={-h * 0.18} cy={-h * 0.62} r={h * 0.24} fill={leaf} />
      <circle cx={h * 0.18} cy={-h * 0.64} r={h * 0.26} fill={leaf} />
      <circle cx={0} cy={-h * 0.84} r={h * 0.27} fill={leaf} />
      <circle cx={-h * 0.08} cy={-h * 0.9} r={h * 0.12} fill={light} opacity={0.55} />
    </g>
  </g>
);

const Floor: React.FC<{ top: string; bottom: string; line: string; id: string }> = ({ top, bottom, line, id }) => (
  <>
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={top} />
        <stop offset="1" stopColor={bottom} />
      </linearGradient>
    </defs>
    <rect x={0} y={GROUND} width={W} height={H - GROUND} fill={`url(#${id})`} />
    <rect x={0} y={GROUND - 3} width={W} height={6} fill={line} />
  </>
);

/** Warm light from a lamp: a soft cone and a pool on the floor. */
const LampLight: React.FC<{ x: number; top: number; color: string; flicker: number }> = ({ x, top, color, flicker }) => (
  <g opacity={0.9 * flicker}>
    <path d={`M${x - 18},${top} L${x - 160},${GROUND} L${x + 160},${GROUND} L${x + 18},${top} Z`} fill={color} opacity={0.12} />
    <ellipse cx={x} cy={GROUND + 10} rx={170} ry={26} fill={color} opacity={0.2} />
  </g>
);

const Birds: React.FC<{ rng: Rng; t: number; count: number; color: string; top: number }> = ({ rng, t, count, color, top }) => (
  <g stroke={color} strokeWidth={4} fill="none" strokeLinecap="round">
    {Array.from({ length: count }, (_, i) => {
      const x = wrap(rng() * W + t * (40 + rng() * 30), W + 200) - 100;
      const y = top + rng() * 200 + Math.sin(t * 2 + i) * 10;
      const flap = Math.sin(t * 9 + i * 2) * 8;
      return <path key={i} d={`M${x - 16},${y - flap} Q${x - 8},${y - 8} ${x},${y} Q${x + 8},${y - 8} ${x + 16},${y - flap}`} />;
    })}
  </g>
);

/* ------------------------------------------------------------ scenes --- */

type SceneProps = { seed: number; t: number; pan: number };

const City: React.FC<SceneProps> = ({ seed, t, pan }) => {
  const r = rngFor(seed, 'city');
  return (
    <g>
      <Sky id="sky-city" top="#3d7bd9" bottom="#9fd3f5" />
      <circle cx={820} cy={330} r={90} fill="#ffe8a3" opacity={0.9} />
      <circle cx={820} cy={330} r={160} fill="#ffe8a3" opacity={0.18} />
      <Clouds rng={r} t={t} fill="#ffffff" count={5} top={180} bottom={700} />
      <Birds rng={r} t={t} count={3} color="#2d4b73" top={420} />
      <Skyline rng={r} t={t} base={GROUND - 40} minH={380} maxH={720} color="#7fa3c9" lit="#dff1ff" dark="#9cbad8" litShare={0.3} pan={pan * 0.3} />
      <Skyline rng={r} t={t} base={GROUND} minH={260} maxH={520} color="#35507a" lit="#ffe39a" dark="#2a4063" litShare={0.35} pan={pan * 0.6} />
      <Floor id="floor-city" top="#9aa3ad" bottom="#6b7580" line="#e9edf1" />
      {[160, 560, 960].map((x, i) => (
        <g key={i}>
          <rect x={x - 5} y={GROUND - 330} width={10} height={330} fill="#2b3444" />
          <path d={`M${x},${GROUND - 330} q0,-26 34,-26`} stroke="#2b3444" strokeWidth={10} fill="none" />
          <rect x={x + 22} y={GROUND - 364} width={28} height={14} rx={4} fill="#fff1b8" />
        </g>
      ))}
      {Array.from({ length: 9 }, (_, i) => (
        <rect key={i} x={i * 130 - 20} y={GROUND + 150} width={70} height={10} fill="#f2f2f2" opacity={0.7} />
      ))}
    </g>
  );
};

const NightCity: React.FC<SceneProps> = ({ seed, t, pan }) => {
  const r = rngFor(seed, 'night_city');
  return (
    <g>
      <Sky id="sky-night" top="#0b1030" bottom="#3a2a5e" />
      <Stars rng={r} t={t} count={90} bottom={900} />
      <circle cx={260} cy={300} r={70} fill="#fdf6d8" />
      <circle cx={285} cy={285} r={62} fill="#0f1438" opacity={0.35} />
      <circle cx={260} cy={300} r={150} fill="#fdf6d8" opacity={0.08} />
      <Skyline rng={r} t={t} base={GROUND - 40} minH={420} maxH={780} color="#1f2250" lit="#ffd36b" dark="#262a5c" litShare={0.35} pan={pan * 0.3} />
      <Skyline rng={r} t={t} base={GROUND} minH={280} maxH={540} color="#13163a" lit="#ffb347" dark="#191c46" litShare={0.45} pan={pan * 0.6} />
      <Floor id="floor-night" top="#2a2d4a" bottom="#15172b" line="#4b4f86" />
      {[200, 860].map((x, i) => {
        const flicker = 0.85 + 0.15 * Math.sin(t * 13 + i * 3) * Math.sin(t * 7);
        return (
          <g key={i}>
            <LampLight x={x + 34} top={GROUND - 350} color="#ffd98a" flicker={flicker} />
            <rect x={x - 5} y={GROUND - 330} width={10} height={330} fill="#0d0f24" />
            <path d={`M${x},${GROUND - 330} q0,-26 34,-26`} stroke="#0d0f24" strokeWidth={10} fill="none" />
            <rect x={x + 22} y={GROUND - 364} width={28} height={14} rx={4} fill="#ffe7a8" opacity={flicker} />
          </g>
        );
      })}
    </g>
  );
};

const Forest: React.FC<SceneProps> = ({ seed, t, pan }) => {
  const r = rngFor(seed, 'forest');
  const sway = Math.sin(t * 0.8) * 1.5;
  return (
    <g>
      <Sky id="sky-forest" top="#7cc4e8" bottom="#e3f3d0" />
      <Clouds rng={r} t={t} fill="#ffffff" count={3} top={160} bottom={480} />
      <Hills rng={r} y={1050} amp={70} color="#8cc08a" pan={pan * 0.2} />
      <g transform={`translate(${pan * 0.35},0)`}>
        {Array.from({ length: 12 }, (_, i) => (
          <Pine key={i} x={i * 100 - 20 + r() * 40} y={GROUND - 120} h={300 + r() * 200} color="#4f8f5c" trunk="#5e4632" sway={sway * 0.5} />
        ))}
      </g>
      <Hills rng={r} y={GROUND - 60} amp={30} color="#5f9f55" pan={pan * 0.5} />
      <g transform={`translate(${pan * 0.6},0)`}>
        <RoundTree x={90} y={GROUND} h={560} leaf="#3f7f3a" light="#8fd07a" trunk="#6b4a2f" sway={sway} />
        <RoundTree x={990} y={GROUND} h={620} leaf="#367235" light="#8fd07a" trunk="#6b4a2f" sway={-sway} />
      </g>
      <Floor id="floor-forest" top="#6aa84f" bottom="#3f7a33" line="#86c060" />
      {Array.from({ length: 22 }, (_, i) => (
        <path key={i} d={`M${r() * W},${GROUND + 20 + r() * 380} l6,-18 l6,18 l6,-14 l6,14`} stroke="#2f6128" strokeWidth={3} fill="none" />
      ))}
      <g>
        <ellipse cx={300} cy={GROUND + 60} rx={22} ry={8} fill="#2f2a26" opacity={0.25} />
        <rect x={294} y={GROUND + 30} width={12} height={30} rx={4} fill="#fff1dc" />
        <path d="M278,1532 Q300,1500 322,1532 Z" fill="#e8412c" />
        <circle cx={292} cy={1522} r={3} fill="#ffffff" />
        <circle cx={306} cy={1518} r={2.5} fill="#ffffff" />
      </g>
      {/* Fireflies, wandering. */}
      {Array.from({ length: 12 }, (_, i) => {
        const x = wrap(r() * W + Math.sin(t * 0.7 + i) * 60, W);
        const y = GROUND - 100 - r() * 500 + Math.cos(t * 0.9 + i * 2) * 40;
        const glow = 0.4 + 0.6 * Math.abs(Math.sin(t * 2 + i));
        return (
          <g key={i} opacity={glow}>
            <circle cx={x} cy={y} r={12} fill="#fff6a0" opacity={0.25} />
            <circle cx={x} cy={y} r={3.4} fill="#fffbd0" />
          </g>
        );
      })}
    </g>
  );
};

const Room: React.FC<SceneProps> = ({ seed, t }) => {
  const r = rngFor(seed, 'room');
  const books = ['#e8412c', '#3aa0ff', '#ffc53d', '#4fbf8a', '#7c5cff', '#ff8fa3', '#f08a3c'];
  return (
    <g>
      <rect x={0} y={0} width={W} height={GROUND} fill="#e9d8c0" />
      {Array.from({ length: 14 }, (_, i) => (
        <rect key={i} x={i * 80} y={0} width={40} height={GROUND} fill="#e2cfb4" />
      ))}
      <rect x={0} y={GROUND - 120} width={W} height={120} fill="#c9a98a" />
      {/* A window with the day moving past it. */}
      <g>
        <rect x={600} y={620} width={360} height={440} fill="#9fd3f5" stroke="#7a5a3f" strokeWidth={18} />
        <g clipPath="url(#room-window)">
          <clipPath id="room-window"><rect x={609} y={629} width={342} height={422} /></clipPath>
          <Cloud x={wrap(t * 14, 560) + 520} y={760} s={0.6} fill="#ffffff" />
          <Hills rng={r} y={1000} amp={20} color="#8cc08a" />
        </g>
        <path d="M780,620 L780,1060 M600,840 L960,840" stroke="#7a5a3f" strokeWidth={12} />
        <rect x={570} y={1060} width={420} height={24} fill="#8a6a4f" />
      </g>
      {/* A bookshelf. */}
      <g>
        <rect x={60} y={560} width={400} height={940} fill="#7a5a3f" />
        {[0, 1, 2, 3].map((shelf) => (
          <g key={shelf}>
            <rect x={80} y={600 + shelf * 220} width={360} height={190} fill="#5e432e" />
            {Array.from({ length: 9 }, (_, i) => {
              const h = 120 + r() * 60;
              return <rect key={i} x={92 + i * 38} y={790 + shelf * 220 - h} width={32} height={h} fill={books[Math.floor(r() * books.length)]} stroke="#3a2a1e" strokeWidth={2} />;
            })}
            <rect x={70} y={790 + shelf * 220} width={380} height={14} fill="#8a6a4f" />
          </g>
        ))}
      </g>
      <Floor id="floor-room" top="#a0724e" bottom="#7a5236" line="#c08e66" />
      <ellipse cx={540} cy={GROUND + 150} rx={380} ry={70} fill="#c64a3c" opacity={0.85} />
      <ellipse cx={540} cy={GROUND + 150} rx={330} ry={52} fill="none" stroke="#f3c6a0" strokeWidth={6} />
      {/* Dust in the light from the window. */}
      {Array.from({ length: 18 }, (_, i) => {
        const x = 600 + r() * 360 + Math.sin(t * 0.5 + i) * 20;
        const y = 1100 + wrap(r() * 400 - t * 12, 400);
        return <circle key={i} cx={x} cy={y} r={2} fill="#fff8e0" opacity={0.6} />;
      })}
    </g>
  );
};

const Office: React.FC<SceneProps> = ({ seed, t }) => {
  const r = rngFor(seed, 'office');
  const minute = (t * 6) % 360;
  return (
    <g>
      <rect x={0} y={0} width={W} height={GROUND} fill="#cfd8e3" />
      <rect x={0} y={GROUND - 90} width={W} height={90} fill="#aebccc" />
      {/* Blinds throwing stripes of light. */}
      <rect x={120} y={420} width={420} height={520} fill="#9fd3f5" />
      {Array.from({ length: 12 }, (_, i) => (
        <rect key={i} x={120} y={420 + i * 44} width={420} height={22} fill="#e6edf5" />
      ))}
      <rect x={110} y={410} width={440} height={540} fill="none" stroke="#8796a8" strokeWidth={10} />
      {/* The clock, moving. */}
      <g transform="translate(820,560)">
        <circle r={90} fill="#ffffff" stroke="#3d4656" strokeWidth={10} />
        <path d={`M0,0 L0,-62`} stroke="#3d4656" strokeWidth={6} strokeLinecap="round" transform={`rotate(${minute})`} />
        <path d={`M0,0 L0,-40`} stroke="#3d4656" strokeWidth={8} strokeLinecap="round" transform={`rotate(${minute / 12 + 120})`} />
        <circle r={7} fill="#e8412c" />
      </g>
      {/* A desk with a glowing screen. */}
      <g>
        <rect x={620} y={1180} width={400} height={24} fill="#6f5846" />
        <rect x={640} y={1204} width={20} height={296} fill="#5a4636" />
        <rect x={980} y={1204} width={20} height={296} fill="#5a4636" />
        <rect x={700} y={1000} width={240} height={160} rx={10} fill="#23222c" />
        <rect x={714} y={1014} width={212} height={132} rx={4} fill="#79d7ff" opacity={0.85 + 0.1 * Math.sin(t * 3)} />
        {Array.from({ length: 5 }, (_, i) => (
          <rect key={i} x={730} y={1030 + i * 22} width={60 + r() * 120} height={8} rx={4} fill="#ffffff" opacity={0.7} />
        ))}
        <rect x={805} y={1160} width={30} height={20} fill="#23222c" />
        <circle cx={660} cy={1150} r={20} fill="#4fbf8a" />
        <rect x={648} y={1150} width={24} height={30} fill="#c98a4b" />
      </g>
      <g>
        <rect x={40} y={1100} width={160} height={400} fill="#8796a8" />
        {[0, 1, 2].map((i) => (
          <g key={i}>
            <rect x={55} y={1120 + i * 125} width={130} height={110} fill="#9eacbd" />
            <rect x={100} y={1165 + i * 125} width={40} height={10} rx={5} fill="#5b6778" />
          </g>
        ))}
      </g>
      <Floor id="floor-office" top="#8b95a3" bottom="#6a7482" line="#b2bcc8" />
    </g>
  );
};

const Library: React.FC<SceneProps> = ({ seed, t }) => {
  const r = rngFor(seed, 'library');
  const books = ['#8e2c2c', '#2c4f8e', '#b98a2c', '#2c7a5a', '#5a2c7a', '#a65c2c'];
  return (
    <g>
      <rect x={0} y={0} width={W} height={GROUND} fill="#3a2419" />
      {[0, 1, 2].map((column) => (
        <g key={column}>
          <rect x={20 + column * 360} y={200} width={320} height={1300} fill="#5a3a26" />
          {Array.from({ length: 7 }, (_, shelf) => (
            <g key={shelf}>
              <rect x={36 + column * 360} y={230 + shelf * 180} width={288} height={160} fill="#2b1a11" />
              {Array.from({ length: 8 }, (_, i) => {
                const h = 110 + r() * 45;
                return <rect key={i} x={44 + column * 360 + i * 35} y={390 + shelf * 180 - h} width={30} height={h} fill={books[Math.floor(r() * books.length)]} stroke="#1a100a" strokeWidth={2} />;
              })}
              <rect x={28 + column * 360} y={388 + shelf * 180} width={304} height={12} fill="#7a5236" />
            </g>
          ))}
        </g>
      ))}
      {/* A ladder leaning on the middle stack. */}
      <g stroke="#8a6440" strokeWidth={10}>
        <path d="M600,420 L520,1500" />
        <path d="M690,420 L610,1500" />
        {Array.from({ length: 9 }, (_, i) => (
          <path key={i} d={`M${596 - i * 9},${480 + i * 118} L${686 - i * 9},${480 + i * 118}`} strokeWidth={8} />
        ))}
      </g>
      {/* Warm hanging lamps and the dust that floats in their light. */}
      {[240, 840].map((x, i) => {
        const glow = 0.9 + 0.1 * Math.sin(t * 5 + i);
        return (
          <g key={i}>
            <path d={`M${x},0 L${x},560`} stroke="#1a100a" strokeWidth={4} />
            <circle cx={x} cy={600} r={180} fill="#ffc46b" opacity={0.12 * glow} />
            <path d={`M${x - 50},600 L${x + 50},600 L${x + 26},556 L${x - 26},556 Z`} fill="#c9a24a" />
            <ellipse cx={x} cy={604} rx={30} ry={10} fill="#fff1c1" opacity={glow} />
          </g>
        );
      })}
      <rect x={0} y={0} width={W} height={GROUND} fill="#ffb347" opacity={0.06} />
      {Array.from({ length: 24 }, (_, i) => {
        const x = r() * W + Math.sin(t * 0.4 + i) * 30;
        const y = 500 + wrap(r() * 900 - t * 10, 900);
        return <circle key={i} cx={x} cy={y} r={2.2} fill="#ffe7b0" opacity={0.5} />;
      })}
      <Floor id="floor-library" top="#6b4430" bottom="#4a2d1f" line="#8a5f43" />
      <ellipse cx={540} cy={GROUND + 160} rx={420} ry={80} fill="#7a1f2b" opacity={0.8} />
    </g>
  );
};

const Desert: React.FC<SceneProps> = ({ seed, t, pan }) => {
  const r = rngFor(seed, 'desert');
  const roll = wrap(t * 90, W + 300) - 150;
  return (
    <g>
      <Sky id="sky-desert" top="#ff9a5a" bottom="#ffe0a3" />
      <circle cx={540} cy={640} r={150} fill="#fff1c1" />
      <circle cx={540} cy={640} r={260} fill="#fff1c1" opacity={0.2} />
      <Hills rng={r} y={1150} amp={60} color="#e8a766" pan={pan * 0.2} />
      <Hills rng={r} y={1320} amp={50} color="#d98f4e" pan={pan * 0.4} />
      <g transform={`translate(${pan * 0.6},0)`}>
        {[140, 900].map((x, i) => (
          <g key={i} fill="#4f8a4a" stroke="#2f5f2d" strokeWidth={4}>
            <rect x={x - 22} y={GROUND - 300} width={44} height={300} rx={22} />
            <path d={`M${x - 22},${GROUND - 160} h-50 a20,20 0 0 1 -20,-20 v-70 a18,18 0 0 1 36,0 v50 h34`} />
            <path d={`M${x + 22},${GROUND - 200} h44 a20,20 0 0 0 20,-20 v-50 a18,18 0 0 0 -36,0 v30 h-28`} />
          </g>
        ))}
      </g>
      <Floor id="floor-desert" top="#e9b877" bottom="#c98f52" line="#f3cf98" />
      <g transform={`translate(${roll},${GROUND - 40}) rotate(${t * 240})`} stroke="#8a6440" strokeWidth={3} fill="none">
        <circle r={36} />
        <path d="M-30,-10 Q0,30 30,-12 M-20,24 Q0,-30 24,20 M-34,6 Q0,-8 32,10" />
      </g>
    </g>
  );
};

const Beach: React.FC<SceneProps> = ({ seed, t, pan }) => {
  const r = rngFor(seed, 'beach');
  const wave = (offset: number, amp: number): string => {
    const points: string[] = [];
    for (let x = -40; x <= W + 40; x += 30) {
      points.push(`${x},${Math.sin(x / 70 + t * 1.6 + offset) * amp}`);
    }
    return `M-40,40 L${points.join(' L')} L${W + 40},40 Z`;
  };
  return (
    <g>
      <Sky id="sky-beach" top="#ff7e79" bottom="#ffd29a" />
      <circle cx={540} cy={1060} r={180} fill="#ffe28a" />
      <Clouds rng={r} t={t} fill="#ffc2b0" count={4} top={200} bottom={700} />
      <Birds rng={r} t={t} count={4} color="#6b3a4a" top={500} />
      <rect x={0} y={1080} width={W} height={260} fill="#3b7fb8" />
      <g transform="translate(0,1080)"><path d={wave(0, 8)} fill="#5aa0d6" /></g>
      <rect x={540 - 170} y={1100} width={340} height={10} fill="#ffe28a" opacity={0.5} />
      <rect x={540 - 110} y={1140} width={220} height={8} fill="#ffe28a" opacity={0.4} />
      <g transform="translate(0,1320)"><path d={wave(2, 14)} fill="#8fd0f0" /></g>
      <g transform={`translate(${pan * 0.6},0)`}>
        <path d={`M880,${GROUND} Q900,1200 960,1000`} stroke="#8a6440" strokeWidth={26} fill="none" />
        {[0, 1, 2, 3, 4].map((i) => (
          <path key={i} transform={`rotate(${-70 + i * 35 + Math.sin(t + i) * 4} 960 1000)`} d="M960,1000 q90,-40 170,20 q-90,-10 -170,-20 Z" fill="#3f8f3a" />
        ))}
      </g>
      <Floor id="floor-beach" top="#f7dca5" bottom="#e9c27e" line="#fff0cc" />
    </g>
  );
};

const Mountains: React.FC<SceneProps> = ({ seed, t, pan }) => {
  const r = rngFor(seed, 'mountains');
  const peak = (x: number, h: number, w: number, color: string, snow: boolean): React.ReactNode => (
    <g key={`${x}`}>
      <path d={`M${x - w},${GROUND} L${x},${GROUND - h} L${x + w},${GROUND} Z`} fill={color} />
      {snow ? <path d={`M${x - w * 0.28},${GROUND - h * 0.72} L${x},${GROUND - h} L${x + w * 0.28},${GROUND - h * 0.72} L${x + w * 0.1},${GROUND - h * 0.66} L${x - w * 0.05},${GROUND - h * 0.74} Z`} fill="#ffffff" /> : null}
    </g>
  );
  return (
    <g>
      <Sky id="sky-mountains" top="#4b86c7" bottom="#cfe6f5" />
      <Clouds rng={r} t={t} fill="#ffffff" count={4} top={250} bottom={650} />
      <g transform={`translate(${pan * 0.2},0)`}>
        {peak(200, 900, 420, '#6b84a8', true)}
        {peak(760, 1050, 480, '#5b7398', true)}
      </g>
      <g transform={`translate(${pan * 0.4},0)`}>
        {peak(480, 640, 420, '#48607f', true)}
        {peak(1000, 560, 340, '#526a8c', false)}
      </g>
      <Clouds rng={r} t={t * 0.6} fill="#eef5fb" count={3} top={900} bottom={1100} opacity={0.7} />
      <g transform={`translate(${pan * 0.6},0)`}>
        {Array.from({ length: 9 }, (_, i) => (
          <Pine key={i} x={i * 130 + r() * 40} y={GROUND} h={220 + r() * 120} color="#2f5f4a" trunk="#4a3526" sway={Math.sin(t) * 0.8} />
        ))}
      </g>
      <Floor id="floor-mountains" top="#7ca36a" bottom="#557a48" line="#a6c78f" />
    </g>
  );
};

const Space: React.FC<SceneProps> = ({ seed, t, pan }) => {
  const r = rngFor(seed, 'space');
  return (
    <g>
      <Sky id="sky-space" top="#05030f" bottom="#1b0f3a" />
      <ellipse cx={720} cy={520} rx={520} ry={260} fill="#7c3aed" opacity={0.18} />
      <ellipse cx={320} cy={820} rx={420} ry={200} fill="#ec4899" opacity={0.12} />
      <Stars rng={r} t={t} count={160} bottom={GROUND} />
      <g transform={`translate(${pan * 0.2},0)`}>
        <circle cx={820} cy={420} r={120} fill="#f08a3c" />
        <ellipse cx={820} cy={420} rx={200} ry={34} fill="none" stroke="#ffd2a3" strokeWidth={10} transform="rotate(-18 820 420)" />
        <circle cx={220} cy={640} r={46} fill="#5ab0ff" />
      </g>
      {[0, 1, 2].map((i) => {
        const y = 900 + i * 120 + Math.sin(t * 0.8 + i) * 20;
        return <path key={i} transform={`translate(${200 + i * 300},${y}) rotate(${t * (10 + i * 7)})`} d="M-30,-10 L-10,-28 L22,-20 L30,6 L8,26 L-24,18 Z" fill="#6b5a7a" stroke="#3d3346" strokeWidth={4} />;
      })}
      <Floor id="floor-space" top="#8e8aa0" bottom="#5c586e" line="#c3bfd4" />
      {[160, 520, 860].map((x, i) => (
        <ellipse key={i} cx={x} cy={GROUND + 120 + i * 40} rx={70} ry={18} fill="#6f6b82" />
      ))}
    </g>
  );
};

const Castle: React.FC<SceneProps> = ({ seed, t, pan }) => {
  const r = rngFor(seed, 'castle');
  const flag = Math.sin(t * 5);
  return (
    <g>
      <Sky id="sky-castle" top="#6b4a8a" bottom="#f0a07a" />
      <Clouds rng={r} t={t} fill="#f7c2b0" count={4} top={200} bottom={600} opacity={0.8} />
      <g transform={`translate(${pan * 0.3},0)`} fill="#6e6a7c">
        <rect x={140} y={620} width={800} height={900} />
        {[140, 440, 740].map((x) => (
          <g key={x}>
            <rect x={x} y={460} width={200} height={1040} />
            {[0, 1, 2, 3].map((i) => <rect key={i} x={x + i * 52} y={430} width={34} height={40} />)}
            <path d={`M${x + 100},460 L${x + 100},360`} stroke="#3d3346" strokeWidth={6} />
            <path d={`M${x + 100},362 Q${x + 140},${372 + flag * 6} ${x + 180},362 L${x + 180},400 Q${x + 140},${410 + flag * 6} ${x + 100},400 Z`} fill="#e8412c" />
            <rect x={x + 80} y={560} width={40} height={70} rx={20} fill="#2b2433" />
          </g>
        ))}
        <path d="M460,1500 L460,1260 Q540,1160 620,1260 L620,1500 Z" fill="#2b2433" />
      </g>
      {[80, 1000].map((x, i) => {
        const f = 1 + Math.sin(t * 17 + i) * 0.1;
        return (
          <g key={i}>
            <circle cx={x} cy={1140} r={70} fill="#ffb347" opacity={0.18 * f} />
            <rect x={x - 6} y={1150} width={12} height={60} fill="#5e4632" />
            <path transform={`translate(${x},1146) scale(${f})`} d="M0,-34 C16,-14 14,4 0,6 C-14,4 -16,-14 0,-34 Z" fill="#ff7a1a" />
          </g>
        );
      })}
      <Floor id="floor-castle" top="#8a8494" bottom="#5c5766" line="#b0aabb" />
      {Array.from({ length: 8 }, (_, row) => (
        <path key={row} d={`M0,${GROUND + 50 + row * 55} L${W},${GROUND + 50 + row * 55}`} stroke="#6e6878" strokeWidth={3} />
      ))}
    </g>
  );
};

const Lab: React.FC<SceneProps> = ({ seed, t }) => {
  const r = rngFor(seed, 'lab');
  const liquids = ['#4fbf8a', '#ff5a8a', '#3aa0ff', '#ffc53d', '#9b6bff'];
  return (
    <g>
      <rect x={0} y={0} width={W} height={GROUND} fill="#1f3340" />
      {Array.from({ length: 10 }, (_, i) => <rect key={i} x={0} y={i * 150} width={W} height={3} fill="#2b4556" />)}
      <path d="M0,300 L1080,300 M0,340 L1080,340" stroke="#4d6b7d" strokeWidth={14} />
      {[0, 1].map((shelf) => (
        <g key={shelf}>
          <rect x={60} y={620 + shelf * 300} width={960} height={16} fill="#6b8394" />
          {Array.from({ length: 8 }, (_, i) => {
            const x = 110 + i * 118;
            const color = liquids[Math.floor(r() * liquids.length)]!;
            const top = 620 + shelf * 300;
            return (
              <g key={i}>
                <path d={`M${x - 14},${top - 110} L${x + 14},${top - 110} L${x + 14},${top - 70} L${x + 38},${top} L${x - 38},${top} L${x - 14},${top - 70} Z`} fill="#dff4ff" fillOpacity={0.25} stroke="#bfe3f2" strokeWidth={4} />
                <path d={`M${x - 28},${top - 20} L${x + 28},${top - 20} L${x + 38},${top} L${x - 38},${top} Z`} fill={color} opacity={0.85} />
                {[0, 1, 2].map((b) => {
                  const rise = wrap(t * (20 + b * 7) + b * 30 + i * 11, 90);
                  return <circle key={b} cx={x + Math.sin(t * 3 + b + i) * 6} cy={top - 22 - rise} r={3 + b} fill={color} opacity={1 - rise / 90} />;
                })}
              </g>
            );
          })}
        </g>
      ))}
      {/* The machine, blinking. */}
      <g>
        <rect x={680} y={1060} width={320} height={440} rx={12} fill="#34495a" stroke="#6b8394" strokeWidth={6} />
        <rect x={710} y={1090} width={260} height={140} rx={8} fill="#0f2a1f" />
        <path d={`M720,1160 ${Array.from({ length: 24 }, (_, i) => `L${720 + i * 10},${1160 + Math.sin(i * 0.9 + t * 6) * 30}`).join(' ')}`} stroke="#4fff9a" strokeWidth={4} fill="none" />
        {Array.from({ length: 6 }, (_, i) => (
          <circle key={i} cx={730 + i * 44} cy={1290} r={12} fill={liquids[i % liquids.length]} opacity={Math.floor(t * 3 + i * 1.7) % 3 === 0 ? 1 : 0.3} />
        ))}
      </g>
      <Floor id="floor-lab" top="#9fb4c2" bottom="#6f8594" line="#d3e2ec" />
      {Array.from({ length: 6 }, (_, i) => <path key={i} d={`M${i * 200},${GROUND} L${i * 200 - 120},${H}`} stroke="#8aa0af" strokeWidth={3} />)}
    </g>
  );
};

const Stage: React.FC<SceneProps> = ({ t }) => {
  const drift = Math.sin(t * 0.5) * 40;
  return (
    <g>
      <rect x={0} y={0} width={W} height={H} fill="#0c0a12" />
      {/* Curtains. */}
      {[0, 1].map((side) => (
        <g key={side} transform={side === 1 ? `translate(${W},0) scale(-1,1)` : undefined}>
          <path d="M0,0 L220,0 Q150,700 200,1500 L0,1500 Z" fill="#6e1423" />
          {[40, 90, 140].map((x) => <path key={x} d={`M${x},0 Q${x - 20},700 ${x + 10},1500`} stroke="#4a0c17" strokeWidth={10} fill="none" />)}
        </g>
      ))}
      <path d="M0,0 L1080,0 L1080,120 Q540,200 0,120 Z" fill="#8a1a2c" />
      {/* The spotlight, following the performer a little. */}
      <path d={`M${480 + drift},0 L${600 + drift},0 L${800 + drift},${GROUND + 40} L${280 + drift},${GROUND + 40} Z`} fill="#fff4d6" opacity={0.12} />
      <ellipse cx={540 + drift} cy={GROUND + 30} rx={280} ry={50} fill="#fff4d6" opacity={0.25} />
      <Floor id="floor-stage" top="#3a2a22" bottom="#20160f" line="#6b4a36" />
    </g>
  );
};

const RENDERERS: Record<SceneName, React.FC<SceneProps>> = {
  city: City,
  night_city: NightCity,
  forest: Forest,
  room: Room,
  office: Office,
  library: Library,
  desert: Desert,
  beach: Beach,
  mountains: Mountains,
  space: Space,
  castle: Castle,
  lab: Lab,
  stage: Stage,
};

export const Scene: React.FC<{ name: SceneName; seed: number; t: number; pan: number }> = ({ name, seed, t, pan }) => {
  const Renderer = RENDERERS[name];
  return <Renderer seed={seed} t={t} pan={pan} />;
};

/* ------------------------------------------------------------ weather --- */

/** The darkening a storm puts on the world: behind the characters, not over them. */
export const WeatherTint: React.FC<{ weather: Weather }> = ({ weather }) =>
  weather === 'rain' || weather === 'storm' ? (
    <rect x={0} y={0} width={W} height={H} fill="#1a2433" opacity={weather === 'storm' ? 0.35 : 0.2} />
  ) : null;

export const WeatherLayer: React.FC<{ weather: Weather; seed: number; t: number }> = ({ weather, seed, t }) => {
  const r = rngFor(seed, `weather-${weather}`);
  switch (weather) {
    case 'rain':
    case 'storm': {
      const flash =
        weather === 'storm' && (Math.floor(t * 0.5) * 7919) % 5 === 0 && (t * 0.5) % 1 < 0.08
          ? 1 - ((t * 0.5) % 1) / 0.08
          : 0;
      return (
        <g>
          <g stroke="#cfe3ff" strokeWidth={3} opacity={0.55} strokeLinecap="round">
            {Array.from({ length: 110 }, (_, i) => {
              const x = r() * (W + 200) - 100;
              const speed = 1400 + r() * 600;
              const y = wrap(r() * H + t * speed, H + 100) - 50;
              return <path key={i} d={`M${x},${y} l-8,40`} />;
            })}
          </g>
          {flash > 0 ? <rect x={0} y={0} width={W} height={H} fill="#ffffff" opacity={0.55 * flash} /> : null}
        </g>
      );
    }
    case 'snow':
      return (
        <g fill="#ffffff">
          {Array.from({ length: 90 }, (_, i) => {
            const size = 2 + r() * 5;
            const x = wrap(r() * W + Math.sin(t * 0.8 + i) * 30, W);
            const y = wrap(r() * H + t * (60 + size * 18), H);
            return <circle key={i} cx={x} cy={y} r={size} opacity={0.85} />;
          })}
        </g>
      );
    case 'fog':
      return (
        <g>
          {[0, 1, 2].map((i) => (
            <ellipse key={i} cx={wrap(t * (18 + i * 8) + i * 400, W + 800) - 400} cy={1100 + i * 180} rx={700} ry={140} fill="#e6ecf2" opacity={0.28} />
          ))}
        </g>
      );
    case 'embers':
      return (
        <g>
          {Array.from({ length: 50 }, (_, i) => {
            const x = wrap(r() * W + Math.sin(t + i) * 40, W);
            const y = wrap(r() * H - t * (80 + r() * 90), H);
            return <circle key={i} cx={x} cy={y} r={2 + r() * 3} fill={r() > 0.5 ? '#ff9d2e' : '#ffd36b'} opacity={0.8} />;
          })}
        </g>
      );
    case 'leaves':
      return (
        <g>
          {Array.from({ length: 26 }, (_, i) => {
            const x = wrap(r() * W + t * 60 + Math.sin(t * 1.3 + i) * 50, W);
            const y = wrap(r() * H + t * (90 + r() * 60), H);
            return <ellipse key={i} cx={x} cy={y} rx={10} ry={5} fill={r() > 0.5 ? '#f08a3c' : '#d9a441'} transform={`rotate(${t * 120 + i * 40} ${x} ${y})`} />;
          })}
        </g>
      );
    default:
      return null;
  }
};
