import { SFX_CUES, beatWords, type BeatSheet } from './schema.js';
import { formatMs, truncate, wordCount } from './text.js';

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join('  ').trimEnd();
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  return [line(headers), divider, ...rows.map(line)].join('\n');
}

export function beatTable(sheet: BeatSheet): string {
  const rows = sheet.beats.map((beat, i) => {
    const words = beatWords(beat.lines);
    const emphasis =
      beat.emphasisWordIndex === null ? '-' : (words[beat.emphasisWordIndex] ?? '?');
    return [
      String(i + 1).padStart(2, '0'),
      beat.id,
      formatMs(beat.startMs),
      formatMs(beat.endMs - beat.startMs),
      beat.template,
      beat.motion.kind,
      emphasis,
      truncate(words.join(' '), 44),
    ];
  });
  return table(['#', 'id', 'in', 'len', 'template', 'motion', 'emphasis', 'text'], rows);
}

export function summary(sheet: BeatSheet): string {
  const lengths = sheet.beats.map((beat) => beat.endMs - beat.startMs);
  const shortest = Math.min(...lengths);
  const longest = Math.max(...lengths);
  const average = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const cueCounts = SFX_CUES.map((cue) => {
    const count = sheet.sfx.filter((entry) => entry.cue === cue).length;
    return `${cue} ${count}`;
  }).join(', ');

  return [
    `topic       ${sheet.meta.topic}`,
    `slug        ${sheet.meta.slug}`,
    `seed        ${sheet.meta.seed}`,
    `duration    ${formatMs(sheet.meta.durationMs)} @ ${sheet.meta.fps}fps`,
    `script      ${wordCount(sheet.script.fullText)} words, hook ${wordCount(sheet.script.hook)} words`,
    `beats       ${sheet.beats.length} (min ${formatMs(shortest)}, avg ${formatMs(average)}, max ${formatMs(longest)})`,
    `templates   ${new Set(sheet.beats.map((b) => b.template)).size} distinct of 6`,
    `music       ${sheet.music.bpm} bpm, ${sheet.music.beatGridMs.length} grid ticks`,
    `words       ${sheet.words.length}`,
    `sfx         ${sheet.sfx.length} (${cueCounts})`,
  ].join('\n');
}
