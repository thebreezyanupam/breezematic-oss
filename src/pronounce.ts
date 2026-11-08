export type Substitution = { rule: string; from: string; to: string };

export type SpokenResult = { spoken: string; substitutions: Substitution[] };

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen',
] as const;

const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
] as const;

const SCALES: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000_000, 'trillion'],
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand'],
];

const MAGNITUDES: Record<string, string> = {
  k: 'thousand',
  m: 'million',
  b: 'billion',
  t: 'trillion',
};

const CURRENCIES: Record<string, { one: string; many: string; sub: string }> = {
  $: { one: 'dollar', many: 'dollars', sub: 'cents' },
  '€': { one: 'euro', many: 'euros', sub: 'cents' },
  '£': { one: 'pound', many: 'pounds', sub: 'pence' },
  '¥': { one: 'yen', many: 'yen', sub: 'sen' },
};

const ORDINAL_TAIL: Record<string, string> = {
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
  twenty: 'twentieth',
  thirty: 'thirtieth',
  forty: 'fortieth',
  fifty: 'fiftieth',
  sixty: 'sixtieth',
  seventy: 'seventieth',
  eighty: 'eightieth',
  ninety: 'ninetieth',
  hundred: 'hundredth',
  thousand: 'thousandth',
  million: 'millionth',
  billion: 'billionth',
};

const ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\be\.g\.\s?/gi, 'for example '],
  [/\bi\.e\.\s?/gi, 'that is '],
  [/\betc\./gi, 'et cetera'],
  [/\bvs\.?\B|\bvs\.?\b/gi, 'versus'],
  [/\bDr\./g, 'Doctor'],
  [/\bMr\./g, 'Mister'],
  [/\bMrs\./g, 'Missus'],
  [/\bMs\./g, 'Miz'],
  [/\bSt\./g, 'Saint'],
  [/\bapprox\./gi, 'approximately'],
  [/\bA\.?K\.?A\.?\b/g, 'also known as'],
  [/\bw\//g, 'with'],
];

const SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\s&\s/g, ' and '],
  [/\s\+\s/g, ' plus '],
  [/\s=\s/g, ' equals '],
  [/#(?=\d)/g, 'number '],
  [/\s@\s/g, ' at '],
  [/°/g, ' degrees'],
  [/\s~(?=\d)/g, ' about '],
];

const SPOKEN_AS_WORD = new Set([
  'NASA', 'NATO', 'SCUBA', 'LASER', 'RADAR', 'ASAP', 'GIF', 'JPEG', 'PNG', 'SQL', 'AIDS',
  'OPEC', 'UNICEF', 'PIN', 'RAM', 'ROM', 'SIM', 'OK',
]);

/**
 * Genuinely spelled-out initialisms. Everything else in caps is assumed to be
 * emphasis — people write "the trick is FOCUS" in pasted scripts, and spelling
 * that out letter by letter was exactly the bug. A caps word with a vowel that
 * is not on this list is treated as a shouted word, not an acronym.
 */
const INITIALISMS = new Set([
  'FBI', 'CIA', 'NSA', 'IRS', 'DNA', 'RNA', 'CEO', 'CFO', 'CTO', 'COO', 'VP',
  'USA', 'UK', 'US', 'EU', 'UN', 'NYC', 'LA', 'DC', 'USSR',
  'AI', 'IQ', 'ID', 'IP', 'AM', 'PM', 'PR', 'HR', 'VIP', 'DIY', 'FAQ', 'ATM',
  'GDP', 'CPU', 'GPU', 'URL', 'USB', 'EV', 'IPO', 'VC', 'HQ', 'QR', 'UFO',
  'NBA', 'NFL', 'NHL', 'MLB', 'BBC', 'CNN', 'ER', 'DJ', 'PS', 'AKA',
]);

/**
 * Emoji and pictographs: kept on screen, never spoken. The variation selector,
 * zero-width joiner and skin tones ride along with the base glyph so a joined
 * sequence (family, flag, keycap) is removed whole.
 */
