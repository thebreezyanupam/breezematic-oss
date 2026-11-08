import fs from 'node:fs';
import { describeLong } from './longform.js';
import { workSlug } from '../workslug.js';
import path from 'node:path';
import { AUDIO, ROOT, assetDirs, dirs, workDir } from '../config.js';
import { ffmpeg, probeDurationMs } from '../ffmpeg.js';
import { log } from '../log.js';
import { slugify } from '../text.js';
import { hashString } from '../rng.js';
import { setSpendContext } from '../spend.js';
import { generateEssay, type Vertical } from './essay.js';
import { synthesizeVoice } from './voice.js';
import { alignWords } from './align.js';
import { planEdit, checkPlan, snapToWords } from './edit.js';
import { composeEssay, LEAD_IN_MS, type ChapterCard, type QuoteCard } from './compose.js';
import { renderProject, saveProject, PROJECT_VERSION, type Project } from './project.js';
import type { Word } from '../schema.js';
import { writeChapterCards, writeTimeline, paragraphStarts } from './longform.js';
import { forgetChapterCards, markChapters, planChapters, type ChapterMode } from './chapters.js';
import { chooseMoments, findQuotations, identifyBook, loadSource } from './quotes.js';
import { writeEssayDescription } from './describe.js';
import { NO_TEXT, type ArtOverride } from './imagegen.js';
import {
  PICTURE_STYLES,
  ILLUSTRATION_MEDIUM,
  defaultStyleFor,
  memoryVariantFor,
  type PictureStyle,
} from '../design/signature.js';
import type { EssayLook } from './compose.js';
import { planCutouts } from './cutouts.js';
import { plainSpeech } from './plaintext.js';
import { loadThumbnails, makeThumbnails } from './thumbnail.js';
import { stageLongStickman, type StickWorld } from './stickworld.js';
import { planWarSound, writeWarCredits } from './warsound.js';
import { IMAGE_DIR } from './images.js';
import { canGoBehind, depthMapFor, depthMatte } from '../providers/localvision.js';
import { planCutSound, planSound, planTitleTyping } from './essaysound.js';
import { findMusic } from '../providers/freesound.js';
import { generatePanels, type CastMember, type ImageEngine } from './storybook.js';
import type { Sheet } from './characters.js';
import { chooseFootage } from './footage.js';

/**
 * One book, one essay, one finished file.
 *
 * The order here is the whole design and it is not the reading order. Writing
 * comes first because everything downstream is shaped by it; the reading comes
 * next because it is the slow part and the only part that cannot be recovered
 * from a cache if the machine is interrupted; and the edit is planned only
 * once the words have real timings, because cuts that land near speech rather
 * than on it are the clearest sign a video was assembled instead of edited.
 *
 * Rendering is frame-by-frame through headless Chrome, which the long-form
 * lore pipeline deliberately avoids -- but that pipeline is one photograph
 * drifting and this is type keyed to a specific word at a specific
 * millisecond, which ffmpeg cannot express. The frames are cheap: flat colour,
 * one block of text, no images and no shaders.
 */

export type BookStage =
  | 'essay'
  | 'voice'
  | 'align'
  | 'edit'
  | 'pictures'
  | 'cutouts'
  | 'render'
  | 'mix';

