import path from 'node:path';
import { workSlug } from '../workslug.js';
import { AUDIO, ROOT, env, workDir } from '../config.js';
import { CAPTION_SCALE, TREATMENT } from '../design.js';
import { hashString, rngFor } from '../rng.js';
import { log } from '../log.js';
import { language, readerFor } from '../languages.js';
import { slugify } from '../text.js';
import {
  beatWords,
  isFootageFile,
  parseBeatSheet,
  MUSIC_FADE_IN_MS,
  MUSIC_FADE_OUT_MS,
  TEMPLATE_NAMES,
  type BeatImage,
  type BeatSheet,
  type EffectName,
  type ImageryMode,
  type ImageSource,
  type StyleName,
  type SubtitleMode,
  type ArtStyle,
  type SfxCue,
  type TemplateName,
  type RenderMode,
  type BoardContent,
  type BoardImagery,
  type BoardTheme,
} from '../schema.js';
import { adaptScript } from './adapt.js';
import { NO_TEXT, generateBeatImages, type ArtOverride } from './imagegen.js';
import { generateSketches } from './sketch.js';
import { assertConfigured as assertImageProvider } from '../providers/flux.js';
import { assertConfigured as assertFreeImageProvider } from '../providers/cloudflare.js';
import { generateScript, scriptFromText } from './script.js';
import { synthesizeVoice } from './voice.js';
import { alignWords } from './align.js';
import { buildBeatSheet, timeDisplayTokens, type PlanResult } from './plan.js';
import { chooseTrack } from './music.js';
import { chooseImages, writeCredits } from './images.js';
import { chooseFootage, writeShotQueries } from './footage.js';
import { preferSubjects, writePhotoQueries } from './subjects.js';
import { chooseOwn, overlayOwn, remaining } from './own.js';
import { setSpendContext } from '../spend.js';
import { directStickman } from './action.js';
import { phrasesOf, timedWar } from './stickworld.js';

import { paintSettings, type StickBeat, type StickWorld } from './stickworld.js';
import { ART_DIRECTION as STORY_ART, generatePanels } from './storybook.js';
import { directGraphics } from './graphics.js';
import { directPainting, writePaintCredits } from './paintdirect.js';
import { readConnection } from '../providers/youtube.js';
import { EXPLAINER_BEAT_MS, OUTRO_MS, type Graphic } from '../explainer.js';

/**
 * Which beats get a clip when the source is "mix", as a seeded pattern.
 *
 * Decided before either fetch rather than after, so each source is only asked
 * for the beats it actually owns: a mixed run downloads about half the footage
 * of a pure video run instead of fetching both sets and discarding one.
 *
 * A fair coin alone is not enough. Over twenty beats it reliably produces runs
 * of four or five of the same kind, and a stretch that long stops reading as a
 * mix and starts reading as a mistake — so a third in a row is flipped. The
 * result is still uneven, which is the point; strict alternation reads as a
 * pattern rather than as variety.
 */
function footagePattern(count: number, seed: number): boolean[] {
  const rng = rngFor(seed, 'mix');
  const out: boolean[] = [];
  let previous: boolean | null = null;
  let run = 0;

  for (let index = 0; index < count; index++) {
    let clip = rng() < 0.5;
    if (clip === previous && run >= 2) clip = !clip;
    run = clip === previous ? run + 1 : 1;
    previous = clip;
    out.push(clip);
  }
  return out;
}

/**
 * Footage is blurred and scrimmed less than a still, per beat.
 *
 * The reason to reach for video is the movement, and a heavy blur is the first
 * thing that takes it away — blurred to a smear it is indistinguishable from a
 * photograph that costs more to fetch. The scrim comes down with it, but only
 * slightly: it is what holds the type legible over a picture, and a moving
 * picture needs that more than a still does, not less.
 *
 * Per beat rather than per sheet, because "mix" puts both kinds in one video.
 */
