import { parseFormula } from '../../chem/formula';
import { embed } from '../../chem/geometry';
import { parseSmiles } from '../../chem/smiles';
import { Rng } from '../../core/rng';
import { elementBySymbol } from '../../data/db';
import type { Substance } from '../../data/substances';

/**
 * Molecular-scale view of a substance at a given temperature and phase: a periodic box of a few hundred
 * molecules or atoms, generated from the macro state where the player zoomed in and run with simple
 * Langevin dynamics. Units: Å, ps, amu (energy amu·Å²/ps² = 10 J/mol).
 *
 * What is real and what is a model:
 *  - Crystal structures and lattice constants are real (ice Ih with the Bernal–Fowler ice rules,
 *    iron/sodium/potassium BCC, lead/aluminium/copper/gold FCC, NaCl rock salt). Molecules come from
 *    the substance's SMILES through the molecule builder's embedding. Thermal vibration amplitude follows the
 *    Lindemann rule (≈10 % of the neighbour distance at the melting point, ∝ √T).
 *  - Liquids: Lennard-Jones between molecule centres (water: SPC/E O–O parameters) with a Langevin
 *    thermostat at the real temperature; molecular orientations diffuse randomly. No charges, so
 *    hydrogen bonds are detected geometrically rather than simulated.
 *  - Gases: ideal-gas density n = P/kT, ballistic Maxwell–Boltzmann motion.
 *  - The view runs ~10¹² times slower than reality: molecular motion happens in picoseconds.
 */

export const KB = 0.831446261815324; // amu·Å²/(ps²·K)
const NA = 6.02214076e23;

export type CellPhase = 'solid' | 'liquid' | 'gas';

export interface Site {
  /** element atomic number */
  z: number;
  /** position in the molecule frame, Å */
  local: [number, number, number];
}

export interface CellSpec {
  substance: Substance;
  phase: CellPhase;
  /** K */
  temperature: number;
  /** Pa */
  pressure: number;
}

export interface MicroCell {
  spec: CellSpec;
  /** periodic box edge, Å */
  box: number;
  /** atoms of one molecule (one site for atomic substances, two for NaCl pairs is avoided: ions are separate) */
  molecules: { sites: Site[]; mass: number }[];
  /** per molecule: centre position, velocity, orientation quaternion (x,y,z,w) */
  pos: Float64Array;
  vel: Float64Array;
  rot: Float64Array;
  /** lattice site (solids) */
  anchor: Float64Array | null;
  /** Molecule kinds per molecule (index into `molecules`). */
  kind: Uint8Array;
  rng: Rng;
  /** ps simulated so far */
  time: number;
}

// ---------- molecule templates ----------

const WATER: Site[] = (() => {
  // SPC/E-like rigid water: O–H 1.0 Å in SPC/E; we use the experimental 0.9572 Å and 104.52°.
  const r = 0.9572;
  const half = (104.52 / 2) * (Math.PI / 180);
  return [
    { z: 8, local: [0, 0, 0] },
    { z: 1, local: [r * Math.sin(half), r * Math.cos(half), 0] },
    { z: 1, local: [-r * Math.sin(half), r * Math.cos(half), 0] },
  ];
})();

const ATOM = (z: number): Site[] => [{ z, local: [0, 0, 0] }];

/** Elemental Z of single-element metals. */
const ELEMENT_Z: Record<string, number> = {
  iron: 26, lead: 82, gallium: 31, mercury: 80, aluminium: 13, copper: 29, gold: 79, sodium: 11, potassium: 19, magnesium: 12,
};

/** Metals keep a sea of free electrons between the ions. */
export const isMetal = (s: Substance) => s.id in ELEMENT_Z;

/** Real crystal structures, lattice constants at room temperature (CRC). */
const LATTICE: Record<string, { type: 'bcc' | 'fcc' | 'rocksalt'; a: number }> = {
  iron: { type: 'bcc', a: 2.8665 },
  sodium: { type: 'bcc', a: 4.2906 },
  potassium: { type: 'bcc', a: 5.328 },
  lead: { type: 'fcc', a: 4.9508 },
  aluminium: { type: 'fcc', a: 4.0495 },
  copper: { type: 'fcc', a: 3.6149 },
  gold: { type: 'fcc', a: 4.0782 },
  nacl: { type: 'rocksalt', a: 5.6402 },
};

