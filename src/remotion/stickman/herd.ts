import { beatRng } from '../../rng.js';
import { creatureHeight, creatureWidth, type CreatureName, type Gait } from './creature.js';
import { GROUND, W } from './scenes.js';
import type { CREATURE_ROLES } from './vocab.js';

/** The figure's scale in a full-size (portrait) view, which the distances here are measured against. */
const FULL_SCALE = 5.4;

export type Placed = { x: number; ground: number; scale: number; right: boolean; gait: Gait };

/**
 * Where each animal stands and how it moves this frame.
 *
 * The same scale as the figures, so an emu comes up to the hero's chin and an
 * elephant towers over it. A herd is two rows -- the back one smaller and
 * higher, which is all the depth a flat world needs -- and is allowed to run
 * off the edge of the frame: a flock that fits neatly on screen reads as
 * seven emus, one that does not reads as twenty thousand.
 */
export function creatureLayout(options: {
  name: CreatureName;
  role: (typeof CREATURE_ROLES)[number];
  count: number;
  heroX: number;
  facingRight: boolean;
  progress: number;
  seed: number;
  id: string;
  /** The figures' scale in this view: a long video's are smaller. */
  scale: number;
}): Placed[] {
  const { name, role, count, heroX, facingRight, progress } = options;
  // Distances below were tuned in figure units at a full-size view.
  const s = options.scale / FULL_SCALE;
  /**
   * Small animals are drawn bigger than life. A pigeon at true size next to a
   * person is a grey fleck, and when the pigeon is the story -- Cher Ami, the
   * trench rats -- it has to be something a viewer can see from the sofa.
   */
  const scale = options.scale * Math.min(2, Math.max(1, 32 / creatureHeight(name)));
  const width = creatureWidth(name) * scale;
  const spacing = Math.max(width * 0.85, 60 * s);
  const rng = beatRng(options.seed, `${options.id}-creature`);
  const out: Placed[] = [];
  const back = (i: number): boolean => count > 1 && i % 2 === 1;

  for (let i = 0; i < count; i++) {
    const row = back(i) ? 1 : 0;
    const col = Math.floor(i / 2);
    const rowScale = scale * (row === 1 ? 0.8 : 1);
    const ground = GROUND - row * 46 * s * 2;
    const jitter = (rng() - 0.5) * spacing * 0.3;

    if (role === 'wild') {
      // Spread over the whole field, each on its own business.
      let x = count === 1 ? (heroX < W / 2 ? W * 0.76 : W * 0.24) : W * (0.08 + (0.84 * (i + 0.5)) / count) + jitter;
      // Never grazing on the hero's head: step aside, to whichever side is nearer.
      const clear = width * 0.8;
      if (Math.abs(x - heroX) < clear) x = heroX + (x < heroX ? -clear : clear);
      const grazing = rng() < 0.55;
      const right = rng() < 0.5;
      out.push({
        x: x + (grazing ? 0 : (right ? 1 : -1) * 60 * s * progress),
        ground: GROUND - 46 * s * 2 - (i % 2) * 20 * s,
        scale: scale * 0.78,
        right,
        gait: grazing ? 'peck' : 'walk',
      });
      continue;
    }

    // The side of the hero the animals are on: in front of it for an enemy and
    // for animals running away, behind it for allies.
    const ahead = facingRight ? 1 : -1;
    const side = role === 'ally' ? -ahead : ahead;
    // Clear of the hero by the length of a neck: an enemy squares up to it,
    // it does not stand in it.
    const gap = 16 * scale + width * (role === 'enemy' ? 0.9 : 0.6);
    const home = heroX + side * (gap + col * spacing + row * spacing * 0.5) + jitter;

    if (role === 'enemy') {
      // They charge in from past the edge and pull up in front of the hero,
      // the front row first; then they stand there and stare.
      // Most of the beat is the charge: at a third of the way through they are
      // still coming, which is when the narration is saying so.
      const arrive = Math.min(0.8, 0.55 + col * 0.06 + row * 0.05);
      const k = Math.min(1, progress / arrive);
      const eased = 1 - Math.pow(1 - k, 2);
      const from = home + side * W * 0.75;
      out.push({ x: from + (home - from) * eased, ground, scale: rowScale, right: side < 0, gait: k < 0.97 ? 'run' : 'stand' });
    } else if (role === 'fleeing') {
      // Already running at the first frame and gone by the last.
      const start = home - side * spacing * 0.6;
      // Across the frame over the whole beat, so they are seen going.
      out.push({ x: start + side * W * 0.95 * Math.min(1.2, progress + col * 0.04), ground, scale: rowScale, right: side > 0, gait: 'run' });
    } else {
      out.push({ x: home, ground, scale: rowScale, right: facingRight, gait: 'stand' });
    }
  }
  // The back row is drawn first so the front row stands in front of it.
  return out.map((c, i) => ({ c, row: back(i) ? 1 : 0 })).sort((a, b) => b.row - a.row).map(({ c }) => c);
}