const EMOJI_RE = new RegExp(
  '(?:' +
    '[\\u{1F1E6}-\\u{1F1FF}]{2}' + // flag pairs
    '|[#*0-9]\\uFE0F?\\u20E3' + // keycaps
    '|\\p{Extended_Pictographic}(?:[\\u{1F3FB}-\\u{1F3FF}]|\\uFE0F|\\u200D\\p{Extended_Pictographic})*' +
  ')',
  'gu',
);

export function underHundred(value: number): string {
  if (value < 20) return ONES[value] ?? String(value);
  const tens = Math.floor(value / 10);
  const rest = value % 10;
  return rest === 0 ? (TENS[tens] ?? '') : `${TENS[tens]} ${ONES[rest]}`;
}

function underThousand(value: number): string {
  if (value < 100) return underHundred(value);
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const head = `${ONES[hundreds]} hundred`;
  return rest === 0 ? head : `${head} ${underHundred(rest)}`;
}

export function integerToWords(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`cannot speak ${value}`);
  if (value < 0) return `minus ${integerToWords(-value)}`;
  if (value === 0) return 'zero';

  const parts: string[] = [];
  let rest = Math.trunc(value);
  for (const [scale, name] of SCALES) {
    if (rest >= scale) {
      parts.push(`${integerToWords(Math.floor(rest / scale))} ${name}`);
      rest %= scale;
    }
  }
  if (rest > 0) parts.push(underThousand(rest));
  return parts.join(' ');
}

export function digitsToWords(digits: string): string {
  return digits
    .split('')
    .map((digit) => ONES[Number(digit)] ?? digit)
    .join(' ');
}

export function numberToWords(raw: string): string {
  const cleaned = raw.replace(/,/g, '');
  const [whole = '0', fraction] = cleaned.split('.');
  const head = integerToWords(Number(whole));
  return fraction === undefined ? head : `${head} point ${digitsToWords(fraction)}`;
}

export function yearToWords(value: number): string {
  if (value === 2000) return 'two thousand';
  if (value > 2000 && value < 2010) return `two thousand ${ONES[value - 2000]}`;
  const high = Math.floor(value / 100);
  const low = value % 100;
  if (low === 0) return `${underHundred(high)} hundred`;
  if (low < 10) return `${underHundred(high)} oh ${ONES[low]}`;
  return `${underHundred(high)} ${underHundred(low)}`;
}

export function ordinalToWords(value: number): string {
  const words = integerToWords(value).split(' ');
  const last = words[words.length - 1];
  if (last === undefined) return integerToWords(value);
  const replacement = ORDINAL_TAIL[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...words.slice(0, -1), replacement].join(' ');
}

function spellLetters(token: string): string {
  return token.split('').join(' ');
}

/**
 * Whether a run of capitals is an initialism to read letter by letter, or just
 * a word someone shouted. Getting this wrong is what made the voice spell
 * ordinary words: a pasted script saying "the trick is FOCUS" came out
 * "F O C U S". Known initialisms spell out, so does anything with no vowel at
 * all (NHS, PDF, HTML), and everything else is left for the TTS to read
 * normally.
 */
function spellsOut(token: string): boolean {
  if (SPOKEN_AS_WORD.has(token)) return false;
  if (INITIALISMS.has(token)) return true;
  return !/[AEIOUY]/.test(token);
}

/** Strips emoji for the voice. The display text keeps them untouched. */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

export type TokenExpansion = { display: string; spoken: string[]; rules: string[] };

export function normalizeForSpeech(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*[—–]\s*/g, ', ');
}

export function expandTokens(text: string): TokenExpansion[] {
  return normalizeForSpeech(text)
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((display) => {
      const { spoken, substitutions } = toSpoken(display);
      return {
        display,
        spoken: spoken.split(/\s+/).filter((word) => word.length > 0),
        rules: substitutions.map((entry) => entry.rule),
      };
    });
}

export function spokenTextOf(expansions: readonly TokenExpansion[]): string {
  return expansions.flatMap((entry) => entry.spoken).join(' ');
}

