import { Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { PALETTES, RENDER, WHITEBOARD } from '../design.js';
import { ShaderField } from './effects/ShaderField.js';
import { HAND_FONT_FAMILY } from './font.js';
import { beatRng } from './layout.js';
import type { Beat, BoardContent, BoardImagery, BoardTheme, EffectName, Word } from '../schema.js';

/**
 * The whiteboard scene: writing and a line drawing appearing on paper at the
 * pace of the read.
 *
 * Two things make this look like writing rather than text turning up.
 *
 * The first is that it is paced by the narration. Every beat already knows
 * which words were spoken inside it and exactly when, because whisper aligned
 * them, so each word is revealed across its own spoken span. Nothing here
 * guesses at a writing speed — the hand keeps up with the voice because it is
 * driven by the voice.
 *
 * The second is that the reveal is a clip along the baseline rather than an
 * opacity fade. Ink does not fade up; it arrives from the left with an edge.
 * The hand sits at that edge, so what you see is the pen laying the word down.
 */

type Props = {
  beat: Beat;
  /** The aligned words spoken inside this beat, in order. */
  words: readonly Word[];
  durationInFrames: number;
  captionScale: number;
  effect: EffectName;
  seed: number;
  textured: boolean;
  theme: BoardTheme;
  content: BoardContent;
  imagery: BoardImagery;
};

/** Everything the surface decides, in one place, so nothing reads it twice. */
function surfaceOf(theme: BoardTheme) {
  const dark = theme === 'dark';
  return {
    dark,
    paper: dark ? WHITEBOARD.paperDark : WHITEBOARD.paper,
    ink: dark ? WHITEBOARD.inkDark : WHITEBOARD.ink,
    pen: dark ? WHITEBOARD.penDark : WHITEBOARD.pen,
    cuff: dark ? WHITEBOARD.cuffDark : WHITEBOARD.cuff,
    /**
     * Multiply darkens and screen lightens, so which one sinks content into
     * the surface depends on which way round the surface is. On paper, ink
     * multiplies into the grain; on slate, chalk screens onto it. Using the
     * wrong one erases the content entirely rather than blending it.
     */
    into: dark ? ('screen' as const) : ('multiply' as const),
    /** The nib's light. Cool on slate, and a quiet accent on paper. */
    glow: dark ? '#9fd8ff' : '#4a86e8',
  };
}

let scratch: CanvasRenderingContext2D | null | undefined;

function measure(text: string, fontSize: number, weight: number): number {
  if (scratch === undefined) scratch = document.createElement('canvas').getContext('2d');
  if (scratch === null) return text.length * fontSize * 0.42;
  scratch.font = `${weight} ${fontSize}px ${HAND_FONT_FAMILY}`;
  return scratch.measureText(text).width;
}

/**
 * Caveat is a different shape from Inter — narrower, and set on a different
 * body — so the size the kinetic fitter arrived at is the wrong size here. It
 * gets its own fit against its own padding, solved from one measurement rather
 * than iterated: width scales linearly with size, so the ratio that makes the
 * widest line fit is the answer, and the line count caps it from the other
 * side.
 */
function fitSize(beat: Beat, captionScale: number): number {
  const room = RENDER.width - WHITEBOARD.sidePaddingPx * 2;
  const probe = 100;

  // Measured the way it is laid out: one span per word with a gap between,
  // not the whole string. Measuring the string counts Caveat's own space, which
  // is narrower than the gap, so every line came out wider than it measured and
  // the last word wrapped -- taking the pen onto a second row with it.
  let widest = 1;
  for (const line of beat.lines) {
    const size = probe * line.scale;
    const parts = line.text.split(/\s+/).filter(Boolean);
    const words = parts.reduce((sum, word) => sum + measure(word, size, line.emphasis ? 700 : 400), 0);
    widest = Math.max(widest, words + Math.max(0, parts.length - 1) * size * WHITEBOARD.wordGapEm);
  }
  const byWidth = (room / widest) * probe;

  const stack = beat.lines.reduce((sum, line) => sum + line.scale, 0) * WHITEBOARD.lineHeight;
  const drawn =
    beat.illustration === null
      ? 0
      : (beat.illustration.file === null ? WHITEBOARD.drawSizePx : WHITEBOARD.sketchSizePx) +
        WHITEBOARD.drawGapPx;
  const vertical =
    RENDER.height * (1 - RENDER.safeTopFraction - RENDER.safeBottomFraction) - drawn;
  const byHeight = vertical / stack;

  return Math.round(Math.min(byWidth, byHeight, WHITEBOARD.maxSizePx) * captionScale);
}

/** How far past its own box a glyph may hang, as a percent of the word's width. */
const GLYPH_BLEED = 9;

/** Writing finishes here, leaving the rest of the beat to read what is on screen. */
const WRITE_BY = 0.9;

/** A word and the slice of the beat it is written across. */
type Timed = { text: string; from: number; to: number };

/**
 * Display words paired with spoken ones by position. They come from the same
 * segment so they line up, but a mismatch is possible — an emoji shows without
 * being said — and an even spread is a better answer than a crash.
 */
function schedule(beat: Beat, words: readonly Word[]): Timed[] {
  const display = beat.lines.flatMap((line) => line.text.split(/\s+/).filter(Boolean));
  const span = Math.max(1, beat.endMs - beat.startMs);

  const raw = display.map((text, index) => {
    const spoken = words[index];
    if (spoken === undefined || display.length !== words.length) {
      const each = 1 / display.length;
      return { text, from: index * each, to: (index + 1) * each };
    }
    return {
      text,
      from: (spoken.startMs - beat.startMs) / span,
      to: (spoken.endMs - beat.startMs) / span,
    };
  });

  /**
   * Cuts land on the music grid; the words do not. Measured across a real
   * sheet, the last word of five beats in six is still being spoken when its
   * beat ends — by up to 160ms — so its reveal ran past the last frame and the
   * final word sat permanently half-written.
   *
   * Rescaling rather than clamping: clamping would finish the last word in a
   * single frame while the rest kept their pacing, which reads as a snap. This
   * squeezes the whole beat evenly and leaves a hold at the end, so the line is
   * complete and readable before the cut — which is what the hold is for.
   */
  const last = raw.reduce((latest, word) => Math.max(latest, word.to), 0);
  if (last <= WRITE_BY) return raw;

  const squeeze = WRITE_BY / last;
  return raw.map((word) => ({
    text: word.text,
    from: word.from * squeeze,
    to: word.to * squeeze,
  }));
}

/**
 * What lays the ink down.
 *
 * This was a drawn pen — a barrel, a cuff, a nib — and a cartoon of a hand is
 * the most dated thing that can be put on a frame. It reads as clip art from a
 * decade ago no matter how well it is drawn, and it is large enough to cover
 * the very word it is supposed to be writing.
 *
 * So the tool is gone and only the point of contact is left: a hairline of
 * light at the leading edge, brightest at the middle and fading out at both
 * ends, with a soft bloom around it and a short wake trailing back over what
 * was just written. Nothing represents a hand. It reads as the ink arriving
 * rather than as an object depositing it, which is both more modern and — since
 * it is two pixels wide — never in the way.
 */
const Nib: React.FC<{
  x: string;
  y: string;
  height: string;
  tint: string;
  ink: string;
  barrel: string;
  cuff: string;
}> = ({ x, y, height, tint, ink, barrel, cuff }) => (
  <span style={{ position: 'absolute', left: x, top: y, pointerEvents: 'none' }}>
    {/* What has just been passed over, fading out behind the tip. */}
    <span
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        width: '0.7em',
        height,
        transform: 'translateY(-50%)',
        background: `linear-gradient(to left, ${tint}, transparent)`,
        opacity: 0.1,
        filter: 'blur(7px)',
      }}
    />
    {/*
      The pen, at about half the size it started.
      
      A quill was tried in its place and read as a decoration sitting on the
      frame rather than a tool touching it — too much silhouette for something
      that has to stay out of the way of the word it is writing. The pen is
      legible at a glance at any size, which is the whole reason to draw one.
      Small enough not to cover the writing, with the nib on the point of
      contact so placing it is placing the tip.
    */}
    <svg
      width={WHITEBOARD.penSizePx}
      height={WHITEBOARD.penSizePx}
      viewBox="0 0 100 100"
      style={{
        position: 'absolute',
        transform: 'translate(-6%, -4%) rotate(8deg)',
        transformOrigin: '0% 0%',
      }}
    >
      <g fill="none" stroke={ink} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 4 L20 20" />
        <path d="M20 20 L34 12 L58 40 L34 52 Z" fill={barrel} />
        <path d="M58 40 L86 74 a10 10 0 0 1 -14 12 L44 54" fill={cuff} />
        <path d="M52 62 L40 74" />
      </g>
    </svg>
  </span>
);

