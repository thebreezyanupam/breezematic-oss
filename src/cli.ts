#!/usr/bin/env node
import fs from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import {
  EFFECT_NAMES,
  MUSIC_LUFS_DEFAULT,
  MUSIC_LUFS_MAX,
  MUSIC_LUFS_MIN,
  MUSIC_FADE_MAX_MS,
  IMAGERY_MODES,
  IMAGE_SOURCES,
  STYLE_NAMES,
  BeatSheetValidationError,
  type EffectName,
  type ImageryMode,
  type ImageSource,
  type StyleName,
  BOARD_CONTENTS,
  BOARD_IMAGERY,
  BOARD_THEMES,
  RENDER_MODES,
  type BoardContent,
  type BoardImagery,
  type BoardTheme,
  type RenderMode,
} from './schema.js';
import { CAPTION_SCALE } from './design.js';
import { MissingApiKeyError } from './providers/errors.js';
import { CHARACTERS, isCharacter } from './voices.js';
import { TONES, isTone } from './tones.js';
import { log, setLevel, type Level } from './log.js';
import { planCommand } from './commands/plan.js';
import { validateCommand } from './commands/validate.js';
import { doctorCommand } from './commands/doctor.js';
import { cacheClearCommand, cacheStatsCommand } from './commands/cache.js';
import { pronounceCommand, scriptCommand } from './commands/script.js';
import { voiceCommand } from './commands/voice.js';
import { renderCommand, stillsCommand } from './commands/render.js';
import { mixCommand } from './commands/mix.js';
import { appCommand } from './commands/app.js';
import { loreCommand } from './commands/lore.js';
import { mimic } from './stages/mimic.js';
import { KEY_FIELDS, exportKeys, isKeyName, keyStates, parseKeysFile, saveKeys } from './keys.js';
import { SCENES } from './remotion/stickman/vocab.js';
import { AMBIENCE_NAMES, type AmbienceName } from './stages/ambience.js';
import {
  publishCommand,
  youtubeConnectCommand,
  youtubeDisconnectCommand,
  youtubeStatusCommand,
} from './commands/publish.js';
import {
  autopilotInstallCommand,
  autopilotNextCommand,
  autopilotRunCommand,
  autopilotStatusCommand,
} from './commands/autopilot.js';

const AUTOPILOT_MODES = ['publish', 'hold'] as const;

function parseAutopilotMode(value: string): (typeof AUTOPILOT_MODES)[number] {
  const mode = value.toLowerCase();
  if (!(AUTOPILOT_MODES as readonly string[]).includes(mode)) {
    throw new InvalidArgumentError(`mode must be one of ${AUTOPILOT_MODES.join(' | ')}`);
  }
  return mode as (typeof AUTOPILOT_MODES)[number];
}

const PRIVACY_LEVELS = ['private', 'unlisted', 'public'] as const;

function parsePrivacy(value: string): (typeof PRIVACY_LEVELS)[number] {
  const level = value.toLowerCase();
  if (!(PRIVACY_LEVELS as readonly string[]).includes(level)) {
    throw new InvalidArgumentError(`privacy must be one of ${PRIVACY_LEVELS.join(' | ')}`);
  }
  return level as (typeof PRIVACY_LEVELS)[number];
}

function parseEffect(value: string): EffectName {
  if (!(EFFECT_NAMES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`effect must be one of ${EFFECT_NAMES.join(' | ')}`);
  }
  return value as EffectName;
}

function parseImagery(value: string): ImageryMode {
  if (!(IMAGERY_MODES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`imagery must be one of ${IMAGERY_MODES.join(' | ')}`);
  }
  return value as ImageryMode;
}

function parseImageSource(value: string): ImageSource {
  if (!(IMAGE_SOURCES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`image source must be one of ${IMAGE_SOURCES.join(' | ')}`);
  }
  return value as ImageSource;
}

function parseImageCount(value: string): number {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new InvalidArgumentError('images must be between 1 and 16');
  }
  return count;
}

