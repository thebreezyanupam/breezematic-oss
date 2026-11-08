import {
  HIGH_CONTRAST_TEMPLATES,
  LAYOUT,
  PLAN,
  PROCEDURAL_CLIPS,
  REVERSAL_MARKERS,
  SFX_GAIN_DB,
  SFX_LEAD_MS,
  TREATMENT,
  env,
} from '../config.js';
import { pickIllustration } from '../icons.js';
import { isLanguage } from '../languages.js';
import { log } from '../log.js';
import { expandTokens } from '../pronounce.js';
import { rangeFloat, rangeInt, rngFor, type Rng } from '../rng.js';
import {
  MOTION_KINDS,
  SCHEMA_VERSION,
  TEMPLATE_NAMES,
  parseBeatSheet,
  type BeatSheet,
  type BeatImage,
  type EffectName,
  type ImageryMode,
  type ImageSource,
  type SubtitleMode,
  type ArtStyle,
  type Line,
  type StyleName,
  type MotionKind,
  type ScriptDraft,
  type Sfx,
  type SfxCue,
  type Substitution,
  type TemplateName,
  type Word,
  type RenderMode,
  type BoardContent,
  type BoardImagery,
  type BoardTheme,
} from '../schema.js';

export type PlanInput = {
  topic: string;
  slug: string;
  seed: number;
  /** What it was written and read in. Defaults to English. */
  language?: string;
  draft: ScriptDraft;
  script: {
    hook: string;
    body: string;
    fullText: string;
    spokenText: string;
    pronunciation: Substitution[];
  };
  words: Word[];
  voice: { audioPath: string; provider: string; voiceId: string; character: string };
  durationMs: number;
  effect: EffectName;
  music: {
    trackPath: string;
    startOffsetMs: number;
    levelLufs: number;
    fadeInMs: number;
    fadeOutMs: number;
  };
  imagery: ImageryMode;
  imageSource: ImageSource;
  style: StyleName;
  subtitles: SubtitleMode;
  artStyle: ArtStyle;
  /** Storybook only: lay the effect field over the panels. */
  panelTexture: boolean;
  /** Which cues are audible. The sheet still records the rest. */
  sfxCues: readonly SfxCue[];
  series: string | null;
  captionScale: number;
  mode: RenderMode;
  boardTexture: boolean;
  boardTheme: BoardTheme;
  boardContent: BoardContent;
  boardImagery: BoardImagery;
  images: readonly (BeatImage | null)[];
  /** How long a beat may run. The shorts' 1.5-3s unless a mode needs longer. */
  beatMs?: { min: number; max: number };
  /** Where cuts go: on the tempo grid (the default), or between sentences. */
  cut?: 'grid' | 'sentence';
};

export type PlanDecision = {
  beatId: string;
  reason: string;
};

export type PlanResult = {
  sheet: BeatSheet;
  decisions: PlanDecision[];
  snapped: number;
  snapAttempts: number;
};

type TimedToken = { text: string; startMs: number; endMs: number };

type Segment = {
  tokens: TimedToken[];
  templateHint: TemplateName | null;
  emphasisHint: string | null;
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'we', 'our', 'you', 'your', 'they', 'their', 'them', 'as', 'by', 'into', 'than', 'then',
  'so', 'do', 'does', 'did', 'has', 'have', 'had', 'not', 'no', 'yes', 'actually', 'turns',
  'least', 'most', 'more', 'less', 'about', 'such', 'very', 'just', 'also', 'out', 'up',
]);

const SUPERLATIVE = /(?:est|only|never|always|every|first|worst|best)$|^(?:only|never|always|every)$/i;

const HIGH_CONTRAST = new Set<TemplateName>(HIGH_CONTRAST_TEMPLATES);

