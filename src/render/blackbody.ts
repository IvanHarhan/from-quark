/**
 * Colour of thermal emission: Planck's law integrated against the CIE 1931 colour-matching functions
 * (analytic multi-lobe fit, Wyman–Sloan–Shirley 2013), converted to linear sRGB.
 */

const H = 6.62607015e-34;
const C = 2.99792458e8;
const KB = 1.380649e-23;

const g = (x: number, mu: number, s1: number, s2: number) => {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
};

function cie(nm: number): [number, number, number] {
  return [
    1.056 * g(nm, 599.8, 37.9, 31.0) + 0.362 * g(nm, 442.0, 16.0, 26.7) - 0.065 * g(nm, 501.1, 20.4, 26.2),
    0.821 * g(nm, 568.8, 46.9, 40.5) + 0.286 * g(nm, 530.9, 16.3, 31.1),
    1.217 * g(nm, 437.0, 11.8, 36.0) + 0.681 * g(nm, 459.0, 26.0, 13.8),
  ];
}

function planck(nm: number, T: number): number {
  const l = nm * 1e-9;
  return (2 * H * C * C) / l ** 5 / (Math.exp((H * C) / (l * KB * T)) - 1);
}

/** CIE XYZ of a blackbody at T (arbitrary absolute scale, consistent across T). */
export function blackbodyXYZ(T: number): [number, number, number] {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const b = planck(nm, T);
    const [x, y, z] = cie(nm);
    X += b * x;
    Y += b * y;
    Z += b * z;
  }
  return [X, Y, Z];
}

/** Linear sRGB chromaticity (max channel = 1). */
export function blackbodyColor(T: number): [number, number, number] {
  const [X, Y, Z] = blackbodyXYZ(T);
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  const m = Math.max(r, gg, b);
  return [Math.max(0, r / m), Math.max(0, gg / m), Math.max(0, b / m)];
}

export const GLOW_T0 = 500;
export const GLOW_STEP = 100;
export const GLOW_STEPS = 36;

/**
 * Table for shaders: rgb = colour × display intensity, for T = 500 K + 100 K·i.
 * Visible luminance grows ~T¹⁰ near the Draper point (~800 K); the display intensity compresses it
 * (Y relative to 1800 K, to the power 0.35) so dull red, orange and white heat all fit on screen.
 */
export function glowTable(): [number, number, number, number][] {
  const yRef = blackbodyXYZ(1800)[1];
  return Array.from({ length: GLOW_STEPS }, (_, i) => {
    const T = GLOW_T0 + GLOW_STEP * i;
    const [r, g2, b] = blackbodyColor(T);
    const k = Math.min(4, (blackbodyXYZ(T)[1] / yRef) ** 0.35);
    return [r * k, g2 * k, b * k, T];
  });
}
