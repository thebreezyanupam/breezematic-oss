import React from 'react';
import { beatRng } from '../../rng.js';

/**
 * The life in a place: birds crossing the sky, smoke on the horizon, dust in
 * the light of a room.
 *
 * A painted place is a still, and a still behind a moving figure reads as a
 * stage set -- the one thing a scene most needs to not look like. So each
 * place gets a little of what moves in it, chosen from what the place already
 * says it is: the director's setting in words ("a dusty wheat field in Western
 * Australia"), the drawn scene, the weather. Nothing new is asked of the
 * model, so every video already staged gets it too, and nothing costs.
 *
 * Deliberately small and far away. It is the background living, not a second
 * subject: a flock is a few specks, smoke is on the horizon, a flash is a
 * glow behind the hills. Anything big enough to look at would be competing
 * with the figure.
 */

export type Ambient = 'birds' | 'gulls' | 'crows' | 'smoke' | 'flashes' | 'motes' | 'fireflies';

const has = (text: string, pattern: RegExp): boolean => pattern.test(text);

const INDOOR = /\b(office|room|hall|chamber|inside|interior|bunker|tent|library|study|kitchen|cell|cockpit|cabin|parlou?r|court ?room|headquarters|barracks|tavern|throne)\b/;
const SEA = /\b(sea|ocean|beach|harbou?r|coast|port|bay|shore|dock|pier|island)\b/;
const BATTLE = /\b(battle|battlefield|trench|trenches|front|frontline|siege|bombard|artillery|burning|ruins?|shelled|war-torn|besieged|no man'?s land)\b/;
const MOURNING = /\b(grave|graves|graveyard|cemetery|funeral|aftermath|corpses?|fallen|wasteland)\b/;
const NIGHT = /\b(night|midnight|moonlit|moonlight|dusk|starlit)\b/;
const INDOOR_SCENES = new Set(['room', 'office', 'library', 'lab', 'stage']);

/** What moves in a place, from what the place says about itself. */
export function ambienceFor(stage: { setting?: string; scene?: string; weather?: string; war?: { gag?: string } } | null | undefined): Ambient[] {
  const setting = (stage?.setting ?? '').toLowerCase();
  const scene = stage?.scene ?? '';
  const weather = stage?.weather ?? 'clear';
  if (scene === 'space') return [];
  const indoor = has(setting, INDOOR) || (setting === '' && INDOOR_SCENES.has(scene));
  if (indoor) return ['motes'];

  const out: Ambient[] = [];
  const night = has(setting, NIGHT) || scene === 'night_city';
  const battle = has(setting, BATTLE) || weather === 'embers';
  const calm = weather === 'clear' || weather === 'fog' || weather === 'leaves';
  if (battle) out.push('smoke', 'flashes');
  if (has(setting, MOURNING)) out.push('crows');
  if (night) {
    if (!battle && calm) out.push('fireflies');
  } else if (calm && !battle) {
    out.push(has(setting, SEA) || scene === 'beach' ? 'gulls' : 'birds');
  }
  return out;
}

type View = { x: number; y: number; w: number; h: number; scale: number };

/** A bird in flight: two arcs that beat. `flap` is -1..1. */
function birdPath(size: number, flap: number): string {
  const lift = size * (0.25 + 0.45 * flap);
  return `M${-size},${-lift} Q${-size * 0.45},${-size * 0.05 - lift * 0.3} 0,0 Q${size * 0.45},${-size * 0.05 - lift * 0.3} ${size},${-lift}`;
}

export const AmbientLife: React.FC<{ kinds: readonly Ambient[]; t: number; seed: number; id: string; view: View }> = ({ kinds, t, seed, id, view }) => {
  if (kinds.length === 0) return null;
  const sky = { top: view.y + view.h * 0.06, bottom: view.y + view.h * 0.36 };
  const horizon = view.y + view.h * 0.47;
  const unit = view.w / 1080;
  const layers: React.ReactNode[] = [];
  // One filter per place, named for it: two beats on screen at once in a
  // transition must not share an id.
  const soft = `amb-soft-${id.replace(/[^a-z0-9]/gi, '').slice(-16)}`;

  for (const kind of kinds) {
    const r = beatRng(seed, `${id}-amb-${kind}`);

    if (kind === 'birds' || kind === 'gulls') {
      // Flocks cross the sky now and then, each on its own line and pace, on
      // the video's clock so a stretch of beats is one sky, not a restart.
      const flocks = kind === 'gulls' ? 2 : 2;
      for (let f = 0; f < flocks; f++) {
        const cycle = 11 + r() * 7;
        const offset = r() * cycle;
        const leftward = r() < 0.5;
        const altitude = sky.top + (sky.bottom - sky.top) * r();
        const count = kind === 'gulls' ? 2 + Math.floor(r() * 2) : 4 + Math.floor(r() * 4);
        // Big enough to read as birds at phone size, small enough to stay far off.
        const size = (kind === 'gulls' ? 19 : 14 + r() * 5) * unit;
        const phase = ((t + offset) % cycle) / cycle;
        const across = -0.15 + phase * 1.3;
        const cx = view.x + view.w * (leftward ? 1 - across : across);
        for (let b = 0; b < count; b++) {
          // A loose V: each bird a little behind and to the side of the last.
          const back = b * size * 2.6 * (leftward ? 1 : -1);
          const side = (b % 2 === 0 ? 1 : -1) * Math.ceil(b / 2) * size * 1.3;
          const bob = Math.sin(t * 1.3 + b) * size * 0.4;
          const beat = kind === 'gulls' ? Math.sin(t * 2.2 + b) * 0.5 : Math.sin(t * (9 + b) + b * 1.7);
          const d = birdPath(size, beat);
          const at = `translate(${cx + back},${altitude + side + bob})`;
          const width = Math.max(2.4, size * 0.2);
          layers.push(
            kind === 'gulls' ? (
              // White on a pale sky disappears: a dark edge first, like the figures' ink.
              <g key={`${kind}${f}-${b}`} transform={at} fill="none" strokeLinecap="round">
                <path d={d} stroke="#3a3d45" strokeWidth={width + 2.4} />
                <path d={d} stroke="#fbfaf6" strokeWidth={width} />
              </g>
            ) : (
              <path key={`${kind}${f}-${b}`} d={d} transform={at} fill="none" stroke="#1f1f24" strokeWidth={width} strokeLinecap="round" opacity={0.85} />
            ),
          );
        }
      }
    }

    if (kind === 'crows') {
      const cx = view.x + view.w * (0.25 + r() * 0.5);
      const cy = sky.top + (sky.bottom - sky.top) * 0.5;
      for (let b = 0; b < 4; b++) {
        const a = t * (0.35 + b * 0.05) + b * 1.6;
        const radius = (60 + b * 22) * unit;
        layers.push(
          <path
            key={`crow${b}`}
            d={birdPath(9 * unit, Math.sin(t * 6 + b) * 0.6)}
            transform={`translate(${cx + Math.cos(a) * radius},${cy + Math.sin(a) * radius * 0.3})`}
            fill="none"
            stroke="#141418"
            strokeWidth={2}
            strokeLinecap="round"
            opacity={0.85}
          />,
        );
      }
    }

    if (kind === 'smoke') {
      // Columns on the horizon, rising and leaning with the wind -- softened,
      // or a column of puffs reads as a stack of grey balls.
      const puffs: React.ReactNode[] = [];
      const columns = 2;
      for (let c = 0; c < columns; c++) {
        const x0 = view.x + view.w * (0.12 + 0.76 * ((c + r() * 0.8) / columns));
        for (let p = 0; p < 9; p++) {
          const age = (t * 0.12 + p / 9 + c * 0.37) % 1;
          puffs.push(
            <circle
              key={`smoke${c}-${p}`}
              cx={x0 + age * 60 * unit + Math.sin(age * 5 + p) * 6 * unit}
              cy={horizon - age * 170 * unit}
              r={(10 + age * 46) * unit}
              fill="#4a4541"
              opacity={0.62 * (1 - age) * Math.min(1, age * 6)}
            />,
          );
        }
      }
      layers.push(
        <g key="smoke" filter={`url(#${soft})`}>
          {puffs}
        </g>,
      );
    }

    if (kind === 'flashes') {
      // Artillery behind the hills: a glow that blooms and fades, now and then.
      for (let k = 0; k < 2; k++) {
        const period = 3.2 + r() * 2.5;
        const local = (t + r() * period) % period;
        if (local > 0.45) continue;
        const burst = Math.floor((t + r() * period) / period);
        const x = view.x + view.w * (0.1 + ((burst * 0.618 + k * 0.37) % 0.8));
        const glow = local < 0.08 ? local / 0.08 : 1 - (local - 0.08) / 0.37;
        layers.push(
          <g key={`flash${k}`} opacity={glow}>
            <ellipse cx={x} cy={horizon - 4 * unit} rx={70 * unit} ry={26 * unit} fill="#ffb347" opacity={0.35} />
            <ellipse cx={x} cy={horizon - 2 * unit} rx={22 * unit} ry={9 * unit} fill="#fff1c9" opacity={0.8} />
          </g>,
        );
      }
    }

    if (kind === 'motes' || kind === 'fireflies') {
      const n = kind === 'motes' ? 42 : 18;
      for (let m = 0; m < n; m++) {
        const bx = r();
        const by = r();
        const speed = 0.2 + r() * 0.4;
        const x = view.x + view.w * ((bx + Math.sin(t * speed * 0.3 + m) * 0.02 + t * 0.004 * speed) % 1);
        const y = view.y + view.h * (kind === 'motes' ? 0.08 + by * 0.6 : 0.45 + by * 0.4) + Math.sin(t * speed + m * 2) * 10 * unit;
        const twinkle = 0.5 + 0.5 * Math.sin(t * (kind === 'motes' ? 1.1 : 3.3) + m * 2.1);
        layers.push(
          kind === 'motes' ? (
            <g key={`mote${m}`}>
              <circle cx={x} cy={y} r={5 * unit} fill="#fff1c8" opacity={0.08 + 0.1 * twinkle} />
              <circle cx={x} cy={y} r={2.2 * unit} fill="#fff8e6" opacity={0.3 + 0.45 * twinkle} />
            </g>
          ) : (
            <g key={`fly${m}`} opacity={twinkle}>
              <circle cx={x} cy={y} r={7 * unit} fill="#f5e27a" opacity={0.25} />
              <circle cx={x} cy={y} r={2 * unit} fill="#fff6b0" />
            </g>
          ),
        );
      }
    }
  }
  return (
    <g pointerEvents="none">
      <defs>
        <filter id={soft} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={7 * unit} />
        </filter>
      </defs>
      {layers}
    </g>
  );
};
