import { z } from 'zod';

/**
 * The painted mode's vocabulary, shared by the director (stages/paintdirect),
 * the beat sheet, and the painter (remotion/painted/engine). Kept apart from
 * the painter because that imports a browser-only WebGL library, and the
 * sheet is parsed in Node.
 *
 * A painted beat is a scene, not a picture: a sky, a ground, the weather, and
 * one or two subjects -- silhouettes from game-icons.net -- placed and coloured
 * by the director and painted live by p5.brush, a wash at a time.
 */

export const SKIES = ['dawn', 'day', 'dusk', 'night', 'storm', 'interior'] as const;
export const GROUNDS = ['hills', 'sea', 'desert', 'city', 'field', 'snow', 'room', 'none'] as const;
export const ATMOSPHERES = ['wind', 'rain', 'snow', 'waves', 'stars', 'none'] as const;

export type Sky = (typeof SKIES)[number];
export type Ground = (typeof GROUNDS)[number];
export type Atmosphere = (typeof ATMOSPHERES)[number];

/** Where each kind of ground meets what stands on it, 0..1 of the height. */
export const GROUND_LINE: Record<Ground, number> = {
  hills: 0.72, sea: 0.68, desert: 0.7, city: 0.7, field: 0.72, snow: 0.72, room: 0.72, none: 0.7,
};

export const paintSubjectSchema = z.object({
  /** The icon's name in the game-icons set, kept for the credits. */
  icon: z.string().max(80),
  author: z.string().max(80).default(''),
  /** Silhouette path data in a 512-unit box. */
  paths: z.array(z.string().max(40_000)).max(12),
  /** Centre across, 0..1 of the frame. */
  x: z.number().min(0).max(1),
  /** "ground" stands it on the ground line; "sky" centres it at `y`. */
  place: z.enum(['ground', 'sky']),
  y: z.number().min(0).max(1),
  /** Width, 0..1 of the frame width. */
  size: z.number().min(0.05).max(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  flip: z.boolean().default(false),
});

export const paintSceneSchema = z.object({
  sky: z.enum(SKIES),
  ground: z.enum(GROUNDS),
  atmosphere: z.enum(ATMOSPHERES),
  light: z.enum(['left', 'right']),
  subjects: z.array(paintSubjectSchema).max(3),
  /** The beat before is the same place: its sky and ground are already dry. */
  settled: z.boolean().default(false),
});

export type PaintSubject = z.infer<typeof paintSubjectSchema>;
export type PaintScene = z.infer<typeof paintSceneSchema>;

/** How long a beat's painting takes, so it finishes while the beat is still on. */
export function paintSeconds(beatSeconds: number): number {
  return Math.max(1.6, Math.min(4.2, beatSeconds * 0.72));
}
