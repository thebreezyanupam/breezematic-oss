import fs from 'node:fs';
import path from 'node:path';
import { KEYS_FILE, UNSAVED_ENV, env } from './config.js';

/**
 * The keys the app can be given from its own Settings screen.
 *
 * Every one is optional: with none of them the app still writes nothing for
 * you but renders, voices locally and mixes. Each key switches a feature on,
 * and the screen says which, so nobody has to read the code to know what a key
 * is for or open a text editor to add one.
 *
 * They are kept in .local/keys.json -- not .env, which people edit by hand and
 * sometimes paste into issues, and not .cache, which `cache clear` empties.
 * The file is gitignored and owner-only. A key in the real environment still
 * wins over it, and a key saved here wins over .env (config.ts loads them in
 * that order), so what the screen shows is what the app uses.
 */

export type KeyField = {
  name: string;
  label: string;
  /** What switching it on gives you. */
  enables: string;
  /** Where to get one. */
  url: string;
  secret: boolean;
  placeholder: string;
  group: 'services' | 'accounts';
};

export const KEY_FIELDS = [
  {
    name: 'GEMINI_API_KEY',
    label: 'Google Gemini',
    enables: 'Writes scripts, picks pictures and graphics, and the Gemini voices. Has a free tier.',
    url: 'https://aistudio.google.com/apikey',
    secret: true,
    placeholder: 'AIza…',
    group: 'services',
  },
  {
    name: 'PEXELS_API_KEY',
    label: 'Pexels',
    enables: 'Free stock video footage and reference clips. Free.',
    url: 'https://www.pexels.com/api/',
    secret: true,
    placeholder: 'Pexels API key',
    group: 'services',
  },
  {
    name: 'FREESOUND_API_KEY',
    label: 'Freesound',
    enables: 'Downloads the sound-effect library. Free.',
    url: 'https://freesound.org/apiv2/apply',
    secret: true,
    placeholder: 'Freesound API key',
    group: 'services',
  },
  {
    name: 'ELEVENLABS_API_KEY',
    label: 'ElevenLabs',
    enables: 'The most expressive narration voice. Paid per character.',
    url: 'https://elevenlabs.io/app/settings/api-keys',
    secret: true,
    placeholder: 'sk_…',
    group: 'services',
  },
  {
    name: 'FLUX_API_KEY',
    label: 'fal.ai',
    enables: 'Generated pictures, and narration in your own cloned voice. Paid per use.',
    url: 'https://fal.ai/dashboard/keys',
    secret: true,
    placeholder: 'fal key',
    group: 'services',
  },
  {
    name: 'CLOUDFLARE_ACCOUNT_ID',
    label: 'Cloudflare account ID',
    enables: 'Free generated pictures, about 130 a day on the free plan. Shown on the Workers AI page of the dashboard.',
    url: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
    secret: false,
    placeholder: '32-character account ID',
    group: 'services',
  },
  {
    name: 'CLOUDFLARE_API_TOKEN',
    label: 'Cloudflare Workers AI token',
    enables: 'The token for free generated pictures. Create it with the "Workers AI" template.',
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    secret: true,
    placeholder: 'API token',
    group: 'services',
  },
  {
    name: 'SUPABASE_URL',
    label: 'Supabase project URL',
    enables: 'Optional. Sign-in, and preferences and project history synced between your computers.',
    url: 'https://supabase.com/dashboard/project/_/settings/api',
    secret: false,
    placeholder: 'https://your-project.supabase.co',
    group: 'accounts',
  },
  {
    name: 'SUPABASE_ANON_KEY',
    label: 'Supabase publishable (anon) key',
    enables: 'The public key from the same page. Never the secret or service_role key.',
    url: 'https://supabase.com/dashboard/project/_/settings/api',
    secret: true,
    placeholder: 'sb_publishable_… or eyJ…',
    group: 'accounts',
  },
] as const;

export type KeyName = (typeof KEY_FIELDS)[number]['name'];

const NAMES = new Set<string>(KEY_FIELDS.map((field) => field.name));
export const isKeyName = (value: unknown): value is KeyName => typeof value === 'string' && NAMES.has(value);

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

