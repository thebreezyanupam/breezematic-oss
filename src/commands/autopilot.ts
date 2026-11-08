import fs from 'node:fs';
import path from 'node:path';
import { ROOT, dirs, env } from '../config.js';
import { log, out } from '../log.js';
import { table } from '../report.js';
import { isConnected, readClientConfig, readConnection } from '../providers/youtube.js';
import {
  nextTopic,
  readState,
  runBatch,
  usedSlugs,
  type AutopilotMode,
} from '../stages/autopilot.js';
import type { PrivacyStatus } from '../providers/youtube.js';

export type AutopilotOptions = {
  mode: AutopilotMode;
  privacy?: PrivacyStatus;
  count: number;
  dryRun: boolean;
  topic?: string;
};

const TASK_NAME = 'BreezeMatic Daily';

export async function autopilotRunCommand(options: AutopilotOptions): Promise<number> {
  const privacy = options.privacy ?? env.YOUTUBE_PRIVACY;

  if (options.mode === 'publish' && !isConnected()) {
    log.error('no YouTube channel is connected. Run: pnpm cli youtube connect');
    return 1;
  }

  out(`mode        ${options.mode === 'publish' ? `publish as ${privacy}` : 'render and hold'}`);
  out(`count       ${options.count}`);
  if (options.dryRun) out('dry run     nothing will be generated or sent');
  out('');

  const results = await runBatch({
    mode: options.mode,
    privacy,
    count: options.count,
    dryRun: options.dryRun,
    ...(options.topic !== undefined ? { topic: options.topic } : {}),
  });

  out('');
  out(
    table(
      ['topic', 'source', 'outcome', 'where'],
      results.map((r) => [
        r.topic.slice(0, 42),
        r.from,
        r.outcome,
        r.url ?? (r.error === null ? `out/${r.slug}.mp4` : r.error.slice(0, 46)),
      ]),
    ),
  );

  return results.some((r) => r.outcome === 'failed') ? 1 : 0;
}

export async function autopilotStatusCommand(): Promise<number> {
  const state = readState();
  const connection = readConnection();
  const client = readClientConfig();
  const queue = path.join(dirs.assets, 'topics.txt');

  let queued = 0;
  if (fs.existsSync(queue)) {
    queued = fs
      .readFileSync(queue, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#')).length;
  }

  const published = state.entries.filter((e) => e.outcome === 'published').length;
  const failed = state.entries.filter((e) => e.outcome === 'failed').length;

  out(
    table(
      ['check', 'value'],
      [
        ['last run', state.lastRunAt ?? 'never'],
        ['made so far', String(state.entries.length)],
        ['published', String(published)],
        ['failed', String(failed)],
        ['topics queued', fs.existsSync(queue) ? String(queued) : 'no assets/topics.txt'],
        ['slugs used', String(usedSlugs().size)],
        ['oauth client', client === null ? 'not set' : `${client.source} (${client.clientId.slice(0, 12)}…)`],
        ['channel', connection?.channelTitle ?? 'not connected'],
        ['default privacy', env.YOUTUBE_PRIVACY],
      ],
    ),
  );

  const recent = state.entries.slice(-8);
  if (recent.length > 0) {
    out('');
    out(
      table(
        ['when', 'topic', 'outcome', 'link'],
        recent.map((e) => [
          e.at.slice(0, 16).replace('T', ' '),
          e.topic.slice(0, 34),
          e.outcome,
          e.url ?? (e.error ?? '—').slice(0, 40),
        ]),
      ),
    );
  }
  return 0;
}

export async function autopilotNextCommand(): Promise<number> {
  const picked = await nextTopic(usedSlugs(), false);
  out(`next        ${picked.topic}`);
  out(`source      ${picked.from}`);
  out('');
  out('Nothing was generated. This only shows what a run would pick up.');
  return 0;
}

/**
 * A daily job needs something outside this process to start it — the app being
 * open is not a schedule. On Windows that is Task Scheduler, and this prints the
 * exact command rather than creating it, so nothing is registered behind you.
 */
export async function autopilotInstallCommand(at: string): Promise<number> {
  if (!/^\d{2}:\d{2}$/.test(at)) {
    log.error('time must look like 09:30');
    return 1;
  }

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const command = `${pnpm} cli autopilot run --mode publish`;

  out('Run this once, in a terminal, to have Windows start it every day:');
  out('');
  out(
    `schtasks /Create /TN "${TASK_NAME}" /TR "cmd /c cd /d ${ROOT} && ${command} >> ${path.join(ROOT, 'work', 'autopilot.log')} 2>&1" /SC DAILY /ST ${at} /F`,
  );
  out('');
  out('To check it, run it now, or remove it:');
  out('');
  out(`schtasks /Query /TN "${TASK_NAME}"`);
  out(`schtasks /Run   /TN "${TASK_NAME}"`);
  out(`schtasks /Delete /TN "${TASK_NAME}" /F`);
  out('');
  out('The machine has to be awake at that time; a scheduled task cannot wake a sleeping PC');
  out('unless you tick "Wake the computer to run this task" in Task Scheduler.');
  return 0;
}
