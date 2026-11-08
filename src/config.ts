import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === '') continue;
    process.env[key] = value;
  }
}

/** Set in the shell or the process manager: these win over every file. */
const FROM_SHELL = new Set(Object.keys(process.env));

loadDotEnv(path.join(ROOT, '.env'));

/**
 * Keys saved from the app's Settings screen (keys.ts). Kept out of .cache,
 * which `cache clear` empties, and out of .env, which people edit by hand.
 */
export const KEYS_FILE = path.join(ROOT, '.local', 'keys.json');

/** The environment before saved keys were laid over it: what a removed key falls back to. */
export const UNSAVED_ENV: Readonly<Record<string, string | undefined>> = { ...process.env };

function loadSavedKeys(file: string): void {
  if (!fs.existsSync(file)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [key, value] of Object.entries(saved)) {
      if (FROM_SHELL.has(key) || typeof value !== 'string' || value.trim() === '') continue;
      process.env[key] = value.trim();
    }
  } catch {
    // A damaged file is the same as no saved keys; the screen can save again.
  }
}

loadSavedKeys(KEYS_FILE);

const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  BREEZEMATIC_WORK_DIR: z.string().default('work'),
  BREEZEMATIC_OUT_DIR: z.string().default('out'),
  BREEZEMATIC_CACHE_DIR: z.string().default('.cache'),
  BREEZEMATIC_ASSETS_DIR: z.string().default('assets'),

  LLM_PROVIDER: z.enum(['gemini']).default('gemini'),
  TTS_PROVIDER: z.enum(['kokoro', 'gemini', 'elevenlabs']).default('kokoro'),
  /** Only read when TTS_PROVIDER is gemini. */
  /**
   * 2.5 rather than 3.1, measured rather than assumed. On the same 92-word
   * script both produced a read of the same length -- 39.3s against 40.8s --
   * but 3.1 spent 1305 audio tokens against 982, and is billed at twice the
   * rate per token. That is 2.6x the cost for output of the same duration.
   * Override it if you can hear the difference; the measurement says the
   * cheaper one is the default.
   */
  GEMINI_TTS_MODEL: z.string().min(1).default('gemini-2.5-flash-preview-tts'),
  /**
   * A delivery note prepended to every passage. This model takes direction in
   * the prompt rather than as a parameter, so this is where a house read is
   * set: pace, warmth, how much it leans on the emphasis.
   */
  GEMINI_TTS_STYLE: z
    .string()
    .default('Read the following aloud as a narrator for a short documentary video. ' +
             'Natural pace, warm and clear, land the emphasis but never shout:'),
  ALIGN_PROVIDER: z.enum(['whisper-cpp']).default('whisper-cpp'),
  FOOTAGE_PROVIDER: z.enum(['pexels']).default('pexels'),

  GEMINI_API_KEY: optionalSecret,

  /**
   * ElevenLabs: a fixed voice, the same speaker on every request.
   *
   * Multilingual v2 by default, because it is the one that sounds like a
   * person narrating. v3 acts harder -- it will land a punchline -- but on
   * straight narration it wanders: stresses in odd places, a different energy
   * from one sentence to the next, which reads as synthetic precisely because
   * no narrator does it. Set "eleven_v3" here to have it back.
   */
  ELEVENLABS_API_KEY: optionalSecret,
  ELEVENLABS_MODEL: z.string().min(1).default('eleven_multilingual_v2'),
  /** Delivery speed, 0.7 to 1.2, asked of the model rather than stretched afterwards. */
  ELEVENLABS_SPEED: z.coerce.number().min(0.7).max(1.2).default(1),
  /** How much of the voice's own style to lean into, 0 to 1. Above about 0.4 it starts to perform. */
  ELEVENLABS_STYLE: z.coerce.number().min(0).max(1).default(0.25),
  /** The voice to read with when a run does not choose one. */
  ELEVENLABS_VOICE: z.string().optional(),
  /**
   * How closely the read sticks to the voice, 0 to 1. Unset: 0.5 on v3
   * ("natural"). An instant clone made from one short sample can wander into
   * an accent that is not its own at 0.5; 1.0 ("robust") holds it, at the
   * cost of some acting.
   */
  ELEVENLABS_STABILITY: z.coerce.number().min(0).max(1).optional(),
  /** List price, for the spend log. A plan's included characters make it cheaper. */
  ELEVENLABS_USD_PER_1K_CHARS: z.coerce.number().min(0).default(0.1),
  GEMINI_SCRIPT_MODEL: z.string().min(1).default('gemini-3.1-flash-lite'),

  PEXELS_API_KEY: optionalSecret,
  FREESOUND_API_KEY: optionalSecret,

  // Pictures. 'stock' is openly licensed photography off Wikimedia Commons and
  // costs nothing; 'ai' is FLUX.1 [schnell], which is metered per image.
  IMAGE_SOURCE: z.enum(['stock', 'ai']).default('stock'),
  FLUX_API_KEY: optionalSecret,
  /** Free generated pictures: Cloudflare Workers AI (providers/cloudflare.ts). */
  CLOUDFLARE_ACCOUNT_ID: optionalSecret,
  CLOUDFLARE_API_TOKEN: optionalSecret,
  /**
   * Voice cloning runs on the same fal key as the pictures, so there is no
   * second vendor and no second secret. The price per billed unit is the one
   * number this cannot discover for itself -- fal reports how many units a
   * call used, which is the half that matters, and what a unit costs is on the
   * invoice.
   */
  CLONE_MODEL: z.string().min(1).default('fal-ai/chatterbox/text-to-speech'),
  CLONE_USD_PER_UNIT: z.coerce.number().min(0).default(0.02),
  /** How much the reading leans into the emotion of a line. 0.5 is level. */
  CLONE_EXAGGERATION: z.coerce.number().min(0).max(1).default(0.45),
  CLONE_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  FLUX_ENDPOINT: z.string().min(1).default('https://fal.run'),
  FLUX_MODEL: z.string().min(1).default('fal-ai/flux/schnell'),
  // Left unset it follows the model: schnell is distilled for four, everything
  // else wants roughly thirty and looks muddy at four.
  FLUX_STEPS: z.coerce.number().int().min(1).max(50).optional(),
  // Flux is trained around a megapixel. A full 1080x1920 is 2.1MP, far enough
  // past that to start duplicating limbs and doubling horizons; 864x1536 is
  // exactly 9:16, well inside the range, and still more than a background that
  // gets blurred and scrimmed will ever need.
  FLUX_WIDTH: z.coerce.number().int().min(256).max(2048).default(864),
  FLUX_HEIGHT: z.coerce.number().int().min(256).max(2048).default(1536),
  /** A short has 10-16 beats; images are dealt across them rather than one each. */
  FLUX_IMAGES: z.coerce.number().int().min(1).max(16).default(6),
  FLUX_USD_PER_IMAGE: z.coerce.number().min(0).default(0.003),

  // Accounts, preferences and project history. Never video.
  SUPABASE_URL: optionalSecret,
  SUPABASE_ANON_KEY: optionalSecret,

  // Publishing to YouTube. Optional: unset, nothing here ever contacts Google.
  // An OAuth client of type "Web application" — the desktop type refuses the
  // loopback redirect this uses. See youtube/README.md.
  YOUTUBE_CLIENT_ID: optionalSecret,
  YOUTUBE_CLIENT_SECRET: optionalSecret,
  /** Must match a redirect URI registered on the OAuth client, character for character. */
  YOUTUBE_REDIRECT_URI: z.string().min(1).default('http://localhost:4747/api/youtube/callback'),
  /**
   * Only the value the publish form opens on. Nothing is ever sent without
   * someone choosing to send it, and private is the setting you cannot regret.
   */
  YOUTUBE_PRIVACY: z.enum(['private', 'unlisted', 'public']).default('private'),
  /**
   * The category an upload goes up under when the page does not choose one.
   * 27 = Education, 24 = Entertainment, 23 = Comedy, 22 = People & Blogs.
   * Education: true stories told with sources are what it is for, and
   * People & Blogs is the vlog shelf -- the wrong signal for these videos.
   */
  YOUTUBE_CATEGORY_ID: z.string().regex(/^\d+$/).default('27'),

  // Publishing to a Facebook Page. Optional: unset, nothing here contacts Meta.
  // A Meta app of type "Consumer" or "Business" with Facebook Login added; the
  // app may stay in development, which is enough to post to a Page you admin.
  FACEBOOK_APP_ID: optionalSecret,
  FACEBOOK_APP_SECRET: optionalSecret,
  /** Must be listed under Facebook Login > Valid OAuth Redirect URIs, exactly. */
  FACEBOOK_REDIRECT_URI: z
    .string()
    .min(1)
    .default('http://localhost:4747/api/facebook/callback'),
  /**
   * Only what the publish form opens on. Unpublished puts the video on the Page
   * without showing it to anyone, which is the setting you cannot regret.
   */
  FACEBOOK_PUBLISHED: z.coerce.boolean().default(false),

  KOKORO_MODEL: z.string().min(1).default('onnx-community/Kokoro-82M-v1.0-ONNX'),
  /**
   * fp32, and not for the reason quantisation usually gets chosen.
   *
   * q8 was the default on the assumption that a smaller model is a faster one.
   * Measured on this machine, reading the same six sentences:
   *
   *     q8      1.36x realtime      q4f16   0.60x realtime
   *     q4      0.55x realtime      fp32    0.57x realtime
   *
   * The quantised model is two and a half times SLOWER than the unquantised
   * one. int8 needs kernels the CPU does not have for these ops, so every
   * layer pays a quantise/dequantise round trip that the fp32 path simply does
   * not have. fp32 is therefore both the fastest option and the reference
   * quality -- a half-hour reading becomes twelve minutes and sounds better.
   *
   * The cost is the download: roughly 330MB against 86MB, once.
   */
  KOKORO_DTYPE: z.enum(['fp32', 'fp16', 'q8', 'q4', 'q4f16']).default('fp32'),
  /** Who reads by default; see src/voices.ts for the roster. */
  VOICE_CHARACTER: z.string().min(1).default('rae'),
  /** Only consulted when VOICE_CHARACTER names nobody: a raw engine voice id. */
  KOKORO_VOICE: z
    .enum([
      'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole',
      'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir',
      'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_emma', 'bf_isabella',
      'bf_alice', 'bf_lily', 'bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable',
    ])
    .default('af_heart'),

  WHISPER_MODEL: z
    .enum([
      'tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en',
      'medium', 'medium.en', 'large-v1', 'large-v2', 'large-v3', 'large-v3-turbo',
    ])
    .default('base.en'),
  WHISPER_CPP_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.7.6'),

  FFMPEG_BIN: z.string().min(1).default('ffmpeg'),
  FFPROBE_BIN: z.string().min(1).default('ffprobe'),

  COST_CEILING_USD: z.coerce.number().positive().default(0.02),

  BREEZEMATIC_APP_PORT: z.coerce.number().int().min(1).max(65535).default(4747),

  MUSIC_BPM: z.coerce.number().min(60).max(200).default(120),
});

