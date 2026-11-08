import fs from 'node:fs';
import path from 'node:path';
import { assetDirs, dirs, env } from '../config.js';
import { readJson, writeJsonAtomic } from '../json.js';
import { log } from '../log.js';
import { slugify } from '../text.js';
import { suggestTopics } from '../app/topics.js';
import { produceBeatSheet } from './pipeline.js';
import { renderPicture } from './render.js';
import { mixVideo } from './mix.js';
import { publishToYouTube } from './publish.js';
import { isConnected } from '../providers/youtube.js';
import type { PrivacyStatus } from '../providers/youtube.js';

/**
 * One video a day, unattended: pick a topic nobody has used, run the whole
 * pipeline, and either publish it or leave it for review.
 *
 * Everything it has already made is the memory. There is no queue state to
 * corrupt — the history file is a log, and the guard against repeating itself
 * is the set of slugs on disk plus that log.
 */

export type AutopilotMode = 'publish' | 'hold';

export type AutopilotOptions = {
  mode: AutopilotMode;
  privacy: PrivacyStatus;
  count: number;
  dryRun: boolean;
  topic?: string;
};

export type AutopilotEntry = {
  at: string;
  topic: string;
  slug: string;
  outcome: 'published' | 'held' | 'failed';
  videoId: string | null;
  url: string | null;
  privacyStatus: string | null;
  error: string | null;
};

export type AutopilotState = {
  version: 1;
  lastRunAt: string | null;
  entries: AutopilotEntry[];
};

const STATE_FILE = path.join(dirs.work, 'autopilot.json');
const QUEUE_FILE = path.join(dirs.assets, 'topics.txt');
const HISTORY_KEEP = 400;

export function readState(): AutopilotState {
  if (!fs.existsSync(STATE_FILE)) return { version: 1, lastRunAt: null, entries: [] };
  try {
    const raw = readJson(STATE_FILE) as Partial<AutopilotState>;
    return {
      version: 1,
      lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
      entries: Array.isArray(raw.entries) ? (raw.entries as AutopilotEntry[]) : [],
    };
  } catch {
    return { version: 1, lastRunAt: null, entries: [] };
  }
}

function writeState(state: AutopilotState): void {
  writeJsonAtomic(STATE_FILE, {
    ...state,
    entries: state.entries.slice(-HISTORY_KEEP),
  });
}

/** Every slug this machine has ever planned, whether autopilot made it or not. */
export function usedSlugs(): Set<string> {
  const slugs = new Set<string>();
  if (fs.existsSync(dirs.work)) {
    for (const entry of fs.readdirSync(dirs.work, { withFileTypes: true })) {
      if (entry.isDirectory()) slugs.add(entry.name);
    }
  }
  for (const entry of readState().entries) slugs.add(entry.slug);
  return slugs;
}

/**
 * A hand-written queue wins over anything invented. Lines are consumed as they
 * are used so the file is also the record of what is left.
 */
function takeQueuedTopic(used: Set<string>, consume: boolean): string | null {
  if (!fs.existsSync(QUEUE_FILE)) return null;

  const lines = fs.readFileSync(QUEUE_FILE, 'utf8').split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const topic = raw.trim();
    if (topic === '' || topic.startsWith('#')) continue;
    if (used.has(slugify(topic))) continue;

    // Looking is not taking: `next` and a dry run must leave the queue alone.
    if (consume) {
      lines[index] = `# done ${new Date().toISOString().slice(0, 10)}  ${topic}`;
      fs.writeFileSync(QUEUE_FILE, lines.join('\n'), 'utf8');
    }
    return topic;
  }
  return null;
}

async function inventTopic(used: Set<string>): Promise<string> {
  const { topics } = await suggestTopics(10);
  for (const raw of topics) {
    const topic = raw.trim();
    if (topic === '' || used.has(slugify(topic))) continue;
    return topic;
  }
  throw new Error(
    'every suggested topic has already been made — add lines to assets/topics.txt',
  );
}

export async function nextTopic(
  used: Set<string>,
  consume = true,
): Promise<{ topic: string; from: 'queue' | 'invented' }> {
  const queued = takeQueuedTopic(used, consume);
  if (queued !== null) return { topic: queued, from: 'queue' };
  return { topic: await inventTopic(used), from: 'invented' };
}

export type CycleResult = AutopilotEntry & { from: 'queue' | 'invented' | 'given' };

/** One video, start to finish. Throws only on a problem worth stopping the batch for. */
export async function runOnce(options: AutopilotOptions): Promise<CycleResult> {
  const used = usedSlugs();
  const picked =
    options.topic === undefined
      ? await nextTopic(used, !options.dryRun)
      : { topic: options.topic, from: 'given' as const };

  const topic = picked.topic;
  const slug = slugify(topic);
  const at = new Date().toISOString();

  log.info(`autopilot: "${topic}" (${picked.from})`);

  if (options.dryRun) {
    return {
      at, topic, slug, outcome: 'held', videoId: null, url: null,
      privacyStatus: null, error: null, from: picked.from,
    };
  }

  try {
    const { sheet } = await produceBeatSheet({ topic, variant: 0, force: false });
    await renderPicture(sheet);
    await mixVideo(sheet, { force: false });

    if (options.mode === 'hold') {
      log.info(`autopilot: held "${slug}" for review — publish it yourself when ready`);
      return {
        at, topic, slug, outcome: 'held', videoId: null, url: null,
        privacyStatus: null, error: null, from: picked.from,
      };
    }

    if (!isConnected()) {
      throw new Error('no YouTube channel is connected — run: pnpm cli youtube connect');
    }

    const published = await publishToYouTube({ sheet, privacyStatus: options.privacy });
    log.info(`autopilot: published ${published.url} (${published.privacyStatus})`);

    return {
      at, topic, slug, outcome: 'published',
      videoId: published.videoId, url: published.url,
      privacyStatus: published.privacyStatus, error: null, from: picked.from,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`autopilot: "${topic}" failed — ${message}`);
    return {
      at, topic, slug, outcome: 'failed', videoId: null, url: null,
      privacyStatus: null, error: message, from: picked.from,
    };
  }
}

export async function runBatch(options: AutopilotOptions): Promise<CycleResult[]> {
  const results: CycleResult[] = [];
  const state = readState();

  for (let i = 0; i < options.count; i++) {
    const result = await runOnce(options);
    results.push(result);

    if (!options.dryRun) {
      state.entries.push(result);
      state.lastRunAt = result.at;
      writeState(state);
    }

    // A failure that will repeat — no channel, no key, no topics left — is not
    // worth burning the rest of the batch on.
    if (result.outcome === 'failed' && options.count > 1) {
      log.warn('autopilot: stopping the batch after a failure');
      break;
    }
  }
  return results;
}
