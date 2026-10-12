import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { isotopesOf, loadIsotopes } from '../data/db';
import { ZoomView } from '../render/micro/zoomView';
import { inspectedSpec, useZoom } from './zoomState';
import { buildLab } from '../render/macro/lab';
import { AtomView } from '../render/micro/atomView';
import { MoleculeView } from '../render/micro/moleculeView';
import { structureOf, useMolecule } from './moleculeBuilder';
import { stepBuilder, useBuilder } from './builder';
import { useApp } from '../ui/store';
import { CameraRig, FOCUS_MIN_DISTANCE } from './cameraRig';
import { LabSim } from './labSim';
import { FixedLoop } from './loop';
import { QUALITY } from './quality';

/** Neither WebGPU nor WebGL2 could be initialised (as opposed to a bug in our own startup code). */
export class RendererUnavailableError extends Error {}

export interface Engine {
  rig: CameraRig;
  dispose(): void;
}

export async function startEngine(canvas: HTMLCanvasElement): Promise<Engine> {
  // WebGPURenderer falls back to its WebGL2 backend by itself when navigator.gpu is missing.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  try {
    await renderer.init();
  } catch (err) {
    throw new RendererUnavailableError(String(err));
  }
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  if (import.meta.env.DEV && backend === 'webgpu') reportShaderErrors(renderer);
  useApp.setState({ backend });

  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe2e4);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;

  const lab = buildLab();
  scene.add(lab.root);
  const labSim = new LabSim(scene, renderer, backend === 'webgpu');
  if (import.meta.env.DEV) Object.assign(window, { __fqLab: labSim, __fqRenderer: renderer });
  const zoomDev = () => import.meta.env.DEV && Object.assign(window, { __fqZoom: zoom });
  let mpmDx = 0;
  let pointer: THREE.Vector2 | null = null;
  const centre = new THREE.Vector2(0, 0);
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    pointer = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  });
  canvas.addEventListener('pointerleave', () => (pointer = null));
  // A click (not a drag) on matter in the lab picks it: the camera glides to it and the wheel closes in.
  let downAt = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || useApp.getState().view !== 'lab' || rig.mode !== 'orbit') return;
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    const spec = inspectedSpec();
    const p = labSim.brushPoint;
    useZoom.getState().select(spec && p ? { spec, point: [p.x, p.y, p.z] } : null);
  });
  // Wheel in at the closest orbit distance: the lab view hands over to the zoom view at the same field of view.
  canvas.addEventListener('wheel', (e) => {
    const sel = useZoom.getState().selection;
    if (e.deltaY >= 0 || !sel || useApp.getState().view !== 'lab' || rig.distance() > FOCUS_MIN_DISTANCE * 1.15) return;
    useZoom.getState().open(sel.spec, 2 * rig.distance() * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    useApp.getState().setView('zoom');
  });
  const marker = document.createElement('div');
  marker.className = 'pick-marker';
  canvas.parentElement?.insertBefore(marker, canvas.nextSibling);
  const markerAt = new THREE.Vector3();

  const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 50);
  const rig = new CameraRig(camera, canvas, {
    onMode: (cameraMode) => useApp.setState({ cameraMode }),
    onLock: (pointerLocked) => useApp.setState({ pointerLocked }),
  });

  const atom = new AtomView(canvas);
  const syncAtom = () => {
    const b = useBuilder.getState();
    atom.sync(b.protons, b.neutrons, b.electrons);
  };
  syncAtom();
  const unsubBuilder = useBuilder.subscribe((b, prev) => {
    syncAtom();
    const ev = b.log[0];
    if (ev && ev.id !== prev.log[0]?.id) atom.onDecay(ev.emitted, ev.electronDelta < 0);
  });

  const mol = new MoleculeView(canvas, {
    onPick: (i) => useMolecule.getState().clickAtom(i),
    onHover: (i) => useMolecule.getState().setHovered(i),
  });
  const syncMol = () => {
    const s = useMolecule.getState();
    mol.sync(s.molecule, structureOf(s.molecule).positions, s.selected, s.hovered);
  };
  syncMol();
  const unsubMol = useMolecule.subscribe(syncMol);

  const zoom = new ZoomView(canvas, {
    onExit: () => useApp.getState().setView('lab'),
    mode: () => useZoom.getState().mode,
    lang: () => useApp.getState().lang,
  });
  zoomDev();
  const mostAbundant = (z: number) => {
    const isos = isotopesOf(z);
    const natural = isos.filter((i) => i.abundance !== null).sort((a, b) => b.abundance! - a.abundance!);
    return (natural[0] ?? [...isos].sort((a, b) => (b.halfLife ?? 0) - (a.halfLife ?? 0))[0])?.a ?? 2 * z;
  };
  const unsubZoom = useZoom.subscribe((z, prev) => {
    if (z.token !== prev.token && z.spec) {
      const { spec, startWidth } = z;
      loadIsotopes().then(() => zoom.open(spec, mostAbundant, startWidth ?? undefined));
    }
    if (z.selection !== prev.selection) {
      const p = z.selection?.point;
      rig.focus(p ? new THREE.Vector3(...p) : null);
    }
    if (z.jump && z.jump !== prev.jump) {
      zoom.jumpTo(z.jump);
      useZoom.setState({ jump: null });
    }
  });
  let zoomInfoAt = 0;

  const applyView = () => {
    const { view } = useApp.getState();
    rig.setEnabled(view === 'lab');
    atom.setActive(view === 'atom');
    mol.setActive(view === 'molecule');
    zoom.setActive(view === 'zoom');
    if (view === 'atom') loadIsotopes().then(() => useApp.setState({ isotopesReady: true }));
  };
  applyView();

  const applyQuality = () => {
    const q = QUALITY[useApp.getState().quality];
    if (q.mpmDx !== mpmDx) {
      mpmDx = q.mpmDx;
      labSim.configure(q.mpmDx, q.mpmParticles);
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.maxPixelRatio));
    lab.sun.castShadow = q.shadows;
    if (lab.sun.shadow.mapSize.x !== q.shadowMapSize) {
      lab.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      lab.sun.shadow.map?.dispose();
      lab.sun.shadow.map = null;
    }
    resize();
  };
  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    atom.resize(camera.aspect);
    mol.resize(camera.aspect);
    zoom.resize(camera.aspect);
  };
  window.addEventListener('resize', resize);
  const unsubApp = useApp.subscribe((s, prev) => {
    if (s.quality !== prev.quality) applyQuality();
    if (s.view !== prev.view) applyView();
  });
  applyQuality();

  let frames = 0;
  let fpsTime = 0;
  const loop = new FixedLoop({
    step(dt) {
      const app = useApp.getState();
      if (app.view === 'atom' && app.isotopesReady) stepBuilder(dt);
      if (app.view === 'lab') labSim.step(renderer, dt);
    },
    frame(realDt) {
      const view = useApp.getState().view;
      if (view === 'atom') {
        atom.update(realDt, useBuilder.getState().timeScale);
        renderer.render(atom.scene, atom.camera);
      } else if (view === 'molecule') {
        mol.update(realDt);
        renderer.render(mol.scene, mol.camera);
      } else if (view === 'zoom') {
        zoom.update(realDt);
        zoom.render(renderer);
        zoomInfoAt += realDt;
        if (zoomInfoAt > 0.2) {
          zoomInfoAt = 0;
          useZoom.getState().setInfo(zoom.info());
        }
      } else {
        rig.update(realDt);
        // In first person the cursor is the crosshair.
        const ndc = rig.mode === 'fps' ? (rig.fps.isLocked ? centre : null) : pointer;
        labSim.pointer(ndc, camera, [...labSim.benchTargets(), lab.root]);
        labSim.frame();
        labSim.render(camera);
      }
      const sel = useZoom.getState().selection;
      let markerShown = false;
      if (sel && view === 'lab') {
        markerAt.set(...sel.point).project(camera);
        if (markerAt.z < 1 && Math.abs(markerAt.x) < 1 && Math.abs(markerAt.y) < 1) {
          markerShown = true;
          marker.style.transform = `translate(${(((markerAt.x + 1) / 2) * canvas.clientWidth).toFixed(1)}px, ${(((1 - markerAt.y) / 2) * canvas.clientHeight).toFixed(1)}px)`;
        }
      }
      marker.style.display = markerShown ? '' : 'none';
      frames++;
      fpsTime += realDt;
      if (fpsTime >= 0.5) {
        useApp.setState({ fps: Math.round(frames / fpsTime) });
        frames = 0;
        fpsTime = 0;
      }
    },
  });
  renderer.setAnimationLoop((t) => loop.tick(t));
  // Dev-only: advance frames by hand (rAF stops while the window is hidden).
  if (import.meta.env.DEV) {
    let fakeNow = performance.now();
    Object.assign(window, {
      __fqFrames: (n: number, ms = 1000 / 60) => {
        // Never behind real rAF time, or the loop would see a negative frame time and skip steps.
        fakeNow = Math.max(fakeNow, performance.now());
        for (let i = 0; i < n; i++) loop.tick((fakeNow += ms));
      },
    });
  }

  return {
    rig,
    dispose() {
      renderer.setAnimationLoop(null);
      window.removeEventListener('resize', resize);
      unsubApp();
      unsubBuilder();
      unsubMol();
      unsubZoom();
      renderer.dispose();
    },
  };
}

