import { interpolate, useCurrentFrame } from 'remotion';
import { SUBSCRIBE_TIMING } from '../../explainer.js';
import { EX, easeOut, msToFrame, pop, ramp } from './theme.js';

/**
 * The subscribe plug: the same card, the same cursor, the same click, in
 * every video.
 *
 * Consistency is the whole point of it. A viewer who has seen three of these
 * recognises the fourth before the word is finished, and that recognition is
 * what makes a channel feel like a channel rather than a feed of unrelated
 * videos. So nothing here is seeded and nothing varies with the topic.
 *
 * It is drawn over everything and timed to the word: the card is up a moment
 * before "subscribe" is said, the cursor presses the button just after, the
 * button turns to "Subscribed" and the bell rings. The sounds under it are
 * placed from the same timings (SUBSCRIBE_TIMING), in the mix.
 */
export const SubscribePlug: React.FC<{ fontFamily: string; channel: string }> = ({ fontFamily, channel }) => {
  const frame = useCurrentFrame();
  const click = msToFrame(SUBSCRIBE_TIMING.leadMs + SUBSCRIBE_TIMING.clickMs);
  const bell = msToFrame(SUBSCRIBE_TIMING.leadMs + SUBSCRIBE_TIMING.bellMs);
  const hold = msToFrame(SUBSCRIBE_TIMING.leadMs + SUBSCRIBE_TIMING.holdMs);

  const enter = pop(frame, 0, { damping: 13, stiffness: 210, mass: 0.6 });
  const leave = interpolate(frame, [hold - 8, hold], [0, 1], { easing: easeOut, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (frame > hold) return null;

  const pressed = frame >= click;
  const press = frame >= click - 2 && frame < click + 4 ? 0.92 : 1;
  const ripple = ramp(frame, click, 14);

  // The cursor comes in from the lower right and settles on the button.
  const cursorIn = interpolate(frame, [4, click - 2], [0, 1], { easing: easeOut, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const cursorX = 980 - 210 * cursorIn;
  const cursorY = 1400 - 270 * cursorIn;

  const ring = frame >= bell ? Math.sin((frame - bell) * 1.3) * 22 * Math.max(0, 1 - (frame - bell) / 18) : 0;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 70,
          right: 70,
          top: 1040,
          height: 170,
          borderRadius: 40,
          background: '#ffffff',
          boxShadow: '0 30px 90px rgba(0,0,0,0.55)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 26px 0 30px',
          gap: 24,
          opacity: Math.min(1, enter * 1.4) * (1 - leave),
          transform: `translateY(${(1 - enter) * 220 + leave * 160}px) scale(${0.9 + 0.1 * Math.min(1, enter)})`,
        }}
      >
        {/* The bell: the mark of the card, rung once the button is pressed. */}
        <div
          style={{
            flex: '0 0 auto',
            width: 104,
            height: 104,
            borderRadius: '50%',
            background: pressed ? EX.accent : '#f1f1f1',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `rotate(${ring}deg)`,
            transformOrigin: '50% 20%',
          }}
        >
          <svg width={60} height={60} viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily, fontWeight: 850, fontSize: 46, color: '#0f0f0f', letterSpacing: '-0.02em', lineHeight: 1.05, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {channel}
          </div>
          <div style={{ fontFamily, fontWeight: 600, fontSize: 32, color: '#606060', marginTop: 6 }}>
            {pressed ? 'See you in the next one' : 'New explainers every week'}
          </div>
        </div>
        <div
          style={{
            position: 'relative',
            flex: '0 0 auto',
            height: 92,
            padding: '0 34px',
            borderRadius: 46,
            background: pressed ? '#e5e5e5' : '#e62117',
            color: pressed ? '#0f0f0f' : '#ffffff',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontFamily,
            fontWeight: 850,
            fontSize: 36,
            letterSpacing: '0.01em',
            transform: `scale(${press})`,
            overflow: 'hidden',
          }}
        >
          {pressed ? (
            <svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="#0f0f0f" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          ) : null}
          {pressed ? 'Subscribed' : 'Subscribe'}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 320,
              height: 320,
              marginLeft: -160,
              marginTop: -160,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.45)',
              opacity: ripple > 0 && ripple < 1 ? 1 - ripple : 0,
              transform: `scale(${ripple})`,
            }}
          />
        </div>
      </div>

      {/* The cursor, over the card. */}
      <svg
        width={74}
        height={74}
        viewBox="0 0 24 24"
        style={{
          position: 'absolute',
          left: cursorX,
          top: cursorY,
          opacity: Math.min(1, cursorIn * 3) * (1 - leave),
          transform: `scale(${press === 1 ? 1 : 0.88})`,
          filter: 'drop-shadow(0 6px 10px rgba(0,0,0,0.45))',
        }}
      >
        <path d="M4 2.5l15 9.2-6.4 1.4 3.7 7.1-2.6 1.3-3.7-7.2L5 19z" fill="#ffffff" stroke="#111111" strokeWidth={1.4} strokeLinejoin="round" />
      </svg>
    </div>
  );
};
