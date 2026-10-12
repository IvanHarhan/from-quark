import { Rng } from '../core/rng';
import { element } from '../data/db';
import type { MoleculeEntry } from '../data/molecules';
import type { SourceId } from '../data/types';
import { neighbors, type MBond, type Molecule } from './molecule';
import { analyzeCenter, type CenterInfo } from './vsepr';

/** Positions in ångströms, 3 numbers per atom. */
export type Positions = Float64Array;

export interface BondLength {
  value: number;
  source: SourceId;
}

const BOND_CHAR = ['', '-', '=', '#'];

function sym(z: number) {
  return element(z)!.symbol;
}

export function bondKey(m: Molecule, b: MBond): string {
  const [x, y] = [sym(m.atoms[b.a].z), sym(m.atoms[b.b].z)].sort();
  return `${x}${BOND_CHAR[b.order]}${y}`;
}

/** Experimental length if the molecule is in the reference set, else the sum of Pyykkö radii. */
export function bondLength(m: Molecule, b: MBond, ref?: MoleculeEntry): BondLength {
  const exp = ref?.bonds?.[bondKey(m, b)];
  if (exp !== undefined) return { value: exp, source: 'cccbdb' };
  const r = (z: number) => {
    const cr = element(z)!.covalentRadius;
    return cr[b.order - 1] ?? cr[0] ?? 150;
  };
  return { value: (r(m.atoms[b.a].z) + r(m.atoms[b.b].z)) / 100, source: 'pyykko' };
}

export interface CenterGeometry extends CenterInfo {
  /** Target angle between two neighbours (indices into neighbors(m, atom)). */
  target(k: number, l: number, current: number): number;
  source: SourceId;
}

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/**
 * Angle targets for a centre. Reference molecules with a measured angle use it: all-identical neighbours
 * get that angle (H₂O, NH₃, CH₄); a planar centre with a measured X–C–X pair (C₂H₄, CH₂O) splits the rest
 * evenly. Otherwise the nearest ideal VSEPR angle is used, which also sorts 90°/120°/180° pairs in
 * bipyramids and octahedra.
 */
export function centerGeometry(m: Molecule, i: number, ref?: MoleculeEntry): CenterGeometry {
  const info = analyzeCenter(m, i);
  const nb = neighbors(m, i);
  const c = sym(m.atoms[i].z);
  const nbSym = nb.map((j) => sym(m.atoms[j].z));
  const angles = ref?.angles ?? {};

  if (nb.length >= 2) {
    const allSame = nbSym.every((s) => s === nbSym[0]);
    const key = `${nbSym[0]}-${c}-${nbSym[0]}`;
    if (allSame && angles[key] !== undefined) {
      const a = angles[key];
      return { ...info, source: 'cccbdb', target: () => a };
    }
    if (nb.length === 3 && info.geometry === 'trigonalPlanar') {
      for (const s of new Set(nbSym)) {
        const pair = nbSym.filter((x) => x === s).length === 2 ? angles[`${s}-${c}-${s}`] : undefined;
        if (pair !== undefined) {
          return {
            ...info,
            source: 'cccbdb',
            target: (k, l) => (nbSym[k] === s && nbSym[l] === s ? pair : (360 - pair) / 2),
          };
        }
      }
    }
  }
  const ideal = info.idealAngles;
  return {
    ...info,
    source: 'vsepr',
    target: (_k, _l, current) =>
      ideal.length ? ideal.reduce((best, a) => (Math.abs(a - current) < Math.abs(best - current) ? a : best)) : current,
  };
}

/**
 * 3D structure by relaxation: bond springs to target lengths, 1–3 springs to target angles,
 * soft repulsion between everything else. Starts from a flat tree layout so π-systems stay planar.
 * Deterministic for a given molecule.
 */
