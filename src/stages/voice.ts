import fs from 'node:fs';
import path from 'node:path';
import { KokoroTTS } from 'kokoro-js';
import { AUDIO, MODELS, env, workDir } from '../config.js';
import { cache } from '../cache.js';
import { BITEXACT, ffmpeg, probeDurationMs } from '../ffmpeg.js';
import { log } from '../log.js';
import { canRead, language, readerFor } from '../languages.js';
import { concatFloat32, readWavPcm16, writeWavPcm16 } from '../wav.js';
import { CHARACTERS, characterFor, type Character } from '../voices.js';
import { pitchProfile, semitones, type PitchProfile } from './pitch.js';
import { plainSpeech } from './plaintext.js';
import { speak as geminiSpeak } from '../providers/geminitts.js';
import { MAX_CHARS as ELEVEN_MAX_CHARS, readSettings, speak as elevenSpeak, stabilityFor } from '../providers/elevenlabs.js';
import { speak as cloneSpeak } from '../providers/chatterbox.js';
import { clipPath, defaultVoice, findVoice } from '../voiceclone.js';

export type VoiceResult = {
  audioPath: string;
  alignPath: string;
  durationMs: number;
  rawDurationMs: number;
  provider: string;
  voiceId: string;
  character: string;
  cached: boolean;
};

let engine: Promise<KokoroTTS> | undefined;

function loadEngine(): Promise<KokoroTTS> {
  if (engine === undefined) {
    // localModel, never model: under a hosted provider `model` is that
    // provider's id, and handing "gemini-2.5-flash-preview-tts" to the local
    // loader sends it looking for a HuggingFace repo by that name. It fails as
    // "Unauthorized access to file", which points nowhere near the cause.
    log.info(`loading ${MODELS.tts.localModel} (${MODELS.tts.dtype})`);
    engine = KokoroTTS.from_pretrained(MODELS.tts.localModel, {
      dtype: MODELS.tts.dtype,
      device: 'cpu',
    });
  }
  return engine;
}

const MAX_WORDS_PER_CHUNK = 30;
const INTER_SENTENCE_MS = 120;

export function splitForSynthesis(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.split(/\s+/).length <= MAX_WORDS_PER_CHUNK) {
      chunks.push(sentence);
      continue;
    }
    let current: string[] = [];
    for (const clause of sentence.split(/(?<=,)\s+/)) {
      const candidate = [...current, clause];
      if (candidate.join(' ').split(/\s+/).length > MAX_WORDS_PER_CHUNK && current.length > 0) {
        chunks.push(current.join(' '));
        current = [clause];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) chunks.push(current.join(' '));
  }
  return chunks;
}

/**
 * The most a single Gemini request is asked to read.
 *
 * This model generates speech the way a language model generates text, one
 * step conditioned on everything before it -- and over a long generation it
 * drifts. Measured on a ninety-second read: 196 words a minute in the first
 * fifteen seconds, 216 by the last, the pauses between words shortening as it
 * went. Across a six-minute essay that compounds into a read that audibly
 * speeds up and changes character, and a 985-word request simply timed out.
 *
 * So a long read is several short ones. Not sentence by sentence -- that would
 * throw away what this model is good at, carrying stress and breath across a
 * sentence boundary -- but paragraph by paragraph, which keeps every
 * sentence's context and resets the drift at exactly the places a human
 * narrator pauses anyway.
 */
const GEMINI_PASSAGE_WORDS = 150;

/** The breath between passages, where a paragraph ended. */
const PASSAGE_GAP_MS = 380;

/**
 * Paragraphs grouped up to the passage limit, never split mid-paragraph unless
 * a single paragraph is itself over the limit -- then on sentence ends.
 */
function passages(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '');

  const units: string[] = [];
  for (const paragraph of paragraphs) {
    const count = paragraph.split(' ').length;
    if (count <= GEMINI_PASSAGE_WORDS) {
      units.push(paragraph);
      continue;
    }
    let current = '';
    for (const sentence of paragraph.split(/(?<=[.!?…])\s+/)) {
      const next = current === '' ? sentence : `${current} ${sentence}`;
      if (current !== '' && next.split(' ').length > GEMINI_PASSAGE_WORDS) {
        units.push(current);
        current = sentence;
      } else {
        current = next;
      }
    }
    if (current !== '') units.push(current);
  }

  const grouped: string[] = [];
  let current = '';
  for (const unit of units) {
    const next = current === '' ? unit : `${current}\n\n${unit}`;
    if (current !== '' && next.split(/\s+/).length > GEMINI_PASSAGE_WORDS) {
      grouped.push(current);
      current = unit;
    } else {
      current = next;
    }
  }
  if (current !== '') grouped.push(current);
  return grouped;
}

