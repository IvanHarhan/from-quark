import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { element } from '../../data/db';
import { validate, type Molecule } from '../../chem/molecule';
import type { Positions } from '../../chem/geometry';

/** Ball-and-stick view, CPK colours, ångström units. */

const BOND_R = 0.075;
const MULTI_OFFSET = 0.11;

const atomRadius = (z: number) => 0.16 + (element(z)?.covalentRadius[0] ?? 120) * 0.0022;

const ERROR_HALO = new THREE.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.3, depthWrite: false });

const labelCache = new Map<string, THREE.SpriteMaterial>();
function labelMaterial(text: string): THREE.SpriteMaterial {
  let m = labelCache.get(text);
  if (!m) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.font = 'bold 64px Segoe UI, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 10;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.strokeText(text, 64, 68);
    g.fillStyle = '#ffffff';
    g.fillText(text, 64, 68);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    labelCache.set(text, m);
  }
  return m;
}

export interface MoleculeViewEvents {
  onPick(atom: number | null): void;
  onHover(atom: number | null): void;
}

export class MoleculeView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
  readonly controls: OrbitControls;

  private root = new THREE.Group();
  private atomMeshes: THREE.Mesh[] = [];
  private labels: THREE.Sprite[] = [];
  private shown: THREE.Vector3[] = [];
  private targets: THREE.Vector3[] = [];
  private bondData: { a: number; b: number; order: number; meshes: THREE.Mesh[] }[] = [];
  private selection: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private errorHalos: THREE.Mesh[] = [];
  private selected: number | null = null;
  private hovered: number | null = null;
  private molecule: Molecule | null = null;
  private active = false;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private down = { x: 0, y: 0 };
  private cylinder = new THREE.CylinderGeometry(1, 1, 1, 14, 1);
  private sphere = new THREE.SphereGeometry(1, 32, 20);
  private materials = new Map<number, THREE.MeshStandardMaterial>();
  private wantDistance = 0;

  constructor(private dom: HTMLElement, private ev: MoleculeViewEvents) {
    this.scene.background = new THREE.Color(0x070a10);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(4, 6, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fb2ff, 1.0);
    rim.position.set(-5, -2, -4);
    this.scene.add(rim);
    this.scene.add(this.root);

    const halo = (color: number, opacity: number) =>
      new THREE.Mesh(this.sphere, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    this.selection = halo(0x5ec8ff, 0.35);
    this.hoverRing = halo(0xffffff, 0.15);
    this.selection.visible = this.hoverRing.visible = false;
    this.scene.add(this.selection, this.hoverRing);

    this.camera.position.set(0, 1.5, 8);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 60;
    this.controls.enabled = false;

    dom.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }));
    dom.addEventListener('pointerup', (e) => {
      if (!this.active || e.button !== 0) return;
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) return;
      this.ev.onPick(this.pick(e));
    });
    dom.addEventListener('pointermove', (e) => {
      if (this.active) this.ev.onHover(this.pick(e));
    });
  }

  setActive(active: boolean) {
    this.active = active;
    this.controls.enabled = active;
  }

  private pick(e: PointerEvent): number | null {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const hit = this.ray.intersectObjects(this.atomMeshes, false)[0];
    return hit ? this.atomMeshes.indexOf(hit.object as THREE.Mesh) : null;
  }

  private material(z: number): THREE.MeshStandardMaterial {
    let m = this.materials.get(z);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: element(z)?.cpk ?? '#ff1493', roughness: 0.35, metalness: 0.05 });
      this.materials.set(z, m);
    }
    return m;
  }

  /** Rebuilds meshes for a new molecule; positions animate from where atoms were (new ones grow from the selection). */
  sync(m: Molecule, positions: Positions, selected: number | null, hovered: number | null) {
    this.selected = selected;
    this.hovered = hovered;
    if (m === this.molecule) return;
    const prevShown = this.shown;
    const prevCount = this.molecule?.atoms.length ?? 0;
    this.molecule = m;

    this.root.clear();
    this.atomMeshes = [];
    this.labels = [];
    this.bondData = [];
    this.errorHalos = [];
    const n = m.atoms.length;
    this.targets = Array.from({ length: n }, (_, i) => new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
    // Same-length edits (bond/charge changes) keep atom identity; deletions shift indices, so start from targets.
    const spawn = selected !== null && prevShown[selected] ? prevShown[selected] : new THREE.Vector3();
    this.shown = this.targets.map((t, i) =>
      i < prevCount && n >= prevCount && prevShown[i] ? prevShown[i].clone() : n < prevCount ? t.clone() : spawn.clone(),
    );

    m.atoms.forEach((a) => {
      const mesh = new THREE.Mesh(this.sphere, this.material(a.z));
      mesh.scale.setScalar(atomRadius(a.z));
      this.root.add(mesh);
      this.atomMeshes.push(mesh);
      const sym = element(a.z)!.symbol;
      const q = a.charge === 0 ? '' : `${Math.abs(a.charge) > 1 ? Math.abs(a.charge) : ''}${a.charge > 0 ? '+' : '−'}`;
      const label = new THREE.Sprite(labelMaterial(sym + q));
      label.scale.setScalar(0.42);
      label.renderOrder = 2;
      this.root.add(label);
      this.labels.push(label);
    });

    for (const b of m.bonds) {
      const meshes: THREE.Mesh[] = [];
      for (let k = 0; k < b.order; k++) {
        for (const end of [b.a, b.b]) {
          const mesh = new THREE.Mesh(this.cylinder, this.material(m.atoms[end].z));
          this.root.add(mesh);
          meshes.push(mesh);
        }
      }
      this.bondData.push({ a: b.a, b: b.b, order: b.order, meshes });
    }

    const v = validate(m);
    const bad = new Set(v.errors.flatMap((e) => ('atom' in e ? [e.atom] : [])));
    for (const i of bad) {
      const h = new THREE.Mesh(this.sphere, ERROR_HALO);
      h.userData.atom = i;
      this.root.add(h);
      this.errorHalos.push(h);
    }

    let radius = 1;
    for (const t of this.targets) radius = Math.max(radius, t.length() + 0.6);
    this.wantDistance = radius * 2.8 + 2;
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt * 10);
    this.shown.forEach((p, i) => p.lerp(this.targets[i], k));

    const camDir = new THREE.Vector3();
    this.atomMeshes.forEach((mesh, i) => {
      mesh.position.copy(this.shown[i]);
      const r = mesh.scale.x;
      camDir.subVectors(this.camera.position, mesh.position).normalize();
      this.labels[i].position.copy(mesh.position).addScaledVector(camDir, r + 0.05);
    });

    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (const b of this.bondData) {
      const pa = this.shown[b.a];
      const pb = this.shown[b.b];
      dir.subVectors(pb, pa);
      const len = dir.length();
      if (len < 1e-6) continue;
      dir.divideScalar(len);
      side.crossVectors(dir, camDir.subVectors(this.camera.position, pa).normalize());
      if (side.lengthSq() < 1e-6) side.crossVectors(dir, up);
      side.normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
      for (let k2 = 0; k2 < b.order; k2++) {
        const off = (k2 - (b.order - 1) / 2) * MULTI_OFFSET * 2;
        const r = b.order === 1 ? BOND_R : BOND_R * 0.6;
        for (let half = 0; half < 2; half++) {
          const mesh = b.meshes[k2 * 2 + half];
          const t0 = half === 0 ? 0 : 0.5;
          mesh.position.copy(pa).addScaledVector(dir, len * (t0 + 0.25)).addScaledVector(side, off);
          mesh.quaternion.copy(quat);
          mesh.scale.set(r, len / 2, r);
        }
      }
    }

    for (const h of this.errorHalos) {
      const i = h.userData.atom as number;
      h.position.copy(this.shown[i]);
      h.scale.setScalar(this.atomMeshes[i].scale.x * 1.6);
    }
    const ring = (mesh: THREE.Mesh, i: number | null, grow: number) => {
      mesh.visible = i !== null && !!this.atomMeshes[i];
      if (mesh.visible) {
        mesh.position.copy(this.shown[i!]);
        mesh.scale.setScalar(this.atomMeshes[i!].scale.x * grow);
      }
    };
    ring(this.selection, this.selected, 1.45);
    ring(this.hoverRing, this.hovered, 1.3);

    if (this.wantDistance > 0) {
      const d = this.camera.position.distanceTo(this.controls.target);
      const next = THREE.MathUtils.damp(d, this.wantDistance, 4, dt);
      this.camera.position.sub(this.controls.target).setLength(next).add(this.controls.target);
      if (Math.abs(next - this.wantDistance) < 0.01) this.wantDistance = 0;
    }
    this.controls.update();
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
