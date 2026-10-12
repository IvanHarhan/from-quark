import { elementBySymbol } from '../data/db';

export type Composition = Map<string, number>;

/** Parses formulas like "H2O", "Ca(OH)2", "CuSO4·5H2O" into element counts. */
export function parseFormula(formula: string): Composition {
  const total: Composition = new Map();
  for (const part of formula.split(/[·.*]/)) {
    const m = part.match(/^(\d*)(.*)$/)!;
    const mult = m[1] ? parseInt(m[1], 10) : 1;
    for (const [sym, n] of parseGroup(m[2], formula)) add(total, sym, n * mult);
  }
  return total;
}

function parseGroup(s: string, whole: string): Composition {
  const stack: Composition[] = [new Map()];
  const re = /([A-Z][a-z]?)(\d*)|(\()|(\))(\d*)|(\s+)/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new Error(`Bad formula "${whole}" at "${s.slice(i)}"`);
    i = re.lastIndex;
    if (m[1]) {
      if (!elementBySymbol(m[1])) throw new Error(`Unknown element "${m[1]}" in "${whole}"`);
      add(stack[stack.length - 1], m[1], m[2] ? parseInt(m[2], 10) : 1);
    } else if (m[3]) {
      stack.push(new Map());
    } else if (m[4]) {
      if (stack.length < 2) throw new Error(`Unbalanced ")" in "${whole}"`);
      const inner = stack.pop()!;
      const mult = m[5] ? parseInt(m[5], 10) : 1;
      for (const [sym, n] of inner) add(stack[stack.length - 1], sym, n * mult);
    }
  }
  if (stack.length !== 1) throw new Error(`Unbalanced "(" in "${whole}"`);
  return stack[0];
}

function add(c: Composition, sym: string, n: number) {
  c.set(sym, (c.get(sym) ?? 0) + n);
}

/** g/mol from CIAAW standard atomic weights. */
export function molarMass(formula: string | Composition): number {
  const comp = typeof formula === 'string' ? parseFormula(formula) : formula;
  let m = 0;
  for (const [sym, n] of comp) m += elementBySymbol(sym)!.mass * n;
  return m;
}
