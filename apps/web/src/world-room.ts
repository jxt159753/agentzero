import * as THREE from 'three';
import { WORLD_MODEL_CATALOG, WORLD_ROOM_DIMENSIONS, type WorldModelPlacement } from '@agentzero/contracts';
import type { DaylightState } from './world-daylight';
import type { TownModels } from './world-3d-models';

export const ROOM_CEILING_HEIGHT = 1.2;

/** A room owns its lighting and soft overlays; catalog meshes still belong to TownModels. */
export class TownRoom {
  readonly root = new THREE.Group();
  readonly contents = new THREE.Group();
  readonly door: THREE.Mesh;
  private readonly ceiling = new THREE.Group();
  private readonly cutaway = new THREE.Group();
  private readonly ambient = new THREE.HemisphereLight(0xdbe6ed, 0xc4b7a2, 1.05);
  private readonly key = new THREE.SpotLight(0xffd9b4, 2.6, 7, 1.2, 0.85, 2);
  private readonly windowLight = new THREE.PointLight(0xa6d1ef, 0.6, 5, 2);
  private readonly placedLight = new THREE.PointLight(0xffc78c, 0, 1.5, 2);
  private readonly plane = new THREE.PlaneGeometry(1, 1);
  private readonly gradient: THREE.CanvasTexture;
  private readonly shadow: THREE.MeshBasicMaterial;
  private readonly warmPool: THREE.MeshBasicMaterial;
  private readonly windowPool: THREE.MeshBasicMaterial;
  private readonly glass = new THREE.MeshBasicMaterial({ color: 0x9dc4d6, toneMapped: false });
  private readonly bulb = new THREE.MeshStandardMaterial({ color: 0xffe8bd, emissive: 0xffce8c, emissiveIntensity: 1.4, roughness: 0.5 });
  private readonly floor: THREE.InstancedMesh;
  private contacts?: THREE.InstancedMesh;
  private placements: readonly WorldModelPlacement[] = [];
  private selected?: string;
  private hasPlacedLight = false;

