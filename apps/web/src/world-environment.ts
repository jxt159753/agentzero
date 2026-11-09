import * as THREE from 'three';
import { WORLD_BOUNDS, WORLD_MODEL_CATALOG, worldLandDimensions, type WorldSnapshot } from '@agentzero/contracts';
import { TownModels, stableNumber, type Placement } from './world-3d-models';
import type { DaylightState } from './world-daylight';

interface Instance { x: number; y: number; z: number; sx: number; sy: number; sz: number; color?: number; angle?: number }
type Box = Parameters<TownModels['boxes']>[0][number];
const random = (key: string, n: number) => stableNumber(`${key}:${n}`);

/** Geometry stays static; time-of-day changes only update reusable sky and lighting materials. */
export class TownEnvironment {
  readonly root = new THREE.Group();
  private readonly ground = new THREE.Group();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly materials = new Set<THREE.Material>();
  private surfaces: THREE.BufferGeometry[] = [];
  private readonly plane = this.geometry(new THREE.PlaneGeometry(1, 1));
  private readonly round = this.geometry(new THREE.IcosahedronGeometry(1, 1));
  private readonly grass = this.surfaceMaterial('grass');
  private readonly stone = this.surfaceMaterial('stone');
  private readonly meadow = this.material(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.DoubleSide }));
  private readonly flower = this.material(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }));
  private readonly blade = this.makeBlade();
  private readonly cloudMaterial = this.material(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  private readonly starMaterial = this.material(new THREE.PointsMaterial({ color: 0xdce8ff, size: 0.12, transparent: true, opacity: 0, depthWrite: false, fog: false }));
  private skyMap?: THREE.CanvasTexture;
  private stars?: THREE.Points;
  private skyMinute = -1;

  constructor(private readonly models: TownModels) {
    this.root.name = 'town-environment';
    this.root.add(this.ground);
    this.buildBackdrop();
  }

  private geometry<T extends THREE.BufferGeometry>(value: T): T { this.geometries.add(value); return value; }
  private material<T extends THREE.Material>(value: T): T { this.materials.add(value); return value; }
  private texture(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (context) draw(context);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = 4;
    this.textures.add(texture); return texture;
  }
  private surfaceMaterial(kind: 'grass' | 'stone') {
    const map = this.texture(512, 512, context => {
      if (kind === 'grass') {
        context.fillStyle = '#78965d'; context.fillRect(0, 0, 512, 512);
        for (let n = 0; n < 10000; n++) {
          const shade = 88 + Math.floor(random('grass-shade', n) * 37);
          context.fillStyle = `rgba(${shade},${shade + 30},${shade - 23},.28)`;
          context.fillRect(random('grass-x', n) * 512, random('grass-y', n) * 512, 1 + random('grass-w', n) * 3, 1 + random('grass-h', n) * 5);
        }
      } else {
        context.fillStyle = '#9c9b88'; context.fillRect(0, 0, 512, 512);
        for (let row = 0; row < 8; row++) for (let col = -1; col < 4; col++) {
          const n = row * 5 + col + 1, shade = 182 + Math.floor(random('paving', n) * 27);
          const x = col * 128 + (row % 2) * 64, y = row * 64;
          context.fillStyle = `rgb(${shade + 11},${shade + 8},${shade - 5})`;
          context.fillRect(x + 1.5, y + 1.5, 125, 61);
          context.fillStyle = '#ffffff24'; context.fillRect(x + 2, y + 2, 124, 1.5);
          context.fillStyle = '#4d4a3b17'; context.fillRect(x + 2, y + 61, 124, 1.5);
        }
        for (let n = 0; n < 4500; n++) {
          context.fillStyle = n % 2 ? '#ffffff16' : '#514c3910';
          context.fillRect(random('stone-x', n) * 512, random('stone-y', n) * 512, 1, 1);
        }
      }
    });
    return this.material(new THREE.MeshStandardMaterial({ map, roughness: 0.96, bumpMap: kind === 'stone' ? map : null, bumpScale: 0.0015 }));
  }
  private surface(x: number, z: number, width: number, depth: number, height: number, material: THREE.Material, repeat: number) {
    const geometry = this.plane.clone(), uv = geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * width / repeat, uv.getY(i) * depth / repeat);
    this.surfaces.push(geometry);
    const mesh = new THREE.Mesh(geometry, material); mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, height, z); mesh.scale.set(width, depth, 1); mesh.receiveShadow = true;
    this.ground.add(mesh); return mesh;
  }
  private instances(parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, points: Instance[], shadows = false) {
    if (!points.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, points.length), dummy = new THREE.Object3D(), color = new THREE.Color();
    points.forEach((point, index) => {
      dummy.position.set(point.x, point.y, point.z); dummy.scale.set(point.sx, point.sy, point.sz);
      dummy.rotation.set(0, point.angle ?? 0, 0); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix);
      mesh.setColorAt(index, color.setHex(point.color ?? 0xffffff));
    });
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = shadows; mesh.receiveShadow = true; mesh.computeBoundingSphere(); parent.add(mesh);
  }
  private makeBlade() {
    const vertices: number[] = [];
    for (let n = 0; n < 3; n++) {
      const angle = n * Math.PI / 3, x = Math.cos(angle) * 0.5, z = Math.sin(angle) * 0.5;
      vertices.push(-x, 0, -z, x, 0, z, x * 0.3, 1 - n * 0.13, z * 0.3);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.computeVertexNormals();
    return this.geometry(geometry);
  }
  private buildBackdrop() {
    const skyMap = this.texture(16, 256, context => {
      const gradient = context.createLinearGradient(0, 0, 0, 256);
      gradient.addColorStop(0, '#4096c4'); gradient.addColorStop(0.45, '#9ccde0'); gradient.addColorStop(0.58, '#d9e8de'); gradient.addColorStop(1, '#e9eddf');
      context.fillStyle = gradient; context.fillRect(0, 0, 16, 256);
    });
    this.skyMap = skyMap;
    const sky = new THREE.Mesh(this.geometry(new THREE.SphereGeometry(95, 40, 24)), this.material(new THREE.MeshBasicMaterial({ map: skyMap, side: THREE.BackSide, depthWrite: false, fog: false })));
    sky.renderOrder = -10; sky.raycast = () => {}; this.root.add(sky);
    const hills: Instance[] = [];
    for (let n = 0; n < 30; n++) {
      const angle = n / 30 * Math.PI * 2, radius = 45 + random('hill-radius', n) * 14;
      hills.push({ x: Math.sin(angle) * radius, z: Math.cos(angle) * radius, y: -1.2,
        sx: 8 + random('hill-x', n) * 8, sy: 3.4 + random('hill-y', n) * 5, sz: 6 + random('hill-z', n) * 8,
        angle, color: n % 3 === 0 ? 0x6e9c87 : n % 3 === 1 ? 0x84ae96 : 0xa0c2ac });
    }
    this.instances(this.root, this.geometry(new THREE.IcosahedronGeometry(1, 2)), this.material(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 })), hills);
    const clouds: Instance[] = [];
    for (let n = 0; n < 15; n++) {
      const angle = n / 15 * Math.PI * 2, radius = 36 + random('cloud-radius', n) * 27;
      const x = Math.sin(angle) * radius, z = Math.cos(angle) * radius, y = 9 + random('cloud-height', n) * 9;
      for (let part = 0; part < 4; part++) clouds.push({ x: x + (part - 1.5) * 2, y: y + Math.sin(part) * 0.65, z,
        sx: 2.5 + random('cloud-width', n + part) * 2, sy: 0.65 + random('cloud-depth', n + part) * 0.7, sz: 1.4, color: 0xf7f5e9 });
    }
    this.instances(this.root, this.geometry(new THREE.SphereGeometry(1, 12, 7)), this.cloudMaterial, clouds);
    const stars: number[] = [];
    for (let n = 0; n < 180; n++) {
      const angle = random('star-angle', n) * Math.PI * 2, altitude = 0.22 + random('star-altitude', n) * 1.25;
      stars.push(Math.cos(angle) * Math.cos(altitude) * 88, Math.sin(altitude) * 88, Math.sin(angle) * Math.cos(altitude) * 88);
    }
    const starGeometry = this.geometry(new THREE.BufferGeometry()); starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
    this.stars = new THREE.Points(starGeometry, this.starMaterial); this.stars.raycast = () => {}; this.root.add(this.stars);
  }
  setDaylight(state: DaylightState) {
    this.cloudMaterial.color.setHex(state.cloudColor);
    this.starMaterial.opacity = (1 - state.daylight) ** 3 * 0.85;
    if (this.stars) this.stars.visible = this.starMaterial.opacity > 0.01;
    const minute = Math.floor(state.hours * 60);
    if (!this.skyMap || this.skyMinute === minute) return;
    this.skyMinute = minute;
    const canvas = this.skyMap.image as HTMLCanvasElement, context = canvas.getContext('2d');
    if (!context) return;
    const color = (value: number) => '#' + value.toString(16).padStart(6, '0');
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, color(state.skyTop));
    gradient.addColorStop(0.58, color(state.skyHorizon));
    gradient.addColorStop(1, color(state.skyHorizon));
    context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height); this.skyMap.needsUpdate = true;
  }
  update(world: WorldSnapshot) {
    this.models.releaseInstances(this.ground); this.ground.clear();
    this.surfaces.forEach(geometry => geometry.dispose()); this.surfaces = [];
    const bounds = world.bounds ?? WORLD_BOUNDS, width = bounds.max_x - bounds.min_x, depth = bounds.max_y - bounds.min_y;
    this.surface((bounds.min_x + bounds.max_x) / 2, (bounds.min_y + bounds.max_y) / 2, width + 85, depth + 85, -0.012, this.grass, 2.4);
    const kerbs: Box[] = [];
    // Roads first, then the plaza and forecourts, so their paving sits cleanly over the crossing.
    const areas = [...world.public_areas].sort((a, b) => Number(a.kind !== 'road') - Number(b.kind !== 'road'));
    for (const area of areas) {
      const height = area.kind === 'road' ? 0.018 : 0.023;
      this.surface(area.x, area.y, area.width, area.height, height, this.stone, 0.92);
      if (area.kind === 'road') {
        const horizontal = area.width > area.height, length = horizontal ? area.width : area.height;
        for (let n = 0; n < Math.ceil(length / 0.22); n++) for (const side of [-1, 1]) {
          const along = -length / 2 + n * 0.22 + 0.105;
          const x = area.x + (horizontal ? along : side * (area.width / 2 - 0.035)), z = area.y + (horizontal ? side * (area.height / 2 - 0.035) : along);
          if (world.public_areas.some(other => other.id !== area.id && Math.abs(x - other.x) < other.width / 2 + 0.06 && Math.abs(z - other.y) < other.height / 2 + 0.06)) continue;
          kerbs.push({ x, z,
            y: 0.024, width: horizontal ? 0.21 : 0.07, depth: horizontal ? 0.07 : 0.21, height: 0.034, color: n % 3 ? 0xbcbcac : 0xc8c8b6 });
        }
      }
    }
    if (kerbs.length) this.ground.add(this.models.boxes(kerbs));
    const fountain = this.models.asset('fountain', 0.95, 0.95, 0.65); fountain.position.set(0, 0.025, -0.75); this.ground.add(fountain);
    const benchSize = WORLD_MODEL_CATALOG.bench, lampSize = WORLD_MODEL_CATALOG.lamp;
    for (const x of [-1.08, 1.08]) {
      const bench = this.models.asset('bench', benchSize.width, benchSize.depth, benchSize.maxHeight); bench.position.set(x, 0.025, 0.45); bench.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2; this.ground.add(bench);
    }
    const occupied = (x: number, z: number, clearance: number) => world.lands.some(land => {
      if (!land.owner_agent_id && !land.owner) return false;
      const size = worldLandDimensions(land);
      return Math.abs(x - land.x) < size.width / 2 + clearance && Math.abs(z - land.y) < size.height / 2 + clearance;
    });
    const publicSpace = (x: number, z: number, clearance: number) => world.public_areas.some(area => Math.abs(x - area.x) < area.width / 2 + clearance && Math.abs(z - area.y) < area.height / 2 + clearance);
    const trees: Placement[] = [], lamps: Placement[] = [], grass: Instance[] = [], flowers: Instance[] = [];
    const addTree = (x: number, z: number, n: number) => {
      if (occupied(x, z, 0.6) || publicSpace(x, z, 0.48)) return;
      trees.push({ x, z, width: 0.65 + random('canopy', n) * 0.55, height: 1.15 + random('tree-height', n) * 0.7, angle: n });
    };
    // Sparse natural cover on unowned land makes an empty new town feel inhabited by nature.
    for (let n = 0; n < 145; n++) {
      const local = n < 55, rangeX = local ? 24 : 64, rangeZ = local ? 22 : 48;
      addTree((random('tree-x', n) - 0.5) * rangeX, (random('tree-z', n) - 0.5) * rangeZ, n);
    }
    for (let n = -24; n <= 24; n += 4) {
      if (Math.abs(n) < 4) continue;
      for (const side of [-1, 1]) { addTree(n, side * 1.2, n * 17 + side); if (Math.abs(n) < 22) addTree(side * 1.2, n, n * 23 + side); }
      lamps.push({ x: n, z: 0.25, width: lampSize.width, height: lampSize.maxHeight, angle: Math.PI / 2 });
      if (Math.abs(n) < 22) lamps.push({ x: -0.25, z: n, width: lampSize.width, height: lampSize.maxHeight });
    }
    for (const x of [-1.22, 1.22]) for (const z of [-0.15, 0.92]) lamps.push({ x, z, width: lampSize.width, height: lampSize.maxHeight, angle: x > 0 ? -Math.PI / 2 : Math.PI / 2 });
    const colors = [0xe9d5a1, 0xf0e8c9, 0xc8b9dd, 0xe7b7a0];
    for (let n = 0; n < 1100; n++) {
      const x = (random('meadow-x', n) - 0.5) * 44, z = (random('meadow-z', n) - 0.5) * 36;
      if (occupied(x, z, 0.06) || publicSpace(x, z, 0.09)) continue;
      const height = 0.025 + random('meadow-height', n) * 0.05;
      grass.push({ x, y: 0.002, z, sx: 0.055, sy: height, sz: 0.055, angle: n, color: n % 3 ? 0x749351 : 0x93a765 });
      if (n % 4 === 0) flowers.push({ x, y: height, z, sx: 0.012, sy: 0.007, sz: 0.012, color: colors[Math.floor(n / 4) % colors.length]! });
    }
    for (const x of [-1.22, 1.22]) for (const z of [-1.18, 1.18]) {
      const shrub = this.models.asset('plant', 0.28, 0.28, 0.34); shrub.position.set(x, 0.025, z); this.ground.add(shrub);
      for (let n = 0; n < 12; n++) flowers.push({ x: x + (random('bed-x', n) - 0.5) * 0.23, z: z + (random('bed-z', n) - 0.5) * 0.23, y: 0.24 + random('bed-height', n) * 0.06,
        sx: 0.018, sy: 0.012, sz: 0.018, color: colors[n % colors.length]! });
    }
    this.ground.add(this.models.instances('tree', trees), this.models.instances('lamp', lamps));
    this.instances(this.ground, this.blade, this.meadow, grass);
    this.instances(this.ground, this.round, this.flower, flowers);
    this.root.traverse(node => { node.raycast = () => {}; });
  }
  dispose() {
    this.models.releaseInstances(this.root); this.root.clear();
    this.surfaces.forEach(geometry => geometry.dispose()); this.surfaces = [];
    this.geometries.forEach(geometry => geometry.dispose()); this.materials.forEach(material => material.dispose()); this.textures.forEach(texture => texture.dispose());
  }
}
