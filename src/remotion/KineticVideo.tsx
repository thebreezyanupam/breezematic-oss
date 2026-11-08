import { AbsoluteFill, Sequence } from 'remotion';
import { LAYOUT, RENDER } from '../design.js';
import { Background } from './Background.js';
import { Grain } from './Grain.js';
import { familyForLanguage, useInterFont } from './font.js';
import { language } from '../languages.js';
import { layoutBeat } from './layout.js';
import { templateFor } from './templates.js';
import { Whiteboard } from './Whiteboard.js';
import { Stickman } from './Stickman.js';
import { Storybook, type NextPanel } from './Storybook.js';
import { ExplainerVideo } from './explainer/ExplainerVideo.js';
import { PaintedVideo } from './painted/PaintedVideo.js';
import {
  beatWords,
  type Beat,
  type BeatSheet,
  type EffectName,
  type ImageryMode,
  type BoardContent,
  type BoardImagery,
  type BoardTheme,
  type RenderMode,
  type SubtitleMode,
  type StyleName,
  type Word,
} from '../schema.js';

const msToFrames = (ms: number): number => Math.round((ms / 1000) * RENDER.fps);

const BeatScene: React.FC<{
  beat: Beat;
  seed: number;
  effect: EffectName;
  imagery: ImageryMode;
  style: StyleName;
  captionScale: number;
  subtitles: SubtitleMode;
  mode: RenderMode;
  textured: boolean;
  /** Storybook only: lay the effect field over the panels. */
  panelTexture: boolean;
  boardTheme: BoardTheme;
  boardContent: BoardContent;
  boardImagery: BoardImagery;
  words: readonly Word[];
  index: number;
  durationInFrames: number;
  /** The next beat's picture, for a mode that dissolves rather than cuts. */
  nextPanel?: NextPanel | null;
  /** The face this video's words are drawn in, decided by its language. */
  fontFamily: string;
  /** The stick figure's scene in the beat before, for the change-of-place move. */
  previousScene?: string | null;
}> = ({ beat, seed, effect, imagery, style, captionScale, subtitles, mode, textured, panelTexture, boardTheme, boardContent, boardImagery, words, index, durationInFrames, nextPanel, previousScene, fontFamily }) => {
  const displayWords = beatWords(beat.lines);
  const emphasisWord =
    beat.emphasisWordIndex === null ? null : (displayWords[beat.emphasisWordIndex] ?? null);
  // The same family goes to the fitter and to the element that draws it. Two
  // different answers here is the bug this argument exists to make impossible.
  const layout = layoutBeat(beat, seed, emphasisWord, style, captionScale, fontFamily);
  const Template = templateFor(beat.template);

  // The panel carries its own caption, so it replaces the scene outright
  // rather than sitting behind the kinetic type the way a background does.

  if (mode === 'whiteboard') {
    return (
      <AbsoluteFill>
        <Whiteboard
          beat={beat}
          words={words}
          durationInFrames={durationInFrames}
          captionScale={captionScale}
          effect={effect}
          seed={seed}
          textured={textured}
          theme={boardTheme}
          content={boardContent}
          imagery={boardImagery}
        />
      </AbsoluteFill>
    );
  }

  /**
   * The figure holds the lower third, so the type is pushed into the upper
   * half rather than centred over it. Everything else -- fitting, templates,
   * emphasis -- is the kinetic path unchanged.
   */
  const onStage = mode === 'stickman';
  /**
   * The panel replaces the background rather than sitting behind it, and it
   * draws its own caption unless the kinetic type is going to. Falling through
   * to the shared type layer rather than returning early is what lets
   * "kinetic" subtitles exist at all: the panel and the animated type are the
   * same composition with two picture layers, not two different scenes.
   */
  const asPanel = mode === 'storybook';
  const panelOwnsCaption = asPanel && subtitles !== 'kinetic';

  return (
    <AbsoluteFill>
      {asPanel ? (
        <Storybook
          beat={beat}
          seed={seed}
          next={nextPanel}
          durationInFrames={durationInFrames}
          fontFamily={fontFamily}
          // The real value, not a translation of it. Passing 'none' here to
          // mean "draw no caption" also told the panel there was no type to
          // light, so the scrim it owes the animated captions never appeared
          // and they rendered white on white. Storybook already reads
          // 'kinetic' as "someone else is drawing the words".
          subtitles={subtitles}
          captionScale={captionScale}
          // Null unless the panel texture is on, so an illustrated video made
          // before this existed renders exactly as it did: every sheet ever
          // written carries an effect, and most of them never meant it to show.
          effect={panelTexture ? effect : null}
        />
      ) : null}
      {onStage ? (
        <Stickman
          beat={beat}
          action={beat.action ?? 'stand'}
          seed={seed}
          durationInFrames={durationInFrames}
          direction={beat.stage}
          previousScene={previousScene ?? null}
        />
      ) : null}
      {onStage || asPanel ? null : <Background
        beat={beat}
        seed={seed}
        effect={effect}
        imagery={imagery}
        durationInFrames={durationInFrames}
        cinema={mode === 'cinema'}
      />}
      {panelOwnsCaption ? null : (
      <AbsoluteFill
        style={{
          paddingTop: RENDER.height * RENDER.safeTopFraction,
          paddingBottom: onStage
            ? RENDER.height * 0.52
            : RENDER.height * RENDER.safeBottomFraction,
          paddingLeft: LAYOUT.sidePaddingPx,
          paddingRight: LAYOUT.sidePaddingPx,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: layout.align,
          textAlign: layout.textAlign,
          fontFamily,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: layout.align,
            transform: `translateX(${layout.offsetX}px) rotate(${layout.rotation}deg)`,
          }}
        >
          <Template
            layout={layout}
            emphasisWord={emphasisWord}
            index={index}
            durationInFrames={durationInFrames}
          />
        </div>
      </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

export const KineticVideo: React.FC<{ sheet: BeatSheet }> = ({ sheet }) => {
  const fontReady = useInterFont();
  const fontFamily = familyForLanguage(language(sheet.meta.language).font);

  // The explainer is its own edit: its transitions, captions and plug span
  // beats, so it cannot be one more branch inside a single beat's scene.
  if (sheet.meta.mode === 'explainer') {
    return fontReady ? <ExplainerVideo sheet={sheet} fontFamily={fontFamily} /> : null;
  }
  // The painted mode paints its own scenes and writes its own words.
  if (sheet.meta.mode === 'painted') {
    return fontReady ? <PaintedVideo sheet={sheet} /> : null;
  }

  return (
    <AbsoluteFill style={{ backgroundColor: '#05070d' }}>
      {!fontReady ? null : sheet.beats.map((beat, index) => {
        const from = msToFrames(beat.startMs);
        const duration = Math.max(1, msToFrames(beat.endMs) - from);
        // The beat after this one, described rather than named: the panel that
        // is leaving draws it, and to draw it at the scale it is about to open
        // on it needs the beat's id and its length, not just its file.
        const after = sheet.beats[index + 1];
        const afterFile = after?.background.image?.file ?? null;
        const nextPanel: NextPanel | null =
          after === undefined || afterFile === null
            ? null
            : {
                file: afterFile,
                id: after.id,
                durationInFrames: Math.max(1, msToFrames(after.endMs) - msToFrames(after.startMs)),
              };
        return (
          <Sequence key={beat.id} from={from} durationInFrames={duration} name={beat.id}>
            <BeatScene
              beat={beat}
              seed={sheet.meta.seed}
              effect={sheet.meta.effect}
              imagery={sheet.meta.imagery}
              style={sheet.meta.style}
              captionScale={sheet.meta.captionScale}
              subtitles={sheet.meta.subtitles}
              mode={sheet.meta.mode}
              textured={sheet.meta.boardTexture}
              panelTexture={sheet.meta.panelTexture}
              boardTheme={sheet.meta.boardTheme}
              boardContent={sheet.meta.boardContent}
              boardImagery={sheet.meta.boardImagery}
              words={sheet.words.filter(
                (word) => word.startMs < beat.endMs && word.endMs > beat.startMs,
              )}
              index={index}
              nextPanel={nextPanel}
              previousScene={index > 0 ? (sheet.beats[index - 1]?.stage?.scene ?? null) : null}
              durationInFrames={duration}
              fontFamily={fontFamily}
            />
          </Sequence>
        );
      })}
      <Grain />
    </AbsoluteFill>
  );
};