/** Everything saved from the screen, by name. */
export function readSavedKeys(): Partial<Record<KeyName, string>> {
  if (!fs.existsSync(KEYS_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) as Record<string, unknown>;
    const keys: Partial<Record<KeyName, string>> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (isKeyName(name) && typeof value === 'string' && value.trim() !== '') keys[name] = value.trim();
    }
    return keys;
  } catch {
    return {};
  }
}

/** The last four characters, which is enough to tell two keys apart and useless to anyone else. */
function hint(value: string): string {
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}

export type KeyState = KeyField & {
  name: KeyName;
  set: boolean;
  /** A secret is never sent back to the page; a URL is. */
  shown: string;
  /** Where the value came from: saved here, or .env / the environment. */
  source: 'app' | 'env' | null;
};

export function keyStates(): KeyState[] {
  const saved = readSavedKeys();
  return KEY_FIELDS.map((field) => {
    const value = env[field.name];
    const set = value !== undefined;
    return {
      ...field,
      set,
      shown: !set ? '' : field.secret ? hint(value) : value,
      source: !set ? null : saved[field.name] === value ? 'app' : 'env',
    };
  });
}

/**
 * The anon key is the browser's half of Supabase and is safe to hold; the
 * service_role key bypasses every row-level policy, so it is refused rather
 * than stored where a screenshot or a shared folder could carry it off.
 */
function checkSupabaseKey(key: string): void {
  if (key.startsWith('sb_secret_')) throw new KeyError('that is a secret key — paste the publishable (anon) key instead');
  const parts = key.split('.');
  if (parts.length !== 3) return;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { role?: unknown };
    if (claims.role === 'service_role') throw new KeyError('that is the service_role key — paste the anon key instead');
  } catch (error) {
    if (error instanceof KeyError) throw error;
  }
}

function check(name: KeyName, value: string): string {
  if (/\s/.test(value)) throw new KeyError(`${name}: a key has no spaces in it — check the paste`);
  if (name === 'SUPABASE_URL') {
    if (!/^https:\/\/[^\s/]+/.test(value)) throw new KeyError('the Supabase URL starts with https://');
    return value.replace(/\/+$/, '');
  }
  if (name === 'SUPABASE_ANON_KEY') checkSupabaseKey(value);
  return value;
}

/**
 * Saves the given keys and puts them into effect at once. An empty string
 * removes a key. Returns the names that changed.
 */
/**
 * Every key in effect, as a .env file: the backup a person keeps so that a
 * reinstall or a new computer is one import, and a file that also works as
 * the project's own .env.
 */
export function exportKeys(): string {
  const lines = [
    '# BreezeMatic keys, exported ' + new Date().toISOString().slice(0, 10) + '.',
    '# Holds secrets: keep it private, never commit or share it.',
    '# Import it from Settings > Keys, or save it as .env in the project folder.',
    '',
  ];
  for (const field of KEY_FIELDS) {
    const value = env[field.name];
    if (value !== undefined) lines.push(`${field.name}=${value}`);
  }
  return lines.join('\n') + '\n';
}

/** Reads KEY=value lines from a .env-style text; anything that is not a known key is ignored. */
export function parseKeysFile(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (isKeyName(name) && value !== '') found[name] = value;
  }
  return found;
}

export function saveKeys(patch: Record<string, unknown>): KeyName[] {
  const saved = readSavedKeys();
  const changed: KeyName[] = [];
  for (const [name, raw] of Object.entries(patch)) {
    if (!isKeyName(name) || typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value === '') {
      if (saved[name] === undefined) continue;
      delete saved[name];
    } else {
      saved[name] = check(name, value);
    }
    changed.push(name);
  }
  if (changed.length === 0) return [];

  fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
  fs.writeFileSync(KEYS_FILE, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 });

  // `env` was parsed once at start; these fields are plain properties on it,
  // and every provider reads them when it is called, not when it is loaded.
  const live = env as Record<string, unknown>;
  for (const name of changed) {
    // A removed key falls back to whatever .env or the environment had.
    const value = saved[name] ?? UNSAVED_ENV[name];
    live[name] = value;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return changed;
}
