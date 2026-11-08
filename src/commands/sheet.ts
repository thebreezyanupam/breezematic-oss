import fs from 'node:fs';
import { beatSheetPath } from '../config.js';
import { readJson, writeJsonAtomic } from '../json.js';
import { log } from '../log.js';
import { parseBeatSheet, type BeatSheet } from '../schema.js';
import { slugify } from '../text.js';
import { produceBeatSheet } from '../stages/pipeline.js';

export type SheetOptions = {
  topic: string;
  seed?: number;
  variant: number;
  force: boolean;
};

/**
 * The settings that only describe how a sheet is drawn, never what is in it.
 * None of them move a cut, retime a word or change which picture belongs to
 * which beat, so applying them to a sheet already on disk is safe.
 */
const PRESENTATION = [
  'effect',
  'style',
  'captionScale',
  'mode',
  'boardTexture',
  'boardTheme',
  'boardContent',
  'boardImagery',
] as const;

/**
 * The sheet the render side consumes. It comes off disk whenever one is there,
 * because the whole point of the checkpoint is that a hand edit between plan
 * and render is what gets rendered — regenerating here silently threw those
 * edits away, along with anything `plan` was told that `render` was not, like
 * the type style. `--force` opts back into regeneration.
 */
export async function loadOrProduceSheet(options: SheetOptions): Promise<BeatSheet> {
  const slug = slugify(options.topic);
  const file = beatSheetPath(slug);

  if (!options.force && fs.existsSync(file)) {
    log.debug(`using the beat sheet already at ${file}`);

    /**
     * The sheet keeps its beats, and the run gets its look.
     *
     * These were baked in at plan time and read back off disk unchanged, so
     * choosing a slate board and pressing render gave you the paper one the
     * sheet was planned with. Nothing about the sheet said so; it simply
     * ignored you. The same trap ate --style once before.
     *
     * Only the presentation keys are taken, and only when the run actually
     * supplied one, so a render with nothing to say still renders the sheet
     * exactly as written.
     */
    const sheet = readJson(file) as { meta?: Record<string, unknown> };
    const given = options as unknown as Record<string, unknown>;
    const changed: string[] = [];
    for (const key of PRESENTATION) {
      if (given[key] === undefined || sheet.meta === undefined) continue;
      if (sheet.meta[key] === given[key]) continue;
      sheet.meta[key] = given[key];
      changed.push(key);
    }
    if (changed.length > 0) log.info(`sheet: applying ${changed.join(', ')} from this run`);
    return parseBeatSheet(sheet);
  }

  const { sheet } = await produceBeatSheet(options);
  writeJsonAtomic(file, sheet);
  return sheet;
}
