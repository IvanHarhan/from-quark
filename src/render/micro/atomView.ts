import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ionConfig, shellCounts } from '../../chem/aufbau';
import type { Emitted } from '../../nuclear/decay';

/** Stylised Bohr-like picture: not to scale (a real atom is ~10⁵ times larger than its nucleus). */

const MAX_NUCLEONS = 300;
const MAX_ELECTRONS = 130;
const NUCLEON_R = 0.5;
const ELECTRON_R = 0.2;
const MAX_SHELLS = 7;

const COLORS = {
  proton: 0xff4a4a,
  neutron: 0xa9b4c2,
  electron: 0x4fb8ff,
  positron: 0xff6ad5,
  neutrino: 0xffffff,
  gamma: 0xfff27a,
  fragment: 0xffa24a,
};

/**
 * Concentric Fibonacci-sphere shells: the first A points form a round nucleus (a cubic lattice looks like a box).
 * Within a shell the points are taken in a strided order so a partly filled outer shell stays evenly spread.
 */
const PACKING: THREE.Vector3[] = (() => {
  const pts: THREE.Vector3[] = [new THREE.Vector3()];
  const gap = NUCLEON_R * 1.7;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let k = 1; pts.length < MAX_NUCLEONS; k++) {
    const r = k * gap;
    const n = Math.max(4, Math.floor((4 * Math.PI * r * r) / (gap * gap * 1.1)));
    const shell: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const y = 1 - ((i + 0.5) / n) * 2;
      const rad = Math.sqrt(1 - y * y);
      const t = i * golden + k;
      shell.push(new THREE.Vector3(Math.cos(t) * rad * r, y * r, Math.sin(t) * rad * r));
    }
    let stride = Math.round(n * 0.618);
    while (gcd(stride, n) !== 1) stride++;
    for (let i = 0; i < n; i++) pts.push(shell[(i * stride) % n]);
  }
  return pts.slice(0, MAX_NUCLEONS);
})();

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

interface Flying {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

export class AtomView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  readonly controls: OrbitControls;

  private protons: THREE.InstancedMesh;
  private neutrons: THREE.InstancedMesh;
  private electrons: THREE.InstancedMesh;
  private rings: THREE.Line[] = [];
  private ringTilt: THREE.Quaternion[] = [];
  private nucleonPos: { pos: THREE.Vector3; proton: boolean }[] = [];
  private shells: number[] = [];
  private nucleusRadius = 0;
  private time = 0;
  private flash: THREE.Mesh;
  private flashLife = 0;
  private flying: Flying[] = [];
  private key = '';
  private framedRadius = 0;
  private wantDistance = 0;
  private m = new THREE.Matrix4();
  private v = new THREE.Vector3();

