import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { PALETTE, TYPE, DEVICE, type Variation } from '../design/signature.js';
import { STYLES, PALETTES } from '../design.js';
import { FONT_FAMILY, HAND_FONT_FAMILY, SERIF_FONT_FAMILY, useInterFont } from './font.js';
import { emphasisStyle } from './templates.js';
import { Stickman } from './Stickman.js';
import { CinemaGrade } from './CinemaGrade.js';
import { cased } from './layout.js';
import { ShaderField } from './effects/ShaderField.js';
import {
  type ChapterCard,
  LEAD_IN_MS,
  type Cutout,
  type EssayGrade,
  type QuoteCard,
  type EssayLook,
  type Line,
  type Plate,
} from '../stages/compose.js';
import type { StickBeat } from '../stages/stickworld.js';
import {
  BehindCaption,
  ChapterCardView,
  chapterAt,
  CinemaPlates,
  CinemaTitle,
  Grain,
  Letterbox,
  QuoteCardView,
  barFraction,
  quoteAt,
} from './EssayCinema.js';

/**
 * The long-form essay frame.
 *
 * Three registers, and they are genuinely three different things rather than
 * one thing at three speeds. That distinction is the whole design: a cold hold
 * is not a slow warm section, it is a composition that has stopped moving, and
 * a hot cut is not a fast warm section, it is type arriving without easing on
 * a ground that has changed colour. If they were parameterised versions of
 * each other the contrast the brief is built around would not survive
 * compression, let alone a viewer.
 *
 * Nothing here decides anything. Which line shows, which device marks it and
 * which register it belongs to were all settled in compose.ts; this looks them
 * up by frame and draws them. That is what makes the look testable without a
 * browser and what keeps a render deterministic.
 */

export type EssayProps = {
  title: string;
  lines: Line[];
  durationMs: number;
  variation: Variation;
  seed: number;
  /** A shader field behind the type, or 'none' for the flat paper ground. */
  effect?: string;
  /** Pictures under the type. */
  plates?: Plate[];
  /** Subjects pasted over the picture at the moment they are named. */
  cutouts?: Cutout[];
  /** How strongly the field sits over a picture, 0 to 1. */
  effectStrength?: number;
  /** Multiplier on every type size. */
  captionScale?: number;
  /** Cinematic unless a video asks for the storybook look. */
  look?: EssayLook;
  /** How hard the cinematic grade leans: film stills take it all. */
  grade?: EssayGrade;
  /** Chapter cards, on the video's clock. Empty for a video without them. */
  chapters?: ChapterCard[];
  /** Titles and chapter names typed on, key by key -- or, when false, faded in whole. */
  typewriter?: boolean;
  /** The book's own words, on screen while the narration quotes them. */
  quotes?: QuoteCard[];
  /** The stick figure's beats, when the look is stickman. */
  stickman?: StickBeat[];
  /** Stickman only: letterbox, grade and grain with subtitles in the bar, or plain. */
  stickFinish?: 'cinematic' | 'plain';
};

/**
 * A caption style, as the type layer needs it.
 *
 * The five treatments already exist for shorts; this reads the same table so
 * the two cannot drift into meaning different things by the same name. What
 * changes here is that the style is per line rather than per video -- the
 * whole point being that it switches for the few seconds a claim lands.
 */
function styleFor(name: string): {
  weight: number;
  emphasisWeight: number;
  stroke: boolean;
  tracking: number;
  emphasis: string;
} {
  const tokens = STYLES[name] ?? STYLES['editorial'];
  return {
    weight: tokens?.bodyWeight ?? 400,
    emphasisWeight: tokens?.emphasisWeight ?? 700,
    stroke: name === 'outline',
    tracking: tokens?.trackingEm ?? 0,
    /**
     * How the treatment actually differs, which this used to throw away.
     *
     * Only `stroke` was being read, so of the five treatments one was hollow
     * and the other four were the same handwriting at weights a script face
     * rounds to the same two. A menu of five choices that produces two
     * outcomes is not a menu.
     *
     * The colours in the table are not read. They belong to the shorts
     * palettes -- the highlighter is a #ffe14d yellow -- and this channel's
     * whole premise is one locked palette, so a treatment borrows its shape
     * from here and its colour from the signature.
     */
    emphasis: tokens?.emphasis ?? 'weight',
  };
}

/**
 * Where the type sits, decided by register rather than by the video's look.
 *
 * This was one placement for the whole video, drawn from the variation, and it
 * was wrong in a way that is obvious once the video plays: ordinary narration
 * set in the middle of the frame at ninety-six points is not a caption, it is
 * a title card, and twenty-five minutes of title cards is exhausting to watch
 * and leaves nowhere for a real one to go.
 *
 * So narration behaves like a caption -- lower third, modest, out of the way
 * of whatever the frame is showing -- and the claim takes the middle, which is
 * the only reason the middle means anything. The variation still shifts the
 * block within its band, so two videos are not identically placed; it just no
 * longer decides whether a caption is a caption.
 */
/**
 * One place, for everything.
 *
 * The claim used to take the centre of the frame, on the reasoning that the
 * centre is where you put the thing that matters. That reasoning ignored what
 * else is in the middle of the frame -- the picture's subject, and now the
 * cuttings, which are pasted over it at the exact moments the argument is
 * loudest. So the two loudest elements were competing for the same hundred
 * pixels, and the type won by covering the thing it was supposed to be
 * emphasising.
 *
 * A caption is a caption. It sits at the bottom, all of it, always, in the
 * same place every time. What changes on a punch is the type, not the address.
 */
const BAND: React.CSSProperties = {
  justifyContent: 'flex-end',
  alignItems: 'center',
  textAlign: 'center',
};