export function timeDisplayTokens(fullText: string, words: readonly Word[]): TimedToken[] {
  const expansions = expandTokens(fullText);
  const timed: TimedToken[] = [];
  let cursor = 0;

  for (const expansion of expansions) {
    // A token that is spoken as nothing — an emoji — still has to appear on
    // screen, but it must not eat an aligned word, or every timing after it
    // slides by one. It borrows the moment of the word that follows.
    if (expansion.spoken.length === 0) {
      const next = words[cursor];
      const previous = timed[timed.length - 1];
      const startMs = next?.startMs ?? previous?.endMs ?? 0;
      timed.push({
        text: expansion.display,
        startMs,
        endMs: startMs + LAYOUT.minWordMs,
      });
      continue;
    }

    const count = expansion.spoken.length;
    const slice = words.slice(cursor, cursor + count);
    const first = slice[0];
    const last = slice[slice.length - 1];

    if (first === undefined || last === undefined) {
      const previous = timed[timed.length - 1];
      const startMs = previous === undefined ? 0 : previous.endMs;
      timed.push({ text: expansion.display, startMs, endMs: startMs + LAYOUT.minWordMs });
    } else {
      timed.push({
        text: expansion.display,
        startMs: first.startMs,
        endMs: Math.max(last.endMs, first.startMs + LAYOUT.minWordMs),
      });
    }
    cursor += count;
  }

  if (cursor !== words.length) {
    log.warn(
      `token mapping consumed ${cursor} spoken words but alignment produced ${words.length}; timings may drift`,
    );
  }
  return timed;
}

function toSegments(draft: ScriptDraft, timed: readonly TimedToken[]): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const beat of draft.beats) {
    const count = beat.text.split(/\s+/).filter((word) => word.length > 0).length;
    const tokens = timed.slice(cursor, cursor + count);
    cursor += count;
    if (tokens.length === 0) continue;
    segments.push({
      tokens: [...tokens],
      templateHint: beat.template_hint,
      emphasisHint: beat.emphasis_word,
    });
  }

  if (cursor < timed.length) {
    const tail = segments[segments.length - 1];
    if (tail !== undefined) tail.tokens.push(...timed.slice(cursor));
  }
  return segments;
}

function durationOf(segment: Segment): number {
  const first = segment.tokens[0];
  const last = segment.tokens[segment.tokens.length - 1];
  if (first === undefined || last === undefined) return 0;
  return last.endMs - first.startMs;
}

