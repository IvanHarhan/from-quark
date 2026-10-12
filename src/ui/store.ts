import { create } from 'zustand';
import type { Lang } from '../i18n';
import type { QualityLevel } from '../game/quality';

export type CameraMode = 'orbit' | 'fps';
export type View = 'lab' | 'atom' | 'molecule' | 'zoom';
export type Backend = 'webgpu' | 'webgl2' | null;

interface AppState {
  lang: Lang;
  quality: QualityLevel;
  view: View;
  /** NUBASE table is loaded (needed by the atom builder). */
  isotopesReady: boolean;
  inventoryOpen: boolean;
  cameraMode: CameraMode;
  pointerLocked: boolean;
  backend: Backend;
  rendererError: boolean;
  /** Startup failure message (a bug, not missing GPU support). */
  crash: string | null;
  fps: number;
  tableOpen: boolean;
  selectedZ: number | null;
  setLang(lang: Lang): void;
  setQuality(q: QualityLevel): void;
  setTableOpen(open: boolean): void;
  setView(view: View): void;
  setInventoryOpen(open: boolean): void;
  selectElement(z: number | null): void;
}

const PREFS_KEY = 'fromquark.prefs';

function loadPrefs(): Partial<Pick<AppState, 'lang' | 'quality'>> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function savePrefs(s: Pick<AppState, 'lang' | 'quality'>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ lang: s.lang, quality: s.quality }));
  } catch {
    // storage unavailable (private mode) — prefs just won't persist
  }
}

const prefs = loadPrefs();

export const useApp = create<AppState>((set, get) => ({
  lang: prefs.lang ?? 'en',
  quality: prefs.quality ?? 'high',
  view: 'lab',
  isotopesReady: false,
  inventoryOpen: false,
  cameraMode: 'orbit',
  pointerLocked: false,
  backend: null,
  rendererError: false,
  crash: null,
  fps: 0,
  tableOpen: false,
  selectedZ: null,
  setLang(lang) {
    set({ lang });
    savePrefs(get());
  },
  setQuality(quality) {
    set({ quality });
    savePrefs(get());
  },
  setTableOpen(tableOpen) {
    set({ tableOpen });
  },
  setView(view) {
    set({ view });
  },
  setInventoryOpen(inventoryOpen) {
    set({ inventoryOpen });
  },
  selectElement(selectedZ) {
    set({ selectedZ });
  },
}));
