import { CAPTION_SCALE, LAYOUT, RENDER, styleTokens, type StyleTokens } from '../design.js';
import { beatRng, mulberry32, rangeFloat } from '../rng.js';
import { FONT_FAMILY } from './font.js';

/**
 * The face the fitter measures against.
 *
 * Module state rather than a parameter threaded through six signatures,
 * because every path into this file goes through layoutBeat and it sets this
 * first. It has to be set at all: the fitter chooses line breaks and font sizes
 * from measured glyph advances, so measuring Devanagari against Inter's metrics
 * would break every line in the wrong place and then draw it in a font that
 * disagreed -- the words would not merely look wrong, they would not fit.
 */
let measureFamily: string = FONT_FAMILY;
import type { Beat, Line, StyleName, TemplateName } from '../schema.js';

export type Sized = {
  line: Line;
  /** The line as it will be drawn, after the style's casing. */
  text: string;
  fontSize: number;
  weight: number;
  /** Correction applied above this line so its glyphs clear the one before. */
  marginTop: number;
};

export type BlockLayout = {
  style: StyleTokens;
  lines: Sized[];
  blockHeight: number;
  fillFraction: number;
  align: 'flex-start' | 'center' | 'flex-end';
  textAlign: 'left' | 'center' | 'right';
  rotation: number;
  offsetX: number;
};

const SAFE_HEIGHT = RENDER.height * (1 - RENDER.safeTopFraction - RENDER.safeBottomFraction);
const FIT_PASSES = 4;

/** Applied before measuring as well as before drawing — uppercase is wider. */
export function cased(text: string, style: StyleTokens): string {
  if (style.casing === 'upper') return text.toLocaleUpperCase();
  if (style.casing === 'lower') return text.toLocaleLowerCase();
  return text;
}

let measuring: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (measuring === undefined) {
    measuring = typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d');
  }
  return measuring;
}

/** Fallback only: used when there is no canvas to measure with. */
function estimateWidth(text: string, fontSize: number): number {
  const tracking = RENDER.trackingEm * fontSize;
  return text.length * (fontSize * LAYOUT.averageGlyphWidthEm + tracking);
}

/**
 * Real glyph advances, not an average. An 800-weight word is far wider than a
 * 500-weight one of the same length, which is exactly the case the estimate
 * used to get wrong — and the emphasis word is always the one that overflowed.
 */
function measureText(text: string, fontSize: number, weight: number, trackingEm: number): number {
  const ctx = context();
  if (ctx === null) return estimateWidth(text, fontSize);

  const tracking = trackingEm * fontSize;
  ctx.font = `${weight} ${fontSize}px ${measureFamily}`;

  const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if (spaced.letterSpacing !== undefined) {
    spaced.letterSpacing = `${tracking}px`;
    return ctx.measureText(text).width;
  }
  return ctx.measureText(text).width + tracking * Math.max(0, text.length - 1);
}

function measureLine(
  text: string,
  line: Line,
  fontSize: number,
  emphasisWord: string | null,
  style: StyleTokens,
): number {
  const weight = line.emphasis ? style.emphasisWeight : style.bodyWeight;
  const parts = line.emphasis ? [text] : splitEmphasis(text, emphasisWord);

  return parts.reduce((sum, part) => {
    if (part === '') return sum;
    const bold = emphasisWord !== null && part.toLowerCase() === emphasisWord.toLowerCase();
    // The highlight block and the outline stroke both take room the glyphs
    // themselves do not, so the fitter has to pay for them.
    const pad = bold ? style.emphasisPadEm * 2 * fontSize : 0;
    return (
      sum +
      measureText(part, fontSize, bold ? style.emphasisWeight : weight, style.trackingEm) +
      pad
    );
  }, 0);
}

type Ink = { top: number; bottom: number };

/** Kept here so the fitter and the renderer cannot disagree about the stroke. */
export function strokeWidth(fontSize: number): number {
  return Math.max(2, fontSize * 0.022);
}

