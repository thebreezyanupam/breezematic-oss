import fs from 'node:fs';
import path from 'node:path';
import { ROOT, beatSheetPath } from '../config.js';
import { writeJsonAtomic } from '../json.js';
import { countByLevel, formatFindings, lintBeatSheet } from '../lint.js';
import { log, out } from '../log.js';
import { beatTable, summary, table } from '../report.js';
import { slugify } from '../text.js';
import { produceBeatSheet } from '../stages/pipeline.js';
import type {
  BoardContent,
  BoardImagery,
  BoardTheme,
  EffectName,
  ImageryMode,
  ImageSource,
  RenderMode,
  StyleName,
} from '../schema.js';

export const STUB_FIXTURE = path.join(ROOT, 'fixtures', 'stub.beatsheet.json');

export type PlanOptions = {
  topic: string;
  seed?: number;
  variant: number;
  out?: string;
  scriptFile?: string;
  adapt?: boolean;
  effect?: EffectName;
  music?: string;
  musicLufs?: number;
  musicFadeInMs?: number;
  musicFadeOutMs?: number;
  musicStartMs?: number;
  tone?: string;
  imagery?: ImageryMode;
  imageSource?: ImageSource;
  imageCount?: number;
  style?: StyleName;
  captionScale?: number;
  mode?: RenderMode;
  brief?: string;
  boardTexture?: boolean;
  boardTheme?: BoardTheme;
  boardContent?: BoardContent;
  boardImagery?: BoardImagery;
  strict: boolean;
  force: boolean;
  table: boolean;
  decisions: boolean;
};

export async function planCommand(options: PlanOptions): Promise<number> {
  const slug = slugify(options.topic);
  const script =
    options.scriptFile === undefined ? undefined : fs.readFileSync(options.scriptFile, 'utf8');
  const { sheet, decisions, snapped, snapAttempts } = await produceBeatSheet({
    ...options,
    ...(script !== undefined ? { script } : {}),
  });
  const destination = options.out ?? beatSheetPath(slug);
  writeJsonAtomic(destination, sheet);

  const findings = lintBeatSheet(sheet);
  const counts = countByLevel(findings);

  out(summary(sheet));
  if (options.table) {
    out('');
    out(beatTable(sheet));
  }
  if (options.decisions) {
    out('');
    out(table(['beat', 'why'], decisions.map((entry) => [entry.beatId, entry.reason])));
  }

  out('');
  out(`snapping    ${snapped}/${snapAttempts} cuts landed on the ${sheet.music.bpm} bpm grid`);
  out(`beat sheet  ${path.relative(ROOT, destination)}`);
  out(`schema      valid`);
  out(`lint        ${counts.warn} warning(s), ${counts.info} note(s)`);
  if (findings.length > 0) out(formatFindings(findings));

  if (options.strict && counts.warn > 0) {
    log.error('--strict was set and the beat sheet has lint warnings');
    return 1;
  }
  return 0;
}
