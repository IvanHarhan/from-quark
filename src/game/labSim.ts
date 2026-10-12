import * as THREE from 'three/webgpu';
import { SUBSTANCES } from '../data/substances';
import { createFluidSprites } from '../render/macro/fluidRender';
import { FluidSurface } from '../render/macro/fluidSurface';
import { TABLE } from '../render/macro/lab';
import { makeDomain, seedCube, seedVesselLiquid, type Domain } from '../sim/mpm/domain';
import { MpmSolver, STATE, type Press } from '../sim/mpm/gpuSolver';
import { PARTICLES_PER_CELL_AXIS, substepsFor } from '../sim/mpm/units';
import { ATM } from '../sim/thermo';
import { BEAKER_1L, createVessel, stepVessel, type Tray, type VesselState } from '../sim/vessel';
import { GRAVITY_PRESETS, PRESS_GAP_MAX, useLab, type PhaseStats, type SpawnRequest } from './labState';

const C0 = 273.15;
/** Hotplate under the beaker. */
const PLATE = { size: 0.16, height: 0.022 };
/** Where the beaker stands; the MPM box extends towards +x over the tray. */
const HOME = { x: -0.36, z: 0.1 };
const FILL = 0.09; // m of water ≈ 0.7 L
const TRAY_WALL = 0.012;

/** Refractory bath next to the beaker: catches what is poured, holds molten metal, anvil for the press. */
export const TRAY: Tray = {
  minX: -0.27,
  maxX: 0.17,
  minZ: -0.08,
  maxZ: 0.28,
  floorY: TABLE.top + TRAY_WALL,
  rim: 0.06,
  wall: TRAY_WALL,
};

/** Press plate over the right end of the tray. */
const PRESS = { x: 0.08, z: 0.1, half: 0.055, thick: 0.012, speed: 0.03 };
/** Torch flame (oxy-acetylene, ~3300 K) and liquid nitrogen (77 K) for the heat brush. */
export const BRUSH = { radius: 0.03, heat: 3300, cool: 77 };

/**
 * Owns the bench simulation: kinematic beaker, hotplate, tray, press, the MPM solver and their meshes.
 * Rebuilt when the quality preset changes the grid resolution.
 */
export class LabSim {
  readonly vessel: VesselState;
  readonly beakerMesh: THREE.Group;
  private plateTop: THREE.Mesh;
  private pressPlate: THREE.Mesh;
  private pressRod: THREE.Mesh;
  private brushMarker: THREE.Mesh;
  private targets: THREE.Object3D[];
  private solver: MpmSolver | null = null;
  private sprites: THREE.Sprite | null = null;
  private surface: FluidSurface | null = null;
  private domain: Domain | null = null;
  private resetToken = -1;
  private pressY: number;
  private pressVy = 0;
  private elapsed = 0;
  private readback: { pos: Float32Array; info: Float32Array; at: number; busy: boolean } = {
    pos: new Float32Array(0),
    info: new Float32Array(0),
    at: 0,
    busy: false,
  };
  private ray = new THREE.Raycaster();
  /** Brush centre in world metres when the cursor is over matter or the bench. */
  brushPoint: THREE.Vector3 | null = null;

  constructor(
    private scene: THREE.Scene,
    private renderer: THREE.WebGPURenderer,
    private webgpu: boolean,
  ) {
    this.vessel = createVessel(BEAKER_1L, HOME.x, TABLE.top + PLATE.height, HOME.z);
    this.beakerMesh = beakerMesh(BEAKER_1L);
    const plate = hotplateMesh();
    this.plateTop = plate.top;
    plate.group.position.set(HOME.x, TABLE.top, HOME.z);
    const press = pressMesh();
    this.pressPlate = press.plate;
    this.pressRod = press.rod;
    this.pressY = TRAY.floorY + PRESS_GAP_MAX;
    this.brushMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    this.brushMarker.scale.setScalar(BRUSH.radius);
    this.brushMarker.visible = false;
    const tray = trayMesh(TRAY);
    this.targets = [this.beakerMesh, tray, plate.group, press.group];
    scene.add(this.beakerMesh, tray, plate.group, press.group, this.brushMarker);
    useLab.setState({ fluidSupported: webgpu });
    if (!webgpu) this.beakerMesh.add(staticWater());
  }

