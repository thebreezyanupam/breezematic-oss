import { env } from '../config.js';
import { log } from '../log.js';
import { MissingApiKeyError } from './errors.js';
import { recordSpend } from '../spend.js';

/**
 * ElevenLabs text-to-speech.
 *
 * Here for one reason above all: the voice stays the voice. Gemini has no
 * fixed identity -- every passage is a fresh performance of "Fenrir", and a
 * measured Emu War read swung seven semitones across its length. An
 * ElevenLabs voice is an id, the same speaker on every request, so a long read
 * made of several requests sounds like one person reading.
 *
 * It returns MP3; the caller turns it into WAV with the rest of the audio
 * work, because ffmpeg is already there and a decoder here would be the only
 * one in the codebase.
 */

const API = 'https://api.elevenlabs.io/v1';
const TIMEOUT_MS = 180_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 11_000, 20_000];

/** Per request, with room under the model's own ceiling (v3 takes 5,000). */
export const MAX_CHARS = 3_500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isConfigured(): boolean {
  return env.ELEVENLABS_API_KEY !== undefined;
}

export function assertConfigured(): void {
  if (!isConfigured()) throw new MissingApiKeyError('ELEVENLABS_API_KEY');
}

function explain(status: number, body: string): string {
  const detail = /"message"\s*:\s*"([^"]{0,240})"/.exec(body)?.[1] ?? /"status"\s*:\s*"([^"]{0,80})"/.exec(body)?.[1] ?? '';
  if (status === 401) return `ELEVENLABS_API_KEY was rejected${detail === '' ? '' : `: ${detail}`}`;
  if (status === 402 || /quota|credits/i.test(detail)) return `out of ElevenLabs credits${detail === '' ? '' : `: ${detail}`}`;
  if (status === 404) return 'that ElevenLabs voice does not exist on this account';
  if (status === 429) return 'ElevenLabs is rate limiting';
  return `ElevenLabs responded ${status}${detail === '' ? '' : `: ${detail}`}`;
}

/** The stability a read is asked for: the setting if there is one, else the model's natural. */
export function stabilityFor(model: string = env.ELEVENLABS_MODEL): number {
  if (env.ELEVENLABS_STABILITY !== undefined) {
    // v3 takes only three values; snap to the nearest rather than be refused.
    return model.startsWith('eleven_v3') ? Math.round(env.ELEVENLABS_STABILITY * 2) / 2 : env.ELEVENLABS_STABILITY;
  }
  // 0.45 on the others: enough variation to sound spoken, not so much that a
  // sentence changes mood halfway through.
  return model.startsWith('eleven_v3') ? 0.5 : 0.45;
}

/**
 * Everything about the read that is not the text, in one place, so the cache
 * key and the request cannot disagree on what was asked for.
 */
export function readSettings(model: string = env.ELEVENLABS_MODEL): Record<string, number | boolean> {
  if (model.startsWith('eleven_v3')) {
    return { stability: stabilityFor(model), similarity_boost: 0.8 };
  }
  return {
    stability: stabilityFor(model),
    /**
     * 0.75, not 0.95. Pushed that high the model reproduces the sample's
     * artefacts along with its timbre -- the hiss, the room, the clicks --
     * and the read comes out sounding processed. 0.75 is the provider's own
     * recommendation and keeps the voice without its recording.
     */
    similarity_boost: 0.75,
    style: env.ELEVENLABS_STYLE,
    use_speaker_boost: true,
    speed: env.ELEVENLABS_SPEED,
  };
}

/** One request's worth of text, read aloud, as MP3 bytes. */
export async function speak(options: {
  text: string;
  voiceId: string;
  model?: string;
  /** Same seed, same read: a re-run of an unchanged passage sounds the same. */
  seed?: number;
  /**
   * The text either side of this request, when a read is split. Without it
   * every request starts as if it were the opening line and ends as if it
   * were the last, and the seams are audible as a change of breath.
   */
  previousText?: string;
  nextText?: string;
}): Promise<Buffer> {
  assertConfigured();
  const model = options.model ?? env.ELEVENLABS_MODEL;
  const body = JSON.stringify({
    text: options.text,
    model_id: model,
    /**
     * v3 takes stability as one of three settings: 0 creative, 0.5 natural,
     * 1 robust. Natural is the one that still acts a line -- a punchline
     * lands, a sarcastic aside sounds sarcastic -- without the creative
     * setting's habit of wandering off the voice, which is the thing this
     * provider was brought in to stop.
     */
    voice_settings: readSettings(model),
    ...(options.seed === undefined ? {} : { seed: options.seed >>> 0 }),
    // v3 does not take request context; the others use it to carry the read across a seam.
    ...(model.startsWith('eleven_v3') || options.previousText === undefined ? {} : { previous_text: options.previousText }),
    ...(model.startsWith('eleven_v3') || options.nextText === undefined ? {} : { next_text: options.nextText }),
  });

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(
        `${API}/text-to-speech/${encodeURIComponent(options.voiceId)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': env.ELEVENLABS_API_KEY ?? '',
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body,
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const wait = RETRY_DELAYS_MS[attempt];
        if ((response.status === 429 || response.status >= 500) && wait !== undefined) {
          log.debug(`elevenlabs: ${response.status}, waiting ${wait}ms`);
          await sleep(wait);
          continue;
        }
        throw new Error(explain(response.status, text));
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length < 1000) throw new Error('ElevenLabs returned no audio');
      // Billed per character. The rate is the list price, so on a plan with
      // characters included this is what the read would cost beyond them.
      recordSpend({
        kind: 'voice',
        model,
        detail: `${options.text.length} characters`,
        usd: (options.text.length / 1000) * env.ELEVENLABS_USD_PER_1K_CHARS,
      });
      return audio;
    } catch (error) {
      const e = error as { name?: string; message?: string };
      const wait = RETRY_DELAYS_MS[attempt];
      if (wait !== undefined && (e.name === 'AbortError' || /fetch failed|terminated|ECONNRESET|ETIMEDOUT|socket/i.test(e.message ?? ''))) {
        log.info(`elevenlabs: connection dropped (${e.message}); retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export type ElevenVoice = { id: string; name: string; category: string; gender: string; accent: string; description: string };

let listed: { at: number; voices: ElevenVoice[] } | null = null;

/** The voices this account can use: its own clones and designs first, then the premade ones. */
export async function listVoices(): Promise<ElevenVoice[]> {
  if (!isConfigured()) return [];
  if (listed !== null && Date.now() - listed.at < 5 * 60_000) return listed.voices;
  const response = await fetch(`${API.replace('/v1', '/v2')}/voices?page_size=100`, {
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY ?? '' },
  });
  if (!response.ok) throw new Error(explain(response.status, await response.text().catch(() => '')));
  const body = (await response.json()) as {
    voices?: { voice_id: string; name: string; category?: string; labels?: Record<string, string> }[];
  };
  const own = (category: string): number => (category === 'premade' ? 1 : 0);
  const voices = (body.voices ?? [])
    .map((voice) => ({
      id: voice.voice_id,
      name: voice.name,
      category: voice.category ?? '',
      gender: voice.labels?.['gender'] ?? '',
      accent: voice.labels?.['accent'] ?? '',
      description: voice.labels?.['descriptive'] ?? voice.labels?.['description'] ?? '',
    }))
    .sort((a, b) => own(a.category) - own(b.category) || a.name.localeCompare(b.name));
  listed = { at: Date.now(), voices };
  return voices;
}