/** Ice Ih (hexagonal), a and c at ~250 K. */
const ICE_A = 4.5181;
const ICE_C = 7.356;

/** Lennard-Jones parameters (σ Å, ε amu·Å²/ps²) for liquid/gas dynamics. */
function ljParams(s: Substance): { sigma: number; eps: number } {
  if (s.id === 'water') return { sigma: 3.166, eps: 65.02 }; // SPC/E O–O, 0.6502 kJ/mol
  // Others: σ from the condensed-phase volume per molecule, ε from Tm (T*_m ≈ 0.7 for LJ) — a fitted model.
  const volPerMol = s.molarMass / 1000 / s.rhoLiquid / NA; // m³
  const sigma = Math.cbrt(volPerMol) * 1e10 * 1.05;
  return { sigma, eps: (KB * s.tm) / 0.7 };
}

/** Sites of one molecule of a substance (simplified for large organics). */
export function moleculeSites(s: Substance): Site[] {
  if (s.id === 'water') return WATER;
  if (ELEMENT_Z[s.id]) return ATOM(ELEMENT_Z[s.id]);
  if (s.id === 'ethanol') {
    return [
      { z: 6, local: [-1.17, -0.4, 0] },
      { z: 6, local: [0.17, 0.33, 0] },
      { z: 8, local: [1.2, -0.62, 0] },
      { z: 1, local: [1.97, -0.06, 0] },
      { z: 1, local: [-1.96, 0.36, 0] },
      { z: 1, local: [-1.27, -1.04, 0.88] },
      { z: 1, local: [-1.27, -1.04, -0.88] },
      { z: 1, local: [0.25, 0.97, 0.89] },
      { z: 1, local: [0.25, 0.97, -0.89] },
    ];
  }
  if (s.id === 'glycerol') {
    return [
      { z: 6, local: [-1.25, 0.3, 0] }, { z: 6, local: [0, -0.5, 0] }, { z: 6, local: [1.25, 0.3, 0] },
      { z: 8, local: [-2.4, -0.5, 0] }, { z: 8, local: [0, -1.4, 1.0] }, { z: 8, local: [2.4, -0.5, 0] },
      { z: 1, local: [-1.25, 1.0, 0.85] }, { z: 1, local: [-1.25, 1.0, -0.85] }, { z: 1, local: [0, -1.0, -0.9] },
      { z: 1, local: [1.25, 1.0, 0.85] }, { z: 1, local: [1.25, 1.0, -0.85] },
      { z: 1, local: [-3.1, 0.1, 0] }, { z: 1, local: [0.6, -2.1, 0.8] }, { z: 1, local: [3.1, 0.1, 0] },
    ];
  }
  if (s.id === 'oil') {
    // Schematic fatty chain segment (a triolein molecule has 163 atoms; one arm is drawn).
    const sites: Site[] = [];
    for (let i = 0; i < 8; i++) {
      const x = (i - 3.5) * 1.27;
      const y = i % 2 ? 0.42 : -0.42;
      sites.push({ z: 6, local: [x, y, 0] });
      sites.push({ z: 1, local: [x, y * 2.4, 0.9] }, { z: 1, local: [x, y * 2.4, -0.9] });
    }
    sites.push({ z: 8, local: [5.4, 0.3, 0] }, { z: 8, local: [5.3, -1.0, 0] });
    return sites;
  }
  if (s.smiles) {
    const m = parseSmiles(s.smiles);
    const p = embed(m);
    const n = m.atoms.length;
    const c = [0, 1, 2].map((k) => m.atoms.reduce((sum, _, i) => sum + p[i * 3 + k], 0) / n);
    return m.atoms.map((a, i) => ({ z: a.z, local: [p[i * 3] - c[0], p[i * 3 + 1] - c[1], p[i * 3 + 2] - c[2]] }));
  }
  // Ionic solids without a molecule (rust): one formula unit as a compact cluster, labelled simplified.
  const atoms = [...parseFormula(s.formula)].flatMap(([sym, count]) => Array<number>(count).fill(elementBySymbol(sym)!.z));
  return atoms.map((z, i) => {
    const t = i * 2.399963;
    const y = atoms.length > 1 ? 1 - (2 * i) / (atoms.length - 1) : 0;
    const r = Math.sqrt(1 - y * y) * 1.9;
    return { z, local: [Math.cos(t) * r, y * 1.9, Math.sin(t) * r] };
  });
}

