import { element } from '../data/db';
import { group, period } from './periodic';

export type BondOrder = 1 | 2 | 3;

export interface MAtom {
  z: number;
  charge: number;
}

export interface MBond {
  a: number;
  b: number;
  order: BondOrder;
}

export interface Molecule {
  atoms: MAtom[];
  bonds: MBond[];
}

const METAL_BLOCKS = new Set([
  'Alkali metal',
  'Alkaline earth metal',
  'Transition metal',
  'Post-transition metal',
  'Lanthanide',
  'Actinide',
]);

export function isMetal(z: number): boolean {
  return METAL_BLOCKS.has(element(z)?.block ?? '');
}

/** Valence electrons of a main-group element; null for d/f-block metals. */
export function valenceElectrons(z: number): number | null {
  if (z === 1) return 1;
  if (z === 2) return 2;
  const g = group(z);
  if (g === null) return null;
  if (g <= 2) return g;
  if (g >= 13) return g - 10;
  return null;
}

/**
 * Bond counts an atom can form. Main group: octet rule (8 − v, or v for v ≤ 4), plus hypervalent
 * options in steps of 2 from period 3 on (S: 2, 4, 6). d/f metals: their positive oxidation states.
 */
export function allowedValences(z: number, charge: number): number[] {
  if (z === 1) {
    const v = 1 - charge;
    return v === 1 ? [1] : [0];
  }
  if (z === 2) return [0];
  const ve = valenceElectrons(z);
  if (ve === null) {
    const ox = (element(z)?.oxidationStates ?? []).filter((o) => o > 0 && o >= charge).map((o) => o - charge);
    const set = [...new Set(ox)].sort((a, b) => a - b);
    return set.length ? set : [0];
  }
  const v = ve - charge;
  if (v <= 0) return [0];
  if (v <= 4) return [v];
  const base = 8 - v;
  if (base < 0) return [0];
  if (period(z) < 3) return [base];
  const out: number[] = [];
  for (let n = base; n <= v; n += 2) out.push(n);
  return out;
}

export function bondSum(m: Molecule, i: number): number {
  let s = 0;
  for (const b of m.bonds) if (b.a === i || b.b === i) s += b.order;
  return s;
}

export function neighbors(m: Molecule, i: number): number[] {
  const out: number[] = [];
  for (const b of m.bonds) {
    if (b.a === i) out.push(b.b);
    else if (b.b === i) out.push(b.a);
  }
  return out;
}

export function findBond(m: Molecule, i: number, j: number): MBond | undefined {
  return m.bonds.find((b) => (b.a === i && b.b === j) || (b.a === j && b.b === i));
}

export type Issue =
  | { kind: 'tooManyBonds'; atom: number; bonds: number; max: number }
  | { kind: 'unsaturated'; atom: number; bonds: number; missing: number }
  | { kind: 'disconnected'; parts: number }
  | { kind: 'empty' };

export interface Validation {
  ok: boolean;
  /** Errors break chemistry rules; warnings are incomplete structures (radicals, loose pieces). */
  errors: Issue[];
  warnings: Issue[];
}

export function validate(m: Molecule): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (m.atoms.length === 0) return { ok: false, errors: [{ kind: 'empty' }], warnings };
  m.atoms.forEach((a, i) => {
    const used = bondSum(m, i);
    const allowed = allowedValences(a.z, a.charge);
    const max = Math.max(...allowed);
    if (used > max) errors.push({ kind: 'tooManyBonds', atom: i, bonds: used, max });
    else if (!allowed.includes(used)) {
      const next = allowed.find((v) => v > used)!;
      warnings.push({ kind: 'unsaturated', atom: i, bonds: used, missing: next - used });
    }
  });
  const parts = components(m).length;
  if (parts > 1) warnings.push({ kind: 'disconnected', parts });
  return { ok: errors.length === 0 && warnings.length === 0, errors, warnings };
}

export function components(m: Molecule): number[][] {
  const seen = new Array(m.atoms.length).fill(false);
  const out: number[][] = [];
  for (let s = 0; s < m.atoms.length; s++) {
    if (seen[s]) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = true;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (const j of neighbors(m, i)) if (!seen[j]) (seen[j] = true), stack.push(j);
    }
    out.push(comp);
  }
  return out;
}

