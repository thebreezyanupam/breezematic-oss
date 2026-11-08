import { env } from '../config.js';
import { log } from '../log.js';
import { MissingApiKeyError } from './errors.js';
import { priceOf } from '../cost.js';
import { recordSpend } from '../spend.js';

/**
 * Gemini's native text-to-speech.
 *
 * The same key that writes the script reads it. That is most of the argument
 * for this being the default upgrade over the bundled local model: no second
 * account, no second bill, and the quality gap is not subtle — the local engine
 * is a good small model reading words correctly, and this is a read with
 * sentence stress and breath in it.
 *
 * It returns raw PCM rather than a container: signed 16-bit little-endian, one
 * channel, 24 kHz. Everything downstream expects a file it can hand to ffmpeg,
 * so a WAV header goes on here rather than being a thing every caller knows.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 11_000, 20_000, 30_000];

/** What the API emits. Fixed by the service, not a preference. */
export const SAMPLE_RATE = 24_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isConfigured(): boolean {
  return env.GEMINI_API_KEY !== undefined;
}

export function assertConfigured(): void {
  if (!isConfigured()) throw new MissingApiKeyError('GEMINI_API_KEY');
}

/**
 * A RIFF header for raw PCM.
 *
 * Written by hand rather than piped through ffmpeg because it is forty-four
 * bytes of arithmetic and shelling out to describe bytes we already hold would
 * be the slowest part of synthesising a sentence.
 */
export function wavFromPcm(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format 1 = PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate: rate * channels * 2
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type Response = {
  candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
};

/** Network trouble rather than an answer: worth asking again. */
function transient(error: unknown): boolean {
  const e = error as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'AbortError') return true;
  const text = `${e?.message ?? ''} ${e?.cause?.code ?? ''}`;
  return /terminated|fetch failed|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|other side closed/i.test(text);
}

function explain(status: number, body: string): string {
  const detail = /"message"\s*:\s*"([^"]{0,200})"/.exec(body)?.[1] ?? '';
  if (status === 400 && /voice/i.test(detail)) return `the voice was rejected: ${detail}`;
  if (status === 401 || status === 403) return 'GEMINI_API_KEY was rejected for speech';
  if (status === 429) return 'the speech provider is rate limiting';
  return `speech provider responded ${status}${detail === '' ? '' : `: ${detail}`}`;
}

/**
 * One passage read aloud, as WAV bytes.
 *
 * `style` is prepended as a direction rather than sent as a parameter, which is
 * how this model takes delivery notes: the text it is given is both the words
 * and the instruction, and a line like "Read this calmly:" changes the read.
 * It is dropped from the audio itself, so it costs a few tokens and nothing else.
 */
export async function speak(options: {
  text: string;
  voice: string;
  model: string;
  style?: string;
}): Promise<Buffer> {
  assertConfigured();

  const prompt =
    options.style === undefined || options.style.trim() === ''
      ? options.text
      : `${options.style.trim()}\n\n${options.text}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } },
      },
    },
  });

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(
        `${API}/${options.model}:generateContent?key=${env.GEMINI_API_KEY ?? ''}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        const wait = RETRY_DELAYS_MS[attempt];
        if (retryable && wait !== undefined) {
          log.debug(`gemini-tts: ${response.status}, waiting ${wait}ms`);
          await sleep(wait);
          continue;
        }
        throw new Error(explain(response.status, text));
      }

      const parsed = (await response.json()) as Response;
      const encoded = parsed.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (typeof encoded !== 'string' || encoded === '') {
        throw new Error('speech provider returned no audio');
      }

      /**
       * The token counts were being read off the wire and thrown away, which is
       * how the hosted reader managed to be the most expensive thing per second
       * in the whole pipeline without appearing in any total.
       */
      const inputTokens = parsed.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = parsed.usageMetadata?.candidatesTokenCount ?? 0;
      recordSpend({
        kind: 'voice',
        model: options.model,
        detail: `${outputTokens} audio tokens`,
        usd: priceOf(options.model, inputTokens, outputTokens),
      });

      return wavFromPcm(Buffer.from(encoded, 'base64'));
    } catch (error) {
      /**
       * A dropped connection is retried like a 503.
       *
       * It was not: "terminated" -- the connection closing while the audio
       * was still arriving -- went straight up, the whole read was abandoned
       * on its first passage, and the video was narrated by the local engine
       * in a different voice that could not say the names.
       */
      const wait = RETRY_DELAYS_MS[attempt];
      if (wait !== undefined && transient(error)) {
        log.info(`gemini-tts: connection dropped (${(error as Error).message}); retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
