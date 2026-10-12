import type { Rng } from '../core/rng';
import { isotope, isotopesOf } from '../data/db';
import type { Isotope } from '../data/types';
import { applyMode, chooseMode, decayProbability, type DecayOutcome } from './decay';

export type NucleusStatus =
  | { kind: 'empty' }
  /** Z beyond the known table. */
  | { kind: 'unknownElement' }
  | { kind: 'stable'; iso: Isotope }
  /** Radioactive in general, but every listed mode needs an electron and the nucleus is bare (e.g. ⁷Be⁴⁺). */
  | { kind: 'bareStable'; iso: Isotope }
  | { kind: 'radioactive'; iso: Isotope; halfLife: number }
  /** Falls apart at once: particle-unbound in NUBASE, or not in NUBASE at all (iso = null, outside the drip lines). */
  | { kind: 'unbound'; iso: Isotope | null };

/** Requires loadIsotopes() to have resolved. */
export function nucleusStatus(z: number, a: number, electrons: number): NucleusStatus {
  if (a === 0) return { kind: 'empty' };
  if (z > 118) return { kind: 'unknownElement' };
  const iso = isotope(z, a);
  if (!iso) return { kind: 'unbound', iso: null };
  if (iso.stable) return { kind: 'stable', iso };
  if (iso.halfLife === null) return { kind: 'unbound', iso };
  if (electrons === 0 && iso.decays.length > 0 && iso.decays.every((d) => d.mode === 'EC')) return { kind: 'bareStable', iso };
  return { kind: 'radioactive', iso, halfLife: iso.halfLife };
}

/**
 * Decay that happens immediately for unbound nuclei. Listed ones use their NUBASE mode; nuclei missing from
 * NUBASE shed a neutron if heavier than every known isotope, otherwise a proton (simplified).
 */
export function immediateDecay(z: number, a: number, electrons: number, rng: Rng): DecayOutcome | null {
  const iso = isotope(z, a);
  if (iso) {
    const mode = chooseMode(iso, electrons, rng);
    return mode ? applyMode(z, a, mode, rng) : null;
  }
  if (z === 0) return { ...applyMode(z, a, 'n'), simplified: true };
  const known = isotopesOf(z);
  const heavy = known.length === 0 || a > Math.max(...known.map((i) => i.a));
  return { ...applyMode(z, a, heavy ? 'n' : 'p'), simplified: true };
}

/** One fixed step of radioactive decay; returns the outcome if the nucleus decayed during dt. */
export function stepDecay(z: number, a: number, electrons: number, dt: number, rng: Rng): DecayOutcome | null {
  const st = nucleusStatus(z, a, electrons);
  if (st.kind === 'unbound') return immediateDecay(z, a, electrons, rng);
  if (st.kind !== 'radioactive') return null;
  if (rng.next() >= decayProbability(st.halfLife, dt)) return null;
  const mode = chooseMode(st.iso, electrons, rng);
  return mode ? applyMode(z, a, mode, rng) : null;
}
