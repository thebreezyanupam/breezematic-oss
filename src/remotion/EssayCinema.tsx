import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  staticFile,
  useVideoConfig,
} from 'remotion';
import { FONT_FAMILY, MONO_FONT_FAMILY, SERIF_FONT_FAMILY } from './font.js';
import { CinemaGrade } from './CinemaGrade.js';
import {
  BEHIND_BAND,
  CHAPTER_CARD_MS,
  LEAD_IN_MS,
  type ChapterCard,
  type EssayGrade,
  type Line,
  type Plate,
  type QuoteCard,
} from '../stages/compose.js';
import { cutAccents, rolls } from './cinemaCuts.js';
import { titleKeystrokes } from './titleType.js';
import { DepthPlate, type Parallax } from './DepthPlate.js';

/**
 * The cinematic look for the long essays.
 *
 * Shorts already had a cinema mode -- the snap on every cut, the recut jump,
 * the flashes, the teal-and-amber grade -- and the essays had none of it: a
 * picture faded in, crept forward seven per cent, and faded out, which is a
 * slideshow with a voice over it. This is the same language, re-timed for
 * landscape pictures held seven seconds apiece, plus the three things that say
 * "film" before anything else does: a letterbox, grain, and a title card that
 * behaves like one.
 *
 * Every value is derived from the plate's file name and the frame, so a
 * re-render is identical and nothing here needs state.
 */

/** Scope. The bars are what a viewer reads as "film" before anything else. */
export const CINEMA_ASPECT = 2.39;

/** How much of the frame height one bar takes, at a given composition size. */
export function barFraction(width: number, height: number): number {
  return Math.max(0, (height - width / CINEMA_ASPECT) / 2 / height);
}

/**
 * One plate's camera at one moment.
 *
 *   drift   the slow move the whole shot makes -- push in, pull out, or pan --
 *           because a still that holds dead for seven seconds reads as a slide
 *   snap    every cut lands slightly tight and settles, so it arrives with
 *           momentum instead of simply appearing
 *   recut   on some long shots, a jump tighter on the same picture halfway
 *           through: the most recognisable trailer move there is, and the
 *           reason a seven-second still does not feel like seven seconds
 */
