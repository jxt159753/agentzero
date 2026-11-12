import { Type, type Static } from '@sinclair/typebox';
import { Uuid } from './primitives.js';
import { worldLandDimensions, type WorldLandGeometry } from './world.js';

/** Shared fitting boxes, in world units, used by both the renderer and placement validation. */
export const WORLD_MODEL_CATALOG = {
  studio: { label: '门廊小屋', category: 'building', solid: true, width: 1.55, depth: 1.55, maxHeight: 1.86 },
  tree: { label: '庭院树', category: 'nature', solid: false, width: 0.9, depth: 0.9, maxHeight: 1.8 },
  lamp: { label: '路灯', category: 'outdoor', solid: false, width: 0.24, depth: 0.08, maxHeight: 0.4 },
  bench: { label: '公园长椅', category: 'furniture', solid: false, width: 0.18, depth: 0.08, maxHeight: 0.1 },
  fountain: { label: '广场喷泉', category: 'outdoor', solid: false, width: 1.1, depth: 1.1, maxHeight: 0.95 },
  plant: { label: '灌木盆栽', category: 'nature', solid: false, width: 0.35, depth: 0.35, maxHeight: 0.55 },
  bookshelf: { label: '书架', category: 'furniture', solid: false, width: 0.5, depth: 0.25, maxHeight: 0.8 },
  cabin: { label: '原木小屋', category: 'building', solid: true, width: 1.4, depth: 1.65, maxHeight: 1.3 },
  shed: { label: '庭院工具房', category: 'building', solid: true, width: 0.8, depth: 0.8, maxHeight: 0.85 },
  tent: { label: '户外帐篷', category: 'outdoor', solid: false, width: 0.8, depth: 0.8, maxHeight: 0.8 },
  fence: { label: '木质围栏', category: 'outdoor', solid: false, width: 0.75, depth: 0.08, maxHeight: 0.45 },
  rock: { label: '庭院景石', category: 'nature', solid: false, width: 0.35, depth: 0.32, maxHeight: 0.21 },
  flowerbox: { label: '缤纷花箱', category: 'nature', solid: false, width: 0.45, depth: 0.18, maxHeight: 0.22 },
  pine: { label: '小松树', category: 'nature', solid: false, width: 0.65, depth: 0.65, maxHeight: 1.1 },
  picnic: { label: '野餐桌', category: 'furniture', solid: false, width: 0.65, depth: 0.55, maxHeight: 0.28 },
  chair: { label: '露营椅', category: 'furniture', solid: false, width: 0.07, depth: 0.07, maxHeight: 0.1 },
  barrel: { label: '木桶', category: 'furniture', solid: false, width: 0.22, depth: 0.22, maxHeight: 0.32 },
  crate: { label: '木箱', category: 'furniture', solid: false, width: 0.22, depth: 0.22, maxHeight: 0.22 },
  signpost: { label: '木制路牌', category: 'outdoor', solid: false, width: 0.3, depth: 0.25, maxHeight: 0.6 },
  well: { label: '石井', category: 'outdoor', solid: false, width: 0.45, depth: 0.45, maxHeight: 0.6 },
  arcade: { label: '游戏机', category: 'furniture', solid: false, width: 0.14, depth: 0.14, maxHeight: 0.25 },
} as const;
export type WorldModelId = keyof typeof WORLD_MODEL_CATALOG;
export type WorldModelCategory = typeof WORLD_MODEL_CATALOG[WorldModelId]['category'];
export const WORLD_MODEL_LIMIT = 32;
export const WORLD_MODEL_MIN_SCALE = 0.25;
export const WORLD_MODEL_MAX_SCALE = 2;
export const WORLD_ROOM_DIMENSIONS = { width: 4.8, height: 3.6 } as const;
export const isWorldRoom = (modelId: WorldModelId): boolean => WORLD_MODEL_CATALOG[modelId]?.category === 'building';

const ModelId = Type.Union((Object.keys(WORLD_MODEL_CATALOG) as WorldModelId[]).map(id => Type.Literal(id)));
const Version = Type.String({ pattern: '^[1-9][0-9]{0,18}$', maxLength: 19 });
const transform = {
  x: Type.Number({ minimum: -1000000, maximum: 1000000 }),
  y: Type.Number({ minimum: -1000000, maximum: 1000000 }),
  rotation: Type.Number({ minimum: 0, maximum: 359 }),
  scale: Type.Number({ minimum: WORLD_MODEL_MIN_SCALE, maximum: WORLD_MODEL_MAX_SCALE }),
};
export const AddWorldModel = Type.Object({ land_version: Version, model_id: ModelId, room_id: Type.Optional(Type.Union([Uuid, Type.Null()])), ...transform }, { additionalProperties: false });
export const PatchWorldModel = Type.Object({ version: Version, ...transform }, { additionalProperties: false });
export const DeleteWorldModel = Type.Object({ version: Version }, { additionalProperties: false });
export const WorldModelParams = Type.Object({ id: Uuid, placementId: Uuid });
export type AddWorldModelInput = Static<typeof AddWorldModel>;
export type PatchWorldModelInput = Static<typeof PatchWorldModel>;
export type DeleteWorldModelInput = Static<typeof DeleteWorldModel>;
export interface WorldModelDraft { model_id: WorldModelId; x: number; y: number; rotation: number; scale: number; room_id?: string | null }
export interface WorldModelPlacement extends WorldModelDraft { id: string; version: string }
export interface WorldModelResult { placement: WorldModelPlacement; land_version: string }

/** The rotated bounding box must fit wholly inside the land; decorative models may overlap. */
export function worldModelFits(land: Pick<WorldLandGeometry, 'area' | 'width' | 'height'>, model: WorldModelDraft): boolean {
  const size = WORLD_MODEL_CATALOG[model.model_id], plot = worldLandDimensions(land);
  if (!size || ![model.x, model.y, model.rotation, model.scale].every(Number.isFinite)
    || model.rotation < 0 || model.rotation > 359 || model.scale < WORLD_MODEL_MIN_SCALE || model.scale > WORLD_MODEL_MAX_SCALE) return false;
  const angle = model.rotation * Math.PI / 180, cosine = Math.abs(Math.cos(angle)), sine = Math.abs(Math.sin(angle));
  const halfWidth = (size.width * cosine + size.depth * sine) * model.scale / 2;
  const halfHeight = (size.width * sine + size.depth * cosine) * model.scale / 2;
  return Math.abs(model.x) + halfWidth <= plot.width / 2 + 1e-9
    && Math.abs(model.y) + halfHeight <= plot.height / 2 + 1e-9;
}

export function worldRoomFits(model: WorldModelDraft): boolean {
  return !isWorldRoom(model.model_id) && worldModelFits({ area: 1728, ...WORLD_ROOM_DIMENSIONS }, model);
}
