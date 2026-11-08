import type { StickBeat } from './stickworld.js';
import { DEVICE, variationFor, type DeviceName, type Variation } from '../design/signature.js';
import type { EditPlan, Register, Segment } from './edit.js';

/**
 * Turns a timed read and an edit plan into what is actually on screen.
 *
 * The renderer is deliberately dumb: given a frame it looks up which line is
 * showing and draws it the way its register and device say. All the deciding
 * happens here, once, where it can be inspected and tested without starting a
 * browser.
 *
 * The important decision is how the words are grouped. Type keyed to narration
 * one word at a time is the short-form grammar and it is wrong at this length
 * -- twenty-five minutes of words arriving individually is exhausting to read
 * and impossible to skim. Lines are phrases: long enough to be a thought, cut
 * at punctuation where punctuation exists, and never long enough to wrap past
 * two rows on the frame.
 */

export type Line = {
  text: string;
  startMs: number;
  endMs: number;
  /** Which word inside the line the type lands on when a HOT stretch slams. */
  stressIndex: number;
  device: DeviceName;
  register: Register;
  /**
   * How the caption is set for this line.
   *
   * Carried per line rather than fixed for the video, because the point of it
   * is that it changes: the type holds one treatment through the argument and
   * switches for the few seconds a claim lands, then goes back. A caption
   * style that never changes is a font choice; one that changes on the punch
   * is editing.
   */
  captionStyle: string;
  /**
   * When each word in the line is spoken.
   *
   * The punch reveals a word at a time, the way a short does, and it has to
   * reveal it when it is said -- evenly spaced reveals drift off the voice
   * within a line and read as a typewriter rather than as speech.
   */
  wordStarts?: number[];
  /**
   * Set into the picture, behind its subject, instead of over it.
   *
   * Only ever a punch, only in the cinematic look, and only a few per video:
   * the claim is written large across the scene and the near part of the
   * picture -- the person, the doorframe, the wall -- is drawn back over it,
   * so the words stand in the room rather than on the glass in front of it.
   * The same words run as a subtitle in the bar, because a word half behind
   * someone's shoulder is a look, not something a viewer should have to read.
   */
  behind?: boolean;
};

export type TimedWord = { text: string; startMs: number; endMs: number };

/**
 * A chapter card: a beat of silence in the narration with the chapter's number
 * and name typed across the picture.
 *
 * The pause is real -- it is cut into the reading itself, before anything is
 * timed against it -- because a card that appears while the narration carries
 * on underneath is a caption, and the thing that makes a chapter feel like a
 * chapter is that everything stops for it.
 */
export type ChapterCard = { atMs: number; index: number; title: string };

/** How much silence a chapter gets, and how much of it the card is up for. */
export const CHAPTER_PAUSE_MS = 3_600;
export const CHAPTER_CARD_MS = 3_200;

/** Words per line. A phrase, not a sentence and not a word. */
const WORDS_PER_LINE = { min: 5, max: 11 } as const;

/**
 * Where a line may end, and where it must.
 *
 * A clause ending is a good place to break once the line is long enough. The
 * end of a sentence is not a preference: a line is allowed to be three words
 * if that is what the sentence was, because the alternative is what this
 * produced before -- "a dying twitch. He stands covered in the filth of
 * human", a line that begins mid-thought and ends mid-phrase. On screen for
 * four seconds next to a voice reading it, that is unreadable, and it happened
 * whenever a sentence ended before the minimum word count.
 */
const SENTENCE_END = /[.?!]["')\]]?$/;
const CLAUSE_END = /[,;:—]$/;

/**
 * Words worth landing on. Everything else is scaffolding.
 *
 * The stressed word is what a HOT cut lands on, so picking it badly is worse
 * than not picking one: a slam on "the" reads as a mistake in a way that no
 * slam does not.
 */
const WEAK = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that',
  'this', 'as', 'by', 'not', 'he', 'she', 'they', 'we', 'you', 'his', 'her',
  'their', 'our', 'has', 'have', 'had', 'do', 'does', 'did', 'no', 'so', 'if',
]);

