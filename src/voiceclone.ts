import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { assetDirs } from './config.js';
import { readJson, writeJsonAtomic } from './json.js';
import { log } from './log.js';

/**
 * The voices this machine can read in, each one a recording of somebody.
 *
 * It started as a single file in a folder, which was the right size for
 * proving the model worked and the wrong size for using it: one voice means
 * re-recording every time you want a different one, and a series that wants
 * its own narrator cannot have one. So it is a small library -- a manifest and
 * a clip per voice -- and a beat sheet records which voice read it, the same
 * way it records which style drew it.
 *
 * The clips never leave the machine except inside the request that reads a
 * script, and they are never served back over HTTP. A recording of a person's
 * voice is the most personal thing this tool touches; it gets the narrowest
 * door that still works.
 */

const MANIFEST = () => path.join(assetDirs.voice, 'voices.json');

const voiceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]{8,32}$/),
    name: z.string().min(1).max(60),
    /** Filename of the clip, inside the same folder. */
    file: z.string().min(1),
    createdMs: z.number().int().nonnegative(),
    /** Seconds of audio, for the list. Zero when ffprobe could not read it. */
    seconds: z.number().nonnegative().default(0),
  })
  .strict();

export type ClonedVoice = z.infer<typeof voiceSchema>;

const fileSchema = z.object({ voices: z.array(voiceSchema).max(64) }).strict();

export function listVoices(): ClonedVoice[] {
  const manifest = MANIFEST();
  if (!fs.existsSync(manifest)) return [];
  try {
    // A manifest entry whose clip has been deleted by hand is not a voice, and
    // offering it would fail at synthesis rather than here.
    return fileSchema
      .parse(readJson(manifest))
      .voices.filter((voice) => fs.existsSync(clipPath(voice)));
  } catch (error) {
    log.warn(`voices: the manifest could not be read (${(error as Error).message})`);
    return [];
  }
}

export function clipPath(voice: ClonedVoice): string {
  return path.join(assetDirs.voice, voice.file);
}

export function findVoice(id: string | undefined): ClonedVoice | null {
  if (id === undefined || id === '') return null;
  return listVoices().find((voice) => voice.id === id) ?? null;
}

/** The one a run uses when nothing said which: the earliest, so it is stable. */
export function defaultVoice(): ClonedVoice | null {
  const all = listVoices();
  if (all.length === 0) return null;
  return [...all].sort((a, b) => a.createdMs - b.createdMs)[0] ?? null;
}

function save(voices: readonly ClonedVoice[]): void {
  fs.mkdirSync(assetDirs.voice, { recursive: true });
  writeJsonAtomic(MANIFEST(), { voices: [...voices] });
}

export function addVoice(input: {
  name: string;
  wav: Buffer;
  seconds: number;
}): ClonedVoice {
  const id = crypto.randomBytes(8).toString('hex');
  const voice: ClonedVoice = {
    id,
    name: input.name.trim().slice(0, 60) || 'Untitled voice',
    file: `${id}.wav`,
    createdMs: Date.now(),
    seconds: Math.round(input.seconds * 10) / 10,
  };

  fs.mkdirSync(assetDirs.voice, { recursive: true });
  const destination = path.join(assetDirs.voice, voice.file);
  const temporary = `${destination}.${process.pid}.part`;
  fs.writeFileSync(temporary, input.wav);
  fs.renameSync(temporary, destination);

  save([...listVoices(), voice]);
  log.info(`voices: added "${voice.name}" (${voice.seconds}s)`);
  return voice;
}

export function renameVoice(id: string, name: string): ClonedVoice | null {
  const all = listVoices();
  const found = all.find((voice) => voice.id === id);
  if (found === undefined) return null;
  found.name = name.trim().slice(0, 60) || found.name;
  save(all);
  return found;
}

export function removeVoice(id: string): boolean {
  const all = listVoices();
  const found = all.find((voice) => voice.id === id);
  if (found === undefined) return false;
  fs.rmSync(clipPath(found), { force: true });
  save(all.filter((voice) => voice.id !== id));
  log.info(`voices: removed "${found.name}"`);
  return true;
}

/**
 * Passages to read aloud when recording one.
 *
 * Not arbitrary sentences. A cloning model takes what it hears and nothing
 * else, so the recording has to contain the sounds the voice will later be
 * asked to make: every English vowel, the awkward consonant clusters, a
 * question so the pitch rises, and a long clause so it hears the rhythm of
 * somebody actually reading rather than reciting a word list.
 *
 * Kept short on purpose. Ten to fifteen seconds is what this model wants, and
 * a page of text produces a tired, careful read that sounds like nobody.
 */
export const READING_PASSAGES: readonly { title: string; text: string }[] = [
  {
    title: 'The short one',
    text:
      'The quick brown fox jumps over the lazy dog, while eight zebras vex a judge. ' +
      'Is that really how it happened? I think so — though the truth is usually stranger.',
  },
  {
    title: 'The narrator',
    text:
      'Nothing in the universe ever makes direct contact. Every atom you have ever touched ' +
      'was held a whisper away by a force you cannot see. So what does it mean to feel ' +
      'anything at all?',
  },
  {
    title: 'The range',
    text:
      'She sells sixty thrushes; we judge quality by width, not weight. ' +
      'Would you have guessed that? Probably not — and yet here we are, ' +
      'counting shadows in the afternoon light.',
  },
];
