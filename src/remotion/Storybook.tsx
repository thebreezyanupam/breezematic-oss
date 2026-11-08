import { Easing, Img, interpolate, useCurrentFrame } from 'remotion';
import { PALETTES, RENDER } from '../design.js';
import { ShaderField } from './effects/ShaderField.js';
import { beatRng } from '../rng.js';
import { FONT_FAMILY } from './font.js';
import { mediaSrc } from './media.js';
import { beatWords, type Beat, type EffectName, type SubtitleMode } from '../schema.js';

/**
 * An illustrated panel with the caption burned across the bottom of it.
 *
 * The type treatment is the one difference from every other mode here, and it
 * is deliberate. The kinetic modes set the whole beat as the picture — huge,
 * centred, one or two words at a time. A picture book does the opposite: the
 * drawing is the picture, and the words sit under it in a band, whole lines at
 * a time, heavy enough to read over whatever colour happens to be behind them.
 *
 * White fill with a dark outline rather than a scrim. A band dark enough to
 * hold white type over a bright panel would cover a quarter of the drawing;
 * an outline costs nothing and sits directly on the art, which is exactly what
 * the format does.
 */

/**
 * The two burned treatments.
 *
 * "burned" is the format's own look: heavy, centred low, thick outline, meant
 * to be read at arm's length with the sound off. "minimal" is a caption rather
 * than a title — smaller, lower, lighter outline — for when the platform is
 * going to add its own subtitles on top and two sets would fight.
 */
/** 'kinetic' is drawn by the shared type layer, and 'none' by nobody. */
const SUBTITLE: Record<Exclude<SubtitleMode, 'none' | 'kinetic'>, {
  centre: number;
  size: number;
  weight: number;
  stroke: number;
}> = {
  burned: { centre: 0.8, size: 78, weight: 800, stroke: 9 },
  minimal: { centre: 0.88, size: 52, weight: 600, stroke: 5 },
};

/**
 * The effect field, laid over the finished panel.
 *
 * Soft-light, and the strength was measured rather than picked. Overlay was
 * the obvious choice and it was wrong: the static shader deliberately outputs
 * *bright* snow (`level = clamp(snow * 1.35)`) so that `screen` works for the
 * photographic background, and overlaying a layer that clamps to white lifts
 * the panel hard -- at 0.3 it took the mean luma up by forty on a 0-255 scale
 * and the picture went milky. Soft-light compresses those blown highlights
 * instead, which spreads the grain evenly over the whole frame rather than
 * piling it into the midtones.
 *
 * At 0.4 the panels measure +9 luma and 1.6x the local detail: clearly
 * textured, exposure essentially unmoved. The smooth fields are gentler to
 * begin with and only need to tint, so they sit lower.
 *
 * One thing worth knowing before turning it on: `static` is not a grain field.
 * It is a dead channel, with tear bands and a rolling scanline in it, and over
 * a large flat area -- a photograph's empty sky -- that structure reads as
 * encoding damage rather than as texture. Over a drawn panel, which has no
 * surface of its own, it reads as a printed cel. The drawn panels are what
 * this is for.
 *
 * It does not move with the panel. A texture that zooms with the picture reads
 * as dirt on the drawing; one fixed to the frame reads as the film it is being
 * shown on, which is the point of turning it on.
 */
const TEXTURE: Record<string, { opacity: number; blend: 'soft-light' }> = {
  static: { opacity: 0.4, blend: 'soft-light' },
};
const TEXTURE_DEFAULT = { opacity: 0.24, blend: 'soft-light' } as const;

/**
 * How much of the panel goes dark under the animated type. Enough for white
 * type to read over a pale watercolour wash, little enough that the drawing is
 * still the thing you are looking at.
 */
const KINETIC_SCRIM = 0.42;

/**
 * How long one panel takes to replace the last, in frames — and where that
 * change lands.
 *
 * Hard cutting these was the first problem: each panel moved across its beat
 * and the next started its own move from scratch, so every cut was a size
 * jump, a new direction and a new picture all on one frame. Measured frame by
 * frame there were no dropped frames; it was the cutting.
 *
 * Dissolving into the *incoming* beat was the second problem. A transition is
 * read at its middle, not its start, so fading in across the first eight frames
 * of a beat put the change a quarter-second behind the cut — late enough to
 * feel loose against the narration.
 *
 * So the outgoing panel does the work: it fades the next picture in over its
 * own last frames, and the change completes exactly on the boundary. A plain
 * cross-dissolve, because nothing else survives arbitrary subject matter --
 * a wipe or a push needs the two frames to agree about where the eye is, and
 * two unrelated illustrations never do. Eased, because a linear ramp of this
 * length sits at the double-exposed midpoint long enough to read as a fault.
 */
