import fs from 'node:fs';
import path from 'node:path';

import { dirs } from '../config.js';
import { log } from '../log.js';
import { slugify } from '../text.js';
import { drawImage, type Reference } from '../providers/geminiimage.js';

/**
 * Character memory.
 *
 * A character is drawn once, as a plain reference sheet, and every later
 * picture of them is drawn from that sheet rather than from a description. The
 * sheet is the character: the face, the hair, where the stains are on the vest.
 *
 * Kept per book, on disk, under assets/characters -- not in the cache. That is
 * the point of it. The cache forgets whenever a prompt changes by a word; this
 * does not. The second video about The Metamorphosis gets the Gregor the first
 * one had, and so does the tenth, which is what a series needs and what a
 * viewer who watched the last one will notice if it is missing.
 *
 * And because it is just a picture in a folder, it can be replaced. Draw a
 * Gregor you prefer, save it over the file, and every video from then on uses
 * yours.
 */

export const CHARACTER_DIR = path.join(dirs.assets, 'characters');

export type Sheet = { name: string; file: string; reference: Reference };

function folderFor(book: string): string {
  return path.join(CHARACTER_DIR, slugify(book).slice(0, 60) || 'untitled');
}

function nameFor(name: string): string {
  return slugify(name).slice(0, 60) || 'character';
}

function mimeFor(file: string): string {
  return /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
}

/**
 * The sheet for one character, drawing it the first time it is asked for.
 *
 * Found by name within the book, not by description. The picture writer
 * describes Gregor slightly differently every time it runs; if the sheet were
 * keyed on the words, each run would mint a new Gregor, which is exactly the
 * inconsistency this exists to end.
 */
export async function sheetFor(options: {
  book: string;
  name: string;
  look: string;
  medium: string;
}): Promise<Sheet> {
  const folder = folderFor(options.book);
  const base = nameFor(options.name);

  /**
   * An existing drawing of this person, under any spelling of their name.
   *
   * By exact file name first -- any image the person put there wins, whatever
   * its extension -- and then by the same-character rule, because the writer
   * says "Gregor" one run and "Gregor Samsa" the next, and an exact match
   * would draw a second Gregor for the second spelling.
   */
  const found = fs.existsSync(folder)
    ? fs
        .readdirSync(folder)
        .filter((file) => /\.(png|jpe?g)$/i.test(file) && !file.includes('.unkeyed'))
        .sort((a, b) => Number(!a.startsWith(`${base}.`)) - Number(!b.startsWith(`${base}.`)))
        .find(
          (file) =>
            file.startsWith(`${base}.`) ||
            sameCharacter(file.replace(/\.(png|jpe?g)$/i, '').replace(/-/g, ' '), options.name),
        )
    : undefined;
  if (found !== undefined) {
    const existing = path.join(folder, found);
    return {
      name: options.name,
      file: existing,
      reference: { bytes: fs.readFileSync(existing), mime: mimeFor(existing) },
    };
  }

  fs.mkdirSync(folder, { recursive: true });
  const drawn = await drawImage({
    prompt:
      `${options.medium}. A character reference sheet: one figure, the whole figure from head ` +
      `to foot, standing, facing the viewer in a neutral pose, on a plain flat light background ` +
      `with nothing else in the frame. ${options.name}: ${options.look} No text, no labels.`,
    aspectRatio: '3:4',
    detail: `character sheet: ${options.name}`,
  });

  const file = path.join(folder, `${base}.png`);
  fs.writeFileSync(file, drawn.bytes);
  // What it was drawn from, so a replaced or surprising sheet can be traced.
  fs.writeFileSync(
    path.join(folder, `${base}.json`),
    `${JSON.stringify({ name: options.name, look: options.look, drawn: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  log.info(`characters: drew ${options.name} once — ${path.relative(dirs.root, file)}`);
  return { name: options.name, file, reference: { bytes: drawn.bytes, mime: drawn.mime } };
}

/**
 * Whether two names refer to the same character.
 *
 * It used to be "any shared word of four letters or more", and that is wrong
 * for exactly the books this channel is about: families share a surname. In a
 * test on The Metamorphosis, "Grete Samsa" and "Mr. Samsa" both matched
 * Gregor Samsa's sheet on "samsa", so the sister and the father would have
 * been pasted over the frame as Gregor.
 *
 * So: the same name, or the same first word of the name -- the part that is
 * the person's own. "Gregor" is Gregor Samsa; "Grete Samsa" is not; "The
 * Insect" is "the insect". A surname on its own is never enough.
 */
export function sameCharacter(a: string, b: string): boolean {
  const words = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      // Mr and Mrs are identity, not decoration: stripping them made Mr. and
      // Mrs. Samsa -- the father and mother in the same book -- one person.
      .filter((word) => word !== '' && word !== 'the');
  const left = words(a);
  const right = words(b);
  if (left.length === 0 || right.length === 0) return false;
  if (left.join(' ') === right.join(' ')) return true;
  return left[0] === right[0] && left[0]!.length >= 3;
}

export function findSheet(sheets: readonly Sheet[], name: string): Sheet | undefined {
  return sheets.find((sheet) => sameCharacter(sheet.name, name));
}