function footageTreatment(
  background: BeatSheet['beats'][number]['background'],
  image: BeatImage | null,
): BeatSheet['beats'][number]['background'] {
  if (image === null || !isFootageFile(image.file)) return { ...background, image };
  return {
    ...background,
    image,
    blurPx: Math.round(background.blurPx * TREATMENT.footageBlurScale),
    scrimOpacity:
      Math.round(background.scrimOpacity * TREATMENT.footageScrimScale * 100) / 100,
  };
}

function longestBeat(sheet: BeatSheet): number {
  return sheet.beats.reduce((longest, beat) => Math.max(longest, beat.endMs - beat.startMs), 0);
}

/**
 * Half stills, half footage, decided per beat.
 *
 * Both sources are asked only for the beats the pattern gave them -- each
 * honours a blank line by fetching nothing -- so the two lists interleave
 * exactly, with no overlap to resolve and nothing downloaded twice.
 *
 * A beat whose own source came back empty is left empty rather than filled from
 * the other one. The other source was never asked about that beat, so anything
 * it could offer would be a picture chosen for a different beat entirely.
 */
async function mixSources(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
  force: boolean;
  longestBeatMs: number;
}): Promise<(BeatImage | null)[]> {
  const wantsClip = footagePattern(options.beatTexts.length, options.seed);
  const mask = (want: boolean) =>
    options.beatTexts.map((text, index) => (wantsClip[index] === want ? text : ''));

  // Written once for the whole script, not once per half. Both sources are
  // then searching for the same set of shots, so the video holds together
  // across the join instead of reading as two videos cut together.
  const queries = await writeShotQueries({
    topic: options.topic,
    script: options.script,
    beatTexts: options.beatTexts,
    seed: options.seed,
  });

  /**
   * Except when the video is about a named work, where one set cannot serve
   * both. A stock library has no photograph of a named character and Commons
   * has no clip of rain on a window that is about the subject, so the halves
   * are searched on what their own library is indexed by. The clips keep the
   * described shots, which is what Pexels answers to.
   */
  const subjects = await writePhotoQueries({
    topic: options.topic,
    script: options.script,
    beatTexts: mask(false),
    seed: options.seed,
  });

  const clips = await chooseFootage({
    topic: options.topic,
    script: options.script,
    beatTexts: mask(true),
    seed: options.seed,
    force: options.force,
    longestBeatMs: options.longestBeatMs,
    queries,
  });
  const stills = await chooseImages({
    topic: options.topic,
    seed: options.seed,
    beatTexts: mask(false),
    force: options.force,
    queries: subjects.work === null ? queries : preferSubjects(subjects.queries, queries),
    // For a named work the topic pool is off-subject rather than merely
    // broad, so a beat that finds nothing keeps its field instead.
    ...(subjects.work === null
      ? {}
      : { ownQueryOnly: true, mustMention: subjects.names }),
  });

  const mixed = options.beatTexts.map((_, index) =>
    wantsClip[index] === true ? (clips[index] ?? null) : (stills[index] ?? null),
  );
  const clipCount = mixed.filter((image) => image !== null && isFootageFile(image.file)).length;
  log.info(
    `mix: ${clipCount} clip(s) and ${mixed.filter((i) => i !== null).length - clipCount} still(s) ` +
      `across ${mixed.length} beats`,
  );
  return mixed;
}

/**
 * What the still search should ask for.
 *
 * A video about a named work and a video about the world need opposite
 * questions of the same library. "Describe the shot, never name anyone" is
 * right for a topic about entropy and it is the reason a video about Naruto
 * came back illustrated with a bowl of ramen and Keanu Reeves: the one thing
 * that would have found the subject was the thing the rules forbade.
 *
 * So the subject writer goes first and is allowed to decline. It reports no
 * work for most topics, and those fall through to the shot descriptions
 * unchanged.
 */
async function stillQueries(options: {
  topic: string;
  script: string;
  beatTexts: readonly string[];
  seed: number;
}): Promise<string[]> {
  const [shots, subjects] = await Promise.all([
    writeShotQueries(options),
    writePhotoQueries(options),
  ]);
  return subjects.work === null ? shots : preferSubjects(subjects.queries, shots);
}

