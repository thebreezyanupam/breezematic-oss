import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config.js';
import { log } from '../log.js';
import { recordSpend } from '../spend.js';
import { MissingApiKeyError } from './errors.js';

/**
 * Voice cloning: Chatterbox, on the fal account that already draws the
 * pictures.
 *
 * The obvious route was a local model, to sit beside Kokoro, and it is the
 * wrong one twice over. The good open cloning models are PyTorch, where Kokoro
 * runs here because someone built it for ONNX — so "local" would mean shipping
 * a Python runtime and torch alongside a Node CLI. And the best-known of them,
 * XTTS-v2, is CPML: non-commercial, which rules it out of something that gets
 * sold, however well it performs.
 *
 * Chatterbox is Resemble AI's, MIT-licensed, and does this zero-shot: a few
 * seconds of reference speech in the same request as the text, no training step
 * and nothing to store on their side. fal hosts it, which means the same key,
 * the same endpoint and the same error handling as FLUX -- no second vendor,
 * no second bill.
 *
 * The reference clip goes inline as a data URI. fal fetches file inputs by URL
 * and a file on this machine has no URL, so the alternative was uploading to
 * fal's storage first and holding an id -- a round trip, a lifetime to manage,
 * and somebody's voice sitting on a server after they stopped using the
 * feature. Measured: a 7-second 24kHz mono clip is 328KB, 438KB encoded, and
 * the request is accepted and answered in about eleven seconds.
 */

const TIMEOUT_MS = 180_000;
const RETRY_DELAYS_MS = [2_000, 6_000, 15_000];

/** How much of a reference clip is worth sending. */
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isConfigured(): boolean {
  return env.FLUX_API_KEY !== undefined;
}

const MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
};

function asDataUri(file: string): string {
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_REFERENCE_BYTES) {
    throw new Error(
      `the reference clip is ${(bytes.length / 1024 / 1024).toFixed(1)}MB; ` +
        'a few seconds of clean speech is all this needs',
    );
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'audio/wav';
  return `data:${type};base64,${bytes.toString('base64')}`;
}

type FalResponse = {
  audio?: { url?: string };
  detail?: unknown;
};

function explain(status: number, body: string): string {
  if (status === 401 || status === 403) return 'the fal key was rejected for speech';
  if (status === 422) return `the speech request was rejected: ${body.slice(0, 200)}`;
  if (status === 429) return 'the speech provider is rate limiting';
  return `speech provider responded ${status}${body === '' ? '' : `: ${body.slice(0, 160)}`}`;
}

/**
 * One passage, read in the cloned voice.
 *
 * `seed` is passed through because everything else in this pipeline is
 * reproducible from one, and a voice that came back different on every render
 * would be the only part that was not.
 */
export async function speak(options: {
  text: string;
  reference: string;
  seed: number;
  exaggeration?: number;
  temperature?: number;
}): Promise<Buffer> {
  if (!isConfigured()) throw new MissingApiKeyError('FLUX_API_KEY');

  const body = JSON.stringify({
    text: options.text,
    audio_url: asDataUri(options.reference),
    seed: options.seed,
    exaggeration: options.exaggeration ?? env.CLONE_EXAGGERATION,
    temperature: options.temperature ?? env.CLONE_TEMPERATURE,
  });

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${env.FLUX_ENDPOINT}/${env.CLONE_MODEL}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${env.FLUX_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const wait = RETRY_DELAYS_MS[attempt];
      if ((res.status === 429 || res.status >= 500) && wait !== undefined) {
        log.debug(`chatterbox: ${res.status}, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw new Error(explain(res.status, text));
    }

    /**
     * Billed from what fal says it billed, not from a guess about length.
     * The response carries the count it charged for, so the only estimate left
     * is the price of a unit -- which is a number on an invoice rather than
     * something this code has to infer.
     */
    const units = Number(res.headers.get('x-fal-billable-units') ?? '1');
    recordSpend({
      kind: 'voice',
      model: env.CLONE_MODEL,
      detail: `${Number.isFinite(units) ? units : 1} unit(s), ${options.text.split(/\s+/).length} words`,
      usd: (Number.isFinite(units) ? units : 1) * env.CLONE_USD_PER_UNIT,
    });

    const parsed = (await res.json()) as FalResponse;
    const url = parsed.audio?.url;
    if (typeof url !== 'string' || url === '') {
      throw new Error('the speech provider returned no audio');
    }

    const audio = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!audio.ok) throw new Error(`could not fetch the generated audio (${audio.status})`);
    return Buffer.from(await audio.arrayBuffer());
  }
}