// ---------- structure builders ----------

function cubicLattice(type: 'bcc' | 'fcc' | 'rocksalt', a: number, cells: number): { p: number[]; species: number[] } {
  const basis: [number, number, number, number][] =
    type === 'bcc'
      ? [[0, 0, 0, 0], [0.5, 0.5, 0.5, 0]]
      : type === 'fcc'
        ? [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [0.5, 0, 0.5, 0], [0, 0.5, 0.5, 0]]
        : [
            [0, 0, 0, 0], [0.5, 0.5, 0, 0], [0.5, 0, 0.5, 0], [0, 0.5, 0.5, 0],
            [0.5, 0, 0, 1], [0, 0.5, 0, 1], [0, 0, 0.5, 1], [0.5, 0.5, 0.5, 1],
          ];
  const p: number[] = [];
  const species: number[] = [];
  for (let i = 0; i < cells; i++)
    for (let j = 0; j < cells; j++)
      for (let k = 0; k < cells; k++)
        for (const [x, y, z, sp] of basis) {
          p.push((i + x) * a, (j + y) * a, (k + z) * a);
          species.push(sp);
        }
  return { p, species };
}

/**
 * Ice Ih oxygen lattice (hexagonal, 4 O per cell) in an orthorhombic supercell, plus proton directions
 * satisfying the ice rules: each O donates exactly two H along an Euler circuit of the 4-regular O–O graph,
 * so every O gets two in and two out.
 */
export function iceIh(nx: number, ny: number, nz: number): { o: number[]; box: [number, number, number]; donors: [number, number][] } {
  const a = ICE_A;
  const c = ICE_C;
  // Orthorhombic cell: a × a√3 × c with 8 O.
  const ax = a;
  const ay = a * Math.sqrt(3);
  const hexBasis: [number, number, number][] = [
    [1 / 3, 2 / 3, 1 / 16], [1 / 3, 2 / 3, 7 / 16], [2 / 3, 1 / 3, 9 / 16], [2 / 3, 1 / 3, 15 / 16],
  ];
  const o: number[] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++)
        for (const shift of [[0, 0], [0.5, 0.5]] as const)
          for (const [u, v, w] of hexBasis) {
            // hexagonal fractional (u, v) → Cartesian, then fold into the orthorhombic cell
            let x = (u + v * -0.5) * a + shift[0] * ax;
            let y = v * (a * Math.sqrt(3)) / 2 + shift[1] * ay;
            x = ((x % ax) + ax) % ax;
            y = ((y % ay) + ay) % ay;
            o.push(x + i * ax, y + j * ay, w * c + k * c);
          }
  const box: [number, number, number] = [nx * ax, ny * ay, nz * c];
  const n = o.length / 3;
  // O–O graph: 4 nearest neighbours under periodic boundaries.
  const neigh: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      let d2 = 0;
      for (let k = 0; k < 3; k++) {
        let d = o[j * 3 + k] - o[i * 3 + k];
        d -= box[k] * Math.round(d / box[k]);
        d2 += d * d;
      }
      if (d2 < 3.0 * 3.0) {
        neigh[i].push(j);
        neigh[j].push(i);
      }
    }
  // Euler circuit (Hierholzer) orients every edge; along the tour each vertex has in = out = 2.
  const used = new Set<string>();
  const key = (a1: number, b1: number) => (a1 < b1 ? `${a1}:${b1}` : `${b1}:${a1}`);
  const donors: [number, number][] = [];
  const ptr = new Array(n).fill(0);
  for (let start = 0; start < n; start++) {
    const stack = [start];
    while (stack.length) {
      const v = stack[stack.length - 1];
      let moved = false;
      while (ptr[v] < neigh[v].length) {
        const w = neigh[v][ptr[v]++];
        const k2 = key(v, w);
        if (used.has(k2)) continue;
        used.add(k2);
        donors.push([v, w]);
        stack.push(w);
        moved = true;
        break;
      }
      if (!moved) stack.pop();
    }
  }
  return { o, box, donors };
}

