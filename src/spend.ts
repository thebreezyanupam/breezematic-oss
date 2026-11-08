import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { dirs, env } from './config.js';
import { readJson, writeJsonAtomic } from './json.js';
import { log } from './log.js';

/**
 * What this machine has actually spent, and what it is allowed to.
 *
 * There was a CostLedger before this and it counted one stage, in memory, for
 * the length of one command. It never saw an image — which is where nearly all
 * of the money goes — it was never written down, and its `overCeiling()` was
 * dead code that nothing called. So the honest answer to "how much has this
 * cost me" was that nobody knew.
 *
 * Recording happens in the three providers that charge, rather than at the
 * places that call them. That is the difference between a number that is right
 * and a number that is nearly right: a stage can be added, cached, retried or
 * forgotten, but if it did not go through one of those three functions it did
 * not cost anything, and if it did then it is in here. Cache hits never reach a
 * provider, so a re-render of an unchanged video correctly records nothing.
 */

const FILE = () => path.join(dirs.work, 'spend.json');

/** What the money went on, in the terms somebody deciding would use. */
export const SPEND_KINDS = ['script', 'voice', 'pictures'] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

const entrySchema = z
  .object({
    at: z.string(),
    slug: z.string(),
    kind: z.enum(SPEND_KINDS),
    model: z.string(),
    /** Human-readable: "15 panels", "2.1k in / 900 out". */
    detail: z.string(),
    usd: z.number().nonnegative(),
  })
  .strict();

export type SpendEntry = z.infer<typeof entrySchema>;

/**
 * A cap, and what to do about it.
 *
 * Two windows because they answer different questions: a day catches a runaway
 * afternoon, a month is the bill. Either can be null, which means no cap rather
 * than a cap of zero.
 *
 * `onExceed` is 'ask' or 'stop'. Asking is the default because the alternative
 * is a tool that silently refuses to work and does not say why.
 */
const limitsSchema = z
  .object({
    dailyUsd: z.number().positive().max(1000).nullable().default(null),
    monthlyUsd: z.number().positive().max(10_000).nullable().default(null),
    onExceed: z.enum(['ask', 'stop']).default('ask'),
  })
  .strict();

export type Limits = z.infer<typeof limitsSchema>;

const fileSchema = z
  .object({
    version: z.literal(1),
    limits: limitsSchema.default({ dailyUsd: null, monthlyUsd: null, onExceed: 'ask' }),
    entries: z.array(entrySchema).default([]),
  })
  .strict();

type SpendFile = z.infer<typeof fileSchema>;

const EMPTY: SpendFile = {
  version: 1,
  limits: { dailyUsd: null, monthlyUsd: null, onExceed: 'ask' },
  entries: [],
};

function read(): SpendFile {
  const file = FILE();
  if (!fs.existsSync(file)) return { ...EMPTY, entries: [] };
  try {
    return fileSchema.parse(readJson(file));
  } catch (error) {
    // Losing the history is bad; refusing to render because of it is worse.
    log.warn(`spend: ${path.basename(file)} could not be read (${(error as Error).message})`);
    return { ...EMPTY, entries: [] };
  }
}

function write(next: SpendFile): void {
  fs.mkdirSync(dirs.work, { recursive: true });
  writeJsonAtomic(FILE(), next);
}

/**
 * Which video the next recording belongs to.
 *
 * Ambient rather than threaded through every provider call, because a provider
 * has no business knowing what a video is and there is exactly one run at a
 * time. Set at the start of a run; anything spent outside one is attributed to
 * no video, which is true.
 */
let currentSlug = '';

/**
 * Whether anything of this kind was ever paid for on this video's behalf.
 *
 * The one record of what a finished video is made of that outlives the run:
 * a picture that was generated was paid for, and the payment names the video.
 */
export function spentOn(slug: string, kind: SpendKind): boolean {
  return read().entries.some((entry) => entry.slug === slug && entry.kind === kind);
}

export function setSpendContext(slug: string): void {
  currentSlug = slug;
}

