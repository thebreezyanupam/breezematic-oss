import React from 'react';

/**
 * The chair and the crate, in the figure's own units.
 *
 * Both were drawn at one fixed world size, which was right for a Short and
 * twice too big in a long video, where the figure is drawn at under half the
 * scale -- so the hero sat on a chair the size of a wardrobe, a body-length
 * away from its seat. Drawn in the rig's units and scaled with the figure,
 * the seat is where the sitting pose puts the hips at any size: hips at y 14,
 * feet on the floor at y 37, facing -x like the figure does.
 */
export const RIG_FLOOR = 37;

export const Chair: React.FC<{ x: number; groundY: number; scale: number; facingRight: boolean }> = ({ x, groundY, scale, facingRight }) => (
  <g transform={`translate(${x},${groundY - RIG_FLOOR * scale}) scale(${facingRight ? -scale : scale},${scale})`} stroke="#1d1b24" strokeWidth={1.1} strokeLinejoin="round">
    {/* back, behind the hips */}
    <rect x={6.5} y={-12} width={2.8} height={30} rx={0.8} fill="#8a5a36" />
    <rect x={5.8} y={-10} width={4.2} height={3} rx={0.8} fill="#a8703f" />
    {/* legs to the floor */}
    <rect x={-15} y={18} width={2.4} height={RIG_FLOOR - 18} fill="#8a5a36" />
    <rect x={6.8} y={18} width={2.4} height={RIG_FLOOR - 18} fill="#8a5a36" />
    {/* seat, under the thighs */}
    <rect x={-17} y={15.6} width={27.5} height={3.4} rx={1.2} fill="#a8703f" />
  </g>
);

export const Crate: React.FC<{ x: number; groundY: number; scale: number }> = ({ x, groundY, scale }) => (
  <g transform={`translate(${x},${groundY}) scale(${scale})`} stroke="#1d1b24" strokeWidth={1}>
    <rect x={-24} y={-59} width={48} height={59} fill="#c98a4b" />
    <path d="M-24,-59 L24,0 M24,-59 L-24,0" stroke="#8a5a2b" strokeWidth={1.9} />
    <rect x={-24} y={-59} width={48} height={59} fill="none" />
  </g>
);
