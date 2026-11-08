import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { dirs, env } from '../config.js';
import { log } from '../log.js';

const SESSION_FILE = path.join(dirs.cache, 'supabase-session.json');

export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super(
      'SUPABASE_URL and SUPABASE_ANON_KEY are not set. See supabase/README.md, or ' +
        'keep using BreezeMatic without an account — everything except history and ' +
        'preferences works exactly the same.',
    );
    this.name = 'SupabaseNotConfiguredError';
  }
}

export function isConfigured(): boolean {
  return env.SUPABASE_URL !== undefined && env.SUPABASE_ANON_KEY !== undefined;
}

let client: SupabaseClient | undefined;
let clientFor = '';

/**
 * Forgets the client and the session stored for this machine. Called when the
 * project is changed or removed in Settings: a session belongs to one project,
 * and replaying it against another only produces a confusing rejection.
 */
export function resetSupabase(): void {
  client = undefined;
  clientFor = '';
  storeSession(null);
}

/**
 * The session lives on this machine rather than in the browser: the page has no
 * build step, so keeping supabase-js on the server side of the wire means no
 * bundler and no new dependency for the page. It also means the CLI could use
 * the same signed-in session later.
 */
export function supabase(): SupabaseClient {
  if (!isConfigured()) throw new SupabaseNotConfiguredError();
  const target = `${env.SUPABASE_URL}|${env.SUPABASE_ANON_KEY}`;
  if (client === undefined || clientFor !== target) {
    clientFor = target;
    client = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

export function readStoredSession(): { access_token: string; refresh_token: string } | null {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as Record<string, unknown>;
    const access = raw['access_token'];
    const refresh = raw['refresh_token'];
    if (typeof access !== 'string' || typeof refresh !== 'string') return null;
    return { access_token: access, refresh_token: refresh };
  } catch {
    return null;
  }
}

export function storeSession(session: Session | null): void {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  if (session === null) {
    if (fs.existsSync(SESSION_FILE)) fs.rmSync(SESSION_FILE, { force: true });
    return;
  }
  // .cache is gitignored; this holds a refresh token for this machine only.
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
}

/** Restores the session saved by a previous run, refreshing it if it has aged out. */
export async function restoreSession(): Promise<Session | null> {
  const stored = readStoredSession();
  if (stored === null) return null;

  const { data, error } = await supabase().auth.setSession(stored);
  if (error !== null || data.session === null) {
    log.debug(`supabase: stored session rejected (${error?.message ?? 'no session'})`);
    storeSession(null);
    return null;
  }
  storeSession(data.session);
  return data.session;
}
