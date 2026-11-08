import { z } from 'zod';
import type { WarDirection } from './stages/warmap.js';
import { LANGUAGES } from './languages.js';
import { CAPTION_SCALE } from './design.js';
import { DEFAULT_CHARACTER, characterForVoice } from './voices.js';
import { graphicSchema } from './explainer.js';
import { paintSceneSchema } from './painted.js';

export const SCHEMA_VERSION = 7;

export const TEMPLATE_NAMES = [
  'word-punch',
  'line-stack',
  'stat-slam',
  'quote-block',
  'countdown',
  'reveal-mask',
] as const;

export const MOTION_KINDS = ['push', 'pan-l', 'pan-r', 'pull'] as const;

export const SFX_CUES = ['whoosh', 'impact', 'riser', 'click'] as const;

/** Background treatments; every one is a fullscreen shader. */
export const EFFECT_NAMES = ['gradient', 'clouds', 'fluid', 'aurora', 'static'] as const;

/** How hard a photograph reads behind the type. */
export const IMAGERY_MODES = ['off', 'blend', 'photo'] as const;

/** Type treatments; see STYLES in design.ts for what each one changes. */
export const STYLE_NAMES = ['editorial', 'brutalist', 'whisper', 'highlight', 'outline'] as const;

/**
 * What the picture layer is. 'kinetic' is type over a shader field; 'whiteboard'
 * is writing and line drawings appearing on paper at the pace of the read.
 * Everything before the renderer -- script, voice, alignment, beats, timings,
 * mix -- is the same either way.
 */
/**
 * The picture layer. "cinema" is kinetic type with the trailer edit over it --
 * snap zooms, a mid-shot recut, speed variation and a film grade -- and it only
 * earns its name over moving footage, so it asks for a clip source.
 *
 * "explainer" is an edited explainer: sharp pictures with a camera move, a
 * motion graphic per beat that lands on its word, word-by-word captions, a
 * transition on every cut and the subscribe plug wherever it is said.
 */
export const RENDER_MODES = ['kinetic', 'whiteboard', 'cinema', 'stickman', 'storybook', 'explainer', 'painted'] as const;

/**
 * How the words appear over a drawn panel.
 *
 * Only meaningful where the picture can carry the beat alone. In the kinetic
 * modes the type *is* the picture, so turning it off would leave an empty
 * frame; on a storybook panel the drawing stands on its own, and plenty of
 * creators ship without burned captions because the platform adds its own.
 *
 * "kinetic" is the odd one: rather than a caption treatment it borrows the
 * animated, word-timed type the other modes are built around, and lays it over
 * the panel. It is there because a storybook panel and kinetic type are not
 * mutually exclusive -- the drawing carries the scene and the type carries the
 * emphasis -- and the two together is a real format rather than a compromise.
 */
export const SUBTITLE_MODES = ['burned', 'minimal', 'kinetic', 'none'] as const;

/**
 * The house art direction for illustrated panels.
 *
 * "auto" is the original behaviour: the writer invents a look to suit the
 * subject, which is right when you do not care and wrong the moment you are
 * running a series, because two videos in the same format should not arrive in
 * two different styles. Naming one fixes it across every video that uses it.
 */
export const ART_STYLES = [
  'auto',
  'flat',
  'watercolour',
  'anime',
  'comic',
  'manga',
  'pencil',
  'painterly',
  'retro',
] as const;
export type ArtStyle = (typeof ART_STYLES)[number];
export const artStyle = z.enum(ART_STYLES);
export type SubtitleMode = (typeof SUBTITLE_MODES)[number];
export const subtitleMode = z.enum(SUBTITLE_MODES);
export type RenderMode = (typeof RENDER_MODES)[number];
export const renderMode = z.enum(RENDER_MODES);

/** Paper and dark ink, or a dark board and light chalk. */
export const BOARD_THEMES = ['light', 'dark'] as const;
export type BoardTheme = (typeof BOARD_THEMES)[number];
export const boardTheme = z.enum(BOARD_THEMES);

/**
 * Where the writing sits relative to the surface. 'overlay' lays it on top,
 * which keeps it crisp; 'dissolve' blends it into the texture so it reads as
 * written on the board itself rather than floating above a picture of one.
 */
