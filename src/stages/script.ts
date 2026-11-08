import { MODELS, PLAN, TEMPLATE_DESCRIPTIONS } from '../config.js';
import { cache } from '../cache.js';
import { CostLedger } from '../cost.js';
import { log } from '../log.js';
import { language, type Language } from '../languages.js';
import { generate } from '../providers/gemini.js';
import { expandTokens, spokenTextOf } from '../pronounce.js';
import {
  TEMPLATE_NAMES,
  scriptDraftSchema,
  type ScriptDraft,
  type Substitution,
  type TemplateName,
} from '../schema.js';
import { wordCount } from '../text.js';
import { toneFor, type Tone } from '../tones.js';
import { EXPLAINER_WORDS } from '../explainer.js';

export const SCRIPT_PROMPT_VERSION = 5;

const TEMPERATURE = 0.9;
/**
 * Cooler for an explainer. Heat is what makes a short's hook surprising, and
 * it is also what made the first explainer "reveal" that the Great Pyramid was
 * floated up an internal water ramp. A video whose job is to be right gets
 * less of it.
 */
const EXPLAINER_TEMPERATURE = 0.5;
const MAX_OUTPUT_TOKENS = 2048;

/**
 * What the script is for. A short is a single surprising claim in forty
 * seconds; an explainer has a minute to actually explain something, and asks
 * once for the subscribe that the short is told never to ask for.
 */
export type ScriptFormat = 'short' | 'explainer';


export type ScriptVariant = {
  index: number;
  seed: number;
  cached: boolean;
  draft: ScriptDraft;
  hook: string;
  body: string;
  fullText: string;
  spokenText: string;
  pronunciation: Substitution[];
  words: number;
  hookWords: number;
  usage: { model: string; inputTokens: number; outputTokens: number };
};