function camera(plate: Plate, ms: number, fps: number) {
  const held = Math.max(1, plate.endMs - plate.startMs);
  // Shared with the sound mix, so a flash always has its whoosh.
  const { move, flashes, leaks, recuts } = cutAccents(plate.file, held);

  const since = ms - plate.startMs;
  const into = Math.min(1, Math.max(0, since / held));
  const drift = Easing.inOut(Easing.sin)(into);

  let scale = move === 'push' ? 1.07 + 0.09 * drift : move === 'pull' ? 1.16 - 0.09 * drift : 1.13;
  const x = move === 'left' ? 3.2 - 6.4 * drift : move === 'right' ? -3.2 + 6.4 * drift : 0;

  const sinceFrames = (since / 1000) * fps;
  const snap = interpolate(sinceFrames, [0, 9], [1.075, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  scale *= snap;

  const recutMs = held * 0.55;
  const afterRecut = recuts && since >= recutMs;
  if (afterRecut) {
    const f = ((since - recutMs) / 1000) * fps;
    scale *= interpolate(f, [0, 22], [1.18, 1.13], {
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.cubic),
    });
  }

  // A flash belongs on a join, so the recut can carry one as well as the cut.
  const joinFrames = afterRecut ? ((since - recutMs) / 1000) * fps : sinceFrames;
  const flash = flashes && joinFrames < 3 ? interpolate(joinFrames, [0, 3], [0.34, 0]) : 0;

  // A warm leak drifting across the cut: the second most copied move in the
  // format after the snap zoom, and the one that gives a still some light.
  const leak =
    leaks && since < 900 ? Math.sin((Math.max(0, since) / 900) * Math.PI) * 0.55 : 0;
  const leakX = interpolate(since, [0, 900], [-30, 130], { extrapolateRight: 'clamp' });

  /**
   * The same move, in depth: what the near part of the picture does that the
   * far part does not. A pan carries the foreground further than the wall
   * behind it; a push brings the near surfaces on faster than the far ones,
   * which is the difference between a dolly and a zoom. Amounts are small on
   * purpose -- past about four per cent of the width the shader has to invent
   * what was behind the subject, and invented background is the one thing
   * that gives this effect away.
   */
  const lateral = 0.07;
  const dolly = 0.16;
  const parallax: Parallax = {
    shift: [
      move === 'left' ? lateral * (0.5 - drift) : move === 'right' ? lateral * (drift - 0.5) : 0,
      0,
    ],
    zoom: move === 'push' ? dolly * drift : move === 'pull' ? dolly * (1 - drift) : 0,
  };

  return { scale, x, flash, leak, leakX, parallax };
}

/**
 * The pictures, cut rather than dissolved.
 *
 * The storybook look crossfades so a picture changes without fighting type
 * that is not changing with it. Here the cut is the point: hard, on the
 * snap, sometimes with a flash. A dissolve is the one transition that makes an
 * edit look amateur in this style.
 */
export const CinemaPlates: React.FC<{
  plates: readonly Plate[];
  ms: number;
  fps: number;
  grade?: EssayGrade;
  /**
   * A caption set into the picture: drawn over the plate, then the plate's
   * near layer is drawn back over it -- all under the grade, so the words are
   * lit and toned like everything else in the shot.
   */
  behind?: React.ReactNode;
}> = ({ plates, ms, fps, grade = 'film', behind }) => {
  const plate = plates.find((p) => ms >= p.startMs && ms < p.endMs) ?? null;
  if (plate === null) return null;
  const shot = camera(plate, ms, fps);

  const style: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transform: `translateX(${shot.x}%) scale(${shot.scale})`,
    // A touch more contrast and a touch less saturation: the grade does the
    // colour, this does the density a film stock has and a render does not.
    // A painting keeps its own saturation; only the density is added.
    filter:
      grade === 'film'
        ? 'contrast(1.1) saturate(0.88) brightness(0.96)'
        : 'contrast(1.05) saturate(0.98) brightness(0.98)',
  };

  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      {plate.motion ? (
        <OffthreadVideo src={staticFile(`images/${plate.file}`)} startFrom={0} muted style={style} />
      ) : plate.depth !== undefined ? (
        <DepthPlate
          key={plate.file}
          src={staticFile(`images/${plate.file}`)}
          depthSrc={staticFile(`images/${plate.depth}`)}
          parallax={shot.parallax}
          style={style}
        />
      ) : (
        <Img src={staticFile(`images/${plate.file}`)} style={style} />
      )}
      {behind !== undefined && behind !== null ? (
        <>
          {/* Moved with the picture, so the words hold still in the scene. */}
          <AbsoluteFill style={{ transform: style.transform }}>{behind}</AbsoluteFill>
          {plate.depth !== undefined && plate.matte !== undefined && !plate.motion ? (
            <DepthPlate
              key={`${plate.file}-front`}
              src={staticFile(`images/${plate.file}`)}
              depthSrc={staticFile(`images/${plate.depth}`)}
              parallax={shot.parallax}
              style={{ ...style, position: 'absolute', inset: 0 }}
              front={plate.matte}
            />
          ) : null}
        </>
      ) : null}
      {shot.leak > 0 ? (
        <AbsoluteFill
          style={{
            background:
              `radial-gradient(ellipse 45% 90% at ${shot.leakX}% 40%, ` +
              'rgba(255,150,60,0.95) 0%, rgba(255,90,30,0.45) 40%, rgba(255,60,20,0) 75%)',
            mixBlendMode: 'screen',
            opacity: shot.leak,
          }}
        />
      ) : null}
      <CinemaGrade flash={shot.flash} strength={grade === 'film' ? 1 : 0.4} />
    </AbsoluteFill>
  );
};