export function toSpoken(text: string): SpokenResult {
  const substitutions: Substitution[] = [];
  let spoken = normalizeForSpeech(text);

  // Before anything else: emoji are for the screen, never for the voice.
  const withoutEmoji = stripEmoji(spoken);
  if (withoutEmoji !== spoken) {
    substitutions.push({ rule: 'emoji', from: spoken, to: withoutEmoji });
    spoken = withoutEmoji;
  }

  const apply = (rule: string, pattern: RegExp, replace: (...args: string[]) => string): void => {
    spoken = spoken.replace(pattern, (...args) => {
      const groups = args.slice(0, -2).map((value) => (value === undefined ? '' : String(value)));
      const from = groups[0] ?? '';
      const to = replace(...groups);
      if (to !== from) substitutions.push({ rule, from, to });
      return to;
    });
  };

  for (const [pattern, replacement] of ABBREVIATIONS) {
    apply('abbreviation', pattern, () => replacement);
  }

  apply('range', /\b(\d{4})\s*-\s*(\d{4})\b/g, (_all, a = '', b = '') =>
    `${yearToWords(Number(a))} to ${yearToWords(Number(b))}`,
  );

  apply('range', /\b(\d+)\s*-\s*(\d+)\b/g, (_all, a = '', b = '') =>
    `${numberToWords(a)} to ${numberToWords(b)}`,
  );

  apply(
    'currency',
    /([$€£¥])\s?(\d[\d,]*(?:\.\d+)?)\s?([kmbt])?\b/gi,
    (_all, symbol = '', amount = '', magnitude = '') => {
      const money = CURRENCIES[symbol];
      if (money === undefined) return _all;
      if (magnitude !== '') {
        const scale = MAGNITUDES[magnitude.toLowerCase()] ?? '';
        return `${numberToWords(amount)} ${scale} ${money.many}`;
      }
      const [whole = '0', cents] = amount.replace(/,/g, '').split('.');
      const unit = whole === '1' && cents === undefined ? money.one : money.many;
      if (cents !== undefined && cents.length === 2) {
        return `${integerToWords(Number(whole))} ${unit} and ${integerToWords(Number(cents))} ${money.sub}`;
      }
      return `${numberToWords(amount)} ${unit}`;
    },
  );

  apply('percent', /(\d[\d,]*(?:\.\d+)?)\s?%/g, (_all, amount = '') =>
    `${numberToWords(amount)} percent`,
  );

  apply('magnitude', /\b(\d[\d,]*(?:\.\d+)?)\s?([kmb])\b/gi, (_all, amount = '', magnitude = '') =>
    `${numberToWords(amount)} ${MAGNITUDES[magnitude.toLowerCase()] ?? ''}`,
  );

  apply('multiplier', /\b(\d[\d,]*(?:\.\d+)?)\s?[x×]\b/g, (_all, amount = '') =>
    `${numberToWords(amount)} times`,
  );

  apply('ordinal', /\b(\d+)(?:st|nd|rd|th)\b/gi, (_all, amount = '') =>
    ordinalToWords(Number(amount)),
  );

  apply('clock', /\b(\d{1,2}):(\d{2})\b/g, (_all, hour = '', minute = '') => {
    const minutes = Number(minute);
    if (minutes === 0) return `${integerToWords(Number(hour))} o'clock`;
    if (minutes < 10) return `${integerToWords(Number(hour))} oh ${ONES[minutes]}`;
    return `${integerToWords(Number(hour))} ${underHundred(minutes)}`;
  });

  apply('year', /\b(1[1-9]\d{2}|20\d{2})\b/g, (_all, year = '') => yearToWords(Number(year)));

  apply('number', /\b\d[\d,]*(?:\.\d+)?\b/g, (all = '') => numberToWords(all));

  for (const [pattern, replacement] of SYMBOLS) {
    apply('symbol', pattern, () => replacement);
  }

  apply('acronym', /\b([A-Z]{2,5})(s)?\b/g, (all = '', token = '', plural = '') => {
    if (!spellsOut(token)) return all;
    return plural === '' ? spellLetters(token) : `${spellLetters(token)}s`;
  });

  spoken = spoken.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();

  return { spoken, substitutions };
}
