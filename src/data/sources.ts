import type { SourceId } from './types';

export interface Source {
  short: string;
  citation: string;
  url: string;
}

export const SOURCES: Record<SourceId, Source> = {
  ciaaw2024: {
    short: 'CIAAW 2024',
    citation: 'IUPAC CIAAW, Abridged Standard Atomic Weights 2024',
    url: 'https://www.ciaaw.org/abridged-atomic-weights.htm',
  },
  pubchem: {
    short: 'PubChem',
    citation: 'PubChem Periodic Table of Elements, NCBI (NIH)',
    url: 'https://pubchem.ncbi.nlm.nih.gov/periodic-table/',
  },
  nubase2020: {
    short: 'NUBASE2020',
    citation: 'F.G. Kondev, M. Wang, W.J. Huang, S. Naimi, G. Audi, Chin. Phys. C 45, 030001 (2021)',
    url: 'https://www-nds.iaea.org/amdc/',
  },
  pyykko: {
    short: 'Pyykkö',
    citation:
      'P. Pyykkö, M. Atsumi, Chem. Eur. J. 15, 186 (2009) and 15, 12770 (2009); P. Pyykkö, S. Riedel, M. Patzschke, Chem. Eur. J. 11, 3511 (2005) — additive covalent radii; bond length ≈ r₁ + r₂',
    url: 'https://doi.org/10.1002/chem.200800987',
  },
  cccbdb: {
    short: 'NIST CCCBDB',
    citation: 'NIST Computational Chemistry Comparison and Benchmark Database, experimental geometries (Release 22)',
    url: 'https://cccbdb.nist.gov/expgeom1x.asp',
  },
  vsepr: {
    short: 'VSEPR',
    citation: 'Ideal VSEPR angle for this electron-domain geometry (Gillespie–Nyholm); real angles differ by a few degrees',
    url: 'https://en.wikipedia.org/wiki/VSEPR_theory',
  },
  crc: {
    short: 'CRC',
    citation: 'CRC Handbook of Chemistry and Physics, 97th ed. (W. M. Haynes, ed.), CRC Press, 2016',
    url: 'https://hbcp.chemnetbase.com/',
  },
  nistWebbook: {
    short: 'NIST WebBook',
    citation: 'NIST Chemistry WebBook, SRD 69 (P. J. Linstrom, W. G. Mallard, eds.) — phase change data, Antoine coefficients',
    url: 'https://webbook.nist.gov/chemistry/',
  },
  iapws: {
    short: 'IAPWS',
    citation: 'IAPWS R6-95(2018): triple point 273.16 K / 611.657 Pa, critical point 647.096 K / 22.064 MPa',
    url: 'http://www.iapws.org/relguide/IAPWS-95.html',
  },
  assael2006: {
    short: 'Assael 2006',
    citation: 'M. J. Assael et al., Reference data for the density and viscosity of liquid aluminum and liquid iron, J. Phys. Chem. Ref. Data 35, 285 (2006)',
    url: 'https://doi.org/10.1063/1.2149380',
  },
  vogelWater: {
    short: 'Vogel fit',
    citation: 'Vogel-type correlation for water viscosity μ = A·10^(B/(T−C)), A = 2.414·10⁻⁵ Pa·s, B = 247.8 K, C = 140 K (±2.5 % from 0 to 370 °C)',
    url: 'https://en.wikipedia.org/wiki/Viscosity#Water',
  },
  nasa: {
    short: 'NASA',
    citation: 'NASA Planetary Fact Sheet (surface gravity)',
    url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/',
  },
  pdg: {
    short: 'PDG',
    citation: 'Particle Data Group, Review of Particle Physics (2024): proton mass 938.272 MeV/c², quark masses (MS-bar, 2 GeV) u = 2.16 MeV, d = 4.70 MeV',
    url: 'https://pdg.lbl.gov/',
  },
  slater: {
    short: 'Slater',
    citation: "J. C. Slater, Atomic Shielding Constants, Phys. Rev. 36, 57 (1930) — effective nuclear charge; orbitals hydrogen-like",
    url: 'https://doi.org/10.1103/PhysRev.36.57',
  },
  estimate: {
    short: 'оценка',
    citation: 'Estimate: no reliable reference value found; order of magnitude from similar materials',
    url: '',
  },
  derived: {
    short: 'calc',
    citation: 'Calculated in-game from the sourced values above',
    url: '',
  },
};

/** Which source each Element field comes from (mass is per-element, see Element.massSource). */
export const ELEMENT_FIELD_SOURCE = {
  config: 'pubchem',
  electronegativity: 'pubchem',
  ionization: 'pubchem',
  electronAffinity: 'pubchem',
  radius: 'pubchem',
  oxidationStates: 'pubchem',
  standardState: 'pubchem',
  meltingPoint: 'pubchem',
  boilingPoint: 'pubchem',
  density: 'pubchem',
  cpk: 'pubchem',
} as const satisfies Record<string, SourceId>;
