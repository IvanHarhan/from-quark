import { describe, expect, it } from 'vitest';
import { blackbodyColor, glowTable } from '../src/render/blackbody';

describe('blackbody colour (Planck × CIE 1931)', () => {
  it('1500 K is red-orange: red dominates, blue is nearly absent', () => {
    const [r, g, b] = blackbodyColor(1500);
    expect(r).toBe(1);
    expect(g).toBeLessThan(0.6);
    expect(b).toBeLessThan(0.2);
  });

  it('6500 K is close to white (the sRGB white point is D65)', () => {
    const [r, g, b] = blackbodyColor(6500);
    expect(Math.min(r, g, b)).toBeGreaterThan(0.85);
  });

  it('glow brightens monotonically with temperature', () => {
    const t = glowTable();
    const lum = t.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
    for (let i = 1; i < lum.length; i++) expect(lum[i]).toBeGreaterThanOrEqual(lum[i - 1]);
    // Near the Draper point (~800 K) the glow is still faint.
    expect(lum[3]).toBeLessThan(0.1);
  });
});
