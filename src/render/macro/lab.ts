import * as THREE from 'three/webgpu';

/** Room interior bounds (metres). Floor at y=0. */
export const ROOM = { halfX: 4, halfZ: 3, height: 3 };
/** Table top surface height and footprint. */
export const TABLE = { x: 0, z: 0, halfX: 1.0, halfZ: 0.45, top: 0.9 };

export interface Lab {
  root: THREE.Group;
  sun: THREE.DirectionalLight;
  /** Named lab objects; later stages attach physics bodies to these. */
  items: Map<string, THREE.Object3D>;
}

const mat = {
  floor: new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.85 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xe4e6e3, roughness: 0.95, side: THREE.BackSide }),
  tableTop: new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.55 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 1, roughness: 0.35 }),
  darkSteel: new THREE.MeshStandardMaterial({ color: 0x4a4e54, metalness: 0.9, roughness: 0.5 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x9a7350, roughness: 0.7 }),
  ceramic: new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.6 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 1, roughness: 0.3 }),
  cold: new THREE.MeshStandardMaterial({ color: 0x9fc6e8, metalness: 0.6, roughness: 0.25 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6e8, emissiveIntensity: 2 }),
  glass: new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.04,
    transmission: 1,
    thickness: 0.003,
    ior: 1.5,
    transparent: true,
    side: THREE.DoubleSide,
  }),
};

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}

/** Thin-walled vessel from a radius profile [(r, y)], revolved. */
function lathe(profile: [number, number][], m: THREE.Material): THREE.Mesh {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 48);
  return mesh(g, m);
}

function beaker(radius: number, height: number): THREE.Object3D {
  const g = new THREE.Group();
  const v = lathe([[0, 0], [radius, 0], [radius, height], [radius * 1.08, height + 0.004]], mat.glass);
  v.castShadow = false;
  g.add(v);
  return g;
}

function erlenmeyer(): THREE.Object3D {
  const v = lathe([[0, 0], [0.05, 0], [0.052, 0.006], [0.016, 0.11], [0.016, 0.15], [0.019, 0.153]], mat.glass);
  v.castShadow = false;
  return v;
}

function roundFlask(): THREE.Object3D {
  const pts: [number, number][] = [];
  const r = 0.06;
  for (let i = 0; i <= 16; i++) {
    const a = -Math.PI / 2 + (i / 16) * (Math.PI - 0.35);
    pts.push([Math.cos(a) * r, r + Math.sin(a) * r]);
  }
  pts.push([0.016, 0.16], [0.019, 0.163]);
  pts[0][0] = 0;
  const v = lathe(pts, mat.glass);
  v.castShadow = false;
  return v;
}

function burner(): THREE.Object3D {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.015, 32), mat.darkSteel, 0, 0.0075, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.13, 24), mat.brass, 0, 0.08, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.025, 24), mat.brass, 0, 0.035, 0));
  return g;
}

function crucible(): THREE.Object3D {
  return lathe([[0, 0], [0.018, 0], [0.024, 0.004], [0.028, 0.04], [0.026, 0.04], [0.022, 0.006], [0, 0.006]], mat.ceramic);
}

function coldPlate(): THREE.Object3D {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(0.26, 0.06, 0.2), mat.darkSteel, 0, 0.03, 0));
  g.add(mesh(new THREE.BoxGeometry(0.22, 0.006, 0.16), mat.cold, 0, 0.063, 0));
  return g;
}

function weights(): THREE.Object3D {
  const g = new THREE.Group();
  [0.02, 0.016, 0.013, 0.01].forEach((r, i) => {
    g.add(mesh(new THREE.CylinderGeometry(r, r, r * 2, 24), mat.brass, i * 0.05, r, 0));
    g.add(mesh(new THREE.CylinderGeometry(r * 0.35, r * 0.35, r * 0.6, 12), mat.brass, i * 0.05, r * 2.3, 0));
  });
  return g;
}

export function buildLab(): Lab {
  const root = new THREE.Group();
  const items = new Map<string, THREE.Object3D>();
  const place = (name: string, o: THREE.Object3D, x: number, y: number, z: number) => {
    o.name = name;
    o.position.set(x, y, z);
    root.add(o);
    items.set(name, o);
  };

  const floor = mesh(new THREE.PlaneGeometry(ROOM.halfX * 2, ROOM.halfZ * 2), mat.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.castShadow = false;
  root.add(floor);
  const room = mesh(new THREE.BoxGeometry(ROOM.halfX * 2, ROOM.height, ROOM.halfZ * 2), mat.wall, 0, ROOM.height / 2, 0);
  room.castShadow = false;
  root.add(room);
  for (const x of [-1.5, 1.5]) {
    const lamp = mesh(new THREE.BoxGeometry(1.2, 0.03, 0.3), mat.lamp, x, ROOM.height - 0.02, 0);
    lamp.castShadow = false;
    root.add(lamp);
  }

  // Lab bench
  const table = new THREE.Group();
  table.add(mesh(new THREE.BoxGeometry(TABLE.halfX * 2, 0.04, TABLE.halfZ * 2), mat.tableTop, 0, TABLE.top - 0.02, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    table.add(mesh(new THREE.BoxGeometry(0.05, TABLE.top - 0.04, 0.05), mat.steel, sx * (TABLE.halfX - 0.06), (TABLE.top - 0.04) / 2, sz * (TABLE.halfZ - 0.06)));
  }
  table.add(mesh(new THREE.BoxGeometry(TABLE.halfX * 2 - 0.1, 0.02, TABLE.halfZ * 2 - 0.1), mat.steel, 0, 0.15, 0));
  place('table', table, TABLE.x, 0, TABLE.z);

  // Wall shelves with spare glassware
  const shelves = new THREE.Group();
  for (const y of [1.25, 1.65]) {
    shelves.add(mesh(new THREE.BoxGeometry(2.4, 0.03, 0.3), mat.wood, 0, y, 0));
    for (let i = 0; i < 6; i++) {
      const v = i % 2 ? erlenmeyer() : beaker(0.03 + (i % 3) * 0.008, 0.08 + (i % 3) * 0.02);
      v.position.set(-1 + i * 0.4, y + 0.015, 0);
      shelves.add(v);
    }
  }
  place('shelves', shelves, 0, 0, -ROOM.halfZ + 0.16);

  const top = TABLE.top;
  // The 1 L beaker and the tray belong to LabSim; keep x ∈ [-0.52, 0.22], z ∈ [-0.13, 0.33] free for them.
  place('flask', erlenmeyer(), 0.32, top, -0.3);
  place('roundFlask', roundFlask(), -0.4, top, -0.28);
  place('burner', burner(), 0.45, top, 0.12);
  place('crucible', crucible(), 0.2, top, -0.25);
  place('coldPlate', coldPlate(), -0.75, top, 0.15);
  place('weights', weights(), 0.5, top, 0.32);

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(2.0, 2.9, 1.6);
  sun.target.position.set(0, TABLE.top, 0);
  sun.castShadow = true;
  const cam = sun.shadow.camera;
  cam.left = -1.6; cam.right = 1.6; cam.top = 1.6; cam.bottom = -1.6; cam.near = 0.5; cam.far = 6;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.01;
  root.add(sun, sun.target);
  root.add(new THREE.HemisphereLight(0xf4f6ff, 0x6a6460, 0.6));

  return { root, sun, items };
}