  constructor(private readonly models: TownModels, private readonly mobile: boolean) {
    this.root.name = 'room-interior';
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d')!, gradient = context.createRadialGradient(32, 32, 2, 32, 32, 32);
    gradient.addColorStop(0, '#ffffffd9'); gradient.addColorStop(0.4, '#ffffff83'); gradient.addColorStop(1, '#ffffff00');
    context.fillStyle = gradient; context.fillRect(0, 0, 64, 64);
    this.gradient = new THREE.CanvasTexture(canvas);
    this.shadow = new THREE.MeshBasicMaterial({ color: 0x233336, map: this.gradient, transparent: true, opacity: 0.38, depthWrite: false });
    this.warmPool = new THREE.MeshBasicMaterial({ color: 0xffd9a0, map: this.gradient, transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending });
    this.windowPool = new THREE.MeshBasicMaterial({ color: 0xb9d8ea, map: this.gradient, transparent: true, opacity: 0.15, depthWrite: false, blending: THREE.AdditiveBlending });
    const { width, height: depth } = WORLD_ROOM_DIMENSIONS, wallHeight = ROOM_CEILING_HEIGHT;
    models.box(this.root, 0x817761, 0, 0.012, 0, width, 0.024, depth);
    const planks: Parameters<TownModels['boxes']>[0] = [];
    const palette = [0xb5a184, 0xc5b08e, 0xbea886, 0xbba17c];
    for (let row = 0; row < 8; row++) for (let col = 0; col < 32; col++) planks.push({
      x: -width / 2 + (col + 0.5) * width / 32, y: 0.03, z: -depth / 2 + (row + 0.5) * depth / 8,
      width: width / 32 - 0.003, height: 0.012, depth: depth / 8 - 0.003, color: palette[(row * 3 + col) % palette.length]!,
    });
    this.floor = models.boxes(planks); this.root.add(this.floor);
    this.ceiling.name = 'room-ceiling'; this.root.add(this.ceiling, this.cutaway);
    models.box(this.ceiling, 0xe9e6db, 0, wallHeight, 0, width + 0.04, 0.03, depth + 0.04).castShadow = false;
    for (const x of [-1.65, 0, 1.65]) models.box(this.ceiling, 0x806e56, x, wallHeight - 0.045, 0, 0.065, 0.08, depth);
    const wall = (parent: THREE.Group, x: number, z: number, span: number, side = false) => {
      models.box(parent, 0xe0ddd1, x, (wallHeight + 0.27) / 2, z, side ? 0.04 : span, wallHeight - 0.27, side ? span : 0.04);
      models.box(parent, 0x456a65, x, 0.135, z, side ? 0.045 : span, 0.27, side ? span : 0.045);
      for (const [y, color, height] of [[0.04, 0x2e514e, 0.045], [0.275, 0xbba57b, 0.018], [wallHeight - 0.035, 0xf2e9d4, 0.05]]) {
        models.box(parent, color!, x, y!, z, side ? 0.06 : span, height!, side ? span : 0.06);
      }
      const count = Math.floor(span / 0.3);
      for (let i = 1; i < count; i++) {
        const offset = -span / 2 + i * span / count;
        models.box(parent, 0x63847a, x + (side ? 0 : offset), 0.145, z + (side ? offset : 0), side ? 0.052 : 0.012, 0.19, side ? 0.012 : 0.052);
      }
    };
    wall(this.root, 0, -depth / 2, width);
    wall(this.root, -width / 2, 0, depth, true); wall(this.cutaway, width / 2, 0, depth, true);
    for (const side of [-1, 1]) wall(this.cutaway, side * (width / 4 + 0.15), depth / 2, width / 2 - 0.3);
    models.box(this.cutaway, 0xe0ddd1, 0, (wallHeight + 0.7) / 2, depth / 2, 0.6, wallHeight - 0.7, 0.04);
    this.door = models.box(this.cutaway, 0x52766b, 0, 0.35, depth / 2, 0.6, 0.7, 0.035);
    for (const side of [-1, 1]) {
      models.box(this.cutaway, 0xe9dfc7, side * 0.315, 0.365, depth / 2 - 0.03, 0.03, 0.73, 0.055);
      models.box(this.cutaway, 0x718d7d, side * 0.145, 0.37, depth / 2 - 0.024, 0.24, 0.55, 0.015);
    }
    models.box(this.cutaway, 0xe9dfc7, 0, 0.72, depth / 2 - 0.03, 0.66, 0.03, 0.055);
    models.box(this.cutaway, 0xd7b56d, 0.22, 0.32, depth / 2 - 0.045, 0.055, 0.014, 0.025);

    // Tall windows, inset landscape silhouettes and brass mullions add depth without new model downloads.
    for (const x of [-1.38, 1.38]) {
      const panel: THREE.Mesh = models.box(this.root, 0xffffff, x, 0.69, -depth / 2 + 0.027, 1.05, 0.66, 0.012);
      panel.material = this.glass; panel.castShadow = false;
      for (let i = 0; i < 7; i++) {
        const h = 0.07 + (i * 3 % 5) * 0.025;
        models.box(this.root, i % 2 ? 0x718b91 : 0x5e7b83, x - 0.45 + i * 0.15, 0.36 + h / 2, -depth / 2 + 0.038, 0.14, h, 0.006).castShadow = false;
      }
      for (const side of [-1, 1]) {
        models.box(this.root, 0xece4ce, x + side * 0.54, 0.69, -depth / 2 + 0.052, 0.035, 0.73, 0.06);
        models.box(this.root, 0xece4ce, x, 0.69 + side * 0.35, -depth / 2 + 0.052, 1.12, 0.035, 0.06);
      }
      for (const side of [-1, 1]) models.box(this.root, 0x8c8266, x + side * 0.18, 0.69, -depth / 2 + 0.055, 0.018, 0.66, 0.035);
      models.box(this.root, 0x8c8266, x, 0.65, -depth / 2 + 0.055, 1.05, 0.018, 0.035);
      models.box(this.root, 0xbca984, x, 0.33, -depth / 2 + 0.055, 1.18, 0.028, 0.1);
      for (const side of [-1, 1]) this.pool(this.windowPool, x + side * 0.26, -1.12, 0.52, 1.2, -0.22);
    }

    const gallery = new THREE.Group(); gallery.name = 'room-gallery'; this.root.add(gallery);
    for (const [index, z] of [-0.95, 0.15, 1.1].entries()) {
      models.box(gallery, 0x9b8057, -width / 2 + 0.033, 0.65, z, 0.025, 0.44, 0.62);
      models.box(gallery, 0xf2e5c9, -width / 2 + 0.05, 0.65, z, 0.01, 0.39, 0.57);
      const art = models.cylinder(gallery, [0xc47f56, 0x718c7b, 0xc5a05e][index]!, -width / 2 + 0.058, 0.7, z - 0.075, 0.105, 0.004);
      art.rotation.z = Math.PI / 2;
      for (let i = 0; i < 3; i++) models.box(gallery, [0x315e60, 0xa0b29b, 0xd1b37c][i]!, -width / 2 + 0.064 + i * 0.003, 0.51 + i * 0.04, z + i * 0.04, 0.004, 0.055, 0.45 - i * 0.07);
    }
    // Flat woven rugs zone the open floor; existing saved furniture keeps its exact coordinates.
    const rugs = new THREE.Group(); rugs.name = 'room-rugs'; this.root.add(rugs);
    const rug = (x: number, z: number, w: number, d: number, color: number) => {
      models.box(rugs, 0xd8c6a2, x, 0.037, z, w, 0.001, d).castShadow = false;
      models.box(rugs, color, x, 0.038, z, w - 0.07, 0.001, d - 0.07).castShadow = false;
      for (const side of [-1, 1]) models.box(rugs, 0xbfa878, x + side * (w / 2 - 0.095), 0.0388, z, 0.014, 0.0004, d - 0.16).castShadow = false;
    };
    rug(-0.95, -0.15, 1.85, 1.65, 0x6c8b80); rug(1.3, 0, 1.35, 1.55, 0xa47e63); rug(0, depth / 2 - 0.37, 0.72, 0.48, 0x54716b);

    // Two visible pendants share one broad key light, retaining one shadow map on desktop.
    for (const x of [-1.05, 1.05]) {
      models.cylinder(this.ceiling, 0x535c52, x, 1.08, -0.15, 0.008, 0.2);
      models.cylinder(this.ceiling, 0x42635b, x, 0.945, -0.15, 0.15, 0.1, true);
      const diffuser = models.cylinder(this.ceiling, 0xffe8bd, x, 0.895, -0.15, 0.125, 0.012);
      diffuser.material = this.bulb; diffuser.castShadow = false;
      this.pool(this.warmPool, x, -0.15, 2.1, 1.8, 0);
    }
    for (const x of [-2.12, 0, 2.12]) {
      models.box(this.root, 0x9f865a, x, 0.75, -depth / 2 + 0.04, 0.04, 0.18, 0.035);
      const sconce = models.box(this.root, 0xffe8bd, x, 0.75, -depth / 2 + 0.065, 0.065, 0.1, 0.025);
      sconce.material = this.bulb; sconce.castShadow = false;
    }
    this.key.position.set(0, 1.04, 0.2); this.key.target.position.set(0, 0, -0.2);
    this.key.castShadow = !mobile; this.key.shadow.mapSize.set(512, 512);
    this.key.shadow.camera.near = 0.025; this.key.shadow.camera.far = 7;
    this.key.shadow.normalBias = 0.0015; this.key.shadow.bias = -0.0001; this.key.shadow.radius = 2;
    this.windowLight.position.set(0, 0.78, -depth / 2 + 0.28);
    this.root.add(this.ambient, this.key, this.key.target, this.windowLight, this.placedLight, this.contents);
  }

