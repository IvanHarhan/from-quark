// Builds src/data/elements.json and src/data/isotopes.json from data-raw/ (see fetch.ts).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DecayBranch, Element, Isotope } from '../../src/data/types.ts';

const ROOT = join(import.meta.dirname, '../..');
const raw = (f: string) => readFile(join(ROOT, 'data-raw', f), 'utf8');

const U_KEV = 931494.10242; // atomic mass unit, keV (CODATA 2018, used by AME2020)
const HBAR_EVS = 6.582119569e-16;
const YEAR_S = 365.2422 * 86400; // NUBASE2020 year definition

const UNIT_S: Record<string, number> = {
  ys: 1e-24, zs: 1e-21, as: 1e-18, fs: 1e-15, ps: 1e-12, ns: 1e-9, us: 1e-6, ms: 1e-3,
  s: 1, m: 60, h: 3600, d: 86400,
  y: YEAR_S, ky: 1e3 * YEAR_S, My: 1e6 * YEAR_S, Gy: 1e9 * YEAR_S, Ty: 1e12 * YEAR_S,
  Py: 1e15 * YEAR_S, Ey: 1e18 * YEAR_S, Zy: 1e21 * YEAR_S, Yy: 1e24 * YEAR_S,
};
// Some particle-unbound ground states are given as a resonance width; t½ = ln2·ħ/Γ.
const WIDTH_EV: Record<string, number> = { eV: 1, keV: 1e3, MeV: 1e6 };

