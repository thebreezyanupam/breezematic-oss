import { chooseQuotations, loadSource } from './quotes.js';
import { cache } from '../cache.js';
import { MODELS } from '../config.js';
import { log } from '../log.js';
import { generate, toInt32Seed } from '../providers/gemini.js';

/**
 * A twenty-to-thirty minute argued essay about one book.
 *
 * Structurally this borrows from the saga writer next door -- a plan first,
 * then sections written one at a time against that plan and a running account
 * of what has been argued -- because the length problem is the same and that
 * shape solves it. Everything else is its opposite.
 *
 * The saga writer is told to invent everything, never address the listener,
 * and never resolve loudly enough to wake anyone. This one is told to take a
 * position on a real book and defend it. A neutral summary is the failure mode
 * here, not the goal: there are ten thousand plot recaps of every famous novel
 * and none of them are worth twenty-five minutes of anybody's evening. The
 * thing that is worth it is somebody who has read it carefully saying "the
 * obvious reading of this ending is wrong, and here is what I think is
 * actually happening" -- and then not backing down for half an hour.
 *
 * Two constraints are load-bearing rather than stylistic.
 *
 * The first is that this is commentary, not reproduction. It argues about a
 * book; it does not perform one. Quotation is capped at a phrase, because a
 * video that reads long passages aloud is a derivative work no matter how good
 * the analysis around it, and the whole point of this niche is that nobody has
 * a claim on it.
 *
 * The second is that the structure is chosen per book rather than filled in.
 * A fixed eight-part template applied to forty novels is exactly what a
 * platform review looks for, and it is also just worse: an essay about a
 * suppressed book and an essay about an ambiguous ending are not the same
 * shape of argument, and pretending otherwise produces forty videos that feel
 * like one.
 */

/**
 * Kokoro's measured pace, shared with the saga writer: 673 words came back as
 * 3.58 minutes. Changing the voice tempo changes this number.
 */
const WORDS_PER_MINUTE = 187;

/** Roughly ninety seconds. The hook is timed, not estimated. */
const HOOK_WORDS = 280;

/** Long enough to develop one move in the argument, short enough to stay prose. */
const WORDS_PER_SECTION = 720;

/**
 * What a section actually comes back as, which is not what it was asked for.
 *
 * Measured over a six-section run: 254, 598, 644, 632, 644, 564 — so the ask
 * of 720 lands around 620, about fourteen per cent short. Planning the section
 * count against the ask rather than the delivery is how a twenty-five minute
 * request becomes a twenty-one minute video, and on a channel whose currency
 * is watch hours that is four minutes given away per upload.
 *
 * The ask stays at 720. Asking for what you want and planning for what you get
 * is the correct pair here: lowering the ask lowers the delivery with it.
 */
const SECTION_WORDS_DELIVERED = 620;

/**
 * How much of what is asked for actually comes back.
 *
 * The same 620-against-720 measurement, as a ratio, so an ask can be computed
 * from a wanted length instead of only the other way round.
 */
const DELIVERY = SECTION_WORDS_DELIVERED / WORDS_PER_SECTION;

/** The most of a short essay the opening is allowed to eat. */
const HOOK_SHARE = 0.22;

/**
 * Below this a section stops being prose and becomes a caption with ambitions.
 * It is a floor on the writing, not on the runtime -- a two-minute request
 * overshoots slightly rather than producing four sentences.
 */
const MIN_SECTION_WORDS = 90;

/**
 * How the words are divided, given a runtime and a number of moves.
 *
 * This exists because the section length used to be a constant, and a constant
 * section length makes short essays impossible rather than merely rare. Four
 * moves is a floor -- there is no room to state a case, test it and land it in
 * fewer -- and at 620 delivered words each, the shortest essay this could
 * physically produce was about 2,760 words: fourteen and a half minutes. A
 * three-minute request came back at 2,749 words. The arithmetic was not wrong
 * anywhere; nothing ever divided the budget by the number of sections.
 *
 * So the move count still comes from the runtime and still bottoms out at
 * four, and the sections shrink to fit inside whatever is left. Long form is
 * untouched by this: at twenty-five minutes it works out at 628 words a
 * section, which is the 620 it was already delivering.
 */
