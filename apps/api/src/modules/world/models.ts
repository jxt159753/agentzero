import { randomUUID } from 'node:crypto';
import type { Actor, AddWorldModelInput, DeleteWorldModelInput, PatchWorldModelInput, WorldLandGeometry, WorldModelPlacement } from '@agentzero/contracts';
import { WORLD_MODEL_LIMIT, isWorldRoom, worldModelFits, worldRoomFits } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError, audit, type CommandResult } from '../../core.js';

interface EditableLand extends WorldLandGeometry { id: string; owner_user_id: string | null; owner_agent_id: string | null; version: string }
const placementFields = 'id,model_id,x,y,rotation,scale,room_id,version::text';

async function editableLand(tx: Tx, actor: Actor, id: string) {
  const land = (await tx.query<EditableLand>('SELECT id,x,y,area,width,height,owner_user_id,owner_agent_id,version::text FROM land_plots WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!land) throw new AppError('NOT_FOUND', 404, '地块不存在');
  if (actor.type === 'system' || land.owner_user_id !== (actor.type === 'user' ? actor.userId : actor.ownerUserId)
    || actor.type === 'agent' && land.owner_agent_id !== actor.agentId) throw new AppError('ACCESS_DENIED', 403, '只能布置自己拥有或当前 Agent 管理的地块');
  if ((await tx.query("SELECT id FROM market_listings WHERE land_id=$1 AND status='active'", [id])).rowCount)
    throw new AppError('ASSET_LISTED', 409, '地块挂牌期间不能修改模型布置');
  return land;
}

function version(actual: string, expected: string) {
  if (actual !== expected) throw new AppError('WORLD_MODEL_VERSION_CONFLICT', 409, '地块或模型已更新，请刷新后重试');
}

async function bumpLand(tx: Tx, id: string) {
  return (await tx.query<{ version: string }>('UPDATE land_plots SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING version::text', [id])).rows[0]!.version;
}

async function placement(tx: Tx, landId: string, id: string) {
  const model = (await tx.query<WorldModelPlacement>(`SELECT ${placementFields} FROM world_model_placements WHERE id=$1 AND land_id=$2`, [id, landId])).rows[0];
  if (!model) throw new AppError('NOT_FOUND', 404, '地块上的模型不存在');
  return model;
}

async function validatePlacement(tx: Tx, land: EditableLand, model: WorldModelPlacement | AddWorldModelInput) {
  if (model.room_id) {
    const room = await placement(tx, land.id, model.room_id);
    if (room.room_id || !isWorldRoom(room.model_id)) throw new AppError('WORLD_ROOM_INVALID', 400, '室内物品必须属于地块上的房屋');
    if (!worldRoomFits(model)) throw new AppError('WORLD_MODEL_OUT_OF_BOUNDS', 400, '室内只能摆放非建筑物体，且完整占地必须位于房间内');
  } else if (!worldModelFits(land, model)) throw new AppError('WORLD_MODEL_OUT_OF_BOUNDS', 400, '模型旋转和缩放后的完整占地必须位于地块内');
}

export async function addWorldModel(tx: Tx, actor: Actor, requestId: string, landId: string, input: AddWorldModelInput): Promise<CommandResult> {
  const land = await editableLand(tx, actor, landId);
  version(land.version, input.land_version);
  await validatePlacement(tx, land, input);
  const count = (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM world_model_placements WHERE land_id=$1', [landId])).rows[0]!.count;
  if (count >= WORLD_MODEL_LIMIT) throw new AppError('WORLD_MODEL_LIMIT', 409, `每块地最多摆放 ${WORLD_MODEL_LIMIT} 个免费模型`);
  const id = randomUUID();
  const model = (await tx.query<WorldModelPlacement>(`INSERT INTO world_model_placements(id,land_id,model_id,x,y,rotation,scale,room_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${placementFields}`, [id, landId, input.model_id, input.x, input.y, input.rotation, input.scale, input.room_id ?? null])).rows[0]!;
  const landVersion = await bumpLand(tx, landId);
  await audit(tx, actor, 'world.model_added', 'land', landId, requestId, { placement: model });
  return { status: 201, body: { placement: model, land_version: landVersion }, resourceType: 'world_model_placement', resourceId: id };
}

export async function patchWorldModel(tx: Tx, actor: Actor, requestId: string, landId: string, id: string, input: PatchWorldModelInput): Promise<CommandResult> {
  const land = await editableLand(tx, actor, landId), current = await placement(tx, landId, id);
  version(current.version, input.version);
  const next = { ...current, ...input };
  await validatePlacement(tx, land, next);
  const model = (await tx.query<WorldModelPlacement>(`UPDATE world_model_placements SET x=$2,y=$3,rotation=$4,scale=$5,version=version+1
    WHERE id=$1 RETURNING ${placementFields}`, [id, input.x, input.y, input.rotation, input.scale])).rows[0]!;
  const landVersion = await bumpLand(tx, landId);
  await audit(tx, actor, 'world.model_moved', 'land', landId, requestId, { placement: model });
  return { status: 200, body: { placement: model, land_version: landVersion }, resourceType: 'world_model_placement', resourceId: id };
}

export async function deleteWorldModel(tx: Tx, actor: Actor, requestId: string, landId: string, id: string, input: DeleteWorldModelInput): Promise<CommandResult> {
  await editableLand(tx, actor, landId);
  const model = await placement(tx, landId, id);
  version(model.version, input.version);
  if ((await tx.query('SELECT id FROM world_model_placements WHERE room_id=$1 LIMIT 1', [id])).rowCount)
    throw new AppError('WORLD_ROOM_NOT_EMPTY', 409, '请先移除房屋内的物品，再移除房屋');
  await tx.query('DELETE FROM world_model_placements WHERE id=$1', [id]);
  const landVersion = await bumpLand(tx, landId);
  await audit(tx, actor, 'world.model_removed', 'land', landId, requestId, { placement_id: id, model_id: model.model_id });
  return { status: 200, body: { deleted: true, id, land_version: landVersion }, resourceType: 'world_model_placement', resourceId: id };
}