export const BOARD_CONTENTS = ['overlay', 'dissolve'] as const;
export type BoardContent = (typeof BOARD_CONTENTS)[number];
export const boardContent = z.enum(BOARD_CONTENTS);

/** The illustration is drawn under the pen, or dissolved in behind the writing. */
export const BOARD_IMAGERY = ['draw', 'dissolve'] as const;
export type BoardImagery = (typeof BOARD_IMAGERY)[number];
export const boardImagery = z.enum(BOARD_IMAGERY);

/**
 * Where a beat's picture comes from: openly licensed stock stills, a generated
 * image, or live footage. "video" is the same contract as the other two -- a
 * file under public/ named in the beat -- and the renderer tells them apart by
 * extension, so sheets written before it existed still load unchanged.
 */
/** "ai-free" is generated too, on Cloudflare's free plan (providers/cloudflare.ts). */
export const IMAGE_SOURCES = ['stock', 'ai', 'video', 'mix', 'ai-free'] as const;

/**
 * Whether a beat's picture is a clip rather than a still.
 *
 * By extension, because the name is always ours: every fetched file is written
 * as a content hash plus the extension the stage chose. It lives here rather
 * than beside the renderer so the pipeline, the linter and the Remotion side
 * all answer the question the same way -- once "mix" exists, a sheet can hold
 * both kinds at once and nothing may guess from the sheet's source alone.
 */
export function isFootageFile(file: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(file);
}

export const templateName = z.enum(TEMPLATE_NAMES);
export const motionKind = z.enum(MOTION_KINDS);
export const sfxCue = z.enum(SFX_CUES);
export const effectName = z.enum(EFFECT_NAMES);
export const imageryMode = z.enum(IMAGERY_MODES);
export const styleName = z.enum(STYLE_NAMES);
export const imageSourceName = z.enum(IMAGE_SOURCES);

export const imageSchema = z
  .object({
    file: z.string().min(1),
    title: z.string(),
    author: z.string(),
    licence: z.string(),
    source: z.string(),
  })
  .strict();

export type TemplateName = z.infer<typeof templateName>;
export type MotionKind = z.infer<typeof motionKind>;
export type SfxCue = z.infer<typeof sfxCue>;
export type EffectName = z.infer<typeof effectName>;
export type ImageryMode = z.infer<typeof imageryMode>;
export type StyleName = z.infer<typeof styleName>;
export type ImageSource = z.infer<typeof imageSourceName>;
export type BeatImage = z.infer<typeof imageSchema>;

const ms = z.number().int().nonnegative();

const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case');

export const metaSchema = z
  .object({
    topic: z.string().min(1),
    slug,
    seed: z.number().int().nonnegative(),
    /**
     * Defaulted, so every sheet written before this existed is English — which
     * they all were.
     */
    language: z.enum(LANGUAGES).default('en'),
    durationMs: z.number().int().min(5_000).max(120_000),
    fps: z.literal(30),
    effect: effectName,
    imagery: imageryMode,
    imageSource: imageSourceName,
    style: styleName,
    /** Defaulted, so sheets written before these existed still load. */
    mode: renderMode.default('kinetic'),
    /**
     * Whiteboard only. Plain paper is what the format is; the shader field
     * behind it is something you turn on, so the default is off.
     */
    boardTexture: z.boolean().default(false),
    boardTheme: boardTheme.default('light'),
    boardContent: boardContent.default('overlay'),
    boardImagery: boardImagery.default('draw'),
    /** Defaulted, so sheets written before subtitles were a choice still load. */
    subtitles: subtitleMode.default('burned'),
    /** Storybook only: the drawing style every panel shares. */
    artStyle: artStyle.default('auto'),
    /**
     * Storybook only: lay the effect field over the panels.
     *
     * Off by default for the same reason the whiteboard's texture is: a clean
     * drawn panel is what the format is, and the field over it is something
     * you turn on. It also means every illustrated video made before this
     * existed still renders the way it was made -- `effect` defaults to
     * 'static' on every sheet ever written, so switching this on by default
     * would have quietly put snow over all of them.
     */
    panelTexture: z.boolean().default(false),
    /**
     * Which cues reach the mix.
     *
     * The plan writes every cue it can justify and this decides which of them
     * are audible, rather than the plan writing only what is wanted. That is
     * the difference between a choice you can change and one you have to
     * re-plan for: the clicks are still in the sheet when they are switched
     * off, so turning them back on is a re-render, not a rebuild.
     *
     * The default is the two that mark structure -- the picture changing, and
     * the turn before a reversal. A click under every line of type came to 89
     * of them in a 48-second video, which is a menu being navigated rather
     * than a video being watched, so it is opt-in.
     */
    sfxCues: z.array(sfxCue).default(['whoosh', 'riser']),
    /** The war channel's sound effects, all together, up or down from where they sit, in dB. */
    warSfxDb: z.number().min(-24).max(12).default(0),
    /**
     * Which series this was made in, by id, or null for a one-off. Recorded on
     * the sheet rather than kept in a side list so a video cannot be separated
     * from its series by anything short of editing the sheet.
     */
    series: z.string().max(64).nullable().default(null),
    /**
     * Explainer only: the channel the subscribe plug names. Taken from the
     * connected channel when the video is made; null draws a plain ask.
     */
    channel: z.string().max(80).nullable().default(null),
    captionScale: z
      .number()
      .min(CAPTION_SCALE.min)
      .max(CAPTION_SCALE.max)
      .default(CAPTION_SCALE.default),
  })
  .strict();

