import { describe, expect, it } from 'vitest';
import { SUBSTANCES, substance } from '../src/data/substances';
import { boxEdges, createCell, hydrogenBonds, iceIh, kineticTemperature, moleculeSites, stepCell } from '../src/sim/micro/cell';

describe('ice Ih', () => {
  const ice = iceIh(4, 2, 2);
  const n = ice.o.length / 3;
  const dist = (i: number, j: number) =>
    Math.hypot(
      ...[0, 1, 2].map((k) => {
        let d = ice.o[j * 3 + k] - ice.o[i * 3 + k];
        d -= ice.box[k] * Math.round(d / ice.box[k]);
        return d;
      }),
    );

  it('has 8 molecules per orthorhombic cell and 4 neighbours at 2.76 Å each', () => {
    expect(n).toBe(4 * 2 * 2 * 8);
    for (let i = 0; i < n; i++) {
      const near: number[] = [];
      for (let j = 0; j < n; j++) if (j !== i && dist(i, j) < 3.0) near.push(dist(i, j));
      expect(near.length, `O${i}`).toBe(4);
      for (const d of near) expect(d).toBeCloseTo(2.76, 1);
    }
  });

  it('obeys the ice rules: every O donates exactly two protons and accepts two', () => {
    const out = new Array(n).fill(0);
    const inn = new Array(n).fill(0);
    for (const [d, a] of ice.donors) {
      out[d]++;
      inn[a]++;
    }
    expect(out.every((x) => x === 2)).toBe(true);
    expect(inn.every((x) => x === 2)).toBe(true);
  });

  it('a frozen cell shows about two hydrogen bonds per molecule', () => {
    const c = createCell({ substance: substance('water'), phase: 'solid', temperature: 260, pressure: 101325 });
    const hb = hydrogenBonds(c).length / c.kind.length;
    expect(hb).toBeGreaterThan(1.6);
    expect(hb).toBeLessThan(2.2);
  });
});

describe('micro dynamics', () => {
  it('liquid water holds its temperature (Langevin thermostat)', () => {
    const c = createCell({ substance: substance('water'), phase: 'liquid', temperature: 300, pressure: 101325 }, 3);
    stepCell(c, 0.002, 200);
    expect(kineticTemperature(c)).toBeGreaterThan(240);
    expect(kineticTemperature(c)).toBeLessThan(360);
  }, 30_000);

  it('liquid water has its real density', () => {
    const s = substance('water');
    const c = createCell({ substance: s, phase: 'liquid', temperature: 300, pressure: 101325 });
    const [x, y, z] = boxEdges(c);
    const rho = (c.kind.length * s.molarMass * 1.66054e-27) / (x * y * z * 1e-30);
    expect(rho).toBeCloseTo(s.rhoLiquid, -1);
  });

  it('iron is a BCC lattice whose atoms vibrate by the Lindemann amount', () => {
    const c = createCell({ substance: substance('iron'), phase: 'solid', temperature: 1500, pressure: 101325 });
    expect(c.kind.length).toBe(2 * 6 ** 3);
    stepCell(c, 0.002, 400);
    let sum = 0;
    const edges = boxEdges(c);
    for (let i = 0; i < c.kind.length; i++)
      for (let k = 0; k < 3; k++) {
        let d = c.pos[i * 3 + k] - c.anchor![i * 3 + k];
        d -= edges[k] * Math.round(d / edges[k]);
        sum += d * d;
      }
    const rms = Math.sqrt(sum / c.kind.length);
    const nn = (2.8665 * Math.sqrt(3)) / 2;
    expect(rms / nn).toBeGreaterThan(0.05);
    expect(rms / nn).toBeLessThan(0.12);
  }, 30_000);

  it('every substance builds its real molecule (from SMILES) in every phase', () => {
    expect(moleculeSites(substance('sugar')).length).toBe(45);
    expect(moleculeSites(substance('glycine')).map((s) => s.z).sort((a, b) => a - b)).toEqual([1, 1, 1, 1, 1, 6, 6, 7, 8, 8]);
    expect(moleculeSites(substance('rust')).length).toBe(5);
    for (const s of SUBSTANCES)
      for (const phase of ['solid', 'liquid', 'gas'] as const) {
        const c = createCell({ substance: s, phase, temperature: phase === 'gas' ? s.tb + 50 : s.tm - 10, pressure: 101325 });
        expect(c.kind.length, `${s.id} ${phase}`).toBeGreaterThan(0);
        expect(Number.isFinite(c.box), `${s.id} ${phase}`).toBe(true);
      }
  });

  it('steam at 100 °C, 1 atm has the ideal-gas number density', () => {
    const c = createCell({ substance: substance('water'), phase: 'gas', temperature: 373.15, pressure: 101325 });
    const n = c.kind.length / (c.box * 1e-10) ** 3;
    expect(n / (101325 / (1.380649e-23 * 373.15))).toBeCloseTo(1, 5);
  });
});
