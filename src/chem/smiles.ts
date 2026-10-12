import { elementBySymbol } from '../data/db';
import type { BondOrder, MAtom, MBond, Molecule } from './molecule';

/** Normal valences for implicit hydrogens on unbracketed organic-subset atoms (OpenSMILES). */
const ORGANIC: Record<string, number[]> = {
  B: [3], C: [4], N: [3, 5], O: [2], P: [3, 5], S: [2, 4, 6], F: [1], Cl: [1], Br: [1], I: [1],
};

/**
 * Minimal SMILES reader (Kekulé form only): organic subset, [bracket atoms] with H count and charge,
 * - = # bonds, branches, ring closures (1–9, %nn), and '.' for separate pieces. No aromatic or stereo.
 */
export function parseSmiles(smiles: string): Molecule {
  const atoms: MAtom[] = [];
  const bonds: MBond[] = [];
  const implicit: boolean[] = [];
  const stack: number[] = [];
  const rings = new Map<number, { atom: number; order: BondOrder | null }>();
  let prev = -1;
  let pending: BondOrder | null = null;
  let i = 0;

  const addAtom = (z: number, charge: number, isImplicit: boolean) => {
    atoms.push({ z, charge });
    implicit.push(isImplicit);
    const idx = atoms.length - 1;
    if (prev >= 0) bonds.push({ a: prev, b: idx, order: pending ?? 1 });
    pending = null;
    prev = idx;
    return idx;
  };

  while (i < smiles.length) {
    const c = smiles[i];
    if (c === '(') {
      stack.push(prev);
      i++;
    } else if (c === ')') {
      if (!stack.length) throw new Error(`SMILES: unbalanced ")" in ${smiles}`);
      prev = stack.pop()!;
      i++;
    } else if (c === '-' || c === '=' || c === '#') {
      pending = c === '-' ? 1 : c === '=' ? 2 : 3;
      i++;
    } else if (c === '.') {
      prev = -1;
      i++;
    } else if (/[0-9%]/.test(c)) {
      let n: number;
      if (c === '%') {
        n = parseInt(smiles.slice(i + 1, i + 3), 10);
        i += 3;
      } else {
        n = +c;
        i++;
      }
      const open = rings.get(n);
      if (open) {
        bonds.push({ a: open.atom, b: prev, order: pending ?? open.order ?? 1 });
        rings.delete(n);
      } else {
        rings.set(n, { atom: prev, order: pending });
      }
      pending = null;
    } else if (c === '[') {
      const end = smiles.indexOf(']', i);
      if (end < 0) throw new Error(`SMILES: unclosed "[" in ${smiles}`);
      const m = smiles.slice(i + 1, end).match(/^(\d*)([A-Z][a-z]?)(@*)(H\d*)?([+-]\d*|[+-]+)?$/);
      if (!m) throw new Error(`SMILES: bad bracket atom "${smiles.slice(i, end + 1)}"`);
      const el = elementBySymbol(m[2]);
      if (!el) throw new Error(`SMILES: unknown element ${m[2]}`);
      let charge = 0;
      if (m[5]) {
        const sign = m[5][0] === '+' ? 1 : -1;
        const rest = m[5].slice(1);
        charge = sign * (rest === '' ? 1 : /^\d+$/.test(rest) ? +rest : m[5].length);
      }
      const idx = addAtom(el.z, charge, false);
      const h = m[4] ? (m[4].length > 1 ? +m[4].slice(1) : 1) : 0;
      for (let k = 0; k < h; k++) {
        atoms.push({ z: 1, charge: 0 });
        implicit.push(false);
        bonds.push({ a: idx, b: atoms.length - 1, order: 1 });
      }
      i = end + 1;
    } else {
      const two = smiles.slice(i, i + 2);
      const sym = two === 'Cl' || two === 'Br' ? two : c;
      if (!(sym in ORGANIC)) throw new Error(`SMILES: unsupported "${sym}" in ${smiles} (use [..] or Kekulé form)`);
      addAtom(elementBySymbol(sym)!.z, 0, true);
      i += sym.length;
    }
  }
  if (rings.size) throw new Error(`SMILES: unclosed ring in ${smiles}`);

  const n = atoms.length;
  for (let k = 0; k < n; k++) {
    if (!implicit[k]) continue;
    const used = bonds.reduce((s, b) => s + (b.a === k || b.b === k ? b.order : 0), 0);
    const sym = Object.keys(ORGANIC).find((s) => elementBySymbol(s)!.z === atoms[k].z)!;
    const target = ORGANIC[sym].find((v) => v >= used) ?? used;
    for (let h = used; h < target; h++) {
      atoms.push({ z: 1, charge: 0 });
      bonds.push({ a: k, b: atoms.length - 1, order: 1 });
    }
  }
  return { atoms, bonds };
}