function splitPoint(segment: Segment): number {
  const tokens = segment.tokens;
  const middle = tokens.length / 2;
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 1; i < tokens.length - 1; i++) {
    const previous = tokens[i - 1];
    if (previous === undefined) continue;
    const isClause = /[,;:]$/.test(previous.text);
    const distance = Math.abs(i - middle);
    const score = distance - (isClause ? tokens.length : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function rebalance(
  segments: Segment[],
  range: { min: number; max: number } = { min: PLAN.beatMsMin, max: PLAN.beatMsMax },
): Segment[] {
  const split: Segment[] = [];
  for (const segment of segments) {
    const queue = [segment];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      if (durationOf(current) <= range.max || current.tokens.length < 4) {
        split.push(current);
        continue;
      }
      const at = splitPoint(current);
      if (at <= 0) {
        split.push(current);
        continue;
      }
      queue.unshift(
        { ...current, tokens: current.tokens.slice(0, at) },
        { ...current, templateHint: null, tokens: current.tokens.slice(at) },
      );
    }
  }

  const merged: Segment[] = [];
  for (const segment of split) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      durationOf(segment) < range.min &&
      durationOf(previous) + durationOf(segment) <= range.max
    ) {
      previous.tokens.push(...segment.tokens);
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

type Window = Segment & { startMs: number; endMs: number };

function assignToWindows(
  source: readonly Segment[],
  timed: readonly TimedToken[],
  boundaries: readonly number[],
): Window[] {
  const hintFor = new Map<TimedToken, Segment>();
  for (const segment of source) {
    for (const token of segment.tokens) hintFor.set(token, segment);
  }

  const windows: Window[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i] ?? 0;
    const end = boundaries[i + 1] ?? start;
    const tokens = timed.filter((token) => token.startMs >= start && token.startMs < end);

    if (tokens.length === 0) {
      const previous = windows[windows.length - 1];
      if (previous !== undefined) {
        previous.endMs = end;
        continue;
      }
    }

    const votes = new Map<TemplateName, number>();
    let emphasisHint: string | null = null;
    for (const token of tokens) {
      const owner = hintFor.get(token);
      if (owner === undefined) continue;
      if (owner.templateHint !== null) {
        votes.set(owner.templateHint, (votes.get(owner.templateHint) ?? 0) + 1);
      }
      if (emphasisHint === null && owner.emphasisHint !== null) {
        const hint = owner.emphasisHint.toLowerCase();
        if (tokens.some((entry) => entry.text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}']/gu, '') === hint)) {
          emphasisHint = owner.emphasisHint;
        }
      }
    }

    let templateHint: TemplateName | null = null;
    let bestVotes = 0;
    for (const [name, count] of votes) {
      if (count > bestVotes) {
        bestVotes = count;
        templateHint = name;
      }
    }

    windows.push({ tokens: [...tokens], templateHint, emphasisHint, startMs: start, endMs: end });
  }

  return windows;
}

function buildGrid(bpm: number, durationMs: number): number[] {
  const step = 60_000 / bpm;
  const grid: number[] = [];
  for (let t = 0; t <= durationMs; t += step) grid.push(Math.round(t));
  return grid;
}

function clauseTimes(segments: readonly Segment[]): number[] {
  const times: number[] = [];
  for (const segment of segments) {
    for (const [index, token] of segment.tokens.entries()) {
      const isLast = index === segment.tokens.length - 1;
      if (isLast || /[,;:.!?]$/.test(token.text)) times.push(token.endMs);
    }
  }
  return times;
}

/**
 * Cuts between sentences rather than on the tempo grid.
 *
 * The grid is right for a short, where the cut is the rhythm and a line can be
 * split across two cards without anyone minding. In an explainer each beat
 * carries a graphic about what it says, and a sentence split across a cut
 * puts the number in one beat and the counter in the next. So every cut goes
 * in the silence between two segments -- the midpoint of the gap, which is
 * where an editor would put it -- and the music is left to fit around them.
 */
export function sentenceCuts(segments: readonly Segment[], durationMs: number): number[] {
  const cuts = [0];
  for (let i = 1; i < segments.length; i++) {
    const before = segments[i - 1]?.tokens.at(-1);
    const after = segments[i]?.tokens[0];
    if (before === undefined || after === undefined) continue;
    const cut = Math.round((before.endMs + Math.max(before.endMs, after.startMs)) / 2);
    if (cut > (cuts[cuts.length - 1] ?? 0) && cut < durationMs) cuts.push(cut);
  }
  cuts.push(durationMs);
  return cuts;
}

function nearestDistance(times: readonly number[], at: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const time of times) {
    const distance = Math.abs(time - at);
    if (distance < best) best = distance;
  }
  return best;
}

export function chooseCuts(
  grid: readonly number[],
  durationMs: number,
  clauses: readonly number[],
  range: { min: number; max: number } = { min: PLAN.beatMsMin, max: PLAN.beatMsMax },
): number[] {
  const cuts = [0];

  for (;;) {
    const last = cuts[cuts.length - 1] ?? 0;
    if (durationMs - last <= range.max) break;

    const window = grid.filter(
      (tick) =>
        tick - last >= range.min &&
        tick - last <= range.max &&
        durationMs - tick >= range.min,
    );
    if (window.length === 0) break;

    const midpoint = last + (range.min + range.max) / 2;
    let best = window[0] ?? last;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const tick of window) {
      const toClause = nearestDistance(clauses, tick);
      const score = toClause + Math.abs(tick - midpoint) / 20;
      if (score < bestScore) {
        bestScore = score;
        best = tick;
      }
    }
    cuts.push(best);
  }

  cuts.push(durationMs);
  return cuts;
}

