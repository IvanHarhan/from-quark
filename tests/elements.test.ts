import { describe, expect, it } from 'vitest';
import { ELEMENTS, element, elementBySymbol } from '../src/data/db';
import { molarMass, parseFormula } from '../src/chem/formula';
import { followsMadelung, formatSubshells, madelung, parseConfig } from '../src/chem/aufbau';

describe('element database', () => {
  it('has all 118 elements in order', () => {
    expect(ELEMENTS).toHaveLength(118);
    ELEMENTS.forEach((e, i) => expect(e.z).toBe(i + 1));
    expect(element(118)?.symbol).toBe('Og');
  });

  it('uses CIAAW standard atomic weights', () => {
    expect(elementBySymbol('H')!.mass).toBe(1.008);
    expect(elementBySymbol('Fe')!.mass).toBe(55.845);
    expect(elementBySymbol('Cl')!.mass).toBe(35.45);
  });

  it('gives radioactive elements the mass of their longest-lived isotope', () => {
    const tc = elementBySymbol('Tc')!;
    expect(tc.massSource).toBe('nubase2020');
    expect(tc.massNumber).toBe(97);
  });

  it('has electron counts matching Z in every configuration', () => {
    for (const e of ELEMENTS) {
      const n = parseConfig(e.config).reduce((a, s) => a + s.electrons, 0);
      expect(n, e.symbol).toBe(e.z);
    }
  });
});

describe('molar mass', () => {
  it.each([
    ['H2O', 18.015],
    ['NaCl', 58.44],
    ['CO2', 44.009],
    ['CH4', 16.043],
    ['C2H5OH', 46.069],
    ['Fe2O3', 159.687],
    ['Ca(OH)2', 74.092],
    ['CuSO4·5H2O', 249.68],
  ])('%s = %f g/mol', (f, m) => {
    expect(molarMass(f)).toBeCloseTo(m, 2);
  });

  it('rejects unknown elements and bad brackets', () => {
    expect(() => parseFormula('Xx2')).toThrow();
    expect(() => parseFormula('Ca(OH2')).toThrow();
  });
});

describe('Madelung rule', () => {
  it('fills iron as [Ar] 4s2 3d6', () => {
    expect(formatSubshells(madelung(26))).toBe('1s2 2s2 2p6 3s2 3p6 4s2 3d6');
    expect(followsMadelung(elementBySymbol('Fe')!.config)).toBe(true);
  });

  it('flags the known exceptions Cr and Cu', () => {
    expect(followsMadelung(elementBySymbol('Cr')!.config)).toBe(false);
    expect(followsMadelung(elementBySymbol('Cu')!.config)).toBe(false);
  });
});