/** Appends one charge. Never throws: money already left, so losing the note is the smaller loss. */
export function recordSpend(entry: {
  kind: SpendKind;
  model: string;
  detail: string;
  usd: number;
}): void {
  if (!Number.isFinite(entry.usd) || entry.usd <= 0) return;
  try {
    const file = read();
    file.entries.push({
      at: new Date().toISOString(),
      slug: currentSlug,
      kind: entry.kind,
      model: entry.model,
      detail: entry.detail,
      usd: entry.usd,
    });
    write(file);
  } catch (error) {
    log.debug(`spend: could not record (${(error as Error).message})`);
  }
}

const dayKey = (at: Date): string => at.toISOString().slice(0, 10);
const monthKey = (at: Date): string => at.toISOString().slice(0, 7);

function sum(entries: readonly SpendEntry[]): number {
  return entries.reduce((total, entry) => total + entry.usd, 0);
}

export type SpendSummary = {
  today: number;
  month: number;
  allTime: number;
  byKind: { kind: SpendKind; usd: number; calls: number }[];
  /** The most recent videos, newest first, with what each one cost. */
  recent: { slug: string; usd: number; at: string }[];
  limits: Limits;
  /** Days since the first recorded charge, for an average that means something. */
  days: number;
  /**
   * The last twelve weeks, oldest first, split by kind: what the chart draws.
   * Weeks start on Monday, in UTC like every timestamp in the ledger.
   */
  weekly: { start: string; byKind: Record<SpendKind, number> }[];
};

const WEEKS = 12;

/** The Monday on or before a moment, as YYYY-MM-DD (UTC). */
function weekStart(at: Date): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function weeklyOf(entries: readonly SpendEntry[], now: Date): SpendSummary['weekly'] {
  const first = new Date(weekStart(now) + 'T00:00:00Z');
  first.setUTCDate(first.getUTCDate() - 7 * (WEEKS - 1));
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const start = new Date(first);
    start.setUTCDate(first.getUTCDate() + 7 * i);
    const byKind = Object.fromEntries(SPEND_KINDS.map((kind) => [kind, 0])) as Record<SpendKind, number>;
    return { start: start.toISOString().slice(0, 10), byKind };
  });
  const index = new Map(weeks.map((week, i) => [week.start, i]));
  for (const entry of entries) {
    const i = index.get(weekStart(new Date(entry.at)));
    if (i !== undefined) weeks[i]!.byKind[entry.kind] += entry.usd;
  }
  return weeks;
}

export function spendSummary(recentLimit = 12): SpendSummary {
  const file = read();
  const now = new Date();
  const today = dayKey(now);
  const month = monthKey(now);

  const byKind = SPEND_KINDS.map((kind) => {
    const mine = file.entries.filter((entry) => entry.kind === kind);
    return { kind, usd: sum(mine), calls: mine.length };
  });

  /**
   * Grouped by video rather than listed call by call. Nobody wants to read
   * three hundred rows of "one panel, $0.003"; the question is which videos
   * cost what.
   */
  const perVideo = new Map<string, { usd: number; at: string }>();
  for (const entry of file.entries) {
    if (entry.slug === '') continue;
    const found = perVideo.get(entry.slug);
    if (found === undefined) perVideo.set(entry.slug, { usd: entry.usd, at: entry.at });
    else {
      found.usd += entry.usd;
      if (entry.at > found.at) found.at = entry.at;
    }
  }

  const first = file.entries[0]?.at;
  const days =
    first === undefined
      ? 0
      : Math.max(1, Math.round((now.getTime() - new Date(first).getTime()) / 86_400_000));

  return {
    today: sum(file.entries.filter((entry) => entry.at.slice(0, 10) === today)),
    month: sum(file.entries.filter((entry) => entry.at.slice(0, 7) === month)),
    allTime: sum(file.entries),
    byKind,
    recent: [...perVideo.entries()]
      .map(([slug, value]) => ({ slug, usd: value.usd, at: value.at }))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, recentLimit),
    limits: file.limits,
    days,
    weekly: weeklyOf(file.entries, now),
  };
}