/**
 * Where this line's ink actually sits inside its box, measured rather than
 * assumed. A line box is fontSize * lineHeightFactor tall, but a 2.2x emphasis
 * word's descender reaches well past that, which is what used to leave the "g"
 * of one line cutting through the line under it.
 */
function inkBox(
  text: string,
  fontSize: number,
  weight: number,
  painted: boolean,
  outset: number,
): Ink {
  const boxHeight = fontSize * LAYOUT.lineHeightFactor;
  const ctx = context();
  if (ctx === null) return { top: 0, bottom: boxHeight };

  ctx.font = `${weight} ${fontSize}px ${measureFamily}`;
  const metrics = ctx.measureText(text === '' ? 'x' : text);

  const fontAscent = metrics.fontBoundingBoxAscent ?? fontSize * 0.9;
  const fontDescent = metrics.fontBoundingBoxDescent ?? fontSize * 0.25;
  const inkAscent = metrics.actualBoundingBoxAscent ?? fontAscent;
  const inkDescent = metrics.actualBoundingBoxDescent ?? fontDescent;

  // CSS centres the font's box inside the line box; half-leading goes negative
  // once lineHeightFactor drops below the font's own ascent + descent.
  const baseline = (boxHeight - (fontAscent + fontDescent)) / 2 + fontAscent;

  // A highlighted word is a filled block, and an inline background covers the
  // font's whole box rather than just the glyphs. Spacing it by the glyphs let
  // the block ride up over the line above and hide it, so a painted line
  // claims its full box.
  if (painted) return { top: baseline - fontAscent, bottom: baseline + fontDescent };

  // An outline stroke straddles the glyph edge, so half of it reaches past the
  // measured ink on every side.
  return { top: baseline - inkAscent - outset, bottom: baseline + inkDescent + outset };
}

/** Horizontal room each template takes for its own furniture before any type. */
function templateChrome(template: TemplateName, lineCount: number): number {
  if (template === 'line-stack') return Math.max(0, lineCount - 1) * LAYOUT.lineStackIndent;
  if (template === 'quote-block') return LAYOUT.quoteBarWidth + LAYOUT.quoteBarGap;
  return 0;
}

export { beatRng };

