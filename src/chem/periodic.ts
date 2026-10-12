const PERIOD_END = [2, 10, 18, 36, 54, 86, 118];

export function period(z: number): number {
  return PERIOD_END.findIndex((end) => z <= end) + 1;
}

/** Group 1–18, or null for lanthanides/actinides (La–Lu, Ac–Lr are drawn in the f-block rows). */
export function group(z: number): number | null {
  const p = period(z);
  const i = z - (p === 1 ? 1 : PERIOD_END[p - 2] + 1); // index within the period
  if (p === 1) return z === 1 ? 1 : 18;
  if (p <= 3) return i < 2 ? i + 1 : i + 11;
  if (p <= 5) return i + 1;
  if (i < 2) return i + 1;
  if (i <= 16) return null;
  return i - 13;
}

/** Grid cell for the standard 18-column layout; f-block goes to rows 9–10. */
export function tableCell(z: number): { row: number; col: number } {
  const g = group(z);
  if (g !== null) return { row: period(z), col: g };
  const p = period(z);
  return { row: p + 3, col: z - (p === 6 ? 57 : 89) + 3 };
}
