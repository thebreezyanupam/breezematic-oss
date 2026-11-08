import { useCurrentFrame } from 'remotion';
import { RENDER } from '../design.js';

export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.075 }) => {
  const frame = useCurrentFrame();
  const shiftX = (frame * 37) % 180;
  const shiftY = (frame * 53) % 180;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        opacity,
        mixBlendMode: 'overlay',
        pointerEvents: 'none',
      }}
    >
      <svg
        width={RENDER.width + 200}
        height={RENDER.height + 200}
        style={{ position: 'absolute', left: -shiftX, top: -shiftY }}
      >
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={7} />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </div>
  );
};
