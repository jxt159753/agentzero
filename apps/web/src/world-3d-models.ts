import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WORLD_ASSETS, WORLD_CORE_ASSETS } from './world-assets';
import { WORLD_MODEL_CATALOG, type WorldModelId } from '@agentzero/contracts';

export type TownAsset = keyof typeof WORLD_ASSETS;
interface Template { root: THREE.Group; size: THREE.Vector3 }
export interface Placement { x: number; z: number; width: number; height: number; angle?: number }
const VISITOR_PALETTES = [
  { coat: 0x7296ac, trousers: 0x4b6071, skin: 0xedc7a2, hair: 0x58473c },
  { coat: 0x8b9e79, trousers: 0x53634f, skin: 0xc99773, hair: 0x414b46 },
  { coat: 0xb99a65, trousers: 0x655d50, skin: 0xa87354, hair: 0x443d3a },
  { coat: 0xb78379, trousers: 0x605a69, skin: 0xf0d4b5, hair: 0x745746 },
] as const;

/** One geometry/material pool per mounted map; clones never own or dispose shared buffers. */
export class TownModels {
  private geometries = new Map<string, THREE.BufferGeometry>();
  private materials = new Map<number, THREE.MeshStandardMaterial>();
  private templates = new Map<TownAsset, Template>();
  private loaded = new Set<THREE.Object3D>();
  private readonly requests = new Map<TownAsset, Promise<void>>();
  private readonly loader = new GLTFLoader();
  private readonly lampMaterial = new THREE.MeshStandardMaterial({ color: 0xe0e2dc, emissive: 0xffc067, emissiveIntensity: 0,
    roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  private disposed = false;
  constructor(private readonly onLoaded?: (count: number) => void) {}
  get loadedCount() { return this.templates.size; }
  setLampStrength(strength: number) { this.lampMaterial.emissiveIntensity = strength * 3; }
  private geometry(name: string, create: () => THREE.BufferGeometry) {
    if (!this.geometries.has(name)) this.geometries.set(name, create());
    return this.geometries.get(name)!;
  }
  material(color: number) {
    if (!this.materials.has(color)) this.materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, flatShading: true }));
    return this.materials.get(color)!;
  }
  box(parent: THREE.Object3D, color: number, x: number, y: number, z: number, width: number, height: number, depth: number) {
    const node = new THREE.Mesh(this.geometry('box', () => new THREE.BoxGeometry(1, 1, 1)), this.material(color));
    node.position.set(x, y, z); node.scale.set(width, height, depth);
    node.castShadow = true; node.receiveShadow = true; parent.add(node); return node;
  }
  boxes(placements: { x: number; y: number; z: number; width: number; height: number; depth: number; color: number }[]) {
    const node = new THREE.InstancedMesh(this.geometry('box', () => new THREE.BoxGeometry(1, 1, 1)), this.material(0xffffff), placements.length);
    const dummy = new THREE.Object3D(), color = new THREE.Color();
    placements.forEach((placement, index) => {
      dummy.position.set(placement.x, placement.y, placement.z); dummy.scale.set(placement.width, placement.height, placement.depth); dummy.updateMatrix();
      node.setMatrixAt(index, dummy.matrix); node.setColorAt(index, color.setHex(placement.color));
    });
    node.instanceMatrix.needsUpdate = true; if (node.instanceColor) node.instanceColor.needsUpdate = true;
    node.receiveShadow = true; node.computeBoundingSphere(); return node;
  }
  cylinder(parent: THREE.Object3D, color: number, x: number, y: number, z: number, radius: number, height: number, cone = false) {
    const geometry = this.geometry(cone ? 'cone' : 'cylinder', () => new THREE.CylinderGeometry(cone ? 0 : 1, 1, 1, cone ? 7 : 16));
    const node = new THREE.Mesh(geometry, this.material(color));
    node.position.set(x, y, z); node.scale.set(radius, height, radius);
    node.castShadow = true; node.receiveShadow = true; parent.add(node); return node;
  }
  sphere(parent: THREE.Object3D, color: number, x: number, y: number, z: number, radius: number) {
    const node = new THREE.Mesh(this.geometry('sphere', () => new THREE.IcosahedronGeometry(1, 1)), this.material(color));
    node.position.set(x, y, z); node.scale.setScalar(radius); node.castShadow = true; parent.add(node); return node;
  }
  /** A small +Z-facing avatar; the ID only chooses a stable fictional color palette. */
  visitor(parent: THREE.Object3D, id: string): { legs: THREE.Object3D[]; arms: THREE.Object3D[] } {
    const { coat, trousers, skin, hair } = VISITOR_PALETTES[Math.floor(stableNumber(id) * VISITOR_PALETTES.length)]!;
    const cream = 0xf0e7d5, ink = 0x374345, shoe = 0x526469;
    const oval = (target: THREE.Object3D, color: number, x: number, y: number, z: number, rx: number, ry: number, rz: number) => {
      const mesh = this.sphere(target, color, x, y, z, 1); mesh.scale.set(rx, ry, rz); return mesh;
    };

    this.cylinder(parent, coat, 0, 0.284, 0, 0.098, 0.188).scale.z = 0.071;
    this.box(parent, cream, 0, 0.286, 0.073, 0.066, 0.156, 0.012);
    this.box(parent, trousers, 0, 0.194, 0, 0.174, 0.018, 0.13);
    this.box(parent, 0xd7cfb9, 0, 0.272, 0.083, 0.004, 0.106, 0.004);
    for (const side of [-1, 1]) {
      this.box(parent, coat, side * 0.057, 0.281, 0.062, 0.052, 0.158, 0.035);
      this.box(parent, cream, side * 0.026, 0.353, 0.069, 0.037, 0.032, 0.019).rotation.z = side * 0.4;
      this.box(parent, trousers, side * 0.058, 0.25, 0.081, 0.029, 0.004, 0.004).rotation.z = side * 0.18;
      this.sphere(parent, cream, side * 0.058, 0.264, 0.082, 0.0045);
    }
    this.cylinder(parent, skin, 0, 0.382, 0, 0.031, 0.044);
    oval(parent, skin, 0, 0.471, 0, 0.105, 0.118, 0.103);
    for (const side of [-1, 1]) {
      oval(parent, skin, side * 0.106, 0.472, 0, 0.017, 0.024, 0.017);
      oval(parent, cream, side * 0.038, 0.484, 0.097, 0.011, 0.014, 0.006);
      oval(parent, ink, side * 0.038, 0.483, 0.103, 0.0065, 0.009, 0.004);
      this.sphere(parent, 0xffffff, side * 0.038 - 0.002, 0.488, 0.107, 0.0025);
      this.box(parent, hair, side * 0.038, 0.507, 0.097, 0.024, 0.004, 0.006).rotation.z = side * -0.12;
      oval(parent, 0xc98c7b, side * 0.069, 0.457, 0.081, 0.012, 0.007, 0.004);
      this.box(parent, 0x916653, side * 0.011, 0.442, 0.102, 0.011, 0.003, 0.004).rotation.z = side * 0.55;
    }
    oval(parent, skin, 0, 0.462, 0.107, 0.009, 0.01, 0.012);
    this.box(parent, 0x916653, 0, 0.439, 0.102, 0.014, 0.003, 0.004);
    oval(parent, hair, 0, 0.552, -0.007, 0.109, 0.06, 0.106);
    oval(parent, hair, 0, 0.503, -0.068, 0.094, 0.078, 0.052);
    for (const side of [-1, 1]) oval(parent, hair, side * 0.092, 0.517, -0.027, 0.026, 0.049, 0.068);
    oval(parent, hair, -0.061, 0.543, 0.07, 0.045, 0.025, 0.041).rotation.z = -0.22;
    oval(parent, hair, -0.016, 0.541, 0.09, 0.041, 0.025, 0.028).rotation.z = -0.22;
    oval(parent, hair, 0.04, 0.546, 0.078, 0.042, 0.025, 0.035).rotation.z = -0.22;

    const arms = [-1, 1].map(side => {
      const pivot = new THREE.Group(); pivot.position.set(side * 0.112, 0.347, 0); pivot.rotation.z = side * 0.12; parent.add(pivot);
      this.cylinder(pivot, coat, 0, -0.055, 0, 0.034, 0.123);
      this.cylinder(pivot, cream, 0, -0.119, 0, 0.035, 0.015);
      oval(pivot, skin, 0, -0.145, 0.003, 0.026, 0.029, 0.027);
      return pivot;
    });
    const legs = [-1, 1].map(side => {
      const pivot = new THREE.Group(); pivot.position.set(side * 0.047, 0.198, 0); parent.add(pivot);
      this.cylinder(pivot, trousers, 0, -0.056, 0, 0.034, 0.11);
      this.cylinder(pivot, trousers, 0, -0.103, 0, 0.035, 0.015);
      oval(pivot, shoe, 0, -0.133, 0.023, 0.039, 0.027, 0.058);
      this.box(pivot, cream, 0, -0.152, 0.022, 0.075, 0.012, 0.105);
      return pivot;
    });
    return { legs, arms };
  }
  private loadAsset(key: TownAsset): Promise<void> {
    const existing = this.requests.get(key);
    if (existing) return existing;
    const request = this.loader.loadAsync(WORLD_ASSETS[key].url).then(gltf => {
      if (this.disposed) { this.disposeObject(gltf.scene); return; }
      gltf.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(gltf.scene), center = bounds.getCenter(new THREE.Vector3());
      const root = new THREE.Group(), size = bounds.getSize(new THREE.Vector3());
      gltf.scene.position.x -= center.x; gltf.scene.position.y -= bounds.min.y; gltf.scene.position.z -= center.z;
      gltf.scene.traverse(node => {
        if (node instanceof THREE.Mesh) { node.castShadow = true; node.receiveShadow = true; }
      });
      root.add(gltf.scene); root.updateMatrixWorld(true);
      if (key === 'lamp') this.prepareLamp(root);
      this.loaded.add(root); this.templates.set(key, { root, size });
      this.onLoaded?.(this.loadedCount);
    });
    this.requests.set(key, request); return request;
  }
  private prepareLamp(root: THREE.Group) {
    const meshes: THREE.Mesh[] = [], bounds = new THREE.Box3();
    root.traverse(node => { if (node instanceof THREE.Mesh) meshes.push(node); });
    for (const mesh of meshes) {
      const source = mesh.geometry, colors = source.getAttribute('color');
      if (!colors) continue;
      const indices: number[] = [], count = source.index?.count ?? source.getAttribute('position').count;
      // The bundled lamp uses bright neutral vertex colors for its glass; keep its pole and shade unlit.
      for (let i = 0; i < count; i += 3) {
        const triangle = [0, 1, 2].map(offset => source.index ? source.index.getX(i + offset) : i + offset);
        if (triangle.every(index => Math.min(colors.getX(index), colors.getY(index), colors.getZ(index)) > 0.8)) indices.push(...triangle);
      }
      if (!indices.length) continue;
      const geometry = source.clone(); geometry.setIndex(indices);
      const glow = new THREE.Mesh(geometry, this.lampMaterial); glow.name = 'lamp-glass'; mesh.add(glow);
      mesh.updateWorldMatrix(true, true);
      const position = source.getAttribute('position'), point = new THREE.Vector3();
      for (const index of indices) bounds.expandByPoint(point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld));
    }
    if (!bounds.isEmpty()) { const point = root.worldToLocal(bounds.getCenter(new THREE.Vector3())); root.userData.lampAnchors = [point.toArray()]; }
  }
  /** Additional catalog models are fetched once, only when placed or previewed. */
  async load(keys: readonly TownAsset[] = WORLD_CORE_ASSETS) {
    if (this.disposed) return this.loadedCount;
    await Promise.allSettled(keys.map(key => this.loadAsset(key)));
    return this.loadedCount;
  }
  asset(key: WorldModelId, width: number, depth = width, maxHeight = width * 1.5) {
    if (key === 'arcade') return this.arcade(width, depth, maxHeight);
    const template = this.templates.get(key);
    if (!template) { if (!this.disposed && !this.requests.has(key)) void this.load([key]); return this.fallback(key, width, depth, maxHeight); }
    const node = template.root.clone(true);
    node.scale.setScalar(Math.min(width / Math.max(template.size.x, 0.001), depth / Math.max(template.size.z, 0.001), maxHeight / Math.max(template.size.y, 0.001)));
    return node;
  }
  private arcade(width: number, depth: number, height: number) {
    const group = new THREE.Group();
    this.box(group, 0x334c61, 0, height * 0.42, 0, width, height * 0.84, depth);
    this.box(group, 0xe2b957, 0, height * 0.90, 0, width * 1.08, height * 0.18, depth * 1.04);
    this.box(group, 0x162537, 0, height * 0.65, depth * 0.51, width * 0.8, height * 0.35, depth * 0.04);
    this.box(group, 0x7ddac4, 0, height * 0.65, depth * 0.54, width * 0.65, height * 0.26, depth * 0.02);
    this.box(group, 0xd6a465, 0, height * 0.38, depth * 0.58, width, height * 0.06, depth * 0.3);
    this.sphere(group, 0xe5755d, -width * 0.22, height * 0.44, depth * 0.6, width * 0.08);
    this.sphere(group, 0x6eafcf, width * 0.22, height * 0.42, depth * 0.6, width * 0.06);
    const bounds = new THREE.Box3().setFromObject(group), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    group.position.set(-center.x, -bounds.min.y, -center.z);
    const fitted = new THREE.Group(); fitted.add(group); fitted.scale.setScalar(Math.min(width / size.x, depth / size.z, height / size.y));
    return fitted;
  }
  /** Per-mesh instancing preserves each GLB's transforms and reduces repeating scenery draw calls. */
  instances(key: TownAsset, placements: Placement[]) {
    const group = new THREE.Group();
    if (!placements.length) return group;
    const model = this.asset(key, 1, 1, 2), bounds = new THREE.Box3().setFromObject(model), size = bounds.getSize(new THREE.Vector3());
    const dummy = new THREE.Object3D(), matrix = new THREE.Matrix4();
    model.updateMatrixWorld(true);
    model.traverse(part => {
      if (!(part instanceof THREE.Mesh)) return;
      const instanced = new THREE.InstancedMesh(part.geometry, part.material, placements.length);
      placements.forEach((placement, index) => {
        dummy.position.set(placement.x, 0.035, placement.z);
        dummy.rotation.set(0, placement.angle ?? 0, 0);
        dummy.scale.setScalar(Math.min(placement.width / Math.max(size.x, size.z, 0.001), placement.height / Math.max(size.y, 0.001)));
        dummy.updateMatrix(); matrix.multiplyMatrices(dummy.matrix, part.matrixWorld); instanced.setMatrixAt(index, matrix);
      });
      instanced.instanceMatrix.needsUpdate = true; instanced.computeBoundingSphere();
      instanced.castShadow = true; instanced.receiveShadow = true; group.add(instanced);
    });
    if (key === 'lamp') group.userData.lampAnchors = placements.flatMap(placement => {
      dummy.position.set(placement.x, 0.035, placement.z); dummy.rotation.set(0, placement.angle ?? 0, 0);
      dummy.scale.setScalar(Math.min(placement.width / Math.max(size.x, size.z, 0.001), placement.height / Math.max(size.y, 0.001))); dummy.updateMatrix();
      return (model.userData.lampAnchors as number[][] ?? []).map(anchor => new THREE.Vector3().fromArray(anchor).applyMatrix4(model.matrixWorld).applyMatrix4(dummy.matrix).toArray());
    });
    return group;
  }
  private fallback(key: TownAsset, width: number, depth: number, maxHeight: number) {
    const group = new THREE.Group();
    if (WORLD_MODEL_CATALOG[key].category === 'building') {
      this.box(group, 0xf1e8ce, 0, 0.37, 0, 0.85, 0.7, 0.8);
      const roof = this.cylinder(group, 0x68866d, 0, 0.91, 0, 0.76, 0.4, true);
      roof.rotation.y = Math.PI / 4; roof.scale.z *= 0.9;
      this.box(group, 0x6d8172, 0, 0.24, 0.415, 0.19, 0.45, 0.03);
      this.box(group, 0x8fb8bd, -0.27, 0.47, 0.415, 0.17, 0.2, 0.03);
      this.box(group, 0x8fb8bd, 0.27, 0.47, 0.415, 0.17, 0.2, 0.03);
    } else if (WORLD_MODEL_CATALOG[key].category === 'nature') {
      this.cylinder(group, 0x977557, 0, 0.35, 0, 0.08, 0.7);
      this.sphere(group, 0x779b65, 0, 0.88, 0, 0.48);
      this.sphere(group, 0xa4b97b, -0.2, 1.07, 0.06, 0.29);
    } else if (key === 'lamp') {
      this.cylinder(group, 0x58706a, 0, 0.65, 0, 0.04, 1.3);
      this.box(group, 0xf6dc93, 0, 1.34, 0, 0.22, 0.23, 0.22).material = this.lampMaterial;
      group.userData.lampAnchors = [[0, 1.34, 0]];
      this.cylinder(group, 0x58706a, 0, 1.5, 0, 0.12, 0.12, true);
    } else if (key === 'bench') {
      this.box(group, 0xb4936c, 0, 0.405, 0, 1.8, 0.09, 0.5);
      this.box(group, 0xb4936c, 0, 0.69, -0.29, 1.8, 0.48, 0.08);
      for (const x of [-0.65, 0.65]) this.box(group, 0x63746a, x, 0.18, 0, 0.08, 0.36, 0.54);
    } else if (key === 'chair') {
      this.box(group, 0x6a8064, 0, 0.385, 0, 0.58, 0.07, 0.5);
      this.box(group, 0x6a8064, 0, 0.66, -0.28, 0.58, 0.48, 0.06);
      for (const x of [-0.31, 0.31]) this.box(group, 0x63746a, x, 0.55, 0, 0.02, 0.03, 0.56);
      for (const x of [-0.27, 0.27]) for (const z of [-0.265, 0.265]) this.box(group, 0x63746a, x, 0.175, z, 0.03, 0.35, 0.03);
    } else if (key === 'fountain') {
      this.cylinder(group, 0xc5cbb6, 0, 0.1, 0, 0.5, 0.2);
      this.cylinder(group, 0x82b4bd, 0, 0.205, 0, 0.43, 0.015);
      this.cylinder(group, 0xdfe1c9, 0, 0.4, 0, 0.1, 0.55);
      this.cylinder(group, 0xb9c8b5, 0, 0.68, 0, 0.25, 0.1);
    } else {
      this.box(group, 0xb4936c, 0, 0.3, 0, 1, 0.12, 0.36);
      this.box(group, 0xb4936c, 0, 0.55, -0.16, 1, 0.35, 0.08);
      for (const x of [-0.35, 0.35]) this.box(group, 0x63746a, x, 0.15, 0, 0.06, 0.3, 0.3);
    }
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    group.scale.setScalar(Math.min(width / size.x, depth / size.z, maxHeight / size.y)); return group;
  }
  releaseInstances(root: THREE.Object3D) {
    root.traverse(node => { if (node instanceof THREE.InstancedMesh) node.dispose(); });
  }
  private disposeObject(root: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    root.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose()); textures.forEach(texture => texture.dispose());
  }
  dispose() {
    this.disposed = true;
    this.loaded.forEach(root => this.disposeObject(root)); this.loaded.clear(); this.templates.clear();
    this.lampMaterial.dispose();
    this.geometries.forEach(geometry => geometry.dispose()); this.materials.forEach(material => material.dispose());
  }
}

export function stableNumber(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  result = Math.imul(result ^ (result >>> 16), 0x85ebca6b);
  result = Math.imul(result ^ (result >>> 13), 0xc2b2ae35); result ^= result >>> 16;
  return (result >>> 0) / 4294967296;
}
