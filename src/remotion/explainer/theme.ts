import { Easing, interpolate, spring } from 'remotion';
import { RENDER } from '../../design.js';
import { MONO_FONT_FAMILY } from '../font.js';

/**
 * The explainer's look, in one place.
 *
 * One accent and one second colour, and nothing else that competes with the
 * picture. Yellow because it reads over every photograph a stock search can
 * return -- sky, skin, snow, night -- at a size a phone can see, and because
 * it is what an edited explainer looks like to the people who watch them.
 */
export const EX = {
  width: RENDER.width,
  height: RENDER.height,
  fps: RENDER.fps,
  ink: '#ffffff',
  dim: 'rgba(255,255,255,0.72)',
  accent: '#ffd23f',
  accentInk: '#14110a',
  second: '#4cc9f0',
  card: 'rgba(12,14,20,0.78)',
  cardEdge: 'rgba(255,255,255,0.10)',
  ground: '#07090e',
  mono: MONO_FONT_FAMILY,
  /**
   * Where things go on a 1080x1920 frame, clear of the platform's own chrome:
   * the search bar over the top, the title and channel over the bottom fifth,
   * the like and share column down the right.
   */
  safeTop: 250,
  safeBottom: 1520,
  sideLeft: 64,
  sideRight: 150,
  /** The graphic's band, between the top chrome and the captions. */
  bandTop: 330,
  bandBottom: 1180,
  /** The captions' line. */
  captionY: 1300,
} as const;

export const msToFrame = (ms: number): number => (ms / 1000) * EX.fps;

/** Quick in, soft landing: the motion of almost everything here. */
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** 0 to 1 between two frames, eased, clamped. */
export function ramp(frame: number, from: number, length: number, easing = easeOut): number {
  return interpolate(frame, [from, from + Math.max(1, length)], [0, 1], {
    easing,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

/** A spring that starts at a given frame. */
export function pop(frame: number, from: number, config: { damping?: number; stiffness?: number; mass?: number } = {}): number {
  return spring({
    frame: frame - from,
    fps: EX.fps,
    config: { damping: config.damping ?? 13, stiffness: config.stiffness ?? 190, mass: config.mass ?? 0.6 },
  });
}

/** Card chrome shared by every panel graphic. */
export const CARD: React.CSSProperties = {
  background: EX.card,
  border: `2px solid ${EX.cardEdge}`,
  borderRadius: 34,
  boxShadow: '0 30px 80px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)',
};

/** The small uppercase label above a graphic. */
export const KICKER: React.CSSProperties = {
  fontFamily: EX.mono,
  fontWeight: 500,
  fontSize: 34,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: EX.accent,
};

/** Legible over anything: a soft dark halo rather than an outline. */
export const TEXT_SHADOW = '0 4px 18px rgba(0,0,0,0.55), 0 2px 4px rgba(0,0,0,0.5)';
