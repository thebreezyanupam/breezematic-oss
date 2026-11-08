import { AbsoluteFill, Sequence, Solid, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { lightLeak } from '@remotion/effects/light-leak';
import {
  NO_GRAPHIC,
  OUTRO_MS,
  cueTime,
  SUBSCRIBE_TIMING,
  subscribeMoment,
  type TimedWord,
} from '../../explainer.js';
import { beatWords, isFootageFile, type Beat, type BeatSheet } from '../../schema.js';
import { Grain } from '../Grain.js';
import { Captions } from './Captions.js';
import { GraphicLayer, KeywordPunch, wantsPlate } from './graphics.js';
import { Media } from './Media.js';
import { SubscribePlug } from './Subscribe.js';
import { EX, msToFrame } from './theme.js';
import { moveAt, moveStyle, transitionsFor, type TransitionKind } from './transitions.js';

/**
 * The explainer: an edit, not a template.
 *
 * Each beat is three layers that move differently on purpose. The picture and
 * its graphic travel together through the transition, because they are the
 * shot; the captions do not, because a viewer is reading them and a caption
 * that whips off with the picture is a caption they lost their place in. Over
 * all of it sit the things that belong to the video rather than to any beat:
 * the progress line, the subscribe plug, the grain, and the close.
 *
 * The open and the close are the two moments a short is most often judged
 * on, so both are handled here rather than left to the cuts. The first frame
 * is a composed frame -- the picture, the hook already set -- punching in
 * from a lifted exposure, never a fade up from black. The last second is the
 * held moment after the final word: the captions clear, the music fades in the
 * mix, and the picture dips out over the closing frames instead of stopping
 * mid-move.
 */

/** Spoken words for a beat when the sheet predates written captions. */
function spreadLines(beat: Beat, spoken: readonly TimedWord[]): TimedWord[] {
  const written = beatWords(beat.lines);
  const inBeat = spoken.filter((word) => word.startMs >= beat.startMs && word.startMs < beat.endMs);
  if (inBeat.length === 0 || written.length === 0) return [];
  const first = inBeat[0]!.startMs;
  const last = inBeat[inBeat.length - 1]!.endMs;
  const step = (last - first) / written.length;
  return written.map((text, index) => ({
    text,
    startMs: Math.round(first + step * index),
    endMs: Math.round(first + step * (index + 1)),
  }));
}

const ExplainerBeat: React.FC<{
  beat: Beat;
  index: number;
  into: TransitionKind | 'open';
  outOf: TransitionKind | null;
  direction: 1 | -1;
  outDirection: 1 | -1;
  words: readonly TimedWord[];
  durationInFrames: number;
  fontFamily: string;
  kicker: string;
}> = ({ beat, index, into, outOf, direction, outDirection, words, durationInFrames, fontFamily, kicker }) => {
  const frame = useCurrentFrame();
  const graphic = beat.graphic ?? (index === 0 ? { ...NO_GRAPHIC, kind: 'headline' as const } : NO_GRAPHIC);
  const move = moveAt(frame, durationInFrames, into, outOf, direction, outDirection);
  // The opening punch is the picture's alone. Scaling the hook with it pushed
  // the first words off the left edge on frame 0 -- the one frame that has to
  // be perfect -- so the type arrives held and leaves with the cut.
  const typeMove = into === 'open' ? moveAt(frame, durationInFrames, 'held', outOf, direction, outDirection) : move;
  const displayWords = beatWords(beat.lines);
  const emphasis = beat.emphasisWordIndex === null ? null : (displayWords[beat.emphasisWordIndex] ?? null);
  // The camera punches in on the emphasis word, but only where the picture is
  // the subject: under a chart the push would shake the numbers.
  const plate = wantsPlate(graphic.kind);
  const emphasisMs = emphasis === null || plate || graphic.kind === 'headline' ? null : cueTime(emphasis, words, beat.startMs);
  const punchFrame = emphasisMs === null ? null : Math.round(msToFrame(emphasisMs - beat.startMs));
  const still = beat.background.image !== null && !isFootageFile(beat.background.image.file);
  // A still draws its own motion blur; only a sideways move keeps a little CSS blur for the smear.
  const mediaBlur = still ? (move.x !== 0 || move.y !== 0 ? 0.45 : 0) : 0;

  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: EX.ground }}>
      <AbsoluteFill style={moveStyle(move, mediaBlur)}>
        <Media
          beat={beat}
          durationInFrames={durationInFrames}
          treatment={plate ? 'plate' : 'sharp'}
          move={move}
          into={into}
          outOf={outOf}
          punchFrame={punchFrame}
        />
      </AbsoluteFill>
      <AbsoluteFill style={moveStyle(typeMove)}>
        <GraphicLayer
          graphic={graphic}
          words={words}
          beatStartMs={beat.startMs}
          beatEndMs={beat.endMs}
          durationInFrames={durationInFrames}
          fontFamily={fontFamily}
          emphasis={emphasis}
          kicker={kicker}
        />
        {graphic.kind === 'none' && punchFrame !== null && emphasis !== null && subscribeMoment(words) === null ? (
          <KeywordPunch
            word={emphasis}
            atFrame={punchFrame}
            durationInFrames={durationInFrames}
            side={index % 2 === 0 ? 'left' : 'right'}
            fontFamily={fontFamily}
          />
        ) : null}
      </AbsoluteFill>
      {move.flash > 0 ? <AbsoluteFill style={{ backgroundColor: '#ffffff', opacity: move.flash }} /> : null}
    </AbsoluteFill>
  );
};

/**
 * A light leak washing over a cut: the warm flare of film fogging at the
 * edge of a reel. Remotion's lightLeak, evolving over the first half of its
 * time and retracting over the second, laid on with screen so it only ever
 * adds light.
 */
