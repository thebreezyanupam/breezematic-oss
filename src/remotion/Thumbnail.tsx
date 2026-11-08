import React, { useEffect, useMemo, useState } from 'react';
import { AbsoluteFill, Img, continueRender, delayRender, staticFile, useVideoConfig } from 'remotion';
import { FONT_FAMILY, useInterFont } from './font.js';
import { barFraction } from './EssayCinema.js';
import type { ThumbnailProps } from './thumbnailProps.js';

export { THUMBNAIL_COMPOSITION_ID, THUMBNAIL_SIZE, emptyThumbnail, type ThumbnailProps } from './thumbnailProps.js';

/**
 * A thumbnail, made from a picture the video already paid for.
 *
 * The look is the one that reads at matchbox size: the picture pushed in on
 * its subject and darkened, two or three huge words across it, and then the
 * subject again on top of the words -- cut out by the local model -- so the
 * words sit *behind* the character. That depth is what makes it look designed
 * rather than captioned. The channel's cinema bars stay, and the subject is
 * allowed to break out of the top one, which is the other half of the effect.
 *
 * The words are typeset here, never drawn by an image model: a thumbnail is
 * the one place a misspelt, melted letter would be seen by everyone.
 */
/** The mask is a CSS image, not an <Img>, so the still would not wait for it. */
function useLoaded(src: string | null): void {
  const [handle] = useState(() => (src === null ? null : delayRender(`loading ${src}`)));
  useEffect(() => {
    if (src === null || handle === null) return;
    const image = new Image();
    const done = (): void => continueRender(handle);
    image.onload = done;
    image.onerror = done;
    image.src = src;
  }, [src, handle]);
}

/** The largest size at which every line fits the width, from real measurement. */
function fitSize(lines: readonly string[], width: number, ready: boolean, max: number): number {
  if (!ready || typeof document === 'undefined') return max * 0.8;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) return max * 0.8;
  context.font = `900 100px '${FONT_FAMILY}'`;
  const widest = Math.max(1, ...lines.map((line) => context.measureText(line).width));
  return Math.min(max, (width / widest) * 100);
}

export const Thumbnail: React.FC<ThumbnailProps> = (props) => {
  const { width, height } = useVideoConfig();
  const ready = useInterFont();
  const imageSrc = props.image === '' ? '' : staticFile(`images/${props.image}`);
  const matteSrc = props.matte === undefined ? null : staticFile(`images/${props.matte}`);
  useLoaded(matteSrc);

  const bar = props.bars ? barFraction(width, height) : 0;
  const lines = props.lines.filter((line) => line.trim() !== '').slice(0, 2);
  const size = useMemo(
    () => fitSize(lines, width * 0.9, ready, lines.length > 1 ? height * 0.27 : height * 0.36),
    [lines, width, height, ready],
  );
  const lineHeight = size * 0.9;
  const block = lineHeight * lines.length;

  /**
   * Where the words go: across the frame, low enough that the subject's head
   * and shoulders come up in front of them. Measured from the subject's top
   * after the push-in, and kept inside the bars.
   */
  const zoom = Math.max(1, props.zoom);
  const subjectTopOnScreen = props.focus.y + (props.subjectTop - props.focus.y) * zoom;
  const scopeTop = bar + 0.03;
  const scopeBottom = 1 - bar - 0.04;
  const wantedTop = subjectTopOnScreen + 0.06;
  const top =
    Math.min(scopeBottom - block / height, Math.max(scopeTop, props.textTop ?? wantedTop)) * height;

  const picture: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: 'center',
  };
  const push: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    transform: `scale(${zoom})`,
    transformOrigin: `${props.focus.x * 100}% ${props.focus.y * 100}%`,
  };

  return (
    <AbsoluteFill style={{ backgroundColor: '#050505', overflow: 'hidden' }}>
      {/* The picture, pushed in and knocked back, so the words and subject carry. */}
      <div style={push}>
        {imageSrc === '' ? null : (
          <Img src={imageSrc} style={{ ...picture, filter: 'brightness(0.55) saturate(1.15) contrast(1.05)' }} />
        )}
      </div>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at ${props.focus.x * 100}% ${props.focus.y * 100}%, transparent 30%, rgba(0,0,0,0.55) 100%)`,
        }}
      />
      <AbsoluteFill style={{ backgroundColor: props.accent, mixBlendMode: 'soft-light', opacity: 0.35 }} />

      {/* The words, behind the subject. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top,
          textAlign: 'center',
          fontFamily: FONT_FAMILY,
          fontWeight: 900,
          fontSize: size,
          lineHeight: `${lineHeight}px`,
          letterSpacing: '-0.02em',
          color: props.accent,
          textShadow: '0 6px 24px rgba(0,0,0,0.55)',
          whiteSpace: 'nowrap',
        }}
      >
        {lines.map((line, index) => (
          <div key={index} style={index === 1 ? { color: '#f7f3ea' } : undefined}>
            {line}
          </div>
        ))}
      </div>

      {/* The bars, under the subject so it can break out of the top one. */}
      {bar > 0 ? (
        <>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: `${bar * 100}%`, backgroundColor: '#000' }} />
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${bar * 100}%`, backgroundColor: '#000' }} />
        </>
      ) : null}

      {/* The subject again, on top of everything, lit a touch brighter than the ground. */}
      {matteSrc === null || imageSrc === '' ? null : (
        // The shadow on the wrapper: a filter on the masked picture itself is
        // applied before the mask and would be cut away with the background.
        <div style={{ ...push, filter: 'drop-shadow(0 0 20px rgba(0,0,0,0.75))' }}>
          <Img
            src={imageSrc}
            style={{
              ...picture,
              filter: 'brightness(1.05) contrast(1.08) saturate(1.1)',
              WebkitMaskImage: `url(${matteSrc})`,
              maskImage: `url(${matteSrc})`,
              WebkitMaskSize: 'cover',
              maskSize: 'cover',
              WebkitMaskPosition: 'center',
              maskPosition: 'center',
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
            }}
          />
        </div>
      )}

      {/* Grain, still: the channel's texture. */}
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        <Img
          src={staticFile('cinema/grain.png')}
          style={{ width: '100%', height: '100%', objectFit: 'cover', mixBlendMode: 'overlay', opacity: 0.14 }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