export function embed(m: Molecule, ref?: MoleculeEntry, iterations = 700): Positions {
  const n = m.atoms.length;
  const p = new Float64Array(n * 3);
  if (n === 0) return p;
  const rng = new Rng(n * 7919 + m.bonds.length * 104729);
  const lengths = m.bonds.map((b) => bondLength(m, b, ref).value);
  const nbs = m.atoms.map((_, i) => neighbors(m, i));

  // Flat BFS layout (z jitter lets non-planar centres pop out).
  const placed = new Array(n).fill(false);
  let offset = 0;
  for (let root = 0; root < n; root++) {
    if (placed[root]) continue;
    p.set([offset, 0, 0], root * 3);
    placed[root] = true;
    const queue: [number, number][] = [[root, rng.range(0, Math.PI * 2)]];
    while (queue.length) {
      const [i, dir] = queue.shift()!;
      const kids = nbs[i].filter((j) => !placed[j]);
      kids.forEach((j, k) => {
        const angle = dir + ((k + 1) * 2 * Math.PI) / (kids.length + 1) + Math.PI;
        const bi = m.bonds.findIndex((b) => (b.a === i && b.b === j) || (b.a === j && b.b === i));
        const L = lengths[bi];
        p.set([p[i * 3] + Math.cos(angle) * L, p[i * 3 + 1] + Math.sin(angle) * L, rng.range(-0.05, 0.05)], j * 3);
        placed[j] = true;
        queue.push([j, angle + Math.PI]);
      });
    }
    offset += 6;
  }

  const centers = m.atoms.map((_, i) => (nbs[i].length >= 2 ? centerGeometry(m, i, ref) : null));
  const bonded = new Set<string>();
  const pairKey = (i: number, j: number) => (i < j ? `${i}:${j}` : `${j}:${i}`);
  for (const b of m.bonds) bonded.add(pairKey(b.a, b.b));
  for (const nb of nbs) for (let k = 0; k < nb.length; k++) for (let l = k + 1; l < nb.length; l++) bonded.add(pairKey(nb[k], nb[l]));

  const f = new Float64Array(n * 3);
  const spring = (i: number, j: number, target: number, k: number) => {
    const dx = p[j * 3] - p[i * 3];
    const dy = p[j * 3 + 1] - p[i * 3 + 1];
    const dz = p[j * 3 + 2] - p[i * 3 + 2];
    const d = Math.hypot(dx, dy, dz) || 1e-6;
    const s = (k * (d - target)) / d;
    f[i * 3] += s * dx; f[i * 3 + 1] += s * dy; f[i * 3 + 2] += s * dz;
    f[j * 3] -= s * dx; f[j * 3 + 1] -= s * dy; f[j * 3 + 2] -= s * dz;
  };
  const dist = (i: number, j: number) =>
    Math.hypot(p[j * 3] - p[i * 3], p[j * 3 + 1] - p[i * 3 + 1], p[j * 3 + 2] - p[i * 3 + 2]);

  for (let it = 0; it < iterations; it++) {
    f.fill(0);
    m.bonds.forEach((b, k) => spring(b.a, b.b, lengths[k], 1));
    centers.forEach((cg, c) => {
      if (!cg) return;
      const nb = nbs[c];
      for (let k = 0; k < nb.length; k++)
        for (let l = k + 1; l < nb.length; l++) {
          const target = cg.target(k, l, measureAngle(p, c, nb[k], nb[l]));
          const L1 = dist(c, nb[k]);
          const L2 = dist(c, nb[l]);
          if (target > 179) {
            // A 1–3 spring has zero gradient at 180°; pull the centre onto the neighbours' axis instead.
            const [i, j] = [nb[k], nb[l]];
            for (let a = 0; a < 3; a++) {
              const q = (p[i * 3 + a] * L2 + p[j * 3 + a] * L1) / (L1 + L2);
              const d = 0.5 * (q - p[c * 3 + a]);
              f[c * 3 + a] += d;
              f[i * 3 + a] -= d / 2;
              f[j * 3 + a] -= d / 2;
            }
            continue;
          }
          const d13 = Math.sqrt(L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(rad(target)));
          spring(nb[k], nb[l], d13, 0.5);
        }
    });
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (bonded.has(pairKey(i, j))) continue;
        const d = dist(i, j);
        if (d < 2.5) spring(i, j, 2.5, 0.08);
      }
    const step = it < iterations * 0.7 ? 0.25 : 0.1;
    for (let k = 0; k < n * 3; k++) p[k] += Math.max(-0.2, Math.min(0.2, f[k] * step));
  }

  // Centre at the origin.
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += p[i * 3 + k] / n;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) p[i * 3 + k] -= c[k];
  return p;
}

export function measureAngle(p: Positions, c: number, i: number, j: number): number {
  const a = [p[i * 3] - p[c * 3], p[i * 3 + 1] - p[c * 3 + 1], p[i * 3 + 2] - p[c * 3 + 2]];
  const b = [p[j * 3] - p[c * 3], p[j * 3 + 1] - p[c * 3 + 1], p[j * 3 + 2] - p[c * 3 + 2]];
  const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b) || 1);
  return deg(Math.acos(Math.max(-1, Math.min(1, cos))));
}

export function measureDistance(p: Positions, i: number, j: number): number {
  return Math.hypot(p[j * 3] - p[i * 3], p[j * 3 + 1] - p[i * 3 + 1], p[j * 3 + 2] - p[i * 3 + 2]);
}
