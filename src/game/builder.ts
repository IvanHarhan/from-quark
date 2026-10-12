import { create } from 'zustand';
import { Rng } from '../core/rng';
import type { DecayOutcome } from '../nuclear/decay';
import { stepDecay } from '../nuclear/nucleus';

export const MAX_PROTONS = 118;
export const MAX_NEUTRONS = 180;
/** Free atoms hold at most one extra electron; up to three is allowed so O²⁻, N³⁻ (as in crystals) can be built. */
export const MAX_EXTRA_ELECTRONS = 3;

export type Particle = 'p' | 'n' | 'e';

export interface DecayEvent extends DecayOutcome {
  id: number;
  fromZ: number;
  fromA: number;
  /** Game seconds the nucleus lived before decaying. */
  age: number;
}

export const TIME_SCALES = [1, 1e3, 1e6, 1e9, 1e12, 1e15, 1e18] as const;

interface BuilderState {
  protons: number;
  neutrons: number;
  electrons: number;
  /** Game seconds since the current nucleus was formed. */
  age: number;
  timeScale: number;
  paused: boolean;
  log: DecayEvent[];
  add(p: Particle, delta: number): void;
  setAtom(z: number, a: number, electrons?: number): void;
  setTimeScale(s: number): void;
  setPaused(p: boolean): void;
  clear(): void;
}

let nextId = 1;
const LOG_SIZE = 20;

export const useBuilder = create<BuilderState>((set, get) => ({
  protons: 1,
  neutrons: 0,
  electrons: 1,
  age: 0,
  timeScale: 1,
  paused: false,
  log: [],
  add(p, delta) {
    const s = get();
    const protons = p === 'p' ? clamp(s.protons + delta, 0, MAX_PROTONS) : s.protons;
    const neutrons = p === 'n' ? clamp(s.neutrons + delta, 0, MAX_NEUTRONS) : s.neutrons;
    const electrons = clamp(p === 'e' ? s.electrons + delta : s.electrons, 0, protons + MAX_EXTRA_ELECTRONS);
    if (protons !== s.protons || neutrons !== s.neutrons) set({ protons, neutrons, electrons, age: 0 });
    else set({ electrons });
  },
  setAtom(z, a, electrons = z) {
    const protons = clamp(z, 0, MAX_PROTONS);
    set({
      protons,
      neutrons: clamp(a - z, 0, MAX_NEUTRONS),
      electrons: clamp(electrons, 0, protons + MAX_EXTRA_ELECTRONS),
      age: 0,
    });
  },
  setTimeScale(timeScale) {
    set({ timeScale });
  },
  setPaused(paused) {
    set({ paused });
  },
  clear() {
    set({ protons: 0, neutrons: 0, electrons: 0, age: 0 });
  },
}));

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Seeded so a session replays identically; one stream for all builder decays. */
const rng = new Rng(0x5eed);

/** Fixed-step update, called by the engine while the builder is open and isotopes are loaded. */
export function stepBuilder(dt: number) {
  const s = useBuilder.getState();
  if (s.paused) return;
  const z = s.protons;
  const a = s.protons + s.neutrons;
  const gameDt = dt * s.timeScale;
  const out = stepDecay(z, a, s.electrons, gameDt, rng);
  if (!out) {
    useBuilder.setState({ age: s.age + gameDt });
    return;
  }
  const event: DecayEvent = { ...out, id: nextId++, fromZ: z, fromA: a, age: s.age + gameDt };
  useBuilder.setState({
    protons: out.z,
    neutrons: out.a - out.z,
    // A fission fragment can't keep the parent's whole cloud; the excess leaves with the other fragment.
    electrons: clamp(s.electrons + out.electronDelta, 0, out.z + (out.emitted.some((e) => e.kind === 'fragment') ? 0 : MAX_EXTRA_ELECTRONS)),
    age: 0,
    log: [event, ...s.log].slice(0, LOG_SIZE),
  });
}
