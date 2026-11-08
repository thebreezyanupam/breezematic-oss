import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assetDirs } from '../config.js';
import { log } from '../log.js';
import { IMAGE_DIR } from './images.js';
import { VIDEO_DIR } from './footage.js';
import type { CommonsImage } from './images.js';

/**
 * Pictures and clips you supplied yourself, which beat every other source.
 *
 * This exists because of a question worth answering plainly: why can a person
 * make an explainer out of clips of the thing they are explaining, when this
 * tool will not go and fetch them?
 *
 * The answer is not that the person is doing something wrong. Commentary and
 * criticism is the strongest fair-use argument there is, creators rely on it
 * every day, and plenty of them are fine. But fair use is decided on the
 * particular use — how much was taken, what was added, whether it substitutes
 * for the original — and that is a judgement about one video, made by whoever
 * is publishing it. A fetcher inside a tool sold to other people makes that
 * judgement for strangers, about scripts it has not read, at a rate nobody is
 * checking. It is the automation that is the problem, not the footage.
 *
 * So the judgement goes back where it belongs. Drop what you want into this
 * folder and it goes in the video, ahead of anything the tool would have found
 * on its own. What you put there and what you can defend is yours to decide,
 * the same as it is for anyone editing by hand.
 *
 * Files are matched to beats by a leading number — `03-kurama.jpg` is beat 3.
 * Anything unnumbered fills the remaining beats in filename order, so a folder
 * of loose files still works without renaming a thing.
 */

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);

export function ownDir(slug: string): string {
  return path.join(assetDirs.own, slug);
}

export type OwnFile = {
  /** Absolute path on disk. */
  source: string;
  /** What the folder called it, for the credits and the interface. */
  name: string;
  /** 1-based beat from a leading number, or null to be dealt in order. */
  pinned: number | null;
  clip: boolean;
};

/** What is in the folder, in the order the names put them in. */
export function listOwn(slug: string): OwnFile[] {
  const dir = ownDir(slug);
  if (!fs.existsSync(dir)) return [];

  const found: OwnFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  )) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const clip = VIDEO_EXT.has(extension);
    if (!clip && !IMAGE_EXT.has(extension)) continue;

    const lead = /^(\d{1,3})\b/.exec(entry.name);
    found.push({
      source: path.join(dir, entry.name),
      name: entry.name,
      pinned: lead === null ? null : Number(lead[1]),
      clip,
    });
  }
  return found;
}

/**
 * Copies one file to where the renderer can serve it and names it by content,
 * so the same picture supplied twice is stored once.
 */
function publish(file: OwnFile): string {
  const bytes = fs.readFileSync(file.source);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  const extension = file.clip ? '.mp4' : '.jpg';
  const name = `own-${hash}${extension}`;
  const dir = file.clip ? VIDEO_DIR : IMAGE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, name);
  if (!fs.existsSync(destination)) fs.copyFileSync(file.source, destination);
  return name;
}

/**
 * One entry per beat, null where nothing was supplied for it.
 *
 * Pinned files are placed first so a number in a filename always wins, then
 * the loose ones fill the gaps from the top. A beat left null here is passed
 * to whatever source the video was going to use anyway, so supplying four
 * pictures for a twenty-beat video is a perfectly good thing to do.
 */
export function chooseOwn(slug: string, beats: number): (CommonsImage | null)[] {
  const out: (CommonsImage | null)[] = Array.from({ length: beats }, () => null);
  const files = listOwn(slug);
  if (files.length === 0) return out;

  const entry = (file: OwnFile): CommonsImage => ({
    file: publish(file),
    title: file.name,
    author: 'supplied',
    licence: 'supplied',
    source: path.relative(assetDirs.own, file.source).split(path.sep).join('/'),
  });

  const loose: OwnFile[] = [];
  for (const file of files) {
    const at = file.pinned === null ? -1 : file.pinned - 1;
    if (at >= 0 && at < beats && out[at] === null) out[at] = entry(file);
    else loose.push(file);
  }

  let next = 0;
  for (const file of loose) {
    while (next < beats && out[next] !== null) next++;
    if (next >= beats) {
      log.warn(`own: ${file.name} had no beat left to go on`);
      break;
    }
    out[next] = entry(file);
  }

  const used = out.filter((image) => image !== null).length;
  log.info(`own: ${used}/${beats} beats from ${path.relative(process.cwd(), ownDir(slug))}`);
  return out;
}

/**
 * Merges supplied media over whatever a source found. Supplied always wins:
 * the whole point is that it is the one thing in here somebody chose.
 */
export function overlayOwn(
  own: readonly (CommonsImage | null)[],
  found: readonly (CommonsImage | null)[],
): (CommonsImage | null)[] {
  return found.map((image, index) => own[index] ?? image ?? null);
}

/** The beats still needing a picture, blanked where one was supplied. */
export function remaining(
  own: readonly (CommonsImage | null)[],
  beatTexts: readonly string[],
): string[] {
  return beatTexts.map((text, index) => (own[index] === null ? text : ''));
}