type CachedCall = {
  raw: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/**
 * The register goes in the system instruction rather than in the numbered
 * rules. Buried at rule 9 of 13 it lost every time to "declarative, no filler"
 * three rules later — a Gen Z brief came back reading like an encyclopaedia.
 * Up here it governs the whole draft.
 */
function systemInstruction(tone: Tone, spoken: Language, format: ScriptFormat = 'short'): string {
  /**
   * First, and repeated at the end of the prompt.
   *
   * A language instruction buried in the middle of a long rule list is the one
   * a model drifts off: it opens in Hindi and finishes in English, or writes
   * Hindi words in Latin letters. Saying it at both ends costs a sentence and
   * is the difference between a usable script and a re-run.
   */
  const inLanguage = spoken.id === 'en' ? [] : ['', `LANGUAGE — ${spoken.instruction}`, ''];

  return [
    format === 'explainer'
      ? 'You write narration for 55-70 second vertical explainer videos that actually teach something.'
      : 'You write narration for 30-50 second vertical short-form videos.',
    ...inLanguage,
    'The narration is the entire video: there is no presenter, no interview, no scene to describe.',
    format === 'explainer'
      ? 'Every word you write will be spoken aloud and captioned over pictures and motion graphics: counters, charts, timelines, numbered steps.'
      : 'Every word you write will be spoken aloud and set as large animated type on screen.',
    '',
    `VOICE — this is who is writing, and it governs every line you produce:`,
    tone.direction,
    '',
    'The numbered rules that follow are structural. Where one of them seems to',
    'argue with the voice above, satisfy the structure while keeping the voice.',
    'The single exception is the rule about sourcing claims, which always wins.',
    '',
    'You return JSON and nothing else. No preamble, no markdown, no code fences.',
  ].join(' ');
}

function buildPrompt(topic: string, tone: Tone, brief: string, spoken: Language): string {
  const templates = TEMPLATE_NAMES.map(
    (name) => `- ${name}: ${TEMPLATE_DESCRIPTIONS[name]}`,
  ).join('\n');

  /**
   * A topic is four to nine words and often ambiguous — "mercury" is a planet,
   * a metal and a god, and the writer has no way to know which was meant. The
   * brief is where that gets said, so it sits directly under the topic and
   * above the rules rather than being folded into one of them, where a line
   * this important reads as a footnote.
   */
  const direction =
    brief.trim() === '' ? '' : `
What the topic means here, and what to do with it:
${brief.trim()}
`;

  /**
   * The topic stays in whatever the person typed. Asking for a Hindi script
   * about "why ice floats on water" is the normal case -- somebody types the
   * subject in the language they think in, and wants the video in another.
   */
  const languageRule =
    spoken.id === 'en'
      ? ''
      : `
LANGUAGE: ${spoken.instruction} Every field you return -- hook, beats, emphasis words -- is in ${spoken.label}. The emphasis word must be copied verbatim from its own beat, so it is in ${spoken.label} too. The topic above may be written in another language; that does not change what you write in.
`;

  return `Write the narration for a short about: ${topic}
${direction}${languageRule}
Rules:
1. "hook" is one standalone sentence of at most ${PLAN.hookMaxWords - 1} words that can be spoken in under two seconds. It states a specific, surprising claim. Never a yes/no question, never "did you know", never "here's why".
2. "beats" has 10 to 16 entries. beats[0].text must be the hook, repeated verbatim.
3. Each beat is one clause or short sentence of 5 to 14 words that reads as a single unit on screen.
4. The beats together total ${PLAN.scriptWordsMin} to ${PLAN.scriptWordsMax} words.
5. Exactly one beat is a reversal, placed between 55% and 75% of the way through, and it starts with "But", "Actually" or "Turns out".
6. Include at least two concrete specifics: a number, a year, or a proper noun. Write numbers as digits, not words.
7. "emphasis_word" is a single word copied verbatim from that beat's text. Prefer a number, a superlative, or the most surprising noun.
8. "template_hint" is one of:
${templates}
9. Keep the voice described above in every beat, including the hook.
10. No filler, no "in this video", no sign-off, no call to action, no emoji, no markdown, no stage directions.
11. The last beat lands the idea. It does not ask for follows or likes.
12. Never attribute a claim to a named study, university, researcher or publication year, and never write "research shows", "studies prove", "scientists say" or "experts agree". State the claim directly. Only use a number you are confident is true; a vague true claim beats a precise invented one.
13. Vary "template_hint": use at least four distinct values across the beats and never the same value more than four times.

Return only the JSON object.`;
}

/**
 * The explainer's brief.
 *
 * Its own prompt rather than a flag threaded through the short's, because the
 * two disagree on the things that matter: how long, how much to explain, and
 * whether to ask for anything. The short's rule against calls to action stays
 * exactly where it is; this one asks for a single subscribe line, in a fixed
 * place, because the plug is drawn wherever that word is said and a plug in
 * the hook is a video that loses its viewer in the first second.
 *
 * Graphics are not written here. They are chosen afterwards against the beats
 * as they were actually cut, which is the only place a chart can be timed to
 * the word it illustrates. What the writer is asked for instead is material a
 * graphic can be honestly built from: real numbers, things to compare, steps
 * in order, dates.
 */
function buildExplainerPrompt(topic: string, tone: Tone, brief: string, spoken: Language): string {
  const templates = TEMPLATE_NAMES.map(
    (name) => `- ${name}: ${TEMPLATE_DESCRIPTIONS[name]}`,
  ).join('\n');
  const direction =
    brief.trim() === '' ? '' : `
What the topic means here, and what to do with it:
${brief.trim()}
`;
  const languageRule =
    spoken.id === 'en'
      ? ''
      : `
LANGUAGE: ${spoken.instruction} Every field you return is in ${spoken.label}, including the subscribe line. The topic above may be written in another language; that does not change what you write in.
`;

  return `Write the narration for a vertical explainer about: ${topic}
${direction}${languageRule}
The video answers one question properly: what this is, why it happens or how it works, and what follows from it. A viewer should finish it able to explain the idea to a friend.

Rules:
1. "hook" is one standalone sentence of at most ${PLAN.hookMaxWords - 1} words that can be spoken in under two seconds. It states a specific, surprising claim or the question the video answers as a statement. Never a yes/no question, never "did you know", never "here's why".
2. "beats" has 14 to 22 entries. beats[0].text must be the hook, repeated verbatim.
3. Each beat is one clause or short sentence of 6 to 16 words that reads as a single unit.
4. The beats together total ${EXPLAINER_WORDS.min} to ${EXPLAINER_WORDS.max} words.
5. Shape: the hook; one or two beats of context; the mechanism explained in order, cause before effect, one step per beat; a concrete example with real figures; the consequence or the surprising implication; then the subscribe beat; then a final beat that lands the idea.
6. Build in material for on-screen graphics, and only where it is true: at least three concrete numbers (written as digits), at least one comparison of two things, and either a sequence of steps or a sequence of dates.
7. Exactly one beat, between 45% and 75% of the way through, starts with "But", "Actually" or "Turns out" and adds a genuine complication or corrects a misconception people really hold. Never invent a surprising theory to fill this beat: if nothing popular is wrong, use it for the hardest part of the explanation.
8. The second-to-last beat is the subscribe line: at most 10 words, containing the word "subscribe", said plainly in the voice above, tied to the topic. Example shape: "Subscribe if you want the next one explained like this." No other beat mentions subscribing, liking, following or comments.
9. "emphasis_word" is a single word copied verbatim from that beat's text. Prefer a number, a superlative, or the most important noun.
10. "template_hint" is one of:
${templates}
11. Keep the voice described above in every beat, including the hook.
12. Explain in plain words. Define any technical term the first time it is used, in the same beat or the next.
13. No filler, no "in this video", no "let's dive in", no emoji, no markdown, no stage directions.
14. ACCURACY OVERRIDES EVERYTHING ABOVE, INCLUDING THE VOICE AND THE HOOK. Explain the established, mainstream understanding a good encyclopedia would give. Where experts genuinely disagree, say it is debated and give the leading explanation; never present a fringe, speculative or invented theory as fact. Only use figures you are certain appear in standard references, and keep them exactly as they are usually given.
15. Never attribute a claim to a named study, university, researcher or publication year, and never write "research shows", "studies prove", "scientists say" or "experts agree". State the claim directly.
16. Vary "template_hint": use at least four distinct values across the beats and never the same value more than five times.

Return only the JSON object.`;
}

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    hook: { type: 'string' },
    beats: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          template_hint: { type: 'string', enum: [...TEMPLATE_NAMES] },
          emphasis_word: { type: 'string' },
        },
        required: ['text', 'template_hint', 'emphasis_word'],
        propertyOrdering: ['text', 'template_hint', 'emphasis_word'],
      },
    },
  },
  required: ['hook', 'beats'],
  propertyOrdering: ['hook', 'beats'],
};

