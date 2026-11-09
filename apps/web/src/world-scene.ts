import { WORLD_BOUNDS, WORLD_MODEL_CATALOG, WORLD_ROOM_DIMENSIONS, worldLandDimensions, type WorldLand, type WorldModelDraft, type WorldModelPlacement, type WorldSnapshot, type WorldStreamDelta } from '@agentzero/contracts';

/** Ground-plane coordinates, independent of pixels. A 3D renderer maps x/y to X/Z. */
export interface WorldPoint { x: number; y: number; room_id?: string | null }
export interface ArcadeSelection { land: WorldLand; placement: WorldModelPlacement }
export function nearbyArcade(lands: WorldLand[], point: WorldPoint): ArcadeSelection | undefined {
  let nearest: ArcadeSelection | undefined, distance = 0.65;
  for (const land of lands) for (const placement of land.models ?? []) {
    if (placement.model_id !== 'arcade' || (placement.room_id ?? null) !== (point.room_id ?? null)) continue;
    const dx = placement.x + (placement.room_id ? 0 : land.x) - point.x, dy = placement.y + (placement.room_id ? 0 : land.y) - point.y;
    const next = Math.hypot(dx, dy);
    if (next < distance) { distance = next; nearest = { land, placement }; }
  }
  return nearest;
}
export function houseEntrance(land: WorldLand, house: WorldModelPlacement): WorldPoint {
  const angle = house.rotation * Math.PI / 180, depth = WORLD_MODEL_CATALOG[house.model_id].depth * house.scale / 2 + 0.16;
  return { x: land.x + house.x + Math.sin(angle) * depth, y: land.y + house.y + Math.cos(angle) * depth };
}
export type WorldPlacementPreview = WorldModelDraft & { selectedId?: string };
export interface SceneBounds { min_x: number; max_x: number; min_y: number; max_y: number }
export interface SceneCamera extends WorldPoint { zoom: number; follow: boolean; revision: number }
export const DEFAULT_SCENE_BOUNDS: SceneBounds = WORLD_BOUNDS;
export const WALK_SPEED = 4;
export const FIRST_PERSON_WALK_SPEED = 0.45, FIRST_PERSON_RUN_SPEED = 0.9;
const JUMP_VELOCITY = 0.5, GRAVITY = 0.98;
export const JUMP_DURATION = 2 * JUMP_VELOCITY / GRAVITY;

/** Height above the ground after elapsed real seconds; one world unit is ten metres. */
export function sampleJumpHeight(seconds: number): number {
  return seconds <= 0 || seconds >= JUMP_DURATION ? 0 : JUMP_VELOCITY * seconds - GRAVITY * seconds * seconds / 2;
}

/** Use the plot edge so large and rectangular plots are reachable from the road. */
export function nearbyShowcaseLand(lands: WorldLand[], point: WorldPoint): WorldLand | undefined {
  let nearest: WorldLand | undefined, nearestDistance = 1.5, nearestCenter = Infinity;
  for (const land of lands) {
    if (!land.owner_agent_id || !land.showcase?.length) continue;
    const { width, height } = worldLandDimensions(land);
    const dx = Math.abs(land.x - point.x), dy = Math.abs(land.y - point.y);
    const distance = Math.hypot(Math.max(0, dx - width / 2), Math.max(0, dy - height / 2));
    const center = Math.hypot(dx, dy);
    if (distance < nearestDistance || distance === nearestDistance && center < nearestCenter) {
      nearest = land; nearestDistance = distance; nearestCenter = center;
    }
  }
  return nearest;
}

export function sceneBounds(world: WorldSnapshot): SceneBounds {
  if (world.self.room_id) return { min_x: -WORLD_ROOM_DIMENSIONS.width / 2 + 0.08, max_x: WORLD_ROOM_DIMENSIONS.width / 2 - 0.08,
    min_y: -WORLD_ROOM_DIMENSIONS.height / 2 + 0.08, max_y: WORLD_ROOM_DIMENSIONS.height / 2 - 0.08 };
  return world.bounds ?? DEFAULT_SCENE_BOUNDS;
}
export function clampPoint(point: WorldPoint, bounds: SceneBounds): WorldPoint {
  return { x: Math.max(bounds.min_x, Math.min(bounds.max_x, point.x)), y: Math.max(bounds.min_y, Math.min(bounds.max_y, point.y)) };
}
export function moveTowards(from: WorldPoint, to: WorldPoint, distance: number): WorldPoint {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
  if (!length || length <= distance) return { ...to };
  return { x: from.x + dx / length * distance, y: from.y + dy / length * distance };
}
export function walk(position: WorldPoint, direction: WorldPoint, target: WorldPoint | null, seconds: number, bounds: SceneBounds): WorldPoint {
  const length = Math.hypot(direction.x, direction.y), distance = WALK_SPEED * Math.min(seconds, 0.05);
  return clampPoint(length ? { x: position.x + direction.x / length * distance, y: position.y + direction.y / length * distance }
    : target ? moveTowards(position, target, distance) : position, bounds);
}
export function interpolatePoint(from: WorldPoint, to: WorldPoint, seconds: number, rate = 8): WorldPoint {
  const alpha = 1 - Math.exp(-rate * Math.min(seconds, 0.05));
  return { x: from.x + (to.x - from.x) * alpha, y: from.y + (to.y - from.y) * alpha };
}
export const quantizePoint = (point: WorldPoint): WorldPoint => ({ x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000,
  ...(point.room_id !== undefined ? { room_id: point.room_id } : {}) });
interface MovementSample extends WorldPoint { moving: boolean }
/** Coalesce render-frame samples; a reconnect resends only the latest position. */
export class MovementOutbox {
  private desired?: MovementSample;
  private sent?: MovementSample;
  private sequence = 0;
  move(point: WorldPoint, moving = true) { this.desired = { ...quantizePoint(point), moving }; }
  reconnect() { this.sent = undefined; this.sequence = 0; }
  clear() { this.desired = undefined; this.sent = undefined; }
  next() {
    const point = this.desired;
    if (!point || this.sent?.x === point.x && this.sent.y === point.y && this.sent.moving === point.moving && this.sent.room_id === point.room_id) return;
    this.sent = point;
    return { type: 'move' as const, seq: ++this.sequence, ...point };
  }
}

function applyChanges<T extends { id: string }>(items: T[], changes?: { upsert: T[]; remove: string[] }): T[] {
  if (!changes) return items;
  const removed = new Set(changes.remove), updates = new Map(changes.upsert.map(item => [item.id, item]));
  const result = items.filter(item => !removed.has(item.id)).map(item => {
    const replacement = updates.get(item.id); updates.delete(item.id); return replacement ?? item;
  });
  return [...result, ...updates.values()];
}

/** Keep unchanged collection references so movement never rebuilds town geometry. */
export function applyWorldDelta(world: WorldSnapshot, delta: WorldStreamDelta): WorldSnapshot {
  return { ...world, server_time: delta.server_time, bounds: delta.bounds ?? world.bounds, self: delta.self ?? world.self,
    lands: applyChanges(world.lands, delta.lands), agents: applyChanges(world.agents, delta.agents), visitors: applyChanges(world.visitors, delta.visitors) };
}
