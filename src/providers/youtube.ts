import fs from 'node:fs';
import path from 'node:path';
import { dirs, env } from '../config.js';
import { log } from '../log.js';
import { MissingApiKeyError } from './errors.js';

/**
 * YouTube Data API v3, only as much of it as publishing a finished file needs:
 * the OAuth dance, a token that refreshes itself, and a resumable upload.
 *
 * There is no Shorts endpoint. A video becomes a Short because of what it is —
 * vertical and under three minutes — not because of anything sent with it, so
 * nothing here asks for one. The stage above checks the file qualifies.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CHANNEL_URL =
  'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';
const UPLOAD_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

/**
 * `upload` is what does the work. `readonly` is here only so the page can say
 * which channel it is about to post to — publishing to the wrong account is
 * the mistake worth spending a scope to prevent.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  // Posting the first comment under a video. YouTube has no narrower scope
  // that allows it; pinning is not in the API at all.
  'https://www.googleapis.com/auth/youtube.force-ssl',
].join(' ');

const COMMENT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

/** Whether a connection was granted the comment permission -- channels connected before it was asked for were not. */
export function canComment(connection: Connection | null): boolean {
  return connection !== null && connection.scope.split(/\s+/).includes(COMMENT_SCOPE);
}

/** The link that opens the subscribe prompt for a channel. */
export function subscribeUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}?sub_confirmation=1`;
}

/** Google requires a multiple of 256 KiB for every chunk except the last. */
const CHUNK_BYTES = 8 * 1024 * 1024;
const REFRESH_MARGIN_MS = 60_000;
const MAX_UPLOAD_FAILURES = 5;
const TIMEOUT_MS = 120_000;

const TOKEN_FILE = path.join(dirs.cache, 'youtube-tokens.json');
const CLIENT_FILE = path.join(dirs.cache, 'youtube-client.json');

export type PrivacyStatus = 'private' | 'unlisted' | 'public';

export type Connection = {
  refreshToken: string;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
  channelId: string | null;
  channelTitle: string | null;
};

export type VideoMetadata = {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: PrivacyStatus;
  /** Narration is machine-read, so this is always true for us. */
  containsSyntheticMedia: boolean;
};

export type UploadResult = {
  videoId: string;
  url: string;
  /** What YouTube actually applied, which is not always what was asked for. */
  privacyStatus: string;
  uploadStatus: string;
  rejectionReason: string | null;
};

export class YouTubeNotConnectedError extends Error {
  constructor() {
    super('No YouTube channel is connected. Connect one, then try again.');
    this.name = 'YouTubeNotConnectedError';
  }
}

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Google's own error code, where the failure came from OAuth. */
    readonly oauthError?: string,
  ) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

export type ClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Where it came from, so the page can say whether it can edit it. */
  source: 'app' | 'env';
};

/**
 * The OAuth client can be set two ways. `.env` is the operator's route and wins
 * nothing — it is simply the fallback. Anything saved through the app lives in
 * .cache beside the tokens, so setting this up never means editing a file.
 */
export function readClientConfig(): ClientConfig | null {
  if (fs.existsSync(CLIENT_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8')) as Partial<ClientConfig>;
      if (typeof raw.clientId === 'string' && typeof raw.clientSecret === 'string') {
        return {
          clientId: raw.clientId,
          clientSecret: raw.clientSecret,
          redirectUri:
            typeof raw.redirectUri === 'string' && raw.redirectUri !== ''
              ? raw.redirectUri
              : env.YOUTUBE_REDIRECT_URI,
          source: 'app',
        };
      }
    } catch {
      /* unreadable file falls through to the environment */
    }
  }

  if (env.YOUTUBE_CLIENT_ID !== undefined && env.YOUTUBE_CLIENT_SECRET !== undefined) {
    return {
      clientId: env.YOUTUBE_CLIENT_ID,
      clientSecret: env.YOUTUBE_CLIENT_SECRET,
      redirectUri: env.YOUTUBE_REDIRECT_URI,
      source: 'env',
    };
  }
  return null;
}

export function writeClientConfig(
  config: { clientId: string; clientSecret: string; redirectUri: string } | null,
): void {
  fs.mkdirSync(path.dirname(CLIENT_FILE), { recursive: true });
  if (config === null) {
    if (fs.existsSync(CLIENT_FILE)) fs.rmSync(CLIENT_FILE, { force: true });
    return;
  }
  // Holds a real client secret, so owner-only and never outside .cache.
  fs.writeFileSync(CLIENT_FILE, JSON.stringify(config, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function requireClient(): ClientConfig {
  const config = readClientConfig();
  if (config === null) throw new MissingApiKeyError('YOUTUBE_CLIENT_ID');
  return config;
}

export function isConfigured(): boolean {
  return readClientConfig() !== null;
}

export function assertConfigured(): void {
  requireClient();
}

/* ------------------------------------------------------------------ tokens */

/**
 * Every channel this machine can post to, and which one is the default.
 *
 * One file held one connection, which was right for one channel and wrong the
 * moment there were two: connecting the second overwrote the first, and the
 * books channel and the war channel could not both be ready to post. Now the
 * file holds a list, keyed by channel id, and every upload says which channel
 * it is for -- or, saying nothing, goes to the default.
 *
 * A file written before this, holding one connection, is read as a list of one.
 */
type Store = { v: 2; active: string | null; accounts: Connection[] };

function parseConnection(raw: Partial<Connection> | undefined): Connection | null {
  if (raw === undefined || typeof raw.refreshToken !== 'string' || raw.refreshToken === '') return null;
  return {
    refreshToken: raw.refreshToken,
    accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : '',
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
    scope: typeof raw.scope === 'string' ? raw.scope : '',
    channelId: typeof raw.channelId === 'string' ? raw.channelId : null,
    channelTitle: typeof raw.channelTitle === 'string' ? raw.channelTitle : null,
  };
}

function readStore(): Store {
  if (!fs.existsSync(TOKEN_FILE)) return { v: 2, active: null, accounts: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as Partial<Store> & Partial<Connection>;
    if (raw.v === 2 && Array.isArray(raw.accounts)) {
      const accounts = raw.accounts.map((a) => parseConnection(a)).filter((a): a is Connection => a !== null);
      return { v: 2, active: typeof raw.active === 'string' ? raw.active : null, accounts };
    }
    const single = parseConnection(raw);
    return { v: 2, active: single?.channelId ?? null, accounts: single === null ? [] : [single] };
  } catch {
    return { v: 2, active: null, accounts: [] };
  }
}

function writeStore(store: Store): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  if (store.accounts.length === 0) {
    if (fs.existsSync(TOKEN_FILE)) fs.rmSync(TOKEN_FILE, { force: true });
    return;
  }
  // The default has to be a channel that is still here.
  if (!store.accounts.some((a) => a.channelId === store.active)) store.active = store.accounts[0]!.channelId;
  // .cache is gitignored. These are refresh tokens for channels on one
  // machine; they are not synced anywhere and never leave the disk.
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
}

const keyOf = (connection: Connection): string => connection.channelId ?? connection.refreshToken;

/** Every connected channel, the default first. */
export function listConnections(): Connection[] {
  const store = readStore();
  return [...store.accounts].sort((a, b) => Number(b.channelId === store.active) - Number(a.channelId === store.active));
}

/** The default channel's id, or null with none connected. */
export function activeChannelId(): string | null {
  return listConnections()[0]?.channelId ?? null;
}

/**
 * A channel's connection: the one asked for, or the default. Asking for a
 * channel that is not connected is null, never the default -- posting the war
 * video to the books channel because the war one was disconnected is exactly
 * the mistake this is here to prevent.
 */
export function readConnection(channelId?: string | null): Connection | null {
  const store = readStore();
  if (channelId !== undefined && channelId !== null && channelId !== '') {
    return store.accounts.find((a) => a.channelId === channelId) ?? null;
  }
  return store.accounts.find((a) => a.channelId === store.active) ?? store.accounts[0] ?? null;
}

/** Replace one channel's connection, or with null remove it. */
function writeConnection(connection: Connection | null, remove?: Connection): void {
  const store = readStore();
  const gone = remove ?? connection;
  if (gone !== undefined && gone !== null) {
    store.accounts = store.accounts.filter((a) => keyOf(a) !== keyOf(gone));
  }
  if (connection !== null) {
    store.accounts.push(connection);
    if (store.active === null) store.active = connection.channelId;
  }
  writeStore(store);
}

/** Make a connected channel the default one. */
export function setActiveChannel(channelId: string): void {
  const store = readStore();
  if (!store.accounts.some((a) => a.channelId === channelId)) {
    throw new YouTubeNotConnectedError();
  }
  store.active = channelId;
  writeStore(store);
}

export function isConnected(channelId?: string | null): boolean {
  return readConnection(channelId) !== null;
}

/* -------------------------------------------------------------------- oauth */

export function authorizeUrl(state: string): string {
  const client = requireClient();
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: SCOPES,
    // Without offline + consent Google hands back an access token only, and the
    // connection would die an hour later with no way to renew it.
    access_type: 'offline',
    // select_account as well as consent: without it Google reuses whichever
    // account the browser is signed into, and a second channel on another
    // account -- or a Brand Account -- can never be chosen.
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

/**
 * What an OAuth failure actually means, in a sentence somebody can act on.
 *
 * Google's `error_description` for a dead refresh token is the string "Bad
 * Request", which is how a channel that had simply gone stale surfaced in this
 * app as "Bad Request" and stayed that way. The code beside it says the real
 * thing, and these are the three that matter here.
 */
function explainOauth(code: string | undefined, fallback: string): string {
  if (code === 'invalid_grant') {
    return (
      'the channel connection has expired or was revoked, so it has been cleared — ' +
      'connect the channel again. If your Google Cloud project is still in Testing, ' +
      'refresh tokens there expire after seven days; publishing the consent screen stops that.'
    );
  }
  if (code === 'invalid_client') {
    return 'the client ID or secret was rejected — check the YouTube keys on this machine';
  }
  if (code === 'invalid_scope' || code === 'insufficient_scope') {
    return 'the connection is missing the upload permission — reconnect and accept it';
  }
  return fallback;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    throw new YouTubeApiError(
      explainOauth(
        data.error,
        data.error_description ?? data.error ?? `token endpoint returned ${res.status}`,
      ),
      res.status,
      data.error,
    );
  }
  return data;
}

/** Completes the redirect: swaps the one-time code for a lasting connection. */
export async function connectWithCode(code: string): Promise<Connection & { already: boolean }> {
  const client = requireClient();
  const data = await postToken({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    grant_type: 'authorization_code',
  });

  if (data.refresh_token === undefined || data.access_token === undefined) {
    throw new YouTubeApiError(
      'Google did not return a refresh token. Remove this app at ' +
        'myaccount.google.com/permissions and connect again.',
      400,
    );
  }

  const connection: Connection = {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope ?? SCOPES,
    channelId: null,
    channelTitle: null,
  };

  const channel = await fetchChannel(connection.accessToken).catch((error: unknown) => {
    log.warn(`could not read the channel name: ${error instanceof Error ? error.message : error}`);
    return null;
  });
  /**
   * An account with no channel is refused, not saved. A brand-new Gmail has
   * no YouTube channel until one is created on youtube.com, and saved anyway
   * it became a nameless entry every upload to which failed.
   */
  if (channel === null) {
    throw new YouTubeApiError(
      'that Google account has no YouTube channel yet — create one at youtube.com ' +
        '(avatar → Create a channel), then connect again',
      400,
    );
  }
  connection.channelId = channel.id;
  connection.channelTitle = channel.title;

  // Connecting a channel that is already here refreshes it rather than
  // adding it twice.
  const already = readStore().accounts.some((a) => a.channelId === channel.id);
  writeConnection(connection);
  return { ...connection, already };
}

/** Disconnect one channel -- the one named, or the default. */
export async function disconnect(channelId?: string | null): Promise<void> {
  const connection = readConnection(channelId);
  if (connection === null) return;
  writeConnection(null, connection);
  // Best effort: dropping the file already ends it on this machine.
  await fetch(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: connection.refreshToken }).toString(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

async function accessToken(channelId?: string | null): Promise<string> {
  const connection = readConnection(channelId);
  if (connection === null) throw new YouTubeNotConnectedError();
  if (connection.accessToken !== '' && connection.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return connection.accessToken;
  }

  const client = requireClient();

  /**
   * A refusal here means the connection is gone, and it has to be thrown away.
   *
   * This only cleared the stored tokens when the refresh came back OK but
   * empty, which is the case that never happens. The one that does happen is a
   * 400 with `invalid_grant` -- a refresh token that expired, or that the user
   * revoked -- and that threw straight past the cleanup. So the file stayed on
   * disk, `isConnected()` kept answering true, the publish card kept saying
   * "connected", and every upload failed on a channel the app was certain it
   * had. The way out was not discoverable from anywhere in the interface.
   */
  let data: TokenResponse;
  try {
    data = await postToken({
      refresh_token: connection.refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: 'refresh_token',
    });
  } catch (error) {
    if (error instanceof YouTubeApiError && error.oauthError === 'invalid_grant') {
      writeConnection(null, connection);
      log.warn(`youtube: ${error.message}`);
    }
    throw error;
  }

  if (data.access_token === undefined) {
    writeConnection(null, connection);
    throw new YouTubeNotConnectedError();
  }

  connection.accessToken = data.access_token;
  connection.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  writeConnection(connection);
  return connection.accessToken;
}

async function fetchChannel(token: string): Promise<{ id: string; title: string } | null> {
  const res = await fetch(CHANNEL_URL, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new YouTubeApiError(await describe(res), res.status);

  const body = (await res.json()) as {
    items?: { id?: string; snippet?: { title?: string } }[];
  };
  const first = body.items?.[0];
  if (first?.id === undefined) return null;
  return { id: first.id, title: first.snippet?.title ?? first.id };
}

export async function channelInfo(channelId?: string | null): Promise<{ id: string; title: string } | null> {
  return fetchChannel(await accessToken(channelId));
}

/* ----------------------------------------------------------------- comments */

/**
 * The first comment under a video, posted as the channel.
 *
 * It cannot be pinned from here -- YouTube keeps pinning to people -- so the
 * caller says so. A private video takes no comments at all, and an API
 * project YouTube has not audited has every upload forced private, so this
 * failing is ordinary and never fails the upload it follows.
 */
export async function postComment(videoId: string, text: string, channelId?: string | null): Promise<{ id: string }> {
  const token = await accessToken(channelId);
  const res = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new YouTubeApiError(await describe(res), res.status);
  const body = (await res.json()) as { id?: string };
  return { id: body.id ?? '' };
}

/* ---------------------------------------------------------------- analytics */

export type VideoStats = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  /** Reading fields, for the rows that have them. */
  extra: Record<string, string>;
};

/** Videos per `videos.list` call. Google's own ceiling, not a guess. */
const STATS_BATCH = 50;

function count(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The channel's own recent uploads.
 *
 * Here so the ledger can be filled in backwards. Everything posted before there
 * was anywhere to write it down is still on the channel, and a performance
 * screen that starts empty because the record-keeping is younger than the
 * channel is a screen nobody opens twice.
 */
export async function recentUploads(limit = 50, channelId?: string | null): Promise<
  { videoId: string; title: string; publishedAt: string; privacyStatus: string }[]
> {
  const token = await accessToken(channelId);

  const listRes = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true',
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!listRes.ok) throw new YouTubeApiError(await describe(listRes), listRes.status);
  const channels = (await listRes.json()) as {
    items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[];
  };
  const uploads = channels.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (uploads === undefined) return [];

  const found: { videoId: string; title: string; publishedAt: string; privacyStatus: string }[] = [];
  let pageToken: string | undefined;

  while (found.length < limit) {
    const url =
      'https://www.googleapis.com/youtube/v3/playlistItems' +
      `?part=snippet,status,contentDetails&maxResults=${Math.min(50, limit - found.length)}` +
      `&playlistId=${encodeURIComponent(uploads)}` +
      (pageToken === undefined ? '' : `&pageToken=${encodeURIComponent(pageToken)}`);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new YouTubeApiError(await describe(res), res.status);
    const body = (await res.json()) as {
      nextPageToken?: string;
      items?: {
        snippet?: { title?: string; publishedAt?: string };
        status?: { privacyStatus?: string };
        contentDetails?: { videoId?: string; videoPublishedAt?: string };
      }[];
    };

    for (const item of body.items ?? []) {
      const videoId = item.contentDetails?.videoId;
      if (videoId === undefined) continue;
      found.push({
        videoId,
        title: item.snippet?.title ?? videoId,
        publishedAt:
          item.contentDetails?.videoPublishedAt ??
          item.snippet?.publishedAt ??
          new Date().toISOString(),
        privacyStatus: item.status?.privacyStatus ?? 'unknown',
      });
    }

    pageToken = body.nextPageToken;
    if (pageToken === undefined) break;
  }
  return found;
}

/**
 * How the published videos are doing, by id.
 *
 * `videos.list` rather than the Analytics API, because the scope for it is one
 * this connection already holds: asking for anything more would log every
 * existing user out to re-consent, and views, likes and comments are most of
 * what anybody looks at. Watch time and retention live behind
 * `yt-analytics.readonly` and are worth a reconnection prompt, but not an
 * involuntary one.
 *
 * Ids that come back missing are simply absent from the map. That is the
 * normal answer for a video that has been deleted, and the caller distinguishes
 * "nothing yet" from "gone" by whether the id was asked for.
 */
export async function videoStats(ids: readonly string[]): Promise<Map<string, VideoStats>> {
  const found = new Map<string, VideoStats>();
  if (ids.length === 0) return found;
  const token = await accessToken();

  for (let from = 0; from < ids.length; from += STATS_BATCH) {
    const batch = ids.slice(from, from + STATS_BATCH);
    const url =
      'https://www.googleapis.com/youtube/v3/videos' +
      `?part=statistics,status,snippet&id=${batch.map(encodeURIComponent).join(',')}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new YouTubeApiError(await describe(res), res.status);

    const body = (await res.json()) as {
      items?: {
        id?: string;
        snippet?: { publishedAt?: string };
        status?: { privacyStatus?: string };
        statistics?: {
          viewCount?: string;
          likeCount?: string;
          commentCount?: string;
        };
      }[];
    };

    for (const item of body.items ?? []) {
      if (item.id === undefined) continue;
      const extra: Record<string, string> = {};
      if (item.status?.privacyStatus !== undefined) extra['Visibility'] = item.status.privacyStatus;
      found.set(item.id, {
        views: count(item.statistics?.viewCount),
        likes: count(item.statistics?.likeCount),
        comments: count(item.statistics?.commentCount),
        extra,
      });
    }
  }
  return found;
}

