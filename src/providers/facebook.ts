import fs from 'node:fs';
import path from 'node:path';
import { dirs, env } from '../config.js';
import { log } from '../log.js';

/**
 * Facebook Pages, only as much of the Graph API as posting a finished video to
 * a Page you run needs.
 *
 * The shape is deliberately the same as the YouTube provider next door — an
 * OAuth dance, a stored connection, a chunked upload — but the token story is
 * different enough to be worth stating. Google gives a refresh token and you
 * spend it hourly. Meta gives a short-lived user token, which you trade for a
 * long-lived one, which you then trade for a *Page* token; and a Page token
 * derived from a long-lived user token does not expire. So there is no refresh
 * loop here. There is one exchange at connect time and then a token that keeps
 * working until somebody changes their password or removes the app.
 *
 * The other difference is what an unreviewed app may do. On YouTube an
 * unaudited project has every upload forced private. On Meta, an app in
 * development posts perfectly normally to Pages the app's own admins run —
 * review is what lets it post to *other people's* Pages. Which means this
 * works, publicly, today, for the person who set it up.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';
const DIALOG = 'https://www.facebook.com/v21.0/dialog/oauth';

/**
 * `pages_show_list` to find the Pages, `pages_manage_posts` to post to one,
 * and the two read scopes so the performance screen has something to read.
 * Nothing here asks for a personal profile, friends, or ads.
 *
 * `business_management` is the odd one out, and it is here for a reason that
 * is invisible until it bites: a Page held by a business portfolio rather than
 * attached directly to a personal profile does not come back from
 * `/me/accounts` without it, and does not appear on Facebook's own Page
 * chooser either. The failure is silent and looks like the wrong answer rather
 * than a missing permission — the app connects, reports success, lists the one
 * personal Page, and never mentions the Page somebody actually wanted. It is a
 * broader scope than the rest and it is requested only to make those Pages
 * visible; nothing in this file writes through the Business Manager API.
 */
const SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'read_insights',
  'business_management',
].join(',');

/** Graph wants chunks; 4 MB keeps the progress bar moving without thrashing. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const MAX_UPLOAD_FAILURES = 5;

const TOKEN_FILE = path.join(dirs.cache, 'facebook-tokens.json');
const CLIENT_FILE = path.join(dirs.cache, 'facebook-client.json');

export type Page = { id: string; name: string; token: string };

export type Connection = {
  /** Long-lived user token, kept only so the Page list can be refreshed. */
  userToken: string;
  /** Epoch milliseconds; the *user* token's expiry, not the Page token's. */
  expiresAt: number;
  scope: string;
  pageId: string | null;
  pageName: string | null;
  /** Derived from a long-lived user token, so this one does not expire. */
  pageToken: string | null;
};

export type VideoMetadata = {
  title: string;
  description: string;
  /**
   * Meta requires AI-generated content to be disclosed. Nothing is inherited
   * from the YouTube flag: it is a separate declaration to a separate company.
   */
  containsSyntheticMedia: boolean;
  /** False posts it unpublished, so it can be checked on the Page first. */
  published: boolean;
};

export type UploadResult = {
  videoId: string;
  url: string;
  /** What Meta actually did, which is not always what was asked for. */
  published: boolean;
};

export class FacebookNotConnectedError extends Error {
  constructor() {
    super('No Facebook Page is connected. Connect one, then try again.');
    this.name = 'FacebookNotConnectedError';
  }
}

export class FacebookApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Meta's own code, so a dead token can be told from a refused post. */
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = 'FacebookApiError';
  }

  /** True when reconnecting is the fix and retrying is not. */
  get needsReconnect(): boolean {
    return this.code === 190 || this.status === 401;
  }
}

export type ClientConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  source: 'app' | 'env';
};

/* ------------------------------------------------------------------ client */

export function readClientConfig(): ClientConfig | null {
  if (fs.existsSync(CLIENT_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8')) as Partial<ClientConfig>;
      if (typeof raw.appId === 'string' && typeof raw.appSecret === 'string') {
        return {
          appId: raw.appId,
          appSecret: raw.appSecret,
          redirectUri:
            typeof raw.redirectUri === 'string' && raw.redirectUri !== ''
              ? raw.redirectUri
              : env.FACEBOOK_REDIRECT_URI,
          source: 'app',
        };
      }
    } catch {
      /* unreadable file falls through to the environment */
    }
  }

  if (env.FACEBOOK_APP_ID !== undefined && env.FACEBOOK_APP_SECRET !== undefined) {
    return {
      appId: env.FACEBOOK_APP_ID,
      appSecret: env.FACEBOOK_APP_SECRET,
      redirectUri: env.FACEBOOK_REDIRECT_URI,
      source: 'env',
    };
  }
  return null;
}

