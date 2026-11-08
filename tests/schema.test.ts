import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { countByLevel, lintBeatSheet } from '../src/lint.js';
import { BeatSheetValidationError, SCHEMA_VERSION, parseBeatSheet } from '../src/schema.js';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'stub.beatsheet.json');
const load = (): Record<string, unknown> => JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;

type RawBeat = { id: string; startMs: number; endMs: number; [key: string]: unknown };
const beatsOf = (sheet: Record<string, unknown>): RawBeat[] => sheet['beats'] as RawBeat[];

describe('the stub fixture', () => {
  it('parses and is migrated to the current schema version', () => {
    const sheet = parseBeatSheet(load());
    expect(sheet.version).toBe(SCHEMA_VERSION);
    expect(sheet.beats.length).toBeGreaterThan(0);
  });

  it('keeps its lint findings', () => {
    const findings = lintBeatSheet(parseBeatSheet(load()));
    expect(countByLevel(findings)).toMatchSnapshot();
  });
});

describe('hard invariants', () => {
  it('rejects overlapping beats', () => {
    const sheet = load();
    const beats = beatsOf(sheet);
    const second = beats[1];
    if (second === undefined) throw new Error('fixture needs two beats');
    second.startMs -= 200;
    expect(() => parseBeatSheet(sheet)).toThrow(BeatSheetValidationError);
  });

  it('rejects duplicate beat ids', () => {
    const sheet = load();
    const beats = beatsOf(sheet);
    const [first, second] = beats;
    if (first === undefined || second === undefined) throw new Error('fixture needs two beats');
    second.id = first.id;
    expect(() => parseBeatSheet(sheet)).toThrow(BeatSheetValidationError);
  });

  it('rejects an emphasis index past the end of the words', () => {
    const sheet = load();
    const first = beatsOf(sheet)[0];
    if (first === undefined) throw new Error('fixture needs a beat');
    first['emphasisWordIndex'] = 999;
    expect(() => parseBeatSheet(sheet)).toThrow(BeatSheetValidationError);
  });

  it('rejects unknown fields instead of carrying them silently', () => {
    const sheet = load();
    const first = beatsOf(sheet)[0];
    if (first === undefined) throw new Error('fixture needs a beat');
    first['colour'] = 'red';
    expect(() => parseBeatSheet(sheet)).toThrow(BeatSheetValidationError);
  });
});
