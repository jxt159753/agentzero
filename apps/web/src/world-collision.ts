import { WORLD_MODEL_CATALOG, type WorldSnapshot } from '@agentzero/contracts';
import type { WorldPoint } from './world-scene.js';

export const PLAYER_RADIUS = 0.075;
type BoxObstacle = { x: number; y: number; halfWidth: number; halfDepth: number; cosine: number; sine: number };
type CircleObstacle = { x: number; y: number; radius: number };
export type WorldObstacle = BoxObstacle | CircleObstacle;
const CLEARANCE = 0.000001;

/** Use the same local fitting boxes and Y rotation as the placed meshes. */
export function worldObstacles(world: Pick<WorldSnapshot, 'lands' | 'places'>, roomId: string | null): WorldObstacle[] {
  const obstacles: WorldObstacle[] = roomId ? [] : [
    ...world.places.map(place => ({ x: place.x, y: place.y, halfWidth: 0.59, halfDepth: 0.59, cosine: 1, sine: 0 })),
    { x: 0, y: -0.75, radius: 0.54 - PLAYER_RADIUS },
  ];
  for (const land of world.lands) for (const item of land.models ?? []) {
    if ((item.room_id ?? null) !== roomId) continue;
    const spec = WORLD_MODEL_CATALOG[item.model_id], angle = item.rotation * Math.PI / 180;
    obstacles.push({ x: item.x + (roomId ? 0 : land.x), y: item.y + (roomId ? 0 : land.y),
      halfWidth: spec.width * item.scale / 2, halfDepth: spec.depth * item.scale / 2,
      cosine: Math.cos(angle), sine: Math.sin(angle) });
  }
  return obstacles;
}

function sweep(from: WorldPoint, delta: WorldPoint, obstacle: WorldObstacle): { time: number; normal: WorldPoint } | undefined {
  const dx = from.x - obstacle.x, dy = from.y - obstacle.y;
  if ('radius' in obstacle) {
    const radius = obstacle.radius + PLAYER_RADIUS, distance = dx * dx + dy * dy - radius * radius;
    if (distance < 0) {
      const outward = dx * delta.x + dy * delta.y;
      if (outward >= 0) return;
      const length = Math.hypot(dx, dy);
      return { time: 0, normal: { x: dx / length, y: dy / length } };
    }
    const length = delta.x * delta.x + delta.y * delta.y, toward = dx * delta.x + dy * delta.y;
    const discriminant = toward * toward - length * distance;
    if (!length || toward >= 0 || discriminant <= 0) return;
    const time = (-toward - Math.sqrt(discriminant)) / length;
    if (time < 0 || time >= 1) return;
    return { time, normal: { x: (dx + delta.x * time) / radius, y: (dy + delta.y * time) / radius } };
  }
  const { cosine: c, sine: s } = obstacle;
  const start = [c * dx - s * dy, s * dx + c * dy];
  const direction = [c * delta.x - s * delta.y, s * delta.x + c * delta.y];
  const half = [obstacle.halfWidth + PLAYER_RADIUS, obstacle.halfDepth + PLAYER_RADIUS];
  if (start.every((value, axis) => Math.abs(value) < half[axis]!)) {
    // Quantized saved positions may overlap a face. Allow escape/sideways motion, never deeper entry.
    const axis = half[0]! - Math.abs(start[0]!) <= half[1]! - Math.abs(start[1]!) ? 0 : 1;
    const outward = Math.sign(start[axis]!) || Math.sign(direction[axis]!);
    if (direction[axis]! * outward >= 0) return;
    return { time: 0, normal: axis === 0 ? { x: c * outward, y: -s * outward } : { x: s * outward, y: c * outward } };
  }
  let entry = -Infinity, exit = Infinity, normalX = 0, normalY = 0;
  for (let axis = 0; axis < 2; axis++) {
    const speed = direction[axis]!, position = start[axis]!, extent = half[axis]!;
    if (Math.abs(speed) < 1e-12) { if (Math.abs(position) >= extent) return; continue; }
    const a = (-extent - position) / speed, b = (extent - position) / speed;
    const near = Math.min(a, b);
    if (near > entry) {
      entry = near;
      normalX = axis === 0 ? -Math.sign(speed) : 0; normalY = axis === 1 ? -Math.sign(speed) : 0;
    }
    exit = Math.min(exit, Math.max(a, b));
    if (entry >= exit) return;
  }
  if (entry < 0 || entry >= 1 || exit <= 0) return;
  return { time: entry, normal: { x: c * normalX + s * normalY, y: -s * normalX + c * normalY } };
}

/** Sweep the whole movement segment, then keep its wall-parallel component. Jumping remains visual. */
export function slideWorldMovement(from: WorldPoint, to: WorldPoint, obstacles: readonly WorldObstacle[]): WorldPoint {
  let position = { x: from.x, y: from.y }, delta = { x: to.x - from.x, y: to.y - from.y };
  for (let contact = 0; contact < 4; contact++) {
    const distance = Math.hypot(delta.x, delta.y);
    if (distance < CLEARANCE) break;
    let first: ReturnType<typeof sweep>;
    for (const obstacle of obstacles) {
      const hit = sweep(position, delta, obstacle);
      if (hit && (!first || hit.time < first.time)) first = hit;
    }
    if (!first) return { x: position.x + delta.x, y: position.y + delta.y };
    const travel = Math.max(0, first.time - CLEARANCE / distance);
    position = { x: position.x + delta.x * travel, y: position.y + delta.y * travel };
    const remaining = 1 - first.time, inward = delta.x * first.normal.x + delta.y * first.normal.y;
    delta = { x: (delta.x - first.normal.x * inward) * remaining, y: (delta.y - first.normal.y * inward) * remaining };
  }
  return position;
}