const DISSOLVE_FRAMES = 16;

const PANEL = {
  lineHeight: 1.18,
  sidePadding: 64,
} as const;

/**
 * The panel move: a slow zoom, and nothing else.
 *
 * It used to drift sideways as well — ±26px, direction picked per beat — and
 * that was the jump. The outgoing panel faded the *next* picture in flat and
 * centred, but the next beat's own sequence opened it 26 pixels off centre, in
 * a direction that beat had chosen for itself. So the dissolve completed, the
 * cut landed, and the picture snapped sideways by 26px on a single frame.
 *
 * Zoom has no such seam, because it is centred: a panel at 1.06 and the same
 * panel at 1.06 are in the same place whoever is drawing them. Dropping the
 * drift removes the whole class of bug rather than trying to match two random
 * streams, and a slow push into a still is the move this format wants anyway.
 *
 * `far` is above 1 so `objectFit: cover` never exposes an edge to a rounding
 * error, and travel varies per panel so twenty of them do not breathe in
 * unison.
 */
const ZOOM = {
  far: 1.02,
  minTravel: 0.05,
  maxTravel: 0.11,
  /** Share of panels that pull back rather than push in. */
  pullShare: 0.32,
} as const;

/**
 * Where a panel's zoom starts and ends. Exported in spirit rather than in
 * name: the panel before this one calls it too, so the picture it dissolves in
 * is at exactly the scale this beat is about to open on.
 */
function panelZoom(seed: number, beatId: string): { from: number; to: number } {
  const rng = beatRng(seed, `${beatId}-zoom`);
  const pull = rng() < ZOOM.pullShare;
  const travel = ZOOM.minTravel + rng() * (ZOOM.maxTravel - ZOOM.minTravel);
  const near = ZOOM.far + travel;
  return pull ? { from: near, to: ZOOM.far } : { from: ZOOM.far, to: near };
}

/** What the outgoing panel needs to know about the one replacing it. */
export type NextPanel = { file: string; id: string; durationInFrames: number };

