import { beforeAll, describe, expect, it } from 'vitest';
import { YEAR_S, isotope, isotopeMass, isotopesOf, loadIsotopes } from '../src/data/db';

beforeAll(async () => {
  await loadIsotopes();
});

describe('NUBASE2020 isotopes', () => {
  it('tritium half-life is 12.32 years, beta-minus', () => {
    const t = isotope(1, 3)!;
    expect(t.halfLife! / YEAR_S).toBeCloseTo(12.32, 2);
    expect(t.decays).toEqual([{ mode: 'B-', percent: 100, rel: '=' }]);
  });

  it('O-16 is stable, 99.757% abundant, mass 15.9949 u', () => {
    const o = isotope(8, 16)!;
    expect(o.stable).toBe(true);
    expect(o.abundance).toBeCloseTo(99.757, 3);
    expect(isotopeMass(o)).toBeCloseTo(15.99491462, 6);
  });

  it('C-12 is exactly 12 u by definition', () => {
    expect(isotopeMass(isotope(6, 12)!)).toBe(12);
  });

  it('U-238 alpha-decays with t½ 4.463 Gy', () => {
    const u = isotope(92, 238)!;
    expect(u.halfLife! / YEAR_S / 1e9).toBeCloseTo(4.463, 3);
    expect(u.decays[0]).toMatchObject({ mode: 'A', percent: 100 });
  });

  it('natural abundances of stable isotopes add up to 100%', () => {
    for (const z of [1, 6, 8, 17, 26, 29, 50]) {
      const sum = isotopesOf(z).reduce((a, i) => a + (i.abundance ?? 0), 0);
      expect(sum, `Z=${z}`).toBeCloseTo(100, 0);
    }
  });

  it('every element up to Og has isotopes', () => {
    for (let z = 1; z <= 118; z++) expect(isotopesOf(z).length, `Z=${z}`).toBeGreaterThan(0);
  });
});
