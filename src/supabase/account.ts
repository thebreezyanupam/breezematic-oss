import os from 'node:os';
import crypto from 'node:crypto';
import type { Session, User } from '@supabase/supabase-js';
import { EFFECT_NAMES, type BeatSheet, type EffectName } from '../schema.js';
import { log } from '../log.js';
import { isConfigured, restoreSession, storeSession, supabase } from './client.js';
import { localDb } from '../store/local.js';

export type Account = { id: string; email: string | null };

export type Preferences = {
  theme: 'dark' | 'light';
  effect: EffectName;
  voice: string;
  variant: number;
};

export type RemoteProject = {
  slug: string;
  topic: string;
  effect: string | null;
  durationMs: number | null;
  beatCount: number | null;
  updatedAt: string;
  /** Machines that have rendered an MP4 for this project. */
  renderedOn: string[];
};

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

let session: Session | null = null;
let restored = false;

/**
 * A stable, non-identifying name for this machine, so history can say whether
 * the MP4 for a project is on the computer you are sitting at.
 */
export const DEVICE_ID = crypto
  .createHash('sha256')
  .update(`${os.hostname()}|${os.platform()}|${os.userInfo().username}`)
  .digest('hex')
  .slice(0, 12);

export const DEVICE_LABEL = os.hostname();

function toAccount(user: User | null): Account | null {
  if (user === null) return null;
  return { id: user.id, email: user.email ?? null };
}

export async function currentAccount(): Promise<Account | null> {
  if (!isConfigured()) return null;
  if (!restored) {
    restored = true;
    session = await restoreSession();
  }
  return toAccount(session?.user ?? null);
}

function requireSession(): Session {
  if (session === null) throw new AuthError('not signed in');
  return session;
}

export type SignUpResult = { account: Account | null; confirmationRequired: boolean };

export async function signUp(email: string, password: string): Promise<SignUpResult> {
  const { data, error } = await supabase().auth.signUp({ email, password });
  if (error !== null) throw new AuthError(error.message);

  // With email confirmation on, Supabase returns a user but no session. That is
  // the account being created successfully, not a failure, so it comes back as a
  // result the caller can phrase as an instruction rather than as an error.
  if (data.session === null) {
    return { account: toAccount(data.user), confirmationRequired: true };
  }

  session = data.session;
  storeSession(session);
  return { account: toAccount(session.user), confirmationRequired: false };
}

export async function signIn(email: string, password: string): Promise<Account | null> {
  const { data, error } = await supabase().auth.signInWithPassword({ email, password });
  if (error !== null) throw new AuthError(error.message);
  session = data.session;
  storeSession(session);
  return toAccount(session?.user ?? null);
}

/** Drops the in-memory session too, after the project behind it changed (resetSupabase). */
export function forgetSession(): void {
  session = null;
  restored = false;
}

export async function signOut(): Promise<void> {
  if (isConfigured() && session !== null) {
    await supabase().auth.signOut();
  }
  session = null;
  storeSession(null);
}

const DEFAULT_PREFERENCES: Preferences = {
  theme: 'dark',
  effect: 'static',
  voice: 'af_heart',
  variant: 0,
};

function cleanPreferences(row: Record<string, unknown> | undefined | null): Preferences {
  if (row === undefined || row === null) return DEFAULT_PREFERENCES;
  const effect = row['effect'] as string;
  return {
    theme: row['theme'] === 'light' ? 'light' : 'dark',
    effect: (EFFECT_NAMES as readonly string[]).includes(effect) ? (effect as EffectName) : DEFAULT_PREFERENCES.effect,
    voice: typeof row['voice'] === 'string' ? row['voice'] : DEFAULT_PREFERENCES.voice,
    variant: Number(row['variant'] ?? 0),
  };
}

/* Without an account, preferences and history live in the local database. */

async function readLocalPreferences(): Promise<Preferences> {
  const db = await localDb();
  if (db === null) return DEFAULT_PREFERENCES;
  return cleanPreferences(db.prepare('select theme, effect, voice, variant from preferences where id = 1').get() as Record<string, unknown> | undefined);
}

