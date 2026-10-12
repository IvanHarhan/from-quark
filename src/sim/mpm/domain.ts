import { Rng } from '../../core/rng';
import { PARTICLES_PER_CELL_AXIS } from './units';
import type { VesselPose, VesselShape } from '../vessel';

/** Axis-aligned simulation box in world metres, split into nx·ny·nz cells of size dx. */
export interface Domain {
  origin: [number, number, number];
  n: [number, number, number];
  dx: number;
}

/** Cells kept free at each side so the 3×3×3 stencil never leaves the grid. */
export const BOUNDARY_CELLS = 3;

export function makeDomain(min: [number, number, number], max: [number, number, number], dx: number): Domain {
  const n = [0, 1, 2].map((k) => Math.ceil((max[k] - min[k]) / dx) + 2 * BOUNDARY_CELLS) as [number, number, number];
  const origin = [0, 1, 2].map((k) => min[k] - BOUNDARY_CELLS * dx) as [number, number, number];
  return { origin, n, dx };
}

export function cellCount(d: Domain): number {
  return d.n[0] * d.n[1] * d.n[2];
}

/** Seeds a cube (edge `size`, bottom centre at x, y, z in world metres), 2×2×2 jittered per cell. */
export function seedCube(d: Domain, x: number, y: number, z: number, size: number, seed: number): Float32Array {
  const rng = new Rng(seed);
  const h = d.dx / PARTICLES_PER_CELL_AXIS;
  const n = Math.max(1, Math.round(size / h));
  const pts: number[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) {
        const wx = x - size / 2 + (i + 0.5 + rng.range(-0.2, 0.2)) * h;
        const wy = y + (j + 0.5 + rng.range(-0.2, 0.2)) * h;
        const wz = z - size / 2 + (k + 0.5 + rng.range(-0.2, 0.2)) * h;
        pts.push((wx - d.origin[0]) / d.dx, (wy - d.origin[1]) / d.dx, (wz - d.origin[2]) / d.dx, 1);
      }
  return new Float32Array(pts);
}

/**
 * Seeds liquid particles (2×2×2 per cell, jittered) inside a vessel's cavity up to a fill height.
 * Returns positions in grid units (cells from the domain origin), xyzw with w = 1.
 */
export function seedVesselLiquid(
  d: Domain,
  shape: VesselShape,
  pose: VesselPose,
  fillHeight: number,
  seed: number,
): Float32Array {
  const rng = new Rng(seed);
  const h = d.dx / PARTICLES_PER_CELL_AXIS;
  const r = shape.innerRadius - h * 0.5;
  const pts: number[] = [];
  const c = Math.cos(-pose.tilt);
  const s = Math.sin(-pose.tilt);
  for (let y = shape.bottom + h * 0.5; y < shape.bottom + fillHeight; y += h)
    for (let x = -r; x <= r; x += h)
      for (let z = -r; z <= r; z += h) {
        if (x * x + z * z > r * r) continue;
        const jx = x + rng.range(-0.25, 0.25) * h;
        const jy = y + rng.range(-0.25, 0.25) * h;
        const jz = z + rng.range(-0.25, 0.25) * h;
        const wx = pose.x + jx * c - jy * s;
        const wy = pose.y + jx * s + jy * c;
        const wz = pose.z + jz;
        pts.push((wx - d.origin[0]) / d.dx, (wy - d.origin[1]) / d.dx, (wz - d.origin[2]) / d.dx, 1);
      }
  return new Float32Array(pts);
}
