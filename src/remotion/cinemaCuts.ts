/**
 * What happens on each cinematic cut, decided once.
 *
 * Two places need the answer and they must agree: the renderer, which draws
 * the flash and the light leak, and the sound mix, which puts a whoosh under
 * them. A whoosh on a cut with no flash, or a flash with no sound, reads as a
 * mistake -- so the decision lives here, pure and DOM-free, and both import
 * it. (The renderer's own module cannot be imported by the pipeline: loading
 * the fonts touches `document`.)
 *
 * Every answer is derived from the picture's file name, so the same picture
 * always cuts the same way and a re-render is identical.
 */

export type Move = 'push' | 'pull' | 'left' | 'right';
const MOVES: readonly Move[] = ['push', 'pull', 'left', 'right'];

/** Deterministic numbers from a name. */
export function rolls(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type CutAccents = {
  move: Move;
  /** A white flash on the cut. About one cut in four. */
  flashes: boolean;
  /** A warm light leak drifting across the cut. About one in five. */
  leaks: boolean;
  /** A jump tighter on the same picture partway through. Shots of 12s or more only. */
  recuts: boolean;
};

/** The order of the rolls is fixed: changing it would re-cut every video. */
export function cutAccents(file: string, heldMs: number): CutAccents {
  const roll = rolls(file);
  const move = MOVES[Math.floor(roll() * MOVES.length)] ?? 'push';
  const flashes = roll() < 0.25;
  const leaks = roll() < 0.22;
  // Only on a shot long enough to need breaking up. On the six-to-seven-second
  // holds an essay uses, a jump tighter halfway through reads as the same
  // picture popping back in where a new one was expected.
  const recuts = heldMs >= 12_000 && roll() < 0.4;
  return { move, flashes, leaks, recuts };
}
