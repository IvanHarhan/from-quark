import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  abs,
  atomicAdd,
  atomicLoad,
  atomicStore,
  clamp,
  dot,
  exp,
  float,
  floor,
  instanceIndex,
  instancedArray,
  int,
  length,
  max,
  min,
  normalize,
  pow,
  select,
  sqrt,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { SUBSTANCES, type Substance } from '../../data/substances';
import { boilingPoint, enthalpyAt, viscosity } from '../thermo';
import type { Tray, VesselState } from '../vessel';
import { BOUNDARY_CELLS, cellCount, type Domain } from './domain';
import {
  FIXED_POINT,
  MAX_CELLS_PER_STEP,
  PARTICLES_PER_CELL_AXIS,
  SOUND_SPEED,
  mpmUnits,
  pressureToGrid,
  viscosityToGrid,
} from './units';

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL node types are too dynamic to annotate usefully. */
type N = any;

/** Particle lifecycle flag (c1.w). */
export const STATE = { matter: 0, steam: 1, dead: 2 } as const;

/** Latent heat is smeared over this temperature window for the grid diffusion (apparent heat capacity). */
const LATENT_WINDOW = 2; // K
/**
 * Fixed-point scales for the thermal atomics: heat capacity (J/K) and energy relative to the room
 * temperature (J). Relative energy keeps the numbers small, so edge nodes with tiny weights still get
 * an accurate temperature; absolute CВ·T at this scale would round to nonsense there.
 */
const FP_C = 1e5;
const FP_E = 500;
/** Particles per cell; a node with this much summed weight is completely filled with matter. */
const FULL_WEIGHT = PARTICLES_PER_CELL_AXIS ** 3;
const MIN_NODE_C = 1e-2; // J/K (a full node holds ~2 J/K)
/** Share of the grid temperature mixed into each particle per thermal step (PIC/FLIP blend). */
const PIC_BLEND = 0.1;
const STEAM_LIFE = 3; // s
const STEFAN_BOLTZMANN = 5.670374419e-8;
const EMISSIVITY = 0.3;
const AIR_H = 10; // W/(mВІВ·K), natural convection
/** Borosilicate glass k в‰€ 1.14 W/(mВ·K) over the 4 mm beaker bottom. */
const PLATE_U = 1.14 / 0.004;
/** Impinging oxy-fuel flame / liquid-nitrogen jet: heat transfer coefficients of order 10Ві W/(mВІВ·K). */
const BRUSH_H = 1500; // W/(mВІВ·K)
/**
 * Natural convection in liquids as an effective conductivity k_eff = NuВ·k (engineering approximation).
 * Heat runs up to Г—1000 faster than the real-time flow, so the flow itself cannot carry it; for water
 * heated from below in the beaker Ra в‰€ 10вЃ№ gives Nu в‰€ 0.15В·Ra^в…“ в‰€ 140; 50 is a conservative middle.
 */
const LIQUID_NU = 50;
const MAX_MATERIALS = 32;
const SLOTS = 6;
/**
 * Grid nodes closer than this (cells) to a collider surface get its slip condition; nodes inside the collider
 * move with it. The beaker needs a full cell (with half, liquid creeps through the floorвЂ“wall corner and
 * compacts); the tray and press use half a cell so resting solids don't hover a whole cell above them.
 */
const VESSEL_BAND = 1.0;
const BC_BAND = 0.5;
/** The tray floor collides half a cell lower than drawn, so solids resting on it look seated. */
const TRAY_FLOOR_SINK = 0.5;

export interface ThermalInputs {
  /** Ambient air, K */
  ambient: number;
  /** Hotplate under the beaker, K; null when off. */
  plate: number | null;
  /** Heat brush in world metres, target temperature K; null when idle. */
  brush: { x: number; y: number; z: number; radius: number; target: number } | null;
}

export interface Press {
  /** Plate centre and half extents, world metres. */
  center: [number, number, number];
  half: [number, number, number];
  /** Vertical velocity, m/s */
  vy: number;
}

/**
 * MLS-MPM (Hu et al. 2018) on WebGPU compute with APIC transfer, multi-material, with heat.
 *
 * Mechanics (every substep): liquids are weakly compressible (Tait, Оі = 7) with temperature-dependent
 * viscosity; solids are Neo-Hookean on the elastic left CauchyвЂ“Green tensor b_e with J2 (von Mises)
 * plasticity by Simo's return mapping, so no SVD is needed. A melting particle blends both stresses by its
 * liquid fraction. Stiffness and yield are scaled (see SolidModel).
 *
 * Heat (once per fixed step): particles splat heat capacity and energy to the grid, the grid diffuses heat
 * explicitly (with plate, brush, air convection and radiation), and each particle takes back its share of the
 * temperature change into its enthalpy. Latent heat enters through an apparent heat capacity, so a melting
 * region holds at Tm. Fully boiled particles turn into rising steam puffs.
 *
 * Grid momenta and heat are summed with fixed-point integer atomics, so results do not depend on thread
 * order: the simulation is deterministic for the same input.
 *
 * Particle buffers (vec4):
 *   pos.xyz (grid units), pos.w = material index;  vel.xyz, vel.w = J
 *   c0..c2 = APIC columns; c0.w = enthalpy H (J/kg), c1.w = state, c2.w = steam life (s)
 *   be0 = b_e (xx, yy, zz), be1 = b_e (xy, xz, yz)
 *   info = (T, liquid fraction, state, material) for rendering and readback
 */
export class MpmSolver {
  readonly capacity: number;
  readonly domain: Domain;
  readonly materials: Substance[] = SUBSTANCES;
  count = 0;

  readonly pos: N;
  readonly info: N;
  /** Per particle 6 vec4: vel(J), c0(H), c1(state), c2(steam life), be0, be1 вЂ” packed to stay within
   *  the 8 storage buffers per shader stage that WebGPU guarantees. */
  private data: N;
  private gridInt: N;
  private gridV: N;
  private heatInt: N;
  private heatA: N;
  private heatB: N;
  readonly steamCounter: N;

  private realParticleMass: number;
  private pressure = 101325;

