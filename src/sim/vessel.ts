/**
 * Kinematic lab vessel (beaker). Its pose is driven by the player (tilt to pour, shake); the MPM grid
 * collides against its signed distance field. Units: metres, seconds; local frame has y up and the origin
 * at the centre of the outer bottom.
 */
export interface VesselShape {
  innerRadius: number;
  height: number;
  wall: number;
  bottom: number;
}

/** 1 L laboratory beaker (Ø ~10.6 cm outer, 14 cm tall). */
export const BEAKER_1L: VesselShape = { innerRadius: 0.05, height: 0.14, wall: 0.003, bottom: 0.004 };

export function innerVolume(s: VesselShape): number {
  return Math.PI * s.innerRadius ** 2 * (s.height - s.bottom);
}

/** Signed distance to the vessel walls in its local frame (negative inside glass). */
export function vesselSdf(s: VesselShape, x: number, y: number, z: number): number {
  const r = Math.hypot(x, z);
  const outerR = s.innerRadius + s.wall;
  // Solid capped cylinder…
  const dOuter = Math.max(r - outerR, -y, y - s.height);
  // …minus the cavity, open at the top.
  const dCavity = Math.max(r - s.innerRadius, s.bottom - y);
  return Math.max(dOuter, -dCavity);
}

/** Static open-top tray (lab bath) standing on the table: inner footprint and rim height, metres. */
export interface Tray {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** World y of the tray floor (top of its base plate). */
  floorY: number;
  rim: number;
  wall: number;
}

/** Signed distance to the tray walls/base (negative inside material), world coordinates. */
export function traySdf(t: Tray, x: number, y: number, z: number): number {
  const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) => {
    const qx = Math.abs(x - cx) - hx;
    const qy = Math.abs(y - cy) - hy;
    const qz = Math.abs(z - cz) - hz;
    const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
    return out + Math.min(Math.max(qx, qy, qz), 0);
  };
  const cx = (t.minX + t.maxX) / 2;
  const cz = (t.minZ + t.maxZ) / 2;
  const hx = (t.maxX - t.minX) / 2;
  const hz = (t.maxZ - t.minZ) / 2;
  const outer = box(cx, t.floorY + t.rim / 2 - t.wall / 2, cz, hx + t.wall, (t.rim + t.wall) / 2, hz + t.wall);
  const cavity = box(cx, t.floorY + t.rim, cz, hx, t.rim, hz);
  return Math.max(outer, -cavity);
}

export interface VesselPose {
  /** Bottom centre, world. */
  x: number;
  y: number;
  z: number;
  /** Tilt about the world z axis, radians; positive pours towards +x. */
  tilt: number;
}

export interface VesselState {
  shape: VesselShape;
  /** Resting position on the table. */
  home: { x: number; y: number; z: number };
  pose: VesselPose;
  /** Linear velocity of the local origin, m/s, and angular velocity about z, rad/s. */
  vel: { x: number; y: number; z: number; w: number };
  /** Target tilt set by the player, radians. */
  targetTilt: number;
  shakeTime: number;
  /** 0..1, eases towards 1 while shaking and back to 0 after. */
  shakeAmp: number;
  shaking: boolean;
}

export const MAX_TILT = (125 * Math.PI) / 180;
const TILT_SPEED = 1.4; // rad/s
// Below the first sloshing mode of 0.7 L in this beaker (~3 Hz), so the water sloshes without leaving.
const SHAKE_FREQ = 2; // Hz
const SHAKE_AMP = 0.008; // m
const SHAKE_EASE = 0.4; // s

export function createVessel(shape: VesselShape, x: number, y: number, z: number): VesselState {
  return {
    shape,
    home: { x, y, z },
    pose: { x, y, z, tilt: 0 },
    vel: { x: 0, y: 0, z: 0, w: 0 },
    targetTilt: 0,
    shakeTime: 0,
    shakeAmp: 0,
    shaking: false,
  };
}

/**
 * Advances the pose by dt. Tilting pivots about the pouring lip (top rim on the +x side) so the vessel
 * lifts off the table the way a hand would hold it.
 */
export function stepVessel(v: VesselState, dt: number) {
  const prev = { ...v.pose };
  const dTilt = Math.max(-TILT_SPEED * dt, Math.min(TILT_SPEED * dt, v.targetTilt - v.pose.tilt));
  const tilt = v.pose.tilt + dTilt;

  // Pivot = lip in the untilted frame; rotate the bottom centre about it.
  const lipX = v.shape.innerRadius + v.shape.wall;
  const lipY = v.shape.height;
  const c = Math.cos(-tilt);
  const s = Math.sin(-tilt);
  const ox = -lipX;
  const oy = -lipY;
  let x = v.home.x + lipX + ox * c - oy * s;
  const y = v.home.y + lipY + ox * s + oy * c;
  let z = v.home.z;

  // Amplitude eases in and out so the glass never jumps.
  v.shakeAmp = Math.max(0, Math.min(1, v.shakeAmp + (v.shaking ? dt : -dt) / SHAKE_EASE));
  if (v.shakeAmp > 0) {
    v.shakeTime += dt;
    const ph = 2 * Math.PI * SHAKE_FREQ * v.shakeTime;
    x += SHAKE_AMP * v.shakeAmp * Math.sin(ph);
    z += SHAKE_AMP * v.shakeAmp * 0.6 * Math.sin(ph * 1.3);
  } else {
    v.shakeTime = 0;
  }

  v.pose = { x, y: Math.max(v.home.y, y), z, tilt };
  v.vel = dt > 0
    ? { x: (v.pose.x - prev.x) / dt, y: (v.pose.y - prev.y) / dt, z: (v.pose.z - prev.z) / dt, w: (tilt - prev.tilt) / dt }
    : { x: 0, y: 0, z: 0, w: 0 };
}

/** World point → vessel local frame (inverse of translate then rotate about z by -tilt). */
export function worldToVessel(p: VesselPose, x: number, y: number, z: number): [number, number, number] {
  const dx = x - p.x;
  const dy = y - p.y;
  const c = Math.cos(p.tilt);
  const s = Math.sin(p.tilt);
  return [dx * c - dy * s, dx * s + dy * c, z - p.z];
}
