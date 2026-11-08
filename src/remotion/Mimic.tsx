import React, { useMemo } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Figure, HERO, type Look } from './stickman/figure.js';
import { RIG, skeletonOf } from './stickman/rig.js';
import { GROUND, H, HALO, Scene, W, type SceneName } from './stickman/scenes.js';
import type { Expression } from './stickman/face.js';
import type { MimicFrame } from '../stages/retarget.js';

/**
 * A clip's choreography, performed by the channel's character in a drawn
 * place.
 *
 * Every frame of the figure comes from the clip (stages/motion.ts finds the
 * person, stages/retarget.ts turns them into the rig's angles); nothing of the
 * clip's picture is here. The camera is the clip's camera too, as far as the
 * person shows it: when the source pushes in on the dancer the figure grows,
 * and the drawn world zooms with it about the floor, so the push-in reads as a
 * camera move rather than a figure inflating on a still background.
 *
 * On top of the performance, the things a motion designer would add: trails
 * behind fast hands and feet, and a hit flash where a move snaps to a stop.
 */

export const MIMIC_COMPOSITION_ID = 'breezematic-mimic';

export type MimicProps = {
  frames: MimicFrame[];
  scene: SceneName;
  seed: number;
  look?: Look;
};

const TRAIL = 7;
/** A person's head against their shoulders, near enough: the rig's own is a cartoon's. */
const HEAD_SCALE = 0.72;

/** Where a frame's hands and feet are on screen. */
function extremities(f: MimicFrame): { x: number; y: number }[] {
  const { joints } = skeletonOf(f.pose);
  const feet = RIG.thigh + RIG.shin;
  const top = f.ground - feet * f.scale;
  return [joints.handL, joints.handR, joints.footL, joints.footR].map((p) => ({ x: f.x + p.x * f.scale, y: top + p.y * f.scale }));
}

/** Frames where a fast move stops: energy peaks well above what came either side. */
function hitsOf(frames: readonly MimicFrame[]): number[] {
  const hits: number[] = [];
  for (let i = 3; i < frames.length - 3; i++) {
    const e = frames[i]!.energy;
    if (e < 0.55) continue;
    const peak = frames.slice(i - 3, i + 4).every((f) => f.energy <= e);
    if (peak && (hits.length === 0 || i - hits[hits.length - 1]! > 8)) hits.push(i);
  }
  return hits;
}

export const Mimic: React.FC<MimicProps> = ({ frames, scene, seed, look = HERO }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const reference = useMemo(() => {
    const scales = frames.map((f) => f.scale).sort((a, b) => a - b);
    return scales[Math.floor(scales.length / 2)] ?? 1;
  }, [frames]);
  const hits = useMemo(() => hitsOf(frames), [frames]);

  const at = Math.min(frames.length - 1, frame);
  const f = frames[at];
  if (f === undefined) return <AbsoluteFill style={{ backgroundColor: '#0b0b10' }} />;

  // The world zooms with the clip's camera, about the floor under the figure.
  const zoom = Math.max(0.85, Math.min(2.4, f.scale / reference));
  const pivotX = W / 2 + (f.x - W / 2) * 0.35;
  const world = `translate(${pivotX},${f.ground}) scale(${zoom}) translate(${-W / 2},${-GROUND})`;

  const expression: Expression = f.energy > 0.6 ? 'determined' : 'happy';
  const halo = HALO[scene];

  // Trails: the last few positions of each hand and foot, fading.
  const history = Array.from({ length: TRAIL }, (_, k) => frames[Math.max(0, at - k)]!).map(extremities);
  const trailOpacity = interpolate(f.energy, [0.15, 0.6], [0, 0.85], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const hit = hits.filter((h) => h <= at && at - h < 9).pop();
  const flash = hit === undefined ? 0 : 1 - (at - hit) / 9;
  const hitPoint = hit === undefined ? null : (() => {
    // The extremity that moved most into the hit is where it lands.
    const now = extremities(frames[hit]!);
    const before = extremities(frames[Math.max(0, hit - 3)]!);
    let best = 0;
    for (let k = 1; k < 4; k++) {
      if (Math.hypot(now[k]!.x - before[k]!.x, now[k]!.y - before[k]!.y) > Math.hypot(now[best]!.x - before[best]!.x, now[best]!.y - before[best]!.y)) best = k;
    }
    return now[best]!;
  })();

  // Instant start: four frames up from black, never a slow fade.
  const open = interpolate(frame, [0, 4], [0, 1], { extrapolateRight: 'clamp' });
  const punch = 1 + flash * 0.025;

  return (
    <AbsoluteFill style={{ backgroundColor: '#0b0b10', overflow: 'hidden' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ position: 'absolute', inset: 0, opacity: open, transform: `scale(${punch})` }}>
        <g transform={world}>
          <Scene name={scene} seed={seed} t={t} pan={0} />
        </g>
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          {trailOpacity > 0
            ? [0, 1, 2, 3].map((k) => {
                const points = history.map((h) => h[k]!);
                return points.slice(0, -1).map((p, i) => {
                  const q = points[i + 1]!;
                  const fade = 1 - i / (TRAIL - 1);
                  return (
                    <line
                      key={`${k}-${i}`}
                      x1={p.x}
                      y1={p.y}
                      x2={q.x}
                      y2={q.y}
                      stroke={k < 2 ? look.accent : '#ffffff'}
                      strokeWidth={f.scale * 3.2 * fade}
                      opacity={trailOpacity * fade * 0.8}
                    />
                  );
                });
              })
            : null}
        </g>
        <Figure
          action="stand"
          posed={f.pose}
          progress={0}
          t={t}
          x={f.x}
          groundY={f.ground}
          scale={f.scale}
          facingRight={false}
          expression={expression}
          look={look}
          prop="none"
          halo={halo}
          appear={1}
          phase={0}
          gaze={0}
          headScale={HEAD_SCALE}
        />
        {hitPoint !== null && flash > 0 ? (
          <g transform={`translate(${hitPoint.x},${hitPoint.y})`} opacity={flash}>
            <circle r={f.scale * (6 + (1 - flash) * 22)} fill="none" stroke="#ffffff" strokeWidth={f.scale * 1.6 * flash} />
            {Array.from({ length: 8 }, (_, i) => {
              const a = (i / 8) * Math.PI * 2 + seed;
              const r0 = f.scale * (9 + (1 - flash) * 18);
              const r1 = r0 + f.scale * 9 * flash;
              return (
                <line
                  key={i}
                  x1={Math.cos(a) * r0}
                  y1={Math.sin(a) * r0}
                  x2={Math.cos(a) * r1}
                  y2={Math.sin(a) * r1}
                  stroke={look.accent}
                  strokeWidth={f.scale * 1.4}
                  strokeLinecap="round"
                />
              );
            })}
          </g>
        ) : null}
      </svg>
      {/* A soft vignette holds the eye on the figure. */}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 55%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.38) 100%)', pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};
