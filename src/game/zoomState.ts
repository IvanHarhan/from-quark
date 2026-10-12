import { create } from 'zustand';
import { substance } from '../data/substances';
import { ATM } from '../sim/thermo';
import { useLab } from './labState';
import type { CellSpec } from '../sim/micro/cell';
import type { ZoomInfo, ZoomLevel, ZoomMode } from '../render/micro/zoomView';

interface ZoomState {
  /** What the player zoomed into (substance, phase, T, P at the clicked point). */
  spec: CellSpec | null;
  /** Field of view (m) the zoom starts at: the lab camera's view when flying in. */
  startWidth: number | null;
  /** Bumped on every new zoom so the view rebuilds even for an identical spec. */
  token: number;
  info: ZoomInfo | null;
  /** Level the UI asked to jump to (consumed by the engine). */
  jump: ZoomLevel | null;
  /** Matter picked in the lab: the wheel flies into it. */
  selection: { spec: CellSpec; point: [number, number, number] } | null;
  mode: ZoomMode;
  open(spec: CellSpec, startWidth?: number): void;
  setInfo(info: ZoomInfo): void;
  requestJump(level: ZoomLevel | null): void;
  select(selection: ZoomState['selection']): void;
  setMode(mode: ZoomMode): void;
}

/** The cell spec of whatever is under the cursor in the lab, or null. */
export function inspectedSpec(): CellSpec | null {
  const lab = useLab.getState();
  const ins = lab.inspect;
  if (!ins) return null;
  return {
    substance: substance(ins.substance),
    phase: ins.steam ? 'gas' : ins.liquid > 0.5 ? 'liquid' : 'solid',
    temperature: ins.T,
    pressure: lab.pressureAtm * ATM,
  };
}

export const useZoom = create<ZoomState>((set, get) => ({
  spec: null,
  startWidth: null,
  token: 0,
  info: null,
  jump: null,
  selection: null,
  mode: 'textbook',
  open: (spec, startWidth) => set({ spec, startWidth: startWidth ?? null, token: get().token + 1, info: null }),
  setInfo: (info) => set({ info }),
  requestJump: (jump) => set({ jump }),
  select: (selection) => set({ selection }),
  setMode: (mode) => set({ mode }),
}));