function maxwellVelocity(rng: Rng, mass: number, T: number): [number, number, number] {
  const s = Math.sqrt((KB * T) / mass);
  return [rng.gauss() * s, rng.gauss() * s, rng.gauss() * s];
}

function randomQuat(rng: Rng): [number, number, number, number] {
  const u1 = rng.next();
  const u2 = rng.next() * 2 * Math.PI;
  const u3 = rng.next() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

type V3 = [number, number, number];
const norm3 = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Quaternion of the rotation whose matrix has columns x, y, z (an orthonormal right-handed frame). */
function quatFromBasis(x: V3, y: V3, z: V3): [number, number, number, number] {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const tr = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * Orientation that points water's two O–H bonds along h1 and h2 (unit vectors): the template has the
 * bisector on +y and the H–H direction on +x.
 */
function waterOrientation(h1: V3, h2: V3): [number, number, number, number] {
  const y = norm3([h1[0] + h2[0], h1[1] + h2[1], h1[2] + h2[2]]);
  const x0 = norm3([h1[0] - h2[0], h1[1] - h2[1], h1[2] - h2[2]]);
  const z = norm3(cross3(x0, y));
  const x = cross3(y, z);
  return quatFromBasis(x, y, z);
}

export function createCell(spec: CellSpec, seed = 1): MicroCell {
  const s = spec.substance;
  const rng = new Rng(seed);
  const sites = moleculeSites(s);
  const molMass = s.molarMass;
  const molecules = [{ sites, mass: molMass }];
  let pos: number[] = [];
  let rot: number[] = [];
  let kind: number[] = [];
  let box: number;
  let anchored = false;

  if (spec.phase === 'gas') {
    // Ideal gas: n = P / kT; enough box for ~40 molecules (gas is very sparse).
    const n = spec.pressure / (1.380649e-23 * spec.temperature); // 1/m³
    const count = 40;
    box = Math.cbrt(count / n) * 1e10;
    for (let i = 0; i < count; i++) {
      pos.push(rng.next() * box, rng.next() * box, rng.next() * box);
      rot.push(...randomQuat(rng));
      kind.push(0);
    }
  } else if (spec.phase === 'solid' && s.id === 'water') {
    const ice = iceIh(4, 2, 2);
    box = ice.box[0]; // the supercell is close to cubic: 18.07 × 15.65 × 14.71 Å
    const n = ice.o.length / 3;
    const hDirs: number[][][] = Array.from({ length: n }, () => []);
    for (const [d, a] of ice.donors) {
      const v = [0, 1, 2].map((k) => {
        let x = ice.o[a * 3 + k] - ice.o[d * 3 + k];
        x -= ice.box[k] * Math.round(x / ice.box[k]);
        return x;
      });
      const l = Math.hypot(...v);
      hDirs[d].push(v.map((x) => x / l));
    }
    for (let i = 0; i < n; i++) {
      pos.push(ice.o[i * 3], ice.o[i * 3 + 1], ice.o[i * 3 + 2]);
      // Point the two O–H bonds along the donated O–O directions (the tetrahedral 109.5° is close to
      // water's 104.5°, the template keeps its real angle).
      const [h1, h2] = hDirs[i].length === 2 ? (hDirs[i] as V3[]) : ([[1, 1, 0], [-1, 1, 0]] as V3[]);
      rot.push(...waterOrientation(h1, h2));
      kind.push(0);
    }
    // Ice keeps its own non-cubic box: store the largest edge and wrap per axis via `iceBox` below.
    anchored = true;
    const cell: MicroCell = finish();
    (cell as MicroCell & { boxes?: number[] }).boxes = ice.box;
    return cell;
  } else if (spec.phase === 'solid' && LATTICE[s.id]) {
    const L = LATTICE[s.id];
    const cells = L.type === 'bcc' ? 6 : L.type === 'fcc' ? 4 : 3;
    const lat = cubicLattice(L.type, L.a, cells);
    box = cells * L.a;
    if (L.type === 'rocksalt') {
      molecules.length = 0;
      molecules.push({ sites: ATOM(11), mass: 22.99 }, { sites: ATOM(17), mass: 35.45 });
    }
    for (let i = 0; i < lat.species.length; i++) {
      pos.push(lat.p[i * 3], lat.p[i * 3 + 1], lat.p[i * 3 + 2]);
      rot.push(0, 0, 0, 1);
      kind.push(lat.species[i]);
    }
    anchored = true;
  } else if (spec.phase === 'solid') {
    // No tabulated structure here (gallium, mercury, organics): a simple-cubic packing at the real density,
    // labelled as simplified in the UI.
    const vol = (s.molarMass / 1000 / s.rhoSolid / NA) * 1e30; // Å³ per molecule
    const a = Math.cbrt(vol);
    const cells = Math.max(4, Math.min(8, Math.round(22 / a)));
    box = cells * a;
    for (let i = 0; i < cells; i++)
      for (let j = 0; j < cells; j++)
        for (let k = 0; k < cells; k++) {
          pos.push((i + 0.5) * a, (j + 0.5) * a, (k + 0.5) * a);
          rot.push(...randomQuat(rng));
          kind.push(0);
        }
    anchored = true;
  } else {
    // Liquid at its real density, started on a jittered grid.
    const vol = (s.molarMass / 1000 / s.rhoLiquid / NA) * 1e30;
    const a = Math.cbrt(vol);
    const cells = Math.max(4, Math.min(8, Math.round(22 / a)));
    box = cells * a;
    for (let i = 0; i < cells; i++)
      for (let j = 0; j < cells; j++)
        for (let k = 0; k < cells; k++) {
          pos.push((i + 0.5 + rng.range(-0.15, 0.15)) * a, (j + 0.5 + rng.range(-0.15, 0.15)) * a, (k + 0.5 + rng.range(-0.15, 0.15)) * a);
          rot.push(...randomQuat(rng));
          kind.push(0);
        }
  }
  return finish();

  function finish(): MicroCell {
    const n = kind.length;
    const vel = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const m = molecules[kind[i]].mass;
      vel.set(maxwellVelocity(rng, m, spec.temperature), i * 3);
    }
    const p = new Float64Array(pos);
    return {
      spec,
      box: box!,
      molecules,
      pos: p,
      vel,
      rot: new Float64Array(rot),
      anchor: anchored ? new Float64Array(p) : null,
      kind: new Uint8Array(kind),
      rng,
      time: 0,
    };
  }
}

/** Periodic box edges (ice has a non-cubic supercell). */
export function boxEdges(c: MicroCell): [number, number, number] {
  const b = (c as MicroCell & { boxes?: number[] }).boxes;
  return b ? [b[0], b[1], b[2]] : [c.box, c.box, c.box];
}

/** Nearest-neighbour distance in the solid, for the Lindemann vibration amplitude. */
function neighbourDistance(c: MicroCell): number {
  const s = c.spec.substance;
  if (s.id === 'water') return 2.76;
  const L = LATTICE[s.id];
  if (L) return L.type === 'bcc' ? (L.a * Math.sqrt(3)) / 2 : L.type === 'fcc' ? L.a / Math.SQRT2 : L.a / 2;
  return ljParams(s).sigma * 1.12;
}

/**
 * Advances the cell by `dt` ps.
 *  - solids: Langevin oscillators around lattice sites with the Lindemann amplitude;
 *  - liquids: Lennard-Jones (cell list) + Langevin thermostat;
 *  - gas: free flight (occasional thermalisation stands in for collisions).
 */
export function stepCell(c: MicroCell, dt: number, steps = 1) {
  const { spec, pos, vel, rng } = c;
  const n = c.kind.length;
  const T = spec.temperature;
  const edges = boxEdges(c);
  const gamma = 5; // 1/ps
  const wrap = (i: number, k: number) => {
    pos[i * 3 + k] -= edges[k] * Math.floor(pos[i * 3 + k] / edges[k]);
  };

  for (let s = 0; s < steps; s++) {
    if (c.anchor) {
      // Harmonic tether with spring k so that ⟨u²⟩ per axis = kT/k matches the Lindemann amplitude.
      const lind = 0.1 * neighbourDistance(c) * Math.sqrt(Math.min(T / spec.substance.tm, 1.2)) / Math.sqrt(3);
      for (let i = 0; i < n; i++) {
        const m = c.molecules[c.kind[i]].mass;
        const k = (KB * T) / (lind * lind);
        const sigmaV = Math.sqrt((KB * T) / m);
        for (let a = 0; a < 3; a++) {
          let d = pos[i * 3 + a] - c.anchor[i * 3 + a];
          d -= edges[a] * Math.round(d / edges[a]);
          const f = -k * d;
          const v = vel[i * 3 + a] + (f / m) * dt;
          // Langevin (Ornstein–Uhlenbeck) velocity update keeps the temperature at T.
          const e = Math.exp(-gamma * dt);
          vel[i * 3 + a] = v * e + sigmaV * Math.sqrt(1 - e * e) * rng.gauss();
          pos[i * 3 + a] += vel[i * 3 + a] * dt;
        }
      }
      // Libration of molecules in ice: small random rotations.
      if (spec.substance.id === 'water') jiggleRotations(c, 0.02 * Math.sqrt(T / 273));
      continue;
    }

    if (spec.phase === 'liquid') {
      const { sigma, eps } = ljParams(spec.substance);
      const force = ljForces(c, sigma, eps, edges);
      for (let i = 0; i < n; i++) {
        const m = c.molecules[c.kind[i]].mass;
        const sigmaV = Math.sqrt((KB * T) / m);
        const e = Math.exp(-gamma * dt);
        for (let a = 0; a < 3; a++) {
          const v = vel[i * 3 + a] + (force[i * 3 + a] / m) * dt;
          vel[i * 3 + a] = v * e + sigmaV * Math.sqrt(1 - e * e) * rng.gauss();
          pos[i * 3 + a] += vel[i * 3 + a] * dt;
        }
      }
      // Rotational diffusion (water: D_r ≈ 0.1–0.2 rad²/ps).
      jiggleRotations(c, Math.sqrt(2 * 0.15 * dt));
    } else {
      for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) pos[i * 3 + a] += vel[i * 3 + a] * dt;
      jiggleRotations(c, Math.sqrt(2 * 2 * dt));
    }
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) wrap(i, a);
    c.time += dt;
  }
}