const PLACEMENT: Record<Line['register'], React.CSSProperties> = {
  hot: BAND,
  warm: BAND,
  cold: BAND,
};

/** How far the block shifts inside its band, so two videos are not identical. */
const NUDGE: Record<Variation['composition'], { x: number; align: React.CSSProperties['alignItems'] }> = {
  'left-low': { x: -7, align: 'flex-start' },
  'left-high': { x: -4, align: 'flex-start' },
  centre: { x: 0, align: 'center' },
  'right-low': { x: 7, align: 'flex-end' },
  'right-high': { x: 4, align: 'flex-end' },
};

/** Which way the slow motion travels, as a unit vector over the whole video. */
const DIRECTION: Record<Variation['direction'], { x: number; y: number; zoom: number }> = {
  in: { x: 0, y: 0, zoom: 1 },
  out: { x: 0, y: 0, zoom: -1 },
  left: { x: -1, y: 0, zoom: 0.3 },
  right: { x: 1, y: 0, zoom: 0.3 },
  up: { x: 0, y: -1, zoom: 0.3 },
};

/**
 * Type sizes, in the handwriting.
 *
 * Bigger numbers than the serif used for the same job, because Caveat's
 * x-height is a much smaller fraction of its em -- set at 44 it reads about a
 * third smaller than a 44-point serif and looks like a mistake rather than a
 * choice.
 *
 * The claim is still larger, but nothing like twice: it has to fit the caption
 * band on one or two lines now instead of owning the whole frame, and a
 * four-line punch across the middle was one of the things that made the last
 * cut exhausting to watch.
 */
const SIZE = { hot: 58, warm: 50, cold: 50 } as const;

/**
 * The caption band's typography, which is not a setting.
 *
 * The band used to read its weights and tracking out of the shorts style
 * table, which meant a control labelled "Captions" was choosing the letter
 * spacing of the subtitles -- including `editorial`'s -0.03em, which is a
 * tightening meant for a grotesque at display size and is wrong on a script
 * face at caption size.
 *
 * A subtitle has one correct setting and this is it: the handwriting, regular,
 * normal spacing, with the stressed word in the bold. The style table still
 * governs the punch, where choosing between treatments is the whole point.
 */
const CAPTION_TYPE = {
  weight: TYPE.regular,
  emphasisWeight: TYPE.bold,
  stroke: false,
  tracking: 0,
  emphasis: 'weight',
} as const;

/** The caption band, as a share of frame height. */
const CAPTION_BOTTOM = 0.1;

function lineAt(lines: readonly Line[], ms: number): Line | null {
  // Linear rather than a binary search: a twenty-five minute essay is a few
  // thousand lines and this runs once per frame, not once per pixel.
  for (const line of lines) {
    if (ms >= line.startMs && ms < line.endMs) return line;
  }
  return null;
}

/**
 * The ground.
 *
 * Paper, and a plane that moves differently in each register: drifting under
 * a warm section, dead still under a cold one, and jumping to a new position
 * on every hot cut. The jump is what makes a hot stretch read as cut rather
 * than as animated -- the type changes and so does everything behind it.
 */
/**
 * The picture layer.
 *
 * Under the field rather than over it, so the shader reads as weather on top
 * of a photograph instead of a sheet in front of one -- which is the whole
 * "storybook with heavy static" look and the reason the effect is worth having
 * at all once there are pictures.
 *
 * The slow push is per plate, not per video: a picture that arrives already
 * moving reads as footage, and one that arrives still reads as a slide.
 */
const Plates: React.FC<{ plates: readonly Plate[]; ms: number; fps: number }> = ({
  plates,
  ms,
  fps,
}) => {
  const plate = plates.find((p) => ms >= p.startMs && ms < p.endMs) ?? null;
  if (plate === null) return null;

  const held = plate.endMs - plate.startMs;
  const into = held <= 0 ? 0 : (ms - plate.startMs) / held;
  // A short dissolve at each end, so plates change without a hard cut under
  // type that is not changing with them.
  const fade = Math.min(1, Math.min(ms - plate.startMs, plate.endMs - ms) / 600);

  return (
    <AbsoluteFill style={{ opacity: Math.max(0, fade) }}>
      {plate.motion ? (
        <OffthreadVideo
          src={staticFile(`images/${plate.file}`)}
          startFrom={0}
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <Img
          src={staticFile(`images/${plate.file}`)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `scale(${1.04 + into * 0.07})`,
          }}
        />
      )}
    </AbsoluteFill>
  );
};

/**
 * The cuttings.
 *
 * Everything here is in service of one thing: the edge has to be hard. A
 * cutting fades in and it is a composite -- the eye files it under scenery and
 * stops looking. It appears between one frame and the next and it is an
 * interruption, which is the only reason to use one.
 *
 * So there is no fade at either end. What there is instead is a stamp: two
 * frames of overshoot on the scale and the tilt, which is what something
 * pressed onto a page actually does, and which gives the arrival a physical
 * cause rather than reading as a dropped frame.
 */
/** How long a cutting takes to arrive, and to leave. */
const IN_MS = 320;
const OUT_MS = 260;

