import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { LAYOUT, RENDER, type StyleTokens } from '../design.js';
import { FONT_FAMILY } from './font.js';
import { cased, splitEmphasis, strokeWidth, type BlockLayout, type Sized } from './layout.js';
import type { TemplateName } from '../schema.js';

export type TemplateProps = {
  layout: BlockLayout;
  emphasisWord: string | null;
  index: number;
  durationInFrames: number;
};

const ENTRY = { damping: 9, stiffness: 300, mass: 0.4 } as const;

/**
 * How the emphasis word is marked. The extra room the highlight block and the
 * outline stroke need is already priced into the fitter via
 * `StyleTokens.emphasisPadEm`, so these can draw freely.
 */
export function emphasisStyle(style: StyleTokens, fontSize: number): React.CSSProperties {
  const base: React.CSSProperties = { fontWeight: style.emphasisWeight };

  if (style.emphasis === 'colour') return { ...base, color: style.accent };

  if (style.emphasis === 'highlight') {
    return {
      ...base,
      color: style.onAccent,
      backgroundColor: style.accent,
      padding: `0 ${style.emphasisPadEm}em`,
      borderRadius: fontSize * 0.06,
      boxDecorationBreak: 'clone',
      WebkitBoxDecorationBreak: 'clone',
    };
  }

  if (style.emphasis === 'outline') {
    return {
      ...base,
      color: 'transparent',
      WebkitTextStrokeWidth: strokeWidth(fontSize),
      WebkitTextStrokeColor: style.accent,
    };
  }

  return base;
}

const TypeLine: React.FC<{
  sized: Sized;
  order: number;
  layout: BlockLayout;
  emphasisWord: string | null;
  durationInFrames: number;
  reveal?: boolean;
}> = ({ sized, order, layout, emphasisWord, durationInFrames, reveal = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const delay = Math.round((order * LAYOUT.lineStaggerMs * fps) / 1000);
  const local = frame - delay;
  const entry = spring({ frame: local, fps, config: ENTRY });

  const drift = interpolate(
    frame,
    [0, Math.max(1, durationInFrames - 1)],
    [order % 2 === 0 ? 7 : -7, order % 2 === 0 ? -7 : 7],
  );
  const breathe = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [1, 1.014]);

  const style = layout.style;
  const marker = emphasisWord === null ? null : cased(emphasisWord, style);
  const parts = sized.line.emphasis ? [sized.text] : splitEmphasis(sized.text, marker);

  const wipe = reveal ? Math.min(1, Math.max(0, entry)) : 1;

  return (
    <div
      style={{
        opacity: local < 0 ? 0 : 1,
        transform: `translateY(${interpolate(entry, [0, 1], [44, 0]) + drift}px) scale(${entry * breathe})`,
        clipPath: reveal ? `inset(0 ${(1 - wipe) * 100}% 0 0)` : undefined,
        marginTop: sized.marginTop,
        fontSize: sized.fontSize,
        lineHeight: LAYOUT.lineHeightFactor,
        fontWeight: sized.weight,
        letterSpacing: `${style.trackingEm}em`,
        color: style.ink,
        whiteSpace: 'nowrap',
        willChange: 'transform',
      }}
    >
      {parts.map((part, i) =>
        marker !== null && part.toLowerCase() === marker.toLowerCase() ? (
          <span key={i} style={emphasisStyle(style, sized.fontSize)}>
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </div>
  );
};

const Stack: React.FC<
  TemplateProps & { reveal?: boolean; indent?: (order: number) => number }
> = ({ layout, emphasisWord, durationInFrames, reveal, indent }) => (
  <>
    {layout.lines.map((sized, order) => (
      <div key={order} style={{ marginLeft: indent === undefined ? 0 : indent(order) }}>
        <TypeLine
          sized={sized}
          order={order}
          layout={layout}
          emphasisWord={emphasisWord}
          durationInFrames={durationInFrames}
          {...(reveal === true ? { reveal: true } : {})}
        />
      </div>
    ))}
  </>
);

const Rule: React.FC<{ width: number; layout: BlockLayout }> = ({ width, layout }) =>
  layout.style.rules ? (
    <div
      style={{
        width,
        height: 6,
        backgroundColor: layout.style.ink,
        opacity: 0.85,
        margin: '18px 0',
      }}
    />
  ) : null;

const WordPunch: React.FC<TemplateProps> = (props) => <Stack {...props} />;

const LineStack: React.FC<TemplateProps> = (props) => (
  <Stack {...props} indent={(order) => order * LAYOUT.lineStackIndent} />
);

const StatSlam: React.FC<TemplateProps> = (props) => (
  <>
    <Rule width={RENDER.width * 0.34} layout={props.layout} />
    <Stack {...props} />
    <Rule width={RENDER.width * 0.52} layout={props.layout} />
  </>
);

const QuoteBlock: React.FC<TemplateProps> = (props) => (
  <div style={{ display: 'flex', gap: LAYOUT.quoteBarGap }}>
    <div
      style={{
        width: LAYOUT.quoteBarWidth,
        backgroundColor: props.layout.style.ink,
        opacity: 0.8,
        borderRadius: LAYOUT.quoteBarWidth / 2,
      }}
    />
    <div>
      <Stack {...props} />
    </div>
  </div>
);

/**
 * No index on the frame. The enumeration lives in the narration — "three
 * things followed" — and a stamped "03" over the top reads as a subtitle
 * artefact rather than design.
 */
const Countdown: React.FC<TemplateProps> = (props) => <Stack {...props} />;

const RevealMask: React.FC<TemplateProps> = (props) => <Stack {...props} reveal />;

const TEMPLATES: Record<TemplateName, React.FC<TemplateProps>> = {
  'word-punch': WordPunch,
  'line-stack': LineStack,
  'stat-slam': StatSlam,
  'quote-block': QuoteBlock,
  countdown: Countdown,
  'reveal-mask': RevealMask,
};

export function templateFor(name: TemplateName): React.FC<TemplateProps> {
  return TEMPLATES[name];
}
