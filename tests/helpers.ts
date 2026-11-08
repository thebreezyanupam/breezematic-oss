import { SFX_CUES, type RenderMode, type Word } from '../src/schema.js';
import type { PlanInput } from '../src/stages/plan.js';

/** A short script, written the way the script stage hands one over: the first beat is the hook. */
export const BEATS = [
  'The Dutch refused to dub their television.',
  'Almost every country in Europe overdubbed foreign shows.',
  'The Netherlands kept the original voices and added subtitles.',
  'A generation grew up reading English at speed.',
  'Today the Dutch speak it better than anyone outside the anglosphere.',
  'Their best teacher was a sitcom.',
] as const;

/**
 * Word timings as an aligner would return them: an even pace, a short gap
 * between words and a longer one after each sentence.
 */
export function timeWords(text: string, wordMs = 300, gapMs = 40, sentenceGapMs = 260): Word[] {
  const words: Word[] = [];
  let at = 120;
  for (const token of text.split(/\s+/).filter((t) => t !== '')) {
    words.push({ text: token, startMs: at, endMs: at + wordMs });
    at += wordMs + (/[.!?]$/.test(token) ? sentenceGapMs : gapMs);
  }
  return words;
}

export function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  const hook = BEATS[0];
  const body = BEATS.slice(1).join(' ');
  const fullText = `${hook} ${body}`;
  const words = timeWords(fullText);
  const last = words[words.length - 1];
  const durationMs = (last?.endMs ?? 0) + 300;

  return {
    topic: 'Why the Dutch speak English so well',
    slug: 'why-the-dutch-speak-english-so-well',
    seed: 42,
    language: 'en',
    draft: {
      hook,
      beats: BEATS.map((text, index) => ({
        text,
        template_hint: null,
        emphasis_word: index === 0 ? 'refused' : null,
      })),
    },
    script: { hook, body, fullText, spokenText: fullText, pronunciation: [] },
    words,
    voice: { audioPath: 'work/test/narration.wav', provider: 'kokoro', voiceId: 'af_heart', character: 'narrator' },
    durationMs,
    effect: 'gradient',
    music: { trackPath: '', startOffsetMs: 0, levelLufs: -26, fadeInMs: 400, fadeOutMs: 1200 },
    imagery: 'off',
    imageSource: 'stock',
    style: 'editorial',
    subtitles: 'burned',
    artStyle: 'auto',
    panelTexture: false,
    sfxCues: SFX_CUES,
    series: null,
    captionScale: 1,
    mode: 'kinetic' satisfies RenderMode,
    boardTexture: false,
    boardTheme: 'light',
    boardContent: 'overlay',
    boardImagery: 'draw',
    images: [],
    ...overrides,
  };
}
