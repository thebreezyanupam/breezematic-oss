import { Composition } from 'remotion';
import { COMPOSITION_ID, RENDER } from '../design.js';
import { KineticVideo } from './KineticVideo.js';
import { Essay, type EssayProps } from './Essay.js';
import { Mimic, MIMIC_COMPOSITION_ID, type MimicProps } from './Mimic.js';
import { Study, PAINT_STUDY_ID, Plate, PAINT_PLATE_ID, type PlateProps } from './painted/Study.js';
import { Thumbnail, THUMBNAIL_COMPOSITION_ID, THUMBNAIL_SIZE, emptyThumbnail } from './Thumbnail.js';
import { parseBeatSheet, type BeatSheet } from '../schema.js';
import fixture from '../../fixtures/stub.beatsheet.json';

const defaultSheet: BeatSheet = parseBeatSheet(fixture);

/**
 * Landscape, because long-form is watched on a television or a second monitor
 * and the shorts composition is 9:16. The two share a bundle and nothing else.
 */
export const ESSAY_COMPOSITION_ID = 'breezematic-essay';
export const ESSAY_RENDER = { width: 1920, height: 1080, fps: 30 } as const;

const emptyEssay: EssayProps = {
  title: '',
  lines: [],
  durationMs: 1000,
  variation: { composition: 'left-low', emphasis: 'oxblood', direction: 'in' },
  seed: 0,
};

export const Root: React.FC = () => (
  <>
  <Composition
    id={COMPOSITION_ID}
    component={KineticVideo}
    width={RENDER.width}
    height={RENDER.height}
    fps={RENDER.fps}
    durationInFrames={Math.round((defaultSheet.meta.durationMs / 1000) * RENDER.fps)}
    defaultProps={{ sheet: defaultSheet }}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(
        1,
        Math.round((props.sheet.meta.durationMs / 1000) * RENDER.fps),
      ),
      fps: RENDER.fps,
      width: RENDER.width,
      height: RENDER.height,
    })}
  />
  <Composition
    id={ESSAY_COMPOSITION_ID}
    component={Essay}
    width={ESSAY_RENDER.width}
    height={ESSAY_RENDER.height}
    fps={ESSAY_RENDER.fps}
    durationInFrames={30}
    defaultProps={emptyEssay}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, Math.round((props.durationMs / 1000) * ESSAY_RENDER.fps)),
      fps: ESSAY_RENDER.fps,
      width: ESSAY_RENDER.width,
      height: ESSAY_RENDER.height,
    })}
  />
  <Composition
    id={MIMIC_COMPOSITION_ID}
    component={Mimic}
    width={RENDER.width}
    height={RENDER.height}
    fps={RENDER.fps}
    durationInFrames={30}
    defaultProps={{ frames: [], scene: 'stage', seed: 0 } as MimicProps}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, props.frames.length),
      fps: RENDER.fps,
      width: RENDER.width,
      height: RENDER.height,
    })}
  />
  <Composition
    id={PAINT_STUDY_ID}
    component={Study}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={1}
    defaultProps={{ p: 1, variant: 0 }}
  />
  <Composition
    id={PAINT_PLATE_ID}
    component={Plate}
    width={1600}
    height={1000}
    fps={30}
    durationInFrames={1}
    defaultProps={{ scene: { sky: 'day', ground: 'hills', atmosphere: 'none', light: 'left', subjects: [], seed: 1 }, p: 1, width: 1600, height: 1000 } as PlateProps}
    calculateMetadata={({ props }) => ({ width: props.width, height: props.height })}
  />
  <Composition
    id={THUMBNAIL_COMPOSITION_ID}
    component={Thumbnail}
    width={THUMBNAIL_SIZE.width}
    height={THUMBNAIL_SIZE.height}
    fps={30}
    durationInFrames={1}
    defaultProps={emptyThumbnail}
  />
  </>
);
