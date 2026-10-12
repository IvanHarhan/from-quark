import { create } from 'zustand';

/** Surface gravity, m/s² (NASA Planetary Fact Sheet; Earth = standard gravity). */
export const GRAVITY_PRESETS = {
  earth: 9.80665,
  moon: 1.62,
  mars: 3.71,
  jupiter: 24.79,
  zero: 0,
} as const;

export type GravityPreset = keyof typeof GRAVITY_PRESETS;

/** Heat processes can run faster than the mechanics (which is always real time). */
export const THERMAL_SPEEDS = [1, 10, 100, 1000] as const;

export type SpawnPlace = 'beaker' | 'tray' | 'press';

export interface SpawnRequest {
  id: number;
  substance: string;
  /** Cube edge, m */
  size: number;
  /** K */
  temperature: number;
  place: SpawnPlace;
}

export type BrushMode = 'heat' | 'cool' | null;

export interface PhaseStats {
  substance: string;
  solid: number;
  liquid: number;
  /** kg turned to vapour since the last reset */
  vapor: number;
}

export interface Inspect {
  substance: string;
  T: number;
  liquid: number;
  steam: boolean;
}

interface LabState {
  tilt: number;
  shaking: boolean;
  gravity: GravityPreset;
  paused: boolean;
  resetToken: number;
  particles: number;
  fluidSupported: boolean;
  /** Hotplate under the beaker: on/off and set point, °C. */
  plateOn: boolean;
  plateC: number;
  /** Press plate gap above the tray floor, m. */
  pressGap: number;
  roomC: number;
  /** Ambient pressure, atm. */
  pressureAtm: number;
  thermalSpeed: number;
  /** Game seconds elapsed for heat processes since the last reset. */
  elapsed: number;
  brush: BrushMode;
  spawnQueue: SpawnRequest[];
  stats: PhaseStats[];
  inspect: Inspect | null;
  setTilt(deg: number): void;
  setShaking(on: boolean): void;
  setGravity(g: GravityPreset): void;
  setPaused(p: boolean): void;
  setPlate(on: boolean, c?: number): void;
  setPressGap(m: number): void;
  setRoomC(c: number): void;
  setPressure(atm: number): void;
  setThermalSpeed(s: number): void;
  setBrush(b: BrushMode): void;
  spawn(r: Omit<SpawnRequest, 'id'>): void;
  reset(): void;
}

export const PRESS_GAP_MAX = 0.16;
let spawnId = 1;

export const useLab = create<LabState>((set, get) => ({
  tilt: 0,
  shaking: false,
  gravity: 'earth',
  paused: false,
  resetToken: 0,
  particles: 0,
  fluidSupported: true,
  plateOn: false,
  plateC: 20,
  pressGap: PRESS_GAP_MAX,
  roomC: 20,
  pressureAtm: 1,
  thermalSpeed: 100,
  elapsed: 0,
  brush: null,
  spawnQueue: [],
  stats: [],
  inspect: null,
  setTilt: (tilt) => set({ tilt }),
  setShaking: (shaking) => set({ shaking }),
  setGravity: (gravity) => set({ gravity }),
  setPaused: (paused) => set({ paused }),
  setPlate: (plateOn, c) => set({ plateOn, plateC: c ?? get().plateC }),
  setPressGap: (pressGap) => set({ pressGap }),
  setRoomC: (roomC) => set({ roomC }),
  setPressure: (pressureAtm) => set({ pressureAtm }),
  setThermalSpeed: (thermalSpeed) => set({ thermalSpeed }),
  setBrush: (brush) => set({ brush }),
  spawn: (r) => set({ spawnQueue: [...get().spawnQueue, { ...r, id: spawnId++ }] }),
  reset: () =>
    set({ resetToken: get().resetToken + 1, tilt: 0, shaking: false, pressGap: PRESS_GAP_MAX, plateOn: false, spawnQueue: [], elapsed: 0 }),
}));
