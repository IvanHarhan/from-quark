/**
 * Reference molecules. Structures as Kekulé SMILES; PubChem CID for identity.
 * Experimental geometry (bond lengths in Å, angles in °) from NIST CCCBDB where listed;
 * everything else is computed (Pyykkö radii + VSEPR) and labelled as such in the UI.
 */
export interface MoleculeEntry {
  id: string;
  ru: string;
  en: string;
  smiles: string;
  cid: number;
  /** "C=C": 1.339 — key is "A-B" / "A=B" / "A#B" with symbols sorted alphabetically. */
  bonds?: Record<string, number>;
  /** "H-O-H": 104.48 — outer symbols sorted alphabetically around the centre. */
  angles?: Record<string, number>;
  organic?: boolean;
}

export const MOLECULES: MoleculeEntry[] = [
  { id: 'h2', ru: 'Водород', en: 'Hydrogen', smiles: '[H][H]', cid: 783, bonds: { 'H-H': 0.741 } },
  { id: 'n2', ru: 'Азот', en: 'Nitrogen', smiles: 'N#N', cid: 947, bonds: { 'N#N': 1.098 } },
  { id: 'o2', ru: 'Кислород', en: 'Oxygen', smiles: 'O=O', cid: 977, bonds: { 'O=O': 1.208 } },
  { id: 'f2', ru: 'Фтор', en: 'Fluorine', smiles: 'FF', cid: 24524, bonds: { 'F-F': 1.412 } },
  { id: 'cl2', ru: 'Хлор', en: 'Chlorine', smiles: 'ClCl', cid: 24526, bonds: { 'Cl-Cl': 1.988 } },
  { id: 'hf', ru: 'Фтороводород', en: 'Hydrogen fluoride', smiles: 'F', cid: 14917, bonds: { 'F-H': 0.917 } },
  { id: 'hcl', ru: 'Хлороводород', en: 'Hydrogen chloride', smiles: 'Cl', cid: 313, bonds: { 'Cl-H': 1.275 } },
  { id: 'hbr', ru: 'Бромоводород', en: 'Hydrogen bromide', smiles: 'Br', cid: 260, bonds: { 'Br-H': 1.414 } },
  { id: 'h2o', ru: 'Вода', en: 'Water', smiles: 'O', cid: 962, bonds: { 'H-O': 0.958 }, angles: { 'H-O-H': 104.48 } },
  { id: 'h2o2', ru: 'Пероксид водорода', en: 'Hydrogen peroxide', smiles: 'OO', cid: 784 },
  { id: 'co', ru: 'Угарный газ', en: 'Carbon monoxide', smiles: '[C-]#[O+]', cid: 281, bonds: { 'C#O': 1.128 } },
  { id: 'co2', ru: 'Углекислый газ', en: 'Carbon dioxide', smiles: 'O=C=O', cid: 280, bonds: { 'C=O': 1.162 }, angles: { 'O-C-O': 180 } },
  { id: 'ch4', ru: 'Метан', en: 'Methane', smiles: 'C', cid: 297, bonds: { 'C-H': 1.087 }, angles: { 'H-C-H': 109.47 }, organic: true },
  { id: 'nh3', ru: 'Аммиак', en: 'Ammonia', smiles: 'N', cid: 222, bonds: { 'H-N': 1.012 }, angles: { 'H-N-H': 106.7 } },
  { id: 'h2s', ru: 'Сероводород', en: 'Hydrogen sulfide', smiles: 'S', cid: 402, bonds: { 'H-S': 1.336 }, angles: { 'H-S-H': 92.1 } },
  { id: 'so2', ru: 'Сернистый газ', en: 'Sulfur dioxide', smiles: 'O=S=O', cid: 1119, bonds: { 'O=S': 1.431 }, angles: { 'O-S-O': 119.3 } },
  { id: 'o3', ru: 'Озон', en: 'Ozone', smiles: '[O-][O+]=O', cid: 24823, angles: { 'O-O-O': 116.8 } },
  { id: 'nacl', ru: 'Хлорид натрия (молекула в газе)', en: 'Sodium chloride (gas-phase molecule)', smiles: '[Na]Cl', cid: 5234, bonds: { 'Cl-Na': 2.361 } },
  { id: 'naoh', ru: 'Гидроксид натрия', en: 'Sodium hydroxide', smiles: '[Na]O', cid: 14798 },
  { id: 'h2so4', ru: 'Серная кислота', en: 'Sulfuric acid', smiles: 'OS(=O)(=O)O', cid: 1118 },
  { id: 'hno3', ru: 'Азотная кислота', en: 'Nitric acid', smiles: 'O[N+](=O)[O-]', cid: 944 },
  { id: 'hcn', ru: 'Циановодород', en: 'Hydrogen cyanide', smiles: 'C#N', cid: 768, bonds: { 'C-H': 1.065, 'C#N': 1.153 } },
  { id: 'c2h2', ru: 'Ацетилен', en: 'Acetylene', smiles: 'C#C', cid: 6326, bonds: { 'C#C': 1.203, 'C-H': 1.063 }, organic: true },
  { id: 'c2h4', ru: 'Этилен', en: 'Ethylene', smiles: 'C=C', cid: 6325, bonds: { 'C=C': 1.339, 'C-H': 1.086 }, angles: { 'H-C-H': 117.6 }, organic: true },
  { id: 'c2h6', ru: 'Этан', en: 'Ethane', smiles: 'CC', cid: 6324, bonds: { 'C-C': 1.535, 'C-H': 1.094 }, organic: true },
  { id: 'ch2o', ru: 'Формальдегид', en: 'Formaldehyde', smiles: 'C=O', cid: 712, bonds: { 'C=O': 1.205, 'C-H': 1.111 }, angles: { 'H-C-H': 116.1 }, organic: true },
  { id: 'ch3oh', ru: 'Метанол', en: 'Methanol', smiles: 'CO', cid: 887, organic: true },
  { id: 'ethanol', ru: 'Этанол', en: 'Ethanol', smiles: 'CCO', cid: 702, organic: true },
  { id: 'acetic', ru: 'Уксусная кислота', en: 'Acetic acid', smiles: 'CC(=O)O', cid: 176, organic: true },
  { id: 'acetone', ru: 'Ацетон', en: 'Acetone', smiles: 'CC(=O)C', cid: 180, organic: true },
  { id: 'glycerol', ru: 'Глицерин', en: 'Glycerol', smiles: 'OCC(O)CO', cid: 753, organic: true },
  { id: 'benzene', ru: 'Бензол', en: 'Benzene', smiles: 'C1=CC=CC=C1', cid: 241, bonds: { 'C-C': 1.397, 'C=C': 1.397, 'C-H': 1.084 }, organic: true },
  { id: 'glycine', ru: 'Глицин', en: 'Glycine', smiles: 'NCC(=O)O', cid: 750, organic: true },
  { id: 'alanine', ru: 'Аланин', en: 'Alanine', smiles: 'CC(N)C(=O)O', cid: 5950, organic: true },
  { id: 'glucose', ru: 'Глюкоза', en: 'Glucose', smiles: 'OCC1OC(O)C(O)C(O)C1O', cid: 5793, organic: true },
  { id: 'propane', ru: 'Пропан', en: 'Propane', smiles: 'CCC', cid: 6334, organic: true },
  { id: 'butane', ru: 'Бутан', en: 'Butane', smiles: 'CCCC', cid: 7843, organic: true },
  { id: 'octane', ru: 'Октан', en: 'Octane', smiles: 'CCCCCCCC', cid: 356, organic: true },
  { id: 'cyclohexane', ru: 'Циклогексан', en: 'Cyclohexane', smiles: 'C1CCCCC1', cid: 8078, organic: true },
  { id: 'isopropanol', ru: 'Изопропанол', en: 'Isopropanol', smiles: 'CC(C)O', cid: 3776, organic: true },
  { id: 'glycol', ru: 'Этиленгликоль', en: 'Ethylene glycol', smiles: 'OCCO', cid: 174, organic: true },
  { id: 'acetaldehyde', ru: 'Ацетальдегид', en: 'Acetaldehyde', smiles: 'CC=O', cid: 177, organic: true },
  { id: 'formic', ru: 'Муравьиная кислота', en: 'Formic acid', smiles: 'OC=O', cid: 284, organic: true },
  { id: 'ether', ru: 'Диэтиловый эфир', en: 'Diethyl ether', smiles: 'CCOCC', cid: 3283, organic: true },
  { id: 'ethylacetate', ru: 'Этилацетат', en: 'Ethyl acetate', smiles: 'CCOC(C)=O', cid: 8857, organic: true },
  { id: 'lactic', ru: 'Молочная кислота', en: 'Lactic acid', smiles: 'CC(O)C(=O)O', cid: 612, organic: true },
  { id: 'citric', ru: 'Лимонная кислота', en: 'Citric acid', smiles: 'OC(=O)CC(O)(CC(=O)O)C(=O)O', cid: 311, organic: true },
  { id: 'palmitic', ru: 'Пальмитиновая кислота', en: 'Palmitic acid', smiles: 'CCCCCCCCCCCCCCCC(=O)O', cid: 985, organic: true },
  { id: 'urea', ru: 'Мочевина', en: 'Urea', smiles: 'NC(=O)N', cid: 1176, organic: true },
  { id: 'serine', ru: 'Серин', en: 'Serine', smiles: 'OCC(N)C(=O)O', cid: 5951, organic: true },
  { id: 'cysteine', ru: 'Цистеин', en: 'Cysteine', smiles: 'SCC(N)C(=O)O', cid: 5862, organic: true },
  { id: 'phenol', ru: 'Фенол', en: 'Phenol', smiles: 'OC1=CC=CC=C1', cid: 996, organic: true },
  { id: 'toluene', ru: 'Толуол', en: 'Toluene', smiles: 'CC1=CC=CC=C1', cid: 1140, organic: true },
  { id: 'aniline', ru: 'Анилин', en: 'Aniline', smiles: 'NC1=CC=CC=C1', cid: 6115, organic: true },
  { id: 'pyridine', ru: 'Пиридин', en: 'Pyridine', smiles: 'C1=CC=NC=C1', cid: 1049, organic: true },
  { id: 'naphthalene', ru: 'Нафталин', en: 'Naphthalene', smiles: 'C1=CC=C2C=CC=CC2=C1', cid: 931, organic: true },
  { id: 'ascorbic', ru: 'Витамин C', en: 'Vitamin C', smiles: 'OCC(O)C1OC(=O)C(O)=C1O', cid: 54670067, organic: true },
  { id: 'aspirin', ru: 'Аспирин', en: 'Aspirin', smiles: 'CC(=O)OC1=CC=CC=C1C(=O)O', cid: 2244, organic: true },
  { id: 'paracetamol', ru: 'Парацетамол', en: 'Paracetamol', smiles: 'CC(=O)NC1=CC=C(O)C=C1', cid: 1983, organic: true },
  { id: 'caffeine', ru: 'Кофеин', en: 'Caffeine', smiles: 'CN1C=NC2=C1C(=O)N(C)C(=O)N2C', cid: 2519, organic: true },
  { id: 'sucrose', ru: 'Сахароза', en: 'Sucrose', smiles: 'OCC1OC(CO)(OC2OC(CO)C(O)C(O)C2O)C(O)C1O', cid: 5988, organic: true },
];