/**
 * An illustration appearing as if it is being drawn.
 *
 * A picture is not stroke geometry, so there is nothing to dash-offset. It is
 * uncovered instead, in bands, each running left to right — which is the order
 * a hand fills a drawing in, and reads as sketching where a single wipe down
 * the frame reads as a curtain.
 *
 * The shape is one polygon: full-width down to the last finished band, then a
 * part-width strip across the band in progress. The pen goes at the corner
 * between them, so its position is the same number that cut the polygon and
 * cannot drift away from the edge it is supposed to be making.
 */
const Sketch: React.FC<{
  file: string;
  progress: number;
  size: number;
  skin: ReturnType<typeof surfaceOf>;
}> = ({ file, progress, size, skin }) => {
  const done = Math.min(1, Math.max(0, progress));
  const bands = WHITEBOARD.sketchBands;
  const row = Math.min(bands - 1, Math.floor(done * bands));
  const across = done * bands - row;
  const top = (row / bands) * 100;
  const bottom = ((row + 1) / bands) * 100;
  const edge = across * 100;

  // Signatures and captions land in the margin, because that is where they go
  // on the pictures the model learned from. The subject is asked to fill the
  // frame, so the outer band can be thrown away without losing it -- which
  // removes the ones that get through without another call to the model.
  const crop = 1 / (1 - WHITEBOARD.sketchCropFraction * 2);

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          // The blend belongs here, not on the image. Clipping and overflow
          // both open a stacking context, and a blend inside one composites
          // against that context rather than the page -- which turned the
          // drawing back into the opaque white card the grade had removed.
          mixBlendMode: skin.into,
          clipPath:
            `polygon(0% 0%, 100% 0%, 100% ${top}%, ${edge}% ${top}%, ` +
            `${edge}% ${bottom}%, 0% ${bottom}%)`,
        }}
      >
      <Img
        src={staticFile(`images/${file}`)}
        alt=""
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: 'block',
          transform: `scale(${crop})`,
          // The grade is what makes the multiply above enough: a generated
          // "white" that is really 246 still darkens the page under it, and
          // the edge of that shows as a faint rectangle. Crushing the
          // near-whites to white removes the card without touching the ink.
          // Inverted on slate: the drawing is black on white, and black ink
          // on a dark board is invisible whichever way it is blended.
          filter: skin.dark
            ? 'grayscale(1) invert(1) brightness(1.1) contrast(1.25)'
            : 'grayscale(1) brightness(1.12) contrast(1.28)',
        }}
      />
      </div>
      {done < 1 ? (
        <Nib
          x={`${edge}%`}
          y={`${bottom}%`}
          height={`${size / WHITEBOARD.sketchBands}px`}
          tint={skin.glow}
          ink={skin.ink}
          barrel={skin.pen}
          cuff={skin.cuff}
        />
      ) : null}
    </div>
  );
};

