import { describe, expect, it } from 'vitest';
import { lintBeatSheet } from '../src/lint.js';
import { parseBeatSheet } from '../src/schema.js';
import { buildBeatSheet } from '../src/stages/plan.js';
import { planInput } from './helpers.js';

describe('buildBeatSheet', () => {
  it('is deterministic: the same input gives a byte-identical sheet', () => {
    const first = JSON.stringify(buildBeatSheet(planInput()).sheet);
    const second = JSON.stringify(buildBeatSheet(planInput()).sheet);
    expect(second).toBe(first);
  });

  it('changes with the seed', () => {
    const a = buildBeatSheet(planInput({ seed: 1 })).sheet;
    const b = buildBeatSheet(planInput({ seed: 2 })).sheet;
    expect(JSON.stringify(b.beats)).not.toBe(JSON.stringify(a.beats));
  });

  it('writes a sheet that passes its own schema', () => {
    const { sheet } = buildBeatSheet(planInput());
    expect(() => parseBeatSheet(JSON.parse(JSON.stringify(sheet)))).not.toThrow();
  });

  it('covers the narration with ordered, non-overlapping beats', () => {
    const input = planInput();
    const { sheet } = buildBeatSheet(input);
    expect(sheet.beats[0]?.startMs).toBe(0);
    expect(sheet.beats[sheet.beats.length - 1]?.endMs).toBe(input.durationMs);
    for (let i = 1; i < sheet.beats.length; i++) {
      expect(sheet.beats[i]?.startMs).toBe(sheet.beats[i - 1]?.endMs);
    }
  });

  it('keeps every displayed word, in order', () => {
    const input = planInput();
    const { sheet } = buildBeatSheet(input);
    const shown = sheet.beats
      .flatMap((beat) => beat.lines.map((line) => line.text))
      .join(' ')
      .split(/\s+/);
    expect(shown).toEqual(input.script.fullText.split(/\s+/));
  });

  it('cuts between sentences when asked', () => {
    const input = planInput({ cut: 'sentence', beatMs: { min: 2_000, max: 6_000 } });
    const { sheet } = buildBeatSheet(input);
    for (const beat of sheet.beats) {
      const text = beat.lines.map((line) => line.text).join(' ');
      expect(text).toMatch(/[.!?]$/);
    }
  });

  it('matches the recorded plan', () => {
    // The shape of the plan, without paths and versions that move for unrelated reasons.
    const { sheet, decisions } = buildBeatSheet(planInput());
    const summary = sheet.beats.map((beat) => ({
      id: beat.id,
      ms: [beat.startMs, beat.endMs],
      template: beat.template,
      motion: beat.motion.kind,
      emphasis: beat.emphasisWordIndex,
      lines: beat.lines.map((line) => line.text),
    }));
    expect({ summary, decisions, sfx: sheet.sfx }).toMatchSnapshot();
  });

  it('produces a sheet the style lint has no hard objection to', () => {
    const { sheet } = buildBeatSheet(planInput());
    const findings = lintBeatSheet(sheet);
    for (const finding of findings) expect(['warn', 'info']).toContain(finding.level);
  });
});