export const substitutionSchema = z
  .object({
    rule: z.string().min(1),
    display: z.string().min(1),
    // Empty on purpose for a token that is shown but never spoken — an emoji.
    // Silence is a real rewrite and worth recording, not an invalid one.
    spoken: z.string(),
  })
  .strict();

export const scriptSchema = z
  .object({
    hook: z.string().min(1),
    body: z.string().min(1),
    fullText: z.string().min(1),
    spokenText: z.string().min(1),
    pronunciation: z.array(substitutionSchema),
  })
  .strict();

export const scriptDraftSchema = z
  .object({
    hook: z.string().min(1),
    beats: z
      .array(
        z
          .object({
            text: z.string().min(1),
            template_hint: templateName.nullable(),
            emphasis_word: z.string().nullable(),
          })
          .strict(),
      )
      .min(4)
      .max(24),
  })
  .strict();

export type ScriptDraft = z.infer<typeof scriptDraftSchema>;
export type Substitution = z.infer<typeof substitutionSchema>;

export const voiceSchema = z
  .object({
    audioPath: z.string().min(1),
    provider: z.string().min(1),
    voiceId: z.string().min(1),
    /** Who read it — the roster id in src/voices.ts, not the engine's voice. */
    character: z.string().min(1),
  })
  .strict();

export const wordSchema = z
  .object({
    text: z.string().min(1),
    startMs: ms,
    endMs: ms,
  })
  .strict()
  .refine((w) => w.endMs > w.startMs, { message: 'word endMs must be greater than startMs' });

/**
 * How loud the bed sits, in LUFS. Defaulted rather than required so a sheet
 * written before the control existed still parses and simply gets the house
 * level — no re-plan needed.
 */
export const MUSIC_LUFS_DEFAULT = -22;
export const MUSIC_LUFS_MIN = -34;
export const MUSIC_LUFS_MAX = -12;
export const MUSIC_FADE_IN_MS = 1200;
export const MUSIC_FADE_OUT_MS = 2000;
export const MUSIC_FADE_MAX_MS = 15_000;

export const musicSchema = z
  .object({
    trackPath: z.string(),
    bpm: z.number().positive().max(300),
    beatGridMs: z.array(ms).min(2),
    startOffsetMs: ms,
    levelLufs: z.number().min(MUSIC_LUFS_MIN).max(MUSIC_LUFS_MAX).default(MUSIC_LUFS_DEFAULT),
    /** Both defaulted, so a sheet written before they existed still parses. */
    fadeInMs: ms.max(15_000).default(MUSIC_FADE_IN_MS),
    fadeOutMs: ms.max(15_000).default(MUSIC_FADE_OUT_MS),
  })
  .strict()
  .refine((m) => isStrictlyAscending(m.beatGridMs), {
    message: 'beatGridMs must be strictly ascending',
    path: ['beatGridMs'],
  });

export const lineSchema = z
  .object({
    text: z.string().min(1),
    emphasis: z.boolean(),
    scale: z.number().positive().max(6),
  })
  .strict();