export const DEFAULT_EFFECT: EffectName = 'static';
export const DEFAULT_IMAGERY: ImageryMode = 'blend';
export const DEFAULT_STYLE: StyleName = 'editorial';
/**
 * The two cues that mark structure: the picture changing, and the turn before
 * a reversal. Impact and click are written into every sheet and left silent
 * until somebody asks for them -- a thud on every emphasised word and a tick
 * under every line of type are decoration, and decoration should be a choice.
 */
export const DEFAULT_SFX_CUES: readonly SfxCue[] = ['whoosh', 'riser'];

export type PipelineStage = 'script' | 'voice' | 'align' | 'plan';

export type ProduceOptions = {
  topic: string;
  seed?: number;
  /**
   * What it is written and read in. Defaults to English, which is what every
   * video made before this existed was.
   */
  language?: string;
  variant: number;
  force: boolean;
  /** Hand-written narration; when set, nothing is written for you. */
  script?: string;
  /** Shape a pasted script into beats before it is spoken. On unless refused. */
  adapt?: boolean;
  /** Who reads it: a roster id from src/voices.ts. */
  character?: string;
  /** Which engine reads it: 'kokoro' (local, free) or 'gemini' (hosted). */
  ttsProvider?: string;
  /** The register it is written in: a roster id from src/tones.ts. */
  tone?: string;
  effect?: EffectName;
  /** assets/music filename, 'none' to go without, or undefined to pick by seed. */
  music?: string;
  /** How loud the bed sits, in LUFS. */
  musicLufs?: number;
  /** Bed fades, in ms. */
  musicFadeInMs?: number;
  musicFadeOutMs?: number;
  /** Where in the track to start, in ms. Overrides the seeded pick. */
  musicStartMs?: number;
  imagery?: ImageryMode;
  /** Where the pictures come from; ignored when imagery is off. */
  imageSource?: ImageSource;
  /** How many pictures to generate and deal across the beats. */
  imageCount?: number;
  style?: StyleName;
  /** Multiplier on how much of the safe area the captions aim to fill. */
  captionScale?: number;
  /** Storybook only: how the words sit on the panel, or whether they do. */
  subtitles?: SubtitleMode;
  /** Storybook only: the drawing style every panel shares. */
  artStyle?: ArtStyle;
  /**
   * The stick figure's world: drawn scenes (free), or backgrounds painted for
   * the story's actual places, one per place (about a third of a cent each).
   */
  stickWorld?: StickWorld;
  /** Storybook only: lay the effect field over the panels. */
  panelTexture?: boolean;
  /** Which sound-effect cues are audible. The sheet records the rest anyway. */
  sfxCues?: readonly SfxCue[];
  /** Which cloned voice reads it, when the engine is 'clone'. */
  cloneVoice?: string;
  /**
   * Stick figure only: which channel it is for. 'war' stages it as the war
   * channel does in long form -- uniforms, armies, animals, sounds on the
   * word, freeze-frames, stickers and maps.
   */
  niche?: 'books' | 'war';
  /** Which ElevenLabs voice reads it, by id, when the engine is 'elevenlabs'. */
  elevenVoice?: string;
  /** The series this belongs to, by id. */
  series?: string | null;
  /** Picture layer: kinetic type, or writing on paper. */
  mode?: RenderMode;
  /** Free text saying what the topic means and what kind of video is wanted. */
  brief?: string;
  /** Whiteboard only: lay the shader field under the paper. */
  boardTexture?: boolean;
  boardTheme?: BoardTheme;
  boardContent?: BoardContent;
  boardImagery?: BoardImagery;
  onStage?: (stage: PipelineStage) => void;
  /** Line-by-line through the reading, the longest stage in a long script. */
  onProgress?: (done: number, total: number) => void;
};

/**
 * Script -> voice -> alignment -> beat sheet. This is the generation half of
 * the pipeline; render and mix consume what it writes. Both the CLI and the
 * app call this one function — neither owns a private composition of stages.
 */
