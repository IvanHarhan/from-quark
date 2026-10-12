import type { Substance } from '../data/substances';

/**
 * Phase and heat bookkeeping for one substance.
 *
 * Specific enthalpy H (J/kg) is measured from the solid at its melting point:
 *   solid      H = cp_s (T − Tm)                     (H ≤ 0)
 *   melting    0 ≤ H ≤ Lf                            (T = Tm)
 *   liquid     H = Lf + cp_l (T − Tm)
 *   boiling    H_b ≤ H ≤ H_b + Lv, H_b = Lf + cp_l (Tb − Tm)   (T = Tb)
 *   gas        beyond: the particle leaves the liquid as vapour.
 * Simplifications: Tm does not depend on pressure (for ice −0.0074 K/atm); constant cp per phase.
 */

export const ATM = 101325;
const R = 8.314462618;

export type Phase = 'solid' | 'liquid' | 'gas' | 'supercritical';

/**
 * Boiling point at pressure P (Pa): Antoine within its tabulated range (±0.5 K), else Clausius–Clapeyron
 * anchored at Tb (1 atm) with constant Lv — an approximation that drifts a few K far from 1 atm.
 */
export function boilingPoint(s: Substance, P: number): number {
  if (s.antoine) {
    const logP = Math.log10(P / 1e5);
    // NIST ranges leave small gaps (e.g. 373–379 K for water); use the set whose range is nearest.
    let best: { T: number; miss: number } | null = null;
    for (const a of s.antoine) {
      const T = a.B / (a.A - logP) - a.C;
      const miss = Math.max(0, a.tMin - T, T - a.tMax);
      if (!best || miss < best.miss) best = { T, miss };
    }
    if (best && best.miss < 0.5) return best.T;
  }
  // 1/T = 1/Tb − (R / ΔHvap,molar) · ln(P/P₀)
  const hv = s.lv * (s.molarMass / 1000);
  return 1 / (1 / s.tb - (R / hv) * Math.log(P / ATM));
}

/** Vapour pressure (Pa) at T from Antoine, or Clausius–Clapeyron. */
export function vaporPressure(s: Substance, T: number): number {
  if (s.antoine) {
    const a = [...s.antoine].sort(
      (x, y) => Math.max(0, x.tMin - T, T - x.tMax) - Math.max(0, y.tMin - T, T - y.tMax),
    )[0];
    if (Math.max(0, a.tMin - T, T - a.tMax) < 0.5) return 1e5 * 10 ** (a.A - a.B / (T + a.C));
  }
  const hv = s.lv * (s.molarMass / 1000);
  return ATM * Math.exp((-hv / R) * (1 / T - 1 / s.tb));
}

/** Sublimation temperature below the triple-point pressure (Clausius–Clapeyron with L_sub = Lf + Lv). */
function sublimationPoint(s: Substance, P: number): number {
  const t = s.triple!;
  const hs = (s.lf + s.lv) * (s.molarMass / 1000);
  return 1 / (1 / t.T - (R / hs) * Math.log(P / t.P));
}

export function phaseAt(s: Substance, T: number, P: number): Phase {
  if (s.critical && T >= s.critical.T && P >= s.critical.P) return 'supercritical';
  if (s.triple && P < s.triple.P) return T < sublimationPoint(s, P) ? 'solid' : 'gas';
  if (T < s.tm) return 'solid';
  return T < boilingPoint(s, P) ? 'liquid' : 'gas';
}

export interface ThermalState {
  T: number;
  /** 0 = solid, 1 = liquid (fraction melted) */
  liquid: number;
  /** 0..1 fraction boiled off; 1 means the particle has become vapour */
  vapor: number;
}

export function boilEnthalpy(s: Substance, tb: number): number {
  return s.lf + s.cpLiquid * (tb - s.tm);
}

export function stateFromEnthalpy(s: Substance, H: number, tb: number): ThermalState {
  if (H <= 0) return { T: s.tm + H / s.cpSolid, liquid: 0, vapor: 0 };
  if (H <= s.lf) return { T: s.tm, liquid: H / s.lf, vapor: 0 };
  const hb = boilEnthalpy(s, tb);
  if (H <= hb) return { T: s.tm + (H - s.lf) / s.cpLiquid, liquid: 1, vapor: 0 };
  if (H <= hb + s.lv) return { T: tb, liquid: 1, vapor: (H - hb) / s.lv };
  return { T: tb, liquid: 1, vapor: 1 };
}

/** Enthalpy of a fully solid (T ≤ Tm) or fully liquid (Tm < T ≤ Tb) state. */
export function enthalpyAt(s: Substance, T: number, tb: number): number {
  if (T <= s.tm) return s.cpSolid * (T - s.tm);
  return s.lf + s.cpLiquid * (Math.min(T, tb) - s.tm);
}

export function viscosity(s: Substance, T: number): number {
  const v = s.viscosity;
  switch (v.model) {
    case 'vogel':
      return v.A * 10 ** (v.B / (T - v.C));
    case 'log10':
      return 1e-3 * 10 ** (v.a1 + v.a2 / T);
    case 'const':
      return v.value;
  }
}
