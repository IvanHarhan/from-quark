/**
 * MLS-MPM runs in grid units: length = cell size dx, mass = one particle's mass, time = seconds.
 * This keeps grid momenta in a range where fixed-point integer atomics (deterministic, order-independent)
 * have plenty of precision.
 *
 * Model limits, stated honestly: liquids are weakly compressible. Real water has a speed of sound of
 * ~1480 m/s, which would need ~10⁵ substeps per second at this resolution; we use an artificial sound
 * speed well above the flow speeds instead, so density stays within a few percent of the real value.
 * Surface tension is not modelled.
 */

/** 8 particles per cell (2×2×2), the usual MPM sampling. */
export const PARTICLES_PER_CELL_AXIS = 2;
/** Artificial speed of sound for liquids, m/s. Flow speeds in the lab stay below ~2–3 m/s. */
export const SOUND_SPEED = 6;
/** CFL safety factor for the explicit step. */
export const CFL = 0.4;
/** Fixed-point scale for integer atomics in P2G. */
export const FIXED_POINT = 1e4;
/** Particles may move at most this many cells per substep (velocity clamp keeps CFL under impacts). */
export const MAX_CELLS_PER_STEP = 0.45;

export interface MpmUnits {
  dx: number;
  /** Mass of one particle, kg. */
  particleMass: number;
  /** Particle volume in cells³. */
  particleVolume: number;
}

export function mpmUnits(dx: number, density: number): MpmUnits {
  const spacing = dx / PARTICLES_PER_CELL_AXIS;
  return { dx, particleMass: density * spacing ** 3, particleVolume: 1 / PARTICLES_PER_CELL_AXIS ** 3 };
}

/** Pressure / stress in Pa → grid units (particle-mass / (cell · s²)). */
export function pressureToGrid(pa: number, u: MpmUnits): number {
  return (pa * u.dx) / u.particleMass;
}

/** Dynamic viscosity Pa·s → grid units. */
export function viscosityToGrid(paS: number, u: MpmUnits): number {
  return (paS * u.dx) / u.particleMass;
}

/** Bulk modulus giving the chosen artificial sound speed: K = ρc². */
export function bulkModulus(density: number, soundSpeed = SOUND_SPEED): number {
  return density * soundSpeed * soundSpeed;
}

/** Number of equal substeps so each is within the CFL limit for the sound speed. */
export function substepsFor(frameDt: number, dx: number, soundSpeed = SOUND_SPEED): number {
  const maxDt = (CFL * dx) / soundSpeed;
  return Math.max(1, Math.ceil(frameDt / maxDt));
}
