import { describe, expect, it } from 'vitest';
import { SUBSTANCES, substance } from '../src/data/substances';
import { ATM, boilingPoint, enthalpyAt, phaseAt, stateFromEnthalpy, vaporPressure, viscosity } from '../src/sim/thermo';
import { molarMass } from '../src/chem/formula';

const water = substance('water');
const C = (c: number) => c + 273.15;

describe('water phases at 1 atm', () => {
  it.each([
    [-10, 'solid'],
    [50, 'liquid'],
    [120, 'gas'],
  ])('%i °C is %s', (t, p) => {
    expect(phaseAt(water, C(t), ATM)).toBe(p);
  });

  it('boils at 100 °C at 1 atm and ~81 °C at half an atmosphere (Antoine)', () => {
    expect(boilingPoint(water, ATM)).toBeCloseTo(373.12, 0);
    expect(boilingPoint(water, ATM / 2) - 273.15).toBeCloseTo(81.3, 0);
  });

  it('vapour pressure at 25 °C is about 3.17 kPa', () => {
    expect(vaporPressure(water, C(25)) / 1000).toBeCloseTo(3.17, 1);
  });

  it('ice sublimates below the triple point', () => {
    expect(phaseAt(water, C(-5), 300)).toBe('gas');
    expect(phaseAt(water, C(-40), 300)).toBe('solid');
  });

  it('is supercritical above 647 K and 22 MPa', () => {
    expect(phaseAt(water, 700, 25e6)).toBe('supercritical');
  });

  it('viscosity is 1.0 mPa·s at 20 °C and 0.28 mPa·s at 100 °C', () => {
    expect(viscosity(water, C(20)) * 1000).toBeCloseTo(1.0, 1);
    expect(viscosity(water, C(100)) * 1000).toBeCloseTo(0.28, 1);
  });
});

describe('melting points', () => {
  it('iron melts at 1811 K (1538 °C)', () => {
    const fe = substance('iron');
    expect(fe.tm).toBe(1811);
    expect(phaseAt(fe, 1800, ATM)).toBe('solid');
    expect(phaseAt(fe, 1820, ATM)).toBe('liquid');
  });

  it('liquid iron viscosity at Tm is a few mPa·s', () => {
    const mu = viscosity(substance('iron'), 1811) * 1000;
    expect(mu).toBeGreaterThan(4);
    expect(mu).toBeLessThan(8);
  });
});

describe('enthalpy bookkeeping', () => {
  it('melting 1 kg of ice at 0 °C takes 333.55 kJ', () => {
    const tb = boilingPoint(water, ATM);
    expect(stateFromEnthalpy(water, 0, tb)).toMatchObject({ T: 273.15, liquid: 0 });
    expect(stateFromEnthalpy(water, 333.55e3, tb)).toMatchObject({ T: 273.15, liquid: 1 });
    expect(stateFromEnthalpy(water, 333.55e3 / 2, tb).liquid).toBeCloseTo(0.5, 6);
  });

  it('round-trips temperature through enthalpy', () => {
    const tb = boilingPoint(water, ATM);
    for (const t of [-20, 0, 25, 99]) expect(stateFromEnthalpy(water, enthalpyAt(water, C(t), tb), tb).T).toBeCloseTo(C(t), 6);
  });

  it('boiling holds at Tb until Lv is supplied', () => {
    const tb = boilingPoint(water, ATM);
    const hb = enthalpyAt(water, tb, tb);
    expect(stateFromEnthalpy(water, hb + water.lv / 2, tb)).toMatchObject({ T: tb, vapor: 0.5 });
  });
});

describe('substance data', () => {
  it('molar masses agree with the formula', () => {
    for (const s of SUBSTANCES) expect(s.molarMass, s.id).toBeCloseTo(molarMass(s.formula), 2);
  });

  it('every value is physical', () => {
    for (const s of SUBSTANCES) {
      expect(s.tb, s.id).toBeGreaterThan(s.tm);
      for (const k of ['rhoSolid', 'rhoLiquid', 'cpSolid', 'cpLiquid', 'lf', 'lv', 'kSolid', 'kLiquid'] as const) {
        expect(s[k], `${s.id}.${k}`).toBeGreaterThan(0);
      }
    }
  });
});
