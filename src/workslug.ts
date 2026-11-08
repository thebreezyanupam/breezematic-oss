import fs from 'node:fs';
import path from 'node:path';
import { workDir } from './config.js';
import { slugify } from './text.js';

/**
 * The folder a video's work goes in, by what kind of video it is.
 *
 * Every kind named its folder after its title, and titles collide across
 * kinds: a Short called "The Great Emu War" and a long essay called "The Great
 * Emu War" both wrote into work/the-great-emu-war. The long one's narration
 * overwrote the short's, and the library -- one row per folder -- showed the
 * short and hid the essay entirely.
 *
 * So a folder that already belongs to another kind of video is left alone,
 * and this one takes a suffix. A folder that is already this kind's -- a
 * re-run, a render after a plan -- keeps its plain name, which is what keeps
 * every existing video where it was.
 */
export type WorkKind = 'short' | 'book' | 'lore';

const MARKERS: Record<WorkKind, string> = {
  short: 'beatsheet.json',
  book: 'essay.txt',
  lore: 'saga.txt',
};

const SUFFIX: Record<WorkKind, string> = { short: '-short', book: '-long', lore: '-saga' };

function belongsTo(slug: string): WorkKind[] {
  const dir = workDir(slug);
  return (Object.keys(MARKERS) as WorkKind[]).filter((kind) => fs.existsSync(path.join(dir, MARKERS[kind])));
}

export function workSlug(kind: WorkKind, title: string): string {
  // Book essays have always been cut at 80 characters; the others never were.
  const base = kind === 'book' ? slugify(title).slice(0, 80) : slugify(title);
  const owners = belongsTo(base);
  if (owners.length === 0 || owners.includes(kind)) return base;
  return `${base}${SUFFIX[kind]}`;
}