export const backgroundSchema = z
  .object({
    clipId: z.string().min(1),
    inPointMs: ms,
    blurPx: z.number().min(0).max(200),
    scrimOpacity: z.number().min(0).max(1),
    image: imageSchema.nullable(),
  })
  .strict();

export const motionSchema = z
  .object({
    kind: motionKind,
    amount: z.number().min(0).max(1),
  })
  .strict();

/** A line drawing for one beat: stroke geometry in a 24x24 box, in draw order. */
export const illustrationSchema = z
  .object({
    name: z.string().min(1),
    /**
     * Empty when the beat matched no concept in the icon map. That is most
     * beats -- measured at 65% across twelve sheets -- so requiring strokes
     * here is what left two thirds of every whiteboard video with nothing
     * drawn on it at all.
     */
    paths: z.array(z.string().min(1)).max(24),
    /**
     * An illustration under public/images. When present it is what gets drawn
     * and `paths` is the fallback beneath it, so a sheet stays renderable if
     * the file is ever missing.
     */
    file: z.string().min(1).nullable().default(null),
  })
  .strict()
  .refine((d) => d.paths.length > 0 || d.file !== null, {
    message: 'an illustration needs either stroke geometry or an image',
  });

export const beatSchema = z
  .object({
    id: z.string().min(1),
    startMs: ms,
    endMs: ms,
    template: templateName,
    lines: z.array(lineSchema).min(1).max(4),
    emphasisWordIndex: z.number().int().nonnegative().nullable(),
    background: backgroundSchema,
    motion: motionSchema,
    /** Only the whiteboard mode draws it; null when nothing fit the line. */
    illustration: illustrationSchema.nullable().default(null),
    /**
     * What the stick figure does through this beat, as an action name. Not an
     * enum in the schema on purpose: the vocabulary lives with the rig, and a
     * sheet written against a later version naming an action this build has
     * never heard of should fall back to standing rather than fail to load.
     */
    action: z.string().nullable().default(null),
    /**
     * Where the stick figure is and how it looks there: the place, its face,
     * what it holds, who is with it, the weather. Loose strings for the same
     * reason as `action` -- the vocabulary lives with the renderer, and an
     * unknown word falls back instead of failing the sheet.
     */
    stage: z
      .object({
        scene: z.string().optional(),
        expression: z.string().optional(),
        prop: z.string().optional(),
        companion: z.string().optional(),
        companionExpression: z.string().optional(),
        weather: z.string().optional(),
        /** The place in words, which a painted background is made from. */
        setting: z.string().optional(),
        /** A painted background under public/images, instead of the drawn scene. */
        background: z.string().optional(),
        /** The background's depth map, for the camera to move through it. */
        depth: z.string().optional(),
        /** How near the floor under the figure is, 0 far to 1 near. */
        floor: z.number().optional(),
        /**
         * Animals in the beat. Listed rather than left to pass through: an
         * object schema drops keys it does not name, and it did -- the emus
         * were staged, then silently removed on the way into the sheet.
         */
        creature: z.string().optional(),
        creatureCount: z.string().optional(),
        creatureRole: z.string().optional(),
        /**
         * The war channel's extras: uniforms, sounds on the word, gags,
         * stickers, maps. Checked field by field where they are made
         * (cleanWarDirection); here the sheet only has to carry them.
         */
        war: z.custom<WarDirection>((value) => value !== null && typeof value === 'object').optional(),
      })
      .nullable()
      .default(null),
    /** Explainer only: the motion graphic this beat carries. */
    graphic: graphicSchema.nullable().default(null),
    /** Painted only: the scene p5.brush paints for this beat. */
    paint: paintSceneSchema.nullable().default(null),
    /**
     * Explainer only: the beat's words as they are written, each with the
     * moment it is said. The sheet's own `words` are what was spoken, which
     * for "$4.2b" is five words; a caption has to show the one.
     */
    captions: z
      .array(z.object({ text: z.string().min(1), startMs: ms, endMs: ms }).strict())
      .nullable()
      .default(null),
  })
  .strict()
  .refine((b) => b.endMs > b.startMs, {
    message: 'beat endMs must be greater than startMs',
    path: ['endMs'],
  })
  .refine((b) => b.emphasisWordIndex === null || b.emphasisWordIndex < countBeatWords(b.lines), {
    message: 'emphasisWordIndex is out of range for the words in this beat',
    path: ['emphasisWordIndex'],
  });