function budget(minutes: number, moves: number): { hook: number; section: number } {
  const total = minutes * WORDS_PER_MINUTE;
  const hook = Math.min(HOOK_WORDS, Math.round(total * HOOK_SHARE));
  const section = Math.max(MIN_SECTION_WORDS, Math.round((total - hook) / Math.max(1, moves)));
  // Asked for high, because the ask is what lands short. Lowering the ask to
  // match the delivery lowers the delivery with it.
  return { hook: Math.round(hook / DELIVERY), section: Math.round(section / DELIVERY) };
}

/**
 * The verticals, in the order search demand actually runs.
 *
 * Each is a different *kind* of argument rather than a different subject, which
 * is why they are here and not in a prompt: an endings essay is a reading, a
 * banned-books essay is a history, a feud is a narrative. They want different
 * shapes and different evidence, and the plan is told which one it is writing.
 */
export const VERTICALS = ['ending', 'banned', 'lost', 'feud', 'canon', 'war'] as const;
export type Vertical = (typeof VERTICALS)[number];

export const VERTICAL_BRIEF: Record<Vertical, string> = {
  ending:
    'An ending nobody agrees about. The essay argues for one reading against the ' +
    'popular one. Spoilers are the entire point — never withhold, never tease. The ' +
    'evidence is textual: what is on the page, what is conspicuously not, what the ' +
    'structure does that the plot does not.',
  banned:
    'A book that was banned, censored, prosecuted or quietly suppressed. The essay ' +
    'argues about what the suppression was actually about, which is rarely the ' +
    'reason given at the time. The evidence is historical: who objected, what they ' +
    'said, what they did, and what the book was doing that frightened them.',
  lost:
    'A book that was destroyed, abandoned, left unfinished, or never written. The ' +
    'essay argues about what was lost — what the finished thing would have been, ' +
    'and whether the loss was accident, decision or myth.',
  feud:
    'A fight between writers, or between a writer and a publisher, critic or ' +
    'institution. The essay argues about what the fight was really over, which is ' +
    'almost never what either side said it was over.',
  canon:
    'One author, read as a whole. The essay argues for a shape in the body of work ' +
    'that the individual books hide — a preoccupation, a retreat, a question asked ' +
    'repeatedly and answered differently each time.',
  war:
    'Military history, told for laughs: a war, a battle, a campaign, a blunder or a ' +
    'commander. The video\'s position is the real story behind the famous version — ' +
    'usually that it was stupider, stranger or more human than the legend. The ' +
    'evidence is the record: dates, numbers, orders, what was actually said.',
};

export type Case = {
  /** The question somebody types at one in the morning, having just finished it. */
  title: string;
  book: string;
  author: string;
  /** Publication year as plain text; '' when genuinely unsure rather than guessed. */
  year: string;
  /** The position this essay holds and will not abandon. One sentence. */
  thesis: string;
  /** The reading the essay is against. Stated fairly, because a straw man loses. */
  commonReading: string;
  /** Where the argument pivots, and why it lands there rather than anywhere else. */
  turn: string;
  /** What the narrator opens on. Not a summary — the specific irritant. */
  hook: string;
  /** The sections, in order. Each an argumentative move, never a plot stage. */
  moves: string[];
  /** Concrete anchors: what happens on the page, what the record shows. */
  evidence: string[];
  /** War channel: what each move's chapter card says. */
  chapterTitles?: string[];
};

export type Essay = {
  title: string;
  brief: Case;
  /** Lines from the book the writer was given, checked against its text. */
  quotations?: string[];
  /** Section zero is the hook and is written in a different register. */
  sections: string[];
  wordCount: number;
};

const CASE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    book: { type: 'string' },
    author: { type: 'string' },
    year: { type: 'string' },
    thesis: { type: 'string' },
    commonReading: { type: 'string' },
    turn: { type: 'string' },
    hook: { type: 'string' },
    moves: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    // War channel only: a chapter name per move. Optional, so the books
    // channel's plans are unchanged.
    chapterTitles: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'title', 'book', 'author', 'year', 'thesis',
    'commonReading', 'turn', 'hook', 'moves', 'evidence',
  ],
};

const SECTION_SCHEMA = {
  type: 'object',
  properties: { prose: { type: 'string' }, argued: { type: 'string' } },
  required: ['prose', 'argued'],
};

