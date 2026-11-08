import { env, imageSteps } from '../config.js';
import { log } from '../log.js';
import { MissingApiKeyError } from './errors.js';
import { recordSpend } from '../spend.js';

/**
 * FLUX.1 [schnell] through fal.ai's synchronous endpoint. Black Forest Labs'
 * own API starts at [dev] and costs an order of magnitude more per image;
 * schnell only exists on the partner hosts, and fal is the one that answers in
 * a single request rather than a submit-then-poll queue.
 *
 * Nothing here knows what the picture is for. The stage above decides how many
 * to make and what to say in the prompt.
 */

export type FluxRequest = {
  prompt: string;
  seed: number;
  width: number;
  height: number;
};

export type FluxResult = {
  bytes: Buffer;
  contentType: string;
  model: string;
  seed: number;
};

const TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 11_000];
/** fal's seed is a uint32; ours is already one, but a sheet can carry anything. */
const UINT32 = 4_294_967_296;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checked before the pipeline spends a minute on narration it would then have
 * no pictures for, rather than at the moment of the first request.
 */
export function isConfigured(): boolean {
  return env.FLUX_API_KEY !== undefined;
}

export function assertConfigured(): void {
  if (!isConfigured()) throw new MissingApiKeyError('FLUX_API_KEY');
}

function endpoint(): string {
  return `${env.FLUX_ENDPOINT.replace(/\/+$/, '')}/${env.FLUX_MODEL.replace(/^\/+/, '')}`;
}

/**
 * The states worth naming. A locked account and a rejected key both come back
 * as an HTTP status and a blob of JSON, and "responded 403" sends whoever reads
 * the log looking in the wrong place. Nothing here names the service: the log
 * goes to the operator, but the same message reaches the browser.
 */
function explain(status: number, body: string): string {
  const detail = /"detail"\s*:\s*"([^"]{0,200})"/.exec(body)?.[1] ?? '';

  if (status === 401 || status === 403) {
    if (/top_?up|balance|credit|insufficient/i.test(detail)) {
      return 'the image account is out of credit — top it up, or set the picture source back to stock';
    }
    if (/lock/i.test(detail)) {
      return `the image account is locked (${detail})`;
    }
    return 'FLUX_API_KEY was rejected — check it is the whole key, id and secret either side of the colon';
  }
  if (status === 402) {
    return 'the image account is out of credit — top it up, or set the picture source back to stock';
  }
  if (status === 422) {
    return `the image request was refused${detail === '' ? '' : `: ${detail}`}`;
  }
  if (status === 429) return 'the image provider is rate limiting; slowing down';

  return `image provider responded ${status}${detail === '' ? '' : `: ${detail}`}`;
}

type FalResponse = {
  images?: { url?: string; content_type?: string }[];
  seed?: number;
  detail?: unknown;
};

async function post(request: FluxRequest): Promise<FalResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Key ${env.FLUX_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        prompt: request.prompt,
        seed: Math.abs(Math.trunc(request.seed)) % UINT32,
        image_size: { width: request.width, height: request.height },
        num_inference_steps: imageSteps(),
        num_images: 1,
        output_format: 'jpeg',
        enable_safety_checker: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(explain(response.status, body)) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return (await response.json()) as FalResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** Inline data URIs and hosted URLs both come back in the same field. */
async function bytesOf(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (data !== null) {
    const payload = data[3] ?? '';
    return {
      bytes: Buffer.from(payload, data[2] === undefined ? 'utf8' : 'base64'),
      contentType: data[1] ?? 'image/jpeg',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`image download responded ${response.status}`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'image/jpeg',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function generateImage(request: FluxRequest): Promise<FluxResult> {
  assertConfigured();
  log.debug(
    `flux request model=${env.FLUX_MODEL} seed=${request.seed} steps=${imageSteps()} ` +
      `size=${request.width}x${request.height}`,
  );

  for (let attempt = 0; ; attempt++) {
    let body: FalResponse;
    try {
      body = await post(request);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const retryable = status === 429 || (status !== undefined && status >= 500);
      const wait = RETRY_DELAYS_MS[attempt];
      if (!retryable || wait === undefined) throw error;
      log.debug(`flux: ${status}, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }

    const url = body.images?.[0]?.url;
    if (typeof url !== 'string' || url === '') {
      throw new Error('image provider returned no image');
    }
    const { bytes, contentType } = await bytesOf(url);
    // One image, one charge, at the moment the provider actually drew it.
    recordSpend({
      kind: 'pictures',
      model: env.FLUX_MODEL,
      detail: `1 image ${request.width}x${request.height}`,
      usd: env.FLUX_USD_PER_IMAGE,
    });
    return {
      bytes,
      contentType: body.images?.[0]?.content_type ?? contentType,
      model: env.FLUX_MODEL,
      seed: body.seed ?? request.seed,
    };
  }
}
