import { out } from '../log.js';
import { produceLore, type LoreOptions } from '../stages/lore.js';

/**
 * The long-form command, which is now a printer.
 *
 * Everything it used to do lives in the stage, so the app and the terminal
 * drive the same code rather than two copies that drift apart.
 */
export type { LoreOptions };

export async function loreCommand(options: LoreOptions): Promise<number> {
  const result = await produceLore(options);

  out(`saga        "${result.title}" — ${result.words} words in ${result.chapters} parts`);
  out(`voice       ${(result.durationMs / 60000).toFixed(1)} min as read`);
  out(`bed         ${result.bed.toLowerCase()}`);
  out('');
  out(`lore        ${result.output}`);
  out(`length      ${(result.durationMs / 60000).toFixed(1)} min`);
  out(`size        ${(result.sizeBytes / 1024 / 1024).toFixed(0)} MB`);
  out(`pace        ${result.assumedWpm} wpm assumed, ${result.wpm} actual`);
  return 0;
}