const Cutouts: React.FC<{ cutouts: readonly Cutout[]; ms: number }> = ({ cutouts, ms }) => {
  const showing = cutouts.filter((cut) => ms >= cut.startMs && ms < cut.endMs);
  if (showing.length === 0) return null;

  return (
    <AbsoluteFill>
      {showing.map((cut) => {
        const since = ms - cut.startMs;
        const until = cut.endMs - ms;
        /**
         * In and out, and both of them are movement rather than a cut.
         *
         * A cutting that vanishes between frames reads as a dropped frame, and
         * a crossfade makes it scenery. So it arrives with an overshoot -- a
         * hand putting something down -- and leaves shrinking and dropping, a
         * hand taking it back. Fast enough to still punctuate.
         */
        const appear = interpolate(Math.min(1, Math.max(0, since / IN_MS)), [0, 1], [0, 1], {
          easing: Easing.out(Easing.back(2.2)),
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const leave = interpolate(Math.min(1, Math.max(0, until / OUT_MS)), [0, 1], [0, 1], {
          easing: Easing.out(Easing.cubic),
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });

        /**
         * Sharing the screen.
         *
         * A partner on the other side is a second person in the same picture,
         * and both step back a little to make room -- smoothly, as the partner
         * arrives and again as it goes, so neither jumps when the other moves.
         */
        const partner = showing.find((other) => other !== cut && other.side !== cut.side);
        const room =
          partner === undefined
            ? 0
            : Math.min(1, Math.max(0, (ms - partner.startMs) / 400)) *
              Math.min(1, Math.max(0, (partner.endMs - ms) / 300));
        const pairScale = 1 - 0.1 * room;

        const entrance = cut.entrance ?? 'rise';
        const toward = cut.side === 'right' ? 1 : -1;
        const book = cut.kind === 'book';

        // The way in, one of four, all landing on the same resting place.
        let dx = 0;
        let dy = 0;
        let spin = 0;
        let flip = 0;
        let grow = 0.84 + 0.16 * appear;
        if (entrance === 'rise') {
          dy = (1 - appear) * 9;
        } else if (entrance === 'slide') {
          dx = (1 - appear) * 70 * toward;
          spin = (1 - appear) * 6 * toward;
          grow = 1;
        } else if (entrance === 'drop') {
          dy = -(1 - appear) * 22;
          spin = (1 - appear) * -8 * toward;
        } else {
          flip = (1 - appear) * 90 * toward;
          grow = 0.92 + 0.08 * appear;
        }
        // The way out: drops and shrinks, except a slide, which goes back the
        // way it came.
        if (entrance === 'slide') dx += (1 - leave) * 60 * toward;
        else dy += (1 - leave) * 7;

        /**
         * Alive while it is up.
         *
         * A cutting held perfectly still for eight seconds reads as a frozen
         * frame. A slow sway of half a degree and a drift of a few per cent
         * over the hold is paper that has been put down, not a sticker on
         * the glass. Phase from the start time, so two cuttings never sway
         * in step.
         */
        const t = since / 1000;
        const phase = (cut.startMs % 997) / 997 * Math.PI * 2;
        const sway = Math.sin(t * 0.9 + phase) * 0.6;
        const bob = Math.sin(t * 1.3 + phase) * 0.5;
        const drift = 1 + Math.min(1, t / 10) * 0.03;

        const scale = grow * (0.94 + 0.06 * leave) * pairScale * drift;
        const tilt = cut.tilt * appear + sway;

        return (
          <div
            key={`${cut.file}-${cut.startMs}`}
            style={{
              position: 'absolute',
              /**
               * Clear of the caption band, not resting on it: two lines of
               * narration occupy roughly the bottom tenth to quarter of the
               * frame, measured on a rendered frame.
               */
              bottom: `${(cut.lift ?? 0.28) * 100}%`,
              ...(cut.side === 'right' ? { right: `${5 - 1.5 * room}%` } : { left: `${5 - 1.5 * room}%` }),
              height: `${cut.scale * 100}%`,
              transform:
                `perspective(1400px) translate(${dx}%, ${dy + bob}%) rotate(${tilt}deg) ` +
                `rotateY(${flip}deg) scale(${scale})`,
              transformOrigin: 'bottom center',
              // A couple of frames of fade at each end, so the silhouette is
              // never half-drawn.
              opacity: Math.min(1, since / 90) * Math.min(1, until / 140),
              display: 'flex',
              alignItems: 'flex-end',
            }}
          >
            <img
              src={staticFile(`images/${cut.file}`)}
              style={{
                height: '100%',
                width: 'auto',
                maxWidth: partner === undefined ? '44vw' : '40vw',
                objectFit: 'contain',
                ...(cut.mirror === true ? { transform: 'scaleX(-1)' } : {}),
                /**
                 * A cover is a rectangle and a person is not, and the two want
                 * opposite shadows. drop-shadow follows the alpha silhouette,
                 * so a keyed figure casts a shadow shaped like the figure; a
                 * cover gets the paper border and box shadow of something laid
                 * on the frame.
                 */
                ...(book
                  ? {
                      border: '9px solid #efe9dd',
                      boxShadow: '0 22px 48px rgba(0,0,0,0.62)',
                    }
                  : {
                      filter:
                        'drop-shadow(0 18px 26px rgba(0,0,0,0.55)) ' +
                        'drop-shadow(0 2px 0 rgba(0,0,0,0.30))',
                    }),
              }}
            />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

const Ground: React.FC<{
  register: Line['register'];
  progress: number;
  variation: Variation;
  cutIndex: number;
  inverted: boolean;
  effect?: string;
  seedFor: number;
  hasPlate: boolean;
  strength: number;
}> = ({ register, progress, variation, cutIndex, inverted, effect, seedFor, hasPlate, strength }) => {
  const travel = DIRECTION[variation.direction];
  const ground = inverted ? PALETTE.ink : PALETTE.paper;

  // Warm drifts across the whole video; cold holds wherever the drift had got
  // to; hot is displaced per cut so each one lands somewhere new.
  const drift = register === 'cold' ? 0 : progress;
  const jump = register === 'hot' ? ((cutIndex * 37) % 9) - 4 : 0;

  const scale = 1 + travel.zoom * drift * 0.06 + (register === 'hot' ? 0.02 : 0);
  const x = travel.x * drift * 40 + jump * 6;
  const y = travel.y * drift * 40;

  if (effect !== 'none' && effect !== undefined) {
    /**
     * A shader field instead of paper.
     *
     * The flat ground is the signature and it stays the default, but an essay
     * about a book with a colour of its own wants one -- and a field that is
     * already written, already GPU-cheap and already part of the house look is
     * a better answer than a photograph nobody has the rights to.
     */
    const palette = PALETTES[effect] ?? PALETTES['gradient'];
    return (
      <AbsoluteFill
        style={{
          /**
           * Transparent where there is a picture underneath, and blended the
           * way the effect actually behaves.
           *
           * Screen at 0.55 is what this was, and it did to the photograph
           * exactly what screen did to the storybook panels earlier: the
           * static shader outputs deliberately bright snow, so screening it
           * over an image adds that brightness everywhere and leaves a grey
           * blizzard with a picture somewhere inside it. Soft-light keeps the
           * grain and keeps the image, which is what "heavy static over a
           * photograph" is supposed to mean.
           */
          backgroundColor: hasPlate ? 'transparent' : (palette?.base ?? PALETTE.ink),
          mixBlendMode: hasPlate ? (effect === 'static' ? 'soft-light' : 'screen') : 'normal',
          /**
           * Scaled by the dial, and the two blends do not scale alike: screen
           * adds brightness everywhere it touches, so the same number that
           * reads as texture in soft-light reads as fog in screen. Half as
           * much of it keeps one control honest for both.
           */
          opacity: hasPlate ? strength * (effect === 'static' ? 1 : 0.56) : 1,
        }}
      >
        <ShaderField
          effect={effect}
          base={palette?.base ?? PALETTE.ink}
          colours={palette?.blobs ?? [PALETTE.oxblood, PALETTE.indigo, PALETTE.foxed]}
          seed={seedFor}
        />
        <AbsoluteFill
          style={{
            // A scrim, or type over a moving field is unreadable at any size.
            background:
              'linear-gradient(180deg, rgba(6,8,14,0.34) 0%, rgba(6,8,14,0.62) 100%)',
          }}
        />
      </AbsoluteFill>
    );
  }

  /**
   * A picture, and no field over it.
   *
   * This branch used to paint paper across the whole frame whatever was
   * underneath, so choosing pictures with the effect set to "none" produced a
   * video with no pictures in it -- the files were generated, paid for, timed,
   * and then covered up by a flat colour. Only the shader branch had ever been
   * taught about plates.
   *
   * What replaces the paper is a scrim weighted to the bottom, because that is
   * now where the narration lives. A subtitle over an unknown photograph needs
   * the frame darkened under it and nowhere else; darkening all of it evenly
   * would be a filter over somebody's picture, which is not the same thing and
   * looks like one.
   */
  if (hasPlate) {
    return (
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(6,8,14,0.30) 0%, rgba(6,8,14,0.04) 34%, ' +
            'rgba(6,8,14,0.10) 58%, rgba(6,8,14,0.66) 100%)',
        }}
      />
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: ground, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
          // A single rule of the accent, far off-centre. It is the only
          // furniture on the frame and it exists so the ground has a horizon
          // to move against -- a plain colour drifting is indistinguishable
          // from a plain colour holding still.
          background:
            `linear-gradient(${inverted ? 180 : 0}deg, ` +
            `${inverted ? PALETTE.ink : PALETTE.paper} 0%, ` +
            `${inverted ? '#1b1e26' : '#e7e0d2'} 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          transform: `translate3d(${x * 1.6}px, ${y * 1.6}px, 0)`,
          opacity: inverted ? 0.16 : 0.1,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: `${38 + travel.y * drift * 6}%`,
            height: 2,
            background: PALETTE[variation.emphasis],
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * One line, drawn the way its register and device say.
 *
 * The device is applied per word rather than per line for `thesis`, because
 * carving is a treatment of letterforms and applying it to a whole block makes
 * a panel rather than writing.
 */
const Words: React.FC<{
  line: Line;
  fps: number;
  frame: number;
  variation: Variation;
  inverted: boolean;
  onField: boolean;
  scale: number;
  look?: EssayLook;
}> = ({ line, fps, frame, variation, inverted, onField, scale, look = 'storybook' }) => {
  const words = line.text.split(/\s+/).filter(Boolean);
  const startFrame = (line.startMs / 1000) * fps;
  const since = frame - startFrame;

  /**
   * The claim, or a caption.
   *
   * Below this line the two are genuinely different jobs. A caption is read
   * past -- it wants to be legible, unremarkable, and in the same place every
   * time, because a viewer who has to find it is not listening. The claim is
   * looked at, and everything the style table and the device set can do is for
   * that. Applying the second to the first is how narration ended up outlined
   * and carved across the middle of the frame.
   */
  const punch = line.register === 'hot';
  const set = punch ? styleFor(line.captionStyle) : CAPTION_TYPE;
  const accent = PALETTE[variation.emphasis];
  /**
   * Over a shader field the type is always light; over paper it follows the
   * inversion. Reading the ground rather than assuming it is what lets the
   * same component serve both without a second copy.
   */
  const body = onField ? PALETTE.paper : inverted ? PALETTE.paper : PALETTE.ink;

  /**
   * Entry, per register.
   *
   * Hot has no easing on purpose. An eased slam is a fade, and the brief's
   * whole point about hot is that it arrives having already happened.
   */
  const entry =
    line.register === 'hot'
      ? interpolate(since, [0, 2], [0, 1], { extrapolateRight: 'clamp' })
      : line.register === 'cold'
        ? interpolate(since, [0, 18], [0, 1], {
            extrapolateRight: 'clamp',
            easing: Easing.out(Easing.cubic),
          })
        : interpolate(since, [0, 9], [0, 1], {
            extrapolateRight: 'clamp',
            easing: Easing.out(Easing.quad),
          });

  const slam = line.register === 'hot' ? interpolate(entry, [0, 1], [1.06, 1]) : 1;

  /**
   * The cinematic subtitle: clean, small, in the bar.
   *
   * Set in the letterbox, where a film puts them, so narration never sits on
   * the picture at all -- the image keeps the whole of the frame it was given
   * and the only type on it is the punch. The handwriting belongs to the
   * storybook look; here it would read as a scrapbook stuck to a film.
   */
  if (!punch && look === 'cinematic') {
    return (
      <div
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: Math.round(38 * scale),
          fontWeight: 500,
          letterSpacing: '0.012em',
          lineHeight: 1.28,
          color: '#ebe7de',
          maxWidth: '80%',
          textAlign: 'center',
          opacity: entry,
        }}
      >
        {words.map((word, i) => (
          <span
            key={`${line.startMs}-${i}`}
            style={{
              fontWeight: i === line.stressIndex ? 700 : 500,
              color: i === line.stressIndex ? '#ffffff' : '#ebe7de',
            }}
          >
            {word}
            {i < words.length - 1 ? ' ' : ''}
          </span>
        ))}
      </div>
    );
  }

  if (punch) {
    return (
      <Punch
        line={line}
        words={words}
        fontSize={Math.round(SIZE.hot * scale)}
        frame={frame}
        fps={fps}
        onField={onField}
      />
    );
  }

  return (
    <div
      style={{
        /**
         * The captions are handwritten; the title card stays set.
         *
         * A script face for narration is what the format actually looks like
         * -- it reads as somebody talking rather than as a document, and it is
         * the single most recognisable thing about the videos this is modelled
         * on. It is not used for the title, which is a printed thing on a
         * printed page and belongs in the serif.
         */
        fontFamily: HAND_FONT_FAMILY,
        fontSize: Math.round(SIZE[line.register] * scale),
        letterSpacing: `${set.tracking}em`,
        lineHeight: 1.32,
        maxWidth: punch ? '74%' : '82%',
        color: body,
        opacity: entry,
        transform: `scale(${slam})`,
        /**
         * One shadow, decided once.
         *
         * There were two `textShadow` keys in this object literal. The second
         * won, so the legibility shadow the narration was given never reached
         * a frame, and every caption over a moving field was fighting the
         * picture underneath it unaided.
         *
         * Lift is a drop shadow because that is literally what raising
         * something off a plane does. The band's shadow is a different thing
         * sharing the property name: a dark halo close to the letterforms,
         * which is what a subtitle has always used to stay readable over an
         * image it knows nothing about.
         */
        /**
         * A halo rather than a drop shadow where the letters are hollow.
         *
         * Four tight, un-offset shadows build a dark ring close to the
         * silhouette, which is what a transparent glyph needs in order to be
         * separable from whatever is showing through it. A soft offset shadow
         * cannot do that job: it darkens the area below the text and leaves
         * the letterform itself sitting on the picture.
         */
        textShadow: !onField
          ? '0 1px 2px rgba(20,22,28,0.20)'
          : punch && set.stroke
            /*
             * One tight shadow, not four.
             *
             * The four-layer halo was wrong in a way that is obvious once
             * rendered: a hollow glyph shows the picture through its middle,
             * so what makes it readable is the contrast of its stroke against
             * that picture -- and stacking dark shadows immediately outside a
             * light stroke surrounds the letter with the same darkness the
             * background already has, cancelling the only edge it had. Over
             * near-black inked art the light stroke is the whole mechanism;
             * the shadow just needs to stop it dissolving where the art goes
             * pale.
             */
            ? '0 0 4px rgba(0,0,0,0.75), 0 3px 14px rgba(0,0,0,0.7)'
            : '0 3px 16px rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,0.95)',
      }}
    >
      {words.map((word, i) => {
        const isStress = i === line.stressIndex;
        // Devices mark the claim. In the band they are all off, which is what
        // "plain" has to mean if it is to mean anything.
        const carved = punch && line.device === DEVICE.thesis;
        const struck = punch && line.device === DEVICE.counter;
        const lifted = punch && line.device === DEVICE.evidence;
        // A block of the accent behind the word the line turns on.
        const blocked = punch && set.emphasis === 'highlight' && isStress;
        // Both accents the signature allows are dark, so paper always reads
        // on them. No branch needed, and the one I wrote for a third accent
        // was dead: the variation only ever picks oxblood or indigo.
        const onBlock = PALETTE.paper;

        return (
          <span
            key={`${line.startMs}-${i}`}
            style={{
              // Two weights, ever. Emphasis past that is colour and scale.
              /**
               * A hollow serif has to be the heavy weight.
               *
               * -webkit-text-stroke centres the stroke on the outline, so on a
               * regular-weight serif the two sides of a 2px stroke meet across
               * the hairlines and the letterform comes apart into dashes. The
               * bold weight's thinnest stroke is wider than the outline, so it
               * stays a letter. Still two weights -- outline simply only ever
               * uses the second one.
               */
              fontWeight:
                punch && set.stroke
                  ? TYPE.bold
                  : isStress
                    ? set.emphasisWeight
                    : set.weight,
              /**
               * The accents are chosen against paper and only work there.
               *
               * Indigo on the flat ground is quiet and legible; indigo on a
               * dark shader field is near-black on near-black. So over a field
               * the roles keep their identity through a light tint rather than
               * their paper value -- the evidence still reads as a different
               * thing from the argument, which is all the colour is for.
               */
              color: blocked
                ? onBlock
                : lifted
                  ? (onField ? '#a9bde8' : PALETTE.indigo)
                  : carved || (isStress && punch)
                    ? (onField && variation.emphasis === 'indigo' ? '#a9bde8' : accent)
                    : struck
                      ? PALETTE.foxed
                      : body,
              ...(blocked
                ? {
                    backgroundColor: accent,
                    padding: '0.02em 0.16em 0.08em',
                    borderRadius: 4,
                  }
                : {}),
              textDecoration: struck ? 'line-through' : 'none',
              // Carving: the letterform sits in the plane rather than on it.
              /**
               * Outline is a caption style and carving is a device, and they
               * ask for the same property -- so the style wins where both
               * apply, because the style is what the viewer was told changes.
               */
              /**
               * A dark edge under a light fill, which is what a caption over
               * an unknown picture has always needed.
               *
               * `paintOrder: stroke fill` puts the stroke behind the letter,
               * so this thickens the silhouette rather than hollowing it --
               * the shadow alone cannot hold an edge against a bright patch of
               * illustration, and a script face has thin enough strokes to
               * disappear into one.
               *
               * The hollow outline is a different thing and stays exactly as
               * it was: it is the punch treatment, chosen deliberately, and it
               * fills with nothing on purpose.
               */
              /**
               * The edge, and the punch gets one too now.
               *
               * It did not, and over inked art that was the difference between
               * a claim and a smudge: the hollow treatment let the drawing
               * through the letterforms -- an anchor and its water texture ran
               * straight across "boats beating against the current" and broke
               * every word in it. Hollow is still hollow where it is chosen,
               * but it is now hollow inside a heavier light stroke sitting on
               * a dark halo, and every solid treatment gets the same dark edge
               * the narration has.
               */
              WebkitTextStroke: blocked
                ? undefined
                : punch && set.stroke
                  // Scaled to the type, so a hollow claim is as heavy at
                  // 1080p as it was designed to be at any other size.
                  ? `${Math.max(3, Math.round(SIZE[line.register] * scale * 0.075))}px ${
                      onField || inverted ? PALETTE.paper : PALETTE.ink
                    }`
                  : carved
                    ? `1px ${inverted ? PALETTE.paper : PALETTE.ink}`
                    : onField
                      ? `${Math.max(2, Math.round(SIZE[line.register] * scale * 0.05))}px rgba(14,15,20,0.92)`
                      : undefined,
              WebkitTextFillColor: punch && set.stroke ? 'transparent' : undefined,
              paintOrder: 'stroke fill',
              marginRight: '0.28em',
              display: 'inline-block',
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
};

/**
 * The punch, drawn exactly the way a short draws the same treatment.
 *
 * It was not. The essay had its own reading of each style, and for Outline
 * that reading was "hollow the whole line, in the handwriting" -- thin script
 * strokes with the picture showing through every letter, which is illegible
 * over any drawing. A short's Outline is something else entirely: the line is
 * solid, bold, upper case Inter, and only the one word the claim turns on is
 * hollow. Most of the line carries the reading; one word carries the
 * emphasis. That is why it works, and it is why a menu entry that looks good
 * in one format has to mean the same thing in the other.
 *
 * So this does not interpret the style tokens, it reuses the function shorts
 * use -- `emphasisStyle` from templates.tsx -- along with the same face,
 * casing, weights, tracking and ink. Two implementations of "Outline" is how
 * they came apart; one cannot.
 *
 * The narration stays handwritten. That contrast is the point of a punch:
 * the voice changes from somebody talking to something being stated.
 */
/**
 * The spring a short's words arrive on -- copied, not approximated, so the
 * punch in a long video lands with the same snap as the same caption style in
 * a short. Underdamped on purpose: the overshoot is the landing.
 */
const WORD_SPRING = { damping: 9, stiffness: 300, mass: 0.4 } as const;

const Punch: React.FC<{
  line: Line;
  words: string[];
  fontSize: number;
  frame: number;
  fps: number;
  onField: boolean;
}> = ({ line, words, fontSize, frame, fps, onField }) => {
  const style = STYLES[line.captionStyle] ?? STYLES['editorial']!;

  return (
    <div
      style={{
        fontFamily: FONT_FAMILY,
        fontSize,
        fontWeight: style.bodyWeight,
        letterSpacing: `${style.trackingEm}em`,
        lineHeight: 1.18,
        color: style.ink,
        maxWidth: '80%',
        /**
         * The one addition to a short's treatment, and it only matters on a
         * bright patch: a short sets its type on a dark ground it controls,
         * and an essay sets it on a drawing it does not. On the dark inked
         * art this is invisible; on a pale corner of it, it is the difference
         * between reading the claim and losing it.
         */
        textShadow: onField ? '0 2px 12px rgba(0,0,0,0.75), 0 0 3px rgba(0,0,0,0.6)' : 'none',
      }}
    >
      {words.map((word, i) => {
        /**
         * Word by word, on the voice.
         *
         * Each word appears at the moment it is spoken and springs in the way
         * a short's words do. Unsaid words still take their space -- they are
         * transparent, not absent -- so the line is laid out once and nothing
         * reflows as it fills in; a line that re-centres on every word is the
         * one thing that would make this look cheap.
         */
        const at = line.wordStarts?.[i] ?? line.startMs;
        const local = frame - (at / 1000) * fps;
        const land = local < 0 ? 0 : spring({ frame: local, fps, config: WORD_SPRING });
        return (
          <span
            key={`${line.startMs}-${i}`}
            style={{
              display: 'inline-block',
              marginRight: '0.26em',
              opacity: local < 0 ? 0 : 1,
              transform: `translateY(${(1 - land) * 0.45}em) scale(${0.72 + 0.28 * land})`,
              transformOrigin: 'bottom center',
              ...(i === line.stressIndex ? emphasisStyle(style, fontSize) : {}),
            }}
          >
            {cased(word, style)}
          </span>
        );
      })}
    </div>
  );
};

/**
 * The opening: the title, typed.
 *
 * Typed rather than faded because a fade is a transition and this is somebody
 * starting to write -- and because the channel is about books, where the words
 * arriving one at a time is the whole subject. The cursor blinks on its own
 * clock so it does not stop when the typing does.
 */
const Opening: React.FC<{ title: string; ms: number }> = ({ title, ms }) => {
  // Typed over the first two-thirds, held for the rest, gone on the last beat.
  const typeFor = LEAD_IN_MS * 0.62;
  const shown = Math.min(title.length, Math.floor((ms / typeFor) * title.length));
  const leaving = Math.max(0, Math.min(1, (ms - (LEAD_IN_MS - 700)) / 700));
  const blink = Math.floor(ms / 480) % 2 === 0;

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '9% 12%',
        opacity: 1 - leaving,
      }}
    >
      <div
        style={{
          fontFamily: SERIF_FONT_FAMILY,
          fontSize: 76,
          fontWeight: TYPE.regular,
          lineHeight: 1.28,
          textAlign: 'center',
          color: PALETTE.paper,
          textShadow: '0 2px 18px rgba(0,0,0,0.8)',
        }}
      >
        {title.slice(0, shown)}
        <span style={{ opacity: blink ? 1 : 0 }}>|</span>
      </div>
    </AbsoluteFill>
  );
};

export const Essay: React.FC<EssayProps> = ({
  lines,
  durationMs,
  variation,
  seed,
  effect,
  plates = [],
  cutouts = [],
  effectStrength = 0.5,
  captionScale = 1,
  title = '',
  look = 'storybook',
  grade = 'film',
  quotes = [],
  chapters = [],
  stickman = [],
  typewriter = true,
  stickFinish = 'cinematic',
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const ready = useInterFont();

  const ms = (frame / fps) * 1000;
  /**
   * While the book is being quoted the card is the caption: the same words,
   * as printed, lit as they are spoken. A subtitle or a punch under it would
   * say them a second time.
   */
  // A chapter card owns its moment: the narration has stopped for it, and a
  // caption or a quotation over it would be words from either side of the
  // pause sitting on the card that separates them.
  const chapter = chapterAt(chapters, ms);
  const quote = chapter === null ? quoteAt(quotes, ms) : null;
  const line = quote === null && chapter === null ? lineAt(lines, ms) : null;
  const progress = durationMs === 0 ? 0 : ms / durationMs;

  // Which cut inside a hot stretch we are on, so the ground can move with it.
  const cutIndex = line === null ? 0 : Math.floor((ms - line.startMs) / 1200);
  const inverted = line?.device === DEVICE.turn;

  if (!ready) return <AbsoluteFill style={{ backgroundColor: PALETTE.paper }} />;

  if (look === 'stickman') {
    /**
     * The stick figure's world fills the frame, one beat at a time.
     *
     * Plain: the words sit across the top where the world is darkened for
     * them -- the figure and the ground own the lower two thirds.
     *
     * Cinematic: the same world graded, grained and letterboxed, with the
     * narration read in the bottom bar as a subtitle. The world is lifted by
     * half a bar so the figure's feet stand above it rather than behind it;
     * what that uncovers at the bottom is under the bar anyway.
     */
    const cinema = stickFinish === 'cinematic';
    const bar = cinema ? barFraction(width, height) * 100 : 0;
    const hasEffect = effect !== undefined && effect !== 'none';
    return (
      <AbsoluteFill style={{ backgroundColor: '#0b0b10' }}>
        <AbsoluteFill style={cinema ? { transform: `translateY(${-Math.min(bar * 0.5, 8)}%)` } : {}}>
        {stickman.map((beat, index) => {
          const from = Math.round((beat.startMs / 1000) * fps);
          const duration = Math.max(1, Math.round((beat.endMs / 1000) * fps) - from);
          return (
            <Sequence key={beat.id} from={from} durationInFrames={duration} layout="none">
              <Stickman
                beat={beat}
                action={beat.action}
                seed={seed}
                durationInFrames={duration}
                direction={beat.stage}
                previousScene={index > 0 ? (stickman[index - 1]?.stage.background ?? stickman[index - 1]?.stage.scene ?? null) : null}
                orientation="landscape"
              />
            </Sequence>
          );
        })}
        </AbsoluteFill>
        {cinema ? <CinemaGrade flash={0} strength={grade === 'film' ? 0.6 : 0.35} /> : null}
        {hasEffect ? (
          <Ground
            register={line?.register ?? 'warm'}
            progress={progress}
            variation={variation}
            cutIndex={cutIndex}
            inverted={false}
            effect={effect}
            seedFor={seed}
            hasPlate
            strength={effectStrength}
          />
        ) : null}
        {cinema ? <Grain frame={frame} /> : null}
        {cinema ? <Letterbox ms={ms} /> : null}
        {quote === null ? null : <QuoteCardView quote={quote} ms={ms} />}
        {ms < LEAD_IN_MS || line === null ? null : (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              ...(cinema ? { bottom: 0, height: `${Math.max(bar, 12)}%` } : { top: 0, height: '30%' }),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: '0 8%',
            }}
          >
            <Words line={line} fps={fps} frame={frame} variation={variation} inverted={false} onField scale={captionScale} look="cinematic" />
          </div>
        )}
        {chapter === null ? null : <ChapterCardView card={chapter} ms={ms} typewriter={typewriter} />}
        {ms < LEAD_IN_MS && title.trim() !== '' ? <CinemaTitle title={title} ms={ms} typewriter={typewriter} /> : null}
      </AbsoluteFill>
    );
  }

  if (look === 'cinematic') {
    /**
     * Picture, grade and grain, then the bars, then type.
     *
     * Type goes over the bars because the narration lives in the bottom one;
     * the grade stays under the type because grading white captions tints
     * them, which reads as a mistake rather than a look.
     */
    const bar = barFraction(width, height) * 100;
    // Set into the picture: drawn inside the plate stack, and read in the bar.
    const behind = line !== null && line.behind === true && ms >= LEAD_IN_MS;
    const punch = line?.register === 'hot' && !behind;
    const hasEffect = effect !== undefined && effect !== 'none';
    /**
     * A punch sits under the effect when there is one, so the field washes
     * over the claim the way it washes over the picture: the words are in the
     * scene rather than pasted on the glass in front of it. The narration
     * stays on top, in its bar, because it has to be read in full.
     */
    const punchLayer =
      ms < LEAD_IN_MS || line === null || !punch ? null : (
          <AbsoluteFill
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              alignItems: 'center',
              textAlign: 'center',
              padding: `0 8% ${bar + 3.5}%`,
            }}
          >
            <Words
              line={line}
              fps={fps}
              frame={frame}
              variation={variation}
              inverted={false}
              onField
              scale={captionScale}
              look="cinematic"
            />
          </AbsoluteFill>
        );
    return (
      <AbsoluteFill style={{ backgroundColor: '#000' }}>
        <CinemaPlates
          plates={plates}
          ms={ms}
          fps={fps}
          grade={grade}
          {...(behind ? { behind: <BehindCaption line={line} frame={frame} fps={fps} /> } : {})}
        />
        {hasEffect ? punchLayer : null}
        {hasEffect ? (
          <Ground
            register={line?.register ?? 'warm'}
            progress={progress}
            variation={variation}
            cutIndex={cutIndex}
            inverted={false}
            effect={effect}
            seedFor={seed}
            hasPlate
            strength={effectStrength}
          />
        ) : null}
        <Grain frame={frame} />
        <Cutouts cutouts={cutouts} ms={ms} />
        <Letterbox ms={ms} />
        {quote === null ? null : <QuoteCardView quote={quote} ms={ms} />}
        {hasEffect ? null : punchLayer}
        {ms < LEAD_IN_MS || line === null || punch ? null : (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: `${bar}%`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            <Words
              // A claim in the scene is also said in the bar, as a subtitle:
              // the big words are half behind somebody, these can be read.
              line={behind ? { ...line, register: 'warm' } : line}
              fps={fps}
              frame={frame}
              variation={variation}
              inverted={false}
              onField
              scale={captionScale}
              look="cinematic"
            />
          </div>
        )}
        {chapter === null ? null : <ChapterCardView card={chapter} ms={ms} typewriter={typewriter} />}
        {ms < LEAD_IN_MS && title.trim() !== '' ? <CinemaTitle title={title} ms={ms} typewriter={typewriter} /> : null}
      </AbsoluteFill>
    );
  }


  const hasEffect = effect !== undefined && effect !== 'none';
  const hasPlateNow = plates.some((p) => ms >= p.startMs && ms < p.endMs);
  /**
   * With an effect on, a punch is drawn under it -- the field moves over the
   * claim as it does over the picture -- and the narration stays above it,
   * where it can always be read.
   */
  // Only over a picture: with none, the field is opaque and would hide the claim.
  const punchUnder = hasEffect && hasPlateNow && line?.register === 'hot';
  const typeLayer =
    ms < LEAD_IN_MS || line === null ? null : (
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          // Narration sits in the caption band; everything else gets the frame.
          /**
           * One padding, one alignment, no nudge.
           *
           * The variation still shifts the ground and picks the accent; it no
           * longer moves the subtitle. A caption that sits left in one video
           * and right in the next is not a composition, it is a caption
           * somebody has to hunt for.
           */
          padding: `6% 9% ${CAPTION_BOTTOM * 100}%`,
          ...PLACEMENT[line.register],
        }}
      >
        <Words
          line={line}
          fps={fps}
          frame={frame}
          variation={variation}
          inverted={inverted}
          onField={hasEffect || hasPlateNow}
          scale={captionScale}
        />
      </AbsoluteFill>
    );

  return (
    /**
     * Ink underneath everything.
     *
     * Over a picture the ground goes transparent so the picture shows, and
     * it decides that from the scene -- "a plate is scheduled now" -- not from
     * whether the picture actually arrived. When one did not, the transparent
     * ground showed whatever was beneath the whole composition, which was
     * nothing, which the browser paints white. A picture that failed to load
     * became a blank white frame with captions on it. Now it becomes the
     * signature's ink, which is at least the right colour to be wrong in.
     */
    <AbsoluteFill style={{ backgroundColor: PALETTE.ink }}>
      <Plates plates={plates} ms={ms} fps={fps} />
      {punchUnder ? typeLayer : null}
      <Ground
        register={line?.register ?? 'warm'}
        progress={progress}
        variation={variation}
        cutIndex={cutIndex}
        inverted={inverted}
        {...(effect !== undefined ? { effect } : {})}
        seedFor={seed}
        hasPlate={plates.some((p) => ms >= p.startMs && ms < p.endMs)}
        strength={effectStrength}
      />
      {/*
        Over the ground, under the type.

        Over the ground because the scrim exists to darken a photograph for
        legibility, and a cutting is not the photograph -- darkening it would
        undo the separation the hard edge just bought. Under the type because
        the argument is the video and a face is never allowed in front of it.
      */}
      <Cutouts cutouts={cutouts} ms={ms} />
      {quote === null ? null : <QuoteCardView quote={quote} ms={ms} />}
      {punchUnder ? null : typeLayer}
      {ms < LEAD_IN_MS ? <Opening title={title} ms={ms} /> : null}
    </AbsoluteFill>
  );
};
