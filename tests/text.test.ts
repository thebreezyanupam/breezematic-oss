import { describe, expect, it } from 'vitest';
import { cueTime, decimalsOf, formatValue, normalizeWord, numbersIn } from '../src/explainer.js';
import { adaptLocally, isSubsequence, unwrap } from '../src/stages/adapt.js';
import { timeWords } from './helpers.js';

const words = (text: string): string[] => text.split(/\s+/).filter((w) => w !== '');

// Long enough that the trimming path has to drop something.
const LONG = Array.from(
  { length: 40 },
  (_, i) => `Sentence number ${i + 1} adds another plain thought to the script.`,
).join(' ');

describe('adaptLocally', () => {
  it('keeps every word, in order, when asked to', () => {
    const { beats, truncated } = adaptLocally(LONG, true);
    expect(truncated).toBe(false);
    expect(words(beats.join(' '))).toEqual(words(LONG));
  });

  it('trims a long script without inventing or reordering words', () => {
    const { beats, truncated } = adaptLocally(LONG);
    const kept = words(beats.join(' '));
    expect(truncated).toBe(true);
    expect(kept.length).toBeLessThan(words(LONG).length);
    expect(isSubsequence(kept, words(LONG))).toBe(true);
  });

  it('is deterministic', () => {
    expect(adaptLocally(LONG)).toEqual(adaptLocally(LONG));
  });
});

describe('unwrap', () => {
  it('joins lines broken mid-sentence and keeps real breaks', () => {
    expect(unwrap('The first line runs\non to here.\nA second sentence.')).toEqual([
      'The first line runs on to here.',
      'A second sentence.',
    ]);
  });

  it('keeps a list with no full stops as it is', () => {
    expect(unwrap('one\ntwo\nthree')).toEqual(['one', 'two', 'three']);
  });
});

describe('isSubsequence', () => {
  it('allows dropping but not adding or reordering', () => {
    const original = ['a', 'b', 'c', 'd'];
    expect(isSubsequence(['a', 'c'], original)).toBe(true);
    expect(isSubsequence(['c', 'a'], original)).toBe(false);
    expect(isSubsequence(['a', 'x'], original)).toBe(false);
  });
});

describe('explainer text', () => {
  it('normalises case, accents and punctuation', () => {
    expect(normalizeWord('Café,')).toBe('cafe');
    expect(normalizeWord('8,849')).toBe('8849');
  });

  it('finds when a cue is said', () => {
    const timed = timeWords('Mount Everest stands 8,849 metres above the sea.');
    expect(cueTime('everest', timed)).toBe(timed[1]?.startMs);
    expect(cueTime('8849 m', timed)).toBe(timed[3]?.startMs);
    expect(cueTime('volcano', timed)).toBeNull();
  });

  it('reads numbers out of text and prints them back', () => {
    expect(numbersIn('8,849 m and 4.2 km')).toEqual([8849, 4.2]);
    expect(formatValue(8849, decimalsOf(8849))).toBe('8,849');
    expect(formatValue(4.2, decimalsOf(4.2))).toBe('4.2');
  });
});
