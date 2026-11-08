export const COMPOSITION_ID = 'breezematic';

/**
 * Caption size, as a multiplier on the size the fitter arrives at.
 *
 * It stops at 1 because 1 is already the ceiling: the fitter grows the type
 * until a line reaches the frame, so every beat comes out width-limited. Asking
 * for more was measured across all six templates and moved them 0-4% — there is
 * nothing above 1 to give without letting the type run off the frame, which is
 * the one thing this layout will not do. So 100% means "as large as it fits",
 * and the control takes it down from there.
 */
export const CAPTION_SCALE = { min: 0.6, max: 1, default: 1 } as const;

export const RENDER = {
  width: 1080,
  height: 1920,
  fps: 30,
  frameTimeoutMs: 120_000,
  maxConcurrency: 8,
  safeTopFraction: 0.12,
  safeBottomFraction: 0.18,
  typeHeightFractionMin: 0.6,
  typeHeightFractionMax: 0.8,
  emphasisScaleMin: 2,
  emphasisScaleMax: 3,
  beatRotationDegrees: 3,
  trackingEm: -0.03,
} as const;

export const TREATMENT = {
  blurPxMin: 28,
  blurPxMax: 40,
  scrimOpacityMin: 0.55,
  scrimOpacityMax: 0.7,
  // The fields are ours, not stock footage, so the palette is worth keeping.
  saturation: 0.62,
  driftScale: 1.08,
  // A blur tuned for a procedural gradient turns a photograph into a smear.
  // The scrim is untouched: it is what keeps the type legible over a picture.
  // "photo" is a stamp now, so nothing behind it is a photograph: the field
  // blurs the way it does with imagery off, because that is what it is.
  imageBlurScale: { off: 1, blend: 0.42, photo: 1 } as Record<string, number>,
  // A dead channel has to stay crisp — blurred static is just grey.
  effectBlurScale: { static: 0.045 } as Record<string, number>,
  /**
   * Footage is treated more gently than a still, because the reason to reach
   * for it is the movement, and movement is the first thing a heavy blur takes
   * away. Blurred to a smear it is indistinguishable from a photograph that
   * happens to cost more to fetch.
   *
   * The scrim comes down with it, but only a little: it is what holds the type
   * legible over a picture, and a moving picture needs that more than a still
   * does, not less.
   */
  footageBlurScale: 0.45,
  footageScrimScale: 0.88,
} as const;

/**
 * "photo" used to mean the same full-bleed picture as "blend", only louder,
 * which put it behind the scrim and under the type where a photograph reads as
 * texture no matter how far up its opacity goes. It is a stamp instead: a print
 * laid on the frame, sitting above the scrim so it keeps its own light, held in
 * the upper band because the type is centred and the two must not overlap.
 */
/**
 * The whiteboard mode. Paper rather than a field, ink rather than white type,
 * and a drawing that goes down before the writing beside it.
 */
export const WHITEBOARD = {
  paper: '#f7f5ef',
  ink: '#1b1a17',
  /** The same board at night: a slate rather than a sheet, written in chalk. */
  paperDark: '#15161a',
  inkDark: '#eceae2',
  /** The pen barrel reads on paper; on slate it needs to be its own light. */
  penDark: '#7fb0ff',
  cuffDark: '#f0d7bb',
  pen: '#2f6fd0',
  cuff: '#e8c9a8',
  sidePaddingPx: 96,
  /** Of the beat, spent putting the drawing down before writing runs on. */
  drawShare: 0.42,
  drawSizePx: 300,
  drawGapPx: 54,
  drawStrokeWidth: 1.5,
  /** An illustration earns more room than a pictogram does. */
  sketchSizePx: 620,
  /** Rows the drawing is uncovered in. Too few reads as a wipe, too many as a fade. */
  sketchBands: 9,
  /** Trimmed from each edge, where signatures and captions land. */
  sketchCropFraction: 0.11,
  /** How much paper is over the field. High: this is texture, not a background. */
  veilOpacity: 0.9,
  /** Half what it was. Big enough to read as a pen, small enough to stay off the word. */
  penSizePx: 62,
  lineHeight: 1.16,
  /** Space between words, in ems. The fitter and the layout share it. */
  wordGapEm: 0.26,
  /** Caveat gets loose above this; the fit is capped rather than let run. */
  maxSizePx: 168,
} as const;

export const STAMP = {
  /**
   * The type is centred and its block reaches up to roughly 0.35 of the frame,
   * so the stamp has to finish above that or the two print over each other.
   * Landscape and modest gets it into that band; a portrait crop at any useful
   * width runs straight into the first line.
   */
  widthFraction: 0.42,
  /** Width over height. */
  aspect: 5 / 4,
  /**
   * The type is centred and its block runs to roughly y 650-1150, which leaves
   * a band above it and a band of about the same height below. The picture
   * takes one or the other, and shifts across the frame within it, so twenty
   * beats do not stack the same rectangle in the same place twenty times.
   */
  bandTopFraction: 0.225,
  bandBottomFraction: 0.715,
  /** How far it slides either side of centre, as a fraction of frame width. */
  driftXFraction: 0.17,
  /** A print is not laid down square. Deterministic per beat, not per frame. */
  tiltDegrees: 3.4,
  /** How far it drifts over a beat, in px, so it is not pinned to the frame. */
  driftPx: 22,
  scaleFrom: 1,
  scaleTo: 1.035,
} as const;

