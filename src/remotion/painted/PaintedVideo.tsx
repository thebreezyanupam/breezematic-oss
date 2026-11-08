import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { RENDER } from '../../design.js';
import { paintSeconds } from '../../painted.js';
import type { BeatSheet } from '../../schema.js';
import { HAND_FONT_FAMILY } from '../font.js';
import { PAPER } from './engine.js';
import { PaintedCanvas } from './PaintedCanvas.js';

/**
 * The painted mode: a storybook that paints itself while it is read.
 *
 * Each beat is a scene (beat.paint) painted live by p5.brush -- washes bloom
 * in, the ink is drawn, the shadow is hatched -- and paced to the read: the
 * painting is done well before the beat ends, so the finished picture is on
 * screen while the line lands. The words are written underneath in a hand,
 * each one appearing as it is said, with the word being spoken in ink and the
 * rest in pencil.
 *
 * Between beats the camera breathes: a slow push on every scene, and the next
 * scene comes up over the last one rather than from blank paper, so a cut
 * reads as a page of the same book.
 */

const FADE_FRAMES = 7;
const INK = '#1f1a17';

const Grain: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: 'none',
      mixBlendMode: 'multiply',
      opacity: 0.35,
      backgroundImage:
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='p'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.45 0 0 0 0 0.38 0 0 0 0 0.3 0 0 0 0.55 0'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23p)'/%3E%3C/svg%3E\")",
    }}
  />
);

const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{ pointerEvents: 'none', background: 'radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 58%, rgba(60,40,20,0.28) 100%)' }}
  />
);

/** The line being read, written out word by word under the painting. */
const Words: React.FC<{ words: readonly { text: string; startMs: number; endMs: number }[]; beatStartMs: number; captionScale: number }> = ({
  words,
  beatStartMs,
  captionScale,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = beatStartMs + (frame / fps) * 1000;
  const size = Math.round(78 * captionScale);
  return (
    <div
      style={{
        position: 'absolute', left: 60, right: 60, bottom: 120,
        display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: `0 ${Math.round(size * 0.28)}px`,
        fontFamily: HAND_FONT_FAMILY, fontWeight: 700, fontSize: size, lineHeight: 1.05, textAlign: 'center',
      }}
    >
      {words.map((word, index) => {
        const said = nowMs >= word.startMs;
        const speaking = said && nowMs < word.endMs + 120;
        const t = interpolate(nowMs, [word.startMs - 40, word.startMs + 160], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <span
            key={index}
            style={{
              // Said words stay in ink; the one being said is in the red of the margin.
              color: speaking ? '#8a2f1d' : INK,
              opacity: t,
              transform: `translateY(${(1 - t) * 10}px) rotate(${((index * 37) % 7) - 3}deg)`,
              display: 'inline-block',
              // The paper shows through ink; a soft halo keeps it readable over paint.
              textShadow: `0 0 22px ${PAPER}, 0 0 12px ${PAPER}, 0 0 5px ${PAPER}, 0 0 2px ${PAPER}`,
            }}
          >
            {word.text}
          </span>
        );
      })}
    </div>
  );
};

const PaintedBeat: React.FC<{
  sheet: BeatSheet;
  index: number;
  durationInFrames: number;
}> = ({ sheet, index, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beat = sheet.beats[index]!;
  const scene = beat.paint;
  const seconds = durationInFrames / fps;
  // A head start of a few frames, so a beat never opens on blank paper.
  // The opening beat starts further in still: the first frame is the hook.
  const total = paintSeconds(seconds);
  const progress = Math.min(1, (frame / fps + (index === 0 ? total * 0.45 : 0.18)) / total);
  const push = interpolate(frame, [0, durationInFrames], [1.0, 1.045]);
  const fadeIn = index === 0 ? 1 : interpolate(frame, [0, FADE_FRAMES], [0, 1], { extrapolateRight: 'clamp' });
  const captionScale = sheet.meta.captionScale;
  const words =
    beat.captions ??
    beat.lines.flatMap((line) => line.text.split(/\s+/)).map((text) => ({ text, startMs: beat.startMs, endMs: beat.endMs }));
  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <AbsoluteFill style={{ transform: `scale(${push})`, backgroundColor: PAPER }}>
        {scene === null ? null : (
          <PaintedCanvas
            scene={{ ...scene, seed: sheet.meta.seed + index * 977 }}
            progress={progress}
            width={RENDER.width}
            height={RENDER.height}
          />
        )}
      </AbsoluteFill>
      {sheet.meta.subtitles === 'none' ? null : (
        <>
          {/* A wash of paper under the words, so they read over any colour. */}
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 560, background: `linear-gradient(to top, ${PAPER}e6 0%, ${PAPER}b3 48%, ${PAPER}00 100%)` }} />
          <Words words={words} beatStartMs={beat.startMs} captionScale={captionScale} />
        </>
      )}
    </AbsoluteFill>
  );
};

export const PaintedVideo: React.FC<{ sheet: BeatSheet }> = ({ sheet }) => {
  const { fps } = useVideoConfig();
  const total = Math.round((sheet.meta.durationMs / 1000) * fps);
  return (
    <AbsoluteFill style={{ backgroundColor: PAPER }}>
      {sheet.beats.map((beat, index) => {
        const from = Math.round((beat.startMs / 1000) * fps);
        const next = sheet.beats[index + 1];
        // Each beat stays up under the next one's fade, so there is no flash of paper.
        const until = next === undefined ? total : Math.round((next.startMs / 1000) * fps) + FADE_FRAMES;
        return (
          <Sequence key={beat.id} from={from} durationInFrames={Math.max(1, until - from)}>
            <PaintedBeat sheet={sheet} index={index} durationInFrames={Math.max(1, until - from)} />
          </Sequence>
        );
      })}
      <Grain />
      <Vignette />
    </AbsoluteFill>
  );
};