function parseCharacter(value: string): string {
  if (!isCharacter(value)) {
    throw new InvalidArgumentError(
      `voice must be one of ${CHARACTERS.map((character) => character.id).join(' | ')}`,
    );
  }
  return value;
}

function parseStyle(value: string): StyleName {
  if (!(STYLE_NAMES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`style must be one of ${STYLE_NAMES.join(' | ')}`);
  }
  return value as StyleName;
}

function parseMusicLufs(value: string): number {
  const lufs = Number.parseFloat(value);
  if (!Number.isFinite(lufs) || lufs < MUSIC_LUFS_MIN || lufs > MUSIC_LUFS_MAX) {
    throw new InvalidArgumentError(
      `music level must be between ${MUSIC_LUFS_MIN} and ${MUSIC_LUFS_MAX} LUFS`,
    );
  }
  return lufs;
}

function parseMode(value: string): string {
  if (!(RENDER_MODES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`mode must be one of ${RENDER_MODES.join(' | ')}`);
  }
  return value;
}

function parseCaptionScale(value: string): number {
  const scale = Number.parseFloat(value);
  if (!Number.isFinite(scale) || scale < CAPTION_SCALE.min || scale > CAPTION_SCALE.max) {
    throw new InvalidArgumentError(
      `caption size must be between ${CAPTION_SCALE.min} and ${CAPTION_SCALE.max}`,
    );
  }
  return scale;
}

function parseTone(value: string): string {
  if (!isTone(value)) {
    throw new InvalidArgumentError(`tone must be one of ${TONES.map((t) => t.id).join(' | ')}`);
  }
  return value;
}

function parseMs(label: string, max: number) {
  return (value: string): number => {
    const ms = Math.round(Number.parseFloat(value));
    if (!Number.isFinite(ms) || ms < 0 || ms > max) {
      throw new InvalidArgumentError(`${label} must be between 0 and ${max} ms`);
    }
    return ms;
  };
}

function parseSeed(value: string): number {
  const seed = Number.parseInt(value, 10);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new InvalidArgumentError('seed must be a non-negative integer');
  }
  return seed;
}

function parseVariant(value: string): number {
  const index = Number.parseInt(value, 10);
  if (!Number.isInteger(index) || index < 0 || index > 9) {
    throw new InvalidArgumentError('variant must be between 0 and 9');
  }
  return index;
}

function parseCount(value: string): number {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new InvalidArgumentError('variants must be between 1 and 10');
  }
  return count;
}

async function run(action: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await action();
  } catch (error) {
    if (error instanceof BeatSheetValidationError || error instanceof MissingApiKeyError) {
      log.error(error.message);
    } else {
      log.error(error instanceof Error ? error : String(error));
    }
    process.exitCode = 1;
  }
}

const program = new Command();

program
  .name('breezematic')
  .description('Topic to publish-ready 9:16 kinetic-typography short')
  .version('0.1.0')
  .option('--log-level <level>', 'error | warn | info | debug')
  .hook('preAction', (command) => {
    const level = command.opts()['logLevel'] as Level | undefined;
    if (level !== undefined) setLevel(level);
  });