  /** (Re)creates the solver at a new resolution and refills the beaker. */
  configure(dx: number, capacity: number) {
    if (!this.webgpu) return;
    this.domain = makeDomain(
      [HOME.x - 0.16, TABLE.top - 0.01, TRAY.minZ - TRAY.wall - 0.03],
      [TRAY.maxX + TRAY.wall + 0.03, TABLE.top + 0.36, TRAY.maxZ + TRAY.wall + 0.03],
      dx,
    );
    this.solver = new MpmSolver(this.domain, capacity);
    this.solver.setTray(TRAY);
    this.resetToken = -1;
  }

  private refill() {
    if (!this.solver || !this.domain) return;
    const v = this.vessel;
    v.targetTilt = 0;
    v.shaking = false;
    v.shakeAmp = 0;
    v.shakeTime = 0;
    v.pose = { ...v.home, tilt: 0 };
    v.vel = { x: 0, y: 0, z: 0, w: 0 };
    this.pressY = TRAY.floorY + PRESS_GAP_MAX;
    const lab = useLab.getState();
    this.solver.setPressure(lab.pressureAtm * ATM);
    this.solver.setParticles(seedVesselLiquid(this.domain, v.shape, v.pose, FILL, 12345), 'water', lab.roomC + C0);
    this.solver.setEnvironment(GRAVITY_PRESETS[lab.gravity], TABLE.top, v);
    if (this.sprites) this.scene.remove(this.sprites);
    // Matter is drawn as a smooth surface (FluidSurface); only steam stays as sprites.
    this.sprites = createFluidSprites(this.solver, true);
    this.scene.add(this.sprites);
    this.surface?.dispose();
    this.surface = new FluidSurface(this.renderer, this.solver, this.scene.environment);
    this.surface.setCount(this.solver.count);
    this.readback.pos = new Float32Array(0);
    this.elapsed = 0;
    useLab.setState({ particles: this.solver.count, stats: [], inspect: null });
  }

  private spawn(r: SpawnRequest) {
    if (!this.solver || !this.domain) return;
    let x: number;
    let y: number;
    let z: number;
    if (r.place === 'beaker') {
      const p = this.vessel.pose;
      x = p.x;
      z = p.z;
      y = p.y + this.vessel.shape.height - r.size - 0.005;
    } else if (r.place === 'press') {
      x = PRESS.x;
      z = PRESS.z;
      y = TRAY.floorY + 0.002;
    } else {
      x = (TRAY.minX + PRESS.x - PRESS.half) / 2;
      z = (TRAY.minZ + TRAY.maxZ) / 2;
      y = TRAY.floorY + 0.03;
    }
    const size = r.place === 'beaker' ? Math.min(r.size, this.vessel.shape.innerRadius * 1.3) : r.size;
    const pts = seedCube(this.domain, x, y, z, size, r.id * 7919);
    this.solver.append(pts, r.substance, r.temperature);
    if (this.sprites) this.sprites.count = this.solver.count;
    this.surface?.setCount(this.solver.count);
    useLab.setState({ particles: this.solver.count });
  }