export const sfxSchema = z
  .object({
    cue: sfxCue,
    atMs: ms,
    gainDb: z.number().min(-60).max(0),
    variant: z.number().int().nonnegative(),
  })
  .strict();

export const beatSheetSchema = z
  .object({
    version: z.literal(SCHEMA_VERSION),
    meta: metaSchema,
    script: scriptSchema,
    voice: voiceSchema,
    words: z.array(wordSchema),
    music: musicSchema,
    beats: z.array(beatSchema).min(1),
    sfx: z.array(sfxSchema),
  })
  .strict()
  .superRefine((sheet, ctx) => {
    const ids = new Set<string>();
    for (const [i, beat] of sheet.beats.entries()) {
      if (ids.has(beat.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['beats', i, 'id'],
          message: `duplicate beat id "${beat.id}"`,
        });
      }
      ids.add(beat.id);

      if (beat.endMs > sheet.meta.durationMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['beats', i, 'endMs'],
          message: `beat ends after meta.durationMs (${sheet.meta.durationMs})`,
        });
      }

      const previous = sheet.beats[i - 1];
      if (previous !== undefined && beat.startMs < previous.endMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['beats', i, 'startMs'],
          message: `beat overlaps the previous beat (ends at ${previous.endMs})`,
        });
      }
    }

    for (const [i, word] of sheet.words.entries()) {
      const previous = sheet.words[i - 1];
      if (previous !== undefined && word.startMs < previous.startMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['words', i, 'startMs'],
          message: 'words must be ordered by startMs',
        });
      }
    }

    for (const [i, cue] of sheet.sfx.entries()) {
      if (cue.atMs > sheet.meta.durationMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sfx', i, 'atMs'],
          message: `cue fires after meta.durationMs (${sheet.meta.durationMs})`,
        });
      }
    }
  });

export type Line = z.infer<typeof lineSchema>;
export type Word = z.infer<typeof wordSchema>;
export type Sfx = z.infer<typeof sfxSchema>;
export type Beat = z.infer<typeof beatSchema>;
export type BeatSheet = z.infer<typeof beatSheetSchema>;

type TextBearing = { readonly text: string };

export function beatWords(lines: readonly TextBearing[]): string[] {
  return lines.flatMap((line) => line.text.split(/\s+/).filter((word) => word.length > 0));
}

function countBeatWords(lines: readonly TextBearing[]): number {
  return beatWords(lines).length;
}

function isStrictlyAscending(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    const previous = values[i - 1];
    const current = values[i];
    if (previous === undefined || current === undefined) return false;
    if (current <= previous) return false;
  }
  return true;
}

export class BeatSheetValidationError extends Error {
  constructor(
    message: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'BeatSheetValidationError';
  }
}

export function formatIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => `  ${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('\n');
}

/**
 * Older sheets stay renderable. Each step adds a field whose historical value
 * is not in doubt, so nobody has to regenerate work to open it: v5 predates
 * generated pictures, so everything it references came from stock, and v6
 * predates named readers, so the reader is whoever owns the voice it recorded.
 */
export function migrateBeatSheet(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  let sheet = input as Record<string, unknown>;

  if (sheet['version'] === 5) {
    const meta = sheet['meta'];
    if (typeof meta !== 'object' || meta === null) return input;
    sheet = {
      ...sheet,
      version: 6,
      meta: { imageSource: 'stock', ...(meta as Record<string, unknown>) },
    };
  }

  if (sheet['version'] === 6) {
    const voice = sheet['voice'];
    if (typeof voice !== 'object' || voice === null) return input;
    const recorded = voice as Record<string, unknown>;
    const voiceId = typeof recorded['voiceId'] === 'string' ? recorded['voiceId'] : '';
    sheet = {
      ...sheet,
      version: 7,
      voice: {
        character: characterForVoice(voiceId)?.id ?? DEFAULT_CHARACTER,
        ...recorded,
      },
    };
  }

  return sheet;
}

export function parseBeatSheet(input: unknown): BeatSheet {
  const result = beatSheetSchema.safeParse(migrateBeatSheet(input));
  if (!result.success) {
    throw new BeatSheetValidationError(
      `beat sheet failed schema validation:\n${formatIssues(result.error.issues)}`,
      result.error.issues,
    );
  }
  return result.data;
}