const Leak: React.FC<{ seed: number; from?: number; strength?: number }> = ({ seed, from = 0, strength = 1 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ mixBlendMode: 'screen', pointerEvents: 'none', opacity: strength }}>
      <Solid
        width={width}
        height={height}
        effects={[
          lightLeak({
            seed,
            hueShift: 0,
            progress: interpolate(frame, [0, durationInFrames - 1], [from, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }),
        ]}
      />
    </AbsoluteFill>
  );
};

/** How long a leak plays across a cut, and how far before the cut it starts. */
const LEAK_FRAMES = 22;
const LEAK_LEAD = 9;

/** A hairline along the top that fills as the video plays: how long is left, at a glance. */
const Progress: React.FC<{ total: number }> = ({ total }) => {
  const frame = useCurrentFrame();
  const share = Math.min(1, frame / Math.max(1, total - 1));
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 10, background: 'rgba(255,255,255,0.14)' }}>
      <div style={{ width: `${share * 100}%`, height: '100%', background: EX.accent, boxShadow: `0 0 18px ${EX.accent}` }} />
    </div>
  );
};

/** The picture dipping out over the closing frames, after the last word has cleared. */
const Close: React.FC<{ total: number }> = ({ total }) => {
  const frame = useCurrentFrame();
  const dip = interpolate(frame, [total - 10, total - 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (dip <= 0) return null;
  return <AbsoluteFill style={{ backgroundColor: EX.ground, opacity: dip }} />;
};

export const ExplainerVideo: React.FC<{ sheet: BeatSheet; fontFamily: string }> = ({ sheet, fontFamily }) => {
  const total = Math.max(1, Math.round(msToFrame(sheet.meta.durationMs)));
  const transitions = transitionsFor(sheet.meta.seed, sheet.beats.map((beat) => beat.id));
  const captionsOf = (beat: Beat): TimedWord[] => beat.captions ?? spreadLines(beat, sheet.words);
  const allCaptions = sheet.beats.flatMap(captionsOf);
  const plugAt = subscribeMoment(allCaptions);
  const lastWordMs = sheet.words[sheet.words.length - 1]?.endMs ?? sheet.meta.durationMs;
  // The captions clear a moment after the last word, only when there is a tail to clear into.
  const fadeAt = sheet.meta.durationMs - lastWordMs >= OUTRO_MS * 0.5 ? lastWordMs + 250 : null;
  const scale = sheet.meta.captionScale;
  const showCaptions = sheet.meta.subtitles !== 'none';
  const captionScale = sheet.meta.subtitles === 'minimal' ? scale * 0.78 : scale;
  // The tag over the hook: the same word on every video, like the plug.
  const kicker = 'explained';

  return (
    <AbsoluteFill style={{ backgroundColor: EX.ground }}>
      {sheet.beats.map((beat, index) => {
        const from = Math.round(msToFrame(beat.startMs));
        const duration = Math.max(1, Math.round(msToFrame(beat.endMs)) - from);
        const words = captionsOf(beat);
        const direction: 1 | -1 = index % 2 === 0 ? 1 : -1;
        const isLast = index === sheet.beats.length - 1;
        return (
          <Sequence key={beat.id} from={from} durationInFrames={duration} name={beat.id}>
            <ExplainerBeat
              beat={beat}
              index={index}
              into={index === 0 ? 'open' : (transitions[index] ?? 'zoom')}
              outOf={isLast ? null : (transitions[index + 1] ?? 'zoom')}
              direction={direction}
              outDirection={direction === 1 ? -1 : 1}
              words={words}
              durationInFrames={duration}
              fontFamily={fontFamily}
              kicker={kicker}
            />
            {showCaptions && beat.graphic?.kind !== 'headline' && !(index === 0 && beat.graphic === null) ? (
              <Captions
                words={words}
                beatStartMs={beat.startMs}
                beatEndMs={beat.endMs}
                scale={captionScale}
                fontFamily={fontFamily}
                fadeAtMs={isLast ? fadeAt : null}
              />
            ) : null}
          </Sequence>
        );
      })}
      {/*
        Leaks on the open and on about one cut in three -- often enough to be
        part of the look, rarely enough that each one is an event. Never
        over the subscribe card, which has to read cleanly.
      */}
      <Sequence from={0} durationInFrames={LEAK_FRAMES} name="leak-open">
        {/* Already retracting on frame 0, and lighter: it warms the hook, never covers it. */}
        <Leak seed={sheet.meta.seed % 97} from={0.55} strength={0.55} />
      </Sequence>
      {sheet.beats.map((beat, index) => {
        if (index === 0 || index % 3 !== 1) return null;
        const cut = Math.round(msToFrame(beat.startMs));
        if (plugAt !== null && Math.abs(beat.startMs - plugAt) < 2_500) return null;
        return (
          <Sequence key={`leak-${beat.id}`} from={Math.max(0, cut - LEAK_LEAD)} durationInFrames={LEAK_FRAMES} name={`leak-${beat.id}`}>
            <Leak seed={(sheet.meta.seed + index * 13) % 97} />
          </Sequence>
        );
      })}
      {plugAt === null ? null : (
        <Sequence
          from={Math.max(0, Math.round(msToFrame(plugAt - SUBSCRIBE_TIMING.leadMs)))}
          durationInFrames={Math.round(msToFrame(SUBSCRIBE_TIMING.leadMs + SUBSCRIBE_TIMING.holdMs)) + 1}
          name="subscribe"
        >
          <SubscribePlug fontFamily={fontFamily} channel={sheet.meta.channel ?? 'Subscribe for more'} />
        </Sequence>
      )}
      <Progress total={total} />
      <Grain opacity={0.06} />
      <Close total={total} />
    </AbsoluteFill>
  );
};
