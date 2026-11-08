import React, { useLayoutEffect, useRef, useState } from 'react';
import { continueRender, delayRender } from 'remotion';
import { paint, type Scene } from './engine.js';

/**
 * One painted scene at one moment. The paint happens in a layout effect, and
 * the frame is held (delayRender) until it has: a WebGL pass is synchronous,
 * but Remotion must not capture the frame between the commit and the effect.
 */
export const PaintedCanvas: React.FC<{ scene: Scene; progress: number; width: number; height: number }> = ({
  scene,
  progress,
  width,
  height,
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  // Held only until the first paint: later frames paint inside the same
  // synchronous commit Remotion waits on, like any canvas drawn per frame.
  const [handle] = useState(() => delayRender('painting a beat'));
  const released = useRef(false);
  useLayoutEffect(() => {
    const out = ref.current;
    if (out !== null) {
      try {
        paint(out, scene, progress);
      } catch (error) {
        // A failed paint leaves paper rather than holding the render forever.
        console.error('painted: ' + (error as Error).message);
      }
    }
    if (!released.current) {
      released.current = true;
      continueRender(handle);
    }
  }, [scene, progress, handle]);
  return <canvas ref={ref} width={width} height={height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
};
