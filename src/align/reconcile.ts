export type HeardWord = { text: string; startMs: number; endMs: number };

export type AlignedWord = { text: string; startMs: number; endMs: number; matched: boolean };

const MATCH = 3;
const MISMATCH = -2;
const GAP = -2;

export function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/[^a-z0-9']/g, '')
    .replace(/^'+|'+$/g, '');
}

type Step = 'diag' | 'up' | 'left';

function alignSequences(a: readonly string[], b: readonly string[]): Array<[number | null, number | null]> {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const score = new Int32Array(rows * cols);
  const trace = new Array<Step | null>(rows * cols).fill(null);

  for (let i = 1; i < rows; i++) {
    score[i * cols] = i * GAP;
    trace[i * cols] = 'up';
  }
  for (let j = 1; j < cols; j++) {
    score[j] = j * GAP;
    trace[j] = 'left';
  }

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const same = a[i - 1] === b[j - 1];
      const diagonal = (score[(i - 1) * cols + (j - 1)] ?? 0) + (same ? MATCH : MISMATCH);
      const up = (score[(i - 1) * cols + j] ?? 0) + GAP;
      const left = (score[i * cols + (j - 1)] ?? 0) + GAP;

      let best = diagonal;
      let step: Step = 'diag';
      if (up > best) {
        best = up;
        step = 'up';
      }
      if (left > best) {
        best = left;
        step = 'left';
      }
      score[i * cols + j] = best;
      trace[i * cols + j] = step;
    }
  }

  const pairs: Array<[number | null, number | null]> = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    const step = trace[i * cols + j];
    if (step === 'diag') {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (step === 'up') {
      pairs.push([i - 1, null]);
      i -= 1;
    } else {
      pairs.push([null, j - 1]);
      j -= 1;
    }
  }
  return pairs.reverse();
}

export function reconcile(
  scriptWords: readonly string[],
  heard: readonly HeardWord[],
  totalDurationMs: number,
): AlignedWord[] {
  if (scriptWords.length === 0) return [];
  if (heard.length === 0) return spreadEvenly(scriptWords, 0, totalDurationMs);

  const pairs = alignSequences(
    scriptWords.map(normalizeToken),
    heard.map((word) => normalizeToken(word.text)),
  );

  const timings = new Array<HeardWord | null>(scriptWords.length).fill(null);
  for (const [scriptIndex, heardIndex] of pairs) {
    if (scriptIndex === null || heardIndex === null) continue;
    const source = heard[heardIndex];
    if (source !== undefined) timings[scriptIndex] = source;
  }

  const words: AlignedWord[] = scriptWords.map((text, index) => {
    const timing = timings[index];
    return timing === null || timing === undefined
      ? { text, startMs: -1, endMs: -1, matched: false }
      : { text, startMs: timing.startMs, endMs: timing.endMs, matched: true };
  });

  fillGaps(words, totalDurationMs);
  enforceMonotonic(words, totalDurationMs);
  return words;
}

function fillGaps(words: AlignedWord[], totalDurationMs: number): void {
  let index = 0;
  while (index < words.length) {
    if (words[index]?.matched === true) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < words.length && words[end]?.matched === false) end += 1;

    const before = words[index - 1];
    const after = words[end];
    const from = before === undefined ? 0 : before.endMs;
    const to = after === undefined ? totalDurationMs : after.startMs;
    const span = Math.max(to - from, (end - index) * 60);
    const each = span / (end - index);

    for (let i = index; i < end; i++) {
      const word = words[i];
      if (word === undefined) continue;
      word.startMs = Math.round(from + (i - index) * each);
      word.endMs = Math.round(from + (i - index + 1) * each);
    }
    index = end;
  }
}

function enforceMonotonic(words: AlignedWord[], totalDurationMs: number): void {
  let previousEnd = 0;
  for (const word of words) {
    if (word.startMs < previousEnd) word.startMs = previousEnd;
    if (word.endMs <= word.startMs) word.endMs = word.startMs + 60;
    if (word.endMs > totalDurationMs) word.endMs = Math.max(word.startMs + 1, totalDurationMs);
    previousEnd = word.endMs;
  }
}

function spreadEvenly(
  scriptWords: readonly string[],
  fromMs: number,
  toMs: number,
): AlignedWord[] {
  const each = (toMs - fromMs) / scriptWords.length;
  return scriptWords.map((text, index) => ({
    text,
    startMs: Math.round(fromMs + index * each),
    endMs: Math.round(fromMs + (index + 1) * each),
    matched: false,
  }));
}
