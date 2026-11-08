import { interpolate } from 'remotion';
import { beatRng } from '../../rng.js';
import { easeInOut, easeOut } from './theme.js';

/**
 * The cut, as an edit rather than a splice.
 *
 * Every transition is two halves on either side of the cut: the outgoing shot
 * leaves in its last few frames and the incoming one arrives in its first
 * few, and the pair are the same move -- a zoom out of one shot is a zoom into
 * the next. Done inside each beat rather than by overlapping them, so the beat
 * sheet's timings stay exactly what they are and a transition can never
 * delay a word.
 *
 *   zoom    a punch through the cut: the old shot rushes in, the new one lands
 *   whip    a fast horizontal pan, smeared, the classic editor's whip
 *   spin    a zoom with a twist, for the lines that turn something over
 *   slide   a vertical push, the feed's own direction
 *   flash   a white frame, for a reveal or a number
 */
export type TransitionKind = 'zoom' | 'whip' | 'spin' | 'slide' | 'flash';

const KINDS: readonly TransitionKind[] = ['zoom', 'whip', 'zoom', 'spin', 'slide', 'flash', 'whip'];

export const ENTER_FRAMES = 8;
export const EXIT_FRAMES = 5;

/**
 * The transition into each beat, by index. Seeded so a re-render cuts the
 * same way, and never the same move twice running, because a repeated
 * transition is the first thing that makes an edit look automatic.
 */
export function transitionsFor(seed: number, ids: readonly string[]): TransitionKind[] {
  const out: TransitionKind[] = [];
  for (const id of ids) {
    const rng = beatRng(seed, `${id}:transition`);
    let kind = KINDS[Math.floor(rng() * KINDS.length)] ?? 'zoom';
    if (kind === out[out.length - 1]) kind = KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length] ?? 'zoom';
    out.push(kind);
  }
  return out;
}

export type Move = {
  scale: number;
  x: number;
  y: number;
  rotate: number;
  blur: number;
  brightness: number;
  /** A white frame over everything, 0 to 1. */
  flash: number;
};

const STILL: Move = { scale: 1, x: 0, y: 0, rotate: 0, blur: 0, brightness: 1, flash: 0 };

/**
 * Where the picture is in its transition at this frame of the beat.
 *
 * `into` is how this beat arrives; `outOf` is how the next one does, which is
 * how this one has to leave. `direction` alternates the whip and the spin so
 * consecutive ones do not all go the same way. A whip arrives from the side
 * opposite its direction, so the shot before it leaves toward that side and
 * the two halves read as one pan.
 */
export function moveAt(
  frame: number,
  durationInFrames: number,
  /** 'open' is the video's first frame; 'held' arrives without a move. */
  into: TransitionKind | 'open' | 'held',
  outOf: TransitionKind | null,
  direction: 1 | -1,
  /** The next beat's direction, which is the one this beat leaves in. */
  outDirection: 1 | -1 = direction,
): Move {
  const move = { ...STILL };

  const enter = interpolate(frame, [0, ENTER_FRAMES], [1, 0], { easing: easeOut, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (enter > 0) {
    switch (into) {
      case 'open':
        // The first frame is already the picture: a short punch-in from a
        // lifted exposure, never a fade up from black.
        move.scale *= 1 + 0.12 * enter;
        move.brightness *= 1 + 0.22 * enter;
        move.blur += 2 * enter;
        break;
      case 'zoom':
        move.scale *= 1 + 0.32 * enter;
        move.blur += 16 * enter;
        move.brightness *= 1 + 0.25 * enter;
        break;
      case 'whip':
        move.x += -direction * 62 * enter;
        move.blur += 22 * enter;
        move.scale *= 1 + 0.06 * enter;
        break;
      case 'spin':
        move.rotate += direction * 9 * enter;
        move.scale *= 1 + 0.4 * enter;
        move.blur += 12 * enter;
        break;
      case 'slide':
        move.y += 100 * enter;
        move.blur += 8 * enter;
        break;
      case 'flash':
        move.flash = Math.max(move.flash, 0.85 * enter);
        move.scale *= 1 + 0.08 * enter;
        break;
    }
  }

  if (outOf !== null) {
    const exit = interpolate(frame, [durationInFrames - EXIT_FRAMES, durationInFrames], [0, 1], {
      easing: easeInOut,
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    if (exit > 0) {
      switch (outOf) {
        case 'zoom':
          move.scale *= 1 + 0.45 * exit;
          move.blur += 14 * exit;
          break;
        case 'whip':
          // Leaves the way the next shot's pan carries it.
          move.x += outDirection * 62 * exit;
          move.blur += 22 * exit;
          break;
        case 'spin':
          move.rotate += -outDirection * 9 * exit;
          move.scale *= 1 + 0.35 * exit;
          move.blur += 10 * exit;
          break;
        case 'slide':
          move.y += -100 * exit;
          move.blur += 8 * exit;
          break;
        case 'flash':
          move.brightness *= 1 + 1.4 * exit;
          move.flash = Math.max(move.flash, 0.6 * exit);
          break;
      }
    }
  }
  return move;
}

/** The move as a CSS transform and filter, with x and y in percent of the frame. */
export function moveStyle(move: Move, blurScale = 1): React.CSSProperties {
  // `blurScale` takes the CSS blur down where the layer draws its own -- the
  // picture's zoom blur and channel split are the motion, and a blur on top
  // of them only turns the motion into fog.
  const blur = move.blur * blurScale;
  return {
    transform: `translate(${move.x}%, ${move.y}%) scale(${move.scale}) rotate(${move.rotate}deg)`,
    filter:
      (blur > 0.2 ? `blur(${blur.toFixed(1)}px) ` : '') +
      (move.brightness !== 1 ? `brightness(${move.brightness.toFixed(3)})` : ''),
  };
}
