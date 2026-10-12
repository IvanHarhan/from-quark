import type { Rng } from '../core/rng';
import { elementBySymbol } from '../data/db';
import type { DecayBranch, Isotope } from '../data/types';

/** Particles that leave the atom. 'fragment' is a nucleus (cluster or fission fragment) with its own z/a. */
export type Emitted =
  | { kind: 'alpha' | 'electron' | 'positron' | 'antineutrino' | 'neutrino' | 'neutron' | 'proton' | 'deuteron' | 'triton' | 'gamma' }
  | { kind: 'fragment'; z: number; a: number };

export interface DecayOutcome {
  /** NUBASE mode actually taken, e.g. "B-n", "A", "e+", "EC". */
  mode: string;
  z: number;
  a: number;
  /** Change in the electron count of the atom (EC eats one). */
  electronDelta: number;
  emitted: Emitted[];
  /** true when the result comes from a simplified model (fission fragments, unlisted nuclei). */
  simplified: boolean;
}

const LIGHT: Record<string, { dz: number; da: number; kind: 'neutron' | 'proton' | 'deuteron' | 'triton' | 'alpha' }> = {
  n: { dz: 0, da: 1, kind: 'neutron' },
  p: { dz: 1, da: 1, kind: 'proton' },
  d: { dz: 1, da: 2, kind: 'deuteron' },
  t: { dz: 1, da: 3, kind: 'triton' },
  A: { dz: 2, da: 4, kind: 'alpha' },
};

/**
 * Applies a NUBASE decay code to (z, a). Codes chain emissions: "B-2n" = β⁻ then two neutrons,
 * "B+pA" = β⁺ then a proton and an alpha, "14C" = cluster emission, "SF" = spontaneous fission.
 */
export function applyMode(z: number, a: number, mode: string, rng?: Rng): DecayOutcome {
  const out: DecayOutcome = { mode, z, a, electronDelta: 0, emitted: [], simplified: false };
  // "24Ne+26Ne" lists alternative clusters; take the first.
  let rest = /^\d+[A-Z][a-z]?\+\d/.test(mode) ? mode.split('+')[0] : mode;
  while (rest) {
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^(\d*)B([-+])/))) {
      const k = m[1] ? +m[1] : 1;
      const minus = m[2] === '-';
      out.z += minus ? k : -k;
      for (let i = 0; i < k; i++) {
        out.emitted.push({ kind: minus ? 'electron' : 'positron' }, { kind: minus ? 'antineutrino' : 'neutrino' });
      }
    } else if ((m = rest.match(/^e\+/))) {
      out.z -= 1;
      out.emitted.push({ kind: 'positron' }, { kind: 'neutrino' });
    } else if ((m = rest.match(/^EC/))) {
      out.z -= 1;
      out.electronDelta -= 1;
      out.emitted.push({ kind: 'neutrino' });
    } else if ((m = rest.match(/^IT/))) {
      out.emitted.push({ kind: 'gamma' });
    } else if ((m = rest.match(/^SF/))) {
      fission(out, rng);
    } else if ((m = rest.match(/^(\d+)([A-Z][a-z]?)/)) && elementBySymbol(m[2])) {
      const fz = elementBySymbol(m[2])!.z;
      const fa = +m[1];
      out.z -= fz;
      out.a -= fa;
      out.emitted.push({ kind: 'fragment', z: fz, a: fa });
    } else if ((m = rest.match(/^(\d*)([npdtA])/))) {
      const k = m[1] ? +m[1] : 1;
      const p = LIGHT[m[2]];
      out.z -= p.dz * k;
      out.a -= p.da * k;
      for (let i = 0; i < k; i++) out.emitted.push({ kind: p.kind });
    } else if ((m = rest.match(/^\+/))) {
      // separator, as in "EC+B+"
    } else {
      throw new Error(`Unknown decay code "${mode}"`);
    }
    rest = rest.slice(m[0].length);
  }
  return out;
}

/**
 * Real fission yields are a broad double-humped distribution; here the light fragment takes 38–45% of Z
 * and 2–3 prompt neutrons fly off. Marked as simplified.
 */
function fission(out: DecayOutcome, rng?: Rng) {
  const r = rng ? rng.range(0.38, 0.45) : 0.415;
  const nu = rng && rng.next() < 0.5 ? 3 : 2;
  const z1 = Math.round(out.z * r);
  const a1 = Math.round(((out.a - nu) * z1) / out.z);
  out.emitted.push({ kind: 'fragment', z: z1, a: a1 });
  for (let i = 0; i < nu; i++) out.emitted.push({ kind: 'neutron' });
  out.z -= z1;
  out.a -= a1 + nu;
  out.simplified = true;
}

const isBetaPlusFamily = (m: string) => m === 'B+' || m === 'EC+B+';

/** Weighted choice among the modes listed for an isotope, honouring NUBASE sub-branches. */
export function chooseMode(iso: Isotope, electrons: number, rng: Rng): string | null {
  const d = iso.decays;
  const pct = (mode: string) => d.find((b) => b.mode === mode)?.percent ?? null;
  const hasMinus = d.some((b) => b.mode === 'B-');
  const plus = d.find((b) => isBetaPlusFamily(b.mode));

  const isSub = (b: DecayBranch) =>
    (hasMinus && b.mode.startsWith('B-') && b.mode !== 'B-') ||
    (!!plus && b.mode.startsWith('B+') && b.mode !== 'B+') ||
    (!!plus && (b.mode === 'e+' || b.mode === 'EC'));

  // A bare nucleus has no electron to capture.
  const top = d.filter((b) => !isSub(b) && !(b.mode === 'EC' && electrons === 0));
  if (top.length === 0) return null;
  const known = top.filter((b) => b.percent !== null && b.percent > 0);
  const pool = known.length ? known : top;
  let pick = pool[pool.length - 1];
  let x = rng.next() * pool.reduce((s, b) => s + (b.percent ?? 1), 0);
  for (const b of pool) {
    x -= b.percent ?? 1;
    if (x < 0) {
      pick = b;
      break;
    }
  }

  if (pick.mode === 'B-') {
    return pickSub(d.filter((b) => isSub(b) && b.mode.startsWith('B-')), pick.percent, rng) ?? 'B-';
  }
  if (isBetaPlusFamily(pick.mode)) {
    const delayed = pickSub(d.filter((b) => isSub(b) && b.mode.startsWith('B+')), pick.percent, rng);
    if (delayed) return delayed;
    const ePlus = pct('e+');
    const ec = pct('EC');
    if (electrons === 0) return ec !== null && ePlus === null ? null : 'e+';
    if (ePlus !== null && ec !== null) return rng.next() * (ePlus + ec) < ePlus ? 'e+' : 'EC';
    if (ec !== null && ePlus === null) return 'EC';
    return 'e+';
  }
  return pick.mode;
}

function pickSub(subs: DecayBranch[], parentPct: number | null, rng: Rng): string | null {
  const parent = parentPct ?? 100;
  let x = rng.next() * parent;
  for (const b of subs) {
    if (b.percent === null) continue;
    x -= b.percent;
    if (x < 0) return b.mode;
  }
  return null;
}

/** Probability that a nucleus with half-life T decays within dt. */
export function decayProbability(halfLife: number, dt: number): number {
  return -Math.expm1((-Math.LN2 * dt) / halfLife);
}