/**
 * One drawing, stroke by stroke. Every Lucide icon is `fill="none"` with
 * stroked geometry, so dash-offsetting a path draws the line itself. On a
 * filled shape the same trick traces the outline instead — a pen going around
 * the edge of a letter — which is what makes most attempts at this look wrong.
 */
const Drawing: React.FC<{
  paths: readonly string[];
  progress: number;
  size: number;
  ink: string;
}> = ({ paths, progress, size, ink }) => {
  // Each stroke gets an equal share of the drawing time, in file order.
  const share = 1 / paths.length;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block' }}>
      <g
        fill="none"
        stroke={ink}
        strokeWidth={WHITEBOARD.drawStrokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths.map((d, index) => {
          const local = Math.max(0, Math.min(1, (progress - index * share) / share));
          if (local <= 0) return null;
          return (
            <path
              key={index}
              d={d}
              // A dash the length of the path, offset by what is left to draw.
              // 100 is well past any 24-unit path, so the whole stroke hides.
              strokeDasharray={100}
              strokeDashoffset={100 * (1 - local)}
            />
          );
        })}
      </g>
    </svg>
  );
};

export const Whiteboard: React.FC<Props> = ({
  beat,
  words,
  durationInFrames,
  captionScale,
  effect,
  seed,
  textured,
  theme,
  content,
  imagery,
}) => {
  const frame = useCurrentFrame();
  const fontSize = fitSize(beat, captionScale);
  const skin = surfaceOf(theme);
  const palette = PALETTES[beat.background.clipId];
  const fieldSeed = Math.floor(beatRng(seed, `${beat.id}-board`)() * 1000);
  const progress = durationInFrames <= 1 ? 1 : frame / (durationInFrames - 1);

  const timed = schedule(beat, words);
  const drawing = beat.illustration;

  // The drawing goes down first and quickly, the way someone sketching would
  // put the picture in before writing beside it.
  const drawProgress = drawing === null ? 0 : Math.min(1, progress / WHITEBOARD.drawShare);
  /**
   * Dissolve asked for a picture file and got nothing on most beats. Only
   * about a quarter of them carry a generated illustration -- the rest match
   * an icon and carry stroke geometry instead -- so choosing "dissolved behind
   * the writing" left those beats with no image at all, silently. The icon
   * dissolves too; it is the same drawing, just vector.
   */
  const dissolving = imagery === 'dissolve' && drawing !== null;
  const dissolvedFile = dissolving ? drawing.file : null;
  const dissolvedPaths = dissolving && drawing.file === null ? drawing.paths : null;

  let cursor = 0;
  const lines = beat.lines.map((line) => {
    const count = line.text.split(/\s+/).filter(Boolean).length;
    const slice = timed.slice(cursor, cursor + count);
    cursor += count;
    return slice;
  });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        backgroundColor: skin.paper,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: `${RENDER.height * RENDER.safeTopFraction}px ${WHITEBOARD.sidePaddingPx}px ${
          RENDER.height * RENDER.safeBottomFraction
        }px`,
        fontFamily: HAND_FONT_FAMILY,
        color: skin.ink,
      }}
    >
      {/*
        The board is a sheet laid over the field rather than a flat colour.
        Ink is dark and the field is not, so the paper stays nearly opaque --
        enough that the writing reads exactly as it did, and only the texture
        comes through. Static is what this is for: at this veil it arrives as
        paper grain rather than as a broken signal.
      */}
      {textured ? (
        <>
          <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
            <ShaderField
              effect={effect}
              base={palette?.base ?? skin.paper}
              colours={palette?.blobs ?? []}
              seed={fieldSeed}
            />
          </div>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 0,
              backgroundColor: skin.paper,
              opacity: WHITEBOARD.veilOpacity,
            }}
          />
        </>
      ) : null}

      {/*
        Dissolved: the picture is the surface rather than something on it. It
        fills the frame, sinks into the board with the same blend the writing
        uses, and comes up slowly -- so the beat reads as writing over an image
        instead of writing beside a drawing.
      */}
      {dissolvedPaths !== null ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            mixBlendMode: skin.into,
            opacity: 0.34 * Math.min(1, progress / WHITEBOARD.drawShare),
          }}
        >
          {/* Larger than it would be drawn, and faint: it is the ground the
              writing sits on rather than a thing beside it. */}
          <Drawing
            paths={dissolvedPaths}
            progress={1}
            size={RENDER.width * 0.92}
            ink={skin.ink}
          />
        </div>
      ) : null}

      {dissolvedFile !== null ? (
        <Img
          src={staticFile(`images/${dissolvedFile}`)}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            mixBlendMode: skin.into,
            opacity: 0.5 * Math.min(1, progress / WHITEBOARD.drawShare),
            filter: skin.dark
              ? 'grayscale(1) invert(1) brightness(1.05) contrast(1.1)'
              : 'grayscale(1) brightness(1.06) contrast(1.08)',
          }}
        />
      ) : null}

      {drawing === null || dissolving ? null : (
        <div style={{ marginBottom: WHITEBOARD.drawGapPx, opacity: drawProgress > 0 ? 1 : 0 }}>
          {drawing.file === null ? (
            <Drawing
              paths={drawing.paths}
              progress={drawProgress}
              size={WHITEBOARD.drawSizePx}
              ink={skin.ink}
            />
          ) : (
            <Sketch
              file={drawing.file}
              progress={drawProgress}
              size={WHITEBOARD.sketchSizePx}
              skin={skin}
            />
          )}
        </div>
      )}

      {lines.map((slice, lineIndex) => (
        <div
          key={lineIndex}
          style={{
            // 'dissolve' sinks the writing into whatever is behind it; the
            // default lays it on top and keeps it crisp.
            mixBlendMode: content === 'dissolve' ? skin.into : 'normal',
            zIndex: 1,
            display: 'flex',
            // Never wrap. The fit above guarantees the line fits, and a wrap
            // would silently move the pen to a row of its own.
            flexWrap: 'nowrap',
            whiteSpace: 'nowrap',
            justifyContent: 'center',
            gap: `0 ${fontSize * (beat.lines[lineIndex]?.scale ?? 1) * WHITEBOARD.wordGapEm}px`,
            lineHeight: WHITEBOARD.lineHeight,
            fontSize: fontSize * (beat.lines[lineIndex]?.scale ?? 1),
            fontWeight: beat.lines[lineIndex]?.emphasis ? 700 : 400,
          }}
        >
          {slice.map((word, index) => {
            const local = interpolate(progress, [word.from, word.to], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
            // The pen rides the edge of the word being written. Putting it
            // inside the word means its position falls out of the same number
            // that drives the clip — no measuring, and it cannot drift.
            const writing = progress >= word.from && progress < word.to;
            return (
              <span key={index} style={{ position: 'relative', display: 'inline-block' }}>
                <span
                  style={{
                    display: 'inline-block',
                    // Ink arrives with an edge. A fade would read as text
                    // turning up, which is the thing this mode is not.
                    //
                    // The vertical bleed is half the box rather than 0.3em.
                    // Caveat's descenders hang further below the line box than
                    // that, so a y or a g was being cut off flat by the very
                    // clip that reveals the word. Expressed as a percentage so
                    // it holds at any size or line scale.
                    /**
                     * The right edge overshoots the box rather than stopping
                     * at it. inset(... 0) clips at the border box, and a
                     * script face hangs its last glyph past its own advance
                     * width -- so the final letter of every finished word had
                     * its overhang sliced off. Proof was one word carrying two
                     * d's where only the last one lost its ascender.
                     *
                     * Scaled so the reveal still starts fully hidden and ends
                     * fully clear: 100% at nothing written, -BLEED once done.
                     */
                    clipPath: `inset(-50% ${(1 - local) * (100 + GLYPH_BLEED) - GLYPH_BLEED}% -50% 0)`,
                  }}
                >
                  {word.text}
                </span>
                {writing ? (
                  <Nib
                    x={`${local * 100}%`}
                    y="0.5em"
                    height="1.35em"
                    tint={skin.glow}
                    ink={skin.ink}
                    barrel={skin.pen}
                    cuff={skin.cuff}
                  />
                ) : null}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};
