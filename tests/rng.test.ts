import { describe, expect, it } from 'vitest';
import { beatRng, hashString, mulberry32, pick, rangeInt, rngFor } from '../src/rng.js';

const take = (rng: () => number, n: number): number[] => Array.from({ length: n }, () => rng());

describe('hashString', () => {
  it('is 32-bit FNV-1a', () => {
    // Reference values for FNV-1a, 32-bit.
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('a')).toBe(0xe40c292c);
    expect(hashString('foobar')).toBe(0xbf9cf968);
  });
});

describe('mulberry32', () => {
  it('replays the same stream for the same seed', () => {
    expect(take(mulberry32(7), 20)).toEqual(take(mulberry32(7), 20));
  });

  it('stays inside [0, 1)', () => {
    for (const value of take(mulberry32(123), 5_000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('gives different streams for different seeds', () => {
    expect(take(mulberry32(1), 5)).not.toEqual(take(mulberry32(2), 5));
  });
});

describe('scoped streams', () => {
  it('do not depend on the order they are drawn in', () => {
    // Remotion renders frames across parallel tabs, so beat b03 may be drawn
    // before b01. Each beat's numbers must not care.
    const forwards = ['b01', 'b02', 'b03'].map((id) => take(beatRng(42, id), 4));
    const backwards = ['b03', 'b02', 'b01'].map((id) => take(beatRng(42, id), 4)).reverse();
    expect(forwards).toEqual(backwards);
  });

  it('separate scopes under one seed', () => {
    expect(take(rngFor(42, 'slug', 'b01'), 4)).not.toEqual(take(rngFor(42, 'slug', 'b02'), 4));
    expect(take(rngFor(42, 'slug', 'b01'), 4)).toEqual(take(rngFor(42, 'slug', 'b01'), 4));
  });
});

describe('helpers', () => {
  it('rangeInt covers both ends and nothing outside', () => {
    const rng = mulberry32(9);
    const seen = new Set(Array.from({ length: 2_000 }, () => rangeInt(rng, 1, 4)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('pick refuses an empty list', () => {
    expect(() => pick(mulberry32(1), [])).toThrow(/empty/);
  });
});