/** Dev only: print WGSL compile errors with the offending lines (three only reports "invalid pipeline"). */
function reportShaderErrors(renderer: THREE.WebGPURenderer) {
  const device = (renderer.backend as unknown as { device: GPUDevice }).device;
  const create = device.createShaderModule.bind(device);
  const seen = (window as unknown as { __fqShaderErrors: string[] }).__fqShaderErrors = [] as string[];
  const sources = ((window as unknown as { __fqWgsl: string[] }).__fqWgsl = [] as string[]);
  device.createShaderModule = (desc) => {
    sources.push(desc.code);
    const mod = create(desc);
    mod.getCompilationInfo().then((info) => {
      for (const m of info.messages) {
        if (m.type !== 'error') continue;
        const lines = desc.code.split('\n');
        const around = lines.slice(Math.max(0, m.lineNum - 4), m.lineNum + 2).join('\n');
        const text = `WGSL ${m.lineNum}:${m.linePos} ${m.message}\n${around}`;
        seen.push(text);
        console.error(text);
      }
    });
    return mod;
  };
  const createPipeline = device.createComputePipeline.bind(device);
  device.createComputePipeline = (desc) => {
    device.pushErrorScope('validation');
    const p = createPipeline(desc);
    device.popErrorScope().then((err) => {
      if (!err) return;
      const text = `Pipeline: ${err.message}`;
      seen.push(text);
      console.error(text);
    });
    return p;
  };
  const createPipelineAsync = device.createComputePipelineAsync.bind(device);
  device.createComputePipelineAsync = (desc) =>
    createPipelineAsync(desc).catch((err: Error) => {
      const text = `Pipeline (async): ${err.message}`;
      seen.push(text);
      console.error(text);
      throw err;
    });
}