program
  .command('plan')
  .description('Script -> voice -> alignment -> beat sheet')
  .requiredOption('--topic <topic>', 'topic the short is about')
  .option('--seed <n>', 'deterministic seed (defaults to a hash of the slug)', parseSeed)
  .option('--variant <n>', 'which script draft to use', parseVariant, 0)
  .option('--out <file>', 'write the beat sheet here instead of work/<slug>/beatsheet.json')
  .option(
    '--script-file <file>',
    'narration to use instead of generating: one beat per line, first line is the hook, *word* marks emphasis',
  )
  .option('--no-adapt', 'use --script-file exactly as written, without shaping it into beats')
  .option('--effect <name>', EFFECT_NAMES.join(' | '), parseEffect)
  .option('--music <file>', 'a filename from assets/music, or "none"')
  .option(
    '--music-level <lufs>',
    `how loud the bed sits, ${MUSIC_LUFS_MIN} to ${MUSIC_LUFS_MAX} LUFS (default ${MUSIC_LUFS_DEFAULT})`,
    parseMusicLufs,
  )
  .option('--music-fade-in <ms>', 'bed fade in, in ms', parseMs('fade in', MUSIC_FADE_MAX_MS))
  .option('--music-fade-out <ms>', 'bed fade out, in ms', parseMs('fade out', MUSIC_FADE_MAX_MS))
  .option('--music-start <ms>', 'where in the track to start, in ms', parseMs('music start', 3_600_000))
  .option('--tone <name>', TONES.map((t) => t.id).join(' | '), parseTone)
  .option('--imagery <mode>', IMAGERY_MODES.join(' | '), parseImagery)
  .option('--image-source <name>', `${IMAGE_SOURCES.join(' | ')} (ai is metered per image)`, parseImageSource)
  .option('--images <n>', 'how many pictures to generate and deal across the beats', parseImageCount)
  .option('--brief <text>', 'what the topic means and what kind of video you want')
  .option('--mode <name>', RENDER_MODES.join(' | '), parseMode)
  .option('--board-texture', 'whiteboard: lay the effect field under the paper', false)
  .option('--board-theme <name>', BOARD_THEMES.join(' | '), (v: string) => {
    if (!(BOARD_THEMES as readonly string[]).includes(v)) {
      throw new InvalidArgumentError(`board theme must be ${BOARD_THEMES.join(' | ')}`);
    }
    return v;
  })
  .option('--board-content <name>', BOARD_CONTENTS.join(' | '), (v: string) => {
    if (!(BOARD_CONTENTS as readonly string[]).includes(v)) {
      throw new InvalidArgumentError(`board content must be ${BOARD_CONTENTS.join(' | ')}`);
    }
    return v;
  })
  .option('--board-imagery <name>', BOARD_IMAGERY.join(' | '), (v: string) => {
    if (!(BOARD_IMAGERY as readonly string[]).includes(v)) {
      throw new InvalidArgumentError(`board imagery must be ${BOARD_IMAGERY.join(' | ')}`);
    }
    return v;
  })
  .option('--style <name>', STYLE_NAMES.join(' | '), parseStyle)
  .option(
    '--caption-size <n>',
    `how large the type runs, ${CAPTION_SCALE.min} to ${CAPTION_SCALE.max} (default ${CAPTION_SCALE.default})`,
    parseCaptionScale,
  )
  .option('--force', 'ignore cached stage output', false)
  .option('--strict', 'exit non-zero on lint warnings', false)
  .option('--decisions', 'explain why each beat got its template and motion', false)
  .option('--no-table', 'skip the per-beat table')
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      planCommand({
        topic: options['topic'] as string,
        ...(options['seed'] !== undefined ? { seed: options['seed'] as number } : {}),
        ...(options['out'] !== undefined ? { out: options['out'] as string } : {}),
        ...(options['scriptFile'] !== undefined
          ? { scriptFile: options['scriptFile'] as string }
          : {}),
        ...(options['effect'] !== undefined ? { effect: options['effect'] as EffectName } : {}),
        ...(options['music'] !== undefined ? { music: options['music'] as string } : {}),
        ...(typeof options['brief'] === 'string' ? { brief: options['brief'] } : {}),
        ...(options['mode'] !== undefined ? { mode: options['mode'] as RenderMode } : {}),
        ...(options['boardTexture'] === true ? { boardTexture: true } : {}),
        ...(options['boardTheme'] !== undefined ? { boardTheme: options['boardTheme'] as BoardTheme } : {}),
        ...(options['boardContent'] !== undefined ? { boardContent: options['boardContent'] as BoardContent } : {}),
        ...(options['boardImagery'] !== undefined ? { boardImagery: options['boardImagery'] as BoardImagery } : {}),
        ...(options['captionSize'] !== undefined
          ? { captionScale: options['captionSize'] as number }
          : {}),
        ...(options['musicLevel'] !== undefined
          ? { musicLufs: options['musicLevel'] as number }
          : {}),
        ...(options['musicFadeIn'] !== undefined
          ? { musicFadeInMs: options['musicFadeIn'] as number }
          : {}),
        ...(options['musicFadeOut'] !== undefined
          ? { musicFadeOutMs: options['musicFadeOut'] as number }
          : {}),
        ...(options['musicStart'] !== undefined
          ? { musicStartMs: options['musicStart'] as number }
          : {}),
        ...(options['tone'] !== undefined ? { tone: options['tone'] as string } : {}),
        ...(options['imagery'] !== undefined
          ? { imagery: options['imagery'] as ImageryMode }
          : {}),
        ...(options['imageSource'] !== undefined
          ? { imageSource: options['imageSource'] as ImageSource }
          : {}),
        ...(options['images'] !== undefined ? { imageCount: options['images'] as number } : {}),
        ...(options['style'] !== undefined ? { style: options['style'] as StyleName } : {}),
        adapt: options['adapt'] !== false,
        variant: options['variant'] as number,
        force: options['force'] === true,
        strict: options['strict'] === true,
        decisions: options['decisions'] === true,
        table: options['table'] !== false,
      }),
    );
  });