  private u = {
    dt: uniform(0.001),
    count: uniform(0, 'uint'),
    gravity: uniform(new THREE.Vector3()),
    tableY: uniform(0),
    // vessel (beaker)
    vPos: uniform(new THREE.Vector3()),
    vCos: uniform(1),
    vSin: uniform(0),
    vVel: uniform(new THREE.Vector3()),
    vW: uniform(0),
    vInnerR: uniform(0),
    vOuterR: uniform(0),
    vFloor: uniform(0),
    vBase: uniform(0),
    vHeight: uniform(0),
    // tray
    trayCenter: uniform(new THREE.Vector3()),
    trayHalf: uniform(new THREE.Vector3()),
    trayFloor: uniform(0),
    trayRim: uniform(0),
    trayWall: uniform(0),
    trayOn: uniform(0),
    // press plate
    pressCenter: uniform(new THREE.Vector3()),
    pressHalf: uniform(new THREE.Vector3()),
    pressVy: uniform(0),
    pressOn: uniform(0),
    // heat
    thDt: uniform(0),
    ambient: uniform(293.15),
    plateT: uniform(293.15),
    plateOn: uniform(0),
    brushPos: uniform(new THREE.Vector3()),
    brushR: uniform(1),
    brushT: uniform(293.15),
    brushOn: uniform(0),
    massKg: uniform(0),
    dxM: uniform(0),
    // materials
    mA: uniformArray(Array.from({ length: MAX_MATERIALS }, () => new THREE.Vector4()), 'vec4') as N,
    mB: uniformArray(Array.from({ length: MAX_MATERIALS }, () => new THREE.Vector4()), 'vec4') as N,
    mC: uniformArray(Array.from({ length: MAX_MATERIALS }, () => new THREE.Vector4()), 'vec4') as N,
    mD: uniformArray(Array.from({ length: MAX_MATERIALS }, () => new THREE.Vector4()), 'vec4') as N,
    mE: uniformArray(Array.from({ length: MAX_MATERIALS }, () => new THREE.Vector4()), 'vec4') as N,
  };

  private kernels: { p2g: N; grid: N; g2p: N; heatP2G: N; heatPrep: N; diffuseAB: N; diffuseBA: N; heatG2P: N; heatG2PFromB: N };

  constructor(domain: Domain, capacity: number) {
    this.domain = domain;
    this.capacity = capacity;
    const cells = cellCount(domain);
    this.pos = instancedArray(capacity, 'vec4');
    this.info = instancedArray(capacity, 'vec4');
    this.data = instancedArray(capacity * SLOTS, 'vec4');
    this.gridInt = instancedArray(cells * 4, 'int').toAtomic();
    this.gridV = instancedArray(cells, 'vec4');
    this.heatInt = instancedArray(cells * 4, 'int').toAtomic();
    this.heatA = instancedArray(cells, 'vec4');
    this.heatB = instancedArray(cells, 'vec4');
    this.steamCounter = instancedArray(1, 'int').toAtomic();
    const spacing = domain.dx / PARTICLES_PER_CELL_AXIS;
    this.realParticleMass = 1000 * spacing ** 3; // kg of the reference (ПЃ = 1000) particle
    this.u.massKg.value = this.realParticleMass;
    this.u.dxM.value = domain.dx;
    this.setPressure(this.pressure);
    this.kernels = this.build();
  }

  materialIndex(id: string): number {
    return this.materials.findIndex((m) => m.id === id);
  }

  /** Re-derives material constants (boiling points depend on pressure). */
  setPressure(P: number) {
    this.pressure = P;
    const units = mpmUnits(this.domain.dx, 1000);
    this.materials.forEach((s, i) => {
      if (i >= MAX_MATERIALS) return;
      const rho = s.rhoLiquid;
      const tb = boilingPoint(s, P);
      // P-wave modulus M = ПЃcВІ sets the CFL-limited stiffness; E, О», Ој follow from Poisson's ratio.
      const M = rho * SOUND_SPEED ** 2;
      const nu = s.solid.poisson;
      const E = (M * (1 + nu) * (1 - 2 * nu)) / (1 - nu);
      const mu = E / (2 * (1 + nu));
      const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
      const yieldStress = s.solid.yieldStrain === null ? 0 : E * s.solid.yieldStrain;
      // Arrhenius fit of the viscosity model between Tm and the middle of the liquid range.
      const tRef = Math.max(s.tm, 293.15);
      const t2 = (s.tm + tb) / 2;
      const muRef = viscosity(s, tRef);
      const beta = Math.log(viscosity(s, t2) / muRef) / (1 / t2 - 1 / tRef);
      this.u.mA.array[i].set(rho / 1000, s.cpSolid, s.cpLiquid, s.lf);
      this.u.mB.array[i].set(s.tm, tb, s.lv, s.kSolid);
      this.u.mC.array[i].set(s.kLiquid, pressureToGrid(M / 7, units), pressureToGrid(mu, units), pressureToGrid(lambda, units));
      this.u.mD.array[i].set(pressureToGrid(yieldStress, units), viscosityToGrid(muRef, units), Number.isFinite(beta) ? beta : 0, tRef);
      this.u.mE.array[i].set(s.betaLiquid, 0, 0, 0);
    });
  }

  /** Replaces all particles with one substance block. positions: xyzw in grid units. */
  setParticles(positions: Float32Array, materialId: string, temperature: number) {
    this.count = 0;
    for (const b of [this.pos, this.info, this.data]) {
      (b.value.array as Float32Array).fill(0);
      b.value.clearUpdateRanges();
      b.value.needsUpdate = true;
    }
    this.u.count.value = 0;
    this.append(positions, materialId, temperature, true);
  }

