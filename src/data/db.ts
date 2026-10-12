import elementsJson from './elements.json';
import type { Element, Isotope } from './types';

export const ELEMENTS = elementsJson as Element[];

const bySymbol = new Map(ELEMENTS.map((e) => [e.symbol, e]));

export function element(z: number): Element | undefined {
  return ELEMENTS[z - 1];
}

export function elementBySymbol(symbol: string): Element | undefined {
  return bySymbol.get(symbol);
}

/** Atomic mass unit in keV (CODATA 2018, as used by AME2020/NUBASE2020). */
export const U_KEV = 931494.10242;
export const YEAR_S = 365.2422 * 86400;

export function isotopeMass(iso: Isotope): number {
  return iso.a + iso.massExcess / U_KEV;
}

// The isotope table is ~0.8 MB, so it is loaded on first use instead of shipping in the main bundle.
let isotopes: Promise<Isotope[]> | null = null;
let byZ: Map<number, Isotope[]> | null = null;

export function loadIsotopes(): Promise<Isotope[]> {
  isotopes ??= import('./isotopes.json').then((m) => {
    const list = m.default as Isotope[];
    byZ = new Map();
    for (const iso of list) {
      const arr = byZ.get(iso.z) ?? [];
      arr.push(iso);
      byZ.set(iso.z, arr);
    }
    return list;
  });
  return isotopes;
}

/** Requires loadIsotopes() to have resolved. */
export function isotopesOf(z: number): Isotope[] {
  if (!byZ) throw new Error('isotopes not loaded');
  return byZ.get(z) ?? [];
}

export function isotope(z: number, a: number): Isotope | undefined {
  return isotopesOf(z).find((i) => i.a === a);
}
