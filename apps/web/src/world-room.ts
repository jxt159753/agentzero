import * as THREE from 'three';
import { WORLD_MODEL_CATALOG, WORLD_ROOM_DIMENSIONS, type WorldModelPlacement } from '@agentzero/contracts';
import type { DaylightState } from './world-daylight';
import type { TownModels } from './world-3d-models';

/** A room owns its lighting and soft overlays; catalog meshes still belong to TownModels. */
export class TownRoom {
  readonly root = new THREE.Group();
  readonly contents = new THREE.Group();
  readonly door: THREE.Mesh;
  private readonly ceiling: THREE.Mesh;
  private readonly cutaway = new THREE.Group();
  private readonly ambient = new THREE.HemisphereLight(0xdbe6ed, 0xc4b7a2, 1.05);
  private readonly key = new THREE.SpotLight(0xffd1a0, 0.48, 4.5, 1.1, 0.85, 2);
  private readonly windowLight = new THREE.PointLight(0xa6d1ef, 0.13, 3.2, 2);
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
    const { width, height: depth } = WORLD_ROOM_DIMENSIONS, wallHeight = 0.55;
    models.box(this.root, 0x817761, 0, 0.012, 0, width, 0.024, depth);
    const planks: Parameters<TownModels['boxes']>[0] = [];
    const palette = [0xbeb298, 0xc8b89d, 0xb9ac92, 0xc3b49a];
    for (let row = 0; row < 4; row++) for (let col = 0; col < 10; col++) planks.push({
      x: -width / 2 + (col + 0.5) * width / 10, y: 0.03, z: -depth / 2 + (row + 0.5) * depth / 4,
      width: width / 10 - 0.004, height: 0.012, depth: depth / 4 - 0.004, color: palette[(row * 3 + col) % palette.length]!,
    });
    this.floor = models.boxes(planks); this.root.add(this.floor);
    this.ceiling = models.box(this.root, 0xe2dfd2, 0, wallHeight, 0, width + 0.04, 0.03, depth + 0.04);
    this.ceiling.name = 'room-ceiling'; this.ceiling.castShadow = false;
    this.root.add(this.cutaway);
    const wall = (parent: THREE.Group, x: number, z: number, span: number, side = false) => {
      models.box(parent, 0xd1d8d2, x, 0.38, z, side ? 0.04 : span, 0.34, side ? span : 0.04);
      models.box(parent, 0x768e86, x, 0.125, z, side ? 0.045 : span, 0.25, side ? span : 0.045);
      models.box(parent, 0x9bafa1, x, 0.253, z, side ? 0.055 : span, 0.012, side ? span : 0.055);
      models.box(parent, 0x576d65, x, 0.055, z, side ? 0.056 : span, 0.04, side ? span : 0.056);
    };
    wall(this.root, 0, -depth / 2, width);
    wall(this.root, -width / 2, 0, depth, true); wall(this.cutaway, width / 2, 0, depth, true);
    for (const side of [-1, 1]) wall(this.cutaway, side * (width / 4 + 0.1), depth / 2, width / 2 - 0.2);
    this.door = models.box(this.cutaway, 0x5d7b6d, 0, 0.18, depth / 2, 0.4, 0.36, 0.035);
    models.box(this.cutaway, 0xc3bea0, 0.14, 0.18, depth / 2 - 0.025, 0.018, 0.018, 0.018);

    for (const x of [-0.88, 0.88]) {
      const panel: THREE.Mesh = models.box(this.root, 0xffffff, x, 0.362, -depth / 2 + 0.027, 0.67, 0.25, 0.012);
      panel.material = this.glass; panel.castShadow = false;
      for (const side of [-1, 1]) {
        models.box(this.root, 0xebe8d5, x + side * 0.345, 0.362, -depth / 2 + 0.043, 0.022, 0.286, 0.035);
        models.box(this.root, 0xebe8d5, x, 0.362 + side * 0.135, -depth / 2 + 0.043, 0.71, 0.018, 0.035);
      }
      models.box(this.root, 0xd6decf, x, 0.362, -depth / 2 + 0.047, 0.014, 0.25, 0.025);
      models.box(this.root, 0xd6decf, x, 0.362, -depth / 2 + 0.047, 0.67, 0.012, 0.025);
      models.box(this.root, 0xaab7a3, x, 0.215, -depth / 2 + 0.055, 0.76, 0.022, 0.09);
      for (const side of [-1, 1]) this.pool(this.windowPool, x + side * 0.17, -0.65, 0.34, 0.8, -0.27);
    }
    // A visible pendant establishes the warm key; neither the window fill nor placed lamp casts shadows.
    models.cylinder(this.root, 0x596a5f, -0.35, 0.502, -0.05, 0.008, 0.085);
    models.cylinder(this.root, 0x698378, -0.35, 0.454, -0.05, 0.09, 0.065, true);
    const diffuser = models.cylinder(this.root, 0xffe8bd, -0.35, 0.421, -0.05, 0.072, 0.012);
    diffuser.material = this.bulb; diffuser.castShadow = false;
    this.key.position.set(-0.35, 0.408, -0.05); this.key.target.position.set(0.1, 0, -0.15);
    this.key.castShadow = !mobile; this.key.shadow.mapSize.set(512, 512);
    this.key.shadow.camera.near = 0.025; this.key.shadow.camera.far = 4.5;
    this.key.shadow.normalBias = 0.0015; this.key.shadow.bias = -0.0001; this.key.shadow.radius = 2;
    this.windowLight.position.set(-0.88, 0.38, -0.96);
    this.pool(this.warmPool, 0.08, -0.12, 1.8, 1.5, 0);
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
    this.key.intensity = 0.42 + daylight.lamps * 0.16;
    this.windowLight.intensity = 0.025 + daylight.daylight * 0.17;
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