  /** Adds particles at rest. Uploads only the new range so the GPU state of existing particles is kept. */
  append(positions: Float32Array, materialId: string, temperature: number, full = false): number {
    const mi = this.materialIndex(materialId);
    const s = this.materials[mi];
    const H = enthalpyAt(s, temperature, boilingPoint(s, this.pressure));
    const n = Math.min(positions.length / 4, this.capacity - this.count);
    if (n <= 0) return 0;
    const start = this.count;
    const arr = (b: N) => b.value.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const k = (start + i) * 4;
      arr(this.pos).set([positions[i * 4], positions[i * 4 + 1], positions[i * 4 + 2], mi], k);
      arr(this.info).set([temperature, H > 0 ? 1 : 0, STATE.matter, mi], k);
      // vel (J = 1), c0 (H), c1 (state), c2 (life), be0 = diag(1), be1 = 0
      arr(this.data).set([0, 0, 0, 1, 0, 0, 0, H, 0, 0, 0, STATE.matter, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0], k * SLOTS);
    }
    for (const [b, stride] of [[this.pos, 4], [this.info, 4], [this.data, 4 * SLOTS]] as [N, number][]) {
      if (!full) b.value.addUpdateRange(start * stride, n * stride);
      b.value.needsUpdate = true;
    }
    this.count += n;
    this.u.count.value = this.count;
    return n;
  }

  setEnvironment(gravity: number, tableTopY: number, vessel: VesselState) {
    const d = this.domain;
    this.u.gravity.value.set(0, -gravity / d.dx, 0);
    this.u.tableY.value = (tableTopY - d.origin[1]) / d.dx;
    const s = vessel.shape;
    // The glass is thinner than a cell; for collisions it is thickened outward/downward so particles
    // can't tunnel through it. The cavity (what holds the liquid) keeps its real size.
    const wall = Math.max(s.wall, 1.5 * d.dx);
    const base = Math.max(s.bottom, 1.5 * d.dx);
    this.u.vInnerR.value = s.innerRadius / d.dx;
    this.u.vOuterR.value = (s.innerRadius + wall) / d.dx;
    this.u.vFloor.value = s.bottom / d.dx;
    this.u.vBase.value = (s.bottom - base) / d.dx;
    this.u.vHeight.value = s.height / d.dx;
    this.setVesselPose(vessel);
  }

  setTray(t: Tray | null) {
    const d = this.domain;
    this.u.trayOn.value = t ? 1 : 0;
    if (!t) return;
    const g = (v: number, k: number) => (v - d.origin[k]) / d.dx;
    this.u.trayCenter.value.set(g((t.minX + t.maxX) / 2, 0), 0, g((t.minZ + t.maxZ) / 2, 2));
    this.u.trayHalf.value.set((t.maxX - t.minX) / 2 / d.dx, 0, (t.maxZ - t.minZ) / 2 / d.dx);
    this.u.trayFloor.value = g(t.floorY, 1) - TRAY_FLOOR_SINK;
    this.u.trayRim.value = t.rim / d.dx;
    this.u.trayWall.value = Math.max(t.wall, 1.5 * d.dx) / d.dx;
  }

  setPress(p: Press | null) {
    const d = this.domain;
    this.u.pressOn.value = p ? 1 : 0;
    if (!p) return;
    this.u.pressCenter.value.set(
      (p.center[0] - d.origin[0]) / d.dx,
      (p.center[1] - d.origin[1]) / d.dx,
      (p.center[2] - d.origin[2]) / d.dx,
    );
    this.u.pressHalf.value.set(p.half[0] / d.dx, p.half[1] / d.dx, p.half[2] / d.dx);
    this.u.pressVy.value = p.vy / d.dx;
  }

  setVesselPose(v: VesselState) {
    const d = this.domain;
    const p = v.pose;
    this.u.vPos.value.set((p.x - d.origin[0]) / d.dx, (p.y - d.origin[1]) / d.dx, (p.z - d.origin[2]) / d.dx);
    this.u.vCos.value = Math.cos(p.tilt);
    this.u.vSin.value = Math.sin(p.tilt);
    this.u.vVel.value.set(v.vel.x / d.dx, v.vel.y / d.dx, v.vel.z / d.dx);
    this.u.vW.value = v.vel.w;
  }

  /** Mechanics: `substeps` steps of dt seconds each. */
  step(renderer: THREE.WebGPURenderer, dt: number, substeps: number) {
    if (this.count === 0) return;
    this.u.dt.value = dt;
    const { p2g, grid, g2p } = this.kernels;
    const list: N[] = [];
    for (let i = 0; i < substeps; i++) list.push(p2g, grid, g2p);
    renderer.compute(list);
  }

  /**
   * Heat transfer over `dt` seconds of game time. The grid diffusion is subdivided for stability
   * (explicit limit dxВІПЃc/(6k) for the most conductive material present).
   */
  thermalStep(renderer: THREE.WebGPURenderer, dt: number, inputs: ThermalInputs) {
    if (this.count === 0 || dt <= 0) return;
    const d = this.domain;
    // The update is implicit in each node's own temperature, so any step is stable; subdividing towards the
    // explicit limit dxВІПЃc/(6k) only buys accuracy, capped to keep the cost bounded.
    let limit = Infinity;
    for (const s of this.materials) {
      for (const [rho, c, k] of [
        [s.rhoSolid, s.cpSolid, s.kSolid],
        [s.rhoLiquid, s.cpLiquid, s.kLiquid * LIQUID_NU],
      ]) {
        limit = Math.min(limit, (d.dx * d.dx * rho * c) / (6 * k));
      }
    }
    const n = Math.min(64, Math.max(1, Math.ceil(dt / limit)));
    this.u.thDt.value = dt / n;
    this.u.ambient.value = inputs.ambient;
    this.u.plateOn.value = inputs.plate === null ? 0 : 1;
    this.u.plateT.value = inputs.plate ?? inputs.ambient;
    this.u.brushOn.value = inputs.brush ? 1 : 0;
    if (inputs.brush) {
      const b = inputs.brush;
      this.u.brushPos.value.set((b.x - d.origin[0]) / d.dx, (b.y - d.origin[1]) / d.dx, (b.z - d.origin[2]) / d.dx);
      this.u.brushR.value = b.radius / d.dx;
      this.u.brushT.value = b.target;
    }
    const k = this.kernels;
    const list: N[] = [k.heatP2G, k.heatPrep];
    for (let i = 0; i < n; i++) list.push(i % 2 === 0 ? k.diffuseAB : k.diffuseBA);
    list.push(n % 2 === 1 ? k.heatG2PFromB : k.heatG2P);
    renderer.compute(list);
  }

  private build() {
    const { pos, info, data, gridInt, gridV, heatInt, heatA, heatB, u } = this;
    const slot = (id: N, k: number): N => data.element(id.mul(SLOTS).add(k));
    const [nx, ny, nz] = this.domain.n;
    const S = float(FIXED_POINT);
    const cells = cellCount(this.domain);
    const B = BOUNDARY_CELLS;

    const cellIndex = (c: N) => int(c.x).add(int(c.y).mul(nx)).add(int(c.z).mul(nx * ny));
    const weights = (fx: N) => [
      fx.oneMinus().add(0.5).pow(2).mul(0.5),
      float(0.75).sub(fx.sub(1).pow(2)),
      fx.sub(0.5).pow(2).mul(0.5),
    ];
    const forEachNode = (fn: (gx: number, gy: number, gz: number) => void) => {
      for (let gx = 0; gx < 3; gx++) for (let gy = 0; gy < 3; gy++) for (let gz = 0; gz < 3; gz++) fn(gx, gy, gz);
    };

    // ---------- materials ----------
    const material = (mi: N): Record<string, N> => {
      const a = u.mA.element(mi);
      const b = u.mB.element(mi);
      const c = u.mC.element(mi);
      const d = u.mD.element(mi);
      const e = u.mE.element(mi);
      return {
        betaL: e.x,
        rhoRel: a.x, cpS: a.y, cpL: a.z, lf: a.w,
        tm: b.x, tb: b.y, lv: b.z, kS: b.w,
        kL: c.x, bulk: c.y, muS: c.z, lambda: c.w,
        yieldS: d.x, viscRef: d.y, viscBeta: d.z, viscTref: d.w,
      };
    };
    type Mat = ReturnType<typeof material>;
    const boilH = (m: Mat) => m.lf.add(m.cpL.mul(m.tb.sub(m.tm)));
    const tempOf = (m: Mat, H: N) =>
      select(H.lessThanEqual(0), m.tm.add(H.div(m.cpS)), select(H.lessThanEqual(m.lf), m.tm, min(m.tm.add(H.sub(m.lf).div(m.cpL)), m.tb)));
    const liquidOf = (m: Mat, H: N) => clamp(H.div(m.lf), 0, 1);
    /** Apparent specific heat (J/(kgВ·K)) including latent heat smeared over LATENT_WINDOW. */
    const cApp = (m: Mat, H: N) => {
      const hb = boilH(m);
      return select(
        H.lessThan(0),
        m.cpS,
        select(
          H.lessThanEqual(m.lf),
          m.lf.div(LATENT_WINDOW),
          select(H.lessThan(hb), m.cpL, m.lv.div(LATENT_WINDOW)),
        ),
      );
    };

    // ---------- colliders ----------
    const boxSdf = (p: N, c: N, h: N) => {
      const q: N = abs(p.sub(c)).sub(h);
      const inside: N = max(q.x, max(q.y, q.z));
      return length(max(q, vec3(0))).add(min(inside, 0));
    };
    const vesselSdf = Fn(([l]: [N]) => {
      const r = length(vec2(l.x, l.z));
      const outer = max(max(r.sub(u.vOuterR), u.vBase.sub(l.y)), l.y.sub(u.vHeight));
      const cavity = max(r.sub(u.vInnerR), u.vFloor.sub(l.y));
      return max(outer, cavity.negate());
    });
    const traySdf = Fn(([p]: [N]) => {
      const w = u.trayWall;
      const c = u.trayCenter;
      const outer = boxSdf(
        p,
        vec3(c.x, u.trayFloor.add(u.trayRim.sub(w).mul(0.5)), c.z),
        vec3(u.trayHalf.x.add(w), u.trayRim.add(w).mul(0.5), u.trayHalf.z.add(w)),
      );
      const cavity = boxSdf(p, vec3(c.x, u.trayFloor.add(u.trayRim), c.z), vec3(u.trayHalf.x, u.trayRim, u.trayHalf.z));
      return max(outer, cavity.negate()).add(float(1e3).mul(float(1).sub(u.trayOn)));
    });
    const pressSdf = Fn(([p]: [N]) => boxSdf(p, u.pressCenter, u.pressHalf).add(float(1e3).mul(float(1).sub(u.pressOn))));
    const gradient = (f: (p: N) => N, p: N) => {
      const h = 0.5;
      return normalize(
        vec3(
          f(p.add(vec3(h, 0, 0))).sub(f(p.sub(vec3(h, 0, 0)))),
          f(p.add(vec3(0, h, 0))).sub(f(p.sub(vec3(0, h, 0)))),
          f(p.add(vec3(0, 0, h))).sub(f(p.sub(vec3(0, 0, h)))),
        ).add(vec3(0, 1e-6, 0)),
      );
    };
    const toLocal = (p: N) => {
      const d = p.sub(u.vPos);
      return vec3(d.x.mul(u.vCos).sub(d.y.mul(u.vSin)), d.x.mul(u.vSin).add(d.y.mul(u.vCos)), d.z);
    };
    const toWorldDir = (n: N) => vec3(n.x.mul(u.vCos).add(n.y.mul(u.vSin)), n.y.mul(u.vCos).sub(n.x.mul(u.vSin)), n.z);
    const vesselVelocity = (p: N) => {
      const r = p.sub(u.vPos);
      return u.vVel.add(vec3(r.y.mul(u.vW), r.x.mul(u.vW).negate(), 0));
    };
    /** Separating slip against a collider moving with velocity vs. */
    const slip = (v: N, n: N, vs: N) => {
      const rel = v.sub(vs).toVar();
      const vn = dot(rel, n);
      If(vn.lessThan(0), () => {
        rel.subAssign(n.mul(vn));
      });
      v.assign(rel.add(vs));
    };

    // ---------- mechanics ----------
    const p2g = Fn(() => {
      const id = instanceIndex;
      If(id.greaterThanEqual(u.count).or(slot(id, 2).w.notEqual(STATE.matter)), () => {
        Return();
      });
      const P = pos.element(id);
      const p = P.xyz;
      const mi = int(P.w);
      const m = material(mi);
      const v = slot(id, 0).xyz;
      const J = slot(id, 0).w;
      const C0 = slot(id, 1).xyz;
      const C1 = slot(id, 2).xyz;
      const C2 = slot(id, 3).xyz;
      const H = slot(id, 1).w;
      const T = tempOf(m, H);
      const phi = liquidOf(m, H).toVar();

      // Liquid: Tait pressure on the volume ratio J (no tension) + Newtonian viscosity Ој(T).
      const pressure = max(m.bulk.mul(pow(J, float(-7)).sub(1)), 0);
      const visc = m.viscRef.mul(exp(m.viscBeta.mul(float(1).div(T).sub(float(1).div(m.viscTref)))));
      // Solid: Kirchhoff П„ = Ој dev(bМ„) + Оє/2 (JВІ в€’ 1) I, Cauchy Пѓ = П„/J.
      const bxx = slot(id, 4).x;
      const byy = slot(id, 4).y;
      const bzz = slot(id, 4).z;
      const bxy = slot(id, 5).x;
      const bxz = slot(id, 5).y;
      const byz = slot(id, 5).z;
      const jm23 = pow(J, float(-2 / 3));
      const tr3 = bxx.add(byy).add(bzz).div(3);
      const kappa = m.lambda.add(m.muS.mul(2 / 3));
      const pVol = kappa.mul(0.5).mul(J.mul(J).sub(1));
      const sol = (dev: N, iso: N) => m.muS.mul(jm23).mul(dev).add(iso).div(J);
      const sxxS = sol(bxx.sub(tr3), pVol);
      const syyS = sol(byy.sub(tr3), pVol);
      const szzS = sol(bzz.sub(tr3), pVol);
      const sxyS = sol(bxy, 0);
      const sxzS = sol(bxz, 0);
      const syzS = sol(byz, 0);
      // Liquid deviatoric part from the strain rate в‰€ sym(C).
      const l = (a: N, b: N) => visc.mul(a.add(b));
      const solidW = float(1).sub(phi);
      const sxx = sxxS.mul(solidW).add(pressure.negate().add(l(C0.x, C0.x)).mul(phi));
      const syy = syyS.mul(solidW).add(pressure.negate().add(l(C1.y, C1.y)).mul(phi));
      const szz = szzS.mul(solidW).add(pressure.negate().add(l(C2.z, C2.z)).mul(phi));
      const sxy = sxyS.mul(solidW).add(l(C1.x, C0.y).mul(phi));
      const sxz = sxzS.mul(solidW).add(l(C2.x, C0.z).mul(phi));
      const syz = syzS.mul(solidW).add(l(C2.y, C1.z).mul(phi));

      const a = u.dt.mul(0.125 * 4).toVar(); // dt В· V_p В· 4/dxВІ
      const mass = m.rhoRel;
      // Boussinesq buoyancy: warm liquid is lighter (ПЃ в‰€ ПЃв‚Ђ(1 в€’ ОІО”T)), which drives natural convection.
      // (Water's density maximum at 4 В°C is not modelled.)
      const buoyancy = u.gravity.mul(u.dt).mul(m.betaL.mul(T.sub(u.ambient)).mul(phi).negate()).toVar();
      const base = floor(p.sub(0.5)).toVar();
      const fx = p.sub(base).toVar();
      const w = weights(fx);
      forEachNode((gx, gy, gz) => {
        const weight = w[gx].x.mul(w[gy].y).mul(w[gz].z);
        const d = vec3(gx, gy, gz).sub(fx);
        const sd = vec3(
          sxx.mul(d.x).add(sxy.mul(d.y)).add(sxz.mul(d.z)),
          sxy.mul(d.x).add(syy.mul(d.y)).add(syz.mul(d.z)),
          sxz.mul(d.x).add(syz.mul(d.y)).add(szz.mul(d.z)),
        );
        const Cd = C0.mul(d.x).add(C1.mul(d.y)).add(C2.mul(d.z));
        // momentum: w (m v + (в€’a Пѓ + m C) d)
        const mom = v.add(Cd).add(buoyancy).mul(mass).sub(sd.mul(a)).mul(weight);
        const idx = cellIndex(base.add(vec3(gx, gy, gz))).mul(4);
        atomicAdd(gridInt.element(idx), int(mom.x.mul(S).round()));
        atomicAdd(gridInt.element(idx.add(1)), int(mom.y.mul(S).round()));
        atomicAdd(gridInt.element(idx.add(2)), int(mom.z.mul(S).round()));
        atomicAdd(gridInt.element(idx.add(3)), int(weight.mul(mass).mul(S).round()));
      });
    })().compute(this.capacity);

    const grid = Fn(() => {
      const id = int(instanceIndex);
      If(id.greaterThanEqual(cells), () => {
        Return();
      });
      const i4 = id.mul(4);
      const mass = float(atomicLoad(gridInt.element(i4.add(3))) as N).div(S).toVar();
      const mx = float(atomicLoad(gridInt.element(i4)) as N).toVar();
      const my = float(atomicLoad(gridInt.element(i4.add(1))) as N).toVar();
      const mz = float(atomicLoad(gridInt.element(i4.add(2))) as N).toVar();
      atomicStore(gridInt.element(i4), 0);
      atomicStore(gridInt.element(i4.add(1)), 0);
      atomicStore(gridInt.element(i4.add(2)), 0);
      atomicStore(gridInt.element(i4.add(3)), 0);
      If(mass.lessThanEqual(1e-6), () => {
        gridV.element(id).assign(vec4(0));
        Return();
      });
      const v = vec3(mx, my, mz).div(S).div(mass).add(u.gravity.mul(u.dt)).toVar();
      const cx = float(id.mod(nx));
      const cy = float(id.div(nx).mod(ny));
      const cz = float(id.div(nx * ny));
      const p = vec3(cx, cy, cz);

      // Concave corners (floor meets wall) need both walls enforced: a single SDF-gradient normal points
      // diagonally there and lets liquid creep along the other wall into the glass.
      // Values shared by several branches must be materialised first (.toVar): TSL emits a cached expression
      // where it is first used, so a value first used inside one `if` is undefined in the `else`.
      const l = toLocal(p).toVar();
      const r = length(vec2(l.x, l.z)).toVar();
      const vs = vesselVelocity(p).toVar();
      If(r.lessThan(u.vInnerR).and(l.y.greaterThan(u.vBase.sub(VESSEL_BAND))).and(l.y.lessThan(u.vHeight.add(VESSEL_BAND))), () => {
        // inside the cavity column: floor and side wall separately; inside the bottom glass, move with it
        If(l.y.lessThan(u.vFloor), () => {
          v.assign(vs);
        }).ElseIf(l.y.lessThan(u.vFloor.add(VESSEL_BAND)), () => {
          slip(v, toWorldDir(vec3(0, 1, 0)), vs);
        });
        If(r.greaterThan(u.vInnerR.sub(VESSEL_BAND)), () => {
          slip(v, toWorldDir(vec3(l.x.negate(), 0, l.z.negate()).div(max(r, 1e-4))), vs);
        });
      }).Else(() => {
        const sd = vesselSdf(l);
        // Inside the glass itself the node simply moves with the glass.
        If(sd.lessThan(0), () => {
          v.assign(vs);
        }).ElseIf(sd.lessThan(VESSEL_BAND), () => {
          slip(v, toWorldDir(gradient((q) => vesselSdf(q), l)), vs);
        });
      });

      const tc = p.sub(vec3(u.trayCenter.x, 0, u.trayCenter.z)).toVar();
      const inTray = abs(tc.x).lessThan(u.trayHalf.x).and(abs(tc.z).lessThan(u.trayHalf.z)).and(u.trayOn.greaterThan(0));
      If(inTray.and(p.y.greaterThan(u.trayFloor.sub(u.trayWall).sub(BC_BAND))).and(p.y.lessThan(u.trayFloor.add(u.trayRim).add(BC_BAND))), () => {
        // (callbacks use braces: an If callback that returns a node becomes a typed expression)
        If(p.y.lessThan(u.trayFloor), () => {
          v.assign(vec3(0));
        }).ElseIf(p.y.lessThan(u.trayFloor.add(BC_BAND)), () => {
          slip(v, vec3(0, 1, 0), vec3(0));
        });
        If(tc.x.greaterThan(u.trayHalf.x.sub(BC_BAND)), () => {
          slip(v, vec3(-1, 0, 0), vec3(0));
        });
        If(tc.x.lessThan(u.trayHalf.x.negate().add(BC_BAND)), () => {
          slip(v, vec3(1, 0, 0), vec3(0));
        });
        If(tc.z.greaterThan(u.trayHalf.z.sub(BC_BAND)), () => {
          slip(v, vec3(0, 0, -1), vec3(0));
        });
        If(tc.z.lessThan(u.trayHalf.z.negate().add(BC_BAND)), () => {
          slip(v, vec3(0, 0, 1), vec3(0));
        });
      }).Else(() => {
        const sd = traySdf(p);
        If(sd.lessThan(0), () => {
          v.assign(vec3(0));
        }).ElseIf(sd.lessThan(BC_BAND), () => {
          slip(v, gradient((q) => traySdf(q), p), vec3(0));
        });
      });
      const sp = pressSdf(p).toVar();
      If(sp.lessThan(0), () => {
        v.assign(vec3(0, u.pressVy, 0));
      }).ElseIf(sp.lessThan(BC_BAND), () => {
        slip(v, gradient((q) => pressSdf(q), p), vec3(0, u.pressVy, 0));
      });
      If(cy.lessThan(u.tableY.add(0.5)).and(v.y.lessThan(0)), () => {
        v.y.assign(0);
        v.x.mulAssign(0.9);
        v.z.mulAssign(0.9);
      });
      If(cx.lessThan(B).and(v.x.lessThan(0)), () => v.x.assign(0));
      If(cx.greaterThan(nx - B).and(v.x.greaterThan(0)), () => v.x.assign(0));
      If(cy.lessThan(B).and(v.y.lessThan(0)), () => v.y.assign(0));
      If(cy.greaterThan(ny - B).and(v.y.greaterThan(0)), () => v.y.assign(0));
      If(cz.lessThan(B).and(v.z.lessThan(0)), () => v.z.assign(0));
      If(cz.greaterThan(nz - B).and(v.z.greaterThan(0)), () => v.z.assign(0));
      gridV.element(id).assign(vec4(v, mass));
    })().compute(cells);

    const g2p = Fn(() => {
      const id = instanceIndex;
      If(id.greaterThanEqual(u.count), () => {
        Return();
      });
      const state = slot(id, 2).w;
      If(state.equal(STATE.dead), () => {
        Return();
      });
      // Steam: rises and fades, no longer part of the continuum.
      If(state.equal(STATE.steam), () => {
        const life = slot(id, 3).w.sub(u.dt);
        const sv = slot(id, 0).xyz.mul(0.995).add(vec3(0, float(0.6).div(u.dxM).mul(u.dt), 0));
        const sp = pos.element(id).xyz.add(sv.mul(u.dt));
        pos.element(id).assign(vec4(sp, pos.element(id).w));
        slot(id, 0).assign(vec4(sv, 1));
        slot(id, 3).w.assign(life);
        info.element(id).z.assign(STATE.steam);
        info.element(id).y.assign(clamp(life.div(STEAM_LIFE), 0, 1));
        If(life.lessThanEqual(0).or(sp.y.greaterThan(ny - B)), () => {
          slot(id, 2).w.assign(STATE.dead);
          info.element(id).z.assign(STATE.dead);
        });
        Return();
      });

      const p = pos.element(id).xyz.toVar();
      const base = floor(p.sub(0.5)).toVar();
      const fx = p.sub(base).toVar();
      const w = weights(fx);
      const nv = vec3(0).toVar();
      const b0 = vec3(0).toVar();
      const b1 = vec3(0).toVar();
      const b2 = vec3(0).toVar();
      forEachNode((gx, gy, gz) => {
        const weight = w[gx].x.mul(w[gy].y).mul(w[gz].z);
        const d = vec3(gx, gy, gz).sub(fx);
        const gv = gridV.element(cellIndex(base.add(vec3(gx, gy, gz)))).xyz.mul(weight);
        nv.addAssign(gv);
        b0.addAssign(gv.mul(d.x.mul(4)));
        b1.addAssign(gv.mul(d.y.mul(4)));
        b2.addAssign(gv.mul(d.z.mul(4)));
      });
      const vmax = float(MAX_CELLS_PER_STEP).div(u.dt);
      const speed = length(nv);
      If(speed.greaterThan(vmax), () => {
        nv.mulAssign(vmax.div(speed));
      });

      const m = material(int(pos.element(id).w));
      const phi = liquidOf(m, slot(id, 1).w).toVar();
      const J = slot(id, 0).w;
      const trace = b0.x.add(b1.y).add(b2.z);
      // A liquid has no tension, so J > 1 would make it stop feeling compression; solids may stretch.
      // (.toVar: newJ is used inside and after the plasticity branch; see the note in the grid kernel)
      const newJ: N = clamp(J.mul(u.dt.mul(trace).add(1)), 0.6, select(phi.greaterThan(0.5), float(1), float(1.4))).toVar();

      // Elastic left CauchyвЂ“Green update: b в†ђ (I + dt C) b (I + dt C)бµЂ, with C columns b0, b1, b2.
      const F = (r: number, c: number) => {
        const col = [b0, b1, b2][c];
        const comp = [col.x, col.y, col.z][r];
        return comp.mul(u.dt).add(r === c ? 1 : 0);
      };
      const bOld = [
        [slot(id, 4).x, slot(id, 5).x, slot(id, 5).y],
        [slot(id, 5).x, slot(id, 4).y, slot(id, 5).z],
        [slot(id, 5).y, slot(id, 5).z, slot(id, 4).z],
      ];
      // FB = FВ·b, then bNew = FBВ·FбµЂ (symmetric: only 6 entries needed)
      const FB = [0, 1, 2].map((r) => [0, 1, 2].map((c) => F(r, 0).mul(bOld[0][c]).add(F(r, 1).mul(bOld[1][c])).add(F(r, 2).mul(bOld[2][c]))));
      const bn = (r: number, c: number) => FB[r][0].mul(F(c, 0)).add(FB[r][1].mul(F(c, 1))).add(FB[r][2].mul(F(c, 2)));
      const nxx: N = bn(0, 0).toVar();
      const nyy: N = bn(1, 1).toVar();
      const nzz: N = bn(2, 2).toVar();
      const nxy: N = bn(0, 1).toVar();
      const nxz: N = bn(0, 2).toVar();
      const nyz: N = bn(1, 2).toVar();

      // J2 plasticity (Simo): scale the deviatoric part of bМ„ back to the yield surface.
      If(m.yieldS.greaterThan(0), () => {
        const tr3 = nxx.add(nyy).add(nzz).div(3);
        const dxx = nxx.sub(tr3);
        const dyy = nyy.sub(tr3);
        const dzz = nzz.sub(tr3);
        const jm23 = pow(newJ, float(-2 / 3));
        const sNorm = m.muS.mul(jm23).mul(
          sqrt(dxx.mul(dxx).add(dyy.mul(dyy)).add(dzz.mul(dzz)).add(nxy.mul(nxy).add(nxz.mul(nxz)).add(nyz.mul(nyz)).mul(2))),
        );
        const limit = m.yieldS.mul(Math.sqrt(2 / 3));
        If(sNorm.greaterThan(limit), () => {
          const k = limit.div(sNorm);
          nxx.assign(dxx.mul(k).add(tr3));
          nyy.assign(dyy.mul(k).add(tr3));
          nzz.assign(dzz.mul(k).add(tr3));
          nxy.mulAssign(k);
          nxz.mulAssign(k);
          nyz.mulAssign(k);
        });
      });
      // A liquid keeps no elastic memory; when it freezes it starts stress-free.
      If(phi.greaterThan(0.5), () => {
        nxx.assign(newJ.pow(2 / 3));
        nyy.assign(newJ.pow(2 / 3));
        nzz.assign(newJ.pow(2 / 3));
        nxy.assign(0);
        nxz.assign(0);
        nyz.assign(0);
      });

      const np = p.add(nv.mul(u.dt)).toVar();
      const l = toLocal(np);
      const sv = vesselSdf(l);
      If(sv.lessThan(0.05), () => {
        np.addAssign(toWorldDir(gradient((q) => vesselSdf(q), l)).mul(float(0.05).sub(sv)));
      });
      const st = traySdf(np);
      If(st.lessThan(0.05), () => {
        np.addAssign(gradient((q) => traySdf(q), np).mul(float(0.05).sub(st)));
      });
      const sp = pressSdf(np);
      If(sp.lessThan(0.05), () => {
        np.addAssign(gradient((q) => pressSdf(q), np).mul(float(0.05).sub(sp)));
      });
      np.y.assign(max(np.y, u.tableY.add(0.3)));
      np.assign(clamp(np, vec3(B - 1), vec3(nx - B + 1, ny - B + 1, nz - B + 1)));

      pos.element(id).assign(vec4(np, pos.element(id).w));
      slot(id, 0).assign(vec4(nv, newJ));
      slot(id, 1).assign(vec4(b0, slot(id, 1).w));
      slot(id, 2).assign(vec4(b1, slot(id, 2).w));
      slot(id, 3).assign(vec4(b2, slot(id, 3).w));
      slot(id, 4).assign(vec4(nxx, nyy, nzz, 0));
      slot(id, 5).assign(vec4(nxy, nxz, nyz, 0));
    })().compute(this.capacity);

    // ---------- heat ----------
    const heatP2G = Fn(() => {
      const id = instanceIndex;
      If(id.greaterThanEqual(u.count).or(slot(id, 2).w.notEqual(STATE.matter)), () => {
        Return();
      });
      const P = pos.element(id);
      const m = material(int(P.w));
      const H = slot(id, 1).w;
      const T: N = tempOf(m, H);
      const kP = m.kS.add(m.kL.mul(LIQUID_NU).sub(m.kS).mul(liquidOf(m, H)));
      const Cp: N = cApp(m, H).mul(m.rhoRel).mul(u.massKg); // J/K
      const base = floor(P.xyz.sub(0.5)).toVar();
      const fx = P.xyz.sub(base).toVar();
      const w = weights(fx);
      forEachNode((gx, gy, gz) => {
        const weight = w[gx].x.mul(w[gy].y).mul(w[gz].z);
        const idx = cellIndex(base.add(vec3(gx, gy, gz))).mul(4);
        atomicAdd(heatInt.element(idx), int(Cp.mul(weight).mul(FP_C).round()));
        atomicAdd(heatInt.element(idx.add(1)), int(Cp.mul(T.sub(u.ambient)).mul(weight).mul(FP_E).round()));
        atomicAdd(heatInt.element(idx.add(2)), int(kP.mul(weight).mul(FP_C).round()));
        atomicAdd(heatInt.element(idx.add(3)), int(weight.mul(FP_C).round()));
      });
    })().compute(this.capacity);

    /** heat buffers: x = T (K), y = C (J/K), z = k (W/mВ·K), w = T at the start of the step */
    const heatPrep = Fn(() => {
      const id = int(instanceIndex);
      If(id.greaterThanEqual(cells), () => {
        Return();
      });
      const i4 = id.mul(4);
      const C = float(atomicLoad(heatInt.element(i4)) as N).div(FP_C).toVar();
      const E = float(atomicLoad(heatInt.element(i4.add(1))) as N).div(FP_E);
      const kw = float(atomicLoad(heatInt.element(i4.add(2))) as N).div(FP_C);
      const ww = float(atomicLoad(heatInt.element(i4.add(3))) as N).div(FP_C);
      atomicStore(heatInt.element(i4), 0);
      atomicStore(heatInt.element(i4.add(1)), 0);
      atomicStore(heatInt.element(i4.add(2)), 0);
      atomicStore(heatInt.element(i4.add(3)), 0);
      // Nodes barely touched by particles (C below ~0.5 % of a full node) are treated as air: their
      // fixed-point temperature would be mostly rounding noise.
      If(C.lessThanEqual(MIN_NODE_C), () => {
        heatA.element(id).assign(vec4(u.ambient, 0, 0, u.ambient));
        Return();
      });
      const T = u.ambient.add(E.div(C));
      // Conductivity scaled by how full the node is, so barely touched edge nodes conduct little.
      const k = kw.div(max(ww, 1e-9)).mul(clamp(ww.div(FULL_WEIGHT), 0, 1));
      heatA.element(id).assign(vec4(T, C, k, T));
    })().compute(cells);

    const diffuse = (src: N, dst: N) =>
      Fn(() => {
        const id = int(instanceIndex);
        If(id.greaterThanEqual(cells), () => {
          Return();
        });
        const cell = src.element(id);
        const C = cell.y;
        If(C.lessThanEqual(1e-9), () => {
          dst.element(id).assign(cell);
          Return();
        });
        const T = cell.x;
        const k = cell.z;
        const cx = id.mod(nx);
        const cy = id.div(nx).mod(ny);
        const cz = id.div(nx * ny);
        const area = u.dxM.mul(u.dxM).toVar();
        // Every exchange is a conductance G (W/K) towards a temperature; the update
        // T' = (CВ·T + dtВ·ОЈGВ·Tбµў) / (C + dtВ·ОЈG) is implicit in the node's own temperature, so it is stable
        // even for nearly empty edge nodes with a tiny heat capacity.
        const G = float(0).toVar();
        const GT = float(0).toVar();
        const exchange = (g: N, target: N) => {
          G.addAssign(g);
          GT.addAssign(g.mul(target));
        };
        const face = (ok: N, nid: N) => {
          If(ok, () => {
            const nb = src.element(nid);
            If(nb.y.greaterThan(1e-9), () => {
              const kf = k.mul(nb.z).mul(2).div(max(k.add(nb.z), 1e-9));
              exchange(kf.mul(u.dxM), nb.x);
            }).Else(() => {
              // Exposed face: natural convection + thermal radiation to the room (linearised).
              const a = u.ambient;
              const rad = float(EMISSIVITY * STEFAN_BOLTZMANN).mul(a.mul(a).add(T.mul(T))).mul(a.add(T));
              exchange(area.mul(rad.add(AIR_H)), a);
            });
          });
        };
        face(cx.greaterThan(0), id.sub(1));
        face(cx.lessThan(nx - 1), id.add(1));
        face(cy.greaterThan(0), id.sub(nx));
        face(cy.lessThan(ny - 1), id.add(nx));
        face(cz.greaterThan(0), id.sub(nx * ny));
        face(cz.lessThan(nz - 1), id.add(nx * ny));

        const p = vec3(float(cx), float(cy), float(cz)).toVar();
        // Hotplate: heats the liquid layer on the beaker floor through the glass while upright.
        If(u.plateOn.greaterThan(0).and(abs(u.vSin).lessThan(0.2)), () => {
          const l = toLocal(p);
          const r = length(vec2(l.x, l.z));
          If(r.lessThan(u.vInnerR).and(l.y.greaterThan(u.vFloor.sub(0.5))).and(l.y.lessThan(u.vFloor.add(1.5))), () => {
            exchange(area.mul(PLATE_U), u.plateT);
          });
        });
        // Brush (torch / liquid nitrogen): convective exchange with a hot or cold jet.
        If(u.brushOn.greaterThan(0), () => {
          const dist = length(p.sub(u.brushPos));
          If(dist.lessThan(u.brushR), () => {
            exchange(area.mul(BRUSH_H).mul(float(1).sub(dist.div(u.brushR))), u.brushT);
          });
        });
        const newT = C.mul(T).add(u.thDt.mul(GT)).div(C.add(u.thDt.mul(G)));
        dst.element(id).assign(vec4(newT, C, k, cell.w));
      })().compute(cells);

    const heatG2P = (src: N) =>
      Fn(() => {
        const id = instanceIndex;
        If(id.greaterThanEqual(u.count).or(slot(id, 2).w.notEqual(STATE.matter)), () => {
          Return();
        });
        const P = pos.element(id);
        const mi = int(P.w);
        const m = material(mi);
        const H = slot(id, 1).w;
        const base = floor(P.xyz.sub(0.5)).toVar();
        const fx = P.xyz.sub(base).toVar();
        const w = weights(fx);
        const dT = float(0).toVar();
        const tGrid = float(0).toVar();
        const wGrid = float(0).toVar();
        const tLo = float(1e9).toVar();
        const tHi = float(-1e9).toVar();
        forEachNode((gx, gy, gz) => {
          const weight = w[gx].x.mul(w[gy].y).mul(w[gz].z);
          const g = src.element(cellIndex(base.add(vec3(gx, gy, gz))));
          dT.addAssign(g.x.sub(g.w).mul(weight));
          If(g.y.greaterThan(0), () => {
            tGrid.addAssign(g.x.mul(weight));
            wGrid.addAssign(weight);
            tLo.assign(min(tLo, g.x));
            tHi.assign(max(tHi, g.x));
          });
        });
        // FLIP: the particle keeps its own temperature and adds the grid change (no smearing)вЂ¦
        const newH = H.add(dT.mul(cApp(m, H))).toVar();
        // вЂ¦blended a little towards the grid temperature (PIC) so per-particle errors cannot accumulate past
        // the physical range. Only within one phase, so latent heat stays exact.
        If(wGrid.greaterThan(0), () => {
          const tPic = tGrid.div(wGrid);
          const hb = boilH(m);
          If(newH.lessThan(0), () => {
            const t = tempOf(m, newH).mul(1 - PIC_BLEND).add(tPic.mul(PIC_BLEND));
            newH.assign(min(m.cpS.mul(t.sub(m.tm)), 0));
          }).ElseIf(newH.greaterThan(m.lf).and(newH.lessThan(hb)), () => {
            const t = tempOf(m, newH).mul(1 - PIC_BLEND).add(tPic.mul(PIC_BLEND));
            newH.assign(clamp(m.lf.add(m.cpL.mul(t.sub(m.tm))), m.lf, hb));
          });
        });
        // Maximum principle: diffusion cannot make a particle hotter or colder than every node around it.
        // Without this a particle mid-melt can take more energy than its latent heat in one step and
        // overshoot far into the next phase.
        // Applied per phase only, never across a phase change (latent heat must still be paid in full).
        If(wGrid.greaterThan(0), () => {
          const hb = boilH(m);
          If(newH.lessThan(0), () => {
            const lo = select(tLo.lessThan(m.tm), m.cpS.mul(tLo.sub(m.tm)), float(0));
            const hi = select(tHi.lessThan(m.tm), m.cpS.mul(tHi.sub(m.tm)), float(0));
            newH.assign(clamp(newH, min(lo, hi), hi));
          }).ElseIf(newH.greaterThan(m.lf).and(newH.lessThan(hb)), () => {
            const lo = select(tLo.greaterThan(m.tm), m.lf.add(m.cpL.mul(min(tLo, m.tb).sub(m.tm))), m.lf);
            const hi = select(tHi.greaterThan(m.tm), m.lf.add(m.cpL.mul(min(tHi, m.tb).sub(m.tm))), m.lf);
            newH.assign(clamp(newH, lo, max(lo, hi)));
          });
        });
        slot(id, 1).w.assign(newH);
        const T = tempOf(m, newH);
        info.element(id).assign(vec4(T, liquidOf(m, newH), STATE.matter, float(mi)));
        // Fully boiled: becomes a steam puff.
        If(newH.greaterThan(boilH(m).add(m.lv)), () => {
          slot(id, 2).w.assign(STATE.steam);
          slot(id, 3).w.assign(STEAM_LIFE);
          slot(id, 0).assign(vec4(0, float(0.2).div(u.dxM), 0, 1));
          info.element(id).assign(vec4(T, 1, STATE.steam, float(mi)));
          atomicAdd(this.steamCounter.element(0), int(1));
        });
      })().compute(this.capacity);

    return {
      p2g,
      grid,
      g2p,
      heatP2G,
      heatPrep,
      diffuseAB: diffuse(heatA, heatB),
      diffuseBA: diffuse(heatB, heatA),
      heatG2P: heatG2P(heatA),
      heatG2PFromB: heatG2P(heatB),
    };
  }
}
