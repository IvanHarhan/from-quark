import * as THREE from 'three/webgpu';
import {
  Fn, Discard, dot, exp, float, floor, fract, instancedArray, length, max, min, mix, screenUV, select, sin, smoothstep, uniform, uv,
  vec2, vec3, vec4,
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ionConfig, type Subshell } from '../../chem/aufbau';
import { meanRadius, sampleCloud, slaterZeff, type CloudPoint } from '../../chem/orbitals';
import { element } from '../../data/db';
import type { Substance } from '../../data/substances';
import { Rng } from '../../core/rng';
import { translate, type Lang, type MessageKey } from '../../i18n';
import {
  atomPositions, boxEdges, createCell, hydrogenBonds, isMetal, stepCell, type CellPhase, type CellSpec, type MicroCell,
} from '../../sim/micro/cell';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Continuous zoom from a lump of matter in the lab down to a single quark.
 *
 * Three layers with their own units so float precision holds: a screen-space "bulk" layer for the material
 * itself (grains, then the blur of its atoms), the micro scene in ångströms (molecules → one atom's electron
 * cloud) and the nuclear scene in femtometres (nucleus → proton → quark). `width` is the vertical size of the
 * field of view in metres; levels cross-fade as it shrinks.
 *
 * Two looks:
 *  - textbook: ball-and-stick molecules, labelled orbitals, crisp nucleons and quarks with charges;
 *  - microscope: what is actually measured. There is no "real colour" below the wavelength of light; physics
 *    measures electron density (atomic-force / tunnelling microscopes), so atoms are glowing density clouds.
 */

export type ZoomLevel = 'bulk' | 'molecules' | 'atom' | 'nucleus' | 'nucleon' | 'quark';
export type ZoomMode = 'textbook' | 'microscope';

const FOV = 50;
const TAN = Math.tan((FOV * Math.PI) / 360);
/** LHC limit on quark size; nothing deeper is known. */
export const MIN_WIDTH = 1e-19;
/** Widest zoom: the lab camera's view of a few centimetres; wider hands back to the lab. */
export const MAX_WIDTH = 5e-2;
const QUARK_LEVEL = 2e-16;

/**
 * Cross-fade weight for a level: 1 while the field of view w is within [lo, hi], fading to 0 over
 * `fade` decades beyond either end (lo = 0 / hi = Infinity mean "no limit on that side").
 */
function band(w: number, lo: number, hi: number, fade = 0.5) {
  const l = Math.log10(w);
  const below = lo > 0 ? Math.min(1, Math.max(0, (l - (Math.log10(lo) - fade)) / fade)) : 1;
  const above = Number.isFinite(hi) ? Math.min(1, Math.max(0, (Math.log10(hi) + fade - l) / fade)) : 1;
  return below * above;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Microstructure seen under an optical microscope: typical grain (crystallite) sizes. These vary a lot
 * with how a sample was made; the values are typical, not measured for this sample.
 */
export function microstructure(s: Substance, phase: CellPhase): { kind: 'grains' | 'cells' | 'none'; size: number } {
  if (phase !== 'solid' || s.id === 'glass') return { kind: 'none', size: 0 };
  const sizes: Record<string, number> = { water: 1e-3, wax: 1e-5, rust: 1e-6, sugar: 3e-4, nacl: 3e-4, glycine: 1e-4, alanine: 1e-4 };
  if (s.id === 'wood') return { kind: 'cells', size: 3e-5 };
  return { kind: 'grains', size: sizes[s.id] ?? 5e-5 };
}

/** Soft additive blobs drawn from a CPU-filled instance buffer (position xyz + radius, colour rgb + intensity). */
class Blobs {
  readonly sprite: THREE.Sprite;
  private pos: N;
  private col: N;
  readonly fade = uniform(1);
  constructor(readonly capacity: number, sharpness = 3) {
    this.pos = instancedArray(capacity, 'vec4');
    this.col = instancedArray(capacity, 'vec4');
    const m = new THREE.SpriteNodeMaterial();
    const p: N = this.pos.toAttribute();
    const c: N = this.col.toAttribute();
    m.positionNode = p.xyz;
    m.scaleNode = p.w.mul(2);
    m.colorNode = Fn(() => {
      const q = uv().mul(2).sub(1);
      const r2 = dot(q, q);
      Discard(r2.greaterThan(1));
      // Gaussian falloff: a density cloud, not a hard sphere.
      const g = exp(r2.mul(-sharpness)).sub(Math.exp(-sharpness)).max(0);
      return vec4(c.xyz.mul(c.w).mul(g).mul(this.fade), 1);
    })();
    m.blending = THREE.AdditiveBlending;
    m.transparent = true;
    m.depthWrite = false;
    m.toneMapped = false;
    m.lights = false;
    this.sprite = new THREE.Sprite(m);
    this.sprite.frustumCulled = false;
    this.sprite.count = 0;
  }
  set(i: number, x: number, y: number, z: number, r: number, color: THREE.Color, intensity: number) {
    (this.pos.value.array as Float32Array).set([x, y, z, r], i * 4);
    (this.col.value.array as Float32Array).set([color.r, color.g, color.b, intensity], i * 4);
  }
  commit(count: number) {
    this.sprite.count = Math.min(count, this.capacity);
    this.pos.value.needsUpdate = true;
    this.col.value.needsUpdate = true;
  }
}

/** Lit balls and sticks (textbook look), one shared opacity. */
class BallStick {
  readonly balls: THREE.InstancedMesh;
  readonly sticks: THREE.InstancedMesh;
  private nb = 0;
  private ns = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private static Y = new THREE.Vector3(0, 1, 0);
  constructor(readonly capacity: number, scene: THREE.Scene, stickColor = 0xb8bec8) {
    const ballMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.0, transparent: true });
    this.balls = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), ballMat, capacity);
    this.balls.setColorAt(0, new THREE.Color());
    const stickMat = new THREE.MeshStandardNodeMaterial({ color: stickColor, roughness: 0.5, transparent: true });
    this.sticks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), stickMat, capacity);
    for (const mesh of [this.balls, this.sticks]) {
      mesh.frustumCulled = false;
      mesh.count = 0;
      scene.add(mesh);
    }
  }
  begin() {
    this.nb = this.ns = 0;
  }
  ball(x: number, y: number, z: number, r: number, color: THREE.Color) {
    if (this.nb >= this.capacity || r <= 0) return;
    this.m.makeScale(r, r, r).setPosition(x, y, z);
    this.balls.setMatrixAt(this.nb, this.m);
    this.balls.setColorAt(this.nb++, color);
  }
  stick(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number) {
    if (this.ns >= this.capacity) return;
    this.v.set(bx - ax, by - ay, bz - az);
    const len = this.v.length();
    if (len < 1e-9) return;
    this.q.setFromUnitVectors(BallStick.Y, this.v.divideScalar(len));
    this.m.compose(this.s.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), this.q, new THREE.Vector3(r, len, r));
    this.sticks.setMatrixAt(this.ns++, this.m);
  }
  commit(opacity: number) {
    const show = opacity > 0.002;
    this.balls.count = show ? this.nb : 0;
    this.sticks.count = show ? this.ns : 0;
    this.balls.instanceMatrix.needsUpdate = true;
    this.sticks.instanceMatrix.needsUpdate = true;
    if (this.balls.instanceColor) this.balls.instanceColor.needsUpdate = true;
    for (const mesh of [this.balls, this.sticks]) {
      (mesh.material as THREE.Material).opacity = opacity;
      mesh.visible = show;
    }
  }
}

