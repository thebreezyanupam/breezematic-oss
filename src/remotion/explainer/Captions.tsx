import { interpolate, useCurrentFrame } from 'remotion';
import type { TimedWord } from '../../explainer.js';
import { EX, TEXT_SHADOW, msToFrame, pop } from './theme.js';

/**
 * Word-by-word captions: a few words at a time, the one being said lit.
 *
 * Chunked the way an editor chunks them -- three or four words, broken at a
 * pause or the end of a clause, never across one -- because a caption is read
 * in a glance, and a glance takes in about that much. The lit word carries a
 * solid highlight rather than only a colour change, since a colour change
 * alone disappears over a yellow picture.
 */

const MAX_WORDS = 4;
const MAX_CHARS = 20;
const PAUSE_MS = 320;

export type Chunk = { words: TimedWord[]; startMs: number; endMs: number };

export function chunkWords(words: readonly TimedWord[]): Chunk[] {
  const chunks: Chunk[] = [];
  let current: TimedWord[] = [];
  const flush = (): void => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first !== undefined && last !== undefined) {
      chunks.push({ words: current, startMs: first.startMs, endMs: last.endMs });
    }
    current = [];
  };
  for (const word of words) {
    const previous = current[current.length - 1];
    const chars = current.reduce((sum, w) => sum + w.text.length + 1, 0) + word.text.length;
    if (
      previous !== undefined &&
      (current.length >= MAX_WORDS || chars > MAX_CHARS || word.startMs - previous.endMs > PAUSE_MS)
    ) {
      flush();
    }
    current.push(word);
    if (/[.!?;:,]$/.test(word.text) && current.length >= 2) flush();
  }
  flush();
  return chunks;
}

export const Captions: React.FC<{
  words: readonly TimedWord[];
  /** Where this beat starts on the video's clock; the words are on that clock. */
  beatStartMs: number;
  /** Where this beat ends, so a chunk stays up to the cut rather than blinking off. */
  beatEndMs: number;
  scale: number;
  fontFamily: string;
  /** Fade them out: the last beat lets the frame settle without text on it. */
  fadeAtMs?: number | null;
}> = ({ words, beatStartMs, beatEndMs, scale, fontFamily, fadeAtMs = null }) => {
  const frame = useCurrentFrame();
  const nowMs = beatStartMs + (frame / EX.fps) * 1000;
  const chunks = chunkWords(words);
  if (chunks.length === 0) return null;

  // The chunk on screen: the latest that has started, held until the next.
  let index = -1;
  for (let i = 0; i < chunks.length; i++) {
    if ((chunks[i]?.startMs ?? Infinity) <= nowMs + 40) index = i;
  }
  if (index === -1) return null;
  const chunk = chunks[index]!;
  const next = chunks[index + 1];
  const holdUntil = next?.startMs ?? beatEndMs;
  if (nowMs > holdUntil) return null;

  const appearFrame = msToFrame(Math.max(chunk.startMs, beatStartMs) - beatStartMs);
  const enter = pop(frame, appearFrame - 1, { damping: 14, stiffness: 260, mass: 0.5 });
  const fade =
    fadeAtMs === null
      ? 1
      : interpolate(nowMs, [fadeAtMs, fadeAtMs + 260], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const size = Math.round(84 * scale);
  let litIndex = 0;
  chunk.words.forEach((word, i) => {
    if (word.startMs - 30 <= nowMs) litIndex = i;
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: EX.sideLeft,
        right: EX.sideLeft + 20,
        top: EX.captionY,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: `${Math.round(size * 0.12)}px ${Math.round(size * 0.22)}px`,
        fontFamily,
        fontWeight: 850,
        fontSize: size,
        lineHeight: 1.08,
        letterSpacing: '-0.02em',
        color: EX.ink,
        opacity: fade,
        transform: `translateY(${(1 - enter) * 26}px) scale(${0.92 + 0.08 * enter})`,
      }}
    >
      {chunk.words.map((word, i) => {
        // Exactly one lit word: the latest one said. Lighting a word only
        // while it sounds leaves every gap between words with nothing lit,
        // which reads as the highlight flickering.
        const lit = i === litIndex;
        const litFrame = msToFrame(word.startMs - beatStartMs);
        const bump = lit ? pop(frame, litFrame - 1, { damping: 10, stiffness: 320, mass: 0.4 }) : 0;
        return (
          <span
            key={`${word.startMs}-${i}`}
            style={{
              position: 'relative',
              display: 'inline-block',
              padding: '0.02em 0.16em 0.06em',
              borderRadius: 14,
              background: lit ? EX.accent : 'transparent',
              color: lit ? EX.accentInk : EX.ink,
              textShadow: lit ? 'none' : TEXT_SHADOW,
              transform: `scale(${1 + 0.07 * bump}) rotate(${lit ? -1.2 : 0}deg)`,
              boxShadow: lit ? '0 10px 30px rgba(0,0,0,0.35)' : 'none',
            }}
          >
            {word.text}
          </span>
        );
      })}
    </div>
  );
};