  /** One fixed simulation step. */
  step(renderer: THREE.WebGPURenderer, dt: number) {
    const lab = useLab.getState();
    if (lab.resetToken !== this.resetToken && this.solver) {
      this.resetToken = lab.resetToken;
      this.refill();
    }
    if (lab.spawnQueue.length) {
      for (const r of lab.spawnQueue) this.spawn(r);
      useLab.setState({ spawnQueue: [] });
    }
    if (lab.paused) return;
    const v = this.vessel;
    v.targetTilt = (lab.tilt * Math.PI) / 180;
    v.shaking = lab.shaking;

    // Press plate follows its target gap at a hydraulic ram speed.
    const target = TRAY.floorY + Math.max(0.004, Math.min(PRESS_GAP_MAX, lab.pressGap));
    const dy = Math.max(-PRESS.speed * dt, Math.min(PRESS.speed * dt, target - this.pressY));
    this.pressVy = dy / dt;
    this.pressY += dy;

    if (!this.solver || !this.domain) {
      stepVessel(v, dt);
      return;
    }
    const s = this.solver;
    s.setPressure(lab.pressureAtm * ATM);
    s.setEnvironment(GRAVITY_PRESETS[lab.gravity], TABLE.top, v);
    s.setPress(this.press());
    // The glass must move continuously through the substeps; a pose that jumps once per step
    // slams the liquid and throws it out of the beaker.
    const n = substepsFor(dt, this.domain.dx);
    for (let i = 0; i < n; i++) {
      stepVessel(v, dt / n);
      s.setVesselPose(v);
      s.step(renderer, dt / n, 1);
    }
    // Clock shown in the UI; updated a few times a second to keep React quiet.
    this.elapsed += dt * lab.thermalSpeed;
    if (Math.abs(this.elapsed - lab.elapsed) > lab.thermalSpeed * 0.25 || this.elapsed < lab.elapsed) {
      useLab.setState({ elapsed: this.elapsed });
    }
    s.thermalStep(renderer, dt * lab.thermalSpeed, {
      ambient: lab.roomC + C0,
      plate: lab.plateOn ? lab.plateC + C0 : null,
      brush:
        lab.brush && this.brushPoint
          ? {
              x: this.brushPoint.x,
              y: this.brushPoint.y,
              z: this.brushPoint.z,
              radius: BRUSH.radius,
              target: lab.brush === 'heat' ? BRUSH.heat : BRUSH.cool,
            }
          : null,
    });
    this.pollReadback(renderer);
  }

  private press(): Press {
    return { center: [PRESS.x, this.pressY + PRESS.thick / 2, PRESS.z], half: [PRESS.half, PRESS.thick / 2, PRESS.half], vy: this.pressVy };
  }

  /** Reads particle state back a few times a second for the inspector, picking and phase totals. */
  private pollReadback(renderer: THREE.WebGPURenderer) {
    const rb = this.readback;
    const now = performance.now();
    if (!this.solver || rb.busy || now - rb.at < 300) return;
    rb.busy = true;
    rb.at = now;
    const s = this.solver;
    Promise.all([renderer.getArrayBufferAsync(s.pos.value), renderer.getArrayBufferAsync(s.info.value)])
      .then(([p, i]) => {
        if (s !== this.solver) return;
        rb.pos = new Float32Array(p);
        rb.info = new Float32Array(i);
        this.updateStats();
      })
      .finally(() => (rb.busy = false));
  }

  private updateStats() {
    if (!this.solver || !this.domain) return;
    const s = this.solver;
    const spacing = this.domain.dx / PARTICLES_PER_CELL_AXIS;
    const stats = new Map<string, PhaseStats>();
    for (let i = 0; i < s.count; i++) {
      const sub = SUBSTANCES[this.readback.info[i * 4 + 3]];
      if (!sub) continue;
      const mass = sub.rhoLiquid * spacing ** 3;
      const st = stats.get(sub.id) ?? { substance: sub.id, solid: 0, liquid: 0, vapor: 0 };
      const state = this.readback.info[i * 4 + 2];
      if (state === STATE.matter) {
        const liq = this.readback.info[i * 4 + 1];
        st.liquid += mass * liq;
        st.solid += mass * (1 - liq);
      } else st.vapor += mass;
      stats.set(sub.id, st);
    }
    useLab.setState({ stats: [...stats.values()] });
  }