/** HTML labels pinned to 3D points (textbook mode). */
class Labels {
  readonly root: HTMLDivElement;
  private pool: HTMLDivElement[] = [];
  private used = 0;
  private v = new THREE.Vector3();
  constructor(private dom: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'zoom-labels';
    dom.parentElement?.insertBefore(this.root, dom.nextSibling);
  }
  begin() {
    this.used = 0;
  }
  at(text: string, p: THREE.Vector3, cam: THREE.Camera, opacity = 1, cls = '') {
    if (opacity < 0.05) return;
    this.v.copy(p).project(cam);
    if (this.v.z < -1 || this.v.z > 1 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1) return;
    this.screen(text, ((this.v.x + 1) / 2) * this.dom.clientWidth, ((1 - this.v.y) / 2) * this.dom.clientHeight, opacity, cls);
  }
  screen(text: string, x: number, y: number, opacity = 1, cls = '') {
    if (opacity < 0.05) return;
    let el = this.pool[this.used];
    if (!el) {
      el = document.createElement('div');
      this.root.appendChild(el);
      this.pool.push(el);
    }
    this.used++;
    if (el.textContent !== text) el.textContent = text;
    const name = `zoom-label ${cls}`;
    if (el.className !== name) el.className = name;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.style.opacity = opacity.toFixed(2);
    el.style.display = '';
  }
  end() {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }
  hide() {
    this.begin();
    this.end();
  }
}

const vdw = (z: number) => (element(z)?.radius ?? 170) / 100; // Å

function cpk(z: number): THREE.Color {
  // Faint element tint on a bluish-white "electron" base.
  const c = new THREE.Color(element(z)?.cpk ?? '#ffffff');
  return new THREE.Color(0.5, 0.65, 1.0).lerp(c, 0.6);
}

const cpkSolid = (z: number) => new THREE.Color(element(z)?.cpk ?? '#cccccc');
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const sup = (n: number) => String(n).split('').map((d) => SUP[+d]).join('');

/** Pairs of atoms in one molecule that are covalently bonded (by distance). */
function bondsOf(sites: { z: number; local: [number, number, number] }[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < sites.length; i++)
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i];
      const b = sites[j];
      if (a.z === 1 && b.z === 1 && sites.length > 2) continue;
      const max = a.z === 1 || b.z === 1 ? 1.25 : 1.95;
      const d = Math.hypot(a.local[0] - b.local[0], a.local[1] - b.local[1], a.local[2] - b.local[2]);
      if (d < max) out.push([i, j]);
    }
  return out;
}

export interface ZoomInfo {
  level: ZoomLevel;
  width: number;
  molecules: number;
  hbondsPerMolecule: number;
  focusZ: number;
  isotopeA: number;
  /** Mean distance between neighbouring molecules/atoms, Å. */
  spacing: number;
}

export interface ZoomOptions {
  /** Zoomed out past the widest view: back to the lab. */
  onExit(): void;
  mode(): ZoomMode;
  lang(): Lang;
}

export class ZoomView {
  readonly microScene = new THREE.Scene();
  readonly nuclearScene = new THREE.Scene();
  readonly microCam = new THREE.PerspectiveCamera(FOV, 1, 1e-4, 1e4);
  readonly nuclearCam = new THREE.PerspectiveCamera(FOV, 1, 1e-4, 1e4);
  readonly controls: OrbitControls;
  width = 1e-8;
  private targetWidth = 1e-8;
  private aspect = 1;
  private cell: MicroCell | null = null;
  private edges: [number, number, number] = [1, 1, 1];
  private bonds: [number, number][][] = [];
  private spacing = 3;
  // microscope
  private atoms = new Blobs(30000, 2.6);
  private electronGas = new Blobs(4000, 4);
  private cloud = new Blobs(5000, 6);
  private nucleusDot = new Blobs(1, 5);
  private nucleons = new Blobs(300, 3.5);
  private quarks = new Blobs(400, 4);
  private gluons: THREE.LineSegments;
  // textbook
  private tbAll: BallStick;
  private tbFocus: BallStick;
  private tbNucleons: BallStick;
  private tbCentre: BallStick;
  private tbQuarks: BallStick;
  private orbitals = new THREE.Group();
  private orbitalMats: { mat: THREE.Material; base: number }[] = [];
  private orbitalLabels: { text: string; p: THREE.Vector3; r: number }[] = [];
  private nucBall: THREE.Mesh;
  private protonShell: THREE.Mesh;
  private springs: THREE.LineSegments;
  // shared
  private hbonds: THREE.LineSegments;
  private hbondsTb: THREE.LineSegments;
  private labels: Labels;
  private bulk: THREE.QuadMesh;
  private bulkU = {
    fade: uniform(0),
    aspect: uniform(1),
    grainScale: uniform(1),
    latScale: uniform(1),
    dots: uniform(0),
    base: uniform(new THREE.Color()),
    kind: uniform(0), // 0 none, 1 grains, 2 cells
    crystal: uniform(1),
    edge: uniform(0.03),
    grainVis: uniform(0),
  };
  private focus = 0;
  private focusAtom = 0;
  private cloudPts: CloudPoint[] = [];
  private cloudPool: CloudPoint[] = [];
  private cloudRng = new Rng(11);
  private nucleonPos: { p: THREE.Vector3; proton: boolean }[] = [];
  private quarkState: { p: THREE.Vector3; v: THREE.Vector3; color: THREE.Color; flavor: 'u' | 'd' }[] = [];
  private seaPairs: { p: THREE.Vector3; life: number; color: THREE.Color; size: number; axis: THREE.Vector3 }[] = [];
  private gasState: { p: THREE.Vector3; home: number }[] = [];
  private rng = new Rng(5);
  private active = false;
  private t = 0;
  private hbCount = 0;
  private isotopeA = 16;
  private focusZ = 8;
  private shells: Subshell[] = [];

