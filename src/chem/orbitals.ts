import { Rng } from '../core/rng';
import type { Subshell } from './aufbau';

/** Bohr radius, Å */
export const A0 = 0.529177210903;

/**
 * Electron clouds as hydrogen-like orbitals ψ_nlm = R_nl(r)·Y_lm(θ,φ) with an effective nuclear charge from
 * Slater's rules (J. C. Slater, Phys. Rev. 36, 57 (1930)). This is the standard textbook approximation:
 * the shapes (s spheres, p dumbbells, d clover leaves, nodes) are exact for hydrogen-like atoms; sizes in
 * many-electron atoms are approximate (a few × 10 %).
 */

type Group = { n: number; kind: 'sp' | 'd' | 'f' };

function groupOf(s: { n: number; l: number }): Group {
  return { n: s.n, kind: s.l <= 1 ? 'sp' : s.l === 2 ? 'd' : 'f' };
}

/** Slater groups in order: (1s)(2s2p)(3s3p)(3d)(4s4p)(4d)(4f)(5s5p)(5d)(5f)… */
function groupRank(g: Group): number {
  return g.n * 10 + (g.kind === 'sp' ? 0 : g.kind === 'd' ? 1 : 2);
}

/** Effective nuclear charge felt by an electron in subshell `target` (Slater's rules). */
export function slaterZeff(z: number, shells: Subshell[], target: { n: number; l: number }): number {
  const tg = groupOf(target);
  let S = 0;
  for (const s of shells) {
    const g = groupOf(s);
    const same = g.n === tg.n && g.kind === tg.kind;
    if (same) {
      const others = s.n === target.n && s.l === target.l ? s.electrons - 1 : s.electrons;
      S += others * (tg.n === 1 ? 0.3 : 0.35);
    } else if (groupRank(g) < groupRank(tg)) {
      if (tg.kind === 'sp') S += s.electrons * (g.n === tg.n - 1 ? 0.85 : g.n < tg.n - 1 ? 1.0 : 1.0);
      else S += s.electrons * 1.0;
    }
  }
  return z - S;
}

/** Generalised Laguerre polynomial L_k^α(x) by recurrence. */
function laguerre(k: number, alpha: number, x: number): number {
  if (k === 0) return 1;
  let l0 = 1;
  let l1 = 1 + alpha - x;
  for (let i = 1; i < k; i++) {
    const l2 = ((2 * i + 1 + alpha - x) * l1 - (i + alpha) * l0) / (i + 1);
    l0 = l1;
    l1 = l2;
  }
  return l1;
}

/** Unnormalised radial probability r²R²_nl(r) for charge Zeff, r in Å. */
export function radialProbability(n: number, l: number, zeff: number, r: number): number {
  const rho = (2 * zeff * r) / (n * A0);
  const R = rho ** l * Math.exp(-rho / 2) * laguerre(n - l - 1, 2 * l + 1, rho);
  return r * r * R * R;
}

/** Real spherical harmonics (unnormalised), m = −l..l, for direction (x, y, z) on the unit sphere. */
export function realHarmonic(l: number, m: number, x: number, y: number, z: number): number {
  switch (l) {
    case 0:
      return 1;
    case 1:
      return m === -1 ? y : m === 0 ? z : x;
    case 2:
      switch (m) {
        case -2: return x * y;
        case -1: return y * z;
        case 0: return (3 * z * z - 1) / (2 * Math.sqrt(3));
        case 1: return x * z;
        default: return (x * x - y * y) / 2;
      }
    default:
      switch (m) {
        case -3: return y * (3 * x * x - y * y);
        case -2: return x * y * z;
        case -1: return y * (5 * z * z - 1);
        case 0: return z * (5 * z * z - 3);
        case 1: return x * (5 * z * z - 1);
        case 2: return z * (x * x - y * y);
        default: return x * (x * x - 3 * y * y);
      }
  }
}

export interface CloudPoint {
  x: number;
  y: number;
  z: number;
  /** subshell index in the input list, for colouring */
  shell: number;
}

/** Inverse-CDF table for r over [0, rMax]. */
function radialSampler(n: number, l: number, zeff: number) {
  const rMax = ((n * n) / Math.max(zeff, 0.3)) * A0 * 4 + 1.5 * A0;
  const N = 400;
  const cdf = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) cdf[i] = cdf[i - 1] + radialProbability(n, l, zeff, (i - 0.5) * (rMax / N));
  const total = cdf[N];
  return (u: number) => {
    const t = u * total;
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < t) lo = mid;
      else hi = mid;
    }
    const f = (t - cdf[lo]) / Math.max(cdf[hi] - cdf[lo], 1e-300);
    return ((lo + f) / N) * rMax;
  };
}

/**
 * Point cloud of the electron density of an atom/ion: `perElectron` samples for every electron, each
 * electron drawn from one real orbital of its subshell (Hund: orbitals filled singly first).
 */
export function sampleCloud(z: number, shells: Subshell[], perElectron: number, seed = 1): CloudPoint[] {
  const rng = new Rng(seed);
  const out: CloudPoint[] = [];
  shells.forEach((s, si) => {
    if (s.electrons <= 0) return;
    const zeff = slaterZeff(z, shells, s);
    const sampleR = radialSampler(s.n, s.l, zeff);
    const orbitals = 2 * s.l + 1;
    for (let e = 0; e < s.electrons; e++) {
      const m = (e % orbitals) - s.l;
      // max of |Y|² over the sphere for rejection sampling (estimated once per l, m).
      let maxY = 0;
      for (let k = 0; k < 200; k++) {
        const d = randomDir(rng);
        maxY = Math.max(maxY, realHarmonic(s.l, m, d[0], d[1], d[2]) ** 2);
      }
      maxY *= 1.1;
      for (let k = 0; k < perElectron; k++) {
        let d: [number, number, number];
        do d = randomDir(rng);
        while (rng.next() * maxY > realHarmonic(s.l, m, d[0], d[1], d[2]) ** 2);
        const r = sampleR(rng.next());
        out.push({ x: d[0] * r, y: d[1] * r, z: d[2] * r, shell: si });
      }
    }
  });
  return out;
}

function randomDir(rng: Rng): [number, number, number] {
  const u = rng.next() * 2 - 1;
  const t = rng.next() * 2 * Math.PI;
  const s = Math.sqrt(1 - u * u);
  return [s * Math.cos(t), s * Math.sin(t), u];
}

/** Expectation value ⟨r⟩ of a hydrogen-like orbital, Å: a0/(2Z)·[3n² − l(l+1)]. */
export function meanRadius(n: number, l: number, zeff: number): number {
  return (A0 / (2 * zeff)) * (3 * n * n - l * (l + 1));
}