  /**
   * Cursor ray: finds the first particle near the ray (from the last readback) or the bench surface.
   * Sets the brush point and the hover inspector.
   */
  pointer(ndc: THREE.Vector2 | null, camera: THREE.Camera, benchMeshes: THREE.Object3D[]) {
    if (!ndc || !this.domain || !this.solver) {
      this.brushPoint = null;
      useLab.setState({ inspect: null });
      return;
    }
    this.ray.setFromCamera(ndc, camera);
    const o = this.ray.ray.origin;
    const dir = this.ray.ray.direction;
    const d = this.domain;
    const pos = this.readback.pos;
    const info = this.readback.info;
    const reach = d.dx * 0.6;
    let best = -1;
    let bestT = Infinity;
    for (let i = 0; i < this.solver.count && i * 4 < pos.length; i++) {
      if (info[i * 4 + 2] === STATE.dead) continue;
      const x = d.origin[0] + pos[i * 4] * d.dx - o.x;
      const y = d.origin[1] + pos[i * 4 + 1] * d.dx - o.y;
      const z = d.origin[2] + pos[i * 4 + 2] * d.dx - o.z;
      const t = x * dir.x + y * dir.y + z * dir.z;
      if (t <= 0 || t >= bestT) continue;
      const px = x - dir.x * t;
      const py = y - dir.y * t;
      const pz = z - dir.z * t;
      if (px * px + py * py + pz * pz < reach * reach) {
        best = i;
        bestT = t;
      }
    }
    const hit = this.ray.intersectObjects(benchMeshes, true)[0];
    if (best >= 0 && (!hit || bestT < hit.distance)) {
      this.brushPoint = o.clone().addScaledVector(dir, bestT);
      const sub = SUBSTANCES[info[best * 4 + 3]];
      useLab.setState({
        inspect: { substance: sub.id, T: info[best * 4], liquid: info[best * 4 + 1], steam: info[best * 4 + 2] === STATE.steam },
      });
    } else {
      this.brushPoint = hit ? hit.point.clone() : null;
      useLab.setState({ inspect: null });
    }
  }

  /** Draws the lab: through the fluid surface renderer when there is a simulation, plainly otherwise. */
  render(camera: THREE.PerspectiveCamera) {
    if (this.surface) this.surface.render(this.scene, camera);
    else this.renderer.render(this.scene, camera);
  }

  /** Per-frame visual sync. */
  frame() {
    const p = this.vessel.pose;
    this.beakerMesh.position.set(p.x, p.y, p.z);
    this.beakerMesh.rotation.z = -p.tilt;
    const lab = useLab.getState();
    this.pressPlate.position.y = this.pressY + PRESS.thick / 2;
    const rodTop = TRAY.floorY + PRESS_GAP_MAX + 0.09;
    this.pressRod.scale.y = rodTop - this.pressY;
    this.pressRod.position.y = (rodTop + this.pressY) / 2;
    // Hotplate surface: blackbody-ish tint when hot, frosty blue when cold.
    const plateMat = this.plateTop.material as THREE.MeshStandardMaterial;
    const t = lab.plateOn ? lab.plateC : lab.roomC;
    plateMat.emissive.setRGB(Math.max(0, (t - 250) / 300), Math.max(0, (t - 330) / 600), 0);
    plateMat.color.set(t < -5 ? 0xbfe3ff : 0x2a2d31);
    this.brushMarker.visible = !!(lab.brush && this.brushPoint);
    if (this.brushPoint) this.brushMarker.position.copy(this.brushPoint);
    (this.brushMarker.material as THREE.MeshBasicMaterial).color.set(lab.brush === 'cool' ? 0x7fd0ff : 0xff8a3d);
  }

  /** Meshes the cursor can land on when nothing is under it (for the brush). */
  benchTargets(): THREE.Object3D[] {
    return this.targets;
  }
}

const glass = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  roughness: 0.03,
  transmission: 1,
  thickness: 0.003,
  ior: 1.5,
  transparent: true,
  opacity: 0.35,
  side: THREE.DoubleSide,
  depthWrite: false,
});

function beakerMesh(s: typeof BEAKER_1L): THREE.Group {
  const g = new THREE.Group();
  const R = s.innerRadius + s.wall;
  const outer = [
    [0, 0], [R, 0], [R, s.height], [R + 0.004, s.height + 0.003],
    [s.innerRadius, s.height], [s.innerRadius, s.bottom], [0, s.bottom],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(outer, 64), glass);
  mesh.renderOrder = 1;
  g.add(mesh);
  const markMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
  for (let ml = 100; ml <= 1000; ml += 100) {
    const h = s.bottom + (ml * 1e-6) / (Math.PI * s.innerRadius ** 2);
    if (h > s.height - 0.005) break;
    const w = ml % 500 === 0 ? 0.018 : 0.01;
    const mark = new THREE.Mesh(new THREE.BoxGeometry(w, 0.0008, 0.0008), markMat);
    mark.position.set(0, h, R + 0.0003);
    g.add(mark);
  }
  return g;
}