/**
 * Words a line must not end on.
 *
 * A seam after "the" or "almost" leaves the viewer holding an incomplete
 * thought for four seconds while the voice has already moved on. The balanced
 * split gets the lengths right and knows nothing about grammar, so this is the
 * one grammatical rule it gets: if the seam lands here, move it a word.
 */
const DANGLING = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'and', 'or', 'but', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'his',
  'her', 'its', 'their', 'our', 'my', 'this', 'that', 'these', 'those',
  'almost', 'very', 'just', 'more', 'most', 'not', 'no', 'so', 'than', 'into',
]);

function stressIn(words: readonly TimedWord[]): number {
  let best = 0;
  let bestScore = -1;
  for (const [i, word] of words.entries()) {
    const bare = word.text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}'-]/gu, '');
    if (bare === '' || WEAK.has(bare)) continue;
    // Longer words carry more, and later words in a phrase carry the point --
    // English puts the news at the end.
    const score = bare.length + i * 0.6;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Groups a read into phrase-length lines.
 *
 * Sentence-first, then balanced. Taking words greedily up to the cap is the
 * obvious implementation and it strands the remainder: a twenty-five word
 * sentence became eleven, eleven and three, so "earth." and "dying twitch."
 * appeared alone on screen for a second each. Splitting a long sentence into
 * equal parts instead -- and nudging each seam to the nearest clause boundary
 * -- gives lines that are all readable lengths and all begin where a thought
 * begins.
 */
export function buildLines(
  words: readonly TimedWord[],
): Omit<Line, 'device' | 'register' | 'captionStyle'>[] {
  const lines: Omit<Line, 'device' | 'register' | 'captionStyle'>[] = [];

  const emit = (group: TimedWord[]): void => {
    if (group.length === 0) return;
    lines.push({
      text: group.map((w) => w.text).join(' '),
      startMs: group[0]!.startMs,
      endMs: group[group.length - 1]!.endMs,
      stressIndex: stressIn(group),
      wordStarts: group.map((w) => w.startMs),
    });
  };

  // Sentences first. Nothing ever spans one.
  const sentences: TimedWord[][] = [];
  let current: TimedWord[] = [];
  for (const word of words) {
    current.push(word);
    if (SENTENCE_END.test(word.text)) {
      sentences.push(current);
      current = [];
    }
  }
  if (current.length > 0) sentences.push(current);

  for (const sentence of sentences) {
    if (sentence.length <= WORDS_PER_LINE.max) {
      emit(sentence);
      continue;
    }

    /**
     * Equal parts, each nudged to a clause boundary where one is close.
     *
     * The count comes first and the seams follow, which is what keeps the
     * parts even -- choosing seams first and counting afterwards is the greedy
     * version by another name.
     */
    const parts = Math.ceil(sentence.length / WORDS_PER_LINE.max);
    const ideal = sentence.length / parts;

    let from = 0;
    for (let p = 1; p <= parts; p++) {
      let to = p === parts ? sentence.length : Math.round(ideal * p);

      if (p < parts) {
        // Look either side of the ideal seam for a comma or semicolon.
        let moved = false;
        for (let offset = 0; offset <= 3 && !moved; offset++) {
          const before = to - offset;
          const after = to + offset;
          if (before > from && CLAUSE_END.test(sentence[before - 1]!.text)) {
            to = before;
            moved = true;
          } else if (after < sentence.length && CLAUSE_END.test(sentence[after - 1]!.text)) {
            to = after;
            moved = true;
          }
        }

        // No punctuation nearby: at least do not leave the line hanging.
        const bare = (i: number): string =>
          (sentence[i]?.text ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}'-]/gu, '');
        for (let guard = 0; guard < 3 && DANGLING.has(bare(to - 1)); guard++) {
          if (to + 1 >= sentence.length) break;
          to += 1;
        }
      }

      emit(sentence.slice(from, to));
      from = to;
    }
  }

  return lines;
}

/**
 * Which device marks which line.
 *
 * Assigned from the edit plan rather than by matching the thesis text against
 * the narration. Matching sounds more precise and is not: the narration
 * paraphrases its own thesis constantly, so a string match either fires on
 * every other line or on none, depending on how strict it is. The plan already
 * knows where the argument states itself, turns, and sits with its evidence --
 * which is the same information, already decided, and stable.
 */
function deviceFor(segment: Segment, indexInSegment: number, total: number): DeviceName {
  if (segment.marksTurn === true) return DEVICE.turn;

  /**
   * A hot stretch states the case. The claim lands at the end of it, not the
   * start: the opening lines of a hot run are still arriving, and carving the
   * first line of every section would make the device mean "a section began".
   */
  if (segment.register === 'hot') {
    return indexInSegment >= total - 2 ? DEVICE.thesis : DEVICE.plain;
  }

  // A held composition is where evidence is sat with, which is what lift is for.
  if (segment.register === 'cold') return DEVICE.evidence;

  return DEVICE.plain;
}

/**
 * A picture, and the stretch of the essay it belongs to.
 *
 * Timed rather than counted: an essay is not a list of beats, so "the fourth
 * image" means nothing, but "the picture from 4:10 to 6:35" is exactly what
 * the renderer needs to look up by frame.
 */
export type Plate = {
  file: string;
  startMs: number;
  endMs: number;
  /** Video files behave differently from stills and the renderer must know. */
  motion: boolean;
  /**
   * A depth map of the still, white near, under public/images. With one, the
   * cinematic renderer moves the near part of the picture past the far part
   * -- a camera move -- instead of pushing in on a flat print.
   */
  depth?: string;
  /**
   * The depth (0 far, 1 near) that separates the picture's subject from what
   * is behind it -- present only when the picture has a subject a caption can
   * pass behind. See `canGoBehind`.
   */
  matte?: number;
};

/**
 * 'person' is somebody who really lived -- the author, a judge, a critic --
 * and is shown by their real photograph or portrait where one is openly
 * licensed; 'character' is somebody in the story, and is drawn.
 */
export type CutoutKind = 'character' | 'person' | 'book' | 'object';

/**
 * A subject pasted over the frame at the moment the narration names it.
 *
 * Separate from a plate because it is the opposite kind of thing. A plate is
 * what the video is looking at and it fills the frame; a cutting is stuck on
 * top of whatever the video was already looking at, keeps its own edges, and
 * leaves again. Folding the two into one list would mean every rule about
 * scale, side and tilt needed a "but not for backgrounds" clause.
 */
export type Cutout = {
  /** A file under public/images. Keyed subjects carry alpha; covers do not. */
  file: string;
  kind: CutoutKind;
  /** What it is, for the log and the credits. Never drawn on screen. */
  name: string;
  startMs: number;
  endMs: number;
  /** Which side of the frame it is pasted on. */
  side: 'left' | 'right';
  /** Degrees off square. Small, and never zero. */
  tilt: number;
  /** How tall it stands, as a share of frame height. */
  scale: number;
  /**
   * How it arrives. Absent is 'rise', which is how every cutting arrived
   * before there was a choice, so older projects play as they did.
   */
  entrance?: 'rise' | 'slide' | 'drop' | 'flip';
  /** Flipped left to right, so a figure looks into the frame rather than out of it. */
  mirror?: boolean;
  /** Where its base sits, as a share of frame height from the bottom. Absent is 0.28. */
  lift?: number;
};

/**
 * A line of the book, shown as it is printed while the narration quotes it.
 *
 * Only ever text found on the page: the narration's words are matched against
 * the book's own text, so a card cannot show a misquotation.
 */
export type QuoteCard = {
  text: string;
  /** "Oscar Wilde, The Picture of Dorian Gray". */
  attribution: string;
  /** When the narration says the first and the last quoted word. */
  speakStartMs: number;
  speakEndMs: number;
};

/**
 * How long the title holds before the narration starts.
 *
 * A video that begins mid-word gives a viewer nothing to land on -- the player
 * is still buffering, the volume is still wrong, and the first sentence is the
 * one carrying the argument. Four seconds is a title typing itself out and a
 * beat of quiet after it, which is enough to arrive.
 */
export const LEAD_IN_MS = 4_000;

export type EssayScene = {
  title: string;
  lines: Line[];
  durationMs: number;
  variation: Variation;
  seed: number;
  /** The shader field behind the type, or 'none' for the flat ground. */
  effect: string;
  /**
   * How strongly the field sits over a picture, 0 to 1.
   *
   * A control rather than a word, because "heavy static" is not a setting --
   * it is one point on a range, and the right point depends on how busy the
   * picture underneath is. The old behaviour is 0.5.
   */
  effectStrength: number;
  /** Multiplier on every type size. 1 is the house setting. */
  captionScale: number;
  /** Pictures under the type. Empty is a perfectly good answer. */
  plates: Plate[];
  /** Subjects pasted over the picture. Empty is a perfectly good answer. */
  cutouts: Cutout[];
  /** The book's own words, on screen while the narration quotes them. */
  quotes: QuoteCard[];
  /** The whole look: cinematic (grade, bars, grain, cuts) or storybook. */
  look: EssayLook;
  /** Chapter cards, on the video's clock. Empty for a video without chapters. */
  chapters: ChapterCard[];
  /** Whether the title and chapter names are typed on. Absent means yes. */
  typewriter?: boolean;
  /** Stickman only: the cinematic finish (bars, grade, grain) or plain. Absent means cinematic. */
  stickFinish?: 'cinematic' | 'plain';
  /**
   * How hard the cinematic grade leans. Film for film stills; soft for
   * paintings, cels and drawings, whose colour is the point of the style --
   * the full teal-and-amber turns a watercolour into a muddy photograph.
   */
  grade: EssayGrade;
  /** The stick figure's beats, on the video's clock, when the look is stickman. */
  stickman?: StickBeat[];
};

export type EssayGrade = 'film' | 'soft';

/**
 * cinematic: pictures, grade, bars and grain. storybook: drawn panels on paper.
 * stickman: the stick figure acting the essay out in its world, no pictures.
 */
export type EssayLook = 'cinematic' | 'storybook' | 'stickman';

export type CaptionStyles = {
  /**
   * Swapped in for hot stretches, where the claim lands.
   *
   * The only caption treatment there is to choose. Narration has a fixed one
   * -- the handwriting at caption size -- because a subtitle that changes
   * character between videos is not a style, it is an inconsistency, and this
   * channel is built on being recognisable.
   */
  punch: string;
};

/**
 * The whole of what the renderer needs, decided here.
 *
 * Lines that straddle a segment boundary are assigned to the segment holding
 * their midpoint rather than split. Splitting them would put half a phrase in
 * a held composition and half in a slam, which reads as a glitch rather than
 * as an edit -- and the boundaries were snapped to word gaps precisely so that
 * this is rare.
 */
export function composeEssay(options: {
  title: string;
  words: readonly TimedWord[];
  plan: EditPlan;
  seed: number;
  effect?: string;
  captions?: Partial<CaptionStyles>;
  /** Files under public/images, spread evenly across the runtime. */
  pictures?: readonly string[];
  /** Subjects already timed to the words that name them. */
  cutouts?: readonly Cutout[];
  /** Depth maps by picture file, for the pictures that have one. */
  depths?: Readonly<Record<string, string>>;
  /** Where each picture's subject separates from its background, for the few that have one. */
  mattes?: Readonly<Record<string, number>>;
  /** Quotations of the book, timed to the narration. */
  quotes?: readonly QuoteCard[];
  /** Chapter cards, on the narration's clock; the lead-in is added here. */
  chapters?: readonly ChapterCard[];
  typewriter?: boolean;
  stickFinish?: 'cinematic' | 'plain';
  look?: EssayLook;
  grade?: EssayGrade;
  effectStrength?: number;
  captionScale?: number;
}): EssayScene {
  const { title, words, plan, seed } = options;
  const captions: CaptionStyles = {
    // Highlighter, because it is the one treatment that stays legible over
    // any drawing: a solid block of the accent behind the word the claim
    // turns on. Hollow outline is still offered and is still the weakest --
    // a transparent glyph shows the picture through itself, and no amount of
    // stroke fully undoes that.
    punch: options.captions?.punch ?? 'highlight',
  };
  const bare = buildLines(words);

  const segmentAt = (ms: number): Segment => {
    const found = plan.segments.find((s) => ms >= s.startMs && ms < s.endMs);
    return found ?? plan.segments[plan.segments.length - 1]!;
  };

  // How many lines each segment holds, so a device can know where it sits.
  const counts = new Map<Segment, number>();
  const owner = bare.map((line) => {
    const segment = segmentAt((line.startMs + line.endMs) / 2);
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
    return segment;
  });

  const seen = new Map<Segment, number>();
  const lines: Line[] = bare.map((line, i) => {
    const segment = owner[i]!;
    const indexInSegment = seen.get(segment) ?? 0;
    seen.set(segment, indexInSegment + 1);
    return {
      ...line,
      register: segment.register,
      device: deviceFor(segment, indexInSegment, counts.get(segment) ?? 1),
      /**
       * Two styles, not three, and the register decides between them.
       *
       * `cold` had its own style and its own place in the middle of the frame,
       * which meant ordinary narration -- a sentence about what a man had
       * watched happen -- was set at sixty-six points in outlined serif across
       * the centre of the picture. That is a title card, and a viewer reads a
       * title card as "this is the important bit". Getting one several times a
       * minute teaches them the opposite: that nothing here is the important
       * bit.
       *
       * So the only line that leaves the caption band is the one the edit plan
       * calls the claim.
       */
      // Empty for narration: the renderer's caption band supplies its own.
      captionStyle: segment.register === 'hot' ? captions.punch : '',
    };
  });

  /**
   * Spread evenly, and held across whatever registers they land on.
   *
   * Cutting a picture on every register change would mean a new image every
   * few seconds through a hot stretch, which is a slideshow rather than an
   * edit. A plate outlasts the cuts happening over it; what changes on a cut
   * is the type and the frame, not the subject.
   */
  const pictures = options.pictures ?? [];
  const span = pictures.length === 0 ? 0 : plan.durationMs / pictures.length;
  const plates: Plate[] = pictures.map((file, i) => ({
    file,
    startMs: Math.round(span * i),
    endMs: Math.round(i === pictures.length - 1 ? plan.durationMs : span * (i + 1)),
    motion: /\.(mp4|webm|mov)$/i.test(file),
    ...(options.depths?.[file] === undefined ? {} : { depth: options.depths[file] }),
    ...(options.depths?.[file] === undefined || options.mattes?.[file] === undefined
      ? {}
      : { matte: options.mattes[file] }),
  }));

  /**
   * Everything shifts by the lead-in, here rather than in the renderer.
   *
   * The narration is muxed with the same offset, so the two stay locked; doing
   * it in the component instead would mean the picture knew about a delay the
   * audio did not, which is the shape of every lip-sync bug.
   */
  for (const line of lines) {
    line.startMs += LEAD_IN_MS;
    line.endMs += LEAD_IN_MS;
    // Shifted with the line, or every word reveals four seconds early.
    if (line.wordStarts !== undefined) {
      line.wordStarts = line.wordStarts.map((ms) => ms + LEAD_IN_MS);
    }
  }
  for (const plate of plates) {
    plate.startMs += LEAD_IN_MS;
    plate.endMs += LEAD_IN_MS;
  }
  /**
   * The cuttings shift with everything else.
   *
   * They are timed against the aligned transcript, which starts at zero
   * because the narration does. The title card is in front of all of it, so a
   * cutting left unshifted lands four seconds early -- over a different
   * sentence, which is the one failure mode this feature cannot survive.
   */
  const cutouts = (options.cutouts ?? []).map((cutout) => ({
    ...cutout,
    startMs: cutout.startMs + LEAD_IN_MS,
    endMs: cutout.endMs + LEAD_IN_MS,
  }));
  /**
   * The first picture reaches back over the opening.
   *
   * Shifted like the rest, it left the lead-in with nothing behind it -- so a
   * video with pictures opened on four seconds of bare shader, which reads as
   * television static rather than as a title. The title should type over the
   * first image of the essay, which is the image the essay opens on anyway.
   */
  const first = plates[0];
  if (first !== undefined) first.startMs = 0;

  /**
   * A chapter gets a picture of its own.
   *
   * The pictures are spread evenly and the chapters are not, so a card would
   * otherwise land in the middle of a shot and the essay would carry on
   * looking at the same thing it was looking at before the chapter. The
   * nearest cut is pulled onto the card instead -- only the nearest, and only
   * when it is within half a shot, so the spread barely moves.
   */
  const chapters = (options.chapters ?? []).map((chapter) => ({
    ...chapter,
    atMs: chapter.atMs + LEAD_IN_MS,
  }));
  if (plates.length > 1) {
    const reach = span / 2;
    for (const chapter of chapters) {
      let nearest = -1;
      let best = reach;
      for (let i = 1; i < plates.length; i++) {
        const gap = Math.abs(plates[i]!.startMs - chapter.atMs);
        if (gap < best) {
          best = gap;
          nearest = i;
        }
      }
      if (nearest < 0) continue;
      plates[nearest - 1]!.endMs = chapter.atMs;
      plates[nearest]!.startMs = chapter.atMs;
    }
  }

  if ((options.look ?? 'cinematic') === 'cinematic') placeBehind(lines, plates);

  return {
    title,
    lines,
    durationMs: plan.durationMs + LEAD_IN_MS,
    variation: variationFor(seed),
    seed,
    effect: options.effect ?? 'none',
    // Clamped here rather than trusted: these come from a form, and a caption
    // at eight times its size is a broken render rather than a bold choice.
    effectStrength: Math.min(1, Math.max(0, options.effectStrength ?? 0.5)),
    captionScale: Math.min(1.6, Math.max(0.6, options.captionScale ?? 1)),
    plates,
    cutouts,
    // On the lead-in's clock, like every other timed thing.
    quotes: (options.quotes ?? []).map((quote) => ({
      ...quote,
      speakStartMs: quote.speakStartMs + LEAD_IN_MS,
      speakEndMs: quote.speakEndMs + LEAD_IN_MS,
    })),
    look: options.look ?? 'cinematic',
    grade: options.grade ?? 'film',
    chapters,
    typewriter: options.typewriter ?? true,
    stickFinish: options.stickFinish ?? 'cinematic',
  };
}

/* ------------------------------------------------------- behind the subject -- */

/**
 * At most one caption in the scene per this long.
 *
 * A few, not all. The first one is the moment a viewer notices the picture is
 * a place; every one after that is the same trick again, and by the fifth it
 * is a filter. Forty seconds leaves a fifteen-minute essay with a handful.
 */
export const BEHIND_GAP_MS = 40_000;

/**
 * Where a caption set into the picture sits, as shares of the frame: across the
 * upper middle, clear of the letterbox and of the ground at the bottom -- which
 * a depth model always reads as near, and which would swallow any word set on
 * it. Shared by the depth analysis, which checks there is a subject here, and
 * the renderer, which puts the words here.
 */
export const BEHIND_BAND = { top: 0.24, bottom: 0.56, left: 0.1, right: 0.9 } as const;

/**
 * Longest punch that still reads set this large: two lines of a couple of dozen
 * capitals. Anything longer would have to shrink until it stopped being the
 * size that makes the effect.
 */
const BEHIND_MAX_CHARS = 44;

/**
 * Chooses which punches are set into the picture.
 *
 * A punch qualifies when the picture under it has a subject to pass behind
 * (the plate carries a matte), the picture holds for the whole line -- a cut
 * mid-line would swap the subject out from in front of the words -- and the
 * line is short enough to set large. The first qualifying punch in each
 * stretch of BEHIND_GAP_MS gets it.
 */
function placeBehind(lines: Line[], plates: readonly Plate[]): void {
  let last = -Infinity;
  for (const line of lines) {
    if (line.register !== 'hot') continue;
    if (line.text.length > BEHIND_MAX_CHARS) continue;
    if (line.startMs - last < BEHIND_GAP_MS) continue;
    const plate = plates.find((p) => line.startMs >= p.startMs && line.endMs <= p.endMs);
    if (plate === undefined || plate.motion || plate.depth === undefined || plate.matte === undefined) continue;
    line.behind = true;
    last = line.startMs;
  }
}
