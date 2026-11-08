import { interpolate } from 'remotion';
import { beatRng } from '../rng.js';
import type { Beat } from '../schema.js';

/**
 * The cinematic edit.
 *
 * What makes a trailer cut feel like one is almost never the footage — it is
 * the cutting. Four things do most of the work, and all four are missing from a
 * shot that simply plays for its beat and stops:
 *
 *   the snap    every cut lands slightly tight and settles, so the frame
 *               arrives with momentum instead of just appearing
 *   the recut   a long shot is cut into twice, jumping tighter on the same
 *               footage — the single most recognisable trailer move, and the
 *               reason a four-second shot does not feel like one
 *   the speed   shots do not all run at 1x; the line that matters slows down
 *   the grade   cool shadows, warm highlights, a vignette and lifted blacks
 *
 * Kept as maths in its own file rather than inline in the renderer because
 * every value here is deterministic per beat, and being able to print the
 * whole edit as numbers is what makes it reviewable without a render.
 */

export const CINEMA = {
  /** Each cut lands this tight and settles to 1. */
  punchFrom: 1.085,
  punchFrames: 10,
  /** Below this a shot is over before a second cut could register. */
  recutMinMs: 2_000,
  /**
   * And not every shot that could take one gets one. At length alone, 14 of 20
   * shots were cut into — often enough that it stops being a punctuation mark
   * and becomes a tic the viewer starts predicting. Roughly half of the
   * eligible ones keeps it an event.
   */
  recutChance: 0.5,
  /** How far through the shot the jump lands. */
  recutAt: 0.56,
  recutScale: 1.22,
  recutSettleFrames: 26,
  /** How often a cut is joined by a flash rather than landing dry. */
  flashChance: 0.3,
  flashFrames: 3,
  flashOpacity: 0.38,
  /** The emphasis beat slows; a few others run hot. */
  slowRate: 0.72,
  fastRate: 1.28,
  fastChance: 0.3,
} as const;

/**
 * How much of the ordinary treatment survives in cinema mode.
 *
 * The other modes treat a picture as texture behind type — blurred, scrimmed,
 * with the shader field over it. Cinema inverts that: the footage is the
 * subject, so the blur nearly goes, the scrim drops to what the type actually
 * needs to stay legible, and the field falls back to a tint. Scaling the sheet's
 * own values rather than replacing them keeps each beat's variation intact.
 */
export const CINEMA_TREATMENT = {
  blurScale: 0.22,
  scrimScale: 0.6,
  fieldScale: 0.45,
} as const;

export type CinemaShot = {
  /** Extra scale on the picture layer, over whatever motion the beat has. */
  scale: number;
  /** White flash over the frame, 0 to 1. */
  flash: number;
  /** Playback rate for a clip. Stills ignore it. */
  rate: number;
  /** Whether this shot is cut into a second time. */
  recut: boolean;
};

/**
 * One shot's state at one frame. Pure: same beat, seed and frame in, same
 * numbers out, which is what keeps a re-render byte-identical.
 */
export function cinemaShot(options: {
  beat: Beat;
  seed: number;
  frame: number;
  durationInFrames: number;
}): CinemaShot {
  const { beat, seed, frame, durationInFrames } = options;
  const rng = beatRng(seed, `${beat.id}-cinema`);

  const flashes = rng() < CINEMA.flashChance;
  const runsHot = rng() < CINEMA.fastChance;
  // The line the beat is built around is the one worth slowing down for.
  const rate =
    beat.emphasisWordIndex !== null ? CINEMA.slowRate : runsHot ? CINEMA.fastRate : 1;

  const durationMs = beat.endMs - beat.startMs;
  // Drawn unconditionally so the stream stays aligned whatever the length is.
  const recutRoll = rng() < CINEMA.recutChance;
  const recut = durationMs >= CINEMA.recutMinMs && recutRoll;
  const recutFrame = Math.round(durationInFrames * CINEMA.recutAt);
  const afterRecut = recut && frame >= recutFrame;

  // Two punches, never overlapping: the cut in, then the jump. The second
  // settles more slowly than the first, or the jump reads as a glitch rather
  // than as a decision.
  const scale = afterRecut
    ? interpolate(
        frame - recutFrame,
        [0, CINEMA.recutSettleFrames],
        [CINEMA.recutScale, CINEMA.recutScale * 0.955],
        { extrapolateRight: 'clamp' },
      )
    : interpolate(frame, [0, CINEMA.punchFrames], [CINEMA.punchFrom, 1], {
        extrapolateRight: 'clamp',
      });

  // A flash belongs on the join, so both the cut and the jump can carry one.
  const sinceJoin = afterRecut ? frame - recutFrame : frame;
  const flash =
    flashes && sinceJoin < CINEMA.flashFrames
      ? interpolate(sinceJoin, [0, CINEMA.flashFrames], [CINEMA.flashOpacity, 0], {
          extrapolateRight: 'clamp',
        })
      : 0;

  return { scale, flash, rate, recut };
}
