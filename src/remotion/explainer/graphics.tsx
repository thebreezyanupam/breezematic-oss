import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { Circle, Underline } from '@remotion/rough-notation';
import {
  cueTime,
  decimalsOf,
  formatValue,
  itemTimes,
  type Graphic,
  type TimedWord,
} from '../../explainer.js';
import { SERIF_FONT_FAMILY } from '../font.js';
import { CARD, EX, KICKER, TEXT_SHADOW, easeOut, msToFrame, pop, ramp } from './theme.js';
import { MapGraphic, canMap } from './MapGraphic.js';

/**
 * The explainer's motion graphics, one component per kind.
 *
 * Every one of them is timed to the narration rather than to the beat: a
 * counter lands on the frame its number is said, a list item arrives with
 * the word that names it. The beat's start and length are only the fallback
 * for a cue the narration never says, so the graphic never runs ahead of the
 * voice or waits for it.
 */

export type GraphicProps = {
  graphic: Graphic;
  /** The beat's written words, each with when it is said, on the video's clock. */
  words: readonly TimedWord[];
  beatStartMs: number;
  beatEndMs: number;
  durationInFrames: number;
  fontFamily: string;
  /** The word the planner picked as the line's emphasis, for the headline. */
  emphasis: string | null;
};

/** A frame within the beat, from a moment on the video's clock. */
const frameAt = (ms: number, beatStartMs: number): number => msToFrame(ms - beatStartMs);

/** The graphic leaving at the end of its beat, so it never just vanishes at the cut. */
function useLeave(durationInFrames: number): number {
  const frame = useCurrentFrame();
  return interpolate(frame, [durationInFrames - 7, durationInFrames - 1], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

const Band: React.FC<{ children: React.ReactNode; leave: number; align?: 'center' | 'start' }> = ({
  children,
  leave,
  align = 'center',
}) => (
  <div
    style={{
      position: 'absolute',
      left: EX.sideLeft,
      right: EX.sideRight - 40,
      top: EX.bandTop,
      height: EX.bandBottom - EX.bandTop,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: align === 'center' ? 'center' : 'flex-start',
      opacity: leave,
      transform: `scale(${0.96 + 0.04 * leave})`,
    }}
  >
    {children}
  </div>
);

const Kicker: React.FC<{ text: string; at: number }> = ({ text, at }) => {
  const frame = useCurrentFrame();
  const shown = ramp(frame, at, 10);
  if (text.trim() === '') return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 26, opacity: shown }}>
      <div style={{ width: 70 * shown, height: 8, borderRadius: 4, background: EX.accent }} />
      <div style={{ ...KICKER, transform: `translateX(${(1 - shown) * -20}px)`, textShadow: TEXT_SHADOW }}>{text}</div>
    </div>
  );
};

/**
 * A band of light that crosses a card once as it lands -- the glint a
 * motion designer puts on anything meant to feel finished rather than drawn.
 * Lives inside the card, which clips it.
 */
const Shine: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const sweep = ramp(frame, at, 16, Easing.inOut(Easing.quad));
  if (sweep <= 0 || sweep >= 1) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: '-30%',
        bottom: '-30%',
        width: '38%',
        left: `${-45 + sweep * 150}%`,
        background: 'linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.16) 45%, rgba(255,255,255,0.32) 50%, rgba(255,255,255,0.16) 55%, rgba(255,255,255,0) 100%)',
        transform: 'rotate(8deg)',
        pointerEvents: 'none',
      }}
    />
  );
};

/**
 * A Lucide line icon drawing itself, one stroke after the next. The strokes
 * are the icon's own skeleton (see icons.ts), so this reads as a pen drawing
 * the thing rather than an outline being traced around it.
 */
const DrawnIcon: React.FC<{ paths: readonly string[]; progress: number; size: number; color: string; width?: number }> = ({
  paths,
  progress,
  size,
  color,
  width = 2,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
    {paths.map((d, index) => {
      const done = Math.max(0, Math.min(1, progress * paths.length - index));
      return <path key={index} d={d} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - done} opacity={done > 0 ? 1 : 0} />;
    })}
  </svg>
);

/** A number running up to its value, landing when it lands. */
function counted(value: number, progress: number): string {
  return formatValue(value * progress, decimalsOf(value));
}

// ---------------------------------------------------------------------------

/**
 * The hook, set big: on screen from the very first frame, so the video opens
 * on a sentence rather than on a fade. The words already said are full
 * white and the ones to come sit back, which turns a static title into one
 * that is visibly being read.
 */
