import sharp from 'sharp';
import { env } from '../config.js';
import { log } from '../log.js';
import { MissingApiKeyError } from './errors.js';
import type { FluxRequest, FluxResult } from './flux.js';

/**
 * Generated pictures for free: FLUX.1 [schnell] on Cloudflare Workers AI.
 *
 * Same model family as the paid path (fal), different host. Cloudflare's free
 * plan includes 10,000 "neurons" a day, and one 1024x1024 schnell picture at
 * six steps costs about 77 of them -- roughly 130 pictures a day at no cost,
 * no card needed, no watermark. FLUX.1 schnell is Apache-2.0, so the pictures
 * are the user's to use.
 *
 * The model draws a square and takes no size, so the picture is cover-cropped
 * to the frame asked for and resized to it. A vertical frame keeps the middle
 * 56% of the square, which is where the prompt's subject is.
 *
 * Beyond the daily allowance a free account is refused rather than billed, so
 * a 429 here is "come back tomorrow", and the run renders on with stock.
 */

export const CLOUDFLARE_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const STEPS = 6;
const TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [2_000, 6_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isConfigured(): boolean {
  return env.CLOUDFLARE_ACCOUNT_ID !== undefined && env.CLOUDFLARE_API_TOKEN !== undefined;
}

export function assertConfigured(): void {
  if (env.CLOUDFLARE_ACCOUNT_ID === undefined) throw new MissingApiKeyError('CLOUDFLARE_ACCOUNT_ID');
  if (env.CLOUDFLARE_API_TOKEN === undefined) throw new MissingApiKeyError('CLOUDFLARE_API_TOKEN');
}

export async function generateImage(request: FluxRequest): Promise<FluxResult> {
  assertConfigured();
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`;
  // The prompt limit is 2,048 characters; the prompt writer stays well under it.
  const body = JSON.stringify({ prompt: request.prompt.slice(0, 2048), steps: STEPS, seed: request.seed % 4_294_967_296 });

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 300);
      const wait = RETRY_DELAYS_MS[attempt];
      // 429 is the daily allowance as often as a burst; one short retry covers a burst.
      if ((response.status === 429 || response.status >= 500) && wait !== undefined) {
        log.debug(`cloudflare: ${response.status}, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (response.status === 429) throw new Error('Cloudflare free allowance used up for today (it resets at 00:00 UTC)');
      if (response.status === 401 || response.status === 403) throw new Error('Cloudflare refused the token: it needs the "Workers AI" permission');
      throw new Error(`Cloudflare Workers AI ${response.status}: ${text}`);
    }
    const json = (await response.json()) as { result?: { image?: string }; success?: boolean; errors?: { message?: string }[] };
    const b64 = json.result?.image;
    if (typeof b64 !== 'string' || b64 === '') {
      throw new Error(`Cloudflare returned no image${json.errors?.[0]?.message ? `: ${json.errors[0].message}` : ''}`);
    }
    const square = Buffer.from(b64, 'base64');
    const bytes = await sharp(square)
      .resize(request.width, request.height, { fit: 'cover', position: 'attention', kernel: 'lanczos3' })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    return { bytes, contentType: 'image/jpeg', model: CLOUDFLARE_IMAGE_MODEL, seed: request.seed };
  }
}