export type BookOptions = {
  book: string;
  vertical: Vertical;
  angle?: string;
  minutes: number;
  seed?: number;
  force: boolean;
  character?: string;
  ttsProvider?: string;
  cloneVoice?: string;
  /** Which ElevenLabs voice reads it, by id, when the engine is 'elevenlabs'. */
  elevenVoice?: string;

  /**
   * A script you wrote, used verbatim.
   *
   * When this is set nothing is written for you -- no plan, no sections, no
   * thesis. That is the point: the writer is useful for a first draft and
   * useless once you have opinions, and an essay channel lives or dies on
   * whether the argument is yours. Sections are split on blank lines, which is
   * how anybody writing prose already separates them.
   */
  script?: string;
  /** Your title. Only consulted when the script is yours too. */
  title?: string;
  /**
   * Art direction for the whole video, not just the writing.
   *
   * Steers the look as well as the words, which is why it is separate from
   * `angle`: "cold, clinical, institutional" is a fact about the frame, and
   * asking for it in the same box as the argument meant it could only ever
   * reach the script.
   */
  direction?: string;

  /** The shader field behind the type, or 'none' for the flat ground. */
  effect?: string;
  /**
   * Where the pictures come from.
   *
   * 'none' is the flat ground and the shader field, which is what the channel
   * signature is. 'ai' draws them, which costs a third of a cent each and is
   * the only source with no rightsholder. 'stock' pulls openly licensed
   * footage, which is free and is somebody else's work -- allowed, credited,
   * and deliberately not the default for a channel whose whole argument is
   * that nothing in it is borrowed.
   */
  pictures?: 'none' | 'ai' | 'stock';
  /** How many to spread across the runtime. */
  pictureCount?: number;
  /**
   * How many subjects to cut out and paste over the frame. 0 is off.
   *
   * Separate from the picture count because they are separate jobs: pictures
   * are what the video is looking at and a cutting is an interruption of it.
   * Tying them together would mean a video with thirty pictures got thirty
   * interruptions, at which point the interruption is the format and stops
   * interrupting anything.
   */
  cutoutCount?: number;
  /**
   * Which model draws the pictures: flux (cheap, faces drift), gemini (every
   * picture, characters from a reference drawing), or mixed (gemini for close
   * shots of a character, flux for everything else). Defaults to mixed.
   */
  imageEngine?: ImageEngine;
  /**
   * The whole look of the video: cinematic (film stills, a grade, grain,
   * letterbox, snap cuts, subtitles in the bar) or storybook (inked panels,
   * handwritten captions, crossfades). Cinematic unless asked otherwise.
   */
  look?: EssayLook;
  /** Stickman look only: the world drawn (free) or painted for the story's places. */
  stickWorld?: StickWorld;
  /**
   * Which channel this is for. 'war' is military history told for laughs:
   * the stick figure gets uniforms, armies, maps, sound effects on the word
   * and editing jokes, and the writer writes in that channel's voice.
   */
  niche?: 'books' | 'war';
  /**
   * The title and chapter names typed on with key sounds, or faded in whole.
   * On for the books channel, off for the war channel, where a typewriter is
   * the wrong register for a joke about emus.
   */
  typewriter?: boolean;
  /** The war channel's sound effects, all together, up or down, in dB. */
  warSfxDb?: number;
  /** The war channel's sound effects at all. On unless switched off. */
  warSfx?: boolean;
  /**
   * Stickman look only: the cinematic finish -- letterbox, grade, grain,
   * subtitles in the bottom bar -- or the plain world with captions on top.
   */
  stickFinish?: 'cinematic' | 'plain';
  /**
   * What the pictures are made of -- film still, anime, oil painting and so
   * on -- independent of the look. Absent, each look uses its own: film stills
   * for cinematic, inked comic for storybook.
   */
  pictureStyle?: PictureStyle;
  /**
   * Depth parallax in the cinematic look: each still gets a depth map, made
   * locally, and the camera moves its near part past its far part. On unless
   * turned off; the storybook look does not use it.
   */
  parallax?: boolean;
  /**
   * Real material from the public record: public-domain portraits of the
   * real people the narration names, from Wikimedia Commons, and the book's
   * own text from Project Gutenberg when it is out of copyright -- so a
   * quotation is checked against the page and shown as it is printed. On
   * unless turned off.
   */
  realSources?: boolean;
  /**
   * assets/music filename, 'none', or 'auto' to search Freesound.
   *
   * 'auto' reads the direction: what somebody wrote to describe how the video
   * should feel is also the best description of what should be playing under
   * it, and asking for the same thing twice in two boxes is how the two end up
   * disagreeing.
   */
  music?: string;
  /**
   * How loud the music sits, in LUFS, the same scale and range a short uses.
   * The narration is mastered to -14, so the default -22 is eight under it:
   * clearly there, never competing.
   */
  musicLufs?: number;
  /** How much of the effects to use. */
  sound?: 'none' | 'sparse' | 'full';
  /** How strongly the field sits over a picture, 0 to 1. */
  effectStrength?: number;
  /** Multiplier on every type size. */
  captionScale?: number;
  /** Caption treatment swapped in where a claim lands. */
  punchStyle?: string;
  /**
   * Where chapters come from: 'script' (only where the script marks them with
   * `# `), 'auto' (worked out from the runtime past five minutes), or 'off'.
   * Defaults to 'script', so a video is never cut into parts nobody asked for.
   */
  chapters?: ChapterMode;

  /** Render size. Smaller is faster and the cost is entirely pixels. */
  width?: number;
  height?: number;
  fps?: number;

  onStage?: (stage: BookStage) => void;
  onProgress?: (done: number, total: number) => void;
};

export type BookResult = {
  slug: string;
  title: string;
  thesis: string;
  book: string;
  author: string;
  words: number;
  sections: number;
  durationMs: number;
  mix: Record<string, number>;
  segments: number;
  /** How many subjects were pasted over the frame. */
  cutouts: number;
  output: string;
  sizeBytes: number;
};

/**
 * Cuts prose into a fixed number of roughly equal pieces, on sentence ends.
 *
 * Each piece is what one picture is about, so the seams matter: a picture
 * prompted from half of one sentence and half of the next is a picture about
 * nothing in particular.
 */
function splitInto(text: string, pieces: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((part) => part.trim() !== '');
  if (pieces <= 1 || sentences.length <= pieces) return sentences.slice(0, Math.max(1, pieces));

  const per = sentences.length / pieces;
  const out: string[] = [];
  for (let i = 0; i < pieces; i++) {
    const from = Math.round(per * i);
    const to = i === pieces - 1 ? sentences.length : Math.round(per * (i + 1));
    out.push(sentences.slice(from, Math.max(from + 1, to)).join(' '));
  }
  return out;
}

/**
 * Groups prose into as many sections as the edit planner can use.
 *
 * Four at the bottom because that is the floor the argument is written to; ten
 * at the top because past that the openings are closer together than the holds
 * that separate them, which is the same collapse this exists to prevent.
 */
function planningSections(sections: readonly string[]): number[] {
  const counts = sections.map((part) => part.split(/\s+/).filter(Boolean).length);
  if (counts.length <= 10) return counts;

  const wanted = Math.min(10, Math.max(4, Math.round(Math.sqrt(counts.length))));
  const per = counts.length / wanted;
  const grouped: number[] = [];
  for (let i = 0; i < wanted; i++) {
    const from = Math.round(per * i);
    const to = i === wanted - 1 ? counts.length : Math.round(per * (i + 1));
    grouped.push(counts.slice(from, Math.max(from + 1, to)).reduce((sum, n) => sum + n, 0));
  }
  return grouped;
}

