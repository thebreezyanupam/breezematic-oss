import fs from 'node:fs';
import path from 'node:path';
import { AUDIO, ROOT, beatSheetPath } from '../config.js';
import { writeJsonAtomic } from '../json.js';
import { out } from '../log.js';
import { table } from '../report.js';
import { formatBytes, formatMs, slugify } from '../text.js';
import { mixVideo, type MixResult } from '../stages/mix.js';
import { loadOrProduceSheet } from './sheet.js';

export type MixOptions = {
  topic: string;
  seed?: number;
  variant: number;
  force: boolean;
  table: boolean;
};

function relative(file: string): string {
  return path.relative(ROOT, file);
}

function db(value: number): string {
  return `${value.toFixed(1)} dB`;
}

function lufs(value: number): string {
  return `${value.toFixed(1)} LUFS`;
}

function sfxTable(result: MixResult): string {
  return table(
    ['cue', 'in sheet', 'samples', 'heard'],
    result.coverage.map((entry) => [
      entry.cue,
      String(entry.cues),
      entry.samples === 0 ? '-' : String(entry.samples),
      // A cue that is switched off is a decision; a cue that is on with
      // nothing to play it is a missing sample. Saying "none" for both would
      // send somebody looking for a file that was never wanted.
      !entry.on ? 'off' : entry.placed === 0 && entry.cues > 0 ? 'no sample' : String(entry.placed),
    ]),
  );
}

export async function mixCommand(options: MixOptions): Promise<number> {
  const sheet = await loadOrProduceSheet(options);

  const result = await mixVideo(sheet, { force: options.force });

  if (options.table) {
    out('');
    out(sfxTable(result));
    if (result.unmatchedSamples.length > 0) {
      out('');
      out(`ignored in assets/sfx: ${result.unmatchedSamples.join(', ')}`);
    }
  }

  out('');
  out(
    table(
      ['stage', 'target', 'measured'],
      [
        [
          'narration',
          `${AUDIO.narrationLufs} LUFS`,
          `${lufs(result.narrationLoudness.integratedLufs)} in, TP ${db(result.narrationLoudness.truePeakDb)}`,
        ],
        [
          'music',
          `${AUDIO.musicLufs} LUFS`,
          result.stems.music === undefined ? 'no track in the beat sheet' : relative(result.stems.music),
        ],
        [
          'duck',
          `-${AUDIO.duckDb} dB under narration`,
          result.stems.music === undefined
            ? 'skipped, nothing to duck'
            : `${AUDIO.duckAttackMs}ms attack / ${AUDIO.duckReleaseMs}ms release`,
        ],
        [
          'sfx',
          `${result.cues.total} cue(s)`,
          result.cues.placed === 0
            ? 'no samples found, bed omitted'
            : `${result.cues.placed} placed`,
        ],
        [
          'master',
          `${AUDIO.masterLufs} LUFS, ${AUDIO.truePeakDb} dBTP`,
          `${lufs(result.masterLoudness.integratedLufs)}, TP ${db(result.masterLoudness.truePeakDb)}, LRA ${result.masterLoudness.lra.toFixed(1)}`,
        ],
      ],
    ),
  );

  const size = fs.statSync(result.outputPath).size;
  out('');
  out(`duration    ${formatMs(result.durationMs)}`);
  out(`picture     ${relative(result.picturePath)}`);
  out(`video       ${relative(result.outputPath)} (${formatBytes(size)})`);
  return 0;
}