/**
 * A long read, as a run of short ones that sound like one.
 *
 * Two things make separately generated passages join up. The same voice and
 * the same delivery note on every request, so each one starts from the same
 * place rather than wherever the last one drifted to. And a tempo check
 * afterwards: each passage's speaking rate is measured and pulled to the
 * median of the set, because the residual variation between independent
 * generations is mostly pace, and pace is the one thing that can be corrected
 * without touching the voice.
 */
/**
 * Said on every request, whatever the character's own note is.
 *
 * Each passage is a separate generation, so each one starts wherever the model
 * feels like starting -- and the complaint about a long read was exactly that:
 * a stretch in the voice asked for, then a passage that "speaks up", louder and
 * more animated, then back. Asking for the same voice and volume throughout is
 * the cheap half of the fix; measuring and correcting afterwards is the other.
 */
const STEADY =
  'Keep exactly the same voice, pace and volume from the first word to the last; ' +
  'never get louder or more excited. Read the following:';

/**
 * Who is reading, said outright.
 *
 * The model is also a voice actor: given a passage about a mother, a rival or
 * a crowd it will sometimes perform them, and a Fenrir read came back with
 * half a minute of a woman's voice and then a different man's in the middle.
 * Naming one narrator of one gender, and saying the people in the text are
 * not to be voiced, is the cheap half of stopping it; the pitch check in
 * synthesizeWithGemini catches what gets through.
 */
function narrator(voice: string | undefined): string {
  const gender = CHARACTERS.find((character) => character.geminiVoice === voice)?.gender;
  const who = gender === undefined ? 'one narrator' : `one ${gender} narrator`;
  return (
    `This is a single-speaker narration by ${who}. Use only that one voice for every word; ` +
    'never switch speaker, gender or accent, and do not act out or voice any person mentioned in the text.'
  );
}

function deliveryNote(style: string | undefined, voice?: string): string {
  const base = (style ?? MODELS.tts.style ?? '').trim().replace(/[:.\s]+$/, '');
  return `${narrator(voice)} ${base === '' ? STEADY : `${base}. ${STEADY}`}`;
}

/** Integrated loudness of a file, optionally through a filter first. */
async function loudnessOf(file: string, filter?: string): Promise<number> {
  const { stderr } = await ffmpeg([
    '-i', file,
    '-af', `${filter === undefined ? '' : `${filter},`}ebur128=framelog=quiet`,
    '-f', 'null', '-',
  ]);
  const found = [...stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  return found === undefined ? Number.NaN : Number(found[1]);
}

/**
 * How a passage sounds, in the two numbers that move when a read "speaks up":
 * how loud it is, and how bright -- the share of it above 2 kHz. A raised,
 * animated delivery puts more energy up there before it gets much louder, so
 * brightness catches the change of character that loudness alone misses.
 */
async function toneOf(file: string): Promise<{ loudness: number; brightness: number }> {
  const loudness = await loudnessOf(file);
  const high = await loudnessOf(file, 'highpass=f=2000');
  return { loudness, brightness: high - loudness };
}

/** Past this, in LU or dB, a passage no longer sounds like the rest of the read. */
const OUTLIER_LOUDNESS = 2.5;
const OUTLIER_BRIGHTNESS = 2.5;
/**
 * Past this share off the median pace, likewise. The tempo match afterwards
 * stretches at most twelve per cent; a passage further out than that cannot be
 * pulled in without sounding stretched, so it is read again instead. Measured
 * on a Fenrir read: seven passages, the fastest 82% quicker than the slowest,
 * and nothing else about them out of line -- speed was the change you heard.
 */
const OUTLIER_PACE = 0.18;

/**
 * The passage with the silence Gemini puts either side of it taken off.
 *
 * Pace is words over time, and a second of dead air at the end of a
 * forty-word passage makes it read as a fifth slower than it was spoken --
 * which then "corrects" a passage that was fine. The breath between passages
 * is added back explicitly when they are joined, at a length that is ours.
 */
async function trimmed(file: string): Promise<void> {
  const out = `${file}.trim.wav`;
  const edge = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05';
  await ffmpeg(['-i', file, '-af', `${edge},areverse,${edge},areverse`, '-f', 'wav', out]);
  fs.renameSync(out, file);
}

const median = (values: readonly number[]): number => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
};

