import { createRoot } from 'react-dom/client';
import { useBuilder, type Particle } from './game/builder';
import { useLab } from './game/labState';
import { inspectedSpec, useZoom } from './game/zoomState';
import { useMolecule } from './game/moleculeBuilder';
import { RendererUnavailableError, startEngine, type Engine } from './game/engine';
import { App } from './ui/App';
import { useApp } from './ui/store';
import './ui/styles.css';

createRoot(document.getElementById('ui')!).render(<App />);

// Dev-only handle for driving the app from the console / automated checks.
if (import.meta.env.DEV) Object.assign(window, { __fq: { useApp, useBuilder, useMolecule, useLab, useZoom } });

let engine: Engine | null = null;
startEngine(document.getElementById('scene') as HTMLCanvasElement)
  .then((e) => {
    engine = e;
    if (import.meta.env.DEV) Object.assign(window, { __fqEngine: e });
  })
  .catch((err) => {
    console.error(err);
    useApp.setState(err instanceof RendererUnavailableError ? { rendererError: true } : { crash: String(err) });
  });

// Heat brush: hold H (torch) or J (liquid nitrogen) and point at the bench.
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyH' || e.code === 'KeyJ') useLab.getState().setBrush(null);
});
window.addEventListener('blur', () => useLab.getState().setBrush(null));

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (e.repeat || target.closest('input, select, textarea')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const app = useApp.getState();
  const builderKey: Record<string, Particle> = { KeyP: 'p', KeyN: 'n', KeyE: 'e' };
  if (app.view === 'atom' && e.code in builderKey) {
    useBuilder.getState().add(builderKey[e.code], e.shiftKey ? -1 : 1);
    return;
  }
  switch (e.code) {
    case 'KeyH':
    case 'KeyJ':
      if (app.view === 'lab') useLab.getState().setBrush(e.code === 'KeyH' ? 'heat' : 'cool');
      break;
    case 'KeyZ': {
      // Straight in from the lab, starting at the material's look under a microscope.
      const spec = app.view === 'lab' ? (inspectedSpec() ?? useZoom.getState().selection?.spec) : null;
      if (spec) {
        useZoom.getState().open(spec, 2e-2);
        app.setView('zoom');
      }
      break;
    }
    case 'KeyC':
      if (app.view === 'lab') engine?.rig.toggle();
      break;
    case 'KeyB':
      app.setView(app.view === 'atom' ? 'lab' : 'atom');
      break;
    case 'KeyM':
      app.setView(app.view === 'molecule' ? 'lab' : 'molecule');
      break;
    case 'Delete':
    case 'Backspace':
      if (app.view === 'molecule') useMolecule.getState().removeSelected();
      break;
    case 'KeyI':
      app.setInventoryOpen(!app.inventoryOpen);
      break;
    case 'KeyT':
      app.setTableOpen(!app.tableOpen);
      break;
    case 'Escape':
      if (app.view === 'zoom') app.setView('lab');
      else if (app.view === 'lab' && useZoom.getState().selection) useZoom.getState().select(null);
      else if (app.selectedZ !== null) app.selectElement(null);
      else if (app.tableOpen) app.setTableOpen(false);
      else if (app.inventoryOpen) app.setInventoryOpen(false);
      break;
  }
});

// Panels need the mouse back.
useApp.subscribe((s, prev) => {
  const opened =
    (s.tableOpen && !prev.tableOpen) || (s.inventoryOpen && !prev.inventoryOpen) || (s.selectedZ !== null && prev.selectedZ === null);
  if (opened) engine?.rig.releasePointer();
});