program
  .command('script')
  .description('Generate narration drafts for a topic')
  .requiredOption('--topic <topic>', 'topic the short is about')
  .option('--seed <n>', 'deterministic seed (defaults to a hash of the slug)', parseSeed)
  .option('--variants <n>', 'how many drafts to generate', parseCount, 1)
  .option('--force', 'ignore cached stage output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      scriptCommand({
        topic: options['topic'] as string,
        ...(options['seed'] !== undefined ? { seed: options['seed'] as number } : {}),
        variants: options['variants'] as number,
        force: options['force'] === true,
      }),
    );
  });

program
  .command('voice')
  .description('Script -> Kokoro TTS -> whisper.cpp word timings')
  .requiredOption('--topic <topic>', 'topic the short is about')
  .option('--seed <n>', 'deterministic seed (defaults to a hash of the slug)', parseSeed)
  .option('--variant <n>', 'which script draft to speak', parseVariant, 0)
  .option('--force', 'ignore cached stage output', false)
  .option('--no-table', 'skip the per-word table')
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      voiceCommand({
        topic: options['topic'] as string,
        ...(options['seed'] !== undefined ? { seed: options['seed'] as number } : {}),
        variant: options['variant'] as number,
        force: options['force'] === true,
        table: options['table'] !== false,
      }),
    );
  });

program
  .command('publish')
  .description('Upload a rendered short to the connected YouTube channel')
  .requiredOption('--topic <topic>', 'topic of the short to publish')
  .option('--privacy <level>', 'private | unlisted | public', parsePrivacy)
  .option('--title <text>', 'override the generated title')
  .option('--description <text>', 'override the generated description')
  .option('--dry-run', 'show exactly what would be sent and stop', false)
  .option('--yes', 'actually upload; without it nothing is sent', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      publishCommand({
        topic: options['topic'] as string,
        ...(options['privacy'] !== undefined
          ? { privacy: options['privacy'] as 'private' | 'unlisted' | 'public' }
          : {}),
        ...(options['title'] !== undefined ? { title: options['title'] as string } : {}),
        ...(options['description'] !== undefined
          ? { description: options['description'] as string }
          : {}),
        dryRun: options['dryRun'] === true,
        yes: options['yes'] === true,
      }),
    );
  });

const autopilot = program
  .command('autopilot')
  .description('Make (and optionally publish) a short without being asked');

autopilot
  .command('run')
  .description('Run one cycle now: pick a topic, make the video, publish or hold it')
  .option('--mode <mode>', 'publish | hold', parseAutopilotMode, 'hold')
  .option('--privacy <level>', 'private | unlisted | public', parsePrivacy)
  .option('--count <n>', 'how many to make in this run', parseCount, 1)
  .option('--topic <topic>', 'use this topic instead of picking one')
  .option('--dry-run', 'show what it would pick and stop', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      autopilotRunCommand({
        mode: options['mode'] as 'publish' | 'hold',
        ...(options['privacy'] !== undefined
          ? { privacy: options['privacy'] as 'private' | 'unlisted' | 'public' }
          : {}),
        count: options['count'] as number,
        ...(options['topic'] !== undefined ? { topic: options['topic'] as string } : {}),
        dryRun: options['dryRun'] === true,
      }),
    );
  });

