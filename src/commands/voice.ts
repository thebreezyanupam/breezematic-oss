import path from 'node:path';
import { ROOT, workDir } from '../config.js';
import { writeJsonAtomic } from '../json.js';
import { out } from '../log.js';
import { table } from '../report.js';
import { hashString } from '../rng.js';
import { formatMs, slugify } from '../text.js';
import { generateScript } from '../stages/script.js';
import { synthesizeVoice } from '../stages/voice.js';
import { alignWords } from '../stages/align.js';

export type VoiceOptions = {
  topic: string;
  seed?: number;
  variant: number;
  force: boolean;
  table: boolean;
};

export async function voiceCommand(options: VoiceOptions): Promise<number> {
  const slug = slugify(options.topic);
  const seed = options.seed ?? hashString(slug);

  const script = await generateScript({
    topic: options.topic,
    seed,
    index: options.variant,
    force: options.force,
  });

  const voice = await synthesizeVoice({
    spokenText: script.spokenText,
    slug,
    force: options.force,
  });

  const alignment = await alignWords({
    audioPath: voice.alignPath,
    spokenText: script.spokenText,
    durationMs: voice.durationMs,
    force: options.force,
  });

  const wordsPath = path.join(workDir(slug), 'words.json');
  writeJsonAtomic(wordsPath, alignment.words);

  const matchRate = (alignment.matchedCount / alignment.words.length) * 100;
  const gaps = findGaps(alignment.words);

  out('');
  out(`topic       ${options.topic}`);
  out(`variant     ${options.variant} (seed ${script.seed})${script.cached ? ' cached' : ''}`);
  out(`spoken      ${alignment.words.length} words`);
  out(`raw audio   ${formatMs(voice.rawDurationMs)}`);
  out(`narration   ${formatMs(voice.durationMs)} after trim + ${'1.05'}x stretch`);
  out(`whisper     heard ${alignment.heardCount} words, matched ${alignment.matchedCount} (${matchRate.toFixed(1)}%)`);
  out(`audio       ${path.relative(ROOT, voice.audioPath)}`);
  out(`words       ${path.relative(ROOT, wordsPath)}`);

  if (gaps.length > 0) {
    out(`gaps        ${gaps.length} silence(s) over 400ms: ${gaps.map((g) => formatMs(g)).join(', ')}`);
  }

  if (options.table) {
    out('');
    out(
      table(
        ['#', 'start', 'end', 'word'],
        alignment.words.map((word, i) => [
          String(i + 1).padStart(3, '0'),
          formatMs(word.startMs),
          formatMs(word.endMs),
          word.text,
        ]),
      ),
    );
  }

  return 0;
}

function findGaps(words: readonly { startMs: number; endMs: number }[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const previous = words[i - 1];
    const current = words[i];
    if (previous === undefined || current === undefined) continue;
    const gap = current.startMs - previous.endMs;
    if (gap > 400) gaps.push(gap);
  }
  return gaps;
}