export async function produceBeatSheet(options: ProduceOptions): Promise<PlanResult> {
  const slug = workSlug('short', options.topic);
  // Here rather than only in the web app, so a run driven from the command
  // line is attributed to its video too. The cap is enforced where a person
  // can answer for it; the accounting happens wherever the money goes.
  setSpendContext(slug);
  const seed = options.seed ?? hashString(slug);
  const stage = options.onStage ?? (() => undefined);
  const spoken = language(options.language);
  /**
   * The reader has to be one that speaks it.
   *
   * Switching a video to Hindi without touching the voice setting is the
   * normal way to arrive here, so this corrects rather than refuses -- but it
   * says so, because the correction can move a run from the free local engine
   * onto a paid one and finding that out from the bill is not acceptable.
   */
  const askedReader = options.ttsProvider;
  const reader = readerFor(spoken.id, askedReader);
  if (askedReader !== undefined && reader !== askedReader) {
    log.warn(
      `voice: the ${askedReader} reader has no ${spoken.label}; reading it with ${reader} instead`,
    );
  }
  const imageSource = options.imageSource ?? env.IMAGE_SOURCE;
  const mode = options.mode ?? 'kinetic';
  // Nothing in the whiteboard draws a photograph, so fetching one is spend
  // with no output. The app disables the control; this makes it true.
  /**
   * Cinema is the edit, and the edit is over a full-bleed picture. "photo"
   * prints a small tilted stamp on the frame, which a snap zoom and a recut
   * would simply jiggle — so the mode picks its own imagery rather than
   * rendering something the treatment cannot act on.
   */
  /**
   * The explainer is built on its pictures -- every graphic sits over one --
   * so like cinema it does not offer "off".
   */
  const imagery =
    mode === 'whiteboard' || mode === 'stickman' || mode === 'painted'
      ? 'off'
      : mode === 'cinema' || mode === 'storybook' || mode === 'explainer'
        ? 'blend'
        : (options.imagery ?? DEFAULT_IMAGERY);

  // Nothing below is cheap, and a missing key for the pictures is the operator's
  // to fix. Fail before a minute of narration has been synthesised for a video
  // that would come out with no images in it.
  if (imagery !== 'off' && (imageSource === 'ai' || mode === 'storybook')) assertImageProvider();
  if (imagery !== 'off' && imageSource === 'ai-free') assertFreeImageProvider();

  // A cut into a photograph is still a cut, so this is a warning rather than a
  // refusal — but half the edit (the speed) has nothing to act on without
  // motion, and it is better said out loud than discovered in the output.
  if (mode === 'cinema' && imageSource !== 'video' && imageSource !== 'mix') {
    log.warn(
      `cinema: picture source is "${imageSource}", so every shot is a still — ` +
        'the snap zooms and recuts still work, the speed changes have nothing to slow down',
    );
  }

  stage('script');
  const script =
    options.script !== undefined && options.script.trim() !== ''
      ? scriptFromText({ text: await prepareScript(options), index: options.variant })
      : await generateScript({
          topic: options.topic,
          seed,
          index: options.variant,
          force: options.force,
          ...(options.tone !== undefined ? { tone: options.tone } : {}),
          ...(options.brief !== undefined ? { brief: options.brief } : {}),
          language: spoken.id,
          ...(mode === 'explainer' ? { format: 'explainer' as const } : {}),
        });

  stage('voice');
  const voice = await synthesizeVoice({
    spokenText: script.spokenText,
    slug,
    force: options.force,
    ...(options.character !== undefined ? { character: options.character } : {}),
    // The resolved reader, not the asked-for one: it has already been checked
    // against the language, and passing the original here would put the check
    // back where it was -- after the money was spent.
    provider: reader,
    language: spoken.id,
    ...(options.cloneVoice !== undefined ? { cloneVoice: options.cloneVoice } : {}),
    ...(options.elevenVoice !== undefined ? { elevenVoice: options.elevenVoice } : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    // A cloned reading is generated, so it is seeded like the pictures and the
    // script rather than being the one part that differs every render.
    seed,
  });

  stage('align');
  const alignment = await alignWords({
    audioPath: voice.alignPath,
    spokenText: script.spokenText,
    durationMs: voice.durationMs,
    force: options.force,
    language: spoken.id,
  });

  stage('plan');
  const track = await chooseTrack({
    seed,
    slug,
    ...(options.music !== undefined ? { preferred: options.music } : {}),
    durationMs: voice.durationMs,
  });
  if (track !== null) log.info(`music: ${track.name} from ${track.startOffsetMs}ms`);

  const planned = buildBeatSheet({
    topic: options.topic,
    slug,
    seed,
    language: spoken.id,
    draft: script.draft,
    script: {
      hook: script.hook,
      body: script.body,
      fullText: script.fullText,
      spokenText: script.spokenText,
      pronunciation: script.pronunciation,
    },
    words: alignment.words,
    voice: {
      audioPath: path.relative(ROOT, voice.audioPath).split(path.sep).join('/'),
      provider: voice.provider,
      voiceId: voice.voiceId,
      character: voice.character,
    },
    /**
     * The reading is trimmed to its last word, so a video exactly as long as
     * it ends mid-gesture: the voice stops and the picture is gone in the same
     * frame. The explainer holds on for a moment after, which is what lets the
     * frame settle and the music fade instead of the whole thing being cut off.
     */
    durationMs: voice.durationMs + (mode === 'explainer' ? OUTRO_MS : 0),
    // A painting needs a few seconds to come in, so painted beats are whole sentences too.
    ...(mode === 'explainer' || mode === 'painted' ? { beatMs: EXPLAINER_BEAT_MS, cut: 'sentence' as const } : {}),
    effect: options.effect ?? DEFAULT_EFFECT,
    music: {
      trackPath: track?.trackPath ?? '',
      startOffsetMs: options.musicStartMs ?? track?.startOffsetMs ?? 0,
      levelLufs: options.musicLufs ?? AUDIO.musicLufs,
      fadeInMs: options.musicFadeInMs ?? MUSIC_FADE_IN_MS,
      fadeOutMs: options.musicFadeOutMs ?? MUSIC_FADE_OUT_MS,
    },
    imagery,
    imageSource,
    style: options.style ?? DEFAULT_STYLE,
    captionScale: options.captionScale ?? CAPTION_SCALE.default,
    subtitles: options.subtitles ?? 'burned',
    artStyle: options.artStyle ?? 'auto',
    panelTexture: options.panelTexture ?? false,
    sfxCues: options.sfxCues ?? DEFAULT_SFX_CUES,
    series: options.series ?? null,
    mode,
    boardTexture: options.boardTexture ?? false,
    boardTheme: options.boardTheme ?? 'light',
    boardContent: options.boardContent ?? 'overlay',
    boardImagery: options.boardImagery ?? 'draw',
    images: [],
  });

  /**
   * The stick figure performs the beat, so this mode has no pictures to fetch
   * and no credits to write -- but it does have work of its own, and the
   * imagery check below returns before any of it. Its own branch, ahead of the
   * picture path, rather than a condition threaded through a path that is
   * entirely about images.
   */
  /**
   * Storybook draws its own panels and burns its own captions, so it wants
   * none of the picture-source machinery below -- no stock search, no mix, no
   * shader field. Its own branch, like the stick figure.
   */
  if (mode === 'storybook') {
    const panelTexts = planned.sheet.beats.map((beat) => beatWords(beat.lines).join(' '));

    /**
     * Everything here is drawn. Nothing is searched for.
     *
     * There was a photograph path in this branch, and it was a mistake I made
     * with numbers to back it up. For a video about a named work it went to
     * Commons for anything real connected to the subject, which in practice
     * meant convention cosplay -- and the measurement said "on subject" while
     * the video said "somebody's holiday album". Strangers in costume, shot
     * under different lights on different cameras, cut between drawn panels.
     * Being able to prove each picture was about Naruto did not make it look
     * like Naruto.
     *
     * A drawing has none of that problem. It is the same hand, the same light
     * and the same character in every panel, and a described character drawn
     * twenty times is closer to the thing than twenty photographs of twenty
     * different people dressed as it.
     *
     * Supplied media still wins, because that is somebody choosing rather than
     * a search guessing. It is the only thing in here that is not drawn.
     */
    const supplied = chooseOwn(slug, panelTexts.length);
    const found = supplied;

    const { images: drawn } = await generatePanels({
      topic: options.topic,
      script: script.fullText,
      // A beat that already has a picture is not drawn, and not paid for.
      beatTexts: remaining(found, panelTexts),
      seed,
      force: options.force,
      art: options.artStyle ?? 'auto',
    });

    const panels = panelTexts.map((_, index) => found[index] ?? drawn[index] ?? null);
    writeCredits(slug, panels);
    return {
      ...planned,
      sheet: parseBeatSheet({
        ...planned.sheet,
        beats: planned.sheet.beats.map((beat, index) => ({
          ...beat,
          background: { ...beat.background, image: panels[index] ?? null },
        })),
      }),
    };
  }

  if (mode === 'stickman') {
    writeCredits(slug, []);
    const genre = options.niche === 'war' ? 'war' : 'books';
    const staging = await directStickman({
      topic: options.topic,
      script: script.fullText,
      beatTexts: planned.sheet.beats.map((beat) => beatWords(beat.lines).join(' ')),
      seed,
      genre,
    });
    const phrases = phrasesOf(planned.sheet.words);
    const staged: StickBeat[] = planned.sheet.beats.map((beat, index) => {
      const stage = staging[index]!;
      return {
        id: beat.id,
        startMs: beat.startMs,
        endMs: beat.endMs,
        action: stage.action,
        stage: {
          scene: stage.scene,
          expression: stage.expression,
          prop: stage.prop,
          companion: stage.companion,
          companionExpression: stage.companionExpression,
          weather: stage.weather,
          setting: stage.setting,
          ...(stage.creature === 'none'
            ? {}
            : { creature: stage.creature, creatureCount: stage.creatureCount, creatureRole: stage.creatureRole }),
          ...(stage.war === undefined ? {} : { war: timedWar(stage.war, beat, phrases) }),
        },
      };
    });
    if (options.stickWorld === 'ai') {
      await paintSettings({ beats: staged, orientation: 'portrait', seed, topic: options.topic, genre });
    }
    return {
      ...planned,
      sheet: parseBeatSheet({
        ...planned.sheet,
        beats: planned.sheet.beats.map((beat, index) => ({
          ...beat,
          action: staged[index]?.action ?? null,
          stage: staged[index]?.stage ?? null,
        })),
      }),
    };
  }

  if (mode === 'painted') {
    writeCredits(slug, []);
    const texts = planned.sheet.beats.map((beat) => beatWords(beat.lines).join(' '));
    const scenes = await directPainting({ topic: options.topic, script: script.fullText, beatTexts: texts, seed, force: options.force });
    writePaintCredits(workDir(slug), scenes);
    const timed = timeDisplayTokens(script.fullText, planned.sheet.words);
    return {
      ...planned,
      sheet: parseBeatSheet({
        ...planned.sheet,
        beats: planned.sheet.beats.map((beat, index) => ({
          ...beat,
          paint: scenes[index] ?? null,
          captions: timed
            .filter((token) => token.startMs >= beat.startMs && token.startMs < beat.endMs)
            .map((token) => ({ text: token.text, startMs: token.startMs, endMs: Math.max(token.startMs + 1, token.endMs) })),
        })),
      }),
    };
  }

  if (imagery === 'off') {
    writeCredits(slug, []);
    return planned;
  }

  // Pictures come after planning because both paths only need the beat count,
  // and the count is not known until the cuts are placed.
  const allBeats = planned.sheet.beats.map((beat) => beatWords(beat.lines).join(' '));
  /**
   * Whatever was supplied by hand, and then only the beats it did not cover.
   *
   * Placed before the branch rather than inside each arm of it so every mode
   * behaves the same way: a picture you chose is used, and nothing is fetched,
   * generated or paid for to sit behind a beat that already has one.
   */
  const supplied = chooseOwn(slug, allBeats.length);
  const beatTexts = remaining(supplied, allBeats);

  const found: (BeatImage | null)[] =
    imageSource === 'ai' || imageSource === 'ai-free'
      ? await generateImages({
          topic: options.topic,
          script: script.fullText,
          seed,
          beatTexts,
          options,
        })
      : imageSource === 'video'
        ? await chooseFootage({
            topic: options.topic,
            script: script.fullText,
            beatTexts,
            seed,
            force: options.force,
            longestBeatMs: longestBeat(planned.sheet),
          })
        : imageSource === 'mix'
          ? await mixSources({
              topic: options.topic,
              script: script.fullText,
              beatTexts,
              seed,
              force: options.force,
              longestBeatMs: longestBeat(planned.sheet),
            })
          : await chooseImages({
              topic: options.topic,
              seed,
              beatTexts,
              force: options.force,
              // The explainer's pictures are placed by an editor, not by search order.
              ...(mode === 'explainer' ? { edit: { script: script.fullText } } : {}),
              // The same written subjects the other two sources search on.
              // Without them a stock run is still matching filenames against
              // whatever words the topic happens to share with other subjects.
              queries: await stillQueries({
                topic: options.topic,
                script: script.fullText,
                beatTexts,
                seed,
              }),
            });
  // The supplied pictures go back in over whatever the source found.
  const images = overlayOwn(supplied, found);
  writeCredits(slug, images);

  // Whiteboard beats draw an illustration rather than a pictogram, where there
  // is a model to make one. The icon picked at plan time stays underneath as
  // the fallback.
  /**
   * On the whiteboard, "picture source" chooses what a beat draws: an
   * illustration from the image model, or the bundled icon set. The control
   * was disabled for this mode, so every board silently got icons -- 24-pixel
   * pictograms, which is exactly as basic as they look -- with no way to ask
   * for anything else.
   */
  const sketches =
    mode === 'whiteboard' && imageSource === 'ai'
      ? await generateSketches({
          topic: options.topic,
          // Only where a drawing will actually be shown. Blank asks for nothing.
          // Every beat. The icon map matches about a third of them, and the
          // rest were being left blank rather than drawn.
          beatTexts,
          // The prompt writer reads the whole thing, so a beat's drawing can be
          // about what the beat means rather than about the words in its line.
          script: script.fullText,
          seed,
          force: options.force,
        })
      : beatTexts.map(() => null);

  const explained = mode === 'explainer' ? await explainerLayer(planned.sheet, script.fullText, options.force) : null;

  return {
    ...planned,
    sheet: parseBeatSheet({
      ...planned.sheet,
      // The plug names the channel it will be posted to, when one is connected.
      ...(explained === null ? {} : { meta: { ...planned.sheet.meta, channel: readConnection()?.channelTitle ?? null } }),
      beats: planned.sheet.beats.map((beat, index) => ({
        ...beat,
        ...(explained === null ? {} : (explained[index] ?? {})),
        background: footageTreatment(beat.background, images[index] ?? null),
        illustration:
          sketches[index] == null
            ? beat.illustration
            : { ...(beat.illustration ?? { name: 'illustration', paths: [] }), file: sketches[index] },
      })),
    }),
  };
}

/**
 * The explainer's own layer over a planned sheet: a graphic per beat, and the
 * beat's written words with the moment each is said, for the captions.
 *
 * The captions are the display text timed, not the transcript. The sheet's
 * words are what the reader said, so "$4.2b" is five of them; the planner
 * already knows how to put the written form back on those times, and the
 * same function does it here.
 */
async function explainerLayer(
  sheet: BeatSheet,
  fullText: string,
  force: boolean,
): Promise<{ graphic: Graphic | null; captions: { text: string; startMs: number; endMs: number }[] }[]> {
  const timed = timeDisplayTokens(fullText, sheet.words);
  const texts = sheet.beats.map((beat) => beatWords(beat.lines).join(' '));
  const graphics = await directGraphics({
    topic: sheet.meta.topic,
    script: fullText,
    beatTexts: texts,
    seed: sheet.meta.seed,
    force,
  });
  return sheet.beats.map((beat, index) => ({
    graphic: graphics[index] ?? null,
    captions: timed
      .filter((token) => token.startMs >= beat.startMs && token.startMs < beat.endMs)
      .map((token) => ({
        text: token.text,
        startMs: token.startMs,
        endMs: Math.max(token.startMs + 1, token.endMs),
      })),
  }));
}

/**
 * A pasted script goes through the shaping pass unless it was explicitly
 * refused. What comes back is the writer's own words in beat-per-line form,
 * trimmed if it ran past a minute; the log says which of those happened so the
 * change is never silent.
 */
async function prepareScript(options: ProduceOptions): Promise<string> {
  const text = options.script ?? '';
  if (options.adapt === false) return text;

  const adapted = await adaptScript({ text, force: options.force });
  const seconds = (adapted.estimatedMs / 1000).toFixed(0);
  log.info(
    `script: your ${adapted.words} words in ${adapted.beats} beats, about ${seconds}s read aloud` +
      (adapted.by === 'model' ? '' : ' (shaped without a model)'),
  );
  if (adapted.truncated) log.warn('script: trimmed from the end to keep the read under a minute');
  for (const note of adapted.notes) log.info(`script: ${note}`);
  return adapted.text;
}

/** Best-effort: a provider failure leaves the fields to carry the beat alone. */
async function generateImages(input: {
  topic: string;
  script: string;
  seed: number;
  beatTexts: readonly string[];
  options: ProduceOptions;
}): Promise<(BeatImage | null)[]> {
  const count = input.options.imageCount ?? env.FLUX_IMAGES;
  try {
    const result = await generateBeatImages({
      topic: input.topic,
      script: input.script,
      seed: input.seed,
      beatTexts: input.beatTexts,
      count,
      force: input.options.force,
      engine: input.options.imageSource === 'ai-free' ? 'cloudflare' : 'fal',
      ...explainerArt(input.options),
    });
    log.info(
      `images: ${result.generated} generated, ${result.prompts.length} across ${input.beatTexts.length} beats, $${result.usd.toFixed(4)}`,
    );
    return result.images;
  } catch (error) {
    log.warn(`images: generation failed (${(error as Error).message}); rendering without pictures`);
    return input.beatTexts.map(() => null);
  }
}

/**
 * The explainer's art style, for the pictures it generates.
 *
 * "auto" keeps them photographs. Anything else is the storybook's own
 * illustrator's direction, put at the front of every prompt where the image
 * model weights hardest, so a video asked to be anime is drawn as anime
 * rather than photographed and then filtered. Stock pictures get a matching
 * treatment in the renderer instead (remotion/explainer/Media.tsx).
 */
function explainerArt(options: ProduceOptions): { art?: ArtOverride } {
  const style = options.artStyle ?? 'auto';
  if (options.mode !== 'explainer' || style === 'auto') return {};
  const medium = STORY_ART[style];
  if (medium === undefined) return {};
  return {
    art: {
      medium,
      direction: `Vertical 9:16 illustration, the subject large and in the middle third. ${NO_TEXT}`,
      shape: 'short vertical explainer videos',
      noun: 'illustrations',
      lockedPalette: false,
      width: env.FLUX_WIDTH,
      height: env.FLUX_HEIGHT,
    },
  };
}

/** The first beat using each template — the cheapest set of stills that shows every look. */
export function firstBeatPerTemplate(
  sheet: BeatSheet,
): { template: TemplateName; id: string }[] {
  const chosen = new Map<TemplateName, string>();
  for (const beat of sheet.beats) {
    if (!chosen.has(beat.template)) chosen.set(beat.template, beat.id);
  }
  return TEMPLATE_NAMES.map((name) => ({ template: name, id: chosen.get(name) })).filter(
    (entry): entry is { template: TemplateName; id: string } => entry.id !== undefined,
  );
}