async function synthesizeWithGemini(
  text: string,
  voice: string,
  destination: string,
  style?: string,
): Promise<void> {
  const parts = passages(text);
  const note = deliveryNote(style, voice);
  log.info(
    `gemini-tts: reading ${text.split(/\s+/).length} words as ${voice}, ` +
      `in ${parts.length} passage(s)`,
  );

  const dir = `${destination}.parts`;
  fs.mkdirSync(dir, { recursive: true });

  type Take = {
    file: string;
    words: number;
    ms: number;
    loudness: number;
    brightness: number;
    pitch: PitchProfile;
  };
  /**
   * Each passage kept as soon as it is paid for.
   *
   * A read that failed on passage six used to start again from passage one,
   * paying for five passages twice. Keyed by the take as well, so a passage
   * read again for sounding wrong is a new take, not the old one replayed.
   */
  const read = async (part: string, file: string): Promise<Take> => {
    const take = path.basename(file, '.wav').replace(/^\d+/, '') || 'a';
    const { path: kept } = await cache.file(
      'gemini-passage',
      { v: 1, model: MODELS.tts.hostedModel, voice, note, text: part, take },
      '.wav',
      async (destination) => {
        fs.writeFileSync(
          destination,
          await geminiSpeak({ text: part, voice, model: MODELS.tts.hostedModel, style: note }),
        );
      },
    );
    fs.copyFileSync(kept, file);
    await trimmed(file);
    return {
      file,
      words: part.split(/\s+/).length,
      ms: await probeDurationMs(file),
      ...(await toneOf(file)),
      pitch: pitchProfile(file),
    };
  };
  /**
   * Words a minute, actually.
   *
   * This was `words / Math.max(1, ms / 60_000)` -- which clamps the *minutes*
   * to at least one, so every passage shorter than a minute reported its word
   * count as its pace. A 32-word passage read at 151 wpm came back as "32
   * wpm", and the tempo match below then stretched passages to agree on a
   * number that was really their length. That is the read speeding up and
   * slowing down between passages for no reason, which is most of what "the
   * voice keeps changing" was.
   */
  const pace = (take: Take): number => take.words / Math.max(0.001, take.ms / 60_000);

  const files: Take[] = [];
  for (const [index, part] of parts.entries()) {
    files.push(await read(part, path.join(dir, `${String(index).padStart(3, '0')}.wav`)));
    log.info(`gemini-tts: passage ${index + 1}/${parts.length}`);
  }

  /**
   * Passages where somebody else is speaking, read again until they are not.
   *
   * Judged on pitch against the whole read, window by window, so a few seconds
   * of another voice inside an otherwise right passage is caught as well as a
   * passage that is wrong throughout. Measured on a cached Fenrir read with
   * the fault in it: the voice sat at 112 Hz, went to 190-220 Hz for half a
   * minute -- a woman -- then held at 160 Hz, a different man, for another
   * thirty seconds. Those are six to twelve semitones off; one person reading
   * with feeling moves a stretch's pitch by two or three.
   */
  const reference = median(files.flatMap((take) => take.pitch.windowsHz));
  const switched = (take: Take): number => {
    if (!Number.isFinite(reference)) return 0;
    const off = take.pitch.windowsHz.map((hz) => (Number.isFinite(hz) ? semitones(hz, reference) : 0));
    let worst = Number.isFinite(take.pitch.medianHz) ? semitones(take.pitch.medianHz, reference) / 3 : 0;
    off.forEach((st, i) => {
      worst = Math.max(worst, st / 7.5);
      // Two stretches in a row well off is a speaker, not an exclamation.
      if (i > 0) worst = Math.max(worst, Math.min(st, off[i - 1]!) / 5.5);
    });
    return worst;
  };
  const SPEAKER_TAKES = 3;
  for (const [index, take] of files.entries()) {
    let best = take;
    let score = switched(take);
    for (let attempt = 1; score > 1 && attempt <= SPEAKER_TAKES; attempt++) {
      log.info(
        `gemini-tts: passage ${index + 1} changes voice (${Math.round(best.pitch.medianHz)} Hz against ` +
          `${Math.round(reference)} Hz); reading it again (${attempt}/${SPEAKER_TAKES})`,
      );
      const retry = await read(parts[index]!, path.join(dir, `${String(index).padStart(3, '0')}v${attempt}.wav`));
      const after = switched(retry);
      if (after < score) {
        best = retry;
        score = after;
      }
    }
    if (best !== take) files[index] = best;
    if (score > 1) {
      log.warn(`gemini-tts: passage ${index + 1} still sounds like another speaker after ${SPEAKER_TAKES} more takes`);
    }
  }

  /**
   * The passages that do not sound like the others, read again once.
   *
   * Measured against the median of the whole read rather than the one before
   * it, so one odd passage cannot drag the reference with it. A second take is
   * a fresh generation and usually lands in the same place as the rest; if it
   * is no closer, the first is kept and the level match below does what it can.
   */
  const distance = (take: Take, loudness: number, brightness: number, wpm: number): number =>
    Math.max(
      Math.abs(take.loudness - loudness) / OUTLIER_LOUDNESS,
      Math.abs(take.brightness - brightness) / OUTLIER_BRIGHTNESS,
      // A passage of a sentence or two has too few words for its pace to mean
      // much, so only a real stretch of speech is judged on it.
      take.words >= 25 ? Math.abs(pace(take) / Math.max(1, wpm) - 1) / OUTLIER_PACE : 0,
    );
  if (files.length >= 3) {
    const mL = median(files.map((f) => f.loudness));
    const mB = median(files.map((f) => f.brightness));
    const mP = median(files.filter((f) => f.words >= 25).map(pace));
    for (const [index, take] of files.entries()) {
      log.info(
        `gemini-tts: passage ${index + 1}: ${Math.round(pace(take))} wpm, ` +
          `${take.loudness.toFixed(1)} LUFS, ${take.brightness.toFixed(1)} dB bright`,
      );
      const off = distance(take, mL, mB, mP);
      if (!(off > 1)) continue;
      log.info(
        `gemini-tts: passage ${index + 1} is out of character ` +
          `(${Math.round((pace(take) / Math.max(1, mP) - 1) * 100)}% pace, ` +
          `${(take.loudness - mL).toFixed(1)} LU, ${(take.brightness - mB).toFixed(1)} dB bright); reading it again`,
      );
      const retry = await read(parts[index]!, path.join(dir, `${String(index).padStart(3, '0')}b.wav`));
      const after = distance(retry, mL, mB, mP);
      // Never trade a passage for one with somebody else's voice in it.
      if (after < off && switched(retry) <= 1) files[index] = retry;
      log.info(`gemini-tts: passage ${index + 1} ${files[index] === retry ? 'replaced' : 'kept'} (${off.toFixed(1)} -> ${after.toFixed(1)})`);
    }
  }

  // Every passage brought to the same level: the half of "it speaks up" that
  // a second take did not fix is the half a gain can.
  const level = median(files.map((f) => f.loudness));

  // Pace, measured per passage, pulled to the median of the whole read.
  const rates = files.map(pace).sort((a, b) => a - b);
  const middle = rates[Math.floor(rates.length / 2)] ?? 0;

  const inputs: string[] = [];
  const filters: string[] = [];
  for (const [index, f] of files.entries()) {
    const rate = pace(f);
    // atempo > 1 speeds up; clamp so a mismeasured passage cannot be mangled.
    const tempo = Math.min(1.12, Math.max(0.88, middle / Math.max(1, rate)));
    const gain = Number.isFinite(f.loudness) ? Math.min(8, Math.max(-8, level - f.loudness)) : 0;
    inputs.push('-i', f.file);
    filters.push(
      `[${index}:a]aresample=24000,volume=${gain.toFixed(2)}dB,atempo=${tempo.toFixed(4)},` +
        `apad=pad_dur=${(PASSAGE_GAP_MS / 1000).toFixed(3)}[p${index}]`,
    );
  }
  const joined = files.map((_, index) => `[p${index}]`).join('');
  await ffmpeg([
    ...inputs,
    '-filter_complex',
    `${filters.join(';')};${joined}concat=n=${files.length}:v=0:a=1[out]`,
    '-map', '[out]',
    '-ac', '1',
    '-ar', '24000',
    // Pinned, because the cache hands over a `.tmp` path and ffmpeg picks
    // its muxer from the extension. Without this the join failed, the
    // failure fell through to the local engine, and the read came back in
    // a different voice with nothing but a warning line to say so.
    '-f', 'wav',
    destination,
  ]);

  const spread = rates.length > 1 ? ((rates[rates.length - 1]! - rates[0]!) / middle) * 100 : 0;
  log.info(
    `gemini-tts: joined at ${Math.round(middle)} wpm; ` +
      `passages varied ${spread.toFixed(0)}% before the tempo match`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * The whole script in one request, in the cloned voice.
 *
 * Not split into sentences the way the local engine is. Kokoro is chunked
 * because it degrades over long inputs; this takes five thousand characters
 * and a script here is about seven hundred, so splitting it would only throw
 * away the prosody that carries across a sentence boundary -- and would bill
 * once per piece instead of once.
 */
/**
 * Passages no longer than the provider will take, split on sentences.
 *
 * A short's script is about seven hundred characters and goes in one request,
 * which is what you want: prosody carries across a sentence boundary and
 * splitting throws that away. A long-form saga is twenty thousand, and the
 * model's ceiling is five -- so the choice is not whether to split but where,
 * and a sentence end is the one place a join is inaudible.
 */
const CLONE_CHARS_PER_CALL = 3_800;

export function splitForClone(text: string): string[] {
  if (text.length <= CLONE_CHARS_PER_CALL) return [text];

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');

  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current === '') {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= CLONE_CHARS_PER_CALL) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current !== '') chunks.push(current);

  // A single sentence longer than the ceiling is pathological, but a hard
  // truncation would silently lose words, so it is cut on whitespace instead.
  return chunks.flatMap((chunk) => {
    if (chunk.length <= CLONE_CHARS_PER_CALL) return [chunk];
    const pieces: string[] = [];
    let rest = chunk;
    while (rest.length > CLONE_CHARS_PER_CALL) {
      const at = rest.lastIndexOf(' ', CLONE_CHARS_PER_CALL);
      const cut = at > 0 ? at : CLONE_CHARS_PER_CALL;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    }
    if (rest !== '') pieces.push(rest);
    return pieces;
  });
}

