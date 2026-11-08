import React from 'react';
import { AbsoluteFill } from 'remotion';
import { ICONS } from '../war/icons.js';
import { PaintedCanvas } from './PaintedCanvas.js';
import type { Scene } from './engine.js';

/** Any scene at any size: the website's painted hero is made with this. */
export const PAINT_PLATE_ID = 'breezematic-paint-plate';
export type PlateProps = { scene: Scene; p: number; width: number; height: number };
export const Plate: React.FC<PlateProps> = ({ scene, p, width, height }) => (
  <AbsoluteFill>
    <PaintedCanvas scene={scene} progress={p} width={width} height={height} />
  </AbsoluteFill>
);

/** A development still: one scene at one progress, for looking at the painter. */
export const PAINT_STUDY_ID = 'breezematic-paint-study';
export type StudyProps = { p: number; variant: number };

const SCENES: Omit<Scene, 'seed'>[] = [
  { sky: 'dusk', ground: 'hills', atmosphere: 'wind', light: 'left', subjects: [
    { paths: ICONS['castle']!.paths, x: 0.5, y: 0, place: 'ground', size: 0.66, color: '#c98a5c' },
  ] },
  { sky: 'day', ground: 'sea', atmosphere: 'waves', light: 'right', subjects: [
    { paths: ICONS['galleon']!.paths, x: 0.5, y: 0, place: 'ground', size: 0.68, color: '#9a5f3a' },
  ] },
  { sky: 'night', ground: 'snow', atmosphere: 'snow', light: 'left', subjects: [
    { paths: ICONS['horse']!.paths, x: 0.38, y: 0, place: 'ground', size: 0.5, color: '#7a4f38' },
    { paths: ICONS['flag']!.paths, x: 0.75, y: 0, place: 'ground', size: 0.34, color: '#c0392b' },
  ] },
];

export const Study: React.FC<StudyProps> = ({ p, variant }) => (
  <AbsoluteFill>
    <PaintedCanvas scene={{ ...SCENES[variant % SCENES.length]!, seed: 7 + variant }} progress={p} width={1080} height={1920} />
  </AbsoluteFill>
);