export type Env = z.infer<typeof envSchema>;

/**
 * The tool was called kinetic before it was called BreezeMatic, and the old
 * KINETIC_* names are sitting in .env files that already work. Reading them as
 * fallbacks means the rename costs nobody a broken config; BREEZEMATIC_* wins
 * wherever both are set.
 */
function withLegacyNames(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('KINETIC_') || value === undefined) continue;
    const renamed = `BREEZEMATIC_${key.slice('KINETIC_'.length)}`;
    if (merged[renamed] === undefined) merged[renamed] = value;
  }
  return merged;
}

const parsed = envSchema.safeParse(withLegacyNames(process.env));
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment:\n${issues}`);
}

export const env: Env = parsed.data;

export const dirs = {
  root: ROOT,
  work: path.resolve(ROOT, env.BREEZEMATIC_WORK_DIR),
  out: path.resolve(ROOT, env.BREEZEMATIC_OUT_DIR),
  cache: path.resolve(ROOT, env.BREEZEMATIC_CACHE_DIR),
  assets: path.resolve(ROOT, env.BREEZEMATIC_ASSETS_DIR),
} as const;

export const assetDirs = {
  bg: path.join(dirs.assets, 'bg'),
  music: path.join(dirs.assets, 'music'),
  sfx: path.join(dirs.assets, 'sfx'),
  /** The reference recording a cloned voice is built from. */
  voice: path.join(dirs.assets, 'voice'),
  fonts: path.join(dirs.assets, 'fonts'),
  /**
   * Media you supplied for one video, under a folder named after its slug.
   * Anything in here outranks every source the tool has, in every mode.
   */
  own: path.join(dirs.assets, 'own'),
} as const;

export function workDir(slug: string): string {
  return path.join(dirs.work, slug);
}

export function beatSheetPath(slug: string): string {
  return path.join(workDir(slug), 'beatsheet.json');
}

/** Beat sheet paths are stored repo-relative so a sheet stays portable. */
export function resolveFromRoot(target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(ROOT, target);
}

export const MODELS = {
  llm: {
    provider: env.LLM_PROVIDER,
    script: env.GEMINI_SCRIPT_MODEL,
  },
  tts: {
    provider: env.TTS_PROVIDER,
    /**
     * Both models, unconditionally. An earlier version resolved a single
     * `model` from TTS_PROVIDER, which broke the moment the provider became a
     * per-run choice: with the machine defaulting to local and a run asking for
     * the hosted engine, it sent the HuggingFace repo name as the hosted model
     * id and got a 404. Neither engine may be described by the other's setting.
     */
    localModel: env.KOKORO_MODEL,
    hostedModel: env.GEMINI_TTS_MODEL,
    style: env.GEMINI_TTS_STYLE,
    dtype: env.KOKORO_DTYPE,
    /** The fallback voice. A character normally decides this per run. */
    voice: env.KOKORO_VOICE,
    character: env.VOICE_CHARACTER,
  },
  align: {
    provider: env.ALIGN_PROVIDER,
    model: env.WHISPER_MODEL,
    whisperCppVersion: env.WHISPER_CPP_VERSION,
  },
  image: {
    provider: 'flux',
    model: env.FLUX_MODEL,
    usdPerImage: env.FLUX_USD_PER_IMAGE,
  },
} as const;

/** Steps, from the setting if there is one and from the model if there is not. */
export function imageSteps(): number {
  return env.FLUX_STEPS ?? (/schnell/i.test(env.FLUX_MODEL) ? 4 : 28);
}

export const whisperDirs = {
  install: path.join(dirs.cache, 'whisper.cpp'),
  models: path.join(dirs.cache, 'whisper-models'),
} as const;

export const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  // Speech is billed on tokens like everything else, and the output side is an
  // order of magnitude dearer -- which is the whole argument for the local
  // reader being the default.
  'gemini-2.5-flash-preview-tts': { input: 0.5, output: 10 },
  'gemini-3.1-flash-tts-preview': { input: 1, output: 20 },
};

export const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  'word-punch': 'one to three words hitting alone, maximum impact',
  'line-stack': 'two or three short lines stacked, the last one lands',
  'stat-slam': 'a number is the hero of the frame',
  'quote-block': 'an aphorism or quoted line that stands on its own',
  'countdown': 'an enumeration, e.g. "three things followed"',
  'reveal-mask': 'a turn, a reveal, or the answer to the previous beat',
};

export { RENDER, TREATMENT, LAYOUT, PALETTES } from './design.js';

/**
 * Measured across the shorts already in work/: the default voice reads between
 * 2.5 and 3.0 words a second. Used to trim a pasted script before a single
 * second of it has been synthesised.
 */
const SPOKEN_WORDS_PER_SECOND = 2.75;

/** Under a minute with room for the tail, not right up against it. */
const PASTED_MAX_MS = 55_000;

export const PLAN = {
  durationMsMin: 30_000,
  durationMsMax: 50_000,
  beatMsMin: 1_500,
  beatMsMax: 3_000,
  snapToleranceMs: 120,
  hookMaxMs: 2_000,
  hookMaxWords: 12,
  scriptWordsMin: 90,
  scriptWordsMax: 140,
  patternInterruptEveryBeats: 4,
  captionToleranceMs: 80,
  spokenWordsPerSecond: SPOKEN_WORDS_PER_SECOND,
  pastedMaxMs: PASTED_MAX_MS,
  pastedMaxWords: Math.floor((PASTED_MAX_MS / 1000) * SPOKEN_WORDS_PER_SECOND),
  /** The beat contract a hand-written script has to land inside. */
  pastedBeatsMin: 4,
  pastedBeatsMax: 24,
  pastedWordsPerBeatMax: 14,
} as const;

export const AUDIO = {
  narrationLufs: -16,
  // 6 dB under the narration, ducking to about 11 under while it is speaking.
  // -26 was inaudible on a phone speaker, which is where these get watched.
  musicLufs: -22,
  masterLufs: -14,
  truePeakDb: -1,
  stemTruePeakDb: -1.5,
  sfxUnderNarrationDbMin: 12,
  sfxUnderNarrationDbMax: 18,
  // duckDb is the depth wanted when narration sits duckOvershootDb above the
  // threshold; the compressor ratio is derived from the pair. Speech quieter
  // than that ducks proportionally less, so duckOvershootDb is the knob to
  // trim if the bed is not getting out of the way.
  duckDb: 5,
  duckAttackMs: 200,
  duckReleaseMs: 400,
  duckThresholdDb: -24,
  duckOvershootDb: 10,
  silenceTrimMsMax: 250,
  narrationTempo: 1.05,
  sampleRate: 48_000,
  channels: 2,
  aacBitrate: '192k',
} as const;

export const PROCEDURAL_CLIPS = [
  { id: 'gradient-dark', mood: 'dark' },
  { id: 'gradient-tense', mood: 'tense' },
  { id: 'gradient-clean', mood: 'clean' },
  { id: 'gradient-warm', mood: 'warm' },
] as const;

export const SFX_GAIN_DB = {
  whoosh: -15,
  impact: -13,
  riser: -14,
  click: -18,
} as const;

/**
 * How far ahead of the moment it marks a cue starts, in milliseconds.
 *
 * A swell is not a hit. Its loudest point is its last, so a file that begins
 * on the frame it is meant to mark peaks well after it and reads as a reaction
 * rather than an accent -- the cut lands, and a quarter-second later something
 * agrees with it. The whoosh under a panel change was doing exactly that.
 *
 * So the swells lead by their own shape: the samples in assets/sfx are cut
 * around their measured peak so that every one of them peaks exactly this far
 * in, with a short tail after it. That is what makes these numbers exact
 * rather than an average -- the top of the rise and the cut are the same
 * frame, whichever variant fires.
 *
 * Cues that peak on their first sample -- an impact under an emphasised word,
 * a click under a line -- lead by nothing.
 */
export const SFX_LEAD_MS = {
  whoosh: 400,
  riser: 1_200,
  impact: 0,
  click: 0,
} as const;

export const HIGH_CONTRAST_TEMPLATES = ['stat-slam', 'reveal-mask', 'countdown'] as const;
export const HOOK_TEMPLATES = ['word-punch', 'stat-slam'] as const;
export const REVERSAL_MARKERS = ['but', 'actually', 'turns out', 'except', 'until'] as const;
