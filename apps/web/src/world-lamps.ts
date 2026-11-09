import * as THREE from 'three';

/** All lamps share one ground-glow draw; only the nearest few use real, shadow-free point lights. */
export class TownLamps {
  readonly root = new THREE.Group();
  private readonly points: THREE.PointLight[];
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private anchors: THREE.Vector3[] = [];
  private glow?: THREE.InstancedMesh;
  private readonly projection = new THREE.Vector3();
  private lastSelection = -Infinity;
  private selection: THREE.Vector3[] = [];
  get count() { return this.anchors.length; }

  constructor(mobile: boolean) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d')!, gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, '#ffffffb0'); gradient.addColorStop(0.25, '#ffffff70'); gradient.addColorStop(1, '#ffffff00');
    context.fillStyle = gradient; context.fillRect(0, 0, 64, 64);
    this.texture = new THREE.CanvasTexture(canvas);
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, color: 0xffc66b, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.points = Array.from({ length: mobile ? 2 : 4 }, () => {
      const light = new THREE.PointLight(0xffcc87, 0, 1.8, 2); light.castShadow = false; this.root.add(light); return light;
    });
    this.root.name = 'town-lamp-lighting';
  }
  rebuild(roots: readonly THREE.Object3D[]) {
    const anchors: THREE.Vector3[] = [];
    for (const root of roots) {
      root.updateWorldMatrix(true, true);
      root.traverse(node => {
        for (const anchor of node.userData.lampAnchors as number[][] ?? []) anchors.push(node.localToWorld(new THREE.Vector3().fromArray(anchor)));
      });
    }
    this.anchors = anchors; this.lastSelection = -Infinity;
    if (this.glow) { this.root.remove(this.glow); this.glow.dispose(); }
    this.glow = new THREE.InstancedMesh(this.geometry, this.material, anchors.length);
    const dummy = new THREE.Object3D(); dummy.rotation.x = -Math.PI / 2; dummy.scale.set(1.6, 1.6, 1);
    anchors.forEach((anchor, index) => { dummy.position.set(anchor.x, 0.045, anchor.z); dummy.updateMatrix(); this.glow!.setMatrixAt(index, dummy.matrix); });
    this.glow.instanceMatrix.needsUpdate = true; this.glow.computeBoundingSphere(); this.glow.raycast = () => {}; this.root.add(this.glow);
  }
  update(x: number, z: number, strength: number, now: number) {
    this.material.opacity = strength * 0.38;
    if (this.glow) this.glow.visible = strength > 0.01;
    if (now - this.lastSelection >= 500) {
      this.lastSelection = now; this.projection.set(x, 0, z);
      this.selection = this.anchors.filter(anchor => Math.hypot(anchor.x - x, anchor.z - z) < 8)
        .sort((a, b) => a.distanceToSquared(this.projection) - b.distanceToSquared(this.projection)).slice(0, this.points.length);
    }
    this.points.forEach((light, index) => {
      const anchor = this.selection[index]; if (anchor) light.position.copy(anchor);
      light.intensity = anchor ? strength * 0.22 : 0;
    });
    return strength > 0.01 ? this.selection.length : 0;
  }
  dispose() {
    this.glow?.dispose(); this.geometry.dispose(); this.material.dispose(); this.texture.dispose(); this.root.clear();
  }
}