/**
 * How the essay's pictures are made, and in what shape.
 *
 * The shorts art direction asks for a "Photograph, vertical 9:16 framing", and
 * the generator's default size is 864x1536. A landscape essay using both was
 * commissioning portrait photographs and then centre-cropping them to 16:9 --
 * paying for a whole image, showing a third of it, and letting the crop decide
 * the composition.
 *
 * The look itself is the channel's, fixed and not a per-video choice: inked,
 * high-contrast, near-black with warm highlights. It is an illustration rather
 * than a photograph because a photograph of a novel does not exist -- the
 * pictures are of scenes and people that were never photographed, and an
 * illustration is honest about that where a photoreal render is not.
 *
 * The last clause is the one that earns its place: the captions live along the
 * bottom now, so the picture is asked to leave them somewhere to sit.
 */
const ESSAY_ART: ArtOverride = {
  /**
   * The medium, and it goes first.
   *
   * Said last, it was ignored: twenty-six prompts that opened with a described
   * scene and carried a photographic look came back as photoreal cinematic
   * renders, every one of them, with the inked-illustration clause sitting
   * unread at the end.
   */
  medium:
    `${ILLUSTRATION_MEDIUM.charAt(0).toUpperCase()}${ILLUSTRATION_MEDIUM.slice(1)}. ` +
    'Not a photograph. Not a 3D render. Not a glossy digital painting. ' +
    'The subject of the drawing is:',
  direction:
    'Drawn as flat inked comic art with visible hatching throughout, heavy black ' +
    'shadow shapes, and the restrained near-black and burnt-orange palette. Cinematic ' +
    'widescreen 16:9 composition, the subject placed off-centre, the lower third left ' +
    'quiet and uncluttered. ' +
    NO_TEXT,
  shape: 'long-form landscape video essays about books, illustrated in inked comic art rather than photographed',
  noun: 'inked comic-art illustrations',
  lockedPalette: true,
  // 16:9 at a size the provider actually renders well.
  width: 1344,
  height: 768,
};

/**
 * How often the picture behind the type changes, by default.
 *
 * It was one every ninety seconds, on the reasoning that a picture wants time
 * to be looked at. That is true of a picture somebody chose to look at and
 * false of a picture behind an argument: ninety seconds of one still image
 * under moving type reads as a slideshow that has jammed, and the thing a
 * viewer notices is that nothing is happening. Six and a half seconds sits in
 * the five-to-ten the format wants, and it is a default -- the control still
 * decides.
 *
 * Counted against the narration as it was actually read, which is why the
 * page no longer sends a count unless somebody set one: its count was worked
 * out from the script at a reading pace, and a slow deep voice reads a
 * quarter slower than that -- so every picture was held nine or ten seconds,
 * long enough to be cut into, and that recut read as the same picture popping
 * back in.
 */
const PICTURE_EVERY_MS = 6_500;

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const COMPOSITION = 'breezematic-essay';

/**
 * A supplied script, shaped like a generated one.
 *
 * Blank lines are section breaks, which is how prose is already written. The
 * plan fields exist because the edit planner needs a turn to mark and the
 * renderer needs a title; everything else a generated essay carries is
 * argumentation the writer did themselves.
 */
function fromScript(script: string, title: string): {
  title: string;
  brief: { moves: string[]; thesis: string; book: string; author: string };
  sections: string[];
  wordCount: number;
} {
  const sections = script
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '');

  /**
   * The title is shown, never read. A script that opens with its own title --
   * the natural way to paste one, and exactly what essay.txt looks like -- had
   * that line spoken as the first sentence, so the video announced its name
   * over the title card that was already saying it. Compared loosely, because
   * a pasted heading keeps a colon or loses a capital as often as not.
   */
  const bare = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const words = (text: string): string[] =>
    text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);

  /**
   * A heading, even when it is not word for word the title field.
   *
   * The exact comparison missed the common case: the title box says one thing
   * ("Fight Club") and the pasted script opens with its own fuller heading
   * ("The Fight Club Ending You Never Saw"). That heading was then read aloud
   * and run straight into the first sentence -- "the Fight Club ending, you
   * never saw rule number one" -- over a title card already showing it.
   *
   * A heading is short, has no sentence-ending punctuation, and shares most
   * of its words with the title. "Rule number one of Fight Club:" is short and
   * mentions the title too, but a third of its words overlap and it ends in a
   * colon, so it stays: it is the first line of the argument.
   */
  const isHeading = (block: string): boolean => {
    if (bare(block) === bare(title)) return true;
    const own = words(block);
    if (own.length === 0 || own.length > 14 || /[.!?…:;]\s*$/.test(block.trim())) return false;
    const titled = new Set(words(title));
    const shared = own.filter((word) => titled.has(word)).length;
    if (shared / own.length >= 0.6) return true;

    /**
     * Covering a short title is not enough on its own: "Fight Club changed my
     * life" covers "Fight Club" completely and is a sentence that lost its
     * full stop, not a heading. What separates them is case -- a heading is
     * Title Case or capitals, a sentence is not.
     */
    const long = block.split(/\s+/).filter((word) => /\p{L}{4,}/u.test(word));
    const capitalised = long.filter((word) => /^\P{L}*\p{Lu}/u.test(word)).length;
    const titleCase = long.length > 0 && capitalised / long.length >= 0.7;
    return titleCase && titled.size > 0 && shared / titled.size >= 0.8;
  };
  while (sections.length > 1 && isHeading(sections[0] ?? '')) sections.shift();

  return {
    title,
    brief: {
      // One per section past the hook, so the planner's arithmetic lines up.
      moves: sections.slice(1).map((_, i) => `section ${i + 1}`),
      thesis: title,
      book: title,
      author: '',
    },
    sections,
    wordCount: script.split(/\s+/).filter(Boolean).length,
  };
}

