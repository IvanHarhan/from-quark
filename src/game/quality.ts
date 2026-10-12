export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  /** Upper bound on devicePixelRatio. */
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  /** MLS-MPM particle budget. */
  mpmParticles: number;
  /** MPM grid cell size, m (particles are dx/2 apart). */
  mpmDx: number;
  /** Molecules in the zoom-level MD cell (used from stage 6). */
  mdMolecules: number;
}

export const QUALITY: Record<QualityLevel, QualityPreset> = {
  low: { maxPixelRatio: 1, shadows: false, shadowMapSize: 512, mpmParticles: 16_000, mpmDx: 0.012, mdMolecules: 500 },
  medium: { maxPixelRatio: 1.25, shadows: true, shadowMapSize: 1024, mpmParticles: 48_000, mpmDx: 0.01, mdMolecules: 1000 },
  high: { maxPixelRatio: 1.5, shadows: true, shadowMapSize: 2048, mpmParticles: 128_000, mpmDx: 0.008, mdMolecules: 2000 },
  ultra: { maxPixelRatio: 2, shadows: true, shadowMapSize: 4096, mpmParticles: 256_000, mpmDx: 0.006, mdMolecules: 3000 },
};

export const QUALITY_LEVELS = Object.keys(QUALITY) as QualityLevel[];