autopilot
  .command('status', { isDefault: true })
  .description('What it has made, what is queued, and whether it can publish')
  .action(async () => {
    await run(() => autopilotStatusCommand());
  });

autopilot
  .command('next')
  .description('Show the topic the next run would pick, without making anything')
  .action(async () => {
    await run(() => autopilotNextCommand());
  });

autopilot
  .command('install')
  .description('Print the Windows Task Scheduler command for a daily run')
  .option('--at <hh:mm>', 'local time to run', '09:00')
  .action(async (options: Record<string, unknown>) => {
    await run(() => autopilotInstallCommand(options['at'] as string));
  });

const youtube = program.command('youtube').description('Manage the YouTube channel connection');

youtube
  .command('status', { isDefault: true })
  .description('Show whether a channel is connected')
  .action(async () => {
    await run(() => youtubeStatusCommand());
  });

youtube
  .command('connect')
  .description('Link a channel; without --code it prints the URL to approve')
  .option('--code <code>', 'the code Google returned on the redirect')
  .action(async (options: Record<string, unknown>) => {
    await run(() => youtubeConnectCommand(options['code'] as string | undefined));
  });

youtube
  .command('disconnect')
  .description('Forget and revoke the stored token')
  .action(async () => {
    await run(() => youtubeDisconnectCommand());
  });

program
  .command('pronounce')
  .description('Show the spoken form the TTS stage will receive')
  .argument('<text...>', 'text to expand')
  .action(async (parts: string[]) => {
    await run(() => pronounceCommand(parts.join(' ')));
  });

program
  .command('stills')
  .description('Render one still frame per template for review')
  .requiredOption('--topic <topic>', 'topic the short is about')
  // Presentation only. The sheet keeps its beats; these say how it is drawn,
  // so a look can be tried without regenerating the script and the voice.
  .option('--mode <name>', RENDER_MODES.join(' | '), parseMode)
  .option('--board-theme <name>', BOARD_THEMES.join(' | '))
  .option('--board-content <name>', BOARD_CONTENTS.join(' | '))
  .option('--board-imagery <name>', BOARD_IMAGERY.join(' | '))
  .option('--board-texture', 'lay the effect field under the paper', false)
  .option('--seed <n>', 'deterministic seed', parseSeed)
  .option('--variant <n>', 'which script draft to use', parseVariant, 0)
  .option('--force', 'ignore cached stage output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      stillsCommand({
        topic: options['topic'] as string,
        ...(options['seed'] !== undefined ? { seed: options['seed'] as number } : {}),
        ...(options['mode'] !== undefined ? { mode: options['mode'] as RenderMode } : {}),
        ...(options['boardTheme'] !== undefined ? { boardTheme: options['boardTheme'] as BoardTheme } : {}),
        ...(options['boardContent'] !== undefined ? { boardContent: options['boardContent'] as BoardContent } : {}),
        ...(options['boardImagery'] !== undefined ? { boardImagery: options['boardImagery'] as BoardImagery } : {}),
        ...(options['boardTexture'] === true ? { boardTexture: true } : {}),
        variant: options['variant'] as number,
        force: options['force'] === true,
      }),
    );
  });

program
  .command('render')
  .description('Render the silent picture track with Remotion')
  .requiredOption('--topic <topic>', 'topic the short is about')
  .option('--seed <n>', 'deterministic seed', parseSeed)
  .option('--variant <n>', 'which script draft to use', parseVariant, 0)
  .option('--force', 'ignore cached stage output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      renderCommand({
        topic: options['topic'] as string,
        ...(options['seed'] !== undefined ? { seed: options['seed'] as number } : {}),
        variant: options['variant'] as number,
        force: options['force'] === true,
      }),
    );
  });