export function stripFences(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/;
  const match = fence.exec(text);
  if (match?.[1] !== undefined) text = match[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`model response contains no JSON object: ${raw.slice(0, 200)}`);
  }
  return text.slice(start, end + 1);
}

function normalizeTemplateHint(value: unknown): TemplateName | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return (TEMPLATE_NAMES as readonly string[]).includes(normalized)
    ? (normalized as TemplateName)
    : null;
}

/**
 * Words, stripped of punctuation, in any script.
 *
 * `\p{L}\p{M}\p{N}` rather than `a-z0-9`, and the `\p{M}` is the half that is
 * easy to miss. Letters alone are not a word in every script: Devanagari
 * matras and the virama are combining marks, so a letters-only class turns
 * हल्की into हलक and बर्फ into बरफ — words that are still non-empty, still
 * look plausible in a log, and match nothing. The result is not a crash but a
 * video where no word is ever emphasised, and the emphasis is most of what the
 * kinetic type does.
 */
function bareWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}'\s-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function normalizeEmphasis(value: unknown, text: string): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().replace(/[^\p{L}\p{M}\p{N}'$%.-]/gu, '');
  if (candidate.length === 0) return null;
  return bareWords(text).includes(candidate.toLowerCase()) ? candidate : null;
}

export function parseDraft(raw: string): ScriptDraft {
  const parsed: unknown = JSON.parse(stripFences(raw));
  const shaped = parsed as { hook?: unknown; beats?: unknown };
  const beats = Array.isArray(shaped.beats) ? shaped.beats : [];

  const normalized = {
    hook: typeof shaped.hook === 'string' ? shaped.hook.trim() : '',
    beats: beats.map((entry) => {
      const beat = entry as Record<string, unknown>;
      const text = typeof beat['text'] === 'string' ? beat['text'].trim() : '';
      return {
        text,
        template_hint: normalizeTemplateHint(beat['template_hint']),
        emphasis_word: normalizeEmphasis(beat['emphasis_word'], text),
      };
    }),
  };

  return scriptDraftSchema.parse(normalized);
}