/**
 * The register, and the two rules that are not about register at all.
 *
 * Everything before "Two hard rules" is voice and can be argued with. The two
 * rules cannot: one is what keeps the channel lawful, and the other is what
 * keeps it honest. An essay that invents a scholar to cite is worse than an
 * essay with no citations, because it is confidently wrong in a way a viewer
 * cannot check and a reviewer can.
 */
const VOICE = [
  'You write long-form video essays about books, for an audience that has read',
  'the book and come looking for an argument about it.',
  '',
  'You hold a position and defend it. You are not a summariser and not a',
  'neutral guide. Never write "some readers think... while others believe" and',
  'then decline to choose; that sentence is the reason most book videos are',
  'unwatchable. State what you think is true and give reasons.',
  '',
  'Concrete over abstract. Name what happens on the page. Prefer one exact',
  'detail to three general observations. Short sentences when the point is',
  'sharp, long ones when the thought needs room.',
  '',
  'No filler. No "in this video". No "let us dive in". No sign-off, no request',
  'for likes, no rhetorical questions asked only to be answered in the next',
  'sentence. No headings, no lists, no stage directions — every word is spoken',
  'aloud.',
  '',
  'TWO HARD RULES.',
  '',
  '1. This is commentary about a book, not a performance of it. You may quote a',
  '   phrase where the exact words matter — a handful of words, inside the',
  '   sentence, never set apart as a passage. Never reproduce a paragraph, a',
  '   scene, a poem or a lyric. Describe and paraphrase instead.',
  '',
  '2. Never invent evidence. Do not attribute a claim to a named critic,',
  '   scholar, letter, interview or biography unless you are confident it is',
  '   real, and never write "critics agree", "scholars have noted" or "research',
  '   shows". An argument from what is on the page is always available and is',
  '   always stronger. Where you are uncertain about a fact, write the sentence',
  '   without it.',
].join('\n');

/**
 * The war channel's voice. Funny the way a well-read friend is funny about
 * history: fast, deadpan, specific, with the jokes pointed at egos, blunders
 * and logistics -- never at the people who suffered for them. The two hard
 * rules are the same as the essays', and matter more here: a comedy channel
 * that makes up a casualty figure is spreading a lie with a laugh attached.
 */
const VOICE_WAR = [
  'You write narration for a comedic military history channel, for viewers',
  'who love history and the internet in equal measure.',
  '',
  'Funny, fast and precise. Deadpan delivery, specific facts, jokes that land at',
  'the ends of sentences. Running gags and callbacks. Modern slang and meme',
  'phrasing sparingly and knowingly -- a "bro really said" or "and it was, in',
  'fact, not fine" now and then, never every line. Commanders are characters with',
  'egos; armies are group chats that went wrong; logistics are always the plot.',
  '',
  'The humour is aimed at vanity, incompetence, absurd plans and the gap between',
  'the legend and what happened. Never at the dead, the wounded, civilians or',
  'atrocities: when the story reaches real suffering, drop the jokes for a',
  'sentence or two and say it plainly, then move on.',
  '',
  'No filler. No "in this video", no "let us dive in", no sign-off, no request',
  'for likes. No headings, no lists, no stage directions -- every word is spoken',
  'aloud.',
  '',
  'TWO HARD RULES.',
  '',
  '1. Never invent facts. Dates, numbers, names, units, quotations and outcomes',
  '   must be real. A joke can exaggerate a feeling; it can never change a fact.',
  '   Where you are unsure of a number, write the sentence without it.',
  '',
  '2. Never put words in a real person\'s mouth as a quotation unless they',
  '   actually said them. Paraphrase is fine and should be marked as such',
  '   ("basically said", "his vibe was").',
].join('\n');

const WAR_SHAPES = [
  'Open on the most absurd true moment, then rewind to how anyone thought this was a good idea.',
  'Tell it as a series of escalating bad decisions, each worse than the last.',
  'Follow the one person who kept making it worse.',
  'Tell the legend first, then the less flattering truth.',
  'Start in the planning meeting, and keep cutting back to how the plan was going.',
  'Tell it from the losing side, as they slowly realise.',
];

