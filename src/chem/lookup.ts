import { MOLECULES, type MoleculeEntry } from '../data/molecules';
import { canonicalKey, type Molecule } from './molecule';
import { parseSmiles } from './smiles';

let index: Map<string, MoleculeEntry> | null = null;

/** Reference entry for a molecule with the same structure (any atom order), if it is in the database. */
export function lookupMolecule(m: Molecule): MoleculeEntry | undefined {
  index ??= new Map(MOLECULES.map((e) => [canonicalKey(parseSmiles(e.smiles)), e]));
  return index.get(canonicalKey(m));
}

export function moleculeFromEntry(e: MoleculeEntry): Molecule {
  return parseSmiles(e.smiles);
}