export function readLimits(): Limits {
  return read().limits;
}

export function writeLimits(input: unknown): Limits {
  const limits = limitsSchema.parse(input);
  const file = read();
  file.limits = limits;
  write(file);
  log.info(
    `spend: limits are now ${limits.dailyUsd ?? 'no'} daily / ${limits.monthlyUsd ?? 'no'} monthly, ${limits.onExceed} when reached`,
  );
  return limits;
}

export type Verdict = {
  /** False when this run would take the machine past a cap. */
  ok: boolean;
  /** 'daily' or 'monthly', when it is not ok. */
  window: 'daily' | 'monthly' | null;
  spent: number;
  limit: number | null;
  estimate: number;
  onExceed: Limits['onExceed'];
};

/**
 * Whether a run costing roughly this much is allowed to start.
 *
 * Checked before the run rather than during it, because stopping halfway
 * through leaves a video that cost money and does not exist. The estimate is
 * the point where it has to be approximately right rather than exact, and it
 * is deliberately generous: refusing a run that would have been affordable is
 * a smaller failure than allowing one that is not.
 */
export function checkBudget(estimate: number): Verdict {
  const summary = spendSummary(0);
  const { limits } = summary;

  const daily =
    limits.dailyUsd !== null && summary.today + estimate > limits.dailyUsd
      ? ({ window: 'daily', spent: summary.today, limit: limits.dailyUsd } as const)
      : null;
  const monthly =
    limits.monthlyUsd !== null && summary.month + estimate > limits.monthlyUsd
      ? ({ window: 'monthly', spent: summary.month, limit: limits.monthlyUsd } as const)
      : null;

  const hit = daily ?? monthly;
  if (hit === null) {
    return {
      ok: true,
      window: null,
      spent: summary.today,
      limit: limits.dailyUsd,
      estimate,
      onExceed: limits.onExceed,
    };
  }
  return { ok: false, ...hit, estimate, onExceed: limits.onExceed };
}

/**
 * Roughly what a run is about to cost, before it starts.
 *
 * Deliberately rough and deliberately high. The point is to catch "this will
 * blow the budget", not to invoice anyone, and a guess that is a little over
 * fails safe: the worst case is a prompt you did not strictly need, where the
 * other kind of error is a bill you did not agree to.
 *
 * The numbers behind it: pictures dominate and are the only part anyone can
 * change the size of. The writing is a handful of small structured calls and
 * lands around a third of a cent whatever the video is. The hosted reader is
 * billed on audio tokens, which track the length of the script closely enough
 * that seconds-of-narration is a better predictor than anything else.
 */