export function writeClientConfig(
  config: { appId: string; appSecret: string; redirectUri: string } | null,
): void {
  fs.mkdirSync(path.dirname(CLIENT_FILE), { recursive: true });
  if (config === null) {
    if (fs.existsSync(CLIENT_FILE)) fs.rmSync(CLIENT_FILE, { force: true });
    return;
  }
  fs.writeFileSync(CLIENT_FILE, JSON.stringify(config, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function requireClient(): ClientConfig {
  const client = readClientConfig();
  if (client === null) {
    throw new Error(
      'Facebook publishing is not set up. Add the app id and secret from your Meta app.',
    );
  }
  return client;
}

export function isConfigured(): boolean {
  return readClientConfig() !== null;
}

/* ------------------------------------------------------------------ tokens */

export function readConnection(): Connection | null {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as Partial<Connection>;
    if (typeof raw.userToken !== 'string' || raw.userToken === '') return null;
    return {
      userToken: raw.userToken,
      expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
      scope: typeof raw.scope === 'string' ? raw.scope : '',
      pageId: typeof raw.pageId === 'string' ? raw.pageId : null,
      pageName: typeof raw.pageName === 'string' ? raw.pageName : null,
      pageToken: typeof raw.pageToken === 'string' ? raw.pageToken : null,
    };
  } catch {
    return null;
  }
}

function writeConnection(connection: Connection | null): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  if (connection === null) {
    if (fs.existsSync(TOKEN_FILE)) fs.rmSync(TOKEN_FILE, { force: true });
    return;
  }
  // .cache is gitignored. A Page token is enough to post as that Page, so it
  // is written owner-only and never leaves the disk.
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(connection, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/** Connected *and* pointed at a Page: a user token alone cannot post anything. */
export function isConnected(): boolean {
  const connection = readConnection();
  return connection !== null && connection.pageToken !== null;
}

export function connectedPage(): { id: string; name: string } | null {
  const connection = readConnection();
  if (connection?.pageId == null || connection.pageName == null) return null;
  return { id: connection.pageId, name: connection.pageName };
}

/* ------------------------------------------------------------------- graph */

type GraphError = {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
};

async function describe(res: Response): Promise<FacebookApiError> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as GraphError;
    const message = parsed.error?.message;
    if (message !== undefined) {
      return new FacebookApiError(
        message,
        res.status,
        parsed.error?.code,
        parsed.error?.error_subcode,
      );
    }
  } catch {
    /* not JSON — fall through */
  }
  return new FacebookApiError(
    text === '' ? `HTTP ${res.status}` : text.slice(0, 300),
    res.status,
  );
}

async function graph<T>(
  pathname: string,
  params: Record<string, string>,
  init?: { method?: 'GET' | 'POST'; body?: FormData },
): Promise<T> {
  const url = new URL(`${GRAPH}/${pathname.replace(/^\//, '')}`);
  // The access token goes in the body for writes and the query for reads;
  // either way it never reaches a log, because nothing here logs a URL.
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await describe(res);
  return (await res.json()) as T;
}

/* -------------------------------------------------------------------- oauth */

export function authorizeUrl(state: string): string {
  const client = requireClient();
  const params = new URLSearchParams({
    client_id: client.appId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: SCOPES,
    /**
     * Ask again, every time.
     *
     * Which Pages the app may touch is chosen on Facebook's own screen, not
     * ours, and Meta shows that screen once and then silently reuses the
     * answer. So without this, somebody who granted one Page by accident can
     * disconnect, reconnect, and be handed the same single Page back with no
     * screen in between and no way to tell why -- the reconnection appears to
     * work and changes nothing. `rerequest` forces the chooser to open.
     */
    auth_type: 'rerequest',
    state,
  });
  return `${DIALOG}?${params.toString()}`;
}

/**
 * Turns the code from the redirect into something that lasts.
 *
 * Three hops, and skipping any of them gives a connection that dies: the code
 * buys an hour-long user token, the hour-long token buys a sixty-day one, and
 * only a Page token minted from *that* is the one that never expires.
 */
export async function connectWithCode(code: string): Promise<Connection> {
  const client = requireClient();

  const short = await graph<{ access_token: string }>('oauth/access_token', {
    client_id: client.appId,
    client_secret: client.appSecret,
    redirect_uri: client.redirectUri,
    code,
  });

  const long = await graph<{ access_token: string; expires_in?: number }>(
    'oauth/access_token',
    {
      grant_type: 'fb_exchange_token',
      client_id: client.appId,
      client_secret: client.appSecret,
      fb_exchange_token: short.access_token,
    },
  );

  const connection: Connection = {
    userToken: long.access_token,
    expiresAt: Date.now() + (long.expires_in ?? 60 * 24 * 3600) * 1000,
    scope: SCOPES,
    pageId: null,
    pageName: null,
    pageToken: null,
  };

  /**
   * One Page means one obvious answer, so it is chosen here rather than making
   * somebody pick from a list of one. Several means asking, because posting to
   * the wrong Page is the mistake worth a click to prevent.
   */
  const pages = await listPages(connection.userToken);
  writeConnection(connection);
  if (pages.length === 1) return selectPage(pages[0]!.id);
  log.info(`facebook: connected, ${pages.length} pages to choose from`);
  return connection;
}

export async function listPages(userToken?: string): Promise<{ id: string; name: string }[]> {
  const token = userToken ?? readConnection()?.userToken;
  if (token === undefined) throw new FacebookNotConnectedError();

  const body = await graph<{ data?: { id?: string; name?: string; access_token?: string }[] }>(
    'me/accounts',
    { access_token: token, fields: 'id,name,access_token', limit: '100' },
  );
  return (body.data ?? [])
    .filter((page): page is { id: string; name: string; access_token: string } =>
      typeof page.id === 'string' &&
      typeof page.name === 'string' &&
      typeof page.access_token === 'string',
    )
    .map((page) => ({ id: page.id, name: page.name }));
}

/** Points the connection at one Page and mints its non-expiring token. */
export async function selectPage(pageId: string): Promise<Connection> {
  const connection = readConnection();
  if (connection === null) throw new FacebookNotConnectedError();

  const body = await graph<{ data?: { id?: string; name?: string; access_token?: string }[] }>(
    'me/accounts',
    { access_token: connection.userToken, fields: 'id,name,access_token', limit: '100' },
  );
  const page = (body.data ?? []).find((candidate) => candidate.id === pageId);
  if (page?.access_token === undefined) {
    throw new FacebookApiError(`no Page with id ${pageId} is managed by this account`, 404);
  }

  const updated: Connection = {
    ...connection,
    pageId: page.id ?? pageId,
    pageName: page.name ?? pageId,
    pageToken: page.access_token,
  };
  writeConnection(updated);
  log.info(`facebook: posting as "${updated.pageName}"`);
  return updated;
}

export async function disconnect(): Promise<void> {
  const connection = readConnection();
  writeConnection(null);
  if (connection === null) return;
  try {
    // Best effort: revoking tells Meta the app is done with the account, but a
    // failure here must not leave the tokens on disk, which is why it is last.
    await graph('me/permissions', { access_token: connection.userToken }, { method: 'POST' });
  } catch {
    /* already gone, or offline */
  }
}

function requirePageToken(): { pageId: string; pageToken: string } {
  const connection = readConnection();
  if (connection?.pageToken == null || connection.pageId == null) {
    throw new FacebookNotConnectedError();
  }
  return { pageId: connection.pageId, pageToken: connection.pageToken };
}

/* ------------------------------------------------------------------ upload */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Posts a finished file to the connected Page, in chunks.
 *
 * Chunked rather than one multipart POST because a three-minute render is tens
 * of megabytes and a single request gives no progress and no way back from a
 * dropped connection halfway. Graph's session upload tells you the offset it
 * wants next, so a failed chunk is re-sent from where it actually stopped
 * rather than from the beginning.
 *
 * There is no Reels call here on purpose. Reels are short-form and capped well
 * under the length of a narrated storybook, so a three-minute video posted as
 * one would be refused or cut; as a Page video there is no such limit.
 */
export async function uploadVideo(options: {
  file: string;
  metadata: VideoMetadata;
  onProgress?: (fraction: number) => void;
}): Promise<UploadResult> {
  const { pageId, pageToken } = requirePageToken();
  const total = fs.statSync(options.file).size;

  const start = await graph<{
    video_id: string;
    upload_session_id: string;
    start_offset: string;
    end_offset: string;
  }>(
    `${pageId}/videos`,
    { access_token: pageToken, upload_phase: 'start', file_size: String(total) },
    { method: 'POST' },
  );

  const handle = fs.openSync(options.file, 'r');
  try {
    let offset = Number(start.start_offset);
    let failures = 0;

    while (offset < total) {
      const size = Math.min(CHUNK_BYTES, total - offset);
      const chunk = Buffer.alloc(size);
      fs.readSync(handle, chunk, 0, size, offset);

      const form = new FormData();
      form.append('access_token', pageToken);
      form.append('upload_phase', 'transfer');
      form.append('upload_session_id', start.upload_session_id);
      form.append('start_offset', String(offset));
      form.append('video_file_chunk', new Blob([chunk]), 'chunk');

      try {
        const res = await fetch(`${GRAPH}/${pageId}/videos`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw await describe(res);

        const moved = (await res.json()) as { start_offset?: string };
        const next = Number(moved.start_offset);
        // Graph decides where it wants the next byte from. Trusting its number
        // over our own arithmetic is what makes a resumed upload correct.
        offset = Number.isFinite(next) ? next : offset + size;
        options.onProgress?.(offset / total);
      } catch (error) {
        const fatal = error instanceof FacebookApiError && error.status < 500;
        failures += 1;
        if (fatal || failures > MAX_UPLOAD_FAILURES) throw error;
        await sleep(1000 * 2 ** (failures - 1));
        log.debug(`facebook: retrying chunk at ${offset}/${total}`);
      }
    }
  } finally {
    fs.closeSync(handle);
  }

  const description =
    options.metadata.containsSyntheticMedia
      ? `${options.metadata.description}\n\nNarration is AI-generated.`
      : options.metadata.description;

  const finished = await graph<{ success?: boolean }>(
    `${pageId}/videos`,
    {
      access_token: pageToken,
      upload_phase: 'finish',
      upload_session_id: start.upload_session_id,
      title: options.metadata.title,
      description,
      published: String(options.metadata.published),
    },
    { method: 'POST' },
  );

  if (finished.success === false) {
    throw new FacebookApiError('Facebook accepted the file but would not publish it', 502);
  }
  options.onProgress?.(1);

  /**
   * The link Facebook itself uses, and what it says about the post.
   *
   * `facebook.com/<video id>` is not a permalink. It resolves for whoever
   * posted it -- the browser has the context -- and sends everybody else to a
   * login wall, which is indistinguishable from the video being private and
   * was read as exactly that. Facebook returns the real address in
   * `permalink_url`: `/reel/<id>/` for a vertical video, `/<page>/videos/<id>`
   * for a landscape one.
   *
   * The privacy and publish state come back in the same request, so the post
   * is confirmed public by asking rather than by assuming the upload did what
   * it was told.
   */
  let url = `https://www.facebook.com/${start.video_id}`;
  try {
    const checked = await graph<{
      permalink_url?: string;
      published?: boolean;
      privacy?: { value?: string; description?: string };
      status?: { video_status?: string };
    }>(start.video_id, {
      access_token: pageToken,
      fields: 'permalink_url,published,privacy,status',
    });
    if (typeof checked.permalink_url === 'string' && checked.permalink_url !== '') {
      url = `https://www.facebook.com${checked.permalink_url}`;
    }
    const privacy = checked.privacy?.value ?? '';
    if (options.metadata.published && (checked.published === false || (privacy !== '' && privacy !== 'EVERYONE'))) {
      log.warn(
        `facebook: the post came back as ${checked.published === false ? 'unpublished' : privacy} ` +
          'rather than public -- check the Page restrictions in Meta Business Suite',
      );
    } else if (options.metadata.published) {
      log.info(`facebook: public, ${checked.status?.video_status ?? 'ready'} — ${url}`);
    }
  } catch (error) {
    log.debug(`facebook: could not confirm the post (${(error as Error).message})`);
  }

  return {
    videoId: start.video_id,
    url,
    published: options.metadata.published,
  };
}

/* --------------------------------------------------------------- analytics */

export type VideoStats = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  extra: Record<string, string>;
};

function summaryCount(value: { summary?: { total_count?: number } } | undefined): number | null {
  const count = value?.summary?.total_count;
  return typeof count === 'number' ? count : null;
}

/**
 * How the Page's videos are doing.
 *
 * One request per video rather than a batch, because video insights are not
 * available on an edge that takes a list. That is fine at this scale — a
 * channel's worth of videos is tens of requests, refreshed only when asked —
 * and a single video that fails is skipped rather than losing the others.
 */
export async function videoStats(ids: readonly string[]): Promise<Map<string, VideoStats>> {
  const found = new Map<string, VideoStats>();
  if (ids.length === 0) return found;
  const { pageToken } = requirePageToken();

  for (const id of ids) {
    try {
      const body = await graph<{
        likes?: { summary?: { total_count?: number } };
        comments?: { summary?: { total_count?: number } };
        views?: number;
        length?: number;
      }>(id, {
        access_token: pageToken,
        fields: 'likes.summary(true),comments.summary(true),views,length',
      });

      const extra: Record<string, string> = {};
      if (typeof body.length === 'number') {
        extra['Length'] = `${Math.round(body.length)}s`;
      }

      found.set(id, {
        views: typeof body.views === 'number' ? body.views : null,
        likes: summaryCount(body.likes),
        comments: summaryCount(body.comments),
        // Shares are on the post, not the video, and the post id is not the
        // video id. Null rather than a wrong zero.
        shares: null,
        extra,
      });
    } catch (error) {
      if (error instanceof FacebookApiError && error.needsReconnect) throw error;
      log.debug(`facebook: no stats for ${id}`);
    }
  }
  return found;
}
