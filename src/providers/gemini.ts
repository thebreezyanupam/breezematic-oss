import { GoogleGenAI } from '@google/genai';
import { env } from '../config.js';
import { log } from '../log.js';
import { MissingApiKeyError } from './errors.js';
import { priceOf } from '../cost.js';
import { recordSpend } from '../spend.js';

export type GeminiRequest = {
  model: string;
  systemInstruction: string;
  prompt: string;
  temperature: number;
  seed: number;
  maxOutputTokens: number;
  responseSchema?: Record<string, unknown>;
  /** Pictures shown to the model with the prompt, for a request that has to look. */
  images?: readonly { bytes: Buffer; mime: string }[];
};

export type GeminiResponse = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export { MissingApiKeyError } from './errors.js';

const INT32_RANGE = 2_147_483_648;

/**
 * Our seeds are uint32 — mulberry32 wants the full range, and hashString()
 * returns one. Gemini's generation_config.seed is an int32 and rejects anything
 * above 2^31-1, so fold the top half down. Deterministic, and it leaves the seed
 * recorded in the beat sheet and the cache key untouched.
 */
export function toInt32Seed(seed: number): number {
  return Math.abs(Math.trunc(seed)) % INT32_RANGE;
}

let client: GoogleGenAI | undefined;
let clientKey: string | undefined;

function getClient(): GoogleGenAI {
  const apiKey = env.GEMINI_API_KEY;
  if (apiKey === undefined) throw new MissingApiKeyError('GEMINI_API_KEY');
  // The key can be changed from Settings while the app runs.
  if (client === undefined || clientKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

export async function generate(request: GeminiRequest): Promise<GeminiResponse> {
  const ai = getClient();

  log.debug(
    `gemini request model=${request.model} seed=${request.seed}->${toInt32Seed(request.seed)} temp=${request.temperature}`,
  );

  const response = await ai.models.generateContent({
    model: request.model,
    contents:
      request.images === undefined || request.images.length === 0
        ? request.prompt
        : [
            {
              role: 'user',
              parts: [
                ...request.images.map((image) => ({
                  inlineData: { mimeType: image.mime, data: image.bytes.toString('base64') },
                })),
                { text: request.prompt },
              ],
            },
          ],
    config: {
      systemInstruction: request.systemInstruction,
      temperature: request.temperature,
      seed: toInt32Seed(request.seed),
      maxOutputTokens: request.maxOutputTokens,
      responseMimeType: 'application/json',
      ...(request.responseSchema === undefined ? {} : { responseSchema: request.responseSchema }),
    },
  });

  const text = response.text;
  if (text === undefined || text.trim().length === 0) {
    const reason = response.candidates?.[0]?.finishReason ?? 'unknown';
    throw new Error(`gemini returned no text (finishReason=${reason})`);
  }

  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens =
    (response.usageMetadata?.candidatesTokenCount ?? 0) +
    (response.usageMetadata?.thoughtsTokenCount ?? 0);

  /**
   * Recorded here rather than by the stages that call this, so a stage cannot
   * be added or changed without its cost being counted. A cached stage never
   * reaches this function, which is exactly right: it did not cost anything.
   */
  recordSpend({
    kind: 'script',
    model: request.model,
    detail: `${round(inputTokens)} in / ${round(outputTokens)} out`,
    usd: priceOf(request.model, inputTokens, outputTokens),
  });

  return {
    text,
    model: response.modelVersion ?? request.model,
    inputTokens,
    outputTokens,
  };
}

/** 2,140 reads as 2.1k. Token counts are estimates; the digits are noise. */
function round(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}
