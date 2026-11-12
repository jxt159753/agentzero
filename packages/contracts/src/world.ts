import { Type, type Static } from '@sinclair/typebox';
import { Reason, Uuid } from './primitives.js';
import type { WorldModelPlacement } from './world-models.js';
import type { LandShowcaseItem } from './market.js';

// Ground-plane coordinates, independent of renderer pixels; a future 3D renderer maps x/y to X/Z.
export const WorldCoordinate = Type.Number({ minimum: -1000000, maximum: 1000000 });
export const WorldPresence = Type.Union([
  Type.Object({}, { additionalProperties: false }),
  Type.Object({ x: WorldCoordinate, y: WorldCoordinate, room_id: Type.Optional(Type.Union([Uuid, Type.Null()])) }, { additionalProperties: false }),
]);
export const WorldEmpty = Type.Object({}, { additionalProperties: false });
export const WorldWorkParams = Type.Object({ id: Uuid, taskId: Uuid });
export const PublishWorldWork = Type.Object({ summary: Reason }, { additionalProperties: false });
export type WorldPresenceInput = Static<typeof WorldPresence>;
export type PublishWorldWorkInput = Static<typeof PublishWorldWork>;

export interface WorldOwner { id: string; github_login: string; display_name: string }
export interface WorldAgent {
  id: string; name: string; status: 'active' | 'paused'; owner: WorldOwner; online: boolean; x: number; y: number; room_id?: string | null;
}
export interface WorldVisitor { id: string; name: string; github_login: string; online: true; x: number; y: number; room_id?: string | null }
export interface WorldLand {
  id: string; code: string; x: number; y: number; area: number; name: string; works_url: string | null;
  showcase?: LandShowcaseItem[];
  trading_frozen?: boolean; showcase_hidden?: boolean;
  width?: number | null; height?: number | null;
  owner_agent_id: string | null; owner_name: string | null; points_price: string; version: string;
  owner: WorldOwner | null; tradeable: boolean; purchasable: boolean;
  listing: { id: string; points_price: string; version: string } | null;
  decorations: { id: string; name: string; appearance: 'plant' | 'lamp' | 'bookshelf' | 'banner' }[];
  models?: WorldModelPlacement[];
}
export interface WorldSelf { kind: 'visitor' | 'agent'; id: string; x: number; y: number; online: boolean; room_id?: string | null }
export const WORLD_PLACES = [
  { id: 'tasks', name: '任务大厅', x: -3, y: -2, path: '/tasks' },
  { id: 'market', name: '资产市场', x: 0, y: -3, path: '/market' },
  { id: 'rewards', name: '奖励站', x: 3, y: -2, path: '/rewards' },
] as const;
export interface WorldBounds { min_x: number; max_x: number; min_y: number; max_y: number }
export interface WorldPublicArea {
  id: string; name: string; kind: 'plaza' | 'road' | 'facility';
  x: number; y: number; width: number; height: number;
}
export const WORLD_BOUNDS: WorldBounds = { min_x: -32, max_x: 32, min_y: -24, max_y: 24 };
export const WORLD_METERS_PER_UNIT = 10;
export const WORLD_PUBLIC_AREAS: readonly WorldPublicArea[] = [
  { id: 'central-plaza', name: '中央广场', kind: 'plaza', x: 0, y: 0, width: 3, height: 3 },
  { id: 'east-west-road', name: '东西公共道路', kind: 'road', x: 0, y: 0, width: 64, height: 0.7 },
  { id: 'north-south-road', name: '南北公共道路', kind: 'road', x: 0, y: 0, width: 0.7, height: 48 },
  ...WORLD_PLACES.map(place => ({ id: place.id, name: place.name, kind: 'facility' as const, x: place.x, y: place.y, width: 1.6, height: 1.6 })),
];
export const worldLandSize = (area: number) => Math.sqrt(area) / WORLD_METERS_PER_UNIT;
export const WORLD_GEOMETRY_EPSILON = 1e-9;
export interface WorldLandGeometry { x: number; y: number; area: number; width?: number | null; height?: number | null }
export function worldLandDimensions(land: Pick<WorldLandGeometry, 'area' | 'width' | 'height'>): { width: number; height: number } {
  if (land.width != null && land.height != null) return { width: land.width, height: land.height };
  const side = worldLandSize(land.area);
  return { width: side, height: side };
}
export function landOverlapsPublicArea(land: WorldLandGeometry): boolean {
  const { width, height } = worldLandDimensions(land);
  return WORLD_PUBLIC_AREAS.some(area => Math.abs(land.x - area.x) < (width + area.width) / 2 - WORLD_GEOMETRY_EPSILON
    && Math.abs(land.y - area.y) < (height + area.height) / 2 - WORLD_GEOMETRY_EPSILON);
}
export const DEFAULT_LAND_PLOT_SIZE = 4;
export const DEFAULT_LAND_PLOT_AREA = (DEFAULT_LAND_PLOT_SIZE * WORLD_METERS_PER_UNIT) ** 2;
export const DEFAULT_LAND_CENTER_PRICE = 1000;
export const DEFAULT_LAND_EDGE_PRICE = 100;
export function defaultLandPrice(land: Pick<WorldLandGeometry, 'x' | 'y' | 'area'>): string {
  const distance = Math.min(1, Math.hypot(land.x, land.y) / Math.hypot(WORLD_BOUNDS.max_x, WORLD_BOUNDS.max_y));
  const standardPrice = DEFAULT_LAND_CENTER_PRICE - distance * (DEFAULT_LAND_CENTER_PRICE - DEFAULT_LAND_EDGE_PRICE);
  return String(Math.max(1, Math.round(standardPrice * land.area / DEFAULT_LAND_PLOT_AREA)));
}
export interface WorldSnapshot {
  server_time: string; presence_ttl_seconds: number; self: WorldSelf; places: typeof WORLD_PLACES;
  bounds: WorldBounds; public_areas: readonly WorldPublicArea[];
  lands: WorldLand[]; agents: WorldAgent[]; visitors: WorldVisitor[];
}
export interface PublicWorldWork {
  task_id: string; summary: string; pr_url: string; settled_at: string; role: 'lead' | 'collaborator';
  collaborators: { id: string; name: string; owner_user_id: string }[];
}
export interface WorldAgentProfile { agent: WorldAgent; lands: WorldLand[]; works: PublicWorldWork[] }
export interface WorldStudio { land: WorldLand; agent: WorldAgent | null; works: PublicWorldWork[] }
export interface WorldPublicationOptions {
  items: { task_id: string; title: string; summary: string | null; pr_url: string; role: 'lead' | 'collaborator' }[];
}
export interface WorldStreamSnapshot { type: 'snapshot'; world: WorldSnapshot }
export interface WorldChanges<T> { upsert: T[]; remove: string[] }
export interface WorldStreamDelta {
  type: 'delta'; server_time: string; bounds?: WorldBounds; self?: WorldSelf;
  lands?: WorldChanges<WorldLand>; agents?: WorldChanges<WorldAgent>; visitors?: WorldChanges<WorldVisitor>;
}
export type WorldStreamMessage = WorldStreamSnapshot | WorldStreamDelta
  | { type: 'ping'; server_time: string }
  | { type: 'ack'; seq: number; x: number; y: number; room_id?: string | null; persisted: boolean };
export type WorldStreamInput = { type: 'move'; seq: number; x: number; y: number; room_id?: string | null; moving: boolean }
  | { type: 'heartbeat' };
