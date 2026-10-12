import { describe, expect, it } from 'vitest';
import { group, period, tableCell } from '../src/chem/periodic';
import { ELEMENT_NAMES_RU } from '../src/i18n/elementNames';

describe('periodic table layout', () => {
  it.each([
    [1, 1, 1], [2, 1, 18], [6, 2, 14], [11, 3, 1], [26, 4, 8], [53, 5, 17],
    [56, 6, 2], [72, 6, 4], [79, 6, 11], [86, 6, 18], [104, 7, 4], [118, 7, 18],
  ])('Z=%i is period %i group %i', (z, p, g) => {
    expect(period(z)).toBe(p);
    expect(group(z)).toBe(g);
  });

  it('puts La–Lu and Ac–Lr in the f-block rows', () => {
    expect(group(57)).toBeNull();
    expect(tableCell(57)).toEqual({ row: 9, col: 3 });
    expect(tableCell(71)).toEqual({ row: 9, col: 17 });
    expect(tableCell(103)).toEqual({ row: 10, col: 17 });
  });

  it('every cell is unique', () => {
    const seen = new Set<string>();
    for (let z = 1; z <= 118; z++) {
      const { row, col } = tableCell(z);
      seen.add(`${row}:${col}`);
    }
    expect(seen.size).toBe(118);
  });

  it('has a Russian name for every element', () => {
    expect(ELEMENT_NAMES_RU).toHaveLength(118);
  });
});
