import { rolls } from './cinemaCuts.js';

/**
 * When each character of the cinematic title is struck.
 *
 * Two places need the answer and they must agree to the millisecond: the
 * renderer, which puts a letter on screen, and the sound mix, which puts a key
 * strike under it. A click that lands a frame off a letter reads as a dubbing
 * error, so the timing lives here, pure and DOM-free, and both import it --
 * the same arrangement as the cinematic cuts.
 *
 * Human, not metronomic: each interval wanders a little, and a space or a
 * punctuation mark holds a beat longer, the way a typist's hands do. The
 * wander is derived from the title, so a re-render types it identically.
 */

/** The first key lands after the bars have begun to arrive. */
export const TYPE_START_MS = 450;
/** Every key is struck by here, so the finished title holds before it goes. */
export const TYPE_END_MS = 2_500;
/** A comfortable pace for a short title; long ones go faster to fit. */
const BASE_INTERVAL_MS = 78;

export type Keystroke = {
  /** When this character appears, from the start of the video. */
  atMs: number;
  /** A space: struck with the thumb, heavier and duller. */
  space: boolean;
};

export function titleKeystrokes(title: string): Keystroke[] {
  const chars = [...title];
  if (chars.length === 0) return [];
  const roll = rolls(`title-${title}`);

  // Relative gaps first, then scaled into the window if they overrun it.
  const gaps = chars.map((char, i) => {
    if (i === 0) return 0;
    const previous = chars[i - 1] ?? '';
    const pause = previous === ' ' ? 1.35 : /[,.:;!?—-]/.test(previous) ? 1.8 : 1;
    return pause * (0.72 + roll() * 0.56);
  });
  const total = gaps.reduce((sum, gap) => sum + gap, 0);
  const interval = Math.min(BASE_INTERVAL_MS, (TYPE_END_MS - TYPE_START_MS) / Math.max(1, total));

  let at = TYPE_START_MS;
  return chars.map((char, i) => {
    at += (gaps[i] ?? 0) * interval;
    return { atMs: Math.round(at), space: char === ' ' };
  });
}
