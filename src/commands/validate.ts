import path from 'node:path';
import { ROOT } from '../config.js';
import { readJson } from '../json.js';
import { countByLevel, formatFindings, lintBeatSheet } from '../lint.js';
import { log, out } from '../log.js';
import { beatTable, summary } from '../report.js';
import { parseBeatSheet } from '../schema.js';

export type ValidateOptions = {
  strict: boolean;
  table: boolean;
  checkFiles: boolean;
};

export async function validateCommand(file: string, options: ValidateOptions): Promise<number> {
  const resolved = path.resolve(process.cwd(), file);
  const sheet = parseBeatSheet(readJson(resolved));
  const findings = lintBeatSheet(sheet, { checkFiles: options.checkFiles });
  const counts = countByLevel(findings);

  out(summary(sheet));
  if (options.table) {
    out('');
    out(beatTable(sheet));
  }
  out('');
  out(`file        ${path.relative(ROOT, resolved)}`);
  out(`schema      valid`);
  out(`lint        ${counts.warn} warning(s), ${counts.info} note(s)`);
  if (findings.length > 0) {
    out(formatFindings(findings));
  }

  if (options.strict && counts.warn > 0) {
    log.error('--strict was set and the beat sheet has lint warnings');
    return 1;
  }
  return 0;
}
