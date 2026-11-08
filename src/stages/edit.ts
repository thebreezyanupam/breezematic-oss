import { log } from '../log.js';

/**
 * The edit plan: which stretch of narration is cut hot, warm or cold.
 *
 * The rule that makes this worth having as code rather than as a note in a
 * style guide is the one about contrast. A fast, loud, slamming edit held for
 * twenty-five minutes is not an intense video — it is a flat one, because
 * intensity is a difference and a constant has no differences in it. So HOT
 * only reads as HOT if something quiet came directly before it, and that is
 * expressible as two constraints:
 *
 *   - no two HOT stretches may be adjacent
 *   - every HOT stretch except the opening one must be preceded by a COLD
 *
 * Both are enforced here and checked afterwards, because a style rule that is
 * merely written down is a style rule that drifts by the fortieth video.
 *
 * Timings are proportional to word counts rather than measured off the audio.
 * That is deliberate for planning: the plan has to exist before the narration
 * does, so that the sections can be written knowing where the quiet is. Once
 * the read exists, `snapToWords` moves every boundary onto the nearest real
 * word so the cuts land on speech rather than near it.
 */

export type Register = 'hot' | 'warm' | 'cold';

export type Segment = {
  register: Register;
  startMs: number;
  endMs: number;
  /** Which section this belongs to; the hook is 0. */
  section: number;
  /** Why it is this register. Goes in the log and survives into review. */
  reason: string;
  /**
   * Set where the argument pivots. A flag rather than a search of `reason`,
   * which is what it was: merging two anchors concatenates their reasons, so a
   * hot stretch that happened to absorb the turn made every line in it invert
   * the ground. Human-readable text is for humans; logic reads this.
   */
  marksTurn?: boolean;
  /** Milliseconds between cuts inside this stretch. */
  cutMs: number;
};

/**
 * Cut rates, from the brief. A range rather than a number because a fixed
 * cadence is its own kind of template -- forty videos all cutting on exactly
 * 1.5 seconds is a fingerprint.
 */
const CUT_MS: Record<Register, readonly [number, number]> = {
  hot: [1_000, 2_000],
  warm: [4_000, 8_000],
  // COLD does not cut. The whole segment is one composition.
  cold: [15_000, 30_000],
};

/** The opening, held hot regardless of where the first section ends. */
/**
 * How long the video runs before the first punch, at most.
 *
 * The opening used to be hot by rule -- ninety seconds of it, capped to 8% on
 * short videos -- so every essay began with its claims shouting in the punch
 * treatment before a viewer knew what the video was about. A punch is only a
 * punch against something steady; the opening is where the steady thing gets
 * established. So the video opens in the narration's own voice, and the first
 * hit lands once there is something for it to land against.
 */
const FIRST_PUNCH_MS = 30_000;
/** The close, held hot regardless of where the last section begins. */
const OUTRO_MS = 60_000;
/** A hot burst at the top of a section. Long enough to land, short enough to leave. */
const OPENER_MS = 10_000;
/** The pivot. The one hot stretch in the middle that gets room. */
const TURN_MS = 25_000;
/** A held composition. Also the minimum gap that makes a following HOT land. */
const COLD_MS = 20_000;

/**
 * The most of a video hot is allowed to be before it stops being emphasis.
 *
 * Not a target -- the planner does not aim at this and a well-shaped essay
 * lands nearer forty per cent. It is the line past which the plan is reported
 * as wrong, because the failure it catches is silent: the video renders, every
 * frame is legible, and the whole thing is shouting.
 */
const MAX_HOT_SHARE = 0.6;

/** What the brief asks the mix to look like. */
const WARM_TARGET = 0.6;

export type EditPlan = {
  segments: Segment[];
  durationMs: number;
  /** Share of runtime per register, for checking against the brief. */
  mix: Record<Register, number>;
};

function cutFor(register: Register, seed: number, index: number): number {
  const [low, high] = CUT_MS[register];
  // Deterministic within a video, different between them, and different
  // between segments so one video does not cut on a metronome.
  const step = Math.abs(Math.round(seed / 7) + index * 31) % (high - low + 1);
  return low + step;
}

/**
 * Turns section word counts into a register timeline.
 *
 * `turnSection` is the index of the section where the argument pivots, which
 * the essay plan already knows; it gets the one mid-essay hot stretch that is
 * not merely a section opener.
 */