/**
 * Structural shapes, so forty essays are not one essay forty times.
 *
 * Picked by seed rather than by the model, because a model asked to "vary the
 * structure" converges on its favourite within a handful of calls. This is the
 * single most important defence against looking like a factory, and it is
 * cheap: the same book under two shapes is genuinely two different essays.
 */
const SHAPES = [
  'Open on the last page and work backwards to the first.',
  'Open on what the book was received as, then show what it actually is.',
  'Follow one object, image or repeated word through the whole book.',
  'Argue the case for the common reading properly, then dismantle it.',
  'Open on the author at the moment of writing it, then read the book through that.',
  'Take the one scene everybody remembers and show it has been misremembered.',
  'Read the book against the one it is usually compared to, and show the comparison is wrong.',
  'Start from a small, apparently trivial inconsistency and follow it until it is not trivial.',
];

async function buildCase(options: {
  book: string;
  vertical: Vertical;
  angle: string;
  minutes: number;
  seed: number;
}): Promise<Case> {
  const { book, vertical, angle, minutes, seed } = options;
  const war = vertical === 'war';
  const shapes = war ? WAR_SHAPES : SHAPES;
  const shape = shapes[seed % shapes.length] ?? shapes[0]!;
  /**
   * Four is a floor rather than a target: below four sections there is not
   * enough room to state a case, test it and land it, so a very short essay
   * gets a fuller argument than its runtime strictly asks for. Above that the
   * arithmetic decides, against the delivered length rather than the asked-for
   * one.
   */
  const moves = Math.max(
    4,
    Math.round((minutes * WORDS_PER_MINUTE - HOOK_WORDS) / SECTION_WORDS_DELIVERED),
  );

  const { value } = await cache.json<Case>(
    'essay-case',
    { book, vertical, angle, minutes, seed, model: MODELS.llm.script, v: 1, ...(war ? { voice: 'war-2' } : {}) },
    async () => {
      const response = await generate({
        model: MODELS.llm.script,
        systemInstruction: war ? VOICE_WAR : VOICE,
        prompt: [
          war
            ? `Plan a ${minutes}-minute comedic military history video about: ${book}`
            : `Plan a ${minutes}-minute video essay about: ${book}`,
          '',
          `Kind of essay: ${VERTICAL_BRIEF[vertical]}`,
          angle.trim() === '' ? '' : `The angle wanted: ${angle.trim()}`,
          '',
          `Structure to use: ${shape}`,
          '',
          'Return:',
          ...(war
            ? [
                '- title: a title somebody would click that is also true: the funniest',
                '  honest summary of what happened. No colon, no fake stakes.',
                '- book: the war, battle or event by name. author: the person the story',
                '  is really about, or "" if nobody is. year: when it happened, or "".',
                '- thesis: the take -- what really happened, in one sentence.',
                '- commonReading: the famous version, the legend, the textbook line.',
                '- turn: where it all goes wrong, and why there.',
                '- hook: the most absurd true detail, to open on.',
                `- moves: exactly ${moves} sections, in order, following the structure`,
                '  above. Each moves the story on -- what happened next and why it was',
                '  a mistake -- never "background" for its own sake.',
                '- evidence: 6-10 real facts the story rests on: dates, numbers, units,',
                '  orders, outcomes. Only ones you are sure of.',
                `- chapterTitles: exactly ${moves} chapter names, one per move, typed on`,
                '  screen as the chapter card: 2 to 5 words, Title Case, funny and specific',
                '  ("The Emus Adapt", "Enter the Machine Guns"). No numbers, no colons.',
              ]
            : [
          '- title: what somebody types into search at one in the morning having',
          '  just finished the book. A real question or a flat claim. Not a',
          '  headline, no colon, no "explained" if you can avoid it.',
          '- book, author, year: the work itself. Leave year empty rather than guess.',
          '- thesis: the position this essay holds, in one sentence. It must be',
          '  arguable — something a reasonable person could dispute.',
          '- commonReading: the reading this essay is against, stated at its',
          '  strongest. If it sounds stupid, you have written it wrong.',
          '- turn: where the argument pivots and why there.',
          '- hook: what the first ninety seconds opens on. The specific irritant,',
          '  not a summary and not a promise of what is coming.',
          `- moves: exactly ${moves} sections, in order, following the structure`,
          '  above. Each is one step in the argument — describe the move, not the',
          '  plot. Never "the plot so far" or "background on the author".',
          '- evidence: 6-10 concrete anchors from the book or the record that the',
          '  argument will rest on. Things that are demonstrably there.',
              ]),
        ].filter((line) => line !== '').join('\n'),
        temperature: 0.85,
        seed: toInt32Seed(seed),
        maxOutputTokens: 3072,
        responseSchema: CASE_SCHEMA,
      });
      return JSON.parse(response.text) as Case;
    },
  );
  return value;
}