program
  .command('mix')
  .description('Sound design and mastering: narration, music duck, SFX bed, final MP4')
  .requiredOption('--topic <topic>', 'topic the short is about')
  .option('--seed <n>', 'deterministic seed', parseSeed)
  .option('--variant <n>', 'which script draft to use', parseVariant, 0)
  .option('--force', 'ignore cached stage output', false)
  .option('--no-table', 'skip the per-cue SFX table')
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      mixCommand({
        topic: options['topic'] as string,
        ...(options['seed'] !== undefined ? { seed: options['seed'] as number } : {}),
        variant: options['variant'] as number,
        force: options['force'] === true,
        table: options['table'] !== false,
      }),
    );
  });


const keys = program.command('keys').description('The API keys the app uses (the same ones as Settings in the app)');

keys
  .command('list', { isDefault: true })
  .description('Show which keys are set, and where each comes from')
  .action(async () => {
    await run(async () => {
      for (const key of keyStates()) {
        const state = key.set ? `${key.source === 'app' ? 'saved' : '.env'} ${key.shown}` : 'not set';
        process.stdout.write(`${key.name.padEnd(20)} ${state.padEnd(18)} ${key.enables}
`);
      }
      return 0;
    });
  });

keys
  .command('set')
  .description(`Save a key: ${KEY_FIELDS.map((field) => field.name).join(', ')}`)
  .argument('<name>')
  .argument('<value>')
  .action(async (name: string, value: string) => {
    await run(async () => {
      if (!isKeyName(name)) throw new InvalidArgumentError(`unknown key ${name}`);
      saveKeys({ [name]: value });
      process.stdout.write(`saved ${name}
`);
      return 0;
    });
  });

keys
  .command('export')
  .description('Write every key in effect to a .env file (keep it private)')
  .argument('[file]', 'where to write it', 'breezematic-keys.env')
  .action(async (file: string) => {
    await run(async () => {
      fs.writeFileSync(file, exportKeys(), { encoding: 'utf8', mode: 0o600 });
      process.stdout.write(`wrote ${file}\n`);
      return 0;
    });
  });

keys
  .command('import')
  .description('Save every key found in a .env file')
  .argument('<file>')
  .action(async (file: string) => {
    await run(async () => {
      const changed = saveKeys(parseKeysFile(fs.readFileSync(file, 'utf8')));
      process.stdout.write(changed.length === 0 ? 'no keys found\n' : `imported ${changed.join(', ')}\n`);
      return 0;
    });
  });

keys
  .command('unset')
  .description('Remove a saved key (one in .env stays)')
  .argument('<name>')
  .action(async (name: string) => {
    await run(async () => {
      if (!isKeyName(name)) throw new InvalidArgumentError(`unknown key ${name}`);
      saveKeys({ [name]: '' });
      process.stdout.write(`removed ${name}
`);
      return 0;
    });
  });

program
  .command('mimic')
  .description('Animate the movement in a reference clip: the stick figure performs it in a drawn scene')
  .argument('<clip>', 'a video file, or a URL to one (Pexels download links work)')
  .option('--scene <name>', `where it happens: ${SCENES.join(', ')}`, 'stage')
  .option('--seed <n>', 'deterministic seed', parseSeed)
  .option('--out <file>', 'where to write the MP4')
  .action(async (clip: string, options: Record<string, unknown>) => {
    await run(async () => {
      await mimic({
        clip,
        scene: options['scene'] as string,
        ...(options['seed'] !== undefined ? { seed: options['seed'] as number } : {}),
        ...(options['out'] !== undefined ? { out: options['out'] as string } : {}),
      });
      return 0;
    });
  });