  constructor(dom: HTMLElement) {
    this.scene.background = new THREE.Color(0x05070c);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(5, 8, 6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fa8ff, 1.2);
    rim.position.set(-6, -3, -5);
    this.scene.add(rim);

    const sphere = new THREE.SphereGeometry(1, 24, 16);
    const mat = (color: number, glow: number) =>
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: glow, roughness: 0.35, metalness: 0.1 });
    this.protons = new THREE.InstancedMesh(sphere, mat(COLORS.proton, 0.35), MAX_NUCLEONS);
    this.neutrons = new THREE.InstancedMesh(sphere, mat(COLORS.neutron, 0.12), MAX_NUCLEONS);
    this.electrons = new THREE.InstancedMesh(sphere, mat(COLORS.electron, 1.6), MAX_ELECTRONS);
    for (const im of [this.protons, this.neutrons, this.electrons]) {
      im.count = 0;
      im.frustumCulled = false;
      this.scene.add(im);
    }

    const circle = new THREE.BufferGeometry().setFromPoints(
      // 129 points with the last == first: WebGPU has no LineLoop, so close the circle by hand.
      Array.from({ length: 129 }, (_, i) => {
        const a = (i / 128) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      }),
    );
    for (let n = 0; n < MAX_SHELLS; n++) {
      const ring = new THREE.Line(
        circle,
        new THREE.LineBasicMaterial({ color: COLORS.electron, transparent: true, opacity: 0.28 }),
      );
      // Golden-angle tilts so shells don't overlap in projection.
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35 + n * 0.5, n * 2.399, 0.2 * n));
      ring.quaternion.copy(q);
      this.ringTilt.push(q);
      this.rings.push(ring);
      this.scene.add(ring);
    }

    this.flash = new THREE.Mesh(
      sphere,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.scene.add(this.flash);

    this.camera.position.set(0, 4, 14);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 120;
    this.controls.enabled = false;
  }

  setActive(active: boolean) {
    this.controls.enabled = active;
  }

  /** Rebuilds geometry when the particle counts change. */
  sync(z: number, n: number, e: number) {
    const key = `${z}:${n}:${e}`;
    if (key === this.key) return;
    this.key = key;
    const a = z + n;

    const pts = PACKING.slice(0, a);
    const c = new THREE.Vector3();
    for (const p of pts) c.add(p);
    if (a) c.divideScalar(a);
    // Protons spread evenly through the packing order instead of clumping.
    this.nucleonPos = pts.map((p, i) => ({
      pos: p.clone().sub(c),
      proton: Math.floor(((i + 1) * z) / a) > Math.floor((i * z) / a),
    }));
    this.nucleusRadius = this.nucleonPos.reduce((r, p) => Math.max(r, p.pos.length()), 0) + NUCLEON_R;

    this.shells = e > 0 ? shellCounts(ionConfig(z, e)) : [];
    this.rings.forEach((r, i) => {
      r.visible = i < this.shells.length && this.shells[i] > 0;
      r.scale.setScalar(this.shellRadius(i));
    });

    const outer = this.shells.length ? this.shellRadius(this.shells.length - 1) : Math.max(this.nucleusRadius, 1.5);
    if (Math.abs(outer - this.framedRadius) > 0.01) {
      this.framedRadius = outer;
      this.wantDistance = outer * 2.6 + 3;
    }
  }

  private shellRadius(i: number) {
    return this.nucleusRadius + 1.6 + i * 1.5;
  }

  onDecay(emitted: Emitted[], electronCaptured: boolean) {
    this.flashLife = 1;
    for (const em of emitted) this.spawn(em);
    if (electronCaptured && this.shells.length) {
      // The captured electron falls into the nucleus from the innermost shell.
      const mesh = this.particleMesh(COLORS.electron, ELECTRON_R);
      const dir = this.randomDir();
      mesh.position.copy(dir).multiplyScalar(this.shellRadius(0));
      this.scene.add(mesh);
      this.flying.push({ obj: mesh, vel: dir.multiplyScalar(-this.shellRadius(0) / 0.6), life: 0.6, maxLife: 0.6 });
    }
  }

  private spawn(em: Emitted) {
    let obj: THREE.Object3D;
    let speed = 6;
    switch (em.kind) {
      case 'alpha':
      case 'deuteron':
      case 'triton': {
        const [p, n] = em.kind === 'alpha' ? [2, 2] : em.kind === 'deuteron' ? [1, 1] : [1, 2];
        obj = this.cluster(p, n);
        break;
      }
      case 'fragment':
        obj = this.particleMesh(COLORS.fragment, NUCLEON_R * Math.cbrt(em.a) * 0.9);
        speed = 3;
        break;
      case 'electron':
        obj = this.particleMesh(COLORS.electron, ELECTRON_R * 1.3);
        speed = 12;
        break;
      case 'positron':
        obj = this.particleMesh(COLORS.positron, ELECTRON_R * 1.3);
        speed = 12;
        break;
      case 'neutrino':
      case 'antineutrino':
        obj = this.particleMesh(COLORS.neutrino, 0.08);
        speed = 22;
        break;
      case 'gamma':
        obj = this.particleMesh(COLORS.gamma, 0.15);
        obj.scale.set(0.15, 0.15, 1.2);
        speed = 28;
        break;
      case 'neutron':
        obj = this.particleMesh(COLORS.neutron, NUCLEON_R);
        break;
      case 'proton':
        obj = this.particleMesh(COLORS.proton, NUCLEON_R);
        break;
    }
    const dir = this.randomDir();
    obj.position.copy(dir).multiplyScalar(this.nucleusRadius * 0.6);
    obj.lookAt(dir.clone().multiplyScalar(100));
    this.scene.add(obj);
    this.flying.push({ obj, vel: dir.multiplyScalar(speed), life: 3, maxLife: 3 });
  }

  private cluster(p: number, n: number): THREE.Group {
    const g = new THREE.Group();
    PACKING.slice(0, p + n).forEach((pos, i) => {
      const m = this.particleMesh(i < p ? COLORS.proton : COLORS.neutron, NUCLEON_R);
      m.position.copy(pos);
      g.add(m);
    });
    return g;
  }

  private particleMesh(color: number, r: number): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 16, 12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, transparent: true }),
    );
    return m;
  }

  private randomDir(): THREE.Vector3 {
    // Visual only, so Math.random is fine here; simulation randomness lives in the seeded Rng.
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    return new THREE.Vector3(s * Math.cos(t), u, s * Math.sin(t));
  }

  /**
   * @param timeScale game-time speed: electrons and nucleon jitter visibly speed up with it (log scale —
   * real electron motion is ~10¹⁶ rad/s and cannot be shown literally at any speed).
   */
  update(dt: number, timeScale = 1) {
    this.time += dt * (1 + Math.log10(Math.max(1, timeScale)) * 0.6);
    const t = this.time;

    let ip = 0;
    let ineu = 0;
    for (let i = 0; i < this.nucleonPos.length; i++) {
      const { pos, proton } = this.nucleonPos[i];
      // Gentle jitter: nucleons are never at rest.
      this.v.set(Math.sin(t * 3.1 + i), Math.sin(t * 2.7 + i * 1.7), Math.sin(t * 3.7 + i * 0.6)).multiplyScalar(0.03).add(pos);
      this.m.makeScale(NUCLEON_R, NUCLEON_R, NUCLEON_R).setPosition(this.v);
      if (proton) this.protons.setMatrixAt(ip++, this.m);
      else this.neutrons.setMatrixAt(ineu++, this.m);
    }
    this.protons.count = ip;
    this.neutrons.count = ineu;
    this.protons.instanceMatrix.needsUpdate = true;
    this.neutrons.instanceMatrix.needsUpdate = true;

    let ie = 0;
    this.shells.forEach((count, n) => {
      const r = this.shellRadius(n);
      const w = 1.4 / (n + 1);
      for (let k = 0; k < count && ie < MAX_ELECTRONS; k++) {
        const a = t * w + (k / count) * Math.PI * 2;
        this.v.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(this.ringTilt[n]);
        this.m.makeScale(ELECTRON_R, ELECTRON_R, ELECTRON_R).setPosition(this.v);
        this.electrons.setMatrixAt(ie++, this.m);
      }
    });
    this.electrons.count = ie;
    this.electrons.instanceMatrix.needsUpdate = true;

    if (this.flashLife > 0) {
      this.flashLife = Math.max(0, this.flashLife - dt * 1.8);
      const k = 1 - this.flashLife;
      this.flash.scale.setScalar(this.nucleusRadius * (1 + k * 3));
      (this.flash.material as THREE.MeshBasicMaterial).opacity = this.flashLife * 0.8;
    }

    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.life -= dt;
      f.obj.position.addScaledVector(f.vel, dt);
      const fade = Math.max(0, f.life / f.maxLife);
      f.obj.traverse((o) => {
        if (o instanceof THREE.Mesh) (o.material as THREE.MeshStandardMaterial).opacity = Math.min(1, fade * 2);
      });
      if (f.life <= 0) {
        this.scene.remove(f.obj);
        f.obj.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
        this.flying.splice(i, 1);
      }
    }

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
