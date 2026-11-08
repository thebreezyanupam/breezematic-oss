import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { downloadWhisperModel, installWhisperCpp, transcribe } from '@remotion/install-whisper-cpp';
import { MODELS, whisperDirs } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { language } from '../languages.js';
import { reconcile, type AlignedWord, type HeardWord } from '../align/reconcile.js';
import type { Word } from '../schema.js';

export type AlignResult = {
  words: Word[];
  heardCount: number;
  matchedCount: number;
  cached: boolean;
};

type CachedTranscript = { heard: HeardWord[] };

export async function ensureWhisper(): Promise<string> {
  fs.mkdirSync(whisperDirs.install, { recursive: true });
  fs.mkdirSync(whisperDirs.models, { recursive: true });

  const install = await installWhisperCpp({
    version: MODELS.align.whisperCppVersion,
    to: whisperDirs.install,
    printOutput: false,
  });
  log.info(
    install.alreadyExisted
      ? `whisper.cpp ${MODELS.align.whisperCppVersion} already installed`
      : `installed whisper.cpp ${MODELS.align.whisperCppVersion}`,
  );

  const model = await downloadWhisperModel({
    model: MODELS.align.model,
    folder: whisperDirs.models,
    printOutput: false,
  });
  log.info(
    model.alreadyExisted
      ? `whisper model ${MODELS.align.model} already downloaded`
      : `downloaded whisper model ${MODELS.align.model}`,
  );

  normalizeWindowsLayout();
  return whisperDirs.install;
}

function normalizeWindowsLayout(): void {
  if (process.platform !== 'win32') return;

  const expected = path.join(whisperDirs.install, 'build', 'bin');
  if (fs.existsSync(path.join(expected, 'whisper-cli.exe'))) return;

  const shipped = path.join(whisperDirs.install, 'Release');
  if (!fs.existsSync(shipped)) return;

  fs.mkdirSync(expected, { recursive: true });
  for (const entry of fs.readdirSync(shipped, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(shipped, entry.name), path.join(expected, entry.name));
  }
  log.debug(`mirrored whisper binaries into ${expected}`);
}

async function listen(audioPath: string, languageId: string): Promise<HeardWord[]> {
  const whisperPath = await ensureWhisper();
  const spoken = language(languageId);

  /**
   * The `.en` models cannot hear anything else.
   *
   * Configured model first, but only where it can work: WHISPER_MODEL defaults
   * to base.en, and handing Hindi audio to an English-only model does not fail
   * -- it returns confident English words that were never said, which then
   * become the caption timings. So a non-English video overrides it with the
   * language's own choice, and says so, because the override costs render time
   * and silently taking longer is its own kind of wrong.
   */
  const model = spoken.whisper.requiresMultilingual ? spoken.whisper.model : MODELS.align.model;
  if (model !== MODELS.align.model) {
    log.info(`align: listening in ${spoken.label} with the ${model} model`);
  }

  const result = await transcribe({
    inputPath: audioPath,
    whisperPath,
    whisperCppVersion: MODELS.align.whisperCppVersion,
    model,
    modelFolder: whisperDirs.models,
    tokenLevelTimestamps: true,
    printOutput: false,
    language: spoken.whisper.language,
  });

  const heard: HeardWord[] = [];
  for (const item of result.transcription) {
    const raw = item.text;
    if (raw.trim().length === 0) continue;
    if (/^\s*[[(].*[\])]\s*$/.test(raw)) continue;

    const token = item.tokens[0];
    const startMs =
      token !== undefined && token.t_dtw !== -1 ? token.t_dtw * 10 : item.offsets.from;

    const previous = heard[heard.length - 1];
    const startsWord = previous === undefined || /^\s/.test(raw) || /^[^\w']/.test(raw.trim());

    if (startsWord) {
      heard.push({ text: raw.trim(), startMs, endMs: item.offsets.to });
    } else {
      previous.text += raw.trim();
      previous.endMs = item.offsets.to;
    }
  }

  for (let i = 0; i < heard.length - 1; i++) {
    const current = heard[i];
    const next = heard[i + 1];
    if (current === undefined || next === undefined) continue;
    if (current.endMs > next.startMs) current.endMs = next.startMs;
    if (current.endMs <= current.startMs) current.endMs = current.startMs + 60;
  }

  return heard;
}

export async function alignWords(options: {
  audioPath: string;
  spokenText: string;
  durationMs: number;
  force: boolean;
  language?: string;
}): Promise<AlignResult> {
  cache.setForce(options.force);
  const spoken = language(options.language);
  const model = spoken.whisper.requiresMultilingual ? spoken.whisper.model : MODELS.align.model;

  const { value, hit } = await cache.json<CachedTranscript>(
    'align',
    {
      provider: MODELS.align.provider,
      // The model that will actually listen, not the configured one -- they
      // differ for every non-English video, and a key naming the wrong one
      // would serve English timings for a Hindi reading.
      model,
      language: spoken.whisper.language,
      whisper: MODELS.align.whisperCppVersion,
      text: options.spokenText,
      /**
       * What was actually said, not only what was meant to be. Keyed on the
       * text alone, a script voiced a second time -- another reader, another
       * provider, or just a fresh take -- was never listened to: whisper's
       * timings for the *old* recording came back from the cache and were laid
       * over the new one. Takes differ in pace, so the captions drifted
       * further from the voice with every sentence, three seconds by the end
       * of a ninety-second essay, and nothing anywhere reported a miss.
       */
      audio: crypto.createHash('sha256').update(fs.readFileSync(options.audioPath)).digest('hex'),
    },
    async () => ({ heard: await listen(options.audioPath, spoken.id) }),
  );

  const scriptWords = options.spokenText.split(/\s+/).filter((word) => word.length > 0);
  const aligned: AlignedWord[] = reconcile(scriptWords, value.heard, options.durationMs);

  return {
    words: aligned.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })),
    heardCount: value.heard.length,
    matchedCount: aligned.filter((word) => word.matched).length,
    cached: hit,
  };
}
