import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MODELS, PRICING_USD_PER_MTOK, assetDirs, dirs, env } from '../config.js';
import { readJson } from '../json.js';
import { countByLevel, lintBeatSheet } from '../lint.js';
import { out } from '../log.js';
import { table } from '../report.js';
import { parseBeatSheet } from '../schema.js';
import { generate } from '../providers/gemini.js';
import {
  isConfigured as youtubeConfigured,
  readConnection as youtubeConnection,
} from '../providers/youtube.js';
import { STUB_FIXTURE } from './plan.js';

type Check = { name: string; ok: boolean; detail: string; required: boolean };

export async function doctorCommand(options: { checkModel: boolean }): Promise<number> {
  const checks: Check[] = [];

  const nodeVersion = process.versions.node;
  const [nodeMajor = 0, nodeMinor = 0] = nodeVersion.split('.').map((part) => Number.parseInt(part, 10));
  checks.push({
    name: 'node',
    // 22.5 is the first with built-in SQLite, which the local database uses.
    ok: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5),
    detail: nodeVersion + (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5) ? '' : ' (needs 22.5 or newer)'),
    required: true,
  });

  checks.push(binaryCheck('ffmpeg', env.FFMPEG_BIN, ['-version']));
  checks.push(binaryCheck('ffprobe', env.FFPROBE_BIN, ['-version']));

  for (const [name, dir] of Object.entries(dirs)) {
    if (name === 'root') continue;
    checks.push(writableCheck(`dir:${name}`, dir));
  }
  for (const [name, dir] of Object.entries(assetDirs)) {
    checks.push({
      name: `assets:${name}`,
      ok: fs.existsSync(dir),
      detail: fs.existsSync(dir) ? `${countEntries(dir)} file(s)` : 'missing',
      required: false,
    });
  }

  const pricing = PRICING_USD_PER_MTOK[MODELS.llm.script];
  checks.push({
    name: 'pricing',
    ok: pricing !== undefined,
    detail:
      pricing === undefined
        ? `no entry for "${MODELS.llm.script}" in PRICING_USD_PER_MTOK; cost reporting will be wrong`
        : `${MODELS.llm.script}: $${pricing.input}/$${pricing.output} per Mtok`,
    required: false,
  });

  for (const [name, value] of [
    ['GEMINI_API_KEY', env.GEMINI_API_KEY],
    ['FLUX_API_KEY', env.FLUX_API_KEY],
    ['PEXELS_API_KEY', env.PEXELS_API_KEY],
    ['FREESOUND_API_KEY', env.FREESOUND_API_KEY],
    ['SUPABASE_URL', env.SUPABASE_URL],
    ['SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY],
    ['YOUTUBE_CLIENT_ID', env.YOUTUBE_CLIENT_ID],
    ['YOUTUBE_CLIENT_SECRET', env.YOUTUBE_CLIENT_SECRET],
  ] as const) {
    checks.push({
      name: `env:${name}`,
      ok: value !== undefined,
      detail: value === undefined ? 'not set' : `set (${value.length} chars)`,
      required: false,
    });
  }

  const supabaseReady = env.SUPABASE_URL !== undefined && env.SUPABASE_ANON_KEY !== undefined;
  checks.push({
    name: 'supabase',
    ok: supabaseReady,
    detail: supabaseReady
      ? 'configured: accounts, preferences and history'
      : 'not set; sign-in disabled, everything else unchanged (see supabase/README.md)',
    required: false,
  });

  const connection = youtubeConnection();
  checks.push({
    name: 'youtube',
    ok: youtubeConfigured() && connection !== null,
    detail: !youtubeConfigured()
      ? 'not set; publishing disabled (see youtube/README.md)'
      : connection === null
        ? 'configured, no channel connected — run: pnpm cli youtube connect'
        : `connected to ${connection.channelTitle ?? connection.channelId ?? 'a channel'}`,
    required: false,
  });

  checks.push(fixtureCheck());

  if (options.checkModel) {
    checks.push(await modelCheck());
  }

  out(
    table(
      ['check', 'status', 'detail'],
      checks.map((check) => [
        check.name,
        check.ok ? 'ok' : check.required ? 'FAIL' : 'warn',
        check.detail,
      ]),
    ),
  );

  out('');
  out(
    table(
      ['stage', 'provider', 'model'],
      [
        ['script', MODELS.llm.provider, MODELS.llm.script],
        ['voice', MODELS.tts.provider, `local ${MODELS.tts.localModel} / hosted ${MODELS.tts.hostedModel}`],
        ['align', MODELS.align.provider, MODELS.align.model],
        [
          'pictures',
          env.IMAGE_SOURCE === 'ai' ? MODELS.image.provider : 'commons',
          env.IMAGE_SOURCE === 'ai'
            ? `${MODELS.image.model} (${env.FLUX_IMAGES} per short, $${MODELS.image.usdPerImage} each)`
            : 'openly licensed stock',
        ],
        ['footage', env.FOOTAGE_PROVIDER, '-'],
      ],
    ),
  );

  const failed = checks.filter((check) => check.required && !check.ok);
  out('');
  out(failed.length === 0 ? 'doctor: ready' : `doctor: ${failed.length} required check(s) failed`);
  return failed.length === 0 ? 0 : 1;
}

function binaryCheck(name: string, bin: string, args: string[]): Check {
  const result = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined || result.status !== 0) {
    return { name, ok: false, detail: `"${bin}" not runnable`, required: true };
  }
  const firstLine = (result.stdout || result.stderr).split(/\r?\n/)[0] ?? '';
  return { name, ok: true, detail: firstLine.slice(0, 60), required: true };
}

function writableCheck(name: string, dir: string): Check {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return { name, ok: true, detail: dir, required: true };
  } catch (error) {
    return { name, ok: false, detail: `${dir}: ${(error as Error).message}`, required: true };
  }
}

async function modelCheck(): Promise<Check> {
  try {
    const response = await generate({
      model: MODELS.llm.script,
      systemInstruction: 'Reply with JSON only.',
      prompt: 'Return {"ok":true}',
      temperature: 0,
      seed: 1,
      maxOutputTokens: 32,
    });
    return {
      name: 'model:reachable',
      ok: true,
      detail: `${response.model} answered (${response.inputTokens}+${response.outputTokens} tok)`,
      required: true,
    };
  } catch (error) {
    return {
      name: 'model:reachable',
      ok: false,
      detail: `${MODELS.llm.script}: ${(error as Error).message.slice(0, 160)}`,
      required: true,
    };
  }
}

function fixtureCheck(): Check {
  try {
    const sheet = parseBeatSheet(readJson(STUB_FIXTURE));
    const counts = countByLevel(lintBeatSheet(sheet));
    return {
      name: 'fixture',
      ok: counts.warn === 0,
      detail: `stub.beatsheet.json: schema valid, ${counts.warn} warning(s)`,
      required: false,
    };
  } catch (error) {
    return { name: 'fixture', ok: false, detail: (error as Error).message, required: true };
  }
}

function countEntries(dir: string): number {
  return fs.readdirSync(dir).filter((name) => !name.startsWith('.')).length;
}