export function layoutBeat(
  beat: Beat,
  seed: number,
  emphasisWord: string | null = null,
  styleName: StyleName | string = 'editorial',
  captionScale: number = CAPTION_SCALE.default,
  /** The face this video is drawn in; the fitter must measure the same one. */
  fontFamily: string = FONT_FAMILY,
): BlockLayout {
  measureFamily = fontFamily;
  const style = styleTokens(styleName);
  const rng = beatRng(seed, beat.id);

  // Drawn in the original order so a given seed still picks the same
  // composition; they are read up front because the width budget depends on
  // how far the block is pushed and turned.
  const roll = rng();
  const textAlign = roll < 0.45 ? 'left' : roll < 0.72 ? 'right' : 'center';
  const rotation = rangeFloat(rng, -RENDER.beatRotationDegrees, RENDER.beatRotationDegrees);
  const offsetX = rangeFloat(rng, -0.02, 0.02) * RENDER.width;

  const texts = beat.lines.map((line) => cased(line.text, style));
  const emphasis = emphasisWord === null ? null : cased(emphasisWord, style);
  const weights = beat.lines.map((line) => line.scale);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

  const chrome = templateChrome(beat.template, beat.lines.length);
  const radians = (Math.abs(rotation) * Math.PI) / 180;
  const frameRoom =
    RENDER.width * LAYOUT.maxBleedFraction - LAYOUT.sidePaddingPx * 2 - chrome - Math.abs(offsetX);

  const heightOf = (unit: number): number =>
    beat.lines.reduce(
      (sum, _line, index) => sum + unit * (weights[index] ?? 1) * LAYOUT.lineHeightFactor,
      0,
    );

  /**
   * Shrinks a starting size until every line clears the frame. Rotating the
   * block widens its bounding box by height * sin(angle), and that height
   * depends on the size being solved for, so it converges rather than solving
   * outright. It only ever shrinks.
   */
  const fit = (start: number): number => {
    let size = start;
    for (let pass = 0; pass < FIT_PASSES; pass++) {
      const budget = Math.max(120, frameRoom - heightOf(size) * Math.sin(radians));

      let worst = 1;
      for (const [index, line] of beat.lines.entries()) {
        const lineSize = size * (weights[index] ?? 1);
        const width = measureLine(texts[index] ?? line.text, line, lineSize, emphasis, style);
        if (width > budget) worst = Math.min(worst, budget / width);
      }

      if (worst > 0.999) break;
      size *= worst;
    }
    return size;
  };

  const neutral = fit(
    (SAFE_HEIGHT * LAYOUT.heightBudgetFraction) / (weightSum * LAYOUT.lineHeightFactor),
  );

  /**
   * Scaling the *target* did nothing, because the fitter only shrinks: on any
   * line long enough for width to be the binding constraint — which is most of
   * them — every starting size collapsed to the same width-limited answer, and
   * 0.7 and 1.3 rendered identically.
   *
   * So the scale applies to the fitted result. Below 1 that is exact, since a
   * block that already fits still fits when smaller. Above 1 it is a request:
   * refitting pulls back anything that would then clip, so asking for more than
   * the frame has gets you the frame.
   */
  const unit = captionScale <= 1 ? neutral * captionScale : fit(neutral * captionScale);

  const sizes = beat.lines.map((line, index) => ({
    line,
    text: texts[index] ?? line.text,
    fontSize: Math.round(unit * (weights[index] ?? 1)),
    weight: line.emphasis ? style.emphasisWeight : style.bodyWeight,
  }));
  const paints = style.emphasis === 'highlight';
  const strokes = style.emphasis === 'outline';
  const inks = sizes.map((sized) => {
    const marked = sized.line.emphasis || containsEmphasis(sized.text, emphasis);
    return inkBox(
      sized.text,
      sized.fontSize,
      sized.weight,
      paints && marked,
      strokes && marked ? strokeWidth(sized.fontSize) / 2 : 0,
    );
  });

  // Space each line off the ink of the one above it, not off its box, so the
  // stack stays tight without any pair of glyphs ever touching.
  const lines: Sized[] = sizes.map((sized, index) => {
    const previous = sizes[index - 1];
    const above = inks[index - 1];
    const here = inks[index];
    if (previous === undefined || above === undefined || here === undefined) {
      return { ...sized, marginTop: 0 };
    }
    const boxHeight = previous.fontSize * LAYOUT.lineHeightFactor;
    const gap =
      LAYOUT.lineGapEm * style.lineGapScale * Math.min(previous.fontSize, sized.fontSize);
    return { ...sized, marginTop: gap - (boxHeight - above.bottom) - here.top };
  });

  const blockHeight = lines.reduce(
    (sum, sized) => sum + sized.fontSize * LAYOUT.lineHeightFactor + sized.marginTop,
    0,
  );

  return {
    style,
    lines,
    blockHeight,
    fillFraction: blockHeight / RENDER.height,
    align: textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center',
    textAlign,
    rotation,
    offsetX,
  };
}

function containsEmphasis(text: string, emphasisWord: string | null): boolean {
  if (emphasisWord === null) return false;
  return splitEmphasis(text, emphasisWord).some(
    (part) => part.toLowerCase() === emphasisWord.toLowerCase(),
  );
}

export function splitEmphasis(text: string, emphasisWord: string | null): string[] {
  if (emphasisWord === null) return [text];
  return text.split(new RegExp(`(\\b${escapeRegExp(emphasisWord)}\\b)`, 'i'));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