export function planEdit(options: {
  /** Words in each section, in order. Section 0 is the hook. */
  sectionWords: readonly number[];
  /** Total narration length. */
  durationMs: number;
  /** Which section carries the pivot. */
  turnSection: number;
  seed: number;
}): EditPlan {
  const { sectionWords, turnSection, seed } = options;
  /**
   * Integer milliseconds from here down.
   *
   * Every boundary is rounded on the way into a segment, so a fractional total
   * meant the last segment ended a fraction before the video did -- a plan
   * that was correct everywhere and still did not reach the end.
   */
  const durationMs = Math.round(options.durationMs);
  const totalWords = sectionWords.reduce((sum, n) => sum + n, 0) || 1;

  // Section boundaries, proportional to words.
  const bounds: { start: number; end: number }[] = [];
  let at = 0;
  for (const words of sectionWords) {
    const span = (words / totalWords) * durationMs;
    bounds.push({ start: at, end: at + span });
    at += span;
  }

  /**
   * Anchors first: the places the brief says must be hot, in time order.
   * Nothing is placed around them yet -- overlap is resolved afterwards,
   * because the outro and the last section's opener can easily collide on a
   * short essay and silently produce two adjacent hot stretches.
   */
  type Anchor = { start: number; end: number; section: number; reason: string; turn?: boolean };

  /**
   * The fixed openings and closings, capped against the runtime.
   *
   * Ninety seconds is six per cent of a twenty-five minute essay and half of a
   * three minute one. Uncapped, a short input merged every anchor into a
   * single hot stretch covering the whole video -- each individual decision
   * correct, the result a hundred per cent hot, which is the exact failure the
   * contrast rules exist to prevent. The format is written for twenty to
   * thirty minutes; this is what makes it degrade rather than inverting.
   */
  const firstPunchMs = Math.min(FIRST_PUNCH_MS, durationMs * 0.15);
  const outroMs = Math.min(OUTRO_MS, durationMs * 0.05);
  /**
   * The holds scale too, and last time they did not.
   *
   * Capping the hook alone was half a fix. A twenty-second hold is the gap two
   * hot stretches need in order to be two rather than one -- so on a
   * fifty-second video, where the anchors sit nine seconds apart, every one of
   * them merged and the plan came out a hundred per cent hot again. The shape
   * is a set of proportions; all of them have to scale or none of them do.
   */
  const coldMs = Math.min(COLD_MS, durationMs * 0.06);
  const openerMs = Math.min(OPENER_MS, durationMs * 0.03);
  const turnMs = Math.min(TURN_MS, durationMs * 0.08);

  const anchors: Anchor[] = [];

  /**
   * A section only opens hot if it is long enough to be a section.
   *
   * The opener assumes sections are minutes long, which they are when the
   * writer produced them. A supplied script is split on blank lines, so its
   * "sections" can be single sentences -- fifty of them, about two seconds
   * each. Every opener then covered its entire section, every opener touched
   * the next, and the merge below folded the whole timeline into one hot
   * stretch: a hundred per cent hot, one segment, every line of the video set
   * as a centred outlined title card.
   *
   * Nothing was wrong with the merge. It is correct that two hot stretches
   * with no room for a hold between them are one hot stretch. The mistake was
   * asking for an opener in a section that could never hold one, so the
   * requirement is stated here instead: a section earns an opener only if it
   * can carry the opener AND the hold the next hot needs afterwards.
   */
  const openable = openerMs + coldMs;
  let refused = 0;
  for (let i = 1; i < bounds.length; i++) {
    const b = bounds[i]!;
    if (b.end - b.start < openable) {
      refused++;
      continue;
    }
    anchors.push({
      start: b.start,
      end: Math.min(b.start + openerMs, b.end),
      section: i,
      reason: `section ${i} opens`,
    });
  }
  if (refused > 0) {
    log.debug(
      `edit: ${refused} section(s) too short to open hot; they stay inside the argument`,
    );
  }

  const turn = bounds[turnSection];
  if (turn !== undefined) {
    // A third of the way in, so the pivot lands inside the argument rather
    // than on top of the section's own opening hit.
    const start = turn.start + (turn.end - turn.start) / 3;
    anchors.push({
      start,
      end: Math.min(start + turnMs, turn.end),
      section: turnSection,
      reason: 'the argument turns',
      turn: true,
    });
  }

  anchors.push({
    start: Math.max(0, durationMs - outroMs),
    end: durationMs,
    section: bounds.length - 1,
    reason: 'the last minute',
  });

  anchors.sort((a, b) => a.start - b.start);
  // Nothing hits before the opening has had time to be an opening.
  for (let i = anchors.length - 1; i >= 0; i--) {
    if ((anchors[i]?.start ?? 0) < firstPunchMs) anchors.splice(i, 1);
  }

  /**
   * Merge anchors that touch.
   *
   * Two hot stretches with nothing between them are one hot stretch, and
   * pretending otherwise is how the no-adjacent rule gets broken while every
   * individual decision looks correct. On a short essay the outro swallows the
   * final section's opener; on any essay the turn can meet the opener of the
   * section it lives in.
   */
  const hot: Anchor[] = [];
  for (const anchor of anchors) {
    const last = hot[hot.length - 1];
    // A gap smaller than a COLD cannot hold the COLD the next HOT requires, so
    // the two are the same stretch whatever the arithmetic says.
    if (last !== undefined && anchor.start - last.end < coldMs) {
      last.end = Math.max(last.end, anchor.end);
      if (!last.reason.includes(anchor.reason)) last.reason += `, ${anchor.reason}`;
      last.turn = last.turn === true || anchor.turn === true;
      continue;
    }
    hot.push({ ...anchor });
  }

  /**
   * A COLD immediately before every HOT but the first, carved out of the WARM
   * that would otherwise run into it. This is the rule the whole file exists
   * for: the quiet is what makes the next thing loud.
   */
  const segments: Segment[] = [];
  let cursor = 0;
  let index = 0;

  const sectionAt = (ms: number): number => {
    const found = bounds.findIndex((b) => ms >= b.start && ms < b.end);
    return found === -1 ? Math.max(0, bounds.length - 1) : found;
  };

  const push = (
    register: Register,
    start: number,
    end: number,
    section: number,
    reason: string,
    marksTurn = false,
  ): void => {
    /**
     * A stretch too short to see is given to its neighbour rather than
     * dropped. Dropping it left a hole in the timeline -- the plan still
     * looked right segment by segment, and every seam after it was a gap.
     */
    if (end - start < 250) {
      const previous = segments[segments.length - 1];
      if (previous !== undefined) previous.endMs = Math.round(end);
      return;
    }
    segments.push({
      register,
      startMs: Math.round(start),
      endMs: Math.round(end),
      section,
      reason,
      ...(marksTurn ? { marksTurn: true } : {}),
      cutMs: cutFor(register, seed, index++),
    });
  };

  for (const stretch of hot) {
    /**
     * Every hot now has something in front of it, the first one included.
     *
     * This was `n > 0`, written when the first hot stretch always began at
     * zero. With the opening no longer hot, the first stretch starts thirty
     * seconds in, and that guard would have left those thirty seconds out of
     * the plan entirely -- a gap at the front of the timeline.
     */
    if (stretch.start > cursor) {
      const coldStart = Math.max(cursor, stretch.start - coldMs);
      if (coldStart > cursor) {
        push('warm', cursor, coldStart, sectionAt(cursor), 'argument');
      }
      push('cold', coldStart, stretch.start, sectionAt(coldStart), 'held, so the next hit lands');
    }
    push('hot', stretch.start, stretch.end, stretch.section, stretch.reason, stretch.turn === true);
    cursor = stretch.end;
  }
  if (cursor < durationMs) push('warm', cursor, durationMs, sectionAt(cursor), 'argument');

  /**
   * Warm is still too much of the runtime at this point, because so far COLD
   * only appears where a HOT needed setting up. The brief wants around sixty
   * per cent warm, with the remainder carrying evidence and the moments meant
   * to be sat with -- so the longest warm stretches are split until the mix is
   * right. Longest first, because a thirty-second warm run does not want
   * breaking and a four-minute one badly does.
   */
  balance(segments, durationMs, seed);

  const mix = mixOf(segments, durationMs);
  log.info(
    `edit: ${segments.length} segments — ` +
      `hot ${(mix.hot * 100).toFixed(0)}%, warm ${(mix.warm * 100).toFixed(0)}%, ` +
      `cold ${(mix.cold * 100).toFixed(0)}%`,
  );

  return { segments, durationMs, mix };
}