async function writeSection(options: {
  brief: Case;
  move: string;
  soFar: string;
  index: number;
  isHook: boolean;
  seed: number;
  /** Words to ask this section for. */
  words: number;
  /** Real lines from the book, checked word for word; may be quoted whole. */
  quotations?: readonly string[];
  /** The war channel: its voice, and its idea of an opening. */
  war?: boolean;
}): Promise<{ prose: string; argued: string }> {
  const { brief, move, soFar, index, isHook, seed, words } = options;
  const war = options.war === true;
  const quotations = options.quotations ?? [];

  const { value } = await cache.json<{ prose: string; argued: string }>(
    'essay-section',
    /**
     * The length is part of the key.
     *
     * Without it, asking for the same book at three minutes and at twenty-five
     * returns the same sections -- the shorter request silently served the
     * longer one's prose out of the cache, and the only symptom is a video
     * that is the wrong length for no visible reason.
     */
    {
      title: brief.title,
      move,
      index,
      seed,
      words,
      model: MODELS.llm.script,
      v: 2,
      // Only when there are some, so every essay cached before this existed
      // is still found.
      ...(quotations.length === 0 ? {} : { quotations }),
      ...(war ? { voice: 'war-1' } : {}),
    },
    async () => {
      const response = await generate({
        model: MODELS.llm.script,
        systemInstruction: war ? VOICE_WAR : VOICE,
        prompt: [
          war
            ? `Subject: ${brief.book}${brief.author === '' ? '' : `, featuring ${brief.author}`}${brief.year === '' ? '' : ` (${brief.year})`}`
            : `Book: ${brief.book} by ${brief.author}${brief.year === '' ? '' : ` (${brief.year})`}`,
          war ? `The take: ${brief.thesis}` : `The position being argued: ${brief.thesis}`,
          war ? `The famous version: ${brief.commonReading}` : `The reading being argued against: ${brief.commonReading}`,
          `Anchors available: ${brief.evidence.join('; ')}`,
          ...(quotations.length === 0
            ? []
            : [
                '',
                'Lines from the book, checked word for word against its text. The book is in the',
                'public domain, so any one of these may be quoted whole. If this section quotes the',
                'book, quote only from this list, exactly as written, and at most one line:',
                ...quotations.map((line) => `  - "${line}"`),
                'Quoting none of them is fine; never paraphrase one and present it as a quotation.',
              ]),
          '',
          isHook
            ? [
                `Write the opening ${Math.max(
                  20,
                  Math.round((words * DELIVERY * 60) / WORDS_PER_MINUTE),
                )} seconds.`,
                '',
                `Open on: ${brief.hook}`,
                '',
                ...(war
                  ? [
                      'The cold open. The most absurd true detail inside the first two',
                      'sentences, then the setup in a line or two, then a joke. Do not say',
                      'what the video will cover; make them need the next sentence.',
                    ]
                  : [
                'This is the only part written hot. Land the specific claim inside',
                'the first three sentences — not a promise that something',
                'interesting is coming, the thing itself. Assume the viewer has',
                'read the book and is not owed a recap. Do not say what the video',
                'will cover.',
                    ]),
                '',
                `About ${words} words.`,
              ].join('\n')
            : [
                soFar === ''
                  ? ''
                  : `Argued so far: ${soFar}`,
                '',
                `This section: ${move}`,
                '',
                ...(war
                  ? [
                      'Keep the pace. Every sentence moves the story on with a real fact;',
                      'a joke or a wry aside every few sentences, a callback where one',
                      'fits. Carry on from the last section rather than restating it.',
                    ]
                  : [
                'The opening is done and the register drops: steady and',
                'unhurried now, still argued. Carry the thread from the previous',
                'section rather than restating it. Do not re-introduce the book',
                'or the thesis.',
                    ]),
                '',
                `About ${words} words of continuous prose.`,
              ].filter((line) => line !== '').join('\n'),
          '',
          'Also return `argued`: one sentence recording what this section',
          'established, so the next one can build on it without repeating it.',
        ].join('\n'),
        temperature: isHook ? 0.9 : 0.82,
        // Its own seed per section, or they come back as variations of one another.
        seed: toInt32Seed(seed + index * 7919),
        maxOutputTokens: 4096,
        responseSchema: SECTION_SCHEMA,
      });
      return JSON.parse(response.text) as { prose: string; argued: string };
    },
  );
  return value;
}

