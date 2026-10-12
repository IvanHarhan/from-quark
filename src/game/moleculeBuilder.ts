import { create } from 'zustand';
import { embed, type Positions } from '../chem/geometry';
import { lookupMolecule } from '../chem/lookup';
import { findBond, saturateWithHydrogen, type BondOrder, type Molecule } from '../chem/molecule';
import type { MoleculeEntry } from '../data/molecules';

interface MoleculeBuilderState {
  molecule: Molecule;
  selected: number | null;
  /** Atom under the cursor in the 3D view. */
  hovered: number | null;
  /** Adds an atom; bonds it to the selected atom if there is one (selection stays, so H's can be added in a row). */
  addAtom(z: number, charge?: number): void;
  /** Click on an atom: select it, or bond/cycle the bond to it from the selected atom. */
  clickAtom(i: number | null): void;
  removeSelected(): void;
  changeCharge(delta: number): void;
  saturate(): void;
  load(m: Molecule): void;
  clear(): void;
  setHovered(i: number | null): void;
}

export interface Structure {
  molecule: Molecule;
  ref: MoleculeEntry | undefined;
  positions: Positions;
}

let cache: Structure | null = null;

/** Reference match + 3D coordinates, computed once per molecule edit and shared by the view and the panel. */
export function structureOf(molecule: Molecule): Structure {
  if (cache?.molecule !== molecule) {
    const ref = lookupMolecule(molecule);
    cache = { molecule, ref, positions: embed(molecule, ref) };
  }
  return cache;
}

const NEXT_ORDER: Record<BondOrder, BondOrder | null> = { 1: 2, 2: 3, 3: null };

export const useMolecule = create<MoleculeBuilderState>((set, get) => ({
  molecule: { atoms: [], bonds: [] },
  selected: null,
  hovered: null,
  addAtom(z, charge = 0) {
    const { molecule: m, selected } = get();
    const atoms = [...m.atoms, { z, charge }];
    const idx = atoms.length - 1;
    const bonds = selected !== null ? [...m.bonds, { a: selected, b: idx, order: 1 as BondOrder }] : m.bonds;
    set({ molecule: { atoms, bonds }, selected: selected ?? idx });
  },
  clickAtom(i) {
    const { molecule: m, selected } = get();
    if (i === null || i === selected) return set({ selected: null });
    if (selected === null) return set({ selected: i });
    const existing = findBond(m, selected, i);
    let bonds = m.bonds;
    if (!existing) bonds = [...bonds, { a: selected, b: i, order: 1 }];
    else {
      const next = NEXT_ORDER[existing.order];
      bonds = next ? bonds.map((b) => (b === existing ? { ...b, order: next } : b)) : bonds.filter((b) => b !== existing);
    }
    set({ molecule: { atoms: m.atoms, bonds }, selected: i });
  },
  removeSelected() {
    const { molecule: m, selected: s } = get();
    if (s === null) return;
    const atoms = m.atoms.filter((_, i) => i !== s);
    const bonds = m.bonds
      .filter((b) => b.a !== s && b.b !== s)
      .map((b) => ({ ...b, a: b.a > s ? b.a - 1 : b.a, b: b.b > s ? b.b - 1 : b.b }));
    set({ molecule: { atoms, bonds }, selected: null, hovered: null });
  },
  changeCharge(delta) {
    const { molecule: m, selected: s } = get();
    if (s === null) return;
    const atoms = m.atoms.map((a, i) => (i === s ? { ...a, charge: Math.max(-3, Math.min(8, a.charge + delta)) } : a));
    set({ molecule: { atoms, bonds: m.bonds } });
  },
  saturate() {
    set({ molecule: saturateWithHydrogen(get().molecule) });
  },
  load(molecule) {
    set({ molecule, selected: null, hovered: null });
  },
  clear() {
    set({ molecule: { atoms: [], bonds: [] }, selected: null, hovered: null });
  },
  setHovered(hovered) {
    if (hovered !== get().hovered) set({ hovered });
  },
}));