function jiggleRotations(c: MicroCell, angle: number) {
  const { rot, rng } = c;
  for (let i = 0; i < c.kind.length; i++) {
    const ax = [rng.gauss(), rng.gauss(), rng.gauss()];
    const l = Math.hypot(...ax) || 1;
    const h = (angle * rng.gauss()) / 2;
    const s = Math.sin(h) / l;
    const dq = [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(h)];
    const q = [rot[i * 4], rot[i * 4 + 1], rot[i * 4 + 2], rot[i * 4 + 3]];
    // q' = dq * q
    const x = dq[3] * q[0] + dq[0] * q[3] + dq[1] * q[2] - dq[2] * q[1];
    const y = dq[3] * q[1] - dq[0] * q[2] + dq[1] * q[3] + dq[2] * q[0];
    const z = dq[3] * q[2] + dq[0] * q[1] - dq[1] * q[0] + dq[2] * q[3];
    const w = dq[3] * q[3] - dq[0] * q[0] - dq[1] * q[1] - dq[2] * q[2];
    const ql = Math.hypot(x, y, z, w);
    rot.set([x / ql, y / ql, z / ql, w / ql], i * 4);
  }
}

/** LJ forces with a 2.5σ cutoff and a cell list (amu·Å/ps²). */
function ljForces(c: MicroCell, sigma: number, eps: number, edges: [number, number, number]): Float64Array {
  const n = c.kind.length;
  const f = new Float64Array(n * 3);
  const rc = 2.5 * sigma;
  const rc2 = rc * rc;
  const nc = edges.map((e) => Math.max(1, Math.floor(e / rc)));
  const cells = new Map<number, number[]>();
  const cellOf = (i: number) =>
    edges.map((e, k) => Math.min(nc[k] - 1, Math.floor((c.pos[i * 3 + k] / e) * nc[k])));
  const key = (x: number, y: number, z: number) => ((x + nc[0]) % nc[0]) + nc[0] * (((y + nc[1]) % nc[1]) + nc[1] * ((z + nc[2]) % nc[2]));
  for (let i = 0; i < n; i++) {
    const [x, y, z] = cellOf(i);
    const k = key(x, y, z);
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(i);
  }
  const s2 = sigma * sigma;
  for (let i = 0; i < n; i++) {
    const [cx, cy, cz] = cellOf(i);
    const seen = new Set<number>();
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const k = key(cx + dx, cy + dy, cz + dz);
          if (seen.has(k)) continue;
          seen.add(k);
          for (const j of cells.get(k) ?? []) {
            if (j <= i) continue;
            const d = [0, 1, 2].map((a) => {
              let v = c.pos[j * 3 + a] - c.pos[i * 3 + a];
              v -= edges[a] * Math.round(v / edges[a]);
              return v;
            });
            const r2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
            if (r2 > rc2 || r2 < 1e-6) continue;
            // Soft floor at 0.8σ avoids blow-ups from the initial packing.
            const r2c = Math.max(r2, 0.64 * s2);
            const sr6 = (s2 / r2c) ** 3;
            const fmag = (24 * eps * (2 * sr6 * sr6 - sr6)) / r2c;
            for (let a = 0; a < 3; a++) {
              f[i * 3 + a] -= fmag * d[a];
              f[j * 3 + a] += fmag * d[a];
            }
          }
        }
  }
  return f;
}