export function draftWarnings(variant: ScriptVariant): string[] {
  const warnings: string[] = [];
  const { draft } = variant;

  if (variant.hookWords > PLAN.hookMaxWords) {
    warnings.push(`hook is ${variant.hookWords} words, limit ${PLAN.hookMaxWords}`);
  }
  if (variant.words < PLAN.scriptWordsMin || variant.words > PLAN.scriptWordsMax) {
    warnings.push(
      `${variant.words} words, target ${PLAN.scriptWordsMin}-${PLAN.scriptWordsMax}`,
    );
  }
  const first = draft.beats[0];
  if (first !== undefined && first.text.trim() !== draft.hook.trim()) {
    warnings.push('beats[0] is not the hook verbatim');
  }
  const reversalIndex = draft.beats.findIndex((beat) =>
    /^(but|actually|turns out)\b/i.test(beat.text.trim()),
  );
  if (reversalIndex === -1) {
    warnings.push('no reversal beat ("But" / "Actually" / "Turns out")');
  } else {
    const position = reversalIndex / draft.beats.length;
    if (position < 0.45 || position > 0.85) {
      warnings.push(`reversal sits at ${Math.round(position * 100)}% of the script`);
    }
  }
  const missingEmphasis = draft.beats.filter((beat) => beat.emphasis_word === null).length;
  if (missingEmphasis > 0) {
    warnings.push(`${missingEmphasis} beat(s) have no usable emphasis word`);
  }
  const missingHint = draft.beats.filter((beat) => beat.template_hint === null).length;
  if (missingHint > 0) {
    warnings.push(`${missingHint} beat(s) have an unrecognised template hint`);
  }
  if (!/\d/.test(variant.fullText)) {
    warnings.push('no digits anywhere; stat-slam beats will have nothing to slam');
  }
  const attribution = /\b(research(ers)? (shows?|found|from|clocked|say)|studies (show|prove|found)|scientists say|experts agree|according to|university of|a \d{4} (study|paper|report))\b/i.exec(
    variant.fullText,
  );
  if (attribution !== null) {
    warnings.push(`cites a source ("${attribution[0]}") the pipeline cannot verify`);
  }
  const hints = draft.beats.map((beat) => beat.template_hint).filter((hint) => hint !== null);
  const distinct = new Set(hints).size;
  if (distinct < 4) {
    warnings.push(`only ${distinct} distinct template hint(s) across ${draft.beats.length} beats`);
  }
  return warnings;
}

export async function generateScript(options: {
  topic: string;
  seed: number;
  index: number;
  force: boolean;
  tone?: string;
  /** The writer's own direction for an ambiguous or under-specified topic. */
  brief?: string;
  language?: string;
  format?: ScriptFormat;
}): Promise<ScriptVariant> {
  const model = MODELS.llm.script;
  const seed = options.seed + options.index;
  const tone = toneFor(options.tone);
  const spoken = language(options.language);
  const format = options.format ?? 'short';

  cache.setForce(options.force);

  const { value, hit } = await cache.json<CachedCall>(
    'script',
    {
      promptVersion: SCRIPT_PROMPT_VERSION,
      tone: tone.id,
      // Part of the key: the same topic in two languages is two scripts, and
      // without this the first one written would be served for both.
      language: spoken.id,
      // Only in the key when it is not the short, so every script cached
      // before the explainer existed is still found.
      ...(format === 'short' ? {} : { format, explainerVersion: 2 }),
      model,
      topic: options.topic,
      seed,
      temperature: format === 'explainer' ? EXPLAINER_TEMPERATURE : TEMPERATURE,
    },
    async () => {
      const response = await generate({
        model,
        systemInstruction: systemInstruction(tone, spoken, format),
        prompt:
          format === 'explainer'
            ? buildExplainerPrompt(options.topic, tone, options.brief ?? '', spoken)
            : buildPrompt(options.topic, tone, options.brief ?? '', spoken),
        temperature: format === 'explainer' ? EXPLAINER_TEMPERATURE : TEMPERATURE,
        seed,
        maxOutputTokens: format === 'explainer' ? MAX_OUTPUT_TOKENS * 2 : MAX_OUTPUT_TOKENS,
        responseSchema: RESPONSE_SCHEMA,
      });
      return {
        raw: response.text,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      };
    },
  );

  const draft = parseDraft(value.raw);
  log.debug(`script variant ${options.index} seed=${seed} ${hit ? 'cached' : 'generated'}`);

  return variantFromDraft(draft, {
    index: options.index,
    seed,
    cached: hit,
    usage: {
      model: value.model,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
    },
  });
}

