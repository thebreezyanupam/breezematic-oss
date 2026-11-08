import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT_FAMILY } from '../font.js';
import { IconGlyph } from './Icon.js';

/**
 * A meme sticker: an icon and a few words, slapped on for a moment.
 *
 * Die-cut look -- a thick white border and a hard shadow, tilted -- because a
 * sticker is a thing somebody stuck onto the video, not part of the world,
 * and that distance is the joke. It springs on with an overshoot, sits for
 * about two seconds and pops off, so it is a beat of commentary rather than a
 * caption. Placed on the right, clear of the words across the top and of the
 * figure in the middle.
 */
const HOLD_SECONDS = 1.9;

export const Sticker: React.FC<{ icon: string; text: string; fromFrame: number }> = ({ icon, text, fromFrame }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const local = frame - fromFrame;
  if (local < 0 || local > fps * (HOLD_SECONDS + 0.4)) return null;

  const pop = spring({ frame: local, fps, config: { damping: 9, stiffness: 240, mass: 0.6 } });
  const leave = interpolate(local, [fps * HOLD_SECONDS, fps * (HOLD_SECONDS + 0.25)], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scale = pop * (0.4 + 0.6 * leave) + (1 - leave) * 0;
  const size = Math.round(width * 0.075);

  return (
    <div
      style={{
        position: 'absolute',
        right: '6%',
        top: '38%',
        transform: `rotate(-7deg) scale(${scale})`,
        transformOrigin: 'center',
        opacity: leave,
        display: 'flex',
        alignItems: 'center',
        gap: size * 0.2,
        padding: `${size * 0.18}px ${size * 0.34}px`,
        background: '#fffdf6',
        borderRadius: size * 0.28,
        border: `${Math.round(size * 0.07)}px solid #ffffff`,
        boxShadow: `${size * 0.06}px ${size * 0.08}px 0 #1d1b24, 0 ${size * 0.2}px ${size * 0.4}px rgba(0,0,0,0.35)`,
      }}
    >
      <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}>
        <IconGlyph name={icon} size={size * 0.92} fill="#1d1b24" />
      </svg>
      {text.trim() === '' ? null : (
        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontWeight: 900,
            fontSize: size * 0.42,
            lineHeight: 1,
            letterSpacing: '-0.01em',
            textTransform: 'uppercase',
            color: '#1d1b24',
            maxWidth: size * 4.2,
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
};