program
  .command('lore')
  .description('Long-form original lore for sleep listening')
  .requiredOption('--topic <topic>', 'a seed for the world, not a title')
  .option('--minutes <n>', 'target runtime in minutes', (v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 2 || n > 240) {
      throw new InvalidArgumentError('minutes must be between 2 and 240');
    }
    return n;
  }, 20)
  .option('--seed <n>', 'deterministic seed (defaults to a hash of the slug)', parseSeed)
  .option('--voice <name>', CHARACTERS.map((c) => c.id).join(' | '), parseCharacter)
  .option('--bed <name>', AMBIENCE_NAMES.join(' | '), (v: string) => {
    if (!(AMBIENCE_NAMES as readonly string[]).includes(v)) {
      throw new InvalidArgumentError(`bed must be one of ${AMBIENCE_NAMES.join(' | ')}`);
    }
    return v;
  })
  .option('--generated', 'make the picture with the image model instead of finding one', false)
  .option('--force', 'ignore cached stage output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      loreCommand({
        topic: options['topic'] as string,
        minutes: options['minutes'] as number,
        ...(options['generated'] === true ? { generated: true } : {}),
        ...(options['bed'] !== undefined ? { bed: options['bed'] as AmbienceName } : {}),
        force: options['force'] === true,
        ...(options['seed'] !== undefined ? { seed: options['seed'] as number } : {}),
        ...(options['voice'] !== undefined ? { character: options['voice'] as string } : {}),
      }),
    );
  });
program
  .command('app')
  .description('Local topic-submit UI over the same stage functions')
  .option('--port <n>', 'listen port (default BREEZEMATIC_APP_PORT / 4747)', (value: string) => {
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new InvalidArgumentError('port must be between 1 and 65535');
    }
    return port;
  })
  .option('--host <host>', 'bind address (0.0.0.0 inside Docker)', '127.0.0.1')
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      appCommand({
        ...(options['port'] !== undefined ? { port: options['port'] as number } : {}),
        host: options['host'] as string,
      }),
    );
  });

program
  .command('validate')
  .description('Validate a hand-edited beat sheet against the schema and style rules')
  .argument('<file>', 'path to a beat sheet JSON file')
  .option('--strict', 'exit non-zero on lint warnings', false)
  .option('--check-files', 'also verify referenced audio assets exist', false)
  .option('--no-table', 'skip the per-beat table')
  .action(async (file: string, options: Record<string, unknown>) => {
    await run(() =>
      validateCommand(file, {
        strict: options['strict'] === true,
        checkFiles: options['checkFiles'] === true,
        table: options['table'] !== false,
      }),
    );
  });

program
  .command('assets')
  .description('Download and build the sound effects and icons the war videos use (free, licence-checked)')
  .option('--only <kinds>', 'rebuild only these sound kinds, comma separated')
  .option('--no-icons', 'skip the icons')
  .action(async (options: Record<string, unknown>) => {
    await run(async () => {
      const { buildSoundLibrary } = await import('./assets/fetch.js');
      const { buildIcons } = await import('./assets/icons.js');
      const { isSoundKind } = await import('./assets/library.js');
      const only =
        typeof options['only'] === 'string'
          ? options['only'].split(',').map((kind) => kind.trim()).filter(isSoundKind)
          : undefined;
      await buildSoundLibrary(only === undefined ? {} : { only });
      if (options['icons'] !== false) await buildIcons();
      return 0;
    });
  });

program
  .command('doctor')
  .description('Check binaries, directories, provider config and the bundled fixture')
  .option('--check-model', 'also send a minimal request to confirm the LLM model still exists', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() => doctorCommand({ checkModel: options['checkModel'] === true }));
  });

const cacheCommand = program.command('cache').description('Inspect or clear the stage cache');

cacheCommand
  .command('stats', { isDefault: true })
  .description('Show cached entries per stage')
  .action(async () => {
    await run(() => cacheStatsCommand());
  });

cacheCommand
  .command('clear')
  .description('Delete cached stage output')
  .argument('[namespace]', 'stage namespace, or all namespaces when omitted')
  .action(async (namespace: string | undefined) => {
    await run(() => cacheClearCommand(namespace));
  });

await program.parseAsync(process.argv);