/** Non-bonding electrons left on a main-group atom; null for d/f metals. */
export function nonBondingElectrons(m: Molecule, i: number): number | null {
  const a = m.atoms[i];
  const ve = valenceElectrons(a.z);
  if (ve === null) return null;
  return Math.max(0, ve - a.charge - bondSum(m, i));
}

export type BondType = 'nonpolar' | 'polar' | 'ionic' | 'metallic' | 'unknown';

/**
 * Classification by Pauling electronegativity difference, the usual textbook convention:
 * ΔEN < 0.4 nonpolar covalent, 0.4–1.7 polar covalent, > 1.7 ionic; metal–metal is metallic.
 */
export function bondType(z1: number, z2: number): { type: BondType; dEN: number | null } {
  if (isMetal(z1) && isMetal(z2)) return { type: 'metallic', dEN: diffEN(z1, z2) };
  const d = diffEN(z1, z2);
  if (d === null) return { type: 'unknown', dEN: null };
  return { type: d < 0.4 ? 'nonpolar' : d <= 1.7 ? 'polar' : 'ionic', dEN: d };
}

function diffEN(z1: number, z2: number): number | null {
  const a = element(z1)?.electronegativity;
  const b = element(z2)?.electronegativity;
  return a == null || b == null ? null : Math.abs(a - b);
}

/** Hill order: C, then H, then the rest alphabetically (no C: everything alphabetical). */
export function hillFormula(m: Molecule): { symbol: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of m.atoms) {
    const s = element(a.z)!.symbol;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const keys = [...counts.keys()];
  const hasC = counts.has('C');
  keys.sort((x, y) => {
    if (hasC) {
      const rank = (s: string) => (s === 'C' ? 0 : s === 'H' ? 1 : 2);
      if (rank(x) !== rank(y)) return rank(x) - rank(y);
    }
    return x.localeCompare(y);
  });
  return keys.map((symbol) => ({ symbol, count: counts.get(symbol)! }));
}

export function formulaString(m: Molecule): string {
  return hillFormula(m)
    .map((p) => p.symbol + (p.count > 1 ? p.count : ''))
    .join('');
}

export function totalCharge(m: Molecule): number {
  return m.atoms.reduce((s, a) => s + a.charge, 0);
}

/** g/mol from CIAAW standard atomic weights. */
export function moleculeMass(m: Molecule): number {
  return m.atoms.reduce((s, a) => s + element(a.z)!.mass, 0);
}

/**
 * Graph fingerprint independent of atom order (Weisfeiler–Lehman refinement), used to recognise
 * known molecules: ethanol and dimethyl ether share C2H6O but get different keys.
 */
export function canonicalKey(m: Molecule): string {
  let labels = m.atoms.map((a) => `${a.z}${a.charge ? `q${a.charge}` : ''}`);
  for (let round = 0; round < 4; round++) {
    labels = labels.map((l, i) => {
      const nb = m.bonds
        .filter((b) => b.a === i || b.b === i)
        .map((b) => `${b.order}${labels[b.a === i ? b.b : b.a]}`)
        .sort()
        .join(',');
      return hash(`${l}(${nb})`);
    });
  }
  return `${formulaString(m)}:${labels.sort().join('.')}`;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Adds H atoms until every atom reaches its nearest allowed valence. Returns the new molecule. */
export function saturateWithHydrogen(m: Molecule): Molecule {
  const out: Molecule = { atoms: [...m.atoms], bonds: [...m.bonds] };
  const n = m.atoms.length;
  for (let i = 0; i < n; i++) {
    const a = m.atoms[i];
    if (a.z === 1 || isMetal(a.z)) continue;
    const used = bondSum(out, i);
    const target = allowedValences(a.z, a.charge).find((v) => v >= used);
    if (target === undefined) continue;
    for (let k = used; k < target; k++) {
      out.atoms.push({ z: 1, charge: 0 });
      out.bonds.push({ a: i, b: out.atoms.length - 1, order: 1 });
    }
  }
  return out;
}
