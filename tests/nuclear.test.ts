import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { isotope, loadIsotopes } from '../src/data/db';
import { applyMode, chooseMode, decayProbability } from '../src/nuclear/decay';
import { immediateDecay, nucleusStatus, stepDecay } from '../src/nuclear/nucleus';
import { formatSubshells, ionConfig, shellCounts } from '../src/chem/aufbau';

beforeAll(async () => {
  await loadIsotopes();
});

describe('decay products', () => {
  it.each([
    ['tritium β⁻ → He-3', 1, 3, 'B-', 2, 3],
    ['U-238 α → Th-234', 92, 238, 'A', 90, 234],
    ['C-14 β⁻ → N-14', 6, 14, 'B-', 7, 14],
    ['Fe-55 EC → Mn-55', 26, 55, 'EC', 25, 55],
    ['Na-22 e⁺ → Ne-22', 11, 22, 'e+', 10, 22],
    ['Ra-223 ¹⁴C → Pb-209', 88, 223, '14C', 82, 209],
    ['Li-11 β⁻n → Be-10', 3, 11, 'B-n', 4, 10],
    ['Li-11 β⁻2n → Be-9', 3, 11, 'B-2n', 4, 9],
    ['Be-8 α (code B+A style) via 2α', 4, 8, 'A', 2, 4],
    ['Ca-48 2β⁻ → Ti-48', 20, 48, '2B-', 22, 48],
    ['free neutron β⁻ → H-1', 0, 1, 'B-', 1, 1],
  ])('%s', (_, z, a, mode, dz, da) => {
    const o = applyMode(z, a, mode);
    expect([o.z, o.a]).toEqual([dz, da]);
  });

  it('EC consumes an electron, β⁻ emits electron and antineutrino', () => {
    expect(applyMode(26, 55, 'EC').electronDelta).toBe(-1);
    expect(applyMode(1, 3, 'B-').emitted.map((e) => e.kind)).toEqual(['electron', 'antineutrino']);
  });

  it('fission conserves Z and A', () => {
    const o = applyMode(98, 252, 'SF', new Rng(1));
    const frag = o.emitted.find((e) => e.kind === 'fragment') as { z: number; a: number };
    const neutrons = o.emitted.filter((e) => e.kind === 'neutron').length;
    expect(o.z + frag.z).toBe(98);
    expect(o.a + frag.a + neutrons).toBe(252);
    expect(o.simplified).toBe(true);
  });
});

describe('branch choice', () => {
  it('U-238 decays by α essentially always', () => {
    const rng = new Rng(7);
    const u = isotope(92, 238)!;
    let alpha = 0;
    for (let i = 0; i < 2000; i++) if (chooseMode(u, 92, rng) === 'A') alpha++;
    expect(alpha).toBeGreaterThan(1995);
  });

  it('Li-11 follows NUBASE sub-branches (β⁻n ≈ 86%)', () => {
    const rng = new Rng(3);
    const li = isotope(3, 11)!;
    let bn = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) if (chooseMode(li, 3, rng) === 'B-n') bn++;
    expect(bn / N).toBeCloseTo(0.863, 1);
  });

  it('Na-22 splits β⁺ into e⁺ ≈ 90.6% and EC', () => {
    const rng = new Rng(5);
    const na = isotope(11, 22)!;
    let ep = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) if (chooseMode(na, 11, rng) === 'e+') ep++;
    expect(ep / N).toBeCloseTo(0.9057, 1);
  });

  it('bare Be-7 cannot decay (EC only)', () => {
    expect(nucleusStatus(4, 7, 0).kind).toBe('bareStable');
    expect(nucleusStatus(4, 7, 4).kind).toBe('radioactive');
    expect(chooseMode(isotope(4, 7)!, 0, new Rng(1))).toBeNull();
  });
});

describe('decay timing', () => {
  it('half of the nuclei survive one half-life', () => {
    const rng = new Rng(42);
    const T = 1;
    const dt = 1 / 120;
    let survived = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      let alive = true;
      for (let t = 0; t < T - 1e-9 && alive; t += dt) if (rng.next() < decayProbability(T, dt)) alive = false;
      if (alive) survived++;
    }
    expect(survived / N).toBeCloseTo(0.5, 1);
  });

  it('is deterministic for the same seed', () => {
    const run = (seed: number) => {
      const rng = new Rng(seed);
      const out: string[] = [];
      for (let i = 0; i < 500; i++) out.push(stepDecay(1, 3, 1, 1e8, rng)?.mode ?? '-');
      return out.join();
    };
    expect(run(9)).toBe(run(9));
  });
});

describe('nucleus status', () => {
  it('classifies common nuclei', () => {
    expect(nucleusStatus(8, 16, 8).kind).toBe('stable');
    expect(nucleusStatus(1, 3, 1).kind).toBe('radioactive');
    expect(nucleusStatus(3, 3, 3).kind).toBe('unbound');
    expect(nucleusStatus(1, 9, 1)).toEqual({ kind: 'unbound', iso: null });
    expect(nucleusStatus(0, 0, 0).kind).toBe('empty');
  });

  it('a nucleus past the neutron drip line sheds a neutron', () => {
    const o = immediateDecay(8, 40, 8, new Rng(1))!;
    expect(o.a).toBe(39);
    expect(o.simplified).toBe(true);
  });
});

describe('ion configurations', () => {
  it.each([
    [26, 24, '1s2 2s2 2p6 3s2 3p6 3d6'],
    [26, 23, '1s2 2s2 2p6 3s2 3p6 3d5'],
    [11, 10, '1s2 2s2 2p6'],
    [17, 18, '1s2 2s2 2p6 3s2 3p6'],
    [8, 10, '1s2 2s2 2p6'],
  ])('Z=%i with %i electrons', (z, e, cfg) => {
    expect(formatSubshells(ionConfig(z, e))).toBe(cfg);
  });

  it('counts electrons per shell', () => {
    expect(shellCounts(ionConfig(26, 26))).toEqual([2, 8, 14, 2]);
  });
});