function mixOf(segments: readonly Segment[], durationMs: number): Record<Register, number> {
  const total: Record<Register, number> = { hot: 0, warm: 0, cold: 0 };
  for (const s of segments) total[s.register] += s.endMs - s.startMs;
  return {
    hot: total.hot / durationMs,
    warm: total.warm / durationMs,
    cold: total.cold / durationMs,
  };
}

/** Splits the longest warm runs with cold holds until warm is near its target. */
function balance(segments: Segment[], durationMs: number, seed: number): void {
  const coldMs = Math.min(COLD_MS, durationMs * 0.06);
  for (let guard = 0; guard < 64; guard++) {
    const mix = mixOf(segments, durationMs);
    if (mix.warm <= WARM_TARGET) return;

    let longest = -1;
    let longestLength = 0;
    for (const [i, s] of segments.entries()) {
      const length = s.endMs - s.startMs;
      // Only worth splitting if both halves survive as real stretches.
      if (s.register === 'warm' && length > coldMs * 3 && length > longestLength) {
        longest = i;
        longestLength = length;
      }
    }
    if (longest === -1) return;

    const s = segments[longest]!;
    // Placed off-centre and seeded, so the quiet does not land on a metronome
    // at the midpoint of every long stretch in every video.
    const bias = 0.4 + ((Math.abs(seed) + longest * 37) % 21) / 100;
    /**
     * Rounded here, once, and then only the rounded values are used.
     *
     * They were rounded at the point of assignment instead, which meant the
     * hold ended at a rounded millisecond and the stretch after it began at an
     * unrounded one. Every split produced a sub-millisecond seam -- invisible
     * in the numbers, and a gap by the only definition that matters.
     */
    const holdStart = Math.round(s.startMs + (s.endMs - s.startMs) * bias);
    const holdEnd = Math.round(Math.min(holdStart + coldMs, s.endMs));

    const tail: Segment = { ...s, startMs: holdEnd, cutMs: s.cutMs };
    const hold: Segment = {
      register: 'cold',
      startMs: holdStart,
      endMs: holdEnd,
      section: s.section,
      reason: 'evidence, sat with',
      cutMs: coldMs,
    };
    s.endMs = holdStart;
    segments.splice(longest + 1, 0, hold, tail);
  }
}

