import { AbsoluteFill, CanvasImage, OffthreadVideo, interpolate, useCurrentFrame } from 'remotion';
import { chromaticAberration } from '@remotion/effects/chromatic-aberration';
import { zoomBlur } from '@remotion/effects/zoom-blur';
import { beatRng } from '../../rng.js';
import type { ArtStyle, Beat } from '../../schema.js';
import { isFootage, mediaSrc } from '../media.js';
import { EX } from './theme.js';
import type { Move, TransitionKind } from './transitions.js';

/**
 * The art style, applied to a picture that was not drawn in it.
 *
 * Generated pictures are drawn in the style (the prompt asks for it), so they
 * get the ordinary grade. Photographs and clips cannot be redrawn, so they are
 * treated toward it instead: graphite and ink for pencil and manga, a halftone
 * screen for comic, a paper wash for watercolour, a print's limited inks for
 * retro. A treatment, honestly -- it reads as the style, it is not a painting.
 */
type Treatment = { grade: string; texture: 'paper' | 'halftone' | 'grain' | null; mono: boolean };
const ART_TREATMENT: Record<ArtStyle, Treatment | null> = {
  auto: null,
  flat: { grade: 'contrast(1.22) saturate(1.5) brightness(1.03)', texture: null, mono: false },
  watercolour: { grade: 'contrast(0.86) saturate(0.72) brightness(1.14) blur(1.3px)', texture: 'paper', mono: false },
  anime: { grade: 'contrast(1.16) saturate(1.38) brightness(1.05)', texture: null, mono: false },
  comic: { grade: 'contrast(1.42) saturate(1.55) brightness(1.02)', texture: 'halftone', mono: false },
  manga: { grade: 'grayscale(1) contrast(1.65) brightness(1.06)', texture: 'halftone', mono: true },
  pencil: { grade: 'grayscale(1) contrast(1.32) brightness(1.16)', texture: 'paper', mono: true },
  painterly: { grade: 'contrast(1.08) saturate(1.32) blur(0.45px)', texture: 'grain', mono: false },
  retro: { grade: 'sepia(0.45) saturate(1.4) contrast(1.15) hue-rotate(-12deg)', texture: 'grain', mono: false },
};

const PAPER_TEXTURE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='260' height='260'%3E%3Cfilter id='p'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.55 0 0 0 0 0.48 0 0 0 0 0.38 0 0 0 0.5 0'/%3E%3C/filter%3E%3Crect width='260' height='260' filter='url(%23p)'/%3E%3C/svg%3E\")";

const ArtTexture: React.FC<{ kind: Treatment['texture'] }> = ({ kind }) => {
  if (kind === null) return null;
  if (kind === 'halftone') {
    return (
      <AbsoluteFill
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.5) 2.4px, transparent 3.1px)',
          backgroundSize: '12px 12px',
          mixBlendMode: 'multiply',
          opacity: 0.8,
        }}
      />
    );
  }
  return (
    <AbsoluteFill
      style={{
        backgroundImage: PAPER_TEXTURE,
        mixBlendMode: kind === 'paper' ? 'multiply' : 'soft-light',
        opacity: kind === 'paper' ? 0.85 : 0.45,
      }}
    />
  );
};

/**
 * The beat's picture, full bleed, with the camera move an editor would put on
 * a still.
 *
 * Two treatments. "sharp" is the picture as the subject: graded, vignetted,
 * moving slowly. "plate" is the picture as the room a graphic stands in --
 * blurred and dark enough that a chart over it reads, but still visibly the
 * thing being talked about rather than a gradient that could be any video.
 *
 * Stills are drawn through a canvas so the cut can use real lens effects
 * rather than a CSS blur: a zoom blur radiating from the centre on a zoom or
 * spin, and the channels pulled apart on a whip. A CSS blur on a fast move
 * reads as out of focus; a zoom blur reads as motion, which is what the
 * transition is.
 *
 * The move comes from the sheet's own motion for the beat, so it is seeded and
 * varies, and it runs the whole beat at a constant ease: a Ken Burns that
 * stops before the cut is a picture that has visibly run out of film.
 */