export const Headline: React.FC<GraphicProps & { kicker: string }> = ({
  words,
  beatStartMs,
  durationInFrames,
  fontFamily,
  emphasis,
  kicker,
}) => {
  const frame = useCurrentFrame();
  const leave = useLeave(durationInFrames);
  const nowMs = beatStartMs + (frame / EX.fps) * 1000;
  const chars = words.reduce((sum, word) => sum + word.text.length + 1, 0);
  const size = chars <= 22 ? 134 : chars <= 36 ? 116 : chars <= 54 ? 100 : chars <= 72 ? 88 : 76;
  const emphasised = emphasis?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') ?? null;

  return (
    <Band leave={leave}>
      <Kicker text={kicker} at={0} />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: `${size * 0.06}px ${size * 0.24}px`,
          fontFamily,
          fontWeight: 900,
          fontSize: size,
          lineHeight: 1.02,
          letterSpacing: '-0.035em',
          color: EX.ink,
        }}
      >
        {words.map((word, index) => {
          // Readable on frame 0: the line is already there and only settling,
          // a word every frame, so the opening is a sentence and not a reveal.
          const shown = pop(frame, index * 0.8 - 9, { damping: 14, stiffness: 220, mass: 0.5 });
          const said = word.startMs <= nowMs + 40;
          const key = word.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
          const hot = emphasised !== null && key === emphasised;
          const body = (
            <span
              key={`${index}-${word.text}`}
              style={{
                display: 'inline-block',
                opacity: Math.min(1, shown) * (said || hot ? 1 : 0.62),
                transform: `translateY(${(1 - shown) * 40}px)`,
                textShadow: hot ? 'none' : TEXT_SHADOW,
                ...(hot
                  ? {
                      background: EX.accent,
                      color: EX.accentInk,
                      padding: '0 0.12em 0.04em',
                      borderRadius: 18,
                      transform: `translateY(${(1 - shown) * 40}px) rotate(-1.5deg)`,
                    }
                  : {}),
              }}
            >
              {word.text}
            </span>
          );
          if (!hot) return body;
          // The marker circle goes round the word as it is said: the hook's
          // one key word, ringed by hand, the way a teacher rings it.
          const ringAt = Math.max(4, Math.round(msToFrame(word.startMs - beatStartMs)));
          return (
            <Circle
              key={`${index}-${word.text}`}
              progress={ramp(frame, ringAt, 14, Easing.inOut(Easing.quad))}
              color="#ffffff"
              strokeWidth={6}
              iterations={2}
              padding={{ left: 26, right: 26, top: 18, bottom: 18 }}
              seed={index + 3}
              style={{ display: 'inline-block' }}
            >
              {body}
            </Circle>
          );
        })}
      </div>
    </Band>
  );
};

// ---------------------------------------------------------------------------