async function synthesizeWithClone(
  text: string,
  destination: string,
  seed: number,
  voiceId: string | undefined,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Named, or the first one recorded. Falling back to "whichever" would mean a
  // sheet that recorded no voice reads in a different one once a second is
  // added, which is the kind of drift a seed is supposed to prevent.
  const voice = findVoice(voiceId) ?? defaultVoice();
  if (voice === null) {
    throw new Error('no cloned voice to read with — record one on the Voices screen');
  }
  const pieces = splitForClone(text);
  log.info(
    `chatterbox: reading ${text.split(/\s+/).length} words as "${voice.name}"` +
      (pieces.length === 1 ? '' : ` in ${pieces.length} passages`),
  );

  if (pieces.length === 1) {
    fs.writeFileSync(destination, await cloneSpeak({ text, reference: clipPath(voice), seed }));
    return;
  }

  /**
   * Concatenated through ffmpeg rather than by splicing the bytes: each call
   * comes back as its own wav with its own header, and the sample rate is the
   * provider's to choose. Each passage is seeded from the same run seed plus
   * its index, so a re-render reads identically without every passage being
   * the same roll.
   */
  const parts: string[] = [];
  for (const [index, piece] of pieces.entries()) {
    // Cached per passage, so an interrupted read is not re-bought. This one
    // costs money as well as time, which makes it matter more than the local
    // engine's, not less.
    const { path: part } = await cache.file(
      'voice-passage',
      { model: env.CLONE_MODEL, voice: voice.id, seed: seed + index * 101, text: piece },
      '.wav',
      async (into) => {
        fs.writeFileSync(
          into,
          await cloneSpeak({ text: piece, reference: clipPath(voice), seed: seed + index * 101 }),
        );
      },
    );
    parts.push(part);
    log.info(`chatterbox ${index + 1}/${pieces.length}: ${piece.slice(0, 60)}`);
    onProgress?.(index + 1, pieces.length);
  }

  await ffmpeg([
    ...parts.flatMap((part) => ['-i', part]),
    '-filter_complex',
    `${parts.map((_, i) => `[${i}:a]`).join('')}concat=n=${parts.length}:v=0:a=1[a]`,
    '-map', '[a]',
    '-y', destination,
  ]);
  // The parts are cache entries now, so they are deliberately not deleted:
  // they are what makes the next attempt cheap.
}