/** World-space atom positions of molecule i (Å). */
export function atomPositions(c: MicroCell, i: number): { z: number; p: [number, number, number] }[] {
  const q = [c.rot[i * 4], c.rot[i * 4 + 1], c.rot[i * 4 + 2], c.rot[i * 4 + 3]];
  const center = [c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]];
  return c.molecules[c.kind[i]].sites.map((s) => {
    const [x, y, z] = s.local;
    // v' = q v q*
    const [qx, qy, qz, qw] = q;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return {
      z: s.z,
      p: [
        center[0] + ix * qw + iw * -qx + iy * -qz - iz * -qy,
        center[1] + iy * qw + iw * -qy + iz * -qx - ix * -qz,
        center[2] + iz * qw + iw * -qz + ix * -qy - iy * -qx,
      ],
    };
  });
}

/** Water hydrogen bonds by the usual geometric criterion: O···O < 3.5 Å and H–O···O angle < 30°. */
export function hydrogenBonds(c: MicroCell): [number, number][] {
  if (c.spec.substance.id !== 'water' || c.spec.phase === 'gas') return [];
  const n = c.kind.length;
  const edges = boxEdges(c);
  const atoms = Array.from({ length: n }, (_, i) => atomPositions(c, i));
  const out: [number, number][] = [];
  const cos30 = Math.cos(Math.PI / 6);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = [0, 1, 2].map((a) => {
        let v = c.pos[j * 3 + a] - c.pos[i * 3 + a];
        v -= edges[a] * Math.round(v / edges[a]);
        return v;
      });
      const r = Math.hypot(...d);
      if (r > 3.5 || r < 2.2) continue;
      for (const h of [1, 2]) {
        const oh = [0, 1, 2].map((a) => atoms[i][h].p[a] - atoms[i][0].p[a]);
        const cos = (oh[0] * d[0] + oh[1] * d[1] + oh[2] * d[2]) / (Math.hypot(...oh) * r);
        if (cos > cos30) {
          out.push([i, j]);
          break;
        }
      }
    }
  return out;
}

/** Instantaneous kinetic temperature (K), for tests. */
export function kineticTemperature(c: MicroCell): number {
  let e = 0;
  for (let i = 0; i < c.kind.length; i++) {
    const m = c.molecules[c.kind[i]].mass;
    e += 0.5 * m * (c.vel[i * 3] ** 2 + c.vel[i * 3 + 1] ** 2 + c.vel[i * 3 + 2] ** 2);
  }
  return (2 * e) / (3 * c.kind.length * KB);
}