  constructor(private dom: HTMLElement, private opts: ZoomOptions) {
    this.microScene.background = new THREE.Color(0x02040a);
    this.nuclearScene.background = null;
    this.microScene.add(this.atoms.sprite, this.electronGas.sprite, this.cloud.sprite, this.nucleusDot.sprite);
    const lineMat = (color: number) =>
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
    this.hbonds = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(0x7fd0ff));
    this.microScene.add(this.hbonds);
    this.nuclearScene.add(this.nucleons.sprite, this.quarks.sprite);
    this.gluons = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(0xffe08a));
    this.springs = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(0xffd25a));
    (this.springs.material as THREE.Material).blending = THREE.NormalBlending;
    this.hbondsTb = new THREE.LineSegments(this.hbonds.geometry, lineMat(0x4fc3ff));
    (this.hbondsTb.material as THREE.Material).blending = THREE.NormalBlending;
    this.microScene.add(this.hbondsTb);
    this.nuclearScene.add(this.gluons, this.springs);

    // textbook objects, lit by a key light riding on each camera
    for (const [scene, cam] of [[this.microScene, this.microCam], [this.nuclearScene, this.nuclearCam]] as const) {
      scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x202430, 1.4));
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(0.6, 1, 1);
      cam.add(key);
      scene.add(cam);
    }
    this.tbAll = new BallStick(30000, this.microScene);
    this.tbFocus = new BallStick(400, this.microScene);
    this.tbNucleons = new BallStick(300, this.nuclearScene);
    this.tbCentre = new BallStick(1, this.nuclearScene);
    this.tbQuarks = new BallStick(400, this.nuclearScene);
    this.microScene.add(this.orbitals);
    this.nucBall = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshStandardNodeMaterial({ color: 0xff5a3c, transparent: true }));
    this.microScene.add(this.nucBall);
    this.protonShell = new THREE.Mesh(
      new THREE.SphereGeometry(0.84, 48, 24),
      new THREE.MeshStandardNodeMaterial({ color: 0xff8a6a, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.nuclearScene.add(this.protonShell);

    this.bulk = new THREE.QuadMesh(this.bulkMaterial());
    this.labels = new Labels(dom);

    this.controls = new OrbitControls(this.microCam, dom);
    this.controls.enableZoom = false;
    this.controls.enablePan = false;
    this.controls.enabled = false;
    dom.addEventListener(
      'wheel',
      (e) => {
        if (!this.active) return;
        e.preventDefault();
        this.zoomBy(Math.exp(e.deltaY * 0.0025));
      },
      { passive: false },
    );
  }

  /** The material as seen through an optical microscope, dissolving into its atoms. */
  private bulkMaterial() {
    const u = this.bulkU;
    const hash = (g: N, a: number, b: number) => fract(sin(dot(g, vec2(a, b))).mul(43758.5453));
    // Voronoi: distances to the nearest and second-nearest feature point, plus a random id of the nearest cell.
    const voronoi = (p: N, jitter: N) => {
      const cell = floor(p);
      const f1 = float(8).toVar();
      const f2 = float(8).toVar();
      const id = float(0).toVar();
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const g = cell.add(vec2(i, j));
          const h = vec2(hash(g, 127.1, 311.7), hash(g, 269.5, 183.3));
          const d = length(p.sub(g.add(h.sub(0.5).mul(jitter).add(0.5))));
          id.assign(select(d.lessThan(f1), hash(g, 419.2, 371.9), id));
          f2.assign(min(f2, max(f1, d)));
          f1.assign(min(f1, d));
        }
      return { f1, f2, id };
    };
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    m.toneMapped = false;
    m.colorNode = Fn(() => {
      const s = screenUV.sub(0.5).mul(vec2(u.aspect, -1));
      // grains: the screen centre sits on a feature point, i.e. inside one grain
      const g = voronoi(s.mul(u.grainScale), float(1));
      const gap = g.f2.sub(g.f1);
      const boundary = float(1).sub(smoothstep(0, u.edge, gap));
      // grains smaller than a few pixels blend into the material's average colour, as they do by eye
      const grains = mix(u.base, u.base.mul(float(0.82).add(g.id.mul(0.3))).mul(float(1).sub(boundary.mul(0.7))), u.grainVis);
      const wall = smoothstep(u.edge.mul(2), u.edge.mul(4), gap);
      const cells = mix(u.base, mix(u.base.mul(0.7), u.base.mul(0.22), wall), u.grainVis);
      const macro: N = select(u.kind.equal(1), grains, select(u.kind.equal(2), cells, u.base)).toVar();
      // atoms/molecules: a regular grid in crystals, random packing otherwise
      const pl = s.mul(u.latScale);
      const q = fract(pl).sub(0.5);
      const dCrystal = length(q);
      const dRandom = voronoi(pl, float(1)).f1;
      const d = select(u.crystal.greaterThan(0.5), dCrystal, dRandom);
      const dotsCol = vec3(0.55, 0.7, 1).mul(exp(d.div(0.22).pow(2).negate())).add(vec3(0.008, 0.016, 0.04));
      return vec4(mix(macro, dotsCol, u.dots), u.fade);
    })();
    return m;
  }

  setActive(active: boolean) {
    this.active = active;
    this.controls.enabled = active;
    if (!active) this.labels.hide();
  }

  zoomBy(factor: number) {
    if (!this.cell) return;
    if (factor > 1 && this.targetWidth >= MAX_WIDTH * 0.999) {
      this.opts.onExit();
      return;
    }
    this.targetWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, this.targetWidth * factor));
  }

  private cellWidth() {
    return (this.cell?.box ?? 20) * 1.6e-10;
  }

  jumpTo(level: ZoomLevel) {
    this.targetWidth = { bulk: 1e-4, molecules: this.cellWidth(), atom: 2.5e-10, nucleus: 2e-14, nucleon: 2.5e-15, quark: 1e-18 }[level];
  }

  /**
   * Builds the micro cell for the substance state the player picked.
   * isotopeFor: mass number to show for the focused element (most abundant isotope).
   * startWidth: field of view to start from (the lab camera's when flying in), defaults to the molecule view.
   */
  open(spec: CellSpec, isotopeFor: (z: number) => number, startWidth?: number) {
    this.cell = createCell(spec, 7);
    const c = this.cell;
    this.edges = boxEdges(c);
    this.bonds = c.molecules.map((m) => bondsOf(m.sites));
    this.spacing = Math.cbrt((this.edges[0] * this.edges[1] * this.edges[2]) / c.kind.length);
    this.width = this.targetWidth = Math.min(MAX_WIDTH, startWidth ?? this.cellWidth());
    // Focus: the molecule nearest the box centre, its heaviest atom.
    const n = c.kind.length;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(c.pos[i * 3] - this.edges[0] / 2, c.pos[i * 3 + 1] - this.edges[1] / 2, c.pos[i * 3 + 2] - this.edges[2] / 2);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.focus = best;
    const sites = c.molecules[c.kind[best]].sites;
    this.focusAtom = sites.reduce((bi, s, i, arr) => (s.z > arr[bi].z ? i : bi), 0);
    this.focusZ = sites[this.focusAtom].z;
    this.isotopeA = isotopeFor(this.focusZ);
    this.shells = ionConfig(this.focusZ, this.focusZ);
    this.cloudPool = sampleCloud(this.focusZ, this.shells, 900, 3);
    this.cloudPts = this.cloudPool.slice(0, Math.min(this.cloud.capacity, 400 * this.focusZ));
    this.buildOrbitals();
    this.buildNucleus();
    this.buildGas();
    this.microCam.position.set(0.4, 0.3, 1);
    this.controls.target.set(0, 0, 0);

    const u = this.bulkU;
    const ms = microstructure(spec.substance, spec.phase);
    u.kind.value = { none: 0, grains: 1, cells: 2 }[ms.kind];
    u.crystal.value = spec.phase === 'solid' && spec.substance.id !== 'glass' ? 1 : 0;
    u.base.value.set(spec.phase === 'gas' ? '#05080f' : spec.substance.colors[spec.phase]);
  }

  /** Textbook orbitals of the focus atom: s (and d, f) as spheres, p as three dumbbells, at their mean radii. */
  private buildOrbitals() {
    for (const o of [...this.orbitals.children]) {
      this.orbitals.remove(o);
      ((o as THREE.Mesh).material as THREE.Material).dispose();
    }
    this.orbitalMats = [];
    this.orbitalLabels = [];
    const sphere = new THREE.SphereGeometry(1, 40, 20);
    const colors = ['#5aa8ff', '#ff8c5a', '#62d88a', '#c08cff'];
    this.shells.forEach((sh, k) => {
      const r = meanRadius(sh.n, sh.l, slaterZeff(this.focusZ, this.shells, sh));
      const mat = new THREE.MeshStandardNodeMaterial({
        color: colors[sh.l], transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6,
      });
      const base = sh.l === 1 ? 0.3 : 0.14;
      this.orbitalMats.push({ mat, base });
      const text = `${sh.n}${'spdf'[sh.l]}${sup(sh.electrons)}`;
      if (sh.l === 1) {
        // p: two lobes along each axis
        for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)])
          for (const sign of [1, -1]) {
            const lobe = new THREE.Mesh(sphere, mat);
            lobe.scale.set(0.34 * r, 0.34 * r, 0.6 * r);
            lobe.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().multiplyScalar(sign));
            lobe.position.copy(axis).multiplyScalar(sign * 0.62 * r);
            this.orbitals.add(lobe);
          }
        this.orbitalLabels.push({ text, p: new THREE.Vector3(1.25 * r, 0, 0), r });
      } else {
        const shell = new THREE.Mesh(sphere, mat);
        shell.scale.setScalar(r);
        this.orbitals.add(shell);
        const a = k * 2.1 + 0.6;
        this.orbitalLabels.push({ text, p: new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0), r });
      }
    });
  }

  private buildGas() {
    this.gasState = [];
    const c = this.cell!;
    if (!isMetal(c.spec.substance) || c.spec.phase === 'gas') return;
    const count = Math.min(this.electronGas.capacity, c.kind.length * 2);
    for (let i = 0; i < count; i++) {
      this.gasState.push({
        p: new THREE.Vector3(this.rng.next() * this.edges[0], this.rng.next() * this.edges[1], this.rng.next() * this.edges[2]),
        home: i % c.kind.length,
      });
    }
  }

  private buildNucleus() {
    const A = this.isotopeA;
    const Z = this.focusZ;
    // Concentric shells sized so the nucleus radius is R = 1.2·A^(1/3) fm.
    const R = 1.2 * Math.cbrt(A);
    const pts: THREE.Vector3[] = [new THREE.Vector3()];
    const gap = 1.8;
    for (let k = 1; pts.length < A; k++) {
      const r = k * gap * 0.62;
      const n = Math.max(4, Math.floor((4 * Math.PI * r * r) / (gap * gap * 0.95)));
      for (let i = 0; i < n && pts.length < A + 40; i++) {
        const y = 1 - ((i + 0.5) / n) * 2;
        const rad = Math.sqrt(1 - y * y);
        const t = i * 2.399963 + k;
        pts.push(new THREE.Vector3(Math.cos(t) * rad * r, y * r, Math.sin(t) * rad * r));
      }
    }
    const chosen = pts.slice(0, A);
    const maxR = chosen.reduce((m, p) => Math.max(m, p.length()), 0) || 1;
    const scale = (R - 0.84) / maxR;
    this.nucleonPos = chosen.map((p, i) => ({
      p: p.multiplyScalar(i === 0 ? 0 : scale),
      // the centre nucleon is a proton (the one we zoom into)
      proton: i === 0 || Math.floor(((i + 1) * Z) / A) > Math.floor((i * Z) / A),
    }));
    // Proton: two up quarks and one down quark, one of each colour charge.
    const colors = [new THREE.Color(1, 0.25, 0.25), new THREE.Color(0.25, 1, 0.35), new THREE.Color(0.35, 0.45, 1)];
    this.quarkState = (['u', 'u', 'd'] as const).map((flavor, i) => ({
      p: new THREE.Vector3(Math.cos((i * 2 * Math.PI) / 3) * 0.35, Math.sin((i * 2 * Math.PI) / 3) * 0.35, 0),
      v: new THREE.Vector3(),
      color: colors[i],
      flavor,
    }));
    this.seaPairs = [];
  }

  level(): ZoomLevel {
    const w = this.width;
    if (w > this.cellWidth() * 1.5) return 'bulk';
    if (w > 4e-10) return 'molecules';
    if (w > 3e-13) return 'atom';
    if (w > 3.2e-15) return 'nucleus';
    if (w > QUARK_LEVEL) return 'nucleon';
    return 'quark';
  }

  info(): ZoomInfo {
    return {
      level: this.level(),
      width: this.width,
      molecules: this.cell?.kind.length ?? 0,
      hbondsPerMolecule: this.cell ? this.hbCount / this.cell.kind.length : 0,
      focusZ: this.focusZ,
      isotopeA: this.isotopeA,
      spacing: this.spacing,
    };
  }

  private t_(key: MessageKey) {
    return translate(this.opts.lang(), key);
  }

  update(dt: number) {
    if (!this.cell) return;
    const c = this.cell;
    const E = this.edges;
    const tb = this.opts.mode() === 'textbook';
    const L = this.labels;
    L.begin();
    this.t += dt;
    // Smooth zoom in log space.
    const lw = Math.log(this.width);
    this.width = Math.exp(lw + (Math.log(this.targetWidth) - lw) * (1 - Math.exp(-dt * 6)));
    const w = this.width;
    const boxM = c.box * 1e-10;

    // ---------- bulk layer ----------
    const fBulk = smooth(1.6 * boxM, 3.2 * boxM, w);
    const u = this.bulkU;
    u.fade.value = fBulk;
    u.aspect.value = this.aspect;
    const ms = microstructure(c.spec.substance, c.spec.phase);
    const heightPx = Math.max(1, this.dom.clientHeight);
    if (ms.size > 0) {
      u.grainScale.value = Math.min(1e4, w / ms.size);
      u.edge.value = Math.max(0.025, (1.5 * u.grainScale.value) / heightPx);
      u.grainVis.value = smooth(3, 12, (ms.size / w) * heightPx);
    }
    const dotPx = ((this.spacing * 1e-10) / w) * heightPx;
    u.dots.value = smooth(3, 10, dotPx);
    u.latScale.value = u.dots.value > 0 ? w / (this.spacing * 1e-10) : 1;
    if (tb && fBulk > 0.3) {
      const name = `${c.spec.substance[this.opts.lang()]} · ${c.spec.substance.formula}`;
      const cx = this.dom.clientWidth / 2;
      const cy = this.dom.clientHeight / 2;
      if (u.dots.value < 0.5 && ms.size > 0 && (ms.size / w) * heightPx > 30)
        L.screen(`${name}: ${this.t_(ms.kind === 'cells' ? 'zoom.tb.cell' : 'zoom.tb.grain')}`, cx, cy, fBulk);
      else if (u.dots.value > 0.3) L.screen(`${name}: ${this.t_('zoom.tb.particles')}`, cx, cy, fBulk * u.dots.value);
    }

    // ---------- molecular dynamics (~20 fs per frame ≈ 10¹² slow-motion) ----------
    if (w > 3e-12 && fBulk < 1) stepCell(c, 0.002, 10);

    // level weights
    const fMolecules = band(w, 8e-10, Infinity, 0.4) * (fBulk < 0.999 ? 1 : 0);
    const fCloud = band(w, 3e-13, 4e-10, 0.6);
    const fNucleusDot = band(w, 6e-13, 3e-11);
    const fNucleus = band(w, 0, 3e-13, 0.4);
    const fQuarks = band(w, 0, 1.5e-15, 0.35);
    const fQuarkLevel = smooth(Math.log10(1.5e-15), Math.log10(QUARK_LEVEL), Math.log10(w));

    // ---------- micro scene (Å) ----------
    const focusAtoms = atomPositions(c, this.focus);
    const fa = focusAtoms[this.focusAtom].p;
    const center = new THREE.Vector3(fa[0], fa[1], fa[2]);
    // Camera keeps its direction (orbit) and frames `width` around the focus atom.
    const widthA = w * 1e10;
    const dirM = this.microCam.position.clone().sub(this.controls.target).normalize();
    if (dirM.lengthSq() < 0.5) dirM.set(0.4, 0.3, 1).normalize();
    this.controls.target.copy(center);
    this.microCam.position.copy(center).addScaledVector(dirM, widthA / 2 / TAN);
    this.microCam.near = Math.max(1e-5, widthA * 0.02);
    this.microCam.far = widthA * 50 + c.box * 4;
    this.microCam.updateProjectionMatrix();
    this.controls.update();

    const wrapNear = (v: number, ref: number, k: number) => v - E[k] * Math.round((v - ref) / E[k]);
    const fFocus = Math.max(fMolecules, band(w, 1e-11, Infinity) * 0.6);
    // Periodic images of every molecule that fall in a slab in front of the camera, so the cell tiles the view.
    const n = c.kind.length;
    const reach = (widthA / 2) * Math.hypot(this.aspect, 1) * 1.1 + 4;
    // Additive clouds pile up with depth: the microscope sees a thin layer, like a real AFM/TEM sample.
    const slab = c.box * (tb ? 0.6 : 0.22);
    const camDist = widthA / 2 / TAN;
    const span = E.map((e) => Math.min(3, Math.ceil(reach / e)));
    let k = 0;
    this.tbAll.begin();
    this.tbFocus.begin();
    const showAtoms = fFocus > 0.001;
    const molLabelAt = new THREE.Vector3();
    for (let i = 0; i < n && showAtoms; i++) {
      const atoms = i === this.focus ? focusAtoms : atomPositions(c, i);
      const bx = wrapNear(c.pos[i * 3], center.x, 0) - c.pos[i * 3];
      const by = wrapNear(c.pos[i * 3 + 1], center.y, 1) - c.pos[i * 3 + 1];
      const bz = wrapNear(c.pos[i * 3 + 2], center.z, 2) - c.pos[i * 3 + 2];
      const bonds = this.bonds[c.kind[i]];
      for (let sx = -span[0]; sx <= span[0]; sx++)
        for (let sy = -span[1]; sy <= span[1]; sy++)
          for (let sz = -span[2]; sz <= span[2]; sz++) {
            const home = sx === 0 && sy === 0 && sz === 0;
            const isFocus = home && i === this.focus;
            if (!isFocus && fMolecules <= 0.001) continue;
            const ox = bx + sx * E[0];
            const oy = by + sy * E[1];
            const oz = bz + sz * E[2];
            const rx = c.pos[i * 3] + ox - center.x;
            const ry = c.pos[i * 3 + 1] + oy - center.y;
            const rz = c.pos[i * 3 + 2] + oz - center.z;
            const depth = rx * dirM.x + ry * dirM.y + rz * dirM.z;
            if (!isFocus && (depth < -slab || depth > Math.min(slab, camDist * 0.4) || Math.hypot(rx - dirM.x * depth, ry - dirM.y * depth, rz - dirM.z * depth) > reach)) continue;
            if (tb) {
              const set = isFocus ? this.tbFocus : this.tbAll;
              for (let a = 0; a < atoms.length; a++) {
                const at = atoms[a];
                // The focused atom's ball gives way to its nucleus and orbitals when zooming in.
                const r = vdw(at.z) * 0.3 * (isFocus && a === this.focusAtom ? 1 - smooth(0.2, 0.8, fCloud) : 1);
                set.ball(at.p[0] + ox, at.p[1] + oy, at.p[2] + oz, r, cpkSolid(at.z));
              }
              for (const [a, b] of bonds) {
                const pa = atoms[a].p;
                const pb = atoms[b].p;
                set.stick(pa[0] + ox, pa[1] + oy, pa[2] + oz, pb[0] + ox, pb[1] + oy, pb[2] + oz, 0.11);
              }
            } else {
              for (let a = 0; a < atoms.length && k < this.atoms.capacity; a++) {
                const at = atoms[a];
                const own = isFocus ? (a === this.focusAtom ? fMolecules : fFocus) : fMolecules;
                this.atoms.set(k++, at.p[0] + ox, at.p[1] + oy, at.p[2] + oz, vdw(at.z) * 0.95, cpk(at.z), 0.07 * own);
              }
            }
            if (isFocus) molLabelAt.set(c.pos[i * 3] + ox, c.pos[i * 3 + 1] + oy, c.pos[i * 3 + 2] + oz);
          }
    }
    this.atoms.commit(tb ? 0 : k);
    this.tbAll.commit(tb ? fMolecules : 0);
    this.tbFocus.commit(tb ? fFocus : 0);

    // textbook labels: the focus molecule's atoms and name
    if (tb && fFocus * (1 - fBulk) > 0.05) {
      const s = c.spec.substance;
      const few = focusAtoms.length <= 9;
      focusAtoms.forEach((at, a) => {
        if (!few && at.z === 1) return;
        if (a === this.focusAtom && fCloud > 0.5) return;
        const sym = element(at.z)?.symbol ?? '?';
        const charge = s.id === 'nacl' ? (at.z === 11 ? '⁺' : '⁻') : '';
        L.at(sym + charge, new THREE.Vector3(...at.p), this.microCam, fFocus, 'atom');
      });
      if (fMolecules > 0.3 && focusAtoms.length > 1)
        L.at(`${s[this.opts.lang()]} ${s.formula}`, molLabelAt.clone().addScaledVector(this.microCam.up, 2.4), this.microCam, fMolecules, 'name');
    }

    // hydrogen bonds (water)
    if (c.spec.substance.id === 'water' && fMolecules > 0.01) {
      const hb = hydrogenBonds(c);
      this.hbCount = hb.length;
      const arr: number[] = [];
      let labelled = false;
      for (const [i, j] of hb) {
        const ai = atomPositions(c, i);
        const aj = atomPositions(c, j)[0].p;
        // donor H closest to the acceptor O
        let h = ai[1].p;
        let best = Infinity;
        for (const s of [ai[1].p, ai[2].p]) {
          const d = Math.hypot(wrapNear(s[0], aj[0], 0) - aj[0], wrapNear(s[1], aj[1], 1) - aj[1], wrapNear(s[2], aj[2], 2) - aj[2]);
          if (d < best) {
            best = d;
            h = s;
          }
        }
        // H moves with its own molecule's image.
        const hx = h[0] + wrapNear(c.pos[i * 3], center.x, 0) - c.pos[i * 3];
        const hy = h[1] + wrapNear(c.pos[i * 3 + 1], center.y, 1) - c.pos[i * 3 + 1];
        const hz = h[2] + wrapNear(c.pos[i * 3 + 2], center.z, 2) - c.pos[i * 3 + 2];
        const ox = wrapNear(aj[0], hx, 0);
        const oy = wrapNear(aj[1], hy, 1);
        const oz = wrapNear(aj[2], hz, 2);
        arr.push(hx, hy, hz, ox, oy, oz);
        if (tb && !labelled && (i === this.focus || j === this.focus)) {
          labelled = true;
          L.at(this.t_('zoom.tb.hbond'), new THREE.Vector3((hx + ox) / 2, (hy + oy) / 2, (hz + oz) / 2), this.microCam, fMolecules, 'hb');
        }
      }
      this.hbonds.geometry.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      (this.hbonds.material as THREE.LineBasicMaterial).opacity = 0.3 * fMolecules;
      (this.hbondsTb.material as THREE.LineBasicMaterial).opacity = 0.9 * fMolecules;
      this.hbonds.visible = !tb;
      this.hbondsTb.visible = tb;
    } else this.hbonds.visible = this.hbondsTb.visible = false;

    // free-electron gas in metals: fast random walkers around the ions
    let g = 0;
    let firstE: THREE.Vector3 | null = null;
    for (const e of this.gasState) {
      e.p.x += (this.rng.next() - 0.5) * 1.2;
      e.p.y += (this.rng.next() - 0.5) * 1.2;
      e.p.z += (this.rng.next() - 0.5) * 1.2;
      const x = wrapNear(e.p.x, center.x, 0);
      const y = wrapNear(e.p.y, center.y, 1);
      const z = wrapNear(e.p.z, center.z, 2);
      firstE ??= new THREE.Vector3(x, y, z);
      this.electronGas.set(g++, x, y, z, tb ? 0.12 : 0.2, new THREE.Color(0.5, 0.75, 1), (tb ? 0.6 : 0.12) * fMolecules);
    }
    this.electronGas.commit(fMolecules > 0.01 ? g : 0);
    if (tb && firstE) L.at(this.t_('zoom.tb.electrons'), firstE, this.microCam, fMolecules, 'e');

    // electron cloud of the focus atom: a live sample of |ψ|², refreshed continuously
    if (fCloud > 0.001 && !tb) {
      const pool = this.cloudPool;
      const refresh = Math.ceil(this.cloudPts.length * 0.08);
      for (let r = 0; r < refresh; r++) {
        this.cloudPts[Math.floor(this.cloudRng.next() * this.cloudPts.length)] = pool[Math.floor(this.cloudRng.next() * pool.length)];
      }
      const ptR = Math.max(0.006, widthA * 0.004);
      let q = 0;
      for (const p of this.cloudPts) {
        const outer = p.shell === this.shells.length - 1;
        const col = outer ? new THREE.Color(0.55, 0.85, 1) : new THREE.Color(0.75, 0.8, 1);
        this.cloud.set(q++, center.x + p.x, center.y + p.y, center.z + p.z, ptR, col, 0.55 * fCloud);
      }
      this.cloud.commit(q);
    } else this.cloud.commit(0);

    // textbook atom: labelled orbitals at their mean radii and a (hugely enlarged) nucleus
    this.orbitals.position.copy(center);
    this.orbitals.visible = tb && fCloud > 0.001;
    for (const o of this.orbitalMats) o.mat.opacity = o.base * fCloud;
    if (this.orbitals.visible) {
      for (const lb of this.orbitalLabels) {
        // inner shells get their label once they are big enough on screen
        const big = smooth(0.03, 0.08, lb.r / widthA);
        L.at(lb.text, lb.p.clone().add(center), this.microCam, fCloud * big, 'orb');
      }
    }
    const fNucBall = tb ? Math.max(fNucleusDot, smooth(0.3, 0.8, fCloud) * band(w, 3e-13, Infinity)) : 0;
    this.nucBall.visible = fNucBall > 0.001;
    this.nucBall.position.copy(center);
    this.nucBall.scale.setScalar(Math.max(widthA * 0.012, 1e-5));
    (this.nucBall.material as THREE.Material).opacity = fNucBall;
    if (fNucBall > 0.3) L.at(this.t_('zoom.tb.nucleus'), center, this.microCam, fNucBall, 'nuc');

    // the nucleus, not to scale, as a bright point
    this.nucleusDot.set(0, center.x, center.y, center.z, Math.max(widthA * 0.012, 1e-5), new THREE.Color(1, 0.75, 0.6), 1.5 * fNucleusDot);
    this.nucleusDot.commit(fNucleusDot > 0.001 && !tb ? 1 : 0);

    // ---------- nuclear scene (fm) ----------
    const widthF = w * 1e15;
    // quarks: three valence quarks bound by the colour field
    for (const qk of this.quarkState) {
      // confined random motion inside the proton radius (0.84 fm), frozen at the quark level so it stays framed
      const jiggle = 1 - fQuarkLevel;
      qk.v.add(new THREE.Vector3(this.rng.gauss(), this.rng.gauss(), this.rng.gauss()).multiplyScalar(dt * 6 * jiggle));
      qk.v.addScaledVector(qk.p, -dt * 12);
      qk.v.multiplyScalar(Math.exp(-dt * (1.5 + 30 * fQuarkLevel)));
      qk.p.addScaledVector(qk.v, dt);
    }
    // At the quark level the camera centres on the first up quark.
    const q0 = this.quarkState[0].p;
    const targetN = q0.clone().multiplyScalar(fQuarkLevel);
    const dirN = this.microCam.position.clone().sub(this.controls.target).normalize();
    this.nuclearCam.position.copy(targetN).addScaledVector(dirN, widthF / 2 / TAN);
    this.nuclearCam.lookAt(targetN);
    this.nuclearCam.near = Math.max(1e-7, widthF * 0.02);
    this.nuclearCam.far = widthF * 50 + 50;
    this.nuclearCam.updateProjectionMatrix();

    let m = 0;
    this.tbNucleons.begin();
    this.tbCentre.begin();
    let labelP: THREE.Vector3 | null = null;
    let labelN: THREE.Vector3 | null = null;
    let bestP = -Infinity;
    let bestN = -Infinity;
    if (fNucleus > 0.001) {
      for (let i = 0; i < this.nucleonPos.length; i++) {
        const nu = this.nucleonPos[i];
        // Nucleons move at ~0.25 c inside the nucleus (Fermi motion): fast jitter.
        const j = 0.18;
        const x = nu.p.x + Math.sin(this.t * 7.1 + i) * j;
        const y = nu.p.y + Math.sin(this.t * 6.3 + i * 1.7) * j;
        const z = nu.p.z + Math.sin(this.t * 8.2 + i * 0.6) * j;
        if (tb) {
          const col = nu.proton ? new THREE.Color('#e8503a') : new THREE.Color('#9aa6b8');
          if (i === 0) this.tbCentre.ball(x, y, z, 0.8, col);
          else this.tbNucleons.ball(x, y, z, 0.8, col);
          // label the nucleons nearest the camera
          const facing = x * dirN.x + y * dirN.y + z * dirN.z;
          if (nu.proton && facing > bestP) {
            bestP = facing;
            labelP = new THREE.Vector3(x, y, z);
          } else if (!nu.proton && facing > bestN) {
            bestN = facing;
            labelN = new THREE.Vector3(x, y, z);
          }
        } else {
          // The centre proton dissolves into its quarks; its neighbours dim so the quarks stand out.
          const f = i === 0 ? fNucleus * (1 - fQuarks) : fNucleus * (1 - 0.75 * fQuarks);
          const col = nu.proton ? new THREE.Color(1, 0.42, 0.35) : new THREE.Color(0.55, 0.65, 0.85);
          this.nucleons.set(m++, x, y, z, 0.84 * 1.3, col, 0.35 * f);
        }
      }
    }
    this.nucleons.commit(m);
    // The camera ends up inside the nucleus: the other nucleons step aside before that, the centre proton stays.
    const fNucTb = tb ? fNucleus * smooth(Math.log10(4e-15), Math.log10(9e-15), Math.log10(w)) : 0;
    this.tbNucleons.commit(fNucTb);
    this.tbCentre.commit(tb ? fNucleus * smooth(Math.log10(2.6e-15), Math.log10(5e-15), Math.log10(w)) : 0);
    if (tb && fNucTb > 0.3) {
      const lift = (p: THREE.Vector3) => p.clone().addScaledVector(dirN, 0.9);
      if (labelP) L.at(this.t_('zoom.tb.proton'), lift(labelP), this.nuclearCam, fNucTb, 'p');
      if (labelN) L.at(this.t_('zoom.tb.neutron'), lift(labelN), this.nuclearCam, fNucTb, 'n');
    }

    // quarks, gluons and short-lived sea quark–antiquark pairs
    let q = 0;
    const gl: number[] = [];
    const sp: number[] = [];
    this.tbQuarks.begin();
    if (fQuarks > 0.001) {
      // Quarks are point-like: below ~1 fm of view they keep a fixed size on screen.
      const qR = tb ? Math.min(0.13, widthF * 0.04) : Math.min(0.22, widthF * 0.07);
      for (const qk of this.quarkState) {
        if (tb) this.tbQuarks.ball(qk.p.x, qk.p.y, qk.p.z, qR, qk.color);
        else this.quarks.set(q++, qk.p.x, qk.p.y, qk.p.z, qR, qk.color, 1.2 * fQuarks);
      }
      // gluon field: a Y-shaped flux tube between the three quarks (springs in the textbook)
      const cen = this.quarkState.reduce((s, x) => s.add(x.p), new THREE.Vector3()).divideScalar(3);
      for (const qk of this.quarkState) {
        if (tb) spring(sp, cen, qk.p, 0.045, 7);
        else gl.push(cen.x, cen.y, cen.z, qk.p.x, qk.p.y, qk.p.z);
      }
      // Sea pairs pop out of the gluon field everywhere; at the quark level they swarm around the quark at every
      // scale you look (virtual particles), but the quark itself shows no inner structure.
      const near = fQuarkLevel > 0.05;
      if (this.rng.next() < dt * (near ? 30 : 4)) {
        const scale = near ? widthF * 0.35 : 0.35;
        const p = new THREE.Vector3(this.rng.gauss(), this.rng.gauss(), this.rng.gauss()).multiplyScalar(scale);
        if (near) p.add(q0);
        const axis = new THREE.Vector3(this.rng.gauss(), this.rng.gauss(), this.rng.gauss()).normalize();
        this.seaPairs.push({ p, life: 0.5, color: new THREE.Color().setHSL(this.rng.next(), 0.7, 0.6), size: near ? widthF * 0.015 : 0.06, axis });
      }
      this.seaPairs = this.seaPairs.filter((s) => (s.life -= dt) > 0).slice(-150);
      for (const s of this.seaPairs) {
        const a = s.p.clone().addScaledVector(s.axis, s.size);
        const b = s.p.clone().addScaledVector(s.axis, -s.size);
        if (tb) {
          this.tbQuarks.ball(a.x, a.y, a.z, s.size * 0.8, s.color);
          this.tbQuarks.ball(b.x, b.y, b.z, s.size * 0.8, new THREE.Color(1, 1, 1).sub(s.color));
        } else {
          this.quarks.set(q++, a.x, a.y, a.z, s.size * 1.5, s.color, s.life * 2 * fQuarks);
          this.quarks.set(q++, b.x, b.y, b.z, s.size * 1.5, s.color, s.life * 2 * fQuarks);
        }
      }
      // the proton's own boundary glow
      if (!tb) this.quarks.set(q++, 0, 0, 0, 0.84 * 1.4, new THREE.Color(1, 0.6, 0.4), 0.12 * fQuarks * (1 - fQuarkLevel));

      if (tb) {
        const fl = fQuarks * (1 - fQuarkLevel);
        this.quarkState.forEach((qk, i) => {
          const text = qk.flavor === 'u' ? 'u  +⅔e' : 'd  −⅓e';
          const op = i === 0 ? fQuarks : fl;
          L.at(i === 0 && fQuarkLevel > 0.5 ? this.t_('zoom.tb.quarkPoint') : text, qk.p, this.nuclearCam, op, `q${i}`);
        });
        const mid = cen.clone().lerp(this.quarkState[1].p, 0.5);
        L.at(this.t_('zoom.tb.gluon'), mid, this.nuclearCam, fl, 'gl');
        const oldest = this.seaPairs.find((s) => s.life > 0.15 && s.p.distanceTo(cen) < (fQuarkLevel > 0.05 ? Infinity : 0.9));
        if (oldest) L.at(this.t_('zoom.tb.sea'), oldest.p, this.nuclearCam, fQuarks, 'sea');
        L.at(this.t_('zoom.tb.protonEdge'), new THREE.Vector3(0, 0.84, 0).applyQuaternion(this.nuclearCam.quaternion), this.nuclearCam, fl, 'edge');
      }
    }
    this.quarks.commit(q);
    this.tbQuarks.commit(tb ? fQuarks : 0);
    this.gluons.geometry.setAttribute('position', new THREE.Float32BufferAttribute(gl, 3));
    (this.gluons.material as THREE.LineBasicMaterial).opacity = 0.7 * fQuarks;
    this.gluons.visible = !tb && fQuarks > 0.001;
    this.springs.geometry.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    (this.springs.material as THREE.LineBasicMaterial).opacity = fQuarks * (1 - fQuarkLevel * 0.8);
    this.springs.visible = tb && fQuarks > 0.001;
    this.protonShell.visible = tb && fQuarks > 0.001;
    (this.protonShell.material as THREE.Material).opacity = 0.12 * fQuarks * (1 - fQuarkLevel);
    L.end();
    this.fBulk = fBulk;
  }

  private fBulk = 0;

  render(renderer: THREE.WebGPURenderer) {
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clear();
    // Under an opaque bulk layer the molecules are not drawn at all.
    if (this.fBulk < 0.999) renderer.render(this.microScene, this.microCam);
    if (this.fBulk > 0.001) this.bulk.render(renderer);
    if (this.width < 2e-12) {
      renderer.clearDepth();
      renderer.render(this.nuclearScene, this.nuclearCam);
    }
    renderer.autoClear = auto;
  }

  resize(aspect: number) {
    this.aspect = aspect;
    for (const cam of [this.microCam, this.nuclearCam]) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
  }
}

/** A coil from a to b (line-segment pairs appended to `out`): a gluon drawn as a spring. */
function spring(out: number[], a: THREE.Vector3, b: THREE.Vector3, radius: number, turns: number) {
  const axis = b.clone().sub(a);
  const len = axis.length();
  if (len < 1e-6) return;
  axis.divideScalar(len);
  const u = new THREE.Vector3(1, 0, 0).cross(axis);
  if (u.lengthSq() < 1e-4) u.set(0, 1, 0).cross(axis);
  u.normalize();
  const v = axis.clone().cross(u);
  const steps = turns * 12;
  let prev = a.clone();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const th = t * turns * Math.PI * 2;
    // taper the coil to zero at both ends so it attaches to the quarks
    const r = radius * Math.sin(Math.PI * t);
    const p = a.clone().addScaledVector(axis, t * len).addScaledVector(u, Math.cos(th) * r).addScaledVector(v, Math.sin(th) * r);
    out.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
    prev = p;
  }
}
