import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { ROOM, TABLE } from '../render/macro/lab';
import type { CameraMode } from '../ui/store';

const EYE_HEIGHT = 1.65;
const MIN_EYE = 0.5;
const MAX_EYE = 2.3;
const WALK_SPEED = 1.6;
const RUN_SPEED = 3.5;
const BODY_RADIUS = 0.25;
const WALL_MARGIN = 0.3;
export const FOCUS_MIN_DISTANCE = 0.04;

export interface RigEvents {
  onMode(mode: CameraMode): void;
  onLock(locked: boolean): void;
}

/** One camera, two controllers: orbit around the bench, or walk around the room. */
export class CameraRig {
  mode: CameraMode = 'orbit';
  readonly orbit: OrbitControls;
  readonly fps: PointerLockControls;
  private keys = new Set<string>();
  private saved = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private focusGoal: THREE.Vector3 | null = null;

  constructor(private camera: THREE.PerspectiveCamera, dom: HTMLElement, private ev: RigEvents) {
    camera.position.set(1.1, 1.55, 1.3);
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.target.set(0, TABLE.top + 0.05, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 0.15;
    this.orbit.maxDistance = 3.2;
    this.orbit.maxPolarAngle = Math.PI * 0.49;
    this.orbit.update();

    this.fps = new PointerLockControls(camera, dom);
    this.fps.enabled = false;
    this.fps.addEventListener('lock', () => ev.onLock(true));
    this.fps.addEventListener('unlock', () => ev.onLock(false));
    dom.addEventListener('click', () => {
      if (this.mode === 'fps' && this.fps.enabled && !this.fps.isLocked) this.fps.lock();
    });
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  toggle() {
    this.setMode(this.mode === 'orbit' ? 'fps' : 'orbit');
  }

  setMode(mode: CameraMode) {
    if (mode === this.mode) return;
    const cam = this.camera;
    if (mode === 'fps') {
      this.saved.pos.copy(cam.position);
      this.saved.target.copy(this.orbit.target);
      this.orbit.enabled = false;
      // Stand where the orbit camera was, at eye height, looking at the same point.
      cam.position.y = EYE_HEIGHT;
      this.clampBody(cam.position);
      cam.lookAt(this.saved.target);
      this.fps.enabled = true;
    } else {
      if (this.fps.isLocked) this.fps.unlock();
      this.fps.enabled = false;
      cam.position.copy(this.saved.pos);
      this.orbit.target.copy(this.saved.target);
      this.orbit.enabled = true;
      this.orbit.update();
    }
    this.mode = mode;
    this.ev.onMode(mode);
  }

  /** Detach from input while another view (e.g. the atom builder) owns the canvas. */
  setEnabled(enabled: boolean) {
    this.releasePointer();
    this.orbit.enabled = enabled && this.mode === 'orbit';
    this.fps.enabled = enabled && this.mode === 'fps';
    if (!enabled) this.keys.clear();
  }

  releasePointer() {
    if (this.fps.isLocked) this.fps.unlock();
  }

  /**
   * Orbit around picked matter so the wheel can close in on it (down to 4 cm, where the zoom view takes
   * over); null goes back to orbiting the bench.
   */
  focus(point: THREE.Vector3 | null) {
    this.focusGoal = point ? point.clone() : null;
    this.orbit.minDistance = point ? FOCUS_MIN_DISTANCE : 0.15;
  }

  /** Orbit distance, or Infinity in first person. */
  distance(): number {
    return this.mode === 'orbit' ? this.camera.position.distanceTo(this.orbit.target) : Infinity;
  }

  update(dt: number) {
    if (this.mode === 'orbit') {
      if (this.focusGoal) {
        // Glide the orbit centre to the picked point; the camera moves along so the view doesn't jump.
        const step = this.focusGoal.clone().sub(this.orbit.target).multiplyScalar(1 - Math.exp(-dt * 6));
        this.orbit.target.add(step);
        this.camera.position.add(step);
        if (this.orbit.target.distanceTo(this.focusGoal) < 1e-4) this.focusGoal = null;
      }
      this.orbit.update();
      return;
    }
    if (!this.fps.isLocked) return;
    const k = this.keys;
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? RUN_SPEED : WALK_SPEED) * dt;
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const up = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (fwd || side) {
      const len = Math.hypot(fwd, side);
      this.fps.moveForward((fwd / len) * speed);
      this.fps.moveRight((side / len) * speed);
    }
    const p = this.camera.position;
    p.y = THREE.MathUtils.clamp(p.y + up * WALK_SPEED * dt, MIN_EYE, MAX_EYE);
    this.clampBody(p);
  }

  /** Keeps the walker inside the room and out of the bench (until stage 4 brings real colliders). */
  private clampBody(p: THREE.Vector3) {
    p.x = THREE.MathUtils.clamp(p.x, -ROOM.halfX + WALL_MARGIN, ROOM.halfX - WALL_MARGIN);
    p.z = THREE.MathUtils.clamp(p.z, -ROOM.halfZ + WALL_MARGIN, ROOM.halfZ - WALL_MARGIN);
    const hx = TABLE.halfX + BODY_RADIUS;
    const hz = TABLE.halfZ + BODY_RADIUS;
    const dx = p.x - TABLE.x;
    const dz = p.z - TABLE.z;
    if (Math.abs(dx) < hx && Math.abs(dz) < hz && p.y < TABLE.top + 1.2) {
      const penX = hx - Math.abs(dx);
      const penZ = hz - Math.abs(dz);
      if (penX < penZ) p.x = TABLE.x + Math.sign(dx || 1) * hx;
      else p.z = TABLE.z + Math.sign(dz || 1) * hz;
    }
  }
}
