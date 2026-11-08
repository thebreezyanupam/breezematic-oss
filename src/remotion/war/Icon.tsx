import React from 'react';
import { ICONS } from './icons.js';

/**
 * One icon from the set, drawn inline in whatever SVG it is placed in.
 *
 * Centred on (x, y) at `size` wide, so a caller places the middle of the thing
 * rather than the corner of a 512 box. The outline is a stroke drawn under the
 * fill, the same way the stick figures are outlined, so an icon sitting in a
 * painted world reads as part of the same drawing.
 */
export const IconGlyph: React.FC<{
  name: string;
  size: number;
  x?: number;
  y?: number;
  fill?: string;
  /** Outline colour, drawn behind the fill. */
  outline?: string;
  /** Outline width in the icon's own 512 units. */
  outlineWidth?: number;
  rotate?: number;
  flip?: boolean;
  opacity?: number;
}> = ({ name, size, x = 0, y = 0, fill = '#1d1b24', outline, outlineWidth = 36, rotate = 0, flip = false, opacity = 1 }) => {
  const icon = ICONS[name];
  if (icon === undefined) return null;
  const k = size / 512;
  return (
    <g
      transform={`translate(${x},${y}) rotate(${rotate}) scale(${flip ? -k : k},${k}) translate(-256,-256)`}
      opacity={opacity}
    >
      {outline === undefined
        ? null
        : icon.paths.map((d, i) => (
            <path key={`o${i}`} d={d} fill={outline} stroke={outline} strokeWidth={outlineWidth} strokeLinejoin="round" />
          ))}
      {icon.paths.map((d, i) => (
        <path key={i} d={d} fill={fill} />
      ))}
    </g>
  );
};

export const hasIcon = (name: unknown): name is string => typeof name === 'string' && ICONS[name] !== undefined;
