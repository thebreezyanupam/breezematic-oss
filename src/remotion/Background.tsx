import { Img, OffthreadVideo, interpolate, useCurrentFrame } from 'remotion';
import { PALETTES, RENDER, STAMP, TREATMENT } from '../design.js';
import { ShaderField } from './effects/ShaderField.js';
import { beatRng } from './layout.js';
import { CINEMA_TREATMENT, cinemaShot } from './cinema.js';
import { CinemaGrade } from './CinemaGrade.js';
import { isFootage, mediaSrc } from './media.js';
import type { Beat, EffectName, ImageryMode } from '../schema.js';

type Props = {
  beat: Beat;
  seed: number;
  effect: EffectName;
  imagery: ImageryMode;
  durationInFrames: number;
  /** Lay the trailer edit over the picture: snap zoom, recut, speed, grade. */
  cinema?: boolean;
};

/**
 * How the shader sits over the photograph. `blend` keeps the picture as
 * texture the field dissolves into; `photo` lets the picture lead and uses the
 * field only to tint it.
 */
type Mix = { field: number; blend: 'soft-light' | 'screen' | 'overlay'; photo: number };

const MIX: Record<ImageryMode, Mix> = {
  off: { field: 1, blend: 'screen', photo: 0 },
  blend: { field: 0.72, blend: 'soft-light', photo: 1 },
  // "photo" no longer washes the frame — it prints a stamp over it, so behind
  // the stamp the field is simply the background, at full strength.
  photo: { field: 1, blend: 'screen', photo: 0 },
};

/**
 * Every field is opaque, but they are not equally opaque in effect. The others
 * are smooth gradients that soft-light leaves the picture showing through;
 * static is broadband noise at full contrast, and soft-lighting it over a
 * photograph averages the picture into flat grey before the blur and the scrim
 * have even had their turn — which is why static looked like it ignored the
 * images entirely.
 *
 * Screening it instead keeps the dark parts of the frame transparent, so the
 * snow lands on top of a picture that is still there.
 */
const FIELD_OVERRIDES: Partial<Record<EffectName, Partial<Mix>>> = {
  static: { field: 0.34, blend: 'screen' },
};

/**
 * Remotion's Img, never the bare tag.
 *
 * A plain <img> does not hold the frame open while the browser decodes it. The
 * renderer captures frames in parallel, each from a fresh page state, so any
 * frame whose picture had not finished decoding was captured without it -- and
 * a full-bleed panel that is missing for two frames out of thirty reads as a
 * flicker. Remotion's Img wraps delayRender/continueRender: the frame is not
 * captured until the image is actually there.
 */
/**
 * A beat's picture, whether it is a still or a clip.
 *
 * OffthreadVideo rather than Video: rendering pulls each frame out with ffmpeg
 * instead of asking a headless Chrome to play the file in real time, which is
 * both faster and the only one of the two that is frame-accurate.
 *
 * Nothing loops here, and nothing needs to: OffthreadVideo has no loop prop,
 * and the fetch stage will not accept a clip shorter than the longest beat, so
 * a clip always outlasts the beat it plays under. A clip that ran out would
 * hold its last frame — a still, mid-video, for no reason a viewer could
 * account for. `muted` because the mix owns the audio.
 */
const Plate: React.FC<{ file: string; style: React.CSSProperties; rate?: number }> = ({
  file,
  style,
  rate,
}) =>
  isFootage(file) ? (
    <OffthreadVideo src={mediaSrc(file)} muted playbackRate={rate ?? 1} style={style} />
  ) : (
    <Img src={mediaSrc(file)} alt="" style={style} />
  );

function mixFor(effect: EffectName, imagery: ImageryMode, hasPhoto: boolean): Mix {
  const base = MIX[imagery] ?? MIX.blend;
  if (!hasPhoto) return base;
  return { ...base, ...(FIELD_OVERRIDES[effect] ?? {}) };
}