export function estimateRun(options: {
  kind: string;
  /** Long form only: how many minutes of narration was asked for. */
  minutes?: number | undefined;
  generatedStill?: boolean | undefined;
  mode?: string | undefined;
  imageSource?: string | undefined;
  imageCount?: number | undefined;
  ttsProvider?: string | undefined;
  /** Beats in the sheet, when there is one. Storybook draws one picture each. */
  beats?: number | undefined;
  usdPerImage: number;
  defaultImages: number;
}): { usd: number; parts: { kind: SpendKind; usd: number; note: string }[] } {
  const parts: { kind: SpendKind; usd: number; note: string }[] = [];

  /**
   * Long form is the one run that can cost real money, and it is worth being
   * explicit about why: the words scale with the length and the speech scales
   * with the words. A twenty-minute saga is roughly twenty times the narration
   * of a short. Measured at about 10.8 audio tokens per word on the hosted
   * reader, which at its output rate is a shade over a cent a minute; the
   * local reader is free however long it runs.
   */
  if (options.kind === 'lore') {
    const minutes = options.minutes ?? 20;
    parts.push({
      kind: 'script',
      usd: 0.004 + minutes * 0.0015,
      note: `writing ${minutes} minutes of prose`,
    });
    if (options.ttsProvider === 'gemini') {
      parts.push({ kind: 'voice', usd: minutes * 0.013, note: `${minutes} minutes, hosted reader` });
    }
    if (options.ttsProvider === 'elevenlabs') {
      // About 140 words a minute, six characters a word, at the list price.
      parts.push({ kind: 'voice', usd: (minutes * 140 * 6 * 0.1) / 1000, note: `${minutes} minutes, ElevenLabs` });
    }
    if (options.ttsProvider === 'clone') {
      // One call per ~3,800 characters, and a minute is about 140 words.
      const calls = Math.max(1, Math.ceil((minutes * 140 * 6) / 3800));
      parts.push({ kind: 'voice', usd: calls * 0.02, note: `${calls} passages, cloned voice` });
    }
    if (options.generatedStill === true) {
      parts.push({ kind: 'pictures', usd: options.usdPerImage, note: '1 generated still' });
    }
    return { usd: parts.reduce((total, part) => total + part.usd, 0), parts };
  }

  const drawsEveryBeat = options.mode === 'storybook';
  const generates = drawsEveryBeat || options.imageSource === 'ai';
  if (generates) {
    const count = drawsEveryBeat
      ? (options.beats ?? 18)
      : (options.imageCount ?? options.defaultImages);
    parts.push({
      kind: 'pictures',
      usd: count * options.usdPerImage,
      note: `${count} generated ${count === 1 ? 'picture' : 'pictures'}`,
    });
  }

  // A plan writes the script, the beats and whatever the mode needs on top;
  // a produce run reuses all of it from the cache and writes nothing.
  if (options.kind === 'plan') {
    parts.push({ kind: 'script', usd: 0.004, note: 'writing and planning' });
  }

  if (options.ttsProvider === 'gemini' && options.kind === 'plan') {
    parts.push({ kind: 'voice', usd: 0.012, note: 'hosted reader' });
  }
  if (options.ttsProvider === 'elevenlabs' && options.kind === 'plan') {
    // A short is about a thousand characters: a tenth of a dollar at list
    // price, and nothing extra while a plan's included characters last.
    parts.push({ kind: 'voice', usd: 0.1, note: 'ElevenLabs, about 1,000 characters' });
  }

  return { usd: parts.reduce((total, part) => total + part.usd, 0), parts };
}

/**
 * The same run with the paid parts swapped for free ones, and what changed.
 *
 * Only two of the three have a free equivalent, and saying so plainly matters
 * more than appearing to solve it: the local reader is a true like-for-like
 * swap, openly licensed stock replaces generated pictures at a real cost in
 * how the video looks, and the writing has no free version at all short of
 * supplying the script yourself. An illustrated video is drawings by
 * definition, so for that mode there is nothing to swap -- it is the one case
 * where the only answers are "spend it" or "don't".
 */
export function freeAlternative(options: { mode?: string | undefined; imageSource?: string | undefined; ttsProvider?: string | undefined }): {
  changes: { field: 'ttsProvider' | 'imageSource'; to: string; was: string; note: string }[];
  blocked: string | null;
} {
  const changes: { field: 'ttsProvider' | 'imageSource'; to: string; was: string; note: string }[] = [];

  if (options.ttsProvider === 'gemini') {
    changes.push({
      field: 'ttsProvider',
      to: 'kokoro',
      was: 'gemini',
      note: 'the local reader, which costs nothing and needs no key',
    });
  }

  if (options.mode === 'storybook') {
    return {
      changes,
      blocked:
        'An illustrated video is drawn panels, and there is no free way to draw them. ' +
        'Switching the reader still helps; the pictures are the part you would have to give up.',
    };
  }

  if (options.imageSource === 'ai') {
    // Still generated, just on the free plan, when there is one to use.
    const free = env.CLOUDFLARE_ACCOUNT_ID !== undefined && env.CLOUDFLARE_API_TOKEN !== undefined;
    changes.push({
      field: 'imageSource',
      to: free ? 'ai-free' : 'stock',
      was: 'ai',
      note: free ? 'generated on the free plan instead of the paid one' : 'openly licensed photographs instead of generated ones',
    });
  }

  return { changes, blocked: null };
}