export const LAYOUT = {
  minWordMs: 90,
  linesPerTemplate: {
    'word-punch': 2,
    'line-stack': 3,
    'stat-slam': 3,
    'quote-block': 3,
    countdown: 2,
    'reveal-mask': 2,
  } as Record<string, number>,
  isolateEmphasisFor: ['word-punch', 'stat-slam', 'reveal-mask'] as readonly string[],
  emphasisScaleIsolated: 2.2,
  emphasisScaleInline: 1.25,
  maxLines: 4,
  maxCharsPerLine: 11,
  maxBleedFraction: 1,
  // Only a fallback for when there is no canvas to measure glyphs with.
  averageGlyphWidthEm: 0.56,
  heightBudgetFraction: 0.8,
  lineHeightFactor: 0.92,
  /** Clear space between the ink of one line and the next, in ems of the smaller. */
  lineGapEm: 0.07,
  entryDurationMs: 150,
  lineStaggerMs: 120,
  // Shared by the templates and by the fitter, so the room a template takes
  // for its furniture can never drift from the room the type is given.
  sidePaddingPx: 54,
  lineStackIndent: 46,
  quoteBarWidth: 10,
  quoteBarGap: 34,
} as const;

export const PALETTES: Record<string, { base: string; blobs: string[] }> = {
  'gradient-dark': { base: '#16264d', blobs: ['#7aa3ff', '#3f63c4', '#a8c4ff'] },
  'gradient-tense': { base: '#3a0d14', blobs: ['#ff5f78', '#c02a45', '#ff97a6'] },
  'gradient-clean': { base: '#243343', blobs: ['#a9c6dc', '#6b8ba6', '#d6e6f2'] },
  'gradient-warm': { base: '#3a2108', blobs: ['#ffab4d', '#c2761c', '#ffd199'] },
};

export const INK = '#f6f5f2';
export const ACCENT = '#ffffff';

/**
 * Type styles. Only Inter is bundled, so the difference between these comes
 * from weight, casing, tracking, spacing and how the emphasis word is marked —
 * not from swapping families. Every value here is read by the fitter as well
 * as the renderer: casing and tracking change how wide a line measures, and
 * measuring against the wrong ones is what puts glyphs through the frame edge.
 */
export type EmphasisTreatment = 'weight' | 'colour' | 'highlight' | 'outline';

export type StyleTokens = {
  label: string;
  bodyWeight: number;
  emphasisWeight: number;
  casing: 'none' | 'upper' | 'lower';
  trackingEm: number;
  emphasis: EmphasisTreatment;
  ink: string;
  accent: string;
  /** Ink drawn on top of the accent block, for the highlight treatment. */
  onAccent: string;
  /** Scales the clear space the fitter leaves between lines. */
  lineGapScale: number;
  /** Extra width the emphasis word takes for its own decoration, in ems. */
  emphasisPadEm: number;
  rules: boolean;
};

export const STYLES: Record<string, StyleTokens> = {
  editorial: {
    label: 'Editorial',
    bodyWeight: 500,
    emphasisWeight: 800,
    casing: 'none',
    trackingEm: -0.03,
    emphasis: 'weight',
    ink: INK,
    accent: INK,
    onAccent: '#101014',
    lineGapScale: 1,
    emphasisPadEm: 0,
    rules: true,
  },
  brutalist: {
    label: 'Brutalist',
    bodyWeight: 800,
    emphasisWeight: 900,
    casing: 'upper',
    trackingEm: -0.045,
    emphasis: 'weight',
    ink: '#ffffff',
    accent: '#ffffff',
    onAccent: '#000000',
    lineGapScale: 0.75,
    emphasisPadEm: 0,
    rules: false,
  },
  whisper: {
    label: 'Whisper',
    bodyWeight: 200,
    emphasisWeight: 500,
    casing: 'lower',
    trackingEm: 0.13,
    emphasis: 'colour',
    ink: '#efe9e2',
    accent: '#ffd08a',
    onAccent: '#101014',
    lineGapScale: 1.7,
    emphasisPadEm: 0,
    rules: false,
  },
  highlight: {
    label: 'Highlighter',
    bodyWeight: 600,
    emphasisWeight: 800,
    casing: 'none',
    trackingEm: -0.025,
    emphasis: 'highlight',
    ink: INK,
    accent: '#ffe14d',
    onAccent: '#14140c',
    lineGapScale: 1.35,
    emphasisPadEm: 0.14,
    rules: false,
  },
  outline: {
    label: 'Outline',
    bodyWeight: 700,
    emphasisWeight: 900,
    casing: 'upper',
    trackingEm: -0.02,
    emphasis: 'outline',
    ink: INK,
    accent: INK,
    onAccent: '#101014',
    lineGapScale: 0.95,
    emphasisPadEm: 0.05,
    rules: false,
  },
};

export function styleTokens(name: string): StyleTokens {
  return STYLES[name] ?? STYLES['editorial']!;
}