async function synthesizeToFile(
  text: string,
  voice: string,
  destination: string,
  provider: string,
  seed: number,
  voiceId: string | undefined,
  onProgress?: (done: number, total: number) => void,
  style?: string,
): Promise<void> {
  // Whatever path the words took to get here, no reader is handed markdown.
  text = plainSpeech(text);
  if (provider === 'gemini') {
    await synthesizeWithGemini(text, voice, destination, style);
    return;
  }

  if (provider === 'clone') {
    await synthesizeWithClone(text, destination, seed, voiceId, onProgress);
    return;
  }

  if (provider === 'elevenlabs') {
    await synthesizeWithElevenLabs(text, voice, destination, seed, onProgress);
    return;
  }

  const tts = await loadEngine();
  const pieces = splitForSynthesis(text);
  if (pieces.length === 0) throw new Error('nothing to synthesize');

  /**
   * Cached a sentence at a time, not a reading at a time.
   *
   * The whole reading was one cache entry, which is correct and was fine while
   * a script was thirty seconds long. A long-form saga is two hundred
   * sentences and about half an hour on this engine, and one entry means an
   * interrupted read -- a stop, a crash, a closed laptop -- throws away every
   * minute of it and starts at sentence one.
   *
   * Per sentence, the same interruption costs whatever was mid-flight. It is
   * also what makes stopping a run a real option rather than a threat: the work
   * survives, so the answer to "can I do something else first" stops being no.
   */
  const chunks: Float32Array[] = [];
  let sampleRate = 24_000;
  let spoken = 0;

  for (const [index, piece] of pieces.entries()) {
    const { path: cached, hit } = await cache.file(
      'voice-line',
      { model: MODELS.tts.localModel, dtype: MODELS.tts.dtype, voice, text: piece },
      '.wav',
      async (into) => {
        const audio = await tts.generate(piece, { voice: voice as never });
        writeWavPcm16(into, audio.audio as Float32Array, audio.sampling_rate);
      },
    );

    const { samples, rate } = readWavPcm16(cached);
    sampleRate = rate;
    if (index > 0) {
      chunks.push(new Float32Array(Math.round((sampleRate * INTER_SENTENCE_MS) / 1000)));
    }
    chunks.push(samples);
    if (hit !== true) spoken++;
    log.info(`kokoro ${index + 1}/${pieces.length}: ${piece.slice(0, 60)}`);
    onProgress?.(index + 1, pieces.length);
  }

  if (spoken < pieces.length) {
    log.info(`kokoro: ${pieces.length - spoken}/${pieces.length} lines were already read`);
  }
  writeWavPcm16(destination, concatFloat32(chunks), sampleRate);
}