function pickTemplate(
  index: number,
  segment: Segment,
  previous: TemplateName | null,
  recent: readonly TemplateName[],
  rng: Rng,
): { template: TemplateName; reason: string } {
  const text = segment.tokens.map((token) => token.text).join(' ');

  if (index === 0) {
    const template = /\d/.test(text) ? 'stat-slam' : 'word-punch';
    return { template, reason: `hook: ${/\d/.test(text) ? 'has a number' : 'no number'}` };
  }

  const needsInterrupt =
    recent.length >= PLAN.patternInterruptEveryBeats - 1 &&
    !recent.some((name) => HIGH_CONTRAST.has(name));

  let allowed = TEMPLATE_NAMES.filter((name) => name !== previous);
  if (needsInterrupt) {
    const contrast = allowed.filter((name) => HIGH_CONTRAST.has(name));
    if (contrast.length > 0) {
      const template = contrast[rangeInt(rng, 0, contrast.length - 1)];
      if (template !== undefined) {
        return { template, reason: `pattern interrupt after ${recent.length} flat beats` };
      }
    }
  }

  if (/\d/.test(text)) {
    const template: TemplateName = previous === 'stat-slam' ? 'word-punch' : 'stat-slam';
    return { template, reason: 'contains a number' };
  }

  if (REVERSAL_MARKERS.some((marker) => text.toLowerCase().startsWith(marker))) {
    const template: TemplateName = previous === 'reveal-mask' ? 'word-punch' : 'reveal-mask';
    return { template, reason: 'reversal beat' };
  }

  if (segment.templateHint !== null && allowed.includes(segment.templateHint)) {
    return { template: segment.templateHint, reason: 'LLM hint' };
  }

  const overused = new Set(recent.slice(-2));
  const fresh = allowed.filter((name) => !overused.has(name));
  if (fresh.length > 0) allowed = fresh;

  const template = allowed[rangeInt(rng, 0, allowed.length - 1)] ?? 'line-stack';
  return { template, reason: 'seeded choice' };
}

function pickMotion(previous: MotionKind | null, rng: Rng): MotionKind {
  const allowed = MOTION_KINDS.filter((kind) => kind !== previous);
  return allowed[rangeInt(rng, 0, allowed.length - 1)] ?? 'push';
}

