import { env } from '../config.js';
import { log } from '../log.js';
import { recordSpend } from '../spend.js';

/**
 * Pictures drawn with a reference: Gemini's image model.
 *
 * FLUX schnell, which draws everything else, takes words and nothing else, so
 * a character stays consistent only as far as a description can hold them --
 * hair and clothes, roughly; a face, not at all. This model can be shown a
 * picture of the character and asked to draw that same person somewhere new,
 * which is the only way a face survives across forty panels.
 *
 * Measured before it was wired in: a drawn Gregor put into a train carriage
 * and then into a bed came back with the same face, the same hair falling over
 * the same forehead, and the ink stains on his vest in the same places. The
 * insect, redrawn climbing a wall, kept its shell, its orange streaks and its
 * legs. Neither survives a description alone.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
export const IMAGE_MODEL = 'gemini-2.5-flash-image';
const TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [2_000, 6_000, 14_000];

/**
 * Per million tokens. An image is 1,290 output tokens, so about four cents --
 * roughly thirteen times a schnell frame, which is why this is only used where
 * a character has to be recognisable.
 */
const USD_PER_M_INPUT = 0.3;
const USD_PER_M_OUTPUT = 30;

/** What one picture costs, for running totals that do not read the ledger. */
export const APPROX_USD_PER_IMAGE = 0.039;

export type Reference = { bytes: Buffer; mime: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function canDrawWithReferences(): boolean {
  return env.GEMINI_API_KEY !== undefined;
}

export async function drawImage(options: {
  prompt: string;
  references?: readonly Reference[];
  aspectRatio: '16:9' | '9:16' | '3:4' | '1:1';
  /** What it was for, in the spend ledger. */
  detail: string;
}): Promise<{ bytes: Buffer; mime: string }> {
  const parts = [
    ...(options.references ?? []).map((ref) => ({
      inlineData: { mimeType: ref.mime, data: ref.bytes.toString('base64') },
    })),
    { text: options.prompt },
  ];
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: options.aspectRatio },
    },
  });

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(
        `${API}/${IMAGE_MODEL}:generateContent?key=${env.GEMINI_API_KEY ?? ''}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal },
      );
      const parsed = (await response.json().catch(() => ({}))) as {
        candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        error?: { message?: string };
      };

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const wait = RETRY_DELAYS_MS[attempt];
        if (retryable && wait !== undefined) {
          log.debug(`gemini-image: ${response.status}, waiting ${wait}ms`);
          await sleep(wait);
          continue;
        }
        throw new Error(`image model ${response.status}: ${parsed.error?.message ?? 'no detail'}`);
      }

      const image = parsed.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data);
      if (image?.inlineData?.data === undefined) {
        // A refusal comes back as a 200 with text and no picture.
        throw new Error('image model returned no picture');
      }

      const input = parsed.usageMetadata?.promptTokenCount ?? 0;
      const output = parsed.usageMetadata?.candidatesTokenCount ?? 0;
      recordSpend({
        kind: 'pictures',
        model: IMAGE_MODEL,
        detail: options.detail,
        usd: (input * USD_PER_M_INPUT + output * USD_PER_M_OUTPUT) / 1_000_000,
      });

      return {
        bytes: Buffer.from(image.inlineData.data, 'base64'),
        mime: image.inlineData.mimeType ?? 'image/png',
      };
    } catch (error) {
      const wait = RETRY_DELAYS_MS[attempt];
      if ((error as Error).name === 'AbortError' && wait !== undefined) {
        log.debug(`gemini-image: timed out, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