  private pool(material: THREE.MeshBasicMaterial, x: number, z: number, width: number, depth: number, rotation: number) {
    const plane = new THREE.Mesh(this.plane, material); plane.position.set(x, 0.038, z);
    plane.rotation.set(-Math.PI / 2, 0, rotation); plane.scale.set(width, depth, 1); plane.raycast = () => {}; this.root.add(plane);
  }

  setContents(placements: readonly WorldModelPlacement[]) {
    this.contents.clear(); this.placements = placements;
    if (this.contacts) { this.root.remove(this.contacts); this.contacts.dispose(); }
    this.contacts = new THREE.InstancedMesh(this.plane, this.shadow, placements.length);
    this.contacts.raycast = () => {}; this.root.add(this.contacts);
    for (const item of placements) {
      const spec = WORLD_MODEL_CATALOG[item.model_id], node = this.models.asset(item.model_id, spec.width, spec.depth, spec.maxHeight);
      node.name = 'placement:' + item.id; node.position.set(item.x, 0.04, item.y);
      node.rotation.y = item.rotation * Math.PI / 180; node.scale.multiplyScalar(item.scale); this.contents.add(node);
    }
    const lamp = placements.find(item => item.model_id === 'lamp');
    this.hasPlacedLight = Boolean(lamp) && !this.mobile;
    this.placedLight.visible = this.hasPlacedLight;
    if (lamp) this.placedLight.position.set(lamp.x, 0.04 + WORLD_MODEL_CATALOG.lamp.maxHeight * lamp.scale * 0.88, lamp.y);
    this.selected = undefined; this.setSelected(undefined, true);
  }

