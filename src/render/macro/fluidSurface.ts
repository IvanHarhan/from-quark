import * as THREE from 'three/webgpu';
import {
  Discard,
  Fn,
  If,
  Loop,
  abs,
  cameraWorldMatrix,
  clamp,
  cross,
  dot,
  exp,
  float,
  fract,
  int,
  max,
  min,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  pmremTexture,
  cameraFar,
  cameraNear,
  depth as fragDepth,
  pow,
  select,
  sqrt,
  texture,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { GLOW_STEP, GLOW_STEPS, GLOW_T0, glowTable } from '../blackbody';
import { STATE, type MpmSolver } from '../../sim/mpm/gpuSolver';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

const KIND = { clear: 0, metal: 1, matte: 2 } as const;
const GLOW_GAIN = 1.6;
/** Largest blur half-width, pixels. */
const BLUR_MAX = 22;

/**
 * Screen-space fluid rendering (van der Laan et al. 2009, "Screen Space Fluid Rendering with Curvature
 * Flow" family): the MPM particles are splatted as spheres into a depth buffer, the depth is smoothed with a
 * bilateral filter so neighbouring particles merge into one surface, normals are rebuilt from the smoothed
 * depth, and the surface is shaded per material: clear liquids refract the scene and absorb by thickness,
 * metals mirror the room, matte solids scatter. Hot matter adds blackbody emission.
 *
 * Replaces renderer.render(scene, camera) for the lab view; steam stays as soft sprites in the scene.
 */
export class FluidSurface {
  private sceneRT: THREE.RenderTarget;
  private dataRT: THREE.RenderTarget;
  private thickRT: THREE.RenderTarget;
  private blurA: THREE.RenderTarget;
  private blurB: THREE.RenderTarget;
  private fluidScene = new THREE.Scene();
  private thickScene = new THREE.Scene();
  private dataSprites: THREE.Sprite;
  private thickSprites: THREE.Sprite;
  private blurH: THREE.QuadMesh;
  private blurV: THREE.QuadMesh;
  private blurH2: THREE.QuadMesh;
  private composite: THREE.QuadMesh;
  private u = {
    texel: uniform(new THREE.Vector2(1, 1)),
    tanHalf: uniform(new THREE.Vector2(1, 1)),
    near: uniform(0.01),
    far: uniform(50),
    radius: uniform(0.005),
    focal: uniform(500),
    /** Dev: 0 normal, 1 thickness, 2 depth, 3 normals. */
    debug: uniform(0),
  };

  constructor(
    private renderer: THREE.WebGPURenderer,
    solver: MpmSolver,
    environment: THREE.Texture | null,
  ) {
    const rt = (type: THREE.TextureDataType, depth: boolean) => {
      const t = new THREE.RenderTarget(1, 1, { type, depthBuffer: depth, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
      t.texture.colorSpace = THREE.NoColorSpace;
      return t;
    };
    this.sceneRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    this.sceneRT.depthTexture = new THREE.DepthTexture(1, 1);
    this.dataRT = rt(THREE.FloatType, true);
    this.thickRT = rt(THREE.HalfFloatType, false);
    this.blurA = rt(THREE.FloatType, false);
    this.blurB = rt(THREE.FloatType, false);

    const d = solver.domain;
    const info: N = solver.info.toAttribute();
    const worldPos = solver.pos.toAttribute().xyz.mul(d.dx).add(vec3(...d.origin));
    const radius = d.dx * 0.62;
    this.u.radius.value = radius;
    const isMatter = info.z.equal(STATE.matter);

    // 1. Front surface: linear view depth of the sphere + material data of the nearest particle.
    const dataMat = new THREE.SpriteNodeMaterial();
    dataMat.positionNode = worldPos;
    dataMat.scaleNode = select(isMatter, float(radius * 2), float(0));
    // fragmentNode writes the raw values; colorNode would pass through lighting/opacity handling.
    dataMat.fragmentNode = Fn(() => {
      const c = uv().mul(2).sub(1);
      const r2 = dot(c, c);
      Discard(r2.greaterThan(1));
      // Linear distance of the billboard pixel (from the fragment depth), pulled forward onto the sphere.
      const viewZ = perspectiveDepthToViewZ(fragDepth, cameraNear, cameraFar);
      const depth = viewZ.negate().sub(sqrt(float(1).sub(r2)).mul(radius));
      return vec4(depth, info.w, info.y, info.x);
    })();
    dataMat.toneMapped = false;
    // Raw data in all four channels (alpha = temperature): blending would scale it by alpha.
    dataMat.blending = THREE.NoBlending;
    dataMat.lights = false;
    this.dataSprites = new THREE.Sprite(dataMat);
    this.dataSprites.frustumCulled = false;
    this.fluidScene.add(this.dataSprites);

    // 2. Thickness (additive): how much matter the view ray crosses, for absorption and refraction.
    const thickMat = new THREE.SpriteNodeMaterial();
    thickMat.positionNode = worldPos;
    thickMat.scaleNode = select(isMatter, float(radius * 2), float(0));
    thickMat.fragmentNode = Fn(() => {
      const c = uv().mul(2).sub(1);
      const r2 = dot(c, c);
      Discard(r2.greaterThan(1));
      // Sprites overlap: a sphere chord averages 4/3·r over the disk, but each particle only owns (dx/2)³ of
      // matter, so scale the chord so the summed thickness equals the real path length through the matter.
      const ownShare = (d.dx / 2) ** 3 / (Math.PI * radius * radius) / ((4 / 3) * radius);
      return vec4(sqrt(float(1).sub(r2)).mul(radius * 2 * ownShare), 0, 0, 1);
    })();
    thickMat.blending = THREE.AdditiveBlending;
    thickMat.depthTest = false;
    thickMat.depthWrite = false;
    thickMat.transparent = false; // additive blending still applies; transparent sprites were skipped in this pass
    thickMat.toneMapped = false;
    thickMat.lights = false;
    this.thickSprites = new THREE.Sprite(thickMat);
    this.thickSprites.frustumCulled = false;
    this.thickScene.add(this.thickSprites);

    // 3. Bilateral blur of the depth: spatial Gaussian in world units, cut off across depth jumps.
    const blur = (src: THREE.RenderTarget, dir: [number, number]) => {
      const m = new THREE.NodeMaterial();
      m.fragmentNode = Fn(() => {
        const tex = (o: N) => texture(src.texture, uv().add(o));
        const center = tex(vec2(0)).toVar();
        const d0 = center.x;
        If(d0.lessThanEqual(0), () => {
          Discard();
        });
        // Filter radius: ~2.5 particle radii projected to pixels, capped for cost.
        const pixR = clamp(this.u.radius.mul(2.5).mul(this.u.focal).div(d0), 1, BLUR_MAX).toVar();
        const sum = float(0).toVar();
        const wsum = float(0).toVar();
        Loop({ start: int(-BLUR_MAX), end: int(BLUR_MAX + 1), type: 'int', condition: '<' }, ({ i }: { i: N }) => {
          const fi = float(i);
          If(abs(fi).lessThanEqual(pixR), () => {
            const s = tex(vec2(dir[0], dir[1]).mul(this.u.texel).mul(fi)).x;
            If(s.greaterThan(0), () => {
              const ws = exp(fi.mul(fi).div(pixR.mul(pixR).mul(-0.5)));
              const dz = s.sub(d0).div(this.u.radius.mul(2));
              const w = ws.mul(exp(dz.mul(dz).negate()));
              sum.addAssign(s.mul(w));
              wsum.addAssign(w);
            });
          });
        });
        return vec4(sum.div(max(wsum, 1e-6)), center.y, center.z, center.w);
      })();
      m.blending = THREE.NoBlending;
      return new THREE.QuadMesh(m);
    };
    this.blurH = blur(this.dataRT, [1, 0]);
    this.blurV = blur(this.blurA, [0, 1]);
    // A second H/V round removes the cross-shaped streaks a single separable bilateral pass leaves.
    this.blurH2 = blur(this.blurB, [1, 0]);

    // 4. Composite.
    const glow: N = uniformArray(glowTable().map(([r, g, b, t]) => new THREE.Vector4(r, g, b, t)), 'vec4');
    const vecs = (f: (s: (typeof solver.materials)[number]) => THREE.Vector4) => uniformArray(solver.materials.map(f), 'vec4') as N;
    const look = (l: { kind: keyof typeof KIND; color: string; absorb?: number; roughness?: number }) => {
      const c = new THREE.Color(l.color);
      return [new THREE.Vector4(c.r, c.g, c.b, KIND[l.kind]), new THREE.Vector4(l.absorb ?? 0, l.roughness ?? 0.05, 0, 0)];
    };
    const sA = vecs((m) => look(m.look.solid)[0]);
    const sB = vecs((m) => look(m.look.solid)[1]);
    const lA = vecs((m) => look(m.look.liquid)[0]);
    const lB = vecs((m) => look(m.look.liquid)[1]);

    const viewPosAt = (uvN: N, depth: N) =>
      vec3(uvN.x.mul(2).sub(1).mul(this.u.tanHalf.x).mul(depth), uvN.y.mul(2).sub(1).mul(this.u.tanHalf.y).mul(depth), depth.negate());

    const comp = new THREE.NodeMaterial();
    comp.fragmentNode = Fn(() => {
      const st = uv();
      const fl = select(
        this.u.debug.equal(4),
        texture(this.dataRT.texture, st),
        select(this.u.debug.equal(5), texture(this.blurA.texture, st), texture(this.blurB.texture, st)),
      ).toVar();
      const d = fl.x;
      // No matter here, or an opaque object in front of it.
      const sceneDepth = texture(this.sceneRT.depthTexture!, st).x;
      const sceneViewZ = perspectiveDepthToViewZ(sceneDepth, this.u.near, this.u.far).negate();
      If(this.u.debug.equal(6), () => {
        const b = texture(this.blurB.texture, st).x;
        Discard(b.equal(0));
      });
      If(d.lessThanEqual(0).or(d.greaterThan(sceneViewZ.add(this.u.radius.mul(0.5)))).and(this.u.debug.notEqual(6)), () => {
        Discard();
      });

      // Normal from the smoothed depth: per axis take the neighbour with the smaller depth jump.
      const P = viewPosAt(st, d).toVar();
      const nb = (o: N) => {
        const sd = texture(this.blurB.texture, st.add(o)).x;
        return select(sd.greaterThan(0), viewPosAt(st.add(o), sd), P);
      };
      const tx = vec2(this.u.texel.x, 0);
      const ty = vec2(0, this.u.texel.y);
      const ddxR = nb(tx).sub(P);
      const ddxL = P.sub(nb(tx.negate()));
      const ddyU = nb(ty).sub(P);
      const ddyD = P.sub(nb(ty.negate()));
      const ddx = select(abs(ddxR.z).lessThan(abs(ddxL.z)), ddxR, ddxL);
      const ddy = select(abs(ddyU.z).lessThan(abs(ddyD.z)), ddyU, ddyD);
      const Nv = normalize(cross(ddx, ddy)).toVar();
      const V = normalize(P.negate()).toVar();
      const mi = int(fl.y);
      const liquid = clamp(fl.z, 0, 1);
      const T = fl.w;
      const A: N = mix(sA.element(mi), lA.element(mi), liquid).toVar();
      const B: N = mix(sB.element(mi), lB.element(mi), liquid).toVar();
      const kind = select(liquid.greaterThan(0.5), lA.element(mi).w, sA.element(mi).w);
      const base = A.xyz;
      const rough = B.y;

      // World-space reflection for the room environment.
      const Rv = Nv.mul(dot(Nv, V).mul(2)).sub(V);
      const Rw = normalize(cameraWorldMatrix.mul(vec4(Rv, 0)).xyz);
      const Nw = normalize(cameraWorldMatrix.mul(vec4(Nv, 0)).xyz);
      const env = environment ? pmremTexture(environment, Rw, rough).rgb.mul(0.9) : vec3(0.75);
      const envDiffuse = environment ? pmremTexture(environment, Nw, float(1)).rgb : vec3(0.6);
      const NdotV = clamp(dot(Nv, V), 0, 1);
      const fres = (f0: N) => f0.add(vec3(1).sub(f0).mul(pow(float(1).sub(NdotV), 5)));
      const keyL = normalize(vec3(0.4, 0.8, 0.45));
      const keyLv = normalize(cameraWorldMatrix.transpose().mul(vec4(keyL, 0)).xyz);
      const spec = pow(max(dot(Nv, normalize(keyLv.add(V))), 0), mix(float(400), float(20), rough)).mul(1.5);

      const color = vec3(0).toVar();
      If(kind.equal(KIND.metal), () => {
        // Conductor: tinted mirror of the room.
        color.assign(env.mul(fres(base)).add(base.mul(spec)));
      })
        .ElseIf(kind.equal(KIND.clear), () => {
          // Dielectric: refracted background, absorbed by thickness (Beer–Lambert, per cm), + Fresnel reflection.
          const thick = texture(this.thickRT.texture, st).x;
          const offset = Nv.xy.mul(clamp(thick.mul(8), 0, 0.06));
          const refr = texture(this.sceneRT.texture, st.sub(offset)).rgb;
          const absorb = B.x.mul(thick.mul(100));
          const tint = exp(vec3(1).sub(base).mul(absorb).negate());
          const F = fres(vec3(0.02)).x;
          color.assign(refr.mul(tint).mul(float(1).sub(F)).add(env.mul(F)).add(vec3(spec)));
        })
        .Else(() => {
          // Matte: diffuse room light + a soft key light.
          const lambert = max(dot(Nv, keyLv), 0);
          color.assign(base.mul(envDiffuse.mul(0.8).add(lambert.mul(0.6))).add(env.mul(fres(vec3(0.03)).x)));
        });

      // Blackbody emission.
      const f: N = clamp(T.sub(GLOW_T0).div(GLOW_STEP), 0, GLOW_STEPS - 1.001);
      const i0: N = int(f);
      const i1: N = (min as N)(i0.add(1), int(GLOW_STEPS - 1));
      const g: N = mix(glow.element(i0).xyz, glow.element(i1).xyz, fract(f)).mul(GLOW_GAIN);
      const glowLevel: N = clamp(max(g.x, max(g.y, g.z)), 0, 1);
      color.assign(color.mul(float(1).sub(glowLevel.mul(0.85))).add(g));
      If(this.u.debug.equal(1), () => {
        color.assign(vec3(texture(this.thickRT.texture, st).x.mul(10)));
      })
        .ElseIf(this.u.debug.equal(2), () => {
          color.assign(vec3(fract(d.mul(20))));
        })
        .ElseIf(this.u.debug.equal(6), () => {
          const b = texture(this.blurB.texture, st).x;
          color.assign(select(b.greaterThan(0), vec3(0, 1, 0), select(b.lessThan(0), vec3(0, 0, 1), vec3(1, 0, 0))));
        })
        .ElseIf(this.u.debug.greaterThanEqual(4), () => {
          color.assign(vec3(fract(d.mul(20)), 0, 0));
        })
        .ElseIf(this.u.debug.equal(3), () => {
          color.assign(Nv.mul(0.5).add(0.5));
        });
      return vec4(color, 1);
    })();
    comp.depthTest = false;
    comp.depthWrite = false;
    comp.transparent = true;
    this.composite = new THREE.QuadMesh(comp);

    this.copy = new THREE.QuadMesh(
      (() => {
        const m = new THREE.NodeMaterial();
        m.fragmentNode = texture(this.sceneRT.texture, uv());
        m.depthTest = false;
        m.depthWrite = false;
        return m;
      })(),
    );
  }

  private copy: THREE.QuadMesh;

  setCount(n: number) {
    this.dataSprites.count = n;
    this.thickSprites.count = n;
  }

  private size = new THREE.Vector2();

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    for (const t of [this.sceneRT, this.dataRT, this.thickRT, this.blurA, this.blurB]) {
      if (t.width !== w || t.height !== h) t.setSize(w, h);
    }
    this.u.texel.value.set(1 / w, 1 / h);
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    this.u.tanHalf.value.set(tanY * camera.aspect, tanY);
    this.u.near.value = camera.near;
    this.u.far.value = camera.far;
    this.u.focal.value = h / 2 / tanY;

    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevAuto = r.autoClear;
    // Every render() would clear its target; the passes below clear explicitly instead.
    r.autoClear = false;

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.dataRT);
    r.clear();
    r.render(this.fluidScene, camera);
    r.setRenderTarget(this.thickRT);
    r.clear();
    r.render(this.thickScene, camera);
    r.setRenderTarget(this.blurA);
    r.clear();
    this.blurH.render(r);
    r.setRenderTarget(this.blurB);
    r.clear();
    this.blurV.render(r);
    r.setRenderTarget(this.blurA);
    r.clear();
    this.blurH2.render(r);
    r.setRenderTarget(this.blurB);
    r.clear();
    this.blurV.render(r);
    r.setClearColor(prevClear, prevAlpha);

    r.setRenderTarget(prevTarget);
    r.clear();
    this.copy.render(r);
    this.composite.render(r);
    r.autoClear = prevAuto;
  }

  dispose() {
    for (const t of [this.sceneRT, this.dataRT, this.thickRT, this.blurA, this.blurB]) t.dispose();
  }
}
