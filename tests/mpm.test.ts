import { describe, expect, it } from 'vitest';
import { cellCount, makeDomain, seedVesselLiquid } from '../src/sim/mpm/domain';
import { bulkModulus, mpmUnits, pressureToGrid, substepsFor } from '../src/sim/mpm/units';
import { BEAKER_1L, createVessel, innerVolume, stepVessel, traySdf, vesselSdf, worldToVessel } from '../src/sim/vessel';

describe('MPM units', () => {
  it('particle mass matches density × volume', () => {
    const u = mpmUnits(0.008, 1000);
    expect(u.particleMass).toBeCloseTo(1000 * 0.004 ** 3, 12);
    // 8 particles per cell weigh exactly one cell of water.
    expect(u.particleMass * 8).toBeCloseTo(1000 * 0.008 ** 3, 12);
  });

  it('substeps respect the CFL limit', () => {
    const n = substepsFor(1 / 60, 0.008);
    expect((1 / 60 / n) * 6).toBeLessThanOrEqual(0.4 * 0.008 + 1e-12);
  });

  it('converts pressure consistently', () => {
    const u = mpmUnits(0.01, 1000);
    // ρc² for c = 6 m/s is 36 kPa.
    expect(bulkModulus(1000)).toBe(36000);
    expect(pressureToGrid(36000, u)).toBeCloseTo((36000 * 0.01) / u.particleMass, 6);
  });
});

describe('beaker', () => {
  it('holds about a litre', () => {
    expect(innerVolume(BEAKER_1L) * 1000).toBeCloseTo(1.04, 1);
  });

  it('SDF: negative in glass, positive in cavity and outside', () => {
    const s = BEAKER_1L;
    expect(vesselSdf(s, s.innerRadius + s.wall / 2, 0.07, 0)).toBeLessThan(0);
    expect(vesselSdf(s, 0, s.bottom / 2, 0)).toBeLessThan(0);
    expect(vesselSdf(s, 0, 0.07, 0)).toBeGreaterThan(0);
    expect(vesselSdf(s, 0.2, 0.07, 0)).toBeGreaterThan(0);
    expect(vesselSdf(s, 0, 0.3, 0)).toBeGreaterThan(0);
  });

  it('tilting 90° pivots about the lip and lays the opening towards +x', () => {
    const v = createVessel(BEAKER_1L, 0, 0.9, 0);
    v.targetTilt = Math.PI / 2;
    for (let i = 0; i < 200; i++) stepVessel(v, 1 / 60);
    expect(v.pose.tilt).toBeCloseTo(Math.PI / 2, 5);
    // The lip stays where it was.
    const lip = worldToVessel(v.pose, 0.053, 0.9 + 0.14, 0);
    expect(lip[0]).toBeCloseTo(0.053, 5);
    expect(lip[1]).toBeCloseTo(0.14, 5);
    // A point just above the old opening is now inside the cavity direction (+x side of the bottom).
    const bottomWorldX = v.pose.x;
    expect(bottomWorldX).toBeLessThan(0);
  });
});

describe('tray', () => {
  const t = { minX: -0.2, maxX: 0.2, minZ: -0.1, maxZ: 0.1, floorY: 0.912, rim: 0.06, wall: 0.012 };
  it('SDF: cavity and outside positive, walls and base negative', () => {
    expect(traySdf(t, 0, 0.93, 0)).toBeGreaterThan(0);
    expect(traySdf(t, 0, 0.906, 0)).toBeLessThan(0);
    expect(traySdf(t, 0.206, 0.94, 0)).toBeLessThan(0);
    expect(traySdf(t, 0.25, 0.94, 0)).toBeGreaterThan(0);
    // Open top: above the rim inside the footprint is free space.
    expect(traySdf(t, 0, 1.1, 0)).toBeGreaterThan(0);
  });
});

describe('seeding', () => {
  it('fills the beaker with the right amount of water', () => {
    const dx = 0.008;
    const d = makeDomain([-0.3, 0.88, -0.2], [0.3, 1.2, 0.2], dx);
    const v = createVessel(BEAKER_1L, 0, 0.9, 0);
    const fill = 0.09;
    const pts = seedVesselLiquid(d, BEAKER_1L, v.pose, fill, 1);
    const count = pts.length / 4;
    const mass = count * mpmUnits(dx, 1000).particleMass;
    const expected = 1000 * Math.PI * BEAKER_1L.innerRadius ** 2 * fill;
    expect(mass / expected).toBeGreaterThan(0.85);
    expect(mass / expected).toBeLessThan(1.1);
    // Every particle lies well inside the grid.
    for (let i = 0; i < count; i++)
      for (let k = 0; k < 3; k++) {
        expect(pts[i * 4 + k]).toBeGreaterThan(2);
        expect(pts[i * 4 + k]).toBeLessThan(d.n[k] - 2);
      }
    expect(cellCount(d)).toBe(d.n[0] * d.n[1] * d.n[2]);
  });

  it('is deterministic', () => {
    const d = makeDomain([-0.1, 0.88, -0.1], [0.1, 1.1, 0.1], 0.01);
    const v = createVessel(BEAKER_1L, 0, 0.9, 0);
    expect(seedVesselLiquid(d, BEAKER_1L, v.pose, 0.05, 7)).toEqual(seedVesselLiquid(d, BEAKER_1L, v.pose, 0.05, 7));
  });
});