type VariantMeta = {
  index: number;
  seed: number;
  cached: boolean;
  usage: ScriptVariant['usage'];
};

/** The pronunciation pass and derived fields, shared by every way a draft can arrive. */
function variantFromDraft(draft: ScriptDraft, meta: VariantMeta): ScriptVariant {
  const hook = draft.hook.trim();
  const bodyBeats = draft.beats.slice(1).map((beat) => beat.text.trim());
  const body = bodyBeats.join(' ');
  const fullText = `${hook} ${body}`.replace(/\s+/g, ' ').trim();
  const expansions = expandTokens(fullText);
  const spokenText = spokenTextOf(expansions);
  const pronunciation = expansions
    .filter((entry) => entry.spoken.join(' ') !== entry.display)
    .map((entry) => ({
      rule: entry.rules[0] ?? 'token',
      display: entry.display,
      spoken: entry.spoken.join(' '),
    }));

  return {
    ...meta,
    draft,
    hook,
    body,
    fullText,
    spokenText,
    pronunciation,
    words: wordCount(fullText),
    hookWords: wordCount(hook),
  };
}

const EMPHASIS_MARK = /\*([^*]+)\*/;

/**
 * A hand-written script: one beat per line, the first line is the hook. A
 * single paragraph is split at sentence ends instead. `*word*` marks the
 * beat's emphasis word; template hints are left to the planner.
 */
export function draftFromText(text: string): ScriptDraft {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const pieces =
    lines.length > 1
      ? lines
      : (lines[0] ?? '')
          .split(/(?<=[.!?])\s+/)
          .map((piece) => piece.trim())
          .filter((piece) => piece.length > 0);

  const beats = pieces.map((piece) => {
    const marked = EMPHASIS_MARK.exec(piece)?.[1]?.trim().split(/\s+/)[0];
    const clean = piece.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    return {
      text: clean,
      template_hint: null,
      emphasis_word: normalizeEmphasis(marked, clean),
    };
  });

  const result = scriptDraftSchema.safeParse({ hook: beats[0]?.text ?? '', beats });
  if (!result.success) {
    const detail = result.error.issues[0];
    throw new Error(
      `script does not fit the beat contract (4-24 beats, one per line, first line is the hook): ` +
        `${detail?.path.join('.') ?? ''} ${detail?.message ?? 'invalid'}`,
    );
  }
  return result.data;
}

export function scriptFromText(options: { text: string; index?: number }): ScriptVariant {
  return variantFromDraft(draftFromText(options.text), {
    index: options.index ?? 0,
    seed: 0,
    cached: false,
    usage: { model: 'user-script', inputTokens: 0, outputTokens: 0 },
  });
}

export async function generateScriptVariants(options: {
  topic: string;
  seed: number;
  count: number;
  force: boolean;
}): Promise<{ variants: ScriptVariant[]; ledger: CostLedger }> {
  const ledger = new CostLedger();
  const variants: ScriptVariant[] = [];

  for (let index = 0; index < options.count; index++) {
    const variant = await generateScript({ ...options, index });
    variants.push(variant);
    if (!variant.cached) {
      ledger.record({
        stage: 'script',
        provider: MODELS.llm.provider,
        model: variant.usage.model,
        inputTokens: variant.usage.inputTokens,
        outputTokens: variant.usage.outputTokens,
      });
    }
  }

  return { variants, ledger };
}