/**
 * A read on ElevenLabs.
 *
 * A short is one request. A long read is split at paragraphs into as few
 * requests as the model allows -- every seam is a place two performances meet,
 * so fewer is better -- and each is cached as soon as it is paid for, so an
 * interrupted read picks up where it stopped rather than buying the start
 * again. The voice is an id, so there is no drift to measure or correct: the
 * checks the Gemini read needs have nothing to do here.
 */
async function synthesizeWithElevenLabs(
  text: string,
  voiceId: string,
  destination: string,
  seed: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const parts: string[] = [];
  let current = '';
  for (const paragraph of paragraphs.length > 0 ? paragraphs : [text.trim()]) {
    const next = current === '' ? paragraph : `${current}\n\n${paragraph}`;
    if (next.length <= ELEVEN_MAX_CHARS) {
      current = next;
      continue;
    }
    if (current !== '') parts.push(current);
    // A paragraph longer than a request on its own is cut at sentences.
    if (paragraph.length <= ELEVEN_MAX_CHARS) {
      current = paragraph;
    } else {
      current = '';
      for (const sentence of paragraph.match(/[^.!?…]+[.!?…]+["”’)]*\s*|[^.!?…]+$/g) ?? [paragraph]) {
        if ((current + sentence).length > ELEVEN_MAX_CHARS && current !== '') {
          parts.push(current.trim());
          current = '';
        }
        current += sentence;
      }
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  if (parts.length === 0) throw new Error('nothing to synthesize');

  log.info(`elevenlabs: reading ${text.length} characters with voice ${voiceId}, in ${parts.length} request(s)`);
  const files: string[] = [];
  for (const [index, part] of parts.entries()) {
    const { path: file } = await cache.file(
      'eleven-passage',
      // Stability is part of the read: changing it has to buy a new one.
      { model: env.ELEVENLABS_MODEL, settings: readSettings(), voice: voiceId, seed: seed + index * 101, text: part },
      '.mp3',
      async (into) => {
        fs.writeFileSync(
          into,
          await elevenSpeak({
            text: part,
            voiceId,
            seed: seed + index * 101,
            ...(index > 0 ? { previousText: parts[index - 1]!.slice(-600) } : {}),
            ...(index < parts.length - 1 ? { nextText: parts[index + 1]!.slice(0, 600) } : {}),
          }),
        );
      },
    );
    files.push(file);
    onProgress?.(index + 1, parts.length);
  }

  const gap = (PASSAGE_GAP_MS / 1000).toFixed(3);
  await ffmpeg([
    ...files.flatMap((file) => ['-i', file]),
    '-filter_complex',
    `${files.map((_, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=mono${i < files.length - 1 ? `,apad=pad_dur=${gap}` : ''}[p${i}]`).join(';')};` +
      `${files.map((_, i) => `[p${i}]`).join('')}concat=n=${files.length}:v=0:a=1[out]`,
    '-map', '[out]',
    '-c:a', 'pcm_s16le',
    // Said outright: the cache hands over a ".tmp" path, which names no format.
    '-f', 'wav',
    '-y', destination,
  ]);
}

const TRIM_FILTER = [
  'silenceremove=',
  'start_periods=1:start_duration=0:start_threshold=-45dB:',
  `stop_periods=-1:stop_duration=${(AUDIO.silenceTrimMsMax / 1000).toFixed(3)}:stop_threshold=-45dB`,
].join('');

/**
 * The trim for a performed read: the silence before the first word goes, and
 * any pause is shortened to at most HOSTED_PAUSE_MS -- but never removed.
 *
 * The local engine's trim takes every pause over a quarter second out
 * entirely, which is right for Kokoro, whose gaps are dead air the engine
 * inserts between sentences. ElevenLabs' gaps are the performance: the breath
 * before a turn, the beat after a number. Cut to nothing they were what made
 * its reads sound like a machine reading -- every sentence starting on the
 * last one's final consonant.
 */
const HOSTED_PAUSE_MS = 420;
const HOSTED_TRIM_FILTER = [
  'silenceremove=',
  'start_periods=1:start_duration=0:start_threshold=-50dB:',
  `stop_periods=-1:stop_duration=${((HOSTED_PAUSE_MS + 150) / 1000).toFixed(3)}:`,
  `stop_silence=${(HOSTED_PAUSE_MS / 1000).toFixed(3)}:stop_threshold=-50dB`,
].join('');

/** Hosted reads keep their own rate: resampling to the local engine's 24 kHz took the air out of the voice. */
const HOSTED_RATE = '44100';

/** A character's pace against the house tempo, at the precision ffmpeg is given. */
export function tempoFor(character: Character): number {
  return Math.round(AUDIO.narrationTempo * character.pace * 1000) / 1000;
}

export async function synthesizeVoice(options: {
  spokenText: string;
  slug: string;
  force: boolean;
  /** Roster id; falls back to the configured default when unknown. */
  character?: string;
  /** Which engine reads it. Defaults to whatever the machine is configured for. */
  provider?: string;
  /** What it is written in; decides which engines may read it. */
  language?: string;
  /** Cloning is seeded like everything else, so a re-render reads the same. */
  seed?: number;
  /** Which cloned voice reads it, when the engine is 'clone'. */
  cloneVoice?: string;
  /** Which ElevenLabs voice reads it, by id, when the engine is 'elevenlabs'. */
  elevenVoice?: string;
  /**
   * Called as each line is read. This is the stage that owns most of the wall
   * clock on a long one, and it is also where a cancellation can be noticed
   * promptly -- a caller that throws from here stops the reading between two
   * sentences rather than at the end of two hundred.
   */
  onProgress?: (done: number, total: number) => void;
}): Promise<VoiceResult> {
  cache.setForce(options.force);

  const character = characterFor(options.character ?? MODELS.tts.character);
  const known = character.id === options.character || options.character === undefined;
  const tempo = tempoFor(character);

  log.info(`voice: ${character.label} — ${character.blurb}`);

  /**
   * The hosted engine is free on the free tier, and a free tier has a daily
   * limit. Reaching it should cost you the quality of one video, not the video:
   * the local engine is bundled, always available, and reads the same words in
   * the same character's register.
   *
   * The fallback re-enters with a different provider rather than swapping the
   * engine inside the cache callback, so the key always describes what is
   * actually in the file. Keyed as "gemini" while holding local audio, a later
   * run with the limit lifted would replay the fallback for ever.
   */
  const spoken = language(options.language);
  let provider: string = readerFor(spoken.id, options.provider ?? MODELS.tts.provider);
  // A cloned voice is the recording, not a roster entry, so the character's
  // own voice id has nothing to say about it.
  let voice = provider === 'gemini' ? character.geminiVoice : character.voice;
  let raw: Awaited<ReturnType<typeof cache.file>>;

  for (;;) {
    // The same character, whichever engine is reading. Only a character outside
    // the roster falls back to the raw configured voice, and only the local
    // engine has one of those to fall back to.
    voice =
      provider === 'gemini'
        ? character.geminiVoice
        : provider === 'clone'
          ? ((findVoice(options.cloneVoice) ?? defaultVoice())?.id ?? 'none')
          : provider === 'elevenlabs'
            ? (options.elevenVoice ?? env.ELEVENLABS_VOICE ?? 'none')
            : known
            ? character.voice
            : MODELS.tts.voice;
    const engineVoice = voice;
    const engine = provider;

    try {
      raw = await cache.file(
        'voice-raw',
        {
          provider: engine,
          model:
            engine === 'gemini'
              ? MODELS.tts.hostedModel
              : engine === 'clone'
                ? env.CLONE_MODEL
                : engine === 'elevenlabs'
                  ? env.ELEVENLABS_MODEL
                  : MODELS.tts.localModel,
          dtype: MODELS.tts.dtype,
          voice: engineVoice,
          // Part of the key: changing the reference clip is changing the
          // voice, and the cached reading of the old one is no longer it.
          ...(engine === 'clone' || engine === 'elevenlabs' ? { seed: options.seed ?? 0 } : {}),
          ...(engine === 'elevenlabs' ? { stability: stabilityFor(), settings: readSettings() } : {}),
          // The hosted read changed shape -- passages, pace-matched -- and
          // without this every script already read keeps its old single-
          // request audio, drift and all, for as long as the cache lives.
          // v2: passages measured, out-of-character ones read again, all
          // levelled -- and the delivery note is part of what was asked for.
          ...(engine === 'gemini'
            ? { reading: 'passages-v4', style: deliveryNote(character.geminiStyle, character.geminiVoice) }
            : {}),
          text: options.spokenText,
        },
        '.wav',
        async (destination) => {
          await synthesizeToFile(
            options.spokenText,
            engineVoice,
            destination,
            engine,
            options.seed ?? 0,
            options.cloneVoice,
            options.onProgress,
            character.geminiStyle,
          );
        },
      );
      break;
    } catch (error) {
      /**
       * Both hosted engines fall back to the local one rather than taking the
       * video down with them. Cloning is the one that can fail for a reason
       * worth reading -- no reference clip yet -- so it says so on the way
       * past instead of failing silently into a different voice.
       */
      if (engine !== 'gemini' && engine !== 'clone' && engine !== 'elevenlabs') throw error;

      /**
       * A chosen Gemini voice is never swapped for another one mid-run.
       *
       * This fell back to the local engine, and the result was a video in a
       * different voice that read the markdown asterisks aloud and could not
       * say "Megumi" or "Fushiguro" -- rendered, and only noticed on playback.
       * Stopping here costs nothing: the voice comes before the pictures and
       * the render, and every passage already read is kept for the next try.
       */
      if (engine === 'elevenlabs') {
        // The same rule as Gemini's, for the same reason: a chosen voice is
        // never quietly swapped for another one.
        throw new Error(
          `the ElevenLabs voice could not finish reading (${(error as Error).message}). ` +
            'Nothing after the voice was started, and the requests already read are kept.',
        );
      }
      if (engine === 'gemini') {
        throw new Error(
          `the Gemini voice could not finish reading (${(error as Error).message}). ` +
            'Nothing after the voice was started, and the passages already read are kept -- ' +
            'run it again and it picks up where it stopped. Pick a local voice to go without Gemini.',
        );
      }

      /**
       * The local engine is only a safety net where it can read the words.
       *
       * For English it is the right answer: a hosted daily limit should cost
       * you the quality of one video, not the video. For Hindi it is the worst
       * possible one -- the bundled reader has no Hindi voice and an
       * English-only phonemiser, so it would not fail, it would confidently
       * produce forty seconds of an American voice sounding out Devanagari.
       * That is worse than an error, because it renders, uploads and plays.
       */
      const rescue = language(spoken.id).readers.find((candidate) => candidate !== engine);
      if (rescue === undefined || !canRead(spoken.id, 'kokoro')) {
        throw new Error(
          `the ${engine} reader failed (${(error as Error).message}), and nothing else ` +
            `on this machine can read ${spoken.label}.`,
        );
      }
      log.warn(
        `voice: the hosted engine failed (${(error as Error).message}); reading it locally instead`,
      );
      provider = 'kokoro';
    }
  }

  /**
   * A performed read is left as performed: no time-stretch (the pace is asked
   * of the model, which keeps the pitch and the breaths natural), pauses
   * shortened rather than deleted, and its own sample rate.
   */
  const performed = provider === 'elevenlabs';
  const processing = {
    provider,
    voice,
    text: options.spokenText,
    rawKey: raw.key,
    trim: performed ? HOSTED_TRIM_FILTER : TRIM_FILTER,
    tempo: performed ? 1 : tempo,
    rate: performed ? HOSTED_RATE : '24000',
  };

  const narration = await cache.file('voice', processing, '.wav', async (destination) => {
    await ffmpeg([
      '-i', raw.path,
      '-af', performed ? HOSTED_TRIM_FILTER : `${TRIM_FILTER},atempo=${tempo}`,
      '-ar', processing.rate, '-ac', '1', '-c:a', 'pcm_s16le',
      ...BITEXACT,
      '-f', 'wav', destination,
    ]);
  });

  const forAlignment = await cache.file('voice-16k', processing, '.wav', async (destination) => {
    await ffmpeg([
      '-i', narration.path,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      ...BITEXACT,
      '-f', 'wav', destination,
    ]);
  });

  const target = path.join(workDir(options.slug), 'voice.wav');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(narration.path, target);

  const [durationMs, rawDurationMs] = await Promise.all([
    probeDurationMs(narration.path),
    probeDurationMs(raw.path),
  ]);

  return {
    audioPath: target,
    alignPath: forAlignment.path,
    durationMs,
    rawDurationMs,
    provider,
    voiceId: voice,
    character: character.id,
    cached: raw.hit && narration.hit,
  };
}