  setSelected(id?: string, force = false) {
    if (!force && this.selected === id) return;
    this.selected = id;
    const dummy = new THREE.Object3D();
    this.placements.forEach((item, index) => {
      const spec = WORLD_MODEL_CATALOG[item.model_id];
      dummy.position.set(item.x, 0.039, item.y); dummy.rotation.set(-Math.PI / 2, 0, -item.rotation * Math.PI / 180);
      dummy.scale.set(item.id === id ? 0 : spec.width * item.scale + 0.09, spec.depth * item.scale + 0.09, 1);
      dummy.updateMatrix(); this.contacts!.setMatrixAt(index, dummy.matrix);
    });
    if (this.contacts) { this.contacts.instanceMatrix.needsUpdate = true; this.contacts.computeBoundingSphere(); }
  }

  setOverview(overview: boolean) { this.ceiling.visible = !overview; this.cutaway.visible = !overview; }

  setDaylight(daylight: DaylightState) {
    // Pale ceiling/floor bounce keeps unlit furniture readable without flattening the key shadows.
    this.ambient.intensity = 1.05 + daylight.daylight * 0.3;
    this.key.intensity = 2.1 + daylight.lamps * 0.6;
    this.windowLight.intensity = 0.06 + daylight.daylight * 0.54;
    this.placedLight.intensity = this.hasPlacedLight ? 0.075 + daylight.lamps * 0.075 : 0;
    this.glass.color.setHex(daylight.phase === 'night' ? 0x355d84 : daylight.phase === 'day' ? 0x9dc4d6 : 0x8f9fab);
    this.windowPool.opacity = 0.025 + daylight.daylight * 0.2;
    this.warmPool.opacity = 0.07 + daylight.lamps * 0.06;
  }

  get lightCount() { return 2 + (this.hasPlacedLight ? 1 : 0); }
  get shadowLightCount() { return this.key.castShadow ? 1 : 0; }
  get windowStrength() { return this.windowLight.intensity; }

  dispose() {
    this.contacts?.dispose(); this.floor.dispose(); this.key.shadow.dispose();
    this.plane.dispose(); this.gradient.dispose();
    for (const material of [this.shadow, this.warmPool, this.windowPool, this.glass, this.bulb]) material.dispose();
    this.root.clear();
  }
}
