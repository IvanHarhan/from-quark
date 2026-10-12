import * as THREE from 'three/webgpu';
import {
  Discard,
  Fn,
  clamp,
  dot,
  float,
  fract,
  int,
  max,
  min,
  mix,
  normalize,
  pow,
  select,
  sin,
  sqrt,
  uniformArray,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { GLOW_STEP, GLOW_STEPS, GLOW_T0, glowTable } from '../blackbody';
import { STATE, type MpmSolver } from '../../sim/mpm/gpuSolver';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Display gain for incandescence (the table is relative luminance; 1800 K ≈ 1 before this gain). */
const GLOW_GAIN = 1.6;
type N = any;

const hexToVec = (hex: string) => {
  const c = new THREE.Color(hex);
  return new THREE.Vector4(c.r, c.g, c.b, 1);
};

/**
 * MPM particles drawn straight from the GPU buffers as sphere impostors. Colour follows the particle's
 * material and phase (solid ↔ liquid blend), steam is a stochastic-transparent white puff, and hot matter
 * glows with blackbody colour (Planck × CIE). A screen-space liquid surface comes with the polish stage.
 */
export function createFluidSprites(solver: MpmSolver, steamOnly = false): THREE.Sprite {
  const d = solver.domain;
  const solid: N = uniformArray(solver.materials.map((m) => hexToVec(m.colors.solid)), 'vec4');
  const liquid: N = uniformArray(solver.materials.map((m) => hexToVec(m.colors.liquid)), 'vec4');
  const glow: N = uniformArray(glowTable().map(([r, g, b, t]) => new THREE.Vector4(r, g, b, t)), 'vec4');

  const info: N = solver.info.toAttribute();
  const mat = new THREE.SpriteNodeMaterial();
  mat.positionNode = solver.pos.toAttribute().xyz.mul(d.dx).add(vec3(...d.origin));
  mat.scaleNode = Fn(() => {
    const state = info.z;
    // With the screen-space surface on, only steam is drawn as sprites.
    return select(
      state.equal(STATE.dead),
      float(0),
      select(state.equal(STATE.steam), float(d.dx * 2.2).mul(float(1.6).sub(info.y)), float(steamOnly ? 0 : d.dx * 0.85)),
    );
  })();
  mat.colorNode = Fn(() => {
    const c = uv().mul(2).sub(1);
    const r2 = dot(c, c);
    Discard(r2.greaterThan(1));
    const state = info.z;
    const mi = int(info.w);

    // Steam: dithered transparency fading with life.
    const hash = fract(sin(dot(c.add(info.x), vec2(12.9898, 78.233))).mul(43758.5453));
    Discard(state.equal(STATE.steam).and(hash.greaterThan(info.y.mul(0.5).mul(float(1).sub(r2)))));

    const n = vec3(c.x, c.y, sqrt(float(1).sub(r2)));
    const l = normalize(vec3(0.35, 0.75, 0.55));
    const diffuse = max(dot(n, l), 0);
    const spec = pow(max(dot(n, normalize(l.add(vec3(0, 0, 1)))), 0), 40).mul(0.5);
    const base = mix(solid.element(mi).xyz, liquid.element(mi).xyz, clamp(info.y, 0, 1));
    const lit = select(state.equal(STATE.steam), vec3(0.92), base.mul(diffuse.mul(0.65).add(0.35)).add(spec));

    // Incandescence by temperature (table every 100 K from 500 K, linear interpolation).
    const f: N = clamp(info.x.sub(GLOW_T0).div(GLOW_STEP), 0, GLOW_STEPS - 1.001);
    const i0: N = int(f);
    const i1: N = (min as N)(i0.add(1), int(GLOW_STEPS - 1));
    const g: N = mix(glow.element(i0).xyz, glow.element(i1).xyz, fract(f)).mul(GLOW_GAIN);
    // A glowing body is dominated by its own light: fade the reflected part as the glow rises.
    const glowLevel: N = clamp(max(g.x, max(g.y, g.z)), 0, 1);
    const lit2: N = lit;
    return vec4(lit2.mul(float(1).sub(glowLevel.mul(0.85))).add(select(state.equal(STATE.steam), vec3(0), g)), 1);
  })();
  mat.lights = false;
  // Tone mapping would desaturate incandescence into pastel; particles are shaded in display space.
  mat.toneMapped = false;
  const sprite = new THREE.Sprite(mat);
  // Callers keep this in step with solver.count as particles are added.
  sprite.count = solver.count;
  sprite.frustumCulled = false;
  return sprite;
}