async function writeLocalPreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const merged = { ...(await readLocalPreferences()), ...patch };
  const db = await localDb();
  db?.prepare(
    `insert into preferences (id, theme, effect, voice, variant) values (1, ?, ?, ?, ?)
     on conflict (id) do update set theme = excluded.theme, effect = excluded.effect, voice = excluded.voice, variant = excluded.variant`,
  ).run(merged.theme, merged.effect, merged.voice, merged.variant);
  return merged;
}

export async function readPreferences(): Promise<Preferences> {
  if (!isConfigured()) return readLocalPreferences();
  const active = requireSession();
  const { data, error } = await supabase()
    .from('preferences')
    .select('theme, effect, voice, variant')
    .eq('user_id', active.user.id)
    .maybeSingle();

  if (error !== null) throw new Error(`preferences: ${error.message}`);
  if (data === null) return DEFAULT_PREFERENCES;

  const effect = data['effect'] as string;
  return {
    theme: data['theme'] === 'light' ? 'light' : 'dark',
    effect: (EFFECT_NAMES as readonly string[]).includes(effect)
      ? (effect as EffectName)
      : DEFAULT_PREFERENCES.effect,
    voice: (data['voice'] as string) ?? DEFAULT_PREFERENCES.voice,
    variant: Number(data['variant'] ?? 0),
  };
}

export async function writePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  if (!isConfigured()) return writeLocalPreferences(patch);
  const active = requireSession();
  const merged = { ...(await readPreferences()), ...patch };

  const { error } = await supabase()
    .from('preferences')
    .upsert({ user_id: active.user.id, ...merged }, { onConflict: 'user_id' });

  if (error !== null) throw new Error(`preferences: ${error.message}`);
  return merged;
}

/**
 * History is written on every plan, so the beat sheet is safe the moment it
 * exists rather than only once something has been rendered.
 */