/**
 * Film grain, moving.
 *
 * A still grain pattern is a dirty lens; grain that changes every frame is
 * film. One texture, jittered by the frame number, so it costs a single image
 * load rather than a noise pass per frame -- an SVG turbulence filter over a
 * 1080p frame is measurably the slowest thing a render can be asked to do.
 */
export const Grain: React.FC<{ frame: number }> = ({ frame }) => {
  const roll = rolls(`grain-${frame}`);
  const x = (roll() - 0.5) * 6;
  const y = (roll() - 0.5) * 6;
  return (
    <AbsoluteFill style={{ overflow: 'hidden', pointerEvents: 'none' }}>
      <Img
        src={staticFile('cinema/grain.png')}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `translate(${x}%, ${y}%) scale(1.12)`,
          mixBlendMode: 'overlay',
          opacity: 0.16,
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * A punch set into the scene, behind its subject.
 *
 * Big, heavy capitals in the band across the upper middle of the frame, where
 * the depth analysis checked there is something near to pass behind. Each word
 * lands when it is spoken, on the same spring a short's words use, so it is the
 * same punch in a different place rather than a new kind of title.
 *
 * Laid out as at most two balanced lines at a size worked out from the longest
 * of them, never wrapped by the browser: a line that re-wraps as words arrive
 * is the thing that would make this look cheap, and a size chosen per line
 * keeps a three-word claim huge and a seven-word one still on two lines.
 */
const BEHIND_SPRING = { damping: 11, stiffness: 260, mass: 0.5 } as const;

export const BehindCaption: React.FC<{ line: Line; frame: number; fps: number }> = ({ line, frame, fps }) => {
  const { width, height } = useVideoConfig();
  const words = line.text.split(/\s+/).filter(Boolean);

  // Two lines when it is long enough to need them, split where they balance.
  let split = words.length;
  if (line.text.length > 16 && words.length > 1) {
    let best = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ').length;
      const b = words.slice(i).join(' ').length;
      if (Math.abs(a - b) < best) {
        best = Math.abs(a - b);
        split = i;
      }
    }
  }
  const rows = split === words.length ? [words] : [words.slice(0, split), words.slice(split)];
  const longest = Math.max(...rows.map((row) => row.join(' ').length));

  const bandWidth = width * (BEHIND_BAND.right - BEHIND_BAND.left);
  const bandHeight = height * (BEHIND_BAND.bottom - BEHIND_BAND.top);
  /**
   * Inter capitals at weight 800 run about 0.76em a character -- measured off
   * a render, where 0.68 put a thirteen-letter line past the edge of the band.
   * And the words ride the camera: they take the plate's own transform, which
   * pushes in by as much as a fifth, so the line is sized for the frame it
   * will be scaled up into rather than the one it is laid out in.
   */
  const CAMERA_MAX = 1.2;
  const fontSize = Math.round(
    Math.min(
      bandWidth / (0.76 * Math.max(1, longest) * CAMERA_MAX),
      ((bandHeight / rows.length) * 0.92) / CAMERA_MAX,
      height * 0.2,
    ),
  );

  const lineStart = (line.startMs / 1000) * fps;
  const leaving = interpolate(frame, [((line.endMs - 260) / 1000) * fps, (line.endMs / 1000) * fps], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  let index = 0;
  return (
    <div
      style={{
        position: 'absolute',
        left: `${BEHIND_BAND.left * 100}%`,
        right: `${(1 - BEHIND_BAND.right) * 100}%`,
        top: `${BEHIND_BAND.top * 100}%`,
        bottom: `${(1 - BEHIND_BAND.bottom) * 100}%`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT_FAMILY,
        fontWeight: 800,
        fontSize,
        lineHeight: 0.96,
        letterSpacing: '-0.02em',
        textTransform: 'uppercase',
        color: '#f3eee4',
        opacity: frame < lineStart ? 0 : leaving,
        // Soft, wide and faint: enough to hold the letters off a pale sky,
        // not a drop shadow, which would put them on a sheet in front of it.
        textShadow: '0 6px 40px rgba(0,0,0,0.35)',
      }}
    >
      {rows.map((row, r) => (
        <div key={r} style={{ whiteSpace: 'nowrap' }}>
          {row.map((word) => {
            const i = index++;
            const at = line.wordStarts?.[i] ?? line.startMs;
            const local = frame - (at / 1000) * fps;
            const land = local < 0 ? 0 : spring({ frame: local, fps, config: BEHIND_SPRING });
            return (
              <span
                key={i}
                style={{
                  display: 'inline-block',
                  marginRight: i === words.length - 1 ? 0 : '0.22em',
                  opacity: local < 0 ? 0 : 1,
                  transform: `translateY(${(1 - land) * 0.3}em) scale(${0.9 + 0.1 * land})`,
                  transformOrigin: 'bottom center',
                  color: i === line.stressIndex ? '#e8b86a' : undefined,
                }}
              >
                {word}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

/* --------------------------------------------------------------- chapters -- */

const NUMERALS = [
  'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX',
  'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE',
];

/** The chapter whose card is on screen at this moment, if any. */
export function chapterAt(chapters: readonly ChapterCard[], ms: number): ChapterCard | null {
  return chapters.find((card) => ms >= card.atMs && ms < card.atMs + CHAPTER_CARD_MS) ?? null;
}

/**
 * The chapter card: everything stops, the number and the name are typed, the
 * essay carries on.
 *
 * The same typewriter as the opening title -- the same keystroke timing, the
 * same block cursor, the same keys under it in the mix -- because a second
 * way of typing on screen in one video is two ideas where there was one. What
 * separates it from the title is the scrim it sits on and the number above
 * it: a title names the video, a chapter card says where you are in it.
 */
export const ChapterCardView: React.FC<{ card: ChapterCard; ms: number; typewriter?: boolean }> = ({
  card,
  ms,
  typewriter = true,
}) => {
  const since = ms - card.atMs;
  const strokes = titleKeystrokes(card.title);
  const chars = [...card.title];
  // Untyped, the whole name is there from the first frame and the card's own
  // fade brings it in.
  const typed = typewriter ? strokes.filter((stroke) => stroke.atMs <= since).length : chars.length;
  const done = typed >= chars.length;
  const lastStroke = strokes[strokes.length - 1]?.atMs ?? 0;
  const cursorOn = typewriter && (!done || Math.floor((since - lastStroke) / 420) % 2 === 1);

  const enter = interpolate(since, [0, 320], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const leave = interpolate(since, [CHAPTER_CARD_MS - 420, CHAPTER_CARD_MS], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const number = interpolate(since, [120, 520], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const cursor = (
    <span
      style={{
        display: 'inline-block',
        width: '0.55em',
        height: '0.95em',
        marginLeft: '0.06em',
        marginRight: '-0.61em',
        verticalAlign: '-0.12em',
        backgroundColor: '#e8b86a',
        opacity: cursorOn ? 0.95 : 0,
        boxShadow: '0 0 14px rgba(232,184,106,0.55)',
      }}
    />
  );

  return (
    <AbsoluteFill style={{ opacity: enter * leave, pointerEvents: 'none' }}>
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse 70% 55% at 50% 50%, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.6) 60%, rgba(0,0,0,0.4) 100%)',
        }}
      />
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 12%',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontFamily: MONO_FONT_FAMILY,
            fontWeight: 500,
            fontSize: 20,
            letterSpacing: '0.34em',
            textTransform: 'uppercase',
            color: '#e8b86a',
            opacity: 0.9 * number,
            marginBottom: 26,
            // The tracking is on the right of the last letter too; this takes
            // it back so the line is actually centred.
            marginRight: '-0.34em',
          }}
        >
          {`Chapter ${NUMERALS[card.index - 1] ?? card.index}`}
        </div>
        <div
          style={{
            fontFamily: MONO_FONT_FAMILY,
            fontWeight: 500,
            fontSize: 46,
            lineHeight: 1.36,
            letterSpacing: '0.02em',
            color: '#f1ede4',
            textShadow: '0 0 22px rgba(0,0,0,0.75)',
          }}
        >
          {chars.map((char, i) => (
            <React.Fragment key={i}>
              <span style={{ visibility: i < typed ? 'visible' : 'hidden' }}>{char}</span>
              {i === typed - 1 ? cursor : null}
            </React.Fragment>
          ))}
          {typed === 0 ? cursor : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * The bars, which arrive rather than being there.
 *
 * Sliding in over the first second is the move every "cinematic edit" opens
 * on, and it tells a viewer what kind of video this is before the first word.
 */
export const Letterbox: React.FC<{ ms: number }> = ({ ms }) => {
  const { width, height } = useVideoConfig();
  const full = barFraction(width, height) * 100;
  const size =
    full *
    interpolate(ms, [150, 1100], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.cubic),
    });
  const bar: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    height: `${size}%`,
    backgroundColor: '#000',
  };
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ ...bar, top: 0 }} />
      <div style={{ ...bar, bottom: 0 }} />
    </AbsoluteFill>
  );
};

/**
 * The title card, typed.
 *
 * A modern typewriter: a monospaced face at one fixed size, each letter struck
 * into place with a key sound under it (the timing is shared with the mix in
 * titleType.ts), and a block cursor that stays solid while typing and blinks
 * once the line is done.
 *
 * It used to fade in with wide tracking that closed up -- the trailer title --
 * and on screen that read as the title shrinking. Nothing here scales or
 * re-spaces: the whole title is laid out from the first frame with the letters
 * not yet typed held invisible, so a new letter never moves the ones before it
 * and a centred line does not creep sideways as it grows.
 */
export const CinemaTitle: React.FC<{ title: string; ms: number; typewriter?: boolean }> = ({
  title,
  ms,
  typewriter = true,
}) => {
  const chars = [...title];
  const strokes = titleKeystrokes(title);
  const typed = typewriter ? strokes.filter((stroke) => stroke.atMs <= ms).length : chars.length;
  const done = typed >= chars.length;
  const lastStroke = strokes[strokes.length - 1]?.atMs ?? 0;
  // Solid while keys are landing, blinking from the moment they stop.
  const cursorOn = typewriter && (!done || Math.floor((ms - lastStroke) / 420) % 2 === 1);
  // Not typed: the title fades in whole as the bars arrive.
  const fadeIn = typewriter
    ? 1
    : interpolate(ms, [250, 800], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const leave = interpolate(ms, [LEAD_IN_MS - 600, LEAD_IN_MS - 120], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Inline, sitting on the text's own line, and taking no width: the negative
  // margin cancels its advance, so the letters never shift to make room for it.
  const cursor = (
    <span
      style={{
        display: 'inline-block',
        width: '0.55em',
        height: '0.95em',
        marginLeft: '0.06em',
        marginRight: '-0.61em',
        verticalAlign: '-0.12em',
        backgroundColor: '#e8b86a',
        opacity: cursorOn ? 0.95 : 0,
        boxShadow: '0 0 14px rgba(232,184,106,0.55)',
      }}
    />
  );

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 12%',
        opacity: (1 - leave) * fadeIn,
        // A soft pool of shadow behind the line, so the type reads over
        // whatever the first picture happens to be.
        background:
          'radial-gradient(ellipse 60% 38% at 50% 50%, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 55%, rgba(0,0,0,0) 100%)',
      }}
    >
      <div
        style={{
          fontFamily: MONO_FONT_FAMILY,
          fontWeight: 500,
          fontSize: 54,
          lineHeight: 1.4,
          letterSpacing: '0.02em',
          textAlign: 'center',
          color: '#f1ede4',
          textShadow: '0 0 22px rgba(0,0,0,0.7)',
        }}
      >
        {chars.map((char, i) => (
          <React.Fragment key={i}>
            <span style={{ visibility: i < typed ? 'visible' : 'hidden' }}>{char}</span>
            {i === typed - 1 ? cursor : null}
          </React.Fragment>
        ))}
        {typed === 0 ? cursor : null}
      </div>
    </AbsoluteFill>
  );
};

/* ----------------------------------------------------------------- quotes -- */

/** The card arrives a beat before the first quoted word and stays after the last. */
const QUOTE_LEAD_MS = 380;
const QUOTE_HOLD_MS = 1_300;

/** The quotation on screen at this moment, if any. */
export function quoteAt(quotes: readonly QuoteCard[], ms: number): QuoteCard | null {
  return (
    quotes.find(
      (quote) => ms >= quote.speakStartMs - QUOTE_LEAD_MS && ms < quote.speakEndMs + QUOTE_HOLD_MS,
    ) ?? null
  );
}

/**
 * The book's own words, as printed, while the narration says them.
 *
 * Each word lights as it is spoken -- the reveal is timed to the aligned
 * voice, so the eye and the ear arrive together -- and the rest wait dimmed,
 * so the whole line can be read ahead. Set in the serif, because it is the
 * book talking; attributed in the typewriter face of the title, because it is
 * the video pointing at the book.
 */
export const QuoteCardView: React.FC<{ quote: QuoteCard; ms: number }> = ({ quote, ms }) => {
  const shownFrom = quote.speakStartMs - QUOTE_LEAD_MS;
  const shownUntil = quote.speakEndMs + QUOTE_HOLD_MS;
  const enter = interpolate(ms, [shownFrom, shownFrom + 380], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const exit = interpolate(ms, [shownUntil - 420, shownUntil], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const presence = enter * exit;

  const words = quote.text.split(/\s+/);
  const spoken = Math.max(
    0,
    Math.min(1, (ms - quote.speakStartMs) / Math.max(1, quote.speakEndMs - quote.speakStartMs)),
  );
  const lit = Math.ceil(spoken * words.length - 0.001);
  const size = words.length <= 14 ? 50 : words.length <= 26 ? 42 : 35;
  const credit = interpolate(ms, [shownFrom + 350, shownFrom + 900], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ opacity: presence, pointerEvents: 'none' }}>
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse 75% 70% at 50% 50%, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.5) 60%, rgba(0,0,0,0.35) 100%)',
        }}
      />
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 14%',
          transform: `translateY(${(1 - enter) * 14}px)`,
          filter: `blur(${(1 - enter) * 5}px)`,
        }}
      >
        <div
          style={{
            fontFamily: SERIF_FONT_FAMILY,
            fontWeight: 700,
            fontSize: 132,
            lineHeight: 0.62,
            height: 56,
            color: '#e8b86a',
            opacity: 0.9,
          }}
        >
          {'\u201C'}
        </div>
        <div
          style={{
            fontFamily: SERIF_FONT_FAMILY,
            fontWeight: 400,
            fontSize: size,
            lineHeight: 1.36,
            textAlign: 'center',
            color: '#f1ede4',
            textShadow: '0 2px 18px rgba(0,0,0,0.7)',
            textWrap: 'balance',
          }}
        >
          {words.map((word, i) => (
            <span key={i} style={{ opacity: i < lit ? 1 : 0.3 }}>
              {word}
              {i < words.length - 1 ? ' ' : ''}
            </span>
          ))}
        </div>
        <div
          style={{
            marginTop: 30,
            fontFamily: MONO_FONT_FAMILY,
            fontWeight: 500,
            fontSize: 20,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: '#e8b86a',
            opacity: 0.85 * credit,
          }}
        >
          {`\u2014 ${quote.attribution}`}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