function hotplateMesh(): { group: THREE.Group; top: THREE.Mesh } {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(PLATE.size, PLATE.height - 0.004, PLATE.size),
    new THREE.MeshStandardMaterial({ color: 0xe8e9ea, roughness: 0.5 }),
  );
  body.position.y = (PLATE.height - 0.004) / 2;
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(PLATE.size * 0.45, PLATE.size * 0.45, 0.004, 48),
    new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.4, emissive: 0x000000 }),
  );
  top.position.y = PLATE.height - 0.002;
  const knob = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, 0.01, 16),
    new THREE.MeshStandardMaterial({ color: 0x333333 }),
  );
  knob.rotation.x = Math.PI / 2;
  knob.position.set(0.04, 0.01, PLATE.size / 2 + 0.005);
  for (const m of [body, top, knob]) {
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  }
  return { group: g, top };
}

function pressMesh(): { group: THREE.Group; plate: THREE.Mesh; rod: THREE.Mesh } {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x4a4e54, metalness: 0.9, roughness: 0.45 });
  const bright = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 1, roughness: 0.3 });
  const top = TRAY.floorY + PRESS_GAP_MAX + 0.12;
  // Two columns outside the tray (in z), a crossbeam and the hydraulic cylinder.
  for (const z of [TRAY.minZ - TRAY.wall - 0.02, TRAY.maxZ + TRAY.wall + 0.02]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, top - TABLE.top, 16), bright);
    col.position.set(PRESS.x, (top + TABLE.top) / 2, z);
    g.add(col);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.04, TRAY.maxZ - TRAY.minZ + 2 * TRAY.wall + 0.07), steel);
  beam.position.set(PRESS.x, top, PRESS.z);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 24), steel);
  cyl.position.set(PRESS.x, top - 0.045, PRESS.z);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 16), bright);
  rod.position.set(PRESS.x, 0, PRESS.z);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(PRESS.half * 2, PRESS.thick, PRESS.half * 2), steel);
  plate.position.set(PRESS.x, 0, PRESS.z);
  for (const m of [beam, cyl, rod, plate]) g.add(m);
  g.traverse((m) => {
    if (m instanceof THREE.Mesh) m.castShadow = m.receiveShadow = true;
  });
  return { group: g, plate, rod };
}

function trayMesh(t: Tray): THREE.Group {
  const g = new THREE.Group();
  // Refractory ceramic (fireclay-like colour).
  const mat = new THREE.MeshStandardMaterial({ color: 0xd8cbb4, roughness: 0.85 });
  const w = t.wall;
  const cx = (t.minX + t.maxX) / 2;
  const cz = (t.minZ + t.maxZ) / 2;
  const sx = t.maxX - t.minX + 2 * w;
  const sz = t.maxZ - t.minZ + 2 * w;
  const box = (x: number, y: number, z: number, a: number, b: number, c: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(a, b, c), mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  };
  const y0 = t.floorY - w;
  box(cx, y0 + w / 2, cz, sx, w, sz);
  const h = t.rim + w;
  box(t.minX - w / 2, y0 + h / 2, cz, w, h, sz);
  box(t.maxX + w / 2, y0 + h / 2, cz, w, h, sz);
  box(cx, y0 + h / 2, t.minZ - w / 2, sx - 2 * w, h, w);
  box(cx, y0 + h / 2, t.maxZ + w / 2, sx - 2 * w, h, w);
  g.name = 'tray';
  return g;
}

/** WebGL2 fallback: a still water column instead of the simulation. */
function staticWater(): THREE.Mesh {
  const s = BEAKER_1L;
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(s.innerRadius - 0.001, s.innerRadius - 0.001, FILL, 48),
    new THREE.MeshPhysicalMaterial({ color: 0x5aa7e0, roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.8 }),
  );
  m.position.y = s.bottom + FILL / 2;
  return m;
}
