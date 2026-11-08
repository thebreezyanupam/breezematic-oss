import path from 'node:path';
import { ROOT } from '../config.js';
import { out } from '../log.js';
import { table } from '../report.js';
import { firstBeatPerTemplate } from '../stages/pipeline.js';
import { renderBeatStills, renderPicture } from '../stages/render.js';
import { loadOrProduceSheet } from './sheet.js';
import type {
  BoardContent,
  BoardImagery,
  BoardTheme,
  RenderMode,
} from '../schema.js';

export type RenderOptions = {
  topic: string;
  seed?: number;
  variant: number;
  force: boolean;
  /**
   * Presentation only, forwarded to the sheet loader. The sheet keeps its
   * beats and this run supplies the look, so a board or a mode can be tried
   * without regenerating the script and the voice behind it.
   */
  mode?: RenderMode;
  boardTheme?: BoardTheme;
  boardContent?: BoardContent;
  boardImagery?: BoardImagery;
  boardTexture?: boolean;
};

export async function stillsCommand(options: RenderOptions): Promise<number> {
  const sheet = await loadOrProduceSheet(options);

  const picks = firstBeatPerTemplate(sheet);
  const files = await renderBeatStills(sheet, picks.map((entry) => entry.id));

  out('');
  out(
    table(
      ['template', 'beat', 'file'],
      picks.map((entry, i) => [
        entry.template,
        entry.id,
        path.relative(ROOT, files[i] ?? ''),
      ]),
    ),
  );
  out('');
  out(`${files.length} still(s) rendered`);
  return 0;
}

export async function renderCommand(options: RenderOptions): Promise<number> {
  const sheet = await loadOrProduceSheet(options);

  const output = await renderPicture(sheet);

  out('');
  out(`beats       ${sheet.beats.length}`);
  out(`duration    ${(sheet.meta.durationMs / 1000).toFixed(2)}s`);
  out(`picture     ${path.relative(ROOT, output)} (silent)`);
  return 0;
}