const num = (s: string): number | null => {
  const v = parseFloat(s.replace(/[#~<>]/g, ''));
  return Number.isFinite(v) ? v : null;
};

function parseIsotopes(text: string): Isotope[] {
  const out: Isotope[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const col = (a: number, b: number) => line.slice(a - 1, b).trim();
    if (line[7] !== '0') continue; // ground states only
    const a = parseInt(col(1, 3), 10);
    const z = parseInt(col(5, 7), 10);
    const mexText = col(19, 31);
    const mex = num(mexText);
    if (mex === null) continue;

    const tText = col(70, 78);
    const unit = col(79, 80);
    const stable = tText === 'stbl';
    let halfLife: number | null = null;
    const t = num(tText);
    if (!stable && t !== null) {
      if (unit in UNIT_S) halfLife = t * UNIT_S[unit];
      else if (unit in WIDTH_EV) halfLife = (Math.LN2 * HBAR_EVS) / (t * WIDTH_EV[unit]);
    }

    let abundance: number | null = null;
    const decays: DecayBranch[] = [];
    for (const item of col(120, 209).split(';').map((s) => s.trim()).filter(Boolean)) {
      const m = item.match(/^([^=~<>\s]+)\s*([=~<>]?)\s*(.*)$/);
      if (!m) continue;
      const [, mode, op, rest] = m;
      const value = num(rest.split(/\s+/)[0] ?? '');
      if (mode === 'IS') {
        abundance = value;
        continue;
      }
      const rel = (op || (rest.includes('?') ? '?' : '=')) as DecayBranch['rel'];
      decays.push({ mode, percent: value, rel: value === null ? '?' : rel });
    }

    out.push({
      z, a,
      massExcess: mex,
      estimated: mexText.includes('#'),
      halfLife,
      stable,
      halfLifeText: stable ? 'stable' : `${tText} ${unit}`.trim(),
      abundance,
      spinParity: col(89, 102),
      decays,
    });
  }
  return out;
}

function parseCiaaw(html: string): Map<number, { mass: number; unc: number }> {
  const map = new Map<number, { mass: number; unc: number }>();
  const clean = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  for (const row of html.split(/<tr/i).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => clean(m[1]));
    const z = parseInt(cells[0], 10);
    const m = cells[3]?.match(/([\d.]+)\s*&plusmn;\s*([\d.]+)/);
    if (Number.isFinite(z) && m) map.set(z, { mass: parseFloat(m[1]), unc: parseFloat(m[2]) });
  }
  return map;
}

function parseOxidation(s: string): number[] {
  return s.split(',').map((x) => parseInt(x.trim(), 10)).filter(Number.isFinite);
}

function parseState(s: string): Element['standardState'] {
  const l = s.toLowerCase();
  if (l.includes('gas')) return 'gas';
  if (l.includes('liquid')) return 'liquid';
  if (l.includes('solid')) return 'solid';
  return null;
}

const pubchem = JSON.parse(await raw('pubchem-periodictable.json'));
const cols: string[] = pubchem.Table.Columns.Column;
const isotopes = parseIsotopes(await raw('nubase_4.mas20.txt'));
const ciaaw = parseCiaaw(await raw('ciaaw-abridged.htm'));

const atomicMass = (iso: Isotope) => iso.a + iso.massExcess / U_KEV;

// Pyykkö covalent radii (pm): single (2009), double (2009), triple (2005).
const radii = new Map<number, [number | null, number | null, number | null]>();
{
  const db = new DatabaseSync(join(ROOT, 'data-raw/mendeleev-elements.db'), { readOnly: true });
  const rows = db
    .prepare('select atomic_number z, covalent_radius_pyykko r1, covalent_radius_pyykko_double r2, covalent_radius_pyykko_triple r3 from elements')
    .all() as { z: number; r1: number | null; r2: number | null; r3: number | null }[];
  const round = (v: number | null) => (v === null ? null : Math.round(v));
  for (const r of rows) radii.set(r.z, [round(r.r1), round(r.r2), round(r.r3)]);
  db.close();
}

const elements: Element[] = pubchem.Table.Row.map((r: { Cell: string[] }) => {
  const c = Object.fromEntries(cols.map((k, i) => [k, r.Cell[i]]));
  const z = parseInt(c.AtomicNumber, 10);
  const std = ciaaw.get(z);
  let mass: number;
  let massNumber: number | null = null;
  if (std) {
    mass = std.mass;
  } else {
    // No standard atomic weight: use the longest-lived isotope, as periodic tables conventionally do.
    const longest = isotopes
      .filter((i) => i.z === z && i.halfLife !== null)
      .sort((x, y) => y.halfLife! - x.halfLife!)[0];
    if (!longest) throw new Error(`no isotope for Z=${z}`);
    mass = +atomicMass(longest).toFixed(6);
    massNumber = longest.a;
  }
  const config = c.ElectronConfiguration.replace(/\s*\(predicted\)/i, '').trim();
  const el: Element = {
    z,
    symbol: c.Symbol,
    name: c.Name,
    mass,
    massUncertainty: std?.unc ?? null,
    massSource: std ? 'ciaaw2024' : 'nubase2020',
    massNumber,
    cpk: c.CPKHexColor ? `#${c.CPKHexColor}` : '#FF1493',
    config,
    configPredicted: /predicted/i.test(c.ElectronConfiguration),
    electronegativity: num(c.Electronegativity),
    ionization: num(c.IonizationEnergy),
    electronAffinity: num(c.ElectronAffinity),
    radius: num(c.AtomicRadius),
    covalentRadius: radii.get(z) ?? [null, null, null],
    oxidationStates: parseOxidation(c.OxidationStates),
    standardState: parseState(c.StandardState),
    meltingPoint: num(c.MeltingPoint),
    boilingPoint: num(c.BoilingPoint),
    density: num(c.Density),
    block: c.GroupBlock,
  };
  return el;
});

if (elements.length !== 118) throw new Error(`expected 118 elements, got ${elements.length}`);

await writeFile(join(ROOT, 'src/data/elements.json'), JSON.stringify(elements));
await writeFile(join(ROOT, 'src/data/isotopes.json'), JSON.stringify(isotopes));
console.log(`elements: ${elements.length} (${ciaaw.size} with CIAAW weights), isotopes: ${isotopes.length}`);