export const Stat: React.FC<GraphicProps> = ({ graphic, words, beatStartMs, beatEndMs, durationInFrames, fontFamily }) => {
  const frame = useCurrentFrame();
  const leave = useLeave(durationInFrames);
  const value = graphic.value ?? 0;
  const startFrame = 3;
  const said = cueTime(graphic.cue, words, beatStartMs);
  const landMs = said ?? beatStartMs + (beatEndMs - beatStartMs) * 0.5;
  const landFrame = Math.max(startFrame + 12, frameAt(landMs, beatStartMs) + 4);
  const progress = interpolate(frame, [startFrame, landFrame], [0, 1], {
    easing: easeOut,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const final = `${graphic.prefix}${formatValue(value, decimalsOf(value))}`;
  const inlineSuffix = graphic.suffix.length > 0 && graphic.suffix.length <= 3;
  const length = final.length + (inlineSuffix ? graphic.suffix.length : 0);
  const size = length <= 4 ? 270 : length <= 6 ? 220 : length <= 8 ? 176 : 140;
  const enter = pop(frame, 0, { damping: 14, stiffness: 200 });
  const ring = ramp(frame, landFrame, 16);

  // A share of a whole is a gauge, not a counter: the ring fills to it.
  if (graphic.suffix.trim() === '%' && value > 0 && value <= 100) {
    return (
      <PercentRing graphic={graphic} value={value} progress={progress} landFrame={landFrame} leave={leave} enter={enter} fontFamily={fontFamily} />
    );
  }

  return (
    <Band leave={leave}>
      <div
        style={{
          ...CARD,
          padding: '54px 56px 58px',
          transform: `translateY(${(1 - enter) * 80}px) scale(${0.9 + 0.1 * enter})`,
          opacity: Math.min(1, enter * 1.4),
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <Shine at={6} />
        <Kicker text={graphic.title !== '' ? graphic.title : 'by the numbers'} at={2} />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'baseline', gap: 10 }}>
          {/* The ring that goes out when the number lands. */}
          <div
            style={{
              position: 'absolute',
              left: size * 0.9,
              top: size * 0.55,
              width: size * 2.6,
              height: size * 2.6,
              marginLeft: -size * 1.3,
              marginTop: -size * 1.3,
              borderRadius: '50%',
              border: `6px solid ${EX.accent}`,
              opacity: ring > 0 && ring < 1 ? (1 - ring) * 0.7 : 0,
              transform: `scale(${0.3 + ring * 0.9})`,
            }}
          />
          <div
            style={{
              fontFamily,
              fontWeight: 900,
              fontSize: size,
              lineHeight: 0.9,
              letterSpacing: '-0.05em',
              color: EX.accent,
              fontVariantNumeric: 'tabular-nums',
              // A punch as it lands, settling back over a third of a second.
              transform: `scale(${frame >= landFrame ? 1 + 0.08 * (1 - ramp(frame, landFrame, 10)) : 1})`,
              transformOrigin: 'left bottom',
              textShadow: '0 10px 40px rgba(255,210,63,0.25)',
            }}
          >
            {graphic.prefix}
            {counted(value, progress)}
            {inlineSuffix ? <span style={{ fontSize: size * 0.5, marginLeft: 8 }}>{graphic.suffix}</span> : null}
          </div>
        </div>
        {!inlineSuffix && graphic.suffix !== '' ? (
          <div style={{ fontFamily, fontWeight: 850, fontSize: 70, color: EX.ink, marginTop: 6, letterSpacing: '-0.02em', opacity: ramp(frame, 6, 10) }}>
            {graphic.suffix}
          </div>
        ) : null}
        <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.12)', marginTop: 34, overflow: 'hidden' }}>
          <div style={{ width: `${progress * 100}%`, height: '100%', background: EX.accent }} />
        </div>
        {graphic.label !== '' ? (
          <div style={{ fontFamily, fontWeight: 650, fontSize: 50, lineHeight: 1.15, color: EX.dim, marginTop: 28, opacity: ramp(frame, 8, 12) }}>
            {graphic.label}
          </div>
        ) : null}
      </div>
    </Band>
  );
};

// ---------------------------------------------------------------------------

export const Compare: React.FC<GraphicProps> = ({ graphic, words, beatStartMs, beatEndMs, durationInFrames, fontFamily }) => {
  const frame = useCurrentFrame();
  const leave = useLeave(durationInFrames);
  const times = itemTimes(graphic.items, words, beatStartMs, beatEndMs);
  const max = Math.max(1, ...graphic.items.map((item) => item.value ?? 0));
  const colours = [EX.second, EX.accent];
  const badge = pop(frame, 6, { damping: 8, stiffness: 240, mass: 0.5 });

  return (
    <Band leave={leave}>
      <Kicker text={graphic.title} at={0} />
      <div style={{ position: 'relative', display: 'flex', gap: 30 }}>
        {graphic.items.slice(0, 2).map((item, index) => {
          const at = frameAt(times[index] ?? beatStartMs, beatStartMs);
          const shown = pop(frame, Math.min(at, 6 + index * 5), { damping: 14, stiffness: 200 });
          const counting = interpolate(frame, [at, at + 18], [0, 1], { easing: easeOut, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          return (
            <div
              key={index}
              style={{
                ...CARD,
                flex: 1,
                padding: '40px 34px 44px',
                minHeight: 470,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                borderTop: `10px solid ${colours[index]}`,
                opacity: Math.min(1, shown * 1.3),
                transform: `translateX(${(1 - shown) * (index === 0 ? -120 : 120)}px)`,
              }}
            >
              <div style={{ fontFamily, fontWeight: 850, fontSize: 56, lineHeight: 1.05, color: EX.ink, letterSpacing: '-0.02em' }}>
                {item.label}
              </div>
              {item.value !== null ? (
                <div>
                  <div style={{ fontFamily, fontWeight: 900, fontSize: 104, lineHeight: 1, color: colours[index], letterSpacing: '-0.04em', fontVariantNumeric: 'tabular-nums', marginTop: 24 }}>
                    {graphic.prefix}
                    {counted(item.value, counting)}
                    {graphic.suffix.length <= 3 ? graphic.suffix : ''}
                  </div>
                  {graphic.suffix.length > 3 ? (
                    <div style={{ fontFamily, fontWeight: 700, fontSize: 40, color: EX.dim, marginTop: 6 }}>{graphic.suffix}</div>
                  ) : null}
                  <div style={{ height: 12, borderRadius: 6, background: 'rgba(255,255,255,0.12)', marginTop: 26, overflow: 'hidden' }}>
                    <div style={{ width: `${(item.value / max) * 100 * counting}%`, height: '100%', background: colours[index] }} />
                  </div>
                </div>
              ) : (
                <div style={{ fontFamily, fontWeight: 600, fontSize: 40, color: EX.dim, marginTop: 20 }}>{item.text}</div>
              )}
            </div>
          );
        })}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 124,
            height: 124,
            marginLeft: -62,
            marginTop: -62,
            borderRadius: '50%',
            background: EX.ink,
            color: EX.accentInk,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily,
            fontWeight: 900,
            fontSize: 50,
            letterSpacing: '-0.02em',
            boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
            transform: `scale(${badge}) rotate(${(1 - Math.min(1, badge)) * -30}deg)`,
          }}
        >
          VS
        </div>
      </div>
    </Band>
  );
};

// ---------------------------------------------------------------------------

export const Bars: React.FC<GraphicProps> = ({ graphic, words, beatStartMs, beatEndMs, durationInFrames, fontFamily }) => {
  const frame = useCurrentFrame();
  const leave = useLeave(durationInFrames);
  const times = itemTimes(graphic.items, words, beatStartMs, beatEndMs);
  const max = Math.max(1e-9, ...graphic.items.map((item) => item.value ?? 0));
  const top = graphic.items.reduce((best, item, index) => ((item.value ?? 0) > (graphic.items[best]?.value ?? 0) ? index : best), 0);
  const enter = pop(frame, 0, { damping: 15, stiffness: 190 });

  return (
    <Band leave={leave}>
      <div
        style={{
          ...CARD,
          padding: '48px 50px 54px',
          position: 'relative',
          overflow: 'hidden',
          opacity: Math.min(1, enter * 1.3),
          transform: `translateY(${(1 - enter) * 70}px)`,
        }}
      >
        <Shine at={10} />
        <Kicker text={graphic.title !== '' ? graphic.title : 'compared'} at={1} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
          {graphic.items.map((item, index) => {
            const at = frameAt(times[index] ?? beatStartMs, beatStartMs);
            const grow = interpolate(frame, [at, at + 16], [0, 1], { easing: easeOut, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            const share = (item.value ?? 0) / max;
            const colour = index === top ? EX.accent : EX.second;
            return (
              <div key={index} style={{ opacity: ramp(frame, at - 3, 6) }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                  <div style={{ fontFamily, fontWeight: 800, fontSize: 46, color: EX.ink, letterSpacing: '-0.01em' }}>{item.label}</div>
                  <div style={{ fontFamily, fontWeight: 900, fontSize: 52, color: colour, fontVariantNumeric: 'tabular-nums' }}>
                    {graphic.prefix}
                    {counted(item.value ?? 0, grow)}
                    {graphic.suffix.length <= 3 ? graphic.suffix : ''}
                  </div>
                </div>
                <div style={{ height: 46, borderRadius: 14, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.max(1.5, share * 100) * grow}%`,
                      height: '100%',
                      borderRadius: 14,
                      background: `linear-gradient(90deg, ${colour}cc, ${colour})`,
                      boxShadow: `0 0 30px ${colour}55`,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {graphic.suffix.length > 3 ? (
          <div style={{ fontFamily: EX.mono, fontSize: 30, color: EX.dim, marginTop: 30, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            in {graphic.suffix}
          </div>
        ) : null}
      </div>
    </Band>
  );
};

// ---------------------------------------------------------------------------

export const Timeline: React.FC<GraphicProps> = ({ graphic, words, beatStartMs, beatEndMs, durationInFrames, fontFamily }) => {
  const frame = useCurrentFrame();
  const leave = useLeave(durationInFrames);
  const times = itemTimes(graphic.items, words, beatStartMs, beatEndMs).map((ms) => frameAt(ms, beatStartMs));
  const rowHeight = graphic.items.length <= 2 ? 250 : graphic.items.length === 3 ? 215 : 180;
  const lineTo = (() => {
    // The line reaches each point as it arrives, and not before.
    let reached = 0;
    times.forEach((at, index) => {
      reached = Math.max(reached, (index + ramp(frame, at - 6, 8)) * rowHeight - rowHeight + 30);
    });
    return Math.max(0, reached);
  })();

  return (
    <Band leave={leave}>
      <Kicker text={graphic.title !== '' ? graphic.title : 'timeline'} at={0} />
      <div style={{ position: 'relative', paddingLeft: 120 }}>
        <div style={{ position: 'absolute', left: 38, top: 30, width: 8, height: (graphic.items.length - 1) * rowHeight, borderRadius: 4, background: 'rgba(255,255,255,0.15)' }} />
        <div style={{ position: 'absolute', left: 38, top: 30, width: 8, height: Math.min(lineTo, (graphic.items.length - 1) * rowHeight), borderRadius: 4, background: EX.accent, boxShadow: `0 0 24px ${EX.accent}88` }} />
        {graphic.items.map((item, index) => {
          const at = times[index] ?? 0;
          const dot = pop(frame, at, { damping: 9, stiffness: 260, mass: 0.5 });
          const shown = ramp(frame, at, 10);
          return (
            <div key={index} style={{ position: 'relative', height: rowHeight }}>
              <div
                style={{
                  position: 'absolute',
                  left: -120 + 42 - 30,
                  top: 4,
                  width: 60,
                  height: 60,
                  borderRadius: '50%',
                  background: EX.accent,
                  border: `8px solid ${EX.ground}`,
                  boxShadow: `0 0 0 4px ${EX.accent}`,
                  transform: `scale(${dot})`,
                }}
              />
              <div style={{ opacity: shown, transform: `translateX(${(1 - shown) * 60}px)` }}>
                <div style={{ fontFamily, fontWeight: 900, fontSize: 76, lineHeight: 1, color: EX.accent, letterSpacing: '-0.03em', textShadow: TEXT_SHADOW }}>
                  {item.label}
                </div>
                {item.text !== '' ? (
                  <div style={{ fontFamily, fontWeight: 700, fontSize: 46, lineHeight: 1.15, color: EX.ink, marginTop: 10, textShadow: TEXT_SHADOW }}>
                    {item.text}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Band>
  );
};

// ---------------------------------------------------------------------------

export const Steps: React.FC<GraphicProps> = ({ graphic, words, beatStartMs, beatEndMs, durationInFrames, fontFamily }) => {
  const frame = useCurrentFrame();
  const leave = useLeave(durationInFrames);
  const times = itemTimes(graphic.items, words, beatStartMs, beatEndMs).map((ms) => frameAt(ms, beatStartMs));
  // The step being talked about is the latest to arrive.
  let current = 0;
  times.forEach((at, index) => {
    if (frame >= at) current = index;
  });

  return (
    <Band leave={leave}>
      <Kicker text={graphic.title !== '' ? graphic.title : 'how it works'} at={0} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        {graphic.items.map((item, index) => {
          const at = times[index] ?? 0;
          const shown = pop(frame, at, { damping: 14, stiffness: 210 });
          const live = index === current && frame >= at;
          return (
            <div
              key={index}
              style={{
                ...CARD,
                display: 'flex',
                alignItems: 'center',
                gap: 30,
                padding: '26px 34px',
                borderRadius: 28,
                opacity: Math.min(1, shown * 1.3) * (live ? 1 : 0.72),
                transform: `translateX(${(1 - shown) * -140}px) scale(${live ? 1.02 : 0.98})`,
                borderColor: live ? EX.accent : EX.cardEdge,
              }}
            >
              <div
                style={{
                  flex: '0 0 auto',
                  width: 92,
                  height: 92,
                  borderRadius: '50%',
                  background: live ? EX.accent : 'rgba(255,255,255,0.12)',
                  color: live ? EX.accentInk : EX.ink,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily,
                  fontWeight: 900,
                  fontSize: 50,
                }}
              >
                {index + 1}
              </div>
              <div style={{ flex: 1, fontFamily, fontWeight: 800, fontSize: 50, lineHeight: 1.1, color: EX.ink, letterSpacing: '-0.015em' }}>
                {item.label}
              </div>
              {item.paths.length > 0 ? (
                <DrawnIcon paths={item.paths} progress={ramp(frame, at + 4, 16, (t) => t)} size={78} color={live ? EX.accent : EX.dim} />
              ) : null}
            </div>
          );
        })}
      </div>
    </Band>
  );
};

// ---------------------------------------------------------------------------

export const List: React.FC<GraphicProps> = ({ graphic, words, beatStartMs, beatEndMs, durationInFrames, fontFamily }) => {
  const frame = useCurrentFrame();
  const leave = useLeave(durationInFrames);
  const times = itemTimes(graphic.items, words, beatStartMs, beatEndMs).map((ms) => frameAt(ms, beatStartMs));
  const underline = ramp(frame, 3, 14);

  return (
    <Band leave={leave}>
      {graphic.title !== '' ? (
        <div style={{ marginBottom: 44 }}>
          <div style={{ fontFamily, fontWeight: 900, fontSize: 104, lineHeight: 1, color: EX.ink, letterSpacing: '-0.035em', textShadow: TEXT_SHADOW, opacity: ramp(frame, 0, 8) }}>
            {graphic.title}
          </div>
          <div style={{ width: `${underline * 46}%`, height: 12, borderRadius: 6, background: EX.accent, marginTop: 18 }} />
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
        {graphic.items.map((item, index) => {
          const at = times[index] ?? 0;
          const shown = pop(frame, at, { damping: 15, stiffness: 220 });
          const tick = ramp(frame, at + 3, 14, (t) => t);
          return (
            <div
              key={index}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 28,
                opacity: Math.min(1, shown * 1.3),
                transform: `translateY(${(1 - shown) * 40}px)`,
              }}
            >
              {item.paths.length > 0 ? (
                <div
                  style={{
                    flex: '0 0 auto',
                    width: 92,
                    height: 92,
                    borderRadius: 24,
                    background: EX.accent,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transform: `rotate(${(1 - Math.min(1, shown)) * -20}deg)`,
                  }}
                >
                  <DrawnIcon paths={item.paths} progress={tick} size={58} color={EX.accentInk} width={2.4} />
                </div>
              ) : (
              <svg width={92} height={92} viewBox="0 0 78 78" style={{ flex: '0 0 auto' }}>
                <rect x={4} y={4} width={70} height={70} rx={20} fill={EX.accent} />
                <path
                  d="M22 40 L34 52 L57 27"
                  fill="none"
                  stroke={EX.accentInk}
                  strokeWidth={9}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={60}
                  strokeDashoffset={60 * (1 - tick)}
                />
              </svg>
              )}
              <div style={{ fontFamily, fontWeight: 800, fontSize: 68, lineHeight: 1.06, color: EX.ink, letterSpacing: '-0.02em', textShadow: TEXT_SHADOW }}>
                {item.label}
              </div>
            </div>
          );
        })}
      </div>
    </Band>
  );
};

// ---------------------------------------------------------------------------

/** A definition card: the term, a rule, and the meaning typed in under it. */
export const Term: React.FC<GraphicProps> = ({ graphic, durationInFrames, fontFamily }) => {
  const frame = useCurrentFrame();
  const leave = useLeave(durationInFrames);
  const enter = pop(frame, 0, { damping: 14, stiffness: 190 });
  const rule = ramp(frame, 6, 12);
  const typeFrom = 10;
  const typeFrames = Math.max(12, Math.min(durationInFrames * 0.55, graphic.label.length * 0.9));
  const typed = Math.round(graphic.label.length * ramp(frame, typeFrom, typeFrames, (t) => t));
  const caret = Math.floor(frame / 8) % 2 === 0 && typed < graphic.label.length + 1;

  return (
    <Band leave={leave}>
      <div
        style={{
          ...CARD,
          padding: '56px 58px 62px',
          position: 'relative',
          overflow: 'hidden',
          opacity: Math.min(1, enter * 1.3),
          transform: `translateY(${(1 - enter) * 70}px) rotate(${(1 - enter) * -2}deg)`,
        }}
      >
        <Shine at={8} />
        <div style={{ ...KICKER, fontSize: 34, marginBottom: 22 }}>definition</div>
        <div style={{ fontFamily: SERIF_FONT_FAMILY, fontWeight: 700, fontSize: graphic.title.length > 18 ? 100 : 124, lineHeight: 1, color: EX.ink, letterSpacing: '-0.02em' }}>
          <Underline progress={ramp(frame, 5, 12, Easing.inOut(Easing.quad))} color={EX.accent} strokeWidth={7} iterations={2} seed={11} style={{ display: 'inline-block' }}>
            {graphic.title}
          </Underline>
        </div>
        <div style={{ width: `${rule * 100}%`, height: 4, background: EX.accent, margin: '34px 0 30px' }} />
        <div style={{ fontFamily, fontWeight: 600, fontSize: 60, lineHeight: 1.2, color: EX.ink, minHeight: 150 }}>
          {graphic.label.slice(0, typed)}
          <span style={{ display: 'inline-block', width: 5, height: 52, marginLeft: 6, verticalAlign: '-6px', background: EX.accent, opacity: caret ? 1 : 0 }} />
        </div>
      </div>
    </Band>
  );
};

// ---------------------------------------------------------------------------

/**
 * A lower third naming what is on screen. Above the captions rather than in
 * the usual broadcast spot at the very bottom, because on a phone the bottom
 * fifth belongs to the platform.
 */
export const Callout: React.FC<GraphicProps> = ({ graphic, durationInFrames, fontFamily }) => {
  const frame = useCurrentFrame();
  const leave = useLeave(durationInFrames);
  const bar = ramp(frame, 2, 8);
  const block = ramp(frame, 6, 12);
  const second = ramp(frame, 11, 12);

  return (
    <div
      style={{
        position: 'absolute',
        left: EX.sideLeft,
        top: 990,
        display: 'flex',
        gap: 16,
        opacity: leave,
        transform: `translateX(${(1 - leave) * -60}px)`,
      }}
    >
      <div style={{ width: 14, borderRadius: 7, background: EX.accent, transform: `scaleY(${bar})`, transformOrigin: 'top' }} />
      <div>
        <div
          style={{
            display: 'inline-block',
            background: EX.accent,
            color: EX.accentInk,
            fontFamily,
            fontWeight: 900,
            fontSize: 64,
            lineHeight: 1,
            letterSpacing: '-0.025em',
            padding: '18px 28px 20px',
            borderRadius: 12,
            clipPath: `inset(0 ${(1 - block) * 100}% 0 0)`,
          }}
        >
          {graphic.title}
        </div>
        {graphic.label !== '' ? (
          <div style={{ marginTop: 10 }}>
            <div
              style={{
                display: 'inline-block',
                background: 'rgba(10,12,18,0.86)',
                color: EX.ink,
                fontFamily,
                fontWeight: 650,
                fontSize: 42,
                lineHeight: 1.1,
                padding: '14px 24px 16px',
                borderRadius: 10,
                clipPath: `inset(0 ${(1 - second) * 100}% 0 0)`,
                maxWidth: 860,
              }}
            >
              {graphic.label}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/**
 * The keyword punch, for a beat with no data to chart: its one important word
 * slams in large as it is said, a hand-drawn underline runs under it, and it
 * holds until the cut.
 *
 * Nothing is invented to fill the frame -- the word is the narration's own,
 * the one the planner already picked as the line's emphasis -- but the beat
 * still gets the motion every other beat has, which is the difference
 * between an edit and a slideshow with captions. Alternates sides so a run of
 * them does not stack in one place.
 */
export const KeywordPunch: React.FC<{
  word: string;
  atFrame: number;
  durationInFrames: number;
  side: 'left' | 'right';
  fontFamily: string;
}> = ({ word, atFrame, durationInFrames, side, fontFamily }) => {
  const frame = useCurrentFrame();
  const leave = useLeave(durationInFrames);
  if (frame < atFrame - 1) return null;
  const slam = pop(frame, atFrame - 1, { damping: 11, stiffness: 260, mass: 0.55 });
  const blur = Math.max(0, (1 - Math.min(1, slam)) * 14);
  // The word, not the sentence around it: a full stop on a slammed word reads as a typo.
  const text = word.replace(/[^\p{L}\p{N}%$'.-]/gu, '').replace(/[.'-]+$/, '');
  const size = text.length <= 6 ? 190 : text.length <= 9 ? 150 : text.length <= 12 ? 120 : 96;
  return (
    <div
      style={{
        position: 'absolute',
        top: EX.bandTop + 60,
        [side]: EX.sideLeft,
        maxWidth: EX.width - EX.sideLeft - EX.sideRight,
        opacity: Math.min(1, slam * 1.5) * leave,
        transform: `scale(${1.35 - 0.35 * Math.min(1, slam)}) rotate(${side === 'left' ? -3 : 3}deg)`,
        transformOrigin: side === 'left' ? 'left center' : 'right center',
        filter: blur > 0.3 ? `blur(${blur.toFixed(1)}px)` : undefined,
      }}
    >
      <Underline
        progress={ramp(frame, atFrame + 3, 10, Easing.inOut(Easing.quad))}
        color={EX.accent}
        strokeWidth={12}
        iterations={2}
        padding={{ top: 4 }}
        seed={text.length + 5}
        style={{ display: 'inline-block' }}
      >
        <span
          style={{
            display: 'inline-block',
            fontFamily,
            fontWeight: 900,
            fontSize: size,
            lineHeight: 1,
            letterSpacing: '-0.045em',
            textTransform: 'uppercase',
            color: EX.ink,
            textShadow: '0 8px 40px rgba(0,0,0,0.6), 0 2px 6px rgba(0,0,0,0.5)',
          }}
        >
          {text}
        </span>
      </Underline>
    </div>
  );
};

/** Whether a kind is drawn over the picture blurred as a plate, or over it sharp. */
export function wantsPlate(kind: Graphic['kind']): boolean {
  return kind !== 'none' && kind !== 'callout' && kind !== 'headline';
}

/**
 * The percent version of a stat: a gauge filling to the share as the number
 * counts, the number in its middle. Fifty per cent drawn as half a circle is
 * understood before it is read.
 */
const PercentRing: React.FC<{
  graphic: Graphic;
  value: number;
  progress: number;
  landFrame: number;
  leave: number;
  enter: number;
  fontFamily: string;
}> = ({ graphic, value, progress, landFrame, leave, enter, fontFamily }) => {
  const frame = useCurrentFrame();
  const radius = 230;
  const around = 2 * Math.PI * radius;
  const filled = (value / 100) * progress;
  const punch = frame >= landFrame ? 1 + 0.06 * (1 - ramp(frame, landFrame, 10)) : 1;
  return (
    <Band leave={leave}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: Math.min(1, enter * 1.4), transform: `scale(${(0.85 + 0.15 * enter) * punch})` }}>
        <Kicker text={graphic.title !== '' ? graphic.title : 'by the numbers'} at={2} />
        <div style={{ position: 'relative', width: radius * 2 + 60, height: radius * 2 + 60 }}>
          <svg width={radius * 2 + 60} height={radius * 2 + 60} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
            <circle cx={radius + 30} cy={radius + 30} r={radius} fill="rgba(10,12,18,0.55)" stroke="rgba(255,255,255,0.12)" strokeWidth={34} />
            <circle
              cx={radius + 30}
              cy={radius + 30}
              r={radius}
              fill="none"
              stroke={EX.accent}
              strokeWidth={34}
              strokeLinecap="round"
              strokeDasharray={around}
              strokeDashoffset={around * (1 - filled)}
              style={{ filter: `drop-shadow(0 0 18px ${EX.accent}88)` }}
            />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily, fontWeight: 900, fontSize: 168, color: EX.ink, letterSpacing: '-0.05em', fontVariantNumeric: 'tabular-nums' }}>
            {formatValue(value * progress, decimalsOf(value))}
            <span style={{ fontSize: 84, color: EX.accent, marginLeft: 6 }}>%</span>
          </div>
        </div>
        {graphic.label !== '' ? (
          <div style={{ fontFamily, fontWeight: 700, fontSize: 52, lineHeight: 1.15, color: EX.ink, marginTop: 30, textAlign: 'center', textShadow: TEXT_SHADOW, opacity: ramp(frame, 8, 12) }}>
            {graphic.label}
          </div>
        ) : null}
      </div>
    </Band>
  );
};

export const GraphicLayer: React.FC<GraphicProps & { kicker: string }> = (props) => {
  switch (props.graphic.kind) {
    case 'headline':
      return <Headline {...props} />;
    case 'stat':
      return <Stat {...props} />;
    case 'compare':
      return <Compare {...props} />;
    case 'bars':
      return <Bars {...props} />;
    case 'timeline':
      return <Timeline {...props} />;
    case 'steps':
      return <Steps {...props} />;
    case 'list':
      return <List {...props} />;
    case 'term':
      return <Term {...props} />;
    case 'callout':
      return <Callout {...props} />;
    case 'map':
      // A place the map cannot find is still named: as a lower third.
      return canMap(props.graphic) ? (
        <MapGraphic graphic={props.graphic} durationInFrames={props.durationInFrames} fontFamily={props.fontFamily} />
      ) : (
        <Callout {...props} />
      );
    case 'none':
      return null;
  }
};