export async function recordProject(sheet: BeatSheet): Promise<void> {
  try {
    const db = await localDb();
    db?.prepare(
      `insert into projects (slug, topic, seed, effect, duration_ms, beat_count, word_count, sfx_count, sheet)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (slug) do update set topic = excluded.topic, seed = excluded.seed, effect = excluded.effect,
         duration_ms = excluded.duration_ms, beat_count = excluded.beat_count, word_count = excluded.word_count,
         sfx_count = excluded.sfx_count, sheet = excluded.sheet,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).run(
      sheet.meta.slug,
      sheet.meta.topic,
      sheet.meta.seed,
      sheet.meta.effect,
      sheet.meta.durationMs,
      sheet.beats.length,
      sheet.script.fullText.split(/\s+/).length,
      sheet.sfx.length,
      JSON.stringify(sheet),
    );
  } catch (error) {
    log.warn(`history: ${(error as Error).message}`);
  }
  if (!isConfigured() || session === null) return;

  const { error } = await supabase().from('projects').upsert(
    {
      user_id: session.user.id,
      slug: sheet.meta.slug,
      topic: sheet.meta.topic,
      seed: sheet.meta.seed,
      effect: sheet.meta.effect,
      duration_ms: sheet.meta.durationMs,
      beat_count: sheet.beats.length,
      word_count: sheet.script.fullText.split(/\s+/).length,
      sfx_count: sheet.sfx.length,
      sheet,
    },
    { onConflict: 'user_id,slug' },
  );

  if (error !== null) log.warn(`history: ${error.message}`);
}

/** Marks that this machine now holds a rendered MP4 for the project. */
export async function recordRender(slug: string): Promise<void> {
  try {
    const db = await localDb();
    const row = db?.prepare('select rendered_on from projects where slug = ?').get(slug) as { rendered_on: string } | undefined;
    if (db && row !== undefined) {
      const others = (JSON.parse(row.rendered_on) as { device?: string }[]).filter((entry) => entry.device !== DEVICE_ID);
      const next = [...others, { device: DEVICE_ID, label: DEVICE_LABEL, at: new Date().toISOString() }];
      db.prepare(`update projects set rendered_on = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where slug = ?`).run(JSON.stringify(next), slug);
    }
  } catch (error) {
    log.warn(`history: ${(error as Error).message}`);
  }
  if (!isConfigured() || session === null) return;

  const { data, error } = await supabase()
    .from('projects')
    .select('rendered_on')
    .eq('user_id', session.user.id)
    .eq('slug', slug)
    .maybeSingle();

  if (error !== null || data === null) {
    if (error !== null) log.warn(`history: ${error.message}`);
    return;
  }

  const existing = Array.isArray(data['rendered_on']) ? (data['rendered_on'] as unknown[]) : [];
  const others = existing.filter(
    (entry) => (entry as { device?: string })?.device !== DEVICE_ID,
  );
  const next = [...others, { device: DEVICE_ID, label: DEVICE_LABEL, at: new Date().toISOString() }];

  const { error: writeError } = await supabase()
    .from('projects')
    .update({ rendered_on: next })
    .eq('user_id', session.user.id)
    .eq('slug', slug);

  if (writeError !== null) log.warn(`history: ${writeError.message}`);
}

async function listLocalProjects(): Promise<RemoteProject[]> {
  const db = await localDb();
  if (db === null) return [];
  const rows = db
    .prepare('select slug, topic, effect, duration_ms, beat_count, updated_at, rendered_on from projects order by updated_at desc limit 500')
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    slug: row['slug'] as string,
    topic: row['topic'] as string,
    effect: (row['effect'] as string | null) ?? null,
    durationMs: (row['duration_ms'] as number | null) ?? null,
    beatCount: (row['beat_count'] as number | null) ?? null,
    updatedAt: row['updated_at'] as string,
    renderedOn: (JSON.parse(String(row['rendered_on'] ?? '[]')) as { device?: string }[])
      .map((entry) => entry.device)
      .filter((device): device is string => typeof device === 'string'),
  }));
}

export async function listProjects(): Promise<RemoteProject[]> {
  if (!isConfigured()) return listLocalProjects();
  const active = requireSession();
  const { data, error } = await supabase()
    .from('projects')
    .select('slug, topic, effect, duration_ms, beat_count, updated_at, rendered_on')
    .eq('user_id', active.user.id)
    .order('updated_at', { ascending: false })
    .limit(200);

  if (error !== null) throw new Error(`history: ${error.message}`);

  return (data ?? []).map((row) => ({
    slug: row['slug'] as string,
    topic: row['topic'] as string,
    effect: (row['effect'] as string | null) ?? null,
    durationMs: (row['duration_ms'] as number | null) ?? null,
    beatCount: (row['beat_count'] as number | null) ?? null,
    updatedAt: row['updated_at'] as string,
    renderedOn: (Array.isArray(row['rendered_on']) ? row['rendered_on'] : [])
      .map((entry) => (entry as { device?: string })?.device)
      .filter((device): device is string => typeof device === 'string'),
  }));
}

/**
 * Forgets a project in the account.
 *
 * Signing out is not a reason to fail: deleting the local files is the point of
 * the operation and the account row is the follow-up, so an unconfigured or
 * signed-out install simply has nothing to forget. RLS restricts the delete to
 * the caller's own rows, and the user_id filter says so here as well.
 */
export async function forgetProject(slug: string): Promise<void> {
  try {
    (await localDb())?.prepare('delete from projects where slug = ?').run(slug);
  } catch (error) {
    log.warn(`history: ${(error as Error).message}`);
  }
  if (!isConfigured() || session === null) return;

  const { error } = await supabase()
    .from('projects')
    .delete()
    .eq('user_id', session.user.id)
    .eq('slug', slug);

  if (error !== null) log.warn(`history: ${error.message}`);
}

/** Removes every project from the signed-in account. False when there is no account to clear. */
export async function forgetAllProjects(): Promise<boolean> {
  if (!isConfigured() || session === null) return false;
  const { error } = await supabase().from('projects').delete().eq('user_id', session.user.id);
  if (error !== null) {
    log.warn(`history: ${error.message}`);
    return false;
  }
  return true;
}

/** Pulls a project's beat sheet back down so another machine can re-render it. */
async function fetchLocalSheet(slug: string): Promise<unknown | null> {
  const row = (await localDb())?.prepare('select sheet from projects where slug = ?').get(slug) as { sheet: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.sheet) as unknown);
}

export async function fetchSheet(slug: string): Promise<unknown | null> {
  if (!isConfigured()) return fetchLocalSheet(slug);
  const active = requireSession();
  const { data, error } = await supabase()
    .from('projects')
    .select('sheet')
    .eq('user_id', active.user.id)
    .eq('slug', slug)
    .maybeSingle();

  if (error !== null) throw new Error(`history: ${error.message}`);
  return data?.['sheet'] ?? null;
}
