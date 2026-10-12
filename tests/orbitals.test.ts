import { describe, expect, it } from 'vitest';
import { ionConfig } from '../src/chem/aufbau';
import { A0, meanRadius, realHarmonic, sampleCloud, slaterZeff } from '../src/chem/orbitals';

describe("Slater's rules", () => {
  it('oxygen 2p feels Z_eff = 4.55', () => {
    expect(slaterZeff(8, ionConfig(8, 8), { n: 2, l: 1 })).toBeCloseTo(4.55, 2);
  });

  it('iron: 3d feels 6.25, 4s feels 3.75', () => {
    const fe = ionConfig(26, 26);
    expect(slaterZeff(26, fe, { n: 3, l: 2 })).toBeCloseTo(6.25, 2);
    expect(slaterZeff(26, fe, { n: 4, l: 0 })).toBeCloseTo(3.75, 2);
  });

  it('hydrogen 1s is the bare nucleus (Z_eff = 1)', () => {
    expect(slaterZeff(1, ionConfig(1, 1), { n: 1, l: 0 })).toBe(1);
  });
});

describe('orbital sampling', () => {
  it('hydrogen 1s samples have ⟨r⟩ = 1.5 a₀', () => {
    const pts = sampleCloud(1, ionConfig(1, 1), 20000, 7);
    const mean = pts.reduce((s, p) => s + Math.hypot(p.x, p.y, p.z), 0) / pts.length;
    expect(mean / A0).toBeCloseTo(1.5, 1);
    expect(meanRadius(1, 0, 1) / A0).toBeCloseTo(1.5, 6);
  });

  it('a p orbital has a nodal plane: almost no density on it', () => {
    const p = { x: 0.3, y: 0.4, z: 0 };
    expect(realHarmonic(1, 0, p.x, p.y, p.z)).toBe(0);
  });

  it('2p of oxygen is a dumbbell: samples avoid the nodal plane of their orbital', () => {
    const shells = [{ n: 2, l: 1, electrons: 1 }];
    const pts = sampleCloud(8, shells, 4000, 3); // one electron → m = −1 → p_y
    const nearPlane = pts.filter((p) => Math.abs(p.y) < 0.02 * Math.hypot(p.x, p.y, p.z)).length;
    expect(nearPlane / pts.length).toBeLessThan(0.01);
  });
});
