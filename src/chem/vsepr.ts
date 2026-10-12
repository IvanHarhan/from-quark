import { neighbors, nonBondingElectrons, type Molecule } from './molecule';

export type Geometry =
  | 'linear'
  | 'trigonalPlanar'
  | 'bent'
  | 'tetrahedral'
  | 'trigonalPyramidal'
  | 'trigonalBipyramidal'
  | 'seesaw'
  | 'tShaped'
  | 'octahedral'
  | 'squarePyramidal'
  | 'squarePlanar';

export interface CenterInfo {
  atom: number;
  bonded: number;
  lonePairs: number;
  /** An odd non-bonding electron (radical) also occupies a domain. */
  radical: boolean;
  /** Electron domains: bonded atoms + lone pairs (+ radical). */
  steric: number;
  geometry: Geometry | null;
  /** Distinct ideal angles between bonds, degrees. */
  idealAngles: number[];
}

type V3 = [number, number, number];

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Ideal electron-domain directions; LP_SLOTS says which ones lone pairs take first. */
const DOMAINS: Record<number, V3[]> = {
  2: [[1, 0, 0], [-1, 0, 0]],
  3: [0, 1, 2].map((k) => [Math.cos((2 * Math.PI * k) / 3), Math.sin((2 * Math.PI * k) / 3), 0] as V3),
  4: ([[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]] as V3[]).map(norm),
  // Equatorial first: lone pairs go equatorial in a trigonal bipyramid.
  5: [
    ...[0, 1, 2].map((k) => [Math.cos((2 * Math.PI * k) / 3), Math.sin((2 * Math.PI * k) / 3), 0] as V3),
    [0, 0, 1],
    [0, 0, -1],
  ],
  // +z then -z first: two lone pairs end up trans (square planar).
  6: [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]],
};

const GEOMETRY: Record<string, Geometry> = {
  '2:0': 'linear',
  '3:0': 'trigonalPlanar', '3:1': 'bent',
  '4:0': 'tetrahedral', '4:1': 'trigonalPyramidal', '4:2': 'bent',
  '5:0': 'trigonalBipyramidal', '5:1': 'seesaw', '5:2': 'tShaped', '5:3': 'linear',
  '6:0': 'octahedral', '6:1': 'squarePyramidal', '6:2': 'squarePlanar',
};

export function bondSlots(steric: number, lone: number): V3[] {
  const d = DOMAINS[steric];
  return d ? d.slice(lone) : [];
}

function distinctAngles(slots: V3[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < slots.length; i++)
    for (let j = i + 1; j < slots.length; j++) {
      const [a, b] = [slots[i], slots[j]];
      const deg = (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
      const r = Math.round(deg * 100) / 100;
      if (!out.some((x) => Math.abs(x - r) < 0.5)) out.push(r);
    }
  return out.sort((a, b) => a - b);
}

export function analyzeCenter(m: Molecule, i: number): CenterInfo {
  const bonded = neighbors(m, i).length;
  const nb = nonBondingElectrons(m, i);
  const lonePairs = nb === null ? 0 : Math.floor(nb / 2);
  const radical = nb !== null && nb % 2 === 1;
  const steric = bonded + lonePairs + (radical ? 1 : 0);
  const lone = steric - bonded;
  const geometry = bonded >= 2 ? (GEOMETRY[`${steric}:${lone}`] ?? null) : null;
  return {
    atom: i,
    bonded,
    lonePairs,
    radical,
    steric,
    geometry,
    idealAngles: geometry ? distinctAngles(bondSlots(steric, lone)) : [],
  };
}
