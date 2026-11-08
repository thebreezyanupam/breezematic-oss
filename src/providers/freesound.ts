import fs from 'node:fs';
import { cache } from '../cache.js';
import { env } from '../config.js';
import { log } from '../log.js';

/**
 * Music from Freesound, filtered to CC0 and nothing else.
 *
 * The licence filter is the whole design. Freesound carries CC0, CC-BY and
 * CC-BY-NC side by side, and the last of those is unusable in a monetised
 * video while looking identical in a search result. CC-BY is usable but puts a
 * per-track credit obligation on every upload, which is a promise somebody has
 * to keep forty videos later. CC0 asks for nothing, so CC0 is the only thing
 * this asks for -- narrower than it could be, and the narrowness is the point.
 *
 * What comes back is the preview rather than the original. That is deliberate
 * too: the original needs an OAuth2 round trip and a user consent screen,
 * while the preview is a 128kbps mp3 available on the API key alone. Under a
 * voice mastered to -16 LUFS at a bed level of -26dB, the difference between
 * 128kbps and lossless is not audible, and it is the difference between a
 * setting somebody can turn on and a sign-in flow they have to complete.
 */

const API = 'https://freesound.org/apiv2';
const TIMEOUT_MS = 30_000;

/** Long enough to loop without the seam arriving every few seconds. */
const MIN_SECONDS = 45;
/** Past this and the download is large for no gain -- it is looped anyway. */
const MAX_SECONDS = 420;

export type Track = {
  id: number;
  name: string;
  /** Seconds. */
  duration: number;
  /** Always 'Creative Commons 0' -- nothing else is accepted. */
  licence: string;
  url: string;
  /** Where the file landed on disk. */
  path: string;
};

export function isConfigured(): boolean {
  return env.FREESOUND_API_KEY !== undefined && env.FREESOUND_API_KEY !== '';
}

function requireKey(): string {
  const key = env.FREESOUND_API_KEY;
  if (key === undefined || key === '') {
    // The shared error already says where .env is; this adds the one thing it
    // cannot know -- which page issues this particular key.
    throw new Error(
      'FREESOUND_API_KEY is not set. Make an account at freesound.org, create a ' +
        'credential at freesound.org/apiv2/apply, and put the key in .env.',
    );
  }
  return key;
}

type SearchResult = {
  results?: {
    id?: number;
    name?: string;
    duration?: number;
    license?: string;
    url?: string;
    previews?: { 'preview-hq-mp3'?: string };
  }[];
};

/**
 * Turns a direction into search terms.
 *
 * Deliberately crude. A direction is written for a human -- "cold, clinical, a
 * lecture theatre at night" -- and Freesound's index is tags on uploads, so the
 * useful move is to keep the adjectives, drop the scene-setting, and add the
 * words that mean "this is a bed and not a sound effect". Sending the sentence
 * whole returns doorbells.
 */
function termsFrom(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 8);

  return [...new Set(words)].join(' ');
}

/**
 * Finds a bed matching a description, downloads it, and returns where it is.
 *
 * Seeded rather than always-first: two essays with the same direction should
 * not open on the same track, and a re-render of one essay must not change its
 * music. Picking by seed from the top results gives both.
 */
export async function findMusic(options: {
  description: string;
  seed: number;
  minSeconds?: number;
}): Promise<Track | null> {
  const key = requireKey();
  const terms = termsFrom(options.description);
  if (terms === '') return null;

  const query = new URLSearchParams({
    query: `${terms} ambient instrumental`,
    filter:
      `license:"Creative Commons 0" ` +
      `duration:[${options.minSeconds ?? MIN_SECONDS} TO ${MAX_SECONDS}]`,
    fields: 'id,name,duration,license,url,previews',
    page_size: '30',
    token: key,
  });

  const response = await fetch(`${API}/search/text/?${query.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      response.status === 401
        ? 'Freesound rejected the API key'
        : `Freesound returned ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`,
    );
  }

  const body = (await response.json()) as SearchResult;
  const usable = (body.results ?? []).filter(
    (
      entry,
    ): entry is {
      id: number;
      name: string;
      duration: number;
      license: string;
      url: string;
      previews: { 'preview-hq-mp3': string };
    } =>
      typeof entry.id === 'number' &&
      typeof entry.name === 'string' &&
      typeof entry.duration === 'number' &&
      typeof entry.previews?.['preview-hq-mp3'] === 'string' &&
      // Belt and braces: the filter above should make this impossible, but a
      // licence check is the one thing worth doing twice.
      /creative commons 0|CC0/i.test(entry.license ?? ''),
  );

  if (usable.length === 0) {
    log.warn(`music: nothing CC0 on Freesound for "${terms}"`);
    return null;
  }

  const pick = usable[Math.abs(options.seed) % usable.length]!;
  log.info(`music: "${pick.name}" (${Math.round(pick.duration)}s, CC0) from Freesound`);

  const { path: file } = await cache.file(
    'freesound-music',
    { id: pick.id },
    '.mp3',
    async (destination) => {
      const audio = await fetch(pick.previews['preview-hq-mp3'], {
        headers: { Authorization: `Token ${key}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!audio.ok) throw new Error(`could not download the preview (${audio.status})`);
      fs.writeFileSync(destination, Buffer.from(await audio.arrayBuffer()));
    },
  );

  return {
    id: pick.id,
    name: pick.name,
    duration: pick.duration,
    licence: 'Creative Commons 0',
    url: pick.url,
    path: file,
  };
}
