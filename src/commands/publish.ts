import path from 'node:path';
import { ROOT, beatSheetPath } from '../config.js';
import { readJson } from '../json.js';
import { log, out } from '../log.js';
import { table } from '../report.js';
import { parseBeatSheet } from '../schema.js';
import { slugify } from '../text.js';
import {
  authorizeUrl,
  channelInfo,
  connectWithCode,
  disconnect,
  isConfigured,
  isConnected,
  readConnection,
  type PrivacyStatus,
} from '../providers/youtube.js';
import { buildMetadata, checkEligibility, probeVideo, publishToYouTube, renderedFile } from '../stages/publish.js';
import fs from 'node:fs';

export type PublishOptions = {
  topic: string;
  privacy?: PrivacyStatus;
  title?: string;
  description?: string;
  dryRun: boolean;
  yes: boolean;
};

function loadSheet(topic: string) {
  const slug = slugify(topic);
  const file = beatSheetPath(slug);
  if (!fs.existsSync(file)) {
    throw new Error(`no beat sheet for "${topic}". Run plan and render first.`);
  }
  return parseBeatSheet(readJson(file));
}

export async function youtubeStatusCommand(): Promise<number> {
  if (!isConfigured()) {
    out('youtube     not configured');
    out('');
    out('Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env — see youtube/README.md.');
    return 0;
  }

  const connection = readConnection();
  if (connection === null) {
    out('youtube     configured, no channel connected');
    out('');
    out('Run:  pnpm cli youtube connect');
    return 0;
  }

  out(`youtube     connected`);
  out(`channel     ${connection.channelTitle ?? connection.channelId ?? 'unknown'}`);
  out(`token       refreshes automatically`);

  const live = await channelInfo().catch((error: unknown) => {
    log.warn(error instanceof Error ? error.message : String(error));
    return null;
  });
  if (live !== null) out(`verified    ${live.title} (${live.id})`);
  return 0;
}

export async function youtubeConnectCommand(code?: string): Promise<number> {
  if (code === undefined) {
    const url = authorizeUrl('cli');
    out('Open this in a browser, approve the channel, then copy the "code" value');
    out('from the URL you land on and run:');
    out('');
    out('  pnpm cli youtube connect --code <code>');
    out('');
    out(url);
    return 0;
  }

  const connection = await connectWithCode(code.trim());
  out(`connected   ${connection.channelTitle ?? connection.channelId ?? 'channel'}`);
  return 0;
}

export async function youtubeDisconnectCommand(): Promise<number> {
  await disconnect();
  out('disconnected — the stored token has been removed and revoked');
  return 0;
}

export async function publishCommand(options: PublishOptions): Promise<number> {
  const sheet = loadSheet(options.topic);
  const file = renderedFile(sheet.meta.slug);

  if (!fs.existsSync(file)) {
    log.error(`${path.relative(ROOT, file)} does not exist — render the video first.`);
    return 1;
  }

  const eligibility = checkEligibility(await probeVideo(file));
  const metadata = await buildMetadata(sheet, {
    ...(options.privacy !== undefined ? { privacyStatus: options.privacy } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  });

  const connection = readConnection();
  out(
    table(
      ['field', 'value'],
      [
        ['file', path.relative(ROOT, file)],
        ['size', `${(fs.statSync(file).size / (1024 * 1024)).toFixed(1)} MB`],
        ['frame', `${eligibility.probe.width}x${eligibility.probe.height}`],
        ['duration', `${(eligibility.probe.durationMs / 1000).toFixed(1)}s`],
        ['short', eligibility.ok ? 'yes' : 'no'],
        ['title', metadata.title],
        ['tags', metadata.tags.join(', ')],
        ['visibility', metadata.privacyStatus],
        ['channel', connection?.channelTitle ?? connection?.channelId ?? 'not connected'],
      ],
    ),
  );

  for (const reason of eligibility.reasons) out(`warning     ${reason}`);

  if (options.dryRun) {
    out('');
    out('dry run — nothing was uploaded');
    return 0;
  }

  if (!isConnected()) {
    out('');
    log.error('no channel is connected. Run: pnpm cli youtube connect');
    return 1;
  }

  // Publishing is one-way enough to be worth a deliberate second step: an
  // upload cannot be un-uploaded, only deleted after the fact.
  if (!options.yes) {
    out('');
    out('Nothing has been uploaded. Re-run with --yes to publish this to the channel above.');
    return 0;
  }

  let lastLogged = -1;
  const result = await publishToYouTube({
    sheet,
    ...(options.privacy !== undefined ? { privacyStatus: options.privacy } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    onProgress: (fraction) => {
      const percent = Math.round(fraction * 100);
      if (percent >= lastLogged + 20) {
        lastLogged = percent;
        log.info(`upload ${percent}%`);
      }
    },
  });

  out('');
  out(`video       ${result.url}`);
  out(`visibility  ${result.privacyStatus}`);
  out(`state       ${result.uploadStatus}`);
  if (result.rejectionReason !== null) out(`rejected    ${result.rejectionReason}`);
  return 0;
}