export const Media: React.FC<{
  beat: Beat;
  durationInFrames: number;
  treatment: 'sharp' | 'plate';
  /** Where the transition is at this frame, and which ones bracket the beat. */
  move: Move;
  into: TransitionKind | 'open';
  outOf: TransitionKind | null;
  /** The frame the beat's emphasis word is said on: the camera punches in on it. */
  punchFrame: number | null;
  /** The video's art style: a picture not drawn in it is treated toward it. */
  art?: ArtStyle;
}> = ({ beat, durationInFrames, treatment, move, into, outOf, punchFrame, art = 'auto' }) => {
  const frame = useCurrentFrame();
  const file = beat.background.image?.file ?? null;
  const t = interpolate(frame, [0, Math.max(1, durationInFrames)], [0, 1], { extrapolateRight: 'clamp' });
  const amount = beat.motion.amount;

  const zoomFrom = 1.06;
  const zoomBy = 0.08 + amount * 0.22;
  let scale = zoomFrom;
  let x = 0;
  switch (beat.motion.kind) {
    case 'push':
      scale = zoomFrom + zoomBy * t;
      break;
    case 'pull':
      scale = zoomFrom + zoomBy * (1 - t);
      break;
    case 'pan-l':
      scale = zoomFrom + 0.06;
      x = (0.5 - t) * 70 * (0.6 + amount);
      break;
    case 'pan-r':
      scale = zoomFrom + 0.06;
      x = (t - 0.5) * 70 * (0.6 + amount);
      break;
  }
  if (treatment === 'plate') scale += 0.08;

  /**
   * The punch: a quick push on the word that matters, settling back over a
   * third of a second. It is the cheapest move in editing and the one viewers
   * feel most, because it puts the cut's energy on a word rather than a frame.
   */
  if (punchFrame !== null && frame >= punchFrame) {
    scale += 0.07 * interpolate(frame, [punchFrame, punchFrame + 3, punchFrame + 14], [0, 1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }

  // Which lens effect this frame of the transition wants, if any.
  const radial = (into === 'zoom' || into === 'spin' || into === 'open') && frame < 10
    || ((outOf === 'zoom' || outOf === 'spin') && frame > durationInFrames - 8);
  const lateral = (into === 'whip' || into === 'slide') && frame < 10
    || ((outOf === 'whip' || outOf === 'slide') && frame > durationInFrames - 8);
  const flashy = (into === 'flash' && frame < 6) || (outOf === 'flash' && frame > durationInFrames - 6);

  // Generated pictures ("ai-...") were drawn in the style already.
  const styled = file !== null && !file.startsWith('ai-') ? ART_TREATMENT[art] : null;
  const grade =
    treatment === 'plate'
      ? `blur(20px) brightness(0.42) saturate(${styled?.mono ? 0 : 1.1})`
      : styled !== null
        ? styled.grade
        : 'contrast(1.06) saturate(1.12) brightness(0.96)';
  const style: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transform: `translateX(${x}px) scale(${scale})`,
    filter: grade,
  };

  return (
    <AbsoluteFill style={{ backgroundColor: EX.ground, overflow: 'hidden' }}>
      {file === null ? (
        <Backdrop frame={frame} />
      ) : isFootage(file) ? (
        <OffthreadVideo
          src={mediaSrc(file)}
          muted
          style={{ ...style, filter: `${grade}${move.blur > 0.2 ? ` blur(${move.blur.toFixed(1)}px)` : ''}` }}
        />
      ) : (
        <CanvasImage
          src={mediaSrc(file)}
          width={EX.width}
          height={EX.height}
          fit="cover"
          style={style}
          effects={[
            zoomBlur({ amount: Math.max(1, move.blur * 4), samples: 24, disabled: !radial || move.blur < 0.5 }),
            chromaticAberration({
              amount: Math.max(1, move.blur * (flashy ? 0.6 : 1.1)),
              angle: 0,
              disabled: !(lateral || flashy) || move.blur < 0.5,
            }),
          ]}
        />
      )}
      {treatment === 'sharp' && file !== null ? <Dust beat={beat} frame={frame} /> : null}
      {treatment === 'sharp' && styled !== null ? <ArtTexture kind={styled.texture} /> : null}
      {/* The grade: lifted teal shadows, warm highlights, a vignette. A monochrome style keeps its greys. */}
      {styled?.mono ? null : (
        <>
          <AbsoluteFill style={{ backgroundColor: 'rgb(8, 30, 40)', mixBlendMode: 'screen', opacity: treatment === 'plate' ? 0.5 : 0.8 }} />
          <AbsoluteFill style={{ backgroundColor: 'rgb(255, 240, 220)', mixBlendMode: 'multiply' }} />
        </>
      )}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse 85% 60% at 50% 45%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.55) 100%)',
        }}
      />
      {/* Darker where the captions sit, so white type holds over a white sky. */}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 52%, rgba(0,0,0,0.62) 78%, rgba(0,0,0,0.7) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * Motes drifting through the light, in front of the picture.
 *
 * A still with a camera move on it is still a still; a few out-of-focus specks
 * moving at a different speed from it are what make the frame read as space
 * with a lens in it. Seeded per beat, so a re-render drifts the same way.
 */
const Dust: React.FC<{ beat: Beat; frame: number }> = ({ beat, frame }) => {
  const rng = beatRng(beat.background.inPointMs + beat.startMs, `${beat.id}:dust`);
  const motes = Array.from({ length: 16 }, () => ({
    x: rng() * EX.width,
    y: rng() * EX.height,
    size: 3 + rng() * 9,
    speed: 0.25 + rng() * 0.7,
    drift: (rng() - 0.5) * 0.8,
    phase: rng() * Math.PI * 2,
    depth: rng(),
  }));
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', mixBlendMode: 'screen' }}>
      {motes.map((mote, index) => {
        const y = (mote.y - frame * mote.speed * 2 + EX.height) % EX.height;
        const x = mote.x + Math.sin(frame / 40 + mote.phase) * 18 + frame * mote.drift;
        return (
          <div
            key={index}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: mote.size,
              height: mote.size,
              borderRadius: '50%',
              background: 'rgba(255, 236, 200, 0.9)',
              opacity: 0.12 + 0.28 * (0.5 + 0.5 * Math.sin(frame / 25 + mote.phase)),
              filter: `blur(${(1 + mote.depth * 4).toFixed(1)}px)`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/**
 * When no picture was found: a graded field with a slow grid, so a beat
 * without an image still looks designed rather than missing.
 */
const Backdrop: React.FC<{ frame: number }> = ({ frame }) => {
  const drift = (frame * 0.6) % 90;
  return (
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(ellipse 90% 70% at 30% 20%, #1d2b4a 0%, rgba(7,9,14,0) 60%), ' +
          'radial-gradient(ellipse 80% 60% at 80% 85%, #3a2a10 0%, rgba(7,9,14,0) 60%), #07090e',
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.05) 2px, transparent 2px), linear-gradient(90deg, rgba(255,255,255,0.05) 2px, transparent 2px)',
          backgroundSize: '90px 90px',
          backgroundPosition: `0 ${drift}px`,
        }}
      />
    </AbsoluteFill>
  );
};