export async function produceBookEssay(options: BookOptions): Promise<BookResult> {
  const slug = workSlug('book', options.book);
  const seed = options.seed ?? hashString(slug);
  const dir = workDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  setSpendContext(slug);

  const stage = (name: BookStage): void => options.onStage?.(name);
  const look: EssayLook = options.look ?? 'cinematic';
  const pictureStyle: PictureStyle = options.pictureStyle ?? defaultStyleFor(look);
  const styleMedium = PICTURE_STYLES[pictureStyle].medium;

  /* ------------------------------------------------------------- writing */

  stage('essay');

  /**
   * Yours, or written for you. Never half of each.
   *
   * A supplied script skips the planner entirely rather than being fed to it
   * as a hint, because a planner shown a finished essay will restructure it --
   * and somebody who wrote the essay did not ask for it to be restructured.
   */
  const supplied = (options.script ?? '').trim();
  const essay = supplied === ''
    ? await generateEssay({
        book: options.book,
        // The war channel always writes in its own voice.
        vertical: options.niche === 'war' ? 'war' : options.vertical,
        ...(options.angle !== undefined ? { angle: options.angle } : {}),
        ...(options.direction !== undefined ? { angle: [options.angle, options.direction].filter(Boolean).join('. ') } : {}),
        seed,
        minutes: options.minutes,
        force: options.force,
        realSources: options.realSources !== false,
        ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
      })
    : fromScript(supplied, options.title ?? options.book);

  /**
   * `# A heading` on its own line is a chapter, not a sentence.
   *
   * Taken out here, before the prose exists, so a heading is never read
   * aloud, never aligned and never captioned -- it only decides where the
   * reading stops and what the card says.
   */
  // Markdown out first, so no asterisk is read aloud or captioned.
  essay.sections = essay.sections.map((section) => plainSpeech(section).trim()).filter((section) => section !== '');
  const marked = markChapters(essay.sections);
  essay.sections = marked.sections;
  if (marked.marks.size > 0) {
    log.info(`chapters: the script marks ${marked.marks.size}`);
  }

  const prose = essay.sections.join('\n\n');

  /**
   * The book this is about, and its author, by name.
   *
   * A generated essay knows. A pasted script knows only its video title, so
   * the book is identified from the script -- one small request -- because
   * the cover, the author's portrait and the book's own text are all looked
   * up by it, and "The Book That Put Oscar Wilde on Trial" finds none of them.
   */
  const subject =
    supplied !== '' && options.realSources !== false
      ? await identifyBook(prose, essay.title)
      : { book: essay.brief.book, author: essay.brief.author };
  const bookName = subject.book || essay.brief.book;
  const authorName = subject.author || essay.brief.author;
  if (supplied !== '' && subject.book !== '') {
    log.info(
      `book: the script is about "${subject.book}"${subject.author === '' ? '' : ` by ${subject.author}`}`,
    );
  }
  fs.writeFileSync(path.join(dir, 'essay.txt'), `${essay.title}\n\n${prose}`, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'case.json'),
    `${JSON.stringify(essay.brief, null, 2)}\n`,
    'utf8',
  );

  /* -------------------------------------------------------------- voice */

  stage('voice');
  const voice = await synthesizeVoice({
    spokenText: prose,
    slug,
    force: options.force,
    ...(options.character !== undefined ? { character: options.character } : {}),
    ...(options.ttsProvider !== undefined ? { provider: options.ttsProvider } : {}),
    ...(options.cloneVoice !== undefined ? { cloneVoice: options.cloneVoice } : {}),
    ...(options.elevenVoice !== undefined ? { elevenVoice: options.elevenVoice } : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    seed,
  });
  let durationMs = await probeDurationMs(voice.audioPath);
  let voiceAudio = voice.audioPath;
  log.info(`book: ${(durationMs / 60_000).toFixed(1)} minutes of narration`);

  /* -------------------------------------------------------------- align */

  stage('align');
  const alignment = await alignWords({
    audioPath: voice.alignPath,
    spokenText: prose,
    durationMs,
    force: options.force,
  });
  /* ----------------------------------------------------------- chapters */

  /**
   * The reading is cut into chapters before anything is timed against it.
   *
   * Everything after this point -- the cuts, the captions, the cuttings, the
   * quotations, the pictures -- is derived from these words, so the pauses
   * have to exist by now. Doing it later would mean a card appearing over a
   * sentence that was planned as if the silence were not there.
   */
  let words: Word[] = [...alignment.words];
  let chapters: ChapterCard[] = [];
  // Only the cinematic look draws a chapter card, so only it gets the pauses:
  // silence with nothing on screen is a gap, not a chapter.
  // The storybook look draws no chapter card, so it gets no pauses: silence
  // with nothing on screen is a gap, not a chapter.
  const chaptered = look === 'storybook' ? null : await planChapters({
    slug,
    dir,
    title: essay.title,
    seed,
    sections: essay.sections,
    marks: marked.marks,
    starts: paragraphStarts(prose, alignment.words),
    words: alignment.words,
    audioPath: voice.audioPath,
    durationMs,
    sampleRate: AUDIO.sampleRate,
    // Only where the script asks, unless the caller says otherwise.
    mode: options.chapters ?? 'script',
  }).catch((error: unknown) => {
    // A video without chapters is the video this made before they existed.
    log.warn(`chapters: not cut (${(error as Error).message}); carrying on without`);
    return null;
  });

  if (chaptered !== null) {
    voiceAudio = chaptered.audioPath;
    durationMs = chaptered.durationMs;
    words = chaptered.words;
    chapters = chaptered.cards;
    writeChapterCards(
      slug,
      chapters.map((card) => ({ ...card, atMs: card.atMs + LEAD_IN_MS })),
    );
  } else {
    forgetChapterCards(dir);
  }

  // Where each paragraph starts, kept for the chapter marks in the YouTube
  // description -- free now, a whisper pass later if it is not written here.
  writeTimeline(slug, prose, words, LEAD_IN_MS);

  /* ------------------------------------------------------------- quotes */

  /**
   * Where the narration quotes the book, found on the page.
   *
   * Only when the book is out of copyright and on Project Gutenberg: the
   * narration's words are matched against the text, and every run of seven
   * or more that is in the book becomes a card showing the line as printed.
   */
  let quotes: QuoteCard[] = [];
  /** Kept past the quotations: the pictures are drawn from the same text. */
  let bookSource: Awaited<ReturnType<typeof loadSource>> = null;
  if (options.realSources !== false && bookName !== '') {
    const source = await loadSource(bookName, authorName);
    bookSource = source;
    if (source !== null) {
      quotes = findQuotations({
        words,
        book: source,
        attribution: `${source.source.author}, ${bookName}`,
      });
      log.info(`quotes: the narration quotes the book ${quotes.length} time(s)`);
      fs.writeFileSync(
        path.join(dir, 'sources.txt'),
        `${[
          `Quotations from "${source.source.title}" by ${source.source.author},`,
          `from the public-domain edition on Project Gutenberg — ${source.source.url}`,
        ].join('\n')}\n`,
        'utf8',
      );
    }
  }

  /* ----------------------------------------------------------- pictures */

  /**
   * One picture per stretch, not one per line.
   *
   * The count is what a viewer can absorb rather than what the essay could
   * support: a picture every ninety seconds or so gives each one time to be
   * looked at, and a new one every few seconds is a slideshow with an argument
   * playing over it.
   */
  let pictures: string[] = [];
  // Depth maps by picture, for the ones the local model could read.
  const depths: Record<string, string> = {};
  const mattes: Record<string, number> = {};
  // Who the story is about, as the picture writer decided. The cutouts are
  // drawn from the same descriptions so Gregor pasted over a frame is the
  // Gregor in the frames around it.
  let cast: CastMember[] = [];
  let sheets: Sheet[] = [];
  // The stick figure is the picture: nothing is drawn or fetched behind it.
  const source = look === 'stickman' ? 'none' : (options.pictures ?? 'none');
  if (source !== 'none') {
    stage('pictures');
    const wanted = options.pictureCount ?? Math.max(3, Math.round(durationMs / PICTURE_EVERY_MS));
    log.info(`book: ${wanted} picture(s) wanted, prompts written from the script`);
    try {
      if (source === 'ai') {
        /**
         * Sections are subdivided rather than truncated.
         *
         * The generator writes one prompt per part it is given and takes at
         * most one per part, so passing whole sections capped the count at the
         * number of sections -- five or seven. Asking for thirty pictures and
         * receiving seven, with no error, is the worst kind of ignored
         * setting. Splitting the prose into `wanted` pieces gives every
         * picture its own stretch of script to be about, which is also what
         * makes it accurate.
         */
        const parts = splitInto(prose, wanted);
        /**
         * The storybook stage, not the background stage.
         *
         * The background stage writes pictures to sit behind a short's large
         * type, so it reaches for mood: across twenty-three prompts for The
         * Metamorphosis it drew boots, a coin purse, an empty bowl and "a large
         * dark shape behind a curtain", and never once the insect. The
         * storybook stage writes a cast first and draws them into the scenes,
         * which is why the short on the same book showed Gregor and this did
         * not. Same stage now, in landscape and in the channel's medium.
         */
        const beatTexts = parts.length > 0 ? parts.map((p) => p.slice(0, 400)) : [essay.title];
        /**
         * What the book says about each stretch of narration.
         *
         * The picture writer used to see the narration and nothing else, so a
         * beat about Gregor waking up became somebody's idea of a man in a
         * bed. With the page in front of it, it draws the room Kafka wrote:
         * the rain on the window, the sample case, the picture in the gilt
         * frame. Only for books out of copyright, and only where a beat is
         * about a scene at all.
         */
        const passages =
          bookSource === null
            ? undefined
            : await chooseMoments({ book: bookSource, beats: beatTexts, seed });

        const made = await generatePanels({
          topic: essay.title,
          script: prose.slice(0, 12_000),
          seed,
          beatTexts,
          force: options.force,
          ...(passages === undefined ? {} : { passages }),
          ...(bookSource === null
            ? {}
            : { source: { title: bookSource.source.title, author: bookSource.source.author } }),
          frame: {
            width: ESSAY_ART.width,
            height: ESSAY_ART.height,
            orientation: 'landscape',
            kind: 'long-form video essay',
            medium:
              pictureStyle === 'ink'
                ? ESSAY_ART.medium.replace(/\s*The subject of the drawing is:\s*$/, '')
                : `${styleMedium.charAt(0).toUpperCase()}${styleMedium.slice(1)}. ` +
                  PICTURE_STYLES[pictureStyle].not,
          },
          // Keyed on the book, so every video about it shares one cast.
          engine: options.imageEngine ?? 'mixed',
          ...((options.imageEngine ?? 'mixed') === 'flux'
            ? {}
            : {
                /**
                 * A cast per art style. A reference drawing is also a style
                 * reference: the inked Gregor pulled every cinematic panel of
                 * him back towards a comic. So each style keeps its own.
                 */
                memory: bookName || essay.title,
                memoryVariant: memoryVariantFor(pictureStyle),
              }),
        });
        cast = made.cast;
        sheets = made.sheets;
        pictures = made.images
          .filter((image): image is NonNullable<typeof image> => image !== null)
          .map((image) => image.file);
      } else {
        const clips = await chooseFootage({
          topic: [essay.title, options.direction ?? ''].filter(Boolean).join(' '),
          script: prose.slice(0, 4000),
          seed,
          beatTexts: essay.sections.slice(0, wanted).map((p) => p.slice(0, 200)),
          force: options.force,
          // Each clip is held for a whole stretch, so nothing shorter will do.
          longestBeatMs: Math.round(durationMs / Math.max(1, wanted)),
        });
        pictures = clips
          .filter((clip): clip is NonNullable<typeof clip> => clip !== null)
          .map((clip) => clip.file);
      }
      log.info(`book: ${pictures.length} picture(s) under the type`);

      /**
       * Depth for every still, locally and for free, so the cinematic camera
       * can move through the picture instead of zooming on it. A picture the
       * model cannot read simply moves flat, as every picture did before.
       */
      if (look === 'cinematic' && options.parallax !== false) {
        const started = Date.now();
        for (const file of pictures) {
          if (/\.(mp4|webm|mov)$/i.test(file)) continue;
          const depth = await depthMapFor(path.join(IMAGE_DIR, file), { force: options.force });
          if (depth === null) continue;
          depths[file] = depth;
          // Whether a punch can be set behind this picture's subject.
          const matte = await depthMatte(path.join(IMAGE_DIR, depth));
          if (matte !== null && canGoBehind(matte)) mattes[file] = matte.threshold;
        }
        log.info(
          `book: depth for ${Object.keys(depths).length}/${pictures.length} picture(s) ` +
            `in ${((Date.now() - started) / 1000).toFixed(0)}s, ` +
            `${Object.keys(mattes).length} with a subject a caption can go behind`,
        );
      }
    } catch (error) {
      /**
       * A missing picture is not a missing video. The field and the flat
       * ground are a complete look on their own -- they were the look until
       * this existed -- so a failure here costs the pictures and nothing else.
       */
      log.warn(`book: pictures unavailable (${(error as Error).message}); going without`);
    }
  }

  /* ------------------------------------------------------------ cutouts */

  /**
   * Chosen after alignment, because a cutting is placed by the word that
   * names it.
   *
   * Every other way of timing these is worse in the same way. By section, and
   * a face arrives somewhere in a four-minute stretch that mentions the
   * person; by sentence index, and it drifts the moment the reader pauses. The
   * aligned transcript already knows the millisecond the name is spoken, which
   * is the only moment the cut actually lands.
   */
  let cutouts: Awaited<ReturnType<typeof planCutouts>> = {
    cutouts: [],
    covers: [],
    portraits: [],
    generated: 0,
    usd: 0,
  };
  // Nothing is pasted over the stick figure's world; it has its own cast.
  const wantedCutouts = look === 'stickman' ? 0 : (options.cutoutCount ?? 0);
  if (wantedCutouts > 0) {
    stage('cutouts');
    cutouts = await planCutouts({
      medium: styleMedium,
      // Every kind in every look now: the local cutout model separates a
      // photoreal figure cleanly, where the colour key punched holes in it.
      realSources: options.realSources !== false,
      engine: options.imageEngine ?? 'mixed',
      cast,
      sheets,
      title: essay.title,
      book: bookName,
      author: authorName,
      prose,
      words,
      durationMs,
      count: wantedCutouts,
      seed,
      force: options.force,
    });

    /**
     * Covers are somebody's copyright and the file says so.
     *
     * A book cover shown while arguing about the book is the ordinary use, and
     * it is what every video on this subject does -- but "ordinary" is not the
     * same as "licensed", and the difference belongs written down next to the
     * video rather than assumed. The generated subjects are not in here
     * because there is no one to credit for them.
     */
    if (cutouts.covers.length > 0) {
      fs.writeFileSync(
        path.join(dir, 'covers.txt'),
        `${[
          'Book covers shown in this video, from Open Library.',
          'Publisher copyright. Shown as the subject of commentary.',
          '',
          ...cutouts.covers.map((cover) => `${cover.name} — ${cover.url}`),
        ].join('\n')}\n`,
        'utf8',
      );
    }
    /**
     * The portraits are openly licensed, and attribution is the licence's
     * one condition -- so every one of them is named here with its author,
     * licence and source, ready to paste into the description.
     */
    if (cutouts.portraits.length > 0) {
      fs.writeFileSync(
        path.join(dir, 'portraits.txt'),
        `${[
          'Portraits shown in this video, from Wikimedia Commons.',
          '',
          ...cutouts.portraits.map(
            (portrait) =>
              `${portrait.title} — ${portrait.author} — ${portrait.licence} — ${portrait.source}`,
          ),
        ].join('\n')}\n`,
        'utf8',
      );
    }
  }

  /* --------------------------------------------------------------- edit */

  stage('edit');
  /**
   * The turn is wherever the plan put it. `moves` excludes the hook, so the
   * section index is one past the move index -- an off-by-one here would put
   * the inverted ground on the wrong argument, which is the kind of mistake
   * that is invisible in a log and obvious on screen.
   */
  const turnMove = essay.brief.moves.findIndex((move) =>
    /turn|pivot|but |however|actually/i.test(move),
  );
  const turnSection = turnMove === -1
    ? Math.max(1, Math.round(essay.sections.length * 0.55))
    : turnMove + 1;

  /**
   * Sections as the edit planner means them, which is not always how they
   * arrived.
   *
   * The writer produces four to nine sections, each an argumentative move --
   * exactly what the planner's structure is built around. A supplied script
   * arrives split on blank lines, which is the author's paragraphing, and one
   * pasted script produced fifty "sections" averaging six words. The prose
   * keeps that shape, because it is the author's and reproducing it faithfully
   * is the point of supplying a script. The planner gets a grouped view
   * instead, so the argument has somewhere to open and somewhere to rest.
   */
  const sectionWords = planningSections(essay.sections);
  const planned = planEdit({ sectionWords, durationMs, turnSection, seed });
  const plan = snapToWords(planned, words);

  const problems = checkPlan(plan);
  for (const problem of problems) log.warn(`edit: ${problem}`);

  const typewriter = options.typewriter ?? options.niche !== 'war';
  const scene = composeEssay({
    typewriter,
    ...(options.stickFinish !== undefined ? { stickFinish: options.stickFinish } : {}),
    title: essay.title,
    words,
    plan,
    seed,
    ...(options.effect !== undefined ? { effect: options.effect } : {}),
    pictures,
    depths,
    mattes,
    quotes,
    cutouts: cutouts.cutouts,
    chapters,
    look,
    // The film grade is for film stills; a painting or a cel gets a lighter one.
    grade: pictureStyle === 'film' ? 'film' : 'soft',
    ...(options.effectStrength !== undefined
      ? { effectStrength: options.effectStrength }
      : {}),
    ...(options.captionScale !== undefined ? { captionScale: options.captionScale } : {}),
    captions: {
      ...(options.punchStyle !== undefined ? { punch: options.punchStyle } : {}),
    },
  });
  /**
   * The stick figure, staged from the captions: a beat every few seconds,
   * each with its place, action, face and company, and the places painted
   * when the world is painted.
   */
  if (look === 'stickman') {
    stage('pictures');
    scene.stickman = await stageLongStickman({
      topic: essay.title,
      script: prose.slice(0, 20_000),
      lines: scene.lines,
      durationMs: scene.durationMs,
      seed,
      world: options.stickWorld ?? 'drawn',
      genre: options.niche === 'war' ? 'war' : 'books',
    });
    log.info(`book: ${scene.stickman.length} stick figure beat(s), world ${options.stickWorld ?? 'drawn'}`);
  }
  const behind = scene.lines.filter((line) => line.behind === true);
  if (look === 'cinematic' && Object.keys(mattes).length > 0) {
    const punches = scene.lines.filter((line) => line.register === 'hot').length;
    log.info(
      `book: ${behind.length} of ${punches} punch(es) set into the picture` +
        (behind.length === 0 ? '' : ` — ${behind.map((line) => `"${line.text}"`).join(', ')}`),
    );
  }
  fs.writeFileSync(
    path.join(dir, 'scene.json'),
    `${JSON.stringify(
      {
        mix: plan.mix,
        segments: plan.segments.length,
        lines: scene.lines.length,
        behind: behind.map((line) => ({ text: line.text, atMs: line.startMs })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  /* --------------------------------------------------------- the sound */

  /**
   * The bed: a file you chose, or one found from the direction.
   *
   * A search that finds nothing is not a failure -- it is a video without
   * music, which is what the default is anyway. So it warns and carries on
   * rather than taking a finished render down over a nice-to-have.
   */
  const wanted = options.music ?? 'none';
  let music = 'none';
  let bedCredit = '';

  if (wanted === 'auto') {
    const description = [options.direction, essay.title].filter(Boolean).join(' ');
    try {
      const found = await findMusic({ description, seed, minSeconds: 45 });
      if (found !== null) {
        music = found.path;
        bedCredit = `${found.name} (${found.licence}) — ${found.url}`;
      }
    } catch (error) {
      log.warn(`music: ${(error as Error).message}; going without`);
    }
  } else if (wanted !== 'none' && wanted !== '') {
    music = wanted;
  }
  if (bedCredit !== '') {
    fs.writeFileSync(path.join(dir, 'music-credit.txt'), `${bedCredit}
`, 'utf8');
    log.info(`music: ${bedCredit}`);
  }

  const punchCues = planSound({
    plan,
    seed,
    level: options.sound ?? 'none',
  }).map((cue) => ({ ...cue, atMs: cue.atMs + LEAD_IN_MS }));
  // The plates are already on the lead-in's clock; the plan's cues were not.
  // The title's typewriter: only the cinematic look types its title.
  const typing =
    look !== 'storybook' && typewriter && essay.title.trim() !== ''
      ? await planTitleTyping({ title: essay.title, dir, level: options.sound ?? 'none' }).catch(
          (error: unknown) => {
            log.warn(`sound: no typewriter under the title (${(error as Error).message})`);
            return null;
          },
        )
      : null;
  /**
   * The chapter cards type like the title does -- same keys, same timing --
   * because they are the same gesture, and a card that types in silence while
   * the title typed with keys under it reads as a bug in the sound.
   */
  const chapterKeys =
    look !== 'storybook' && typewriter
      ? (
          await Promise.all(
            chapters.map((card, i) =>
              planTitleTyping({
                title: card.title,
                dir,
                level: options.sound ?? 'none',
                atMs: card.atMs + LEAD_IN_MS,
                name: `typing-ch${i + 1}`,
              }).catch(() => null),
            ),
          )
        ).filter((cue): cue is NonNullable<typeof cue> => cue !== null)
      : [];

  /**
   * The war channel's sounds, on the words the director chose, and the
   * credits for everything the video borrowed, written next to it.
   */
  const war =
    options.niche === 'war' && options.warSfx !== false && scene.stickman !== undefined
      ? await planWarSound(scene.stickman, seed, {
          // The narration as the mix plays it: the same file, after the lead-in.
          narration: { path: voiceAudio, offsetMs: LEAD_IN_MS },
          voiceLufs: AUDIO.masterLufs,
          trimDb: options.warSfxDb ?? 0,
        })
      : null;
  if (war !== null && scene.stickman !== undefined) {
    writeWarCredits(dir, scene.stickman, war);
    log.info(`sound: ${war.cues.length} war and comedy cue(s) from ${new Set(war.used.map((s) => s.kind)).size} kind(s)`);
  }

  const cues = [
    ...(typing === null ? [] : [typing]),
    ...chapterKeys,
    ...(war?.cues ?? []),
    ...punchCues,
    ...(look === 'cinematic'
      ? planCutSound({
          cuts: scene.plates.slice(1).map((plate) => ({
            atMs: plate.startMs,
            file: plate.file,
            heldMs: plate.endMs - plate.startMs,
          })),
          seed,
          level: options.sound ?? 'none',
          avoid: punchCues.map((cue) => cue.atMs),
        })
      : []),
  ].sort((a, b) => a.atMs - b.atMs);

  /* ------------------------------------------------------- the project */

  /**
   * Saved at the seam between what costs money and what does not.
   *
   * Everything above -- the writing, the reading, the drawing -- is spent.
   * Everything below is a laptop and ten minutes. The editor opens this file,
   * changes what is in it, and renders it again through the same function the
   * pipeline uses here, so the two can never disagree about how a video is
   * assembled.
   */
  const project: Project = {
    version: PROJECT_VERSION,
    slug,
    title: essay.title,
    scene,
    render: {
      width: options.width ?? WIDTH,
      height: options.height ?? HEIGHT,
      fps: options.fps ?? FPS,
    },
    audio: {
      voice: voiceAudio,
      music,
      musicLufs: options.musicLufs ?? AUDIO.musicLufs,
      cues,
    },
    pictureStyle,
    /**
     * The settings, minus the callbacks, which are this process talking to
     * itself and mean nothing to a file.
     */
    options: Object.fromEntries(
      Object.entries(options).filter(([key, value]) => typeof value !== 'function' && key !== 'force'),
    ),
  };
  saveProject(project);

  /* ------------------------------------------------------------- render */

  stage('render');
  const { output, sizeBytes } = await renderProject({
    project,
    onStage: (which) => stage(which),
    // Frames, not percentages: the screen can say "frame 1432 of 16700".
    onProgress: ({ frames, total }) => options.onProgress?.(frames, total),
  });

  /**
   * What goes under the video, written next to it.
   *
   * Not the script: a description is read by somebody deciding whether to
   * watch, and by search, and neither of them wants a transcript. This is a
   * few lines about the argument, the chapters, what was borrowed and from
   * where, and the copyright position.
   */
  try {
    // The same text the upload sends, so what is pasted by hand and what goes
    // up automatically are never two different descriptions.
    const described = await describeLong(slug, 'essay');
    fs.writeFileSync(path.join(dir, 'description.txt'), `${described.description}
`, 'utf8');
    log.info('book: description written to description.txt');
  } catch (error) {
    log.warn(`book: no description written (${(error as Error).message})`);
  }

  /**
   * Three thumbnails from the video's own pictures, ready before anyone
   * presses upload -- the first is used unless another is picked in the
   * editor. Made again only when the pictures changed, so re-voicing a video
   * keeps the thumbnail that was chosen for it.
   */
  try {
    const existing = loadThumbnails(slug);
    const stale =
      existing !== null &&
      existing.options.some((option) => !project.scene.plates.some((plate) => plate.file === option.image));
    await makeThumbnails(project, { force: stale });
  } catch (error) {
    log.warn(`book: no thumbnails made (${(error as Error).message})`);
  }

  return {
    slug,
    title: essay.title,
    thesis: essay.brief.thesis,
    book: essay.brief.book,
    author: essay.brief.author,
    words: essay.wordCount,
    sections: essay.sections.length,
    durationMs,
    mix: plan.mix,
    segments: plan.segments.length,
    cutouts: cutouts.cutouts.length,
    output,
    sizeBytes,
  };
}

export const BOOK_RENDER = { fps: FPS, width: WIDTH, height: HEIGHT } as const;