export const Background: React.FC<Props> = ({
  beat,
  seed,
  effect,
  imagery,
  durationInFrames,
  cinema = false,
}) => {
  const frame = useCurrentFrame();
  const progress = durationInFrames <= 1 ? 0 : frame / (durationInFrames - 1);

  const palette = PALETTES[beat.background.clipId] ?? PALETTES['gradient-dark'];
  const base = palette?.base ?? '#05070d';

  // Consumed so a beat's field sits differently from its neighbour's.
  const rng = beatRng(seed, `${beat.id}-bg`);
  const fieldSeed = Math.floor(rng() * 1000);

  const { kind, amount } = beat.motion;
  const drift = TREATMENT.driftScale;

  const scale =
    kind === 'push'
      ? interpolate(progress, [0, 1], [drift, drift + amount * 0.35])
      : kind === 'pull'
        ? interpolate(progress, [0, 1], [drift + amount * 0.35, drift])
        : drift + amount * 0.12;

  const pan = amount * RENDER.width * 0.18;
  const translateX =
    kind === 'pan-l'
      ? interpolate(progress, [0, 1], [pan, -pan])
      : kind === 'pan-r'
        ? interpolate(progress, [0, 1], [-pan, pan])
        : interpolate(progress, [0, 1], [pan * 0.15, -pan * 0.15]);

  const translateY = interpolate(progress, [0, 1], [amount * 22, -amount * 22]);

  const image = beat.background.image;
  /** Full-bleed, behind the field: the picture as texture. */
  const showPhoto = imagery === 'blend' && image !== null;
  /** Laid on top of the finished frame: the picture as a print. */
  const asStamp = imagery === 'photo' && image !== null;
  const mix = mixFor(effect, imagery, showPhoto);

  // The trailer edit. Computed even when off so the branches below stay flat.
  const shot = cinemaShot({ beat, seed, frame, durationInFrames });
  const blurPx = cinema ? beat.background.blurPx * CINEMA_TREATMENT.blurScale : beat.background.blurPx;
  const scrim = cinema
    ? beat.background.scrimOpacity * CINEMA_TREATMENT.scrimScale
    : beat.background.scrimOpacity;
  const fieldOpacity = showPhoto
    ? mix.field * (cinema ? CINEMA_TREATMENT.fieldScale : 1)
    : 1;

  // Drawn after fieldSeed so an existing beat sheet keeps the field it had.
  const tilt = (rng() * 2 - 1) * STAMP.tiltDegrees;
  const driftAway = rng() < 0.5 ? -1 : 1;
  // Which band, and where across it. Both from the beat's own stream, so the
  // arrangement is fixed for a seed but different from its neighbour's.
  const lowBand = rng() < 0.5;
  const acrossFrame = (rng() * 2 - 1) * STAMP.driftXFraction * RENDER.width;

  const stampWidth = RENDER.width * STAMP.widthFraction;
  const stampDriftX = interpolate(
    progress,
    [0, 1],
    [-STAMP.driftPx * driftAway, STAMP.driftPx * driftAway],
  );
  const stampDriftY = interpolate(progress, [0, 1], [STAMP.driftPx * 0.35, -STAMP.driftPx * 0.35]);
  const stampScale = interpolate(progress, [0, 1], [STAMP.scaleFrom, STAMP.scaleTo]);

  return (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: base }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform:
            `translate(${translateX}px, ${translateY}px) ` +
            `scale(${cinema ? scale * shot.scale : scale})`,
          filter: `blur(${blurPx}px) saturate(${cinema ? 1.06 : TREATMENT.saturation})`,
        }}
      >
        {showPhoto ? (
          <Plate
            file={image.file}
            rate={cinema ? shot.rate : 1}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: mix.photo,
            }}
          />
        ) : null}
        <div style={{ position: 'absolute', inset: 0, opacity: fieldOpacity }}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              mixBlendMode: showPhoto ? mix.blend : 'normal',
            }}
          >
            <ShaderField
              effect={effect}
              base={base}
              colours={palette?.blobs ?? []}
              seed={fieldSeed}
            />
          </div>
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: '#000',
          opacity: scrim,
        }}
      />
      {cinema ? <CinemaGrade flash={shot.flash} /> : null}
      {/*
        Above the scrim on purpose. The scrim exists to hold the type off the
        background, and a stamp that sits under it comes back as the same dim
        rectangle the full-bleed version already was. Still below the type,
        which is drawn by the scene after this component.
      */}
      {asStamp ? (
        <div
          style={{
            position: 'absolute',
            left: RENDER.width / 2 + acrossFrame,
            top:
              RENDER.height *
              (lowBand ? STAMP.bandBottomFraction : STAMP.bandTopFraction),
            width: stampWidth,
            height: stampWidth / STAMP.aspect,
            transform:
              `translate(-50%, -50%) translate(${stampDriftX}px, ${stampDriftY}px) ` +
              `rotate(${tilt}deg) scale(${stampScale})`,
            // No mount. The white border read as a photo-frame sticker; the
            // picture is the thing, so it sits on the frame directly. The
            // shadow stays, or it has no edge against a dark field at all.
            boxShadow: '0 24px 70px rgba(0, 0, 0, 0.5)',
          }}
        >
          <Plate
            file={image.file}
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              // Crisp: the background blur is what makes a photograph texture,
              // and this one is meant to be looked at.
              filter: `saturate(${TREATMENT.saturation})`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
};