/**
 * Every way the plan could be wrong, checked rather than assumed.
 *
 * Returns the problems rather than throwing: a plan that is 58% warm instead
 * of 60% is not a failure, and a caller deciding what to do about it needs to
 * see all of them at once rather than the first.
 */
export function checkPlan(plan: EditPlan): string[] {
  const problems: string[] = [];
  const { segments, durationMs } = plan;

  for (const [i, s] of segments.entries()) {
    if (s.endMs <= s.startMs) problems.push(`segment ${i} has no length`);
    const previous = segments[i - 1];
    if (previous === undefined) continue;
    if (previous.endMs !== s.startMs) problems.push(`gap or overlap before segment ${i}`);
    if (previous.register === 'hot' && s.register === 'hot') {
      problems.push(`segments ${i - 1} and ${i} are both hot`);
    }
    if (s.register === 'hot' && previous.register !== 'cold') {
      problems.push(`hot segment ${i} is not preceded by cold (${previous.register})`);
    }
  }

  if (segments[0]?.startMs !== 0) problems.push('the plan does not start at zero');
  const last = segments[segments.length - 1];
  if (last !== undefined && last.endMs !== durationMs) problems.push('the plan does not reach the end');
  // The inverse of the old rule: the opening is where the steady voice is set up.
  if (segments[0] !== undefined && segments[0].register === 'hot') {
    problems.push('the video opens on a punch, before there is anything for it to punch against');
  }

  /**
   * The mix, which is the only thing this file is actually for.
   *
   * Every check above is structural -- no gaps, no adjacent hot, hot preceded
   * by cold -- and a single hot segment covering the entire video satisfies
   * all of them. It starts at zero, it reaches the end, it is hot, and it has
   * no predecessor to contradict. So a plan with no contrast in it whatsoever
   * passed validation in silence and rendered a hundred seconds of centred
   * outlined type.
   *
   * A rule about contrast has to be a rule about proportions, not about
   * adjacency. The brief asks for hot to punctuate; past about sixty per cent
   * it is the baseline and there is nothing left for it to interrupt.
   */
  const hotMs = segments
    .filter((s) => s.register === 'hot')
    .reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  const share = durationMs === 0 ? 0 : hotMs / durationMs;
  if (share > MAX_HOT_SHARE) {
    problems.push(
      `hot is ${Math.round(share * 100)}% of the runtime, which is a baseline rather than a punch`,
    );
  }
  if (segments.every((s) => s.register === 'hot')) {
    problems.push('every segment is hot, so nothing is punctuated');
  }

  return problems;
}

/**
 * Moves every boundary onto the nearest word boundary in the real read.
 *
 * Planning happens before the narration exists, so the boundaries are
 * arithmetic. Cutting on arithmetic means cutting mid-syllable, which is the
 * single most obvious tell that a video was assembled rather than edited --
 * so once the words are timed, every seam moves to the nearest gap between
 * them.
 */
export function snapToWords(
  plan: EditPlan,
  words: readonly { startMs: number; endMs: number }[],
): EditPlan {
  if (words.length === 0) return plan;
  const edges = [0, ...words.map((w) => w.endMs)];

  const nearest = (ms: number): number => {
    let best = edges[0]!;
    let bestGap = Math.abs(ms - best);
    for (const edge of edges) {
      const gap = Math.abs(ms - edge);
      if (gap < bestGap) {
        best = edge;
        bestGap = gap;
      }
    }
    return best;
  };

  const segments = plan.segments.map((s) => ({ ...s }));
  for (const [i, s] of segments.entries()) {
    if (i === 0) continue;
    const snapped = nearest(s.startMs);
    // Never past the end of the segment before it or the start of this one's
    // own end: a snap that reorders the plan is worse than a soft cut.
    const previous = segments[i - 1]!;
    if (snapped <= previous.startMs || snapped >= s.endMs) continue;
    previous.endMs = snapped;
    s.startMs = snapped;
  }
  return { ...plan, segments };
}