export async function generateEssay(options: {
  /** The book, as somebody would say it: title, or title and author. */
  book: string;
  vertical: Vertical;
  /** Optional steer: the reading you want argued, if you have one in mind. */
  angle?: string;
  seed: number;
  minutes: number;
  force: boolean;
  onProgress?: (done: number, total: number) => void;
  /** Give the writer real lines from the book when it is on Project Gutenberg. */
  realSources?: boolean;
}): Promise<Essay> {
  cache.setForce(options.force);

  const brief = await buildCase({
    book: options.book,
    vertical: options.vertical,
    angle: options.angle ?? '',
    minutes: options.minutes,
    seed: options.seed,
  });

  const target = options.minutes * WORDS_PER_MINUTE;
  const share = budget(options.minutes, brief.moves.length);
  log.info(`essay: "${brief.title}"`);
  log.info(`essay: arguing — ${brief.thesis}`);
  log.info(
    `essay: ${brief.moves.length} sections, ${target} words wanted ` +
      `(hook ~${share.hook}, each section ~${share.section})`,
  );

  /**
   * Real lines to quote, when the book is out of copyright. Without them the
   * writer quotes from memory, and memory produces lines that sound exactly
   * like the author and are not in the book.
   */
  let quotations: string[] = [];
  // A war is not a book on Project Gutenberg.
  if (options.realSources !== false && options.vertical !== 'war') {
    const source = await loadSource(brief.book, brief.author);
    if (source !== null) {
      quotations = await chooseQuotations({
        book: source,
        thesis: brief.thesis,
        evidence: brief.evidence,
        count: 8,
        seed: options.seed,
      }).catch((error: unknown) => {
        log.warn(`essay: could not choose quotations (${(error as Error).message})`);
        return [];
      });
    }
  }

  const sections: string[] = [];
  const history: string[] = [];
  let words = 0;

  const total = brief.moves.length + 1;
  for (let index = 0; index < total; index++) {
    const isHook = index === 0;
    const move = isHook ? brief.hook : (brief.moves[index - 1] ?? brief.thesis);

    const section = await writeSection({
      brief,
      move,
      // Only the recent past. The whole history crowds out the writing, and an
      // argument's working memory is local -- what matters is what the last
      // few sections established, not everything ever said.
      soFar: history.slice(-4).join(' '),
      index,
      isHook,
      seed: options.seed,
      words: isHook ? share.hook : share.section,
      quotations,
      war: options.vertical === 'war',
    });

    /**
     * The war channel's chapters, written in as `# headings`: the writer named
     * them when it planned the video, and the chapter stage reads headings off
     * the script whatever the chapter setting is. Only past five minutes -- a
     * short video with four chapter cards is mostly cards.
     */
    const heading =
      options.vertical === 'war' && !isHook && options.minutes >= 5
        ? (brief.chapterTitles?.[index - 1] ?? '').trim().replace(/[#:]/g, '')
        : '';
    sections.push(heading === '' ? section.prose.trim() : `# ${heading}
${section.prose.trim()}`);
    history.push(section.argued.trim());
    words += section.prose.split(/\s+/).filter(Boolean).length;
    options.onProgress?.(index + 1, total);
    log.info(`essay: ${index + 1}/${total} — ${words}/${target} words`);
  }

  return {
    title: brief.title,
    brief,
    sections,
    wordCount: words,
    ...(quotations.length === 0 ? {} : { quotations }),
  };
}

export const ESSAY_WORDS_PER_MINUTE = WORDS_PER_MINUTE;