export const Storybook: React.FC<{
  beat: Beat;
  seed: number;
  durationInFrames: number;
  subtitles: SubtitleMode;
  captionScale: number;
  /** The shader field to lay over the panel, or null to leave it clean. */
  effect: EffectName | null;
  /** The panel after this one, brought in over the tail so it lands on the cut. */
  next?: NextPanel | null;
  /** The face the caption is drawn in, decided by the video's language. */
  fontFamily?: string;
}> = ({ beat, seed, durationInFrames, subtitles, captionScale, effect, next, fontFamily }) => {
  const frame = useCurrentFrame();
  const progress = durationInFrames <= 1 ? 0 : frame / (durationInFrames - 1);

  const image = beat.background.image;

  const zoom = panelZoom(seed, beat.id);
  const scale = interpolate(progress, [0, 1], [zoom.from, zoom.to]);

  /**
   * The incoming panel is already moving when it arrives.
   *
   * It would be easier to hold it at its opening scale for the length of the
   * dissolve and let it start on the cut, and the position would still match.
   * But then the picture is frozen for half a second and then moves, and a
   * change of speed on the cut frame is the same tell as a change of place —
   * quieter, but there. So it runs its own zoom backwards from the scale it
   * opens on, at its own rate, and crosses the boundary at constant speed.
   */
  const nextZoom = next == null ? null : panelZoom(seed, next.id);
  const nextPerFrame =
    next == null || nextZoom == null
      ? 0
      : (nextZoom.to - nextZoom.from) / Math.max(1, next.durationInFrames - 1);
  const framesToCut = Math.max(0, durationInFrames - 1 - frame);
  const arrivingScale = nextZoom == null ? 1 : nextZoom.from - nextPerFrame * framesToCut;

  /**
   * Eased, and only over the tail. `easing` matters more than the length: a
   * straight ramp spends most of its time at half opacity, which is the part
   * that looks like a fault.
   */
  const handover = Math.max(0, durationInFrames - DISSOLVE_FRAMES);
  const arriving =
    next == null
      ? 0
      : interpolate(frame, [handover, durationInFrames - 1], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.inOut(Easing.ease),
        });

  const lines = beat.lines.map((line) => line.text).filter((text) => text.trim() !== '');
  const spoken = beatWords(beat.lines).length;
  // The gradient stays whoever draws the words: it is part of the picture
  // treatment, and a panel that suddenly loses its footer reads as a different
  // video. Under kinetic type it is what the type sits against.
  const style = subtitles === 'none' || subtitles === 'kinetic' ? null : SUBTITLE[subtitles];

  return (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: '#12131a', overflow: 'hidden' }}>
      {image === null ? null : (
        <Img
          src={mediaSrc(image.file)}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `scale(${scale})`,
          }}
        />
      )}

      {/*
        The next panel, arriving over the tail of this one so the change is
        complete on the cut rather than a quarter-second past it. It is drawn
        at its own zoom, wound back to where that zoom would have been this
        many frames early -- so it reaches its opening scale exactly as its own
        sequence takes over, already at speed.
      */}
      {next == null || arriving <= 0 ? null : (
        <Img
          src={mediaSrc(next.file)}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: arriving,
            transform: `scale(${arrivingScale})`,
          }}
        />
      )}

      {/*
        The field, over both pictures so the texture does not pop on a cut, and
        under everything that has to stay readable.
      */}
      {effect === null ? null : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: (TEXTURE[effect] ?? TEXTURE_DEFAULT).opacity,
            mixBlendMode: (TEXTURE[effect] ?? TEXTURE_DEFAULT).blend,
            pointerEvents: 'none',
          }}
        >
          <ShaderField
            effect={effect}
            base={PALETTES[beat.background.clipId]?.base ?? '#05070d'}
            colours={PALETTES[beat.background.clipId]?.blobs ?? []}
            // Fixed for the video, not per beat: a field that reshuffles every
            // cut is a second thing changing on the cut frame, which is what
            // the dissolve exists to avoid.
            seed={seed % 1000}
          />
        </div>
      )}

      {/*
        Under the animated type only, and it is not optional.

        The kinetic type is white and unstroked because every other mode draws
        it over `Background`, which lays a black scrim first. A storybook panel
        lays none, so the first render of this combination put white captions
        over pale watercolour and they vanished. The panel is still the picture;
        this is the amount of dark the type needs to sit on it.
      */}
      {subtitles !== 'kinetic' ? null : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: '#000',
            opacity: KINETIC_SCRIM,
          }}
        />
      )}

      {/*
        A short gradient at the foot of the frame, not a band across the type.
        The outline does the legibility work; this only stops the caption
        floating on a panel whose bottom edge happens to be pale.
      */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: RENDER.height * 0.34,
          background: 'linear-gradient(180deg, rgba(6,8,14,0) 0%, rgba(6,8,14,0.55) 100%)',
        }}
      />

      {spoken === 0 || style === null ? null : (
        <div
          style={{
            position: 'absolute',
            left: PANEL.sidePadding,
            right: PANEL.sidePadding,
            top: RENDER.height * style.centre,
            transform: 'translateY(-50%)',
            textAlign: 'center',
            fontFamily: fontFamily ?? FONT_FAMILY,
            fontWeight: style.weight,
            // The caption-size control was shown for this mode and did nothing:
            // the size was a constant. It scales the treatment now rather than
            // replacing it, so "minimal at 60%" is still recognisably minimal.
            fontSize: Math.round(style.size * captionScale),
            lineHeight: PANEL.lineHeight,
            letterSpacing: '-0.01em',
            color: '#ffffff',
            // paintOrder keeps the stroke behind the fill; without it the
            // outline eats into the letterforms and the type reads as bolder
            // and muddier at every weight.
            paintOrder: 'stroke fill',
            WebkitTextStroke: `${Math.max(2, Math.round(style.stroke * captionScale))}px #14161f`,
          }}
        >
          {lines.map((text, index) => (
            <div key={index}>{text}</div>
          ))}
        </div>
      )}
    </div>
  );
};