function scoreWord(token: string, hint: string | null): number {
  // Unicode-aware for the same reason script.ts is: an ASCII class turns
  // every Devanagari token into an empty string, and a scorer comparing empty
  // strings finds every word equally emphatic, which is the same as none.
  const bare = token.toLowerCase().replace(/[^\p{L}\p{M}\p{N}'%$.-]/gu, '');
  if (bare.length === 0) return -100;

  let score = 0;
  if (hint !== null && bare === hint.toLowerCase().replace(/[^\p{L}\p{M}\p{N}'%$.-]/gu, '')) score += 6;
  if (/\d/.test(bare)) score += 5;
  if (SUPERLATIVE.test(bare)) score += 3;
  if (STOPWORDS.has(bare)) score -= 8;
  if (bare.length >= 7) score += 1;
  return score;
}

function pickEmphasis(words: readonly string[], hint: string | null): number | null {
  let best = -1;
  let bestScore = 0;
  for (const [index, word] of words.entries()) {
    const score = scoreWord(word, hint);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best === -1 ? null : best;
}

export function layoutLines(
  words: readonly string[],
  template: TemplateName,
  emphasisIndex: number | null,
): Line[] {
  const maxLines = Math.min(LAYOUT.linesPerTemplate[template] ?? 3, Math.max(1, words.length));
  const isolate =
    emphasisIndex !== null &&
    LAYOUT.isolateEmphasisFor.includes(template) &&
    words.length > 2;

  const groups: string[][] = [];

  if (isolate && emphasisIndex !== null) {
    const before = words.slice(0, emphasisIndex);
    const after = words.slice(emphasisIndex + 1);
    if (before.length > 0) groups.push(before);
    groups.push([words[emphasisIndex] ?? '']);
    if (after.length > 0) groups.push(after);
  } else {
    const perLine = Math.ceil(words.length / maxLines);
    for (let i = 0; i < words.length; i += perLine) {
      groups.push(words.slice(i, i + perLine));
    }
  }

  while (groups.length < LAYOUT.maxLines) {
    let widest = -1;
    let widestChars: number = LAYOUT.maxCharsPerLine;
    for (const [index, group] of groups.entries()) {
      const chars = group.join(' ').length;
      if (group.length > 1 && chars > widestChars) {
        widestChars = chars;
        widest = index;
      }
    }
    if (widest === -1) break;
    const group = groups[widest];
    if (group === undefined) break;
    const at = Math.ceil(group.length / 2);
    groups.splice(widest, 1, group.slice(0, at), group.slice(at));
  }

  while (groups.length > LAYOUT.maxLines) {
    const shortest = groups.reduce(
      (best, group, index) => (group.length < (groups[best]?.length ?? 99) ? index : best),
      0,
    );
    const target = shortest === 0 ? 1 : shortest - 1;
    const donor = groups[shortest];
    const receiver = groups[target];
    if (donor === undefined || receiver === undefined) break;
    if (target < shortest) receiver.push(...donor);
    else receiver.unshift(...donor);
    groups.splice(shortest, 1);
  }

  let cursor = 0;
  return groups.map((group) => {
    const containsEmphasis =
      emphasisIndex !== null && emphasisIndex >= cursor && emphasisIndex < cursor + group.length;
    cursor += group.length;
    const scale = containsEmphasis
      ? group.length === 1 && isolate
        ? LAYOUT.emphasisScaleIsolated
        : LAYOUT.emphasisScaleInline
      : 1;
    return { text: group.join(' '), emphasis: containsEmphasis, scale };
  });
}

export function buildBeatSheet(input: PlanInput): PlanResult {
  const timed = timeDisplayTokens(input.script.fullText, input.words);
  const source = rebalance(toSegments(input.draft, timed), input.beatMs);
  const grid = buildGrid(env.MUSIC_BPM, input.durationMs);
  const decisions: PlanDecision[] = [];

  const boundaries =
    input.cut === 'sentence'
      ? sentenceCuts(source, input.durationMs)
      : chooseCuts(grid, input.durationMs, clauseTimes(source), input.beatMs);
  const gridTicks = new Set(grid);
  const snapAttempts = boundaries.length - 2;
  const snapped = boundaries.slice(1, -1).filter((cut) => gridTicks.has(cut)).length;

  const segments = assignToWindows(source, timed, boundaries);

  const beats: BeatSheet['beats'] = [];
  const sfx: Sfx[] = [];
  const recent: TemplateName[] = [];
  /** No video should draw the same thing twice. */
  const drawn = new Set<string>();
  let previousTemplate: TemplateName | null = null;
  let previousMotion: MotionKind | null = null;
  let previousClip: string | null = null;

  for (const [index, segment] of segments.entries()) {
    const id = `b${String(index + 1).padStart(2, '0')}`;
    const rng = rngFor(input.seed, input.slug, id);

    const { startMs, endMs } = segment;

    const words = segment.tokens.map((token) => token.text);
    const emphasisWordIndex = pickEmphasis(words, segment.emphasisHint);

    const { template, reason } = pickTemplate(index, segment, previousTemplate, recent, rng);
    const motion = pickMotion(previousMotion, rng);
    const lines = layoutLines(words, template, emphasisWordIndex);

    const clips = PROCEDURAL_CLIPS.filter((clip) => clip.id !== previousClip);
    const clip = clips[rangeInt(rng, 0, clips.length - 1)] ?? PROCEDURAL_CLIPS[0];

    beats.push({
      id,
      startMs,
      endMs,
      template,
      lines,
      emphasisWordIndex,
      background: {
        clipId: clip.id,
        inPointMs: rangeInt(rng, 0, 6_000),
        blurPx: Math.round(
          rangeFloat(rng, TREATMENT.blurPxMin, TREATMENT.blurPxMax) *
            (TREATMENT.imageBlurScale[input.imagery] ?? 1) *
            (TREATMENT.effectBlurScale[input.effect] ?? 1),
        ),
        // The footage treatment is not applied here. Planning runs before the
        // pictures are fetched, so this cannot know which beats ended up with a
        // clip — and under "mix" the answer differs from beat to beat. The
        // pipeline scales these when it attaches the images.
        scrimOpacity:
          Math.round(
            rangeFloat(rng, TREATMENT.scrimOpacityMin, TREATMENT.scrimOpacityMax) * 100,
          ) / 100,
        image: input.imagery === 'off' ? null : (input.images[beats.length] ?? null),
      },
      motion: { kind: motion, amount: Math.round(rangeFloat(rng, 0.16, 0.32) * 100) / 100 },
      // Chosen from the line's own words and written into the sheet, so the
      // renderer needs no icon library and the same seed draws the same thing.
      // Picked for every mode: it costs nothing to carry and means switching a
      // sheet to whiteboard afterwards does not need a re-plan.
      // `file` is filled in later by the pipeline, where the image model runs.
      // Filled in by the pipeline when the mode wants one; standing otherwise.
      action: null,
      stage: null,
      // The explainer's layer, added by the pipeline once the beats exist.
      graphic: null,
      paint: null,
      captions: null,
      illustration: ((pick) => (pick === null ? null : { ...pick, file: null }))(
        pickIllustration(words.join(' '), drawn),
      ),
    });
    const drawing = beats[beats.length - 1]?.illustration;
    if (drawing !== null && drawing !== undefined) drawn.add(drawing.name);

    decisions.push({
      beatId: id,
      reason: `${template} (${reason}), motion ${motion}, emphasis ${
        emphasisWordIndex === null ? 'none' : (words[emphasisWordIndex] ?? '?')
      }`,
    });

    if (index > 0) {
      // Ahead of the cut, not on it: the sample rises to its peak on its last
      // frames, so it has to start early enough for the top of the rise and
      // the change of picture to be the same moment.
      sfx.push({
        cue: 'whoosh',
        atMs: Math.max(0, startMs - SFX_LEAD_MS.whoosh),
        gainDb: SFX_GAIN_DB.whoosh,
        variant: rangeInt(rng, 0, 3),
      });
    }

    if (emphasisWordIndex !== null) {
      const token = segment.tokens[emphasisWordIndex];
      if (token !== undefined) {
        sfx.push({
          cue: 'impact',
          atMs: Math.max(startMs, Math.min(token.startMs, endMs - 1)),
          gainDb: SFX_GAIN_DB.impact,
          variant: rangeInt(rng, 0, 3),
        });
      }
    }

    for (let line = 0; line < lines.length; line++) {
      sfx.push({
        cue: 'click',
        atMs: Math.min(startMs + line * 120, endMs - 1),
        gainDb: SFX_GAIN_DB.click,
        variant: line % 4,
      });
    }

    const lower = words.join(' ').toLowerCase();
    if (REVERSAL_MARKERS.some((marker) => lower.includes(marker)) && startMs - SFX_LEAD_MS.riser >= 0) {
      sfx.push({
        cue: 'riser',
        atMs: startMs - SFX_LEAD_MS.riser,
        gainDb: SFX_GAIN_DB.riser,
        variant: rangeInt(rng, 0, 3),
      });
    }

    previousTemplate = template;
    previousMotion = motion;
    previousClip = clip.id;
    recent.push(template);
    if (recent.length > PLAN.patternInterruptEveryBeats - 1) recent.shift();
  }

  sfx.sort((a, b) => a.atMs - b.atMs || a.cue.localeCompare(b.cue));

  const sheet = parseBeatSheet({
    version: SCHEMA_VERSION,
    meta: {
      topic: input.topic,
      slug: input.slug,
      seed: input.seed,
      // Recorded on the sheet rather than only in the run options, because the
      // renderer picks its typeface from here and a re-render months later has
      // nothing else to ask.
      language: isLanguage(input.language ?? 'en') ? (input.language ?? 'en') : 'en',
      durationMs: input.durationMs,
      fps: 30,
      effect: input.effect,
      imagery: input.imagery,
      imageSource: input.imageSource,
      style: input.style,
      subtitles: input.subtitles,
      artStyle: input.artStyle,
      panelTexture: input.panelTexture,
      sfxCues: input.sfxCues,
      series: input.series,
      captionScale: input.captionScale,
      mode: input.mode,
      boardTexture: input.boardTexture,
      boardTheme: input.boardTheme,
      boardContent: input.boardContent,
      boardImagery: input.boardImagery,
    },
    script: input.script,
    voice: input.voice,
    words: input.words,
    music: {
      trackPath: input.music.trackPath,
      bpm: env.MUSIC_BPM,
      beatGridMs: grid,
      startOffsetMs: input.music.startOffsetMs,
      levelLufs: input.music.levelLufs,
      fadeInMs: input.music.fadeInMs,
      fadeOutMs: input.music.fadeOutMs,
    },
    beats,
    sfx,
  });

  return { sheet, decisions, snapped, snapAttempts };
}
