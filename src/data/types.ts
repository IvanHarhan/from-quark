export type SourceId =
  | 'ciaaw2024'
  | 'pubchem'
  | 'nubase2020'
  | 'pyykko'
  | 'cccbdb'
  | 'vsepr'
  | 'crc'
  | 'nistWebbook'
  | 'iapws'
  | 'assael2006'
  | 'vogelWater'
  | 'nasa'
  | 'estimate'
  | 'pdg'
  | 'slater'
  | 'derived';

export interface Element {
  z: number;
  symbol: string;
  name: string;
  /** Standard atomic weight, g/mol. Radioactive elements: mass of the longest-lived isotope. */
  mass: number;
  massUncertainty: number | null;
  /** 'ciaaw2024' or 'nubase2020' when taken from the longest-lived isotope. */
  massSource: SourceId;
  /** Mass number of the longest-lived isotope, set only when massSource is nubase2020. */
  massNumber: number | null;
  cpk: string;
  /** Ground-state configuration as published (may differ from the Madelung rule). */
  config: string;
  configPredicted: boolean;
  /** Pauling scale. */
  electronegativity: number | null;
  /** First ionization energy, eV. */
  ionization: number | null;
  /** Electron affinity, eV. */
  electronAffinity: number | null;
  /** Van der Waals radius, pm. */
  radius: number | null;
  /** Pyykkö additive covalent radii for single, double, triple bonds, pm. */
  covalentRadius: [number | null, number | null, number | null];
  oxidationStates: number[];
  standardState: 'solid' | 'liquid' | 'gas' | null;
  /** K */
  meltingPoint: number | null;
  /** K */
  boilingPoint: number | null;
  /** g/cm³ */
  density: number | null;
  block: string;
}

/** NUBASE decay code (A, B-, B+, EC, IT, SF, n, p, 2B-, B-n, ...) with branching ratio in %. */
export interface DecayBranch {
  mode: string;
  /** null = observed but intensity unknown */
  percent: number | null;
  /** '=' exact, '~' approximate, '<' / '>' bound, '?' uncertain */
  rel: '=' | '~' | '<' | '>' | '?';
}

export interface Isotope {
  z: number;
  a: number;
  /** Mass excess, keV */
  massExcess: number;
  /** true when NUBASE marks the value as from systematics (#) */
  estimated: boolean;
  /** Half-life in seconds; null when stable or not measured (e.g. particle-unbound). */
  halfLife: number | null;
  stable: boolean;
  /** As printed in NUBASE, e.g. "12.32 y". */
  halfLifeText: string;
  /** Natural abundance, %. */
  abundance: number | null;
  spinParity: string;
  decays: DecayBranch[];
}
