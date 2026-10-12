import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { canonicalKey, type BondOrder, type Molecule } from '../chem/molecule';

export interface AtomItem {
  kind: 'atom';
  id: string;
  z: number;
  a: number;
  electrons: number;
  savedAt: number;
}

export interface MoleculeItem {
  kind: 'molecule';
  id: string;
  molecule: Molecule;
  savedAt: number;
}

export type InventoryItem = AtomItem | MoleculeItem;

interface InventoryState {
  items: InventoryItem[];
  /** Returns false when an identical item is already stored. */
  addAtom(z: number, a: number, electrons: number): boolean;
  addMolecule(m: Molecule): boolean;
  remove(id: string): void;
  exportJson(): string;
  /** Merges items from an exported file; returns how many were added. Throws on malformed input. */
  importJson(text: string): number;
}

const atomId = (z: number, a: number, e: number) => `atom:${z}:${a}:${e}`;
const isNat = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

function validMolecule(m: unknown): m is Molecule {
  const mol = m as Molecule;
  if (!mol || !Array.isArray(mol.atoms) || !Array.isArray(mol.bonds) || mol.atoms.length === 0) return false;
  const n = mol.atoms.length;
  return (
    mol.atoms.every((a) => Number.isInteger(a?.z) && a.z >= 1 && a.z <= 118 && Number.isInteger(a.charge)) &&
    mol.bonds.every((b) => isNat(b?.a) && isNat(b.b) && b.a < n && b.b < n && b.a !== b.b && [1, 2, 3].includes(b.order as BondOrder))
  );
}

export const useInventory = create<InventoryState>()(
  persist(
    (set, get) => ({
      items: [],
      addAtom(z, a, electrons) {
        const id = atomId(z, a, electrons);
        if (get().items.some((i) => i.id === id)) return false;
        set({ items: [...get().items, { kind: 'atom', id, z, a, electrons, savedAt: Date.now() }] });
        return true;
      },
      addMolecule(molecule) {
        const id = `mol:${canonicalKey(molecule)}`;
        if (get().items.some((i) => i.id === id)) return false;
        set({ items: [...get().items, { kind: 'molecule', id, molecule, savedAt: Date.now() }] });
        return true;
      },
      remove(id) {
        set({ items: get().items.filter((i) => i.id !== id) });
      },
      exportJson() {
        return JSON.stringify({ format: 'fromquark-inventory', version: 1, items: get().items }, null, 2);
      },
      importJson(text) {
        const data = JSON.parse(text);
        if (data?.format !== 'fromquark-inventory' || !Array.isArray(data.items)) throw new Error('not an inventory file');
        let added = 0;
        for (const it of data.items) {
          let ok = false;
          if (it?.kind === 'atom') {
            ok =
              [it.z, it.a, it.electrons].every(isNat) && it.z <= 118 && it.a >= it.z && get().addAtom(it.z, it.a, it.electrons);
          } else if (it?.kind === 'molecule') {
            ok = validMolecule(it.molecule) && get().addMolecule(it.molecule);
          }
          if (ok) added++;
        }
        return added;
      },
    }),
    { name: 'fromquark.inventory', storage: createJSONStorage(() => localStorage), partialize: (s) => ({ items: s.items }) },
  ),
);
