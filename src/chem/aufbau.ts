import { element, elementBySymbol } from '../data/db';

export interface Subshell {
  n: number;
  l: number; // 0=s 1=p 2=d 3=f
  electrons: number;
}

const L = 'spdf';
const CAPACITY = [2, 6, 10, 14];

/** Subshells in Madelung (Klechkovsky) order: by n+l, then by n. */
const ORDER: { n: number; l: number }[] = [];
for (let s = 1; s <= 8; s++) {
  for (let n = 1; n <= s; n++) {
    const l = s - n;
    if (l < n && l <= 3) ORDER.push({ n, l });
  }
}

/** Fills subshells by the Madelung rule. Real atoms deviate (Cr, Cu, ...): compare with the element's config. */
export function madelung(electrons: number): Subshell[] {
  const out: Subshell[] = [];
  let left = electrons;
  for (const { n, l } of ORDER) {
    if (left <= 0) break;
    const e = Math.min(left, CAPACITY[l]);
    out.push({ n, l, electrons: e });
    left -= e;
  }
  return out;
}

/** Expands "[Ar]4s2 3d6" into explicit subshells. */
export function parseConfig(config: string): Subshell[] {
  const out: Subshell[] = [];
  const core = config.match(/^\[([A-Z][a-z]?)\]/);
  if (core) {
    const el = elementBySymbol(core[1]);
    if (!el) throw new Error(`Unknown core ${core[1]}`);
    out.push(...parseConfig(el.config));
  }
  for (const m of config.replace(/^\[[A-Za-z]+\]/, '').matchAll(/(\d)([spdf])(\d+)/g)) {
    out.push({ n: +m[1], l: L.indexOf(m[2]), electrons: +m[3] });
  }
  return out;
}

/**
 * Configuration of an atom or ion. Cations lose electrons from the highest n first (Fe²⁺ = [Ar]3d6, not 4s2 3d4);
 * anions continue filling in Madelung order.
 */
export function ionConfig(z: number, electrons: number): Subshell[] {
  if (z < 1) return madelung(electrons);
  const el = element(z);
  const shells = parseConfig(el!.config).map((s) => ({ ...s }));
  let diff = electrons - z;
  while (diff < 0) {
    const s = shells.filter((x) => x.electrons > 0).sort((a, b) => b.n - a.n || b.l - a.l)[0];
    s.electrons--;
    diff++;
  }
  for (const { n, l } of ORDER) {
    if (diff <= 0) break;
    let s = shells.find((x) => x.n === n && x.l === l);
    if (!s) shells.push((s = { n, l, electrons: 0 }));
    const add = Math.min(diff, CAPACITY[l] - s.electrons);
    s.electrons += add;
    diff -= add;
  }
  return shells.filter((s) => s.electrons > 0).sort((a, b) => a.n - b.n || a.l - b.l);
}

/** Electrons per principal shell n (index 0 = K shell). */
export function shellCounts(shells: Subshell[]): number[] {
  const out: number[] = [];
  for (const s of shells) out[s.n - 1] = (out[s.n - 1] ?? 0) + s.electrons;
  return Array.from(out, (x) => x ?? 0);
}

export function formatSubshells(shells: Subshell[]): string {
  return shells.map((s) => `${s.n}${L[s.l]}${s.electrons}`).join(' ');
}

/** True when the configuration has the same occupations as the Madelung rule predicts. */
export function followsMadelung(config: string): boolean {
  const actual = parseConfig(config);
  const total = actual.reduce((a, s) => a + s.electrons, 0);
  const key = (s: Subshell[]) =>
    s.filter((x) => x.electrons > 0).map((x) => `${x.n}${x.l}:${x.electrons}`).sort().join(',');
  return key(actual) === key(madelung(total));
}