/* ------------------------------------------------------------------- upload */

async function describe(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const reason = parsed.error?.errors?.[0]?.reason;
    const message = parsed.error?.message;
    if (message !== undefined) return reason === undefined ? message : `${message} (${reason})`;
  } catch {
    /* not JSON — fall through to the raw body */
  }
  if (res.status === 401) return 'the connection was rejected; reconnect the channel';
  if (res.status === 403) {
    return 'refused: the daily upload allowance is spent, or the channel cannot upload';
  }
  return text === '' ? `HTTP ${res.status}` : text.slice(0, 300);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks the session how much it already holds, so a retry resumes instead of restarting. */
async function committedBytes(sessionUri: string, total: number): Promise<number> {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes */${total}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 200 || res.status === 201) return total;
  if (res.status !== 308) throw new YouTubeApiError(await describe(res), res.status);

  const range = res.headers.get('range');
  if (range === null) return 0;
  const end = Number.parseInt(range.split('-')[1] ?? '', 10);
  return Number.isFinite(end) ? end + 1 : 0;
}

export async function uploadVideo(options: {
  file: string;
  metadata: VideoMetadata;
  onProgress?: (fraction: number) => void;
  /** Which channel it goes to. Absent: the default. */
  channelId?: string | null;
}): Promise<UploadResult> {
  const token = await accessToken(options.channelId);
  const total = fs.statSync(options.file).size;

  const body = {
    snippet: {
      title: options.metadata.title,
      description: options.metadata.description,
      tags: options.metadata.tags,
      categoryId: options.metadata.categoryId,
      defaultLanguage: 'en',
    },
    status: {
      privacyStatus: options.metadata.privacyStatus,
      // YouTube requires an explicit answer; nothing here is made for children.
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: options.metadata.containsSyntheticMedia,
    },
  };

  const start = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(total),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!start.ok) throw new YouTubeApiError(await describe(start), start.status);

  const sessionUri = start.headers.get('location');
  if (sessionUri === null) {
    throw new YouTubeApiError('YouTube did not open an upload session', start.status);
  }

  const handle = fs.openSync(options.file, 'r');
  try {
    let offset = 0;
    // Counted across the whole upload, not per chunk: a chunk that keeps failing
    // and never moves the offset would otherwise retry for ever.
    let failures = 0;

    while (offset < total) {
      const size = Math.min(CHUNK_BYTES, total - offset);
      const chunk = Buffer.alloc(size);
      fs.readSync(handle, chunk, 0, size, offset);

      try {
        const res = await fetch(sessionUri, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${offset}-${offset + size - 1}/${total}` },
          body: chunk,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (res.status === 308) {
          offset += size;
          options.onProgress?.(offset / total);
          continue;
        }

        if (res.status === 200 || res.status === 201) {
          const done = (await res.json()) as {
            id?: string;
            status?: { privacyStatus?: string; uploadStatus?: string; rejectionReason?: string };
          };
          if (done.id === undefined) {
            throw new YouTubeApiError('the upload finished without a video id', res.status);
          }
          options.onProgress?.(1);
          return {
            videoId: done.id,
            url: `https://www.youtube.com/watch?v=${done.id}`,
            privacyStatus: done.status?.privacyStatus ?? options.metadata.privacyStatus,
            uploadStatus: done.status?.uploadStatus ?? 'uploaded',
            rejectionReason: done.status?.rejectionReason ?? null,
          };
        }

        // Anything below 500 that is not 308 is ours to fix; retrying will not help.
        if (res.status < 500) throw new YouTubeApiError(await describe(res), res.status);
        throw new YouTubeApiError(`YouTube returned ${res.status}`, res.status);
      } catch (error) {
        const retryable = !(error instanceof YouTubeApiError) || error.status >= 500;
        failures += 1;
        if (!retryable || failures > MAX_UPLOAD_FAILURES) throw error;

        await sleep(1000 * 2 ** (failures - 1));
        offset = await committedBytes(sessionUri, total);
        options.onProgress?.(offset / total);
        log.debug(`youtube: resuming upload at ${offset}/${total}`);
      }
    }
  } finally {
    fs.closeSync(handle);
  }

  throw new YouTubeApiError('the upload ended without YouTube confirming the video', 500);
}

/**
 * A custom thumbnail on a video already uploaded.
 *
 * YouTube allows this only on a channel whose phone number is verified; an
 * unverified one answers 403, and the video is left with the frame YouTube
 * picked. The caller decides whether that is worth more than a warning.
 */
export async function setThumbnail(videoId: string, file: string, channelId?: string | null): Promise<void> {
  const token = await accessToken(channelId);
  const bytes = fs.readFileSync(file);
  const res = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'image/jpeg',
        'Content-Length': String(bytes.length),
      },
      body: bytes,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new YouTubeApiError(await describe(res), res.status);
}
