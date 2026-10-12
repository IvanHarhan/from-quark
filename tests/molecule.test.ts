import { describe, expect, it } from 'vitest';
import { embed, measureAngle, measureDistance } from '../src/chem/geometry';
import { lookupMolecule } from '../src/chem/lookup';
import {
  allowedValences,
  bondType,
  canonicalKey,
  formulaString,
  moleculeMass,
  neighbors,
  saturateWithHydrogen,
  validate,
  type Molecule,
} from '../src/chem/molecule';
import { parseSmiles } from '../src/chem/smiles';
import { analyzeCenter } from '../src/chem/vsepr';
import { MOLECULES } from '../src/data/molecules';

const mol = (s: string) => parseSmiles(s);

describe('SMILES', () => {
  it.each([
    ['O', 'H2O'],
    ['CCO', 'C2H6O'],
    ['NCC(=O)O', 'C2H5NO2'],
    ['C1=CC=CC=C1', 'C6H6'],
    ['OS(=O)(=O)O', 'H2O4S'],
    ['[Na]Cl', 'ClNa'],
    ['[NH4+]', 'H4N'],
  ])('%s → %s', (s, f) => {
    expect(formulaString(mol(s))).toBe(f);
  });

  it('every reference molecule parses and is chemically valid', () => {
    for (const e of MOLECULES) expect(validate(mol(e.smiles)).ok, e.id).toBe(true);
  });
});

describe('valence', () => {
  it('knows common valences', () => {
    expect(allowedValences(1, 0)).toEqual([1]);
    expect(allowedValences(6, 0)).toEqual([4]);
    expect(allowedValences(8, 0)).toEqual([2]);
    expect(allowedValences(7, 1)).toEqual([4]);
    expect(allowedValences(8, -1)).toEqual([1]);
    expect(allowedValences(16, 0)).toEqual([2, 4, 6]);
    expect(allowedValences(17, 0)).toEqual([1, 3, 5, 7]);
    expect(allowedValences(10, 0)).toEqual([0]);
    expect(allowedValences(2, 0)).toEqual([0]);
  });

  it('flags too many bonds and missing ones', () => {
    const h3o: Molecule = {
      atoms: [{ z: 8, charge: 0 }, { z: 1, charge: 0 }, { z: 1, charge: 0 }, { z: 1, charge: 0 }],
      bonds: [{ a: 0, b: 1, order: 1 }, { a: 0, b: 2, order: 1 }, { a: 0, b: 3, order: 1 }],
    };
    expect(validate(h3o).errors[0]).toMatchObject({ kind: 'tooManyBonds', atom: 0, bonds: 3, max: 2 });
    h3o.atoms[0].charge = 1;
    expect(validate(h3o).ok).toBe(true);

    const oh: Molecule = { atoms: [{ z: 8, charge: 0 }, { z: 1, charge: 0 }], bonds: [{ a: 0, b: 1, order: 1 }] };
    expect(validate(oh).warnings[0]).toMatchObject({ kind: 'unsaturated', atom: 0, missing: 1 });
  });

  it('fills missing valences with hydrogen', () => {
    const c: Molecule = { atoms: [{ z: 6, charge: 0 }, { z: 8, charge: 0 }], bonds: [{ a: 0, b: 1, order: 1 }] };
    expect(formulaString(saturateWithHydrogen(c))).toBe('CH4O');
  });
});

describe('bond types (ΔEN)', () => {
  it.each([
    [1, 1, 'nonpolar'],
    [6, 1, 'nonpolar'],
    [1, 17, 'polar'],
    [1, 8, 'polar'],
    [11, 17, 'ionic'],
    [11, 11, 'metallic'],
  ])('Z%i–Z%i is %s', (a, b, t) => {
    expect(bondType(a, b).type).toBe(t);
  });
});

describe('molar mass', () => {
  it.each([
    ['O', 18.015],
    ['NCC(=O)O', 75.067],
    ['CCO', 46.069],
    ['C1=CC=CC=C1', 78.114],
  ])('%s = %f g/mol', (s, m) => {
    expect(moleculeMass(mol(s))).toBeCloseTo(m, 2);
  });
});

describe('recognition', () => {
  it('ethanol and dimethyl ether are different', () => {
    expect(canonicalKey(mol('CCO'))).not.toBe(canonicalKey(mol('COC')));
  });

  it('finds a molecule regardless of atom order', () => {
    expect(lookupMolecule(mol('OCC'))?.id).toBe('ethanol');
    expect(lookupMolecule(mol('OC(=O)CN'))?.id).toBe('glycine');
    expect(lookupMolecule(mol('COC'))).toBeUndefined();
  });
});

describe('VSEPR', () => {
  const geom = (s: string, center = 0) => analyzeCenter(mol(s), center).geometry;
  it.each([
    ['O', 'bent'],
    ['C', 'tetrahedral'],
    ['N', 'trigonalPyramidal'],
    ['O=C=O', null],
    ['C=O', 'trigonalPlanar'],
    ['[Xe](F)(F)(F)F', 'squarePlanar'],
    ['S(F)(F)(F)(F)(F)F', 'octahedral'],
    ['P(Cl)(Cl)(Cl)(Cl)Cl', 'trigonalBipyramidal'],
  ])('%s → %s', (s, g) => {
    expect(geom(s)).toBe(g);
  });

  it('CO2 carbon is linear', () => {
    expect(analyzeCenter(mol('O=C=O'), 1).geometry).toBe('linear');
  });
});

describe('3D structure', () => {
  const center = (m: Molecule, z: number) => m.atoms.findIndex((a) => a.z === z);
  const angleAround = (s: string, z: number) => {
    const m = mol(s);
    const p = embed(m, lookupMolecule(m));
    const c = center(m, z);
    const [i, j] = neighbors(m, c);
    return { angle: measureAngle(p, c, i, j), len: measureDistance(p, c, i) };
  };

  it('water: 104.5°, 0.958 Å (experiment)', () => {
    const { angle, len } = angleAround('O', 8);
    expect(angle).toBeCloseTo(104.48, 0);
    expect(len).toBeCloseTo(0.958, 2);
  });

  it('methane: tetrahedral 109.5°', () => {
    expect(angleAround('C', 6).angle).toBeCloseTo(109.47, 0);
  });

  it('CO2 is linear', () => {
    expect(angleAround('O=C=O', 6).angle).toBeGreaterThan(178);
  });

  it('SF6 has 90° neighbours', () => {
    const m = mol('S(F)(F)(F)(F)(F)F');
    const p = embed(m);
    const nb = neighbors(m, 0);
    const angles = nb.slice(1).map((j) => measureAngle(p, 0, nb[0], j)).sort((a, b) => a - b);
    expect(angles[0]).toBeCloseTo(90, -1);
    expect(angles[angles.length - 1]).toBeGreaterThan(170);
  });

  it('benzene ring is a flat hexagon', () => {
    const m = mol('C1=CC=CC=C1');
    const p = embed(m, lookupMolecule(m));
    const cs = m.atoms.map((a, i) => (a.z === 6 ? i : -1)).filter((i) => i >= 0);
    for (const c of cs) {
      const ring = neighbors(m, c).filter((j) => m.atoms[j].z === 6);
      expect(measureAngle(p, c, ring[0], ring[1])).toBeCloseTo(120, -1);
    }
  });
});
