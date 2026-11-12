import type { Actor, PublishWorldWorkInput, WorldAgentProfile, WorldLand,
  WorldPresenceInput, WorldPublicationOptions, WorldSelf, WorldSnapshot, WorldStudio } from '@agentzero/contracts';
import { landOverlapsPublicArea, WORLD_BOUNDS, WORLD_PLACES, WORLD_PUBLIC_AREAS, WORLD_ROOM_DIMENSIONS, worldLandDimensions } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError, audit, type CommandResult } from '../../core.js';

export const PRESENCE_TTL_SECONDS = 60;

const landQuery = `SELECT l.id,l.code,l.x,l.y,l.area,l.width,l.height,l.name,l.works_url,l.showcase,l.trading_frozen,l.showcase_hidden,l.owner_agent_id,a.name AS owner_name,
  CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('id',u.id,'github_login',u.github_login,'display_name',u.display_name) END AS owner,
  l.points_price::text,l.version::text,
  CASE WHEN ml.id IS NULL THEN NULL ELSE jsonb_build_object('id',ml.id,'points_price',ml.points_price::text,'version',ml.version::text) END AS listing,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'name',it.name,'appearance',it.appearance) ORDER BY i.id)
    FROM item_instances i JOIN item_templates it ON it.id=i.template_id WHERE i.land_id=l.id),'[]'::jsonb) AS decorations,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'model_id',m.model_id,'x',m.x,'y',m.y,'rotation',m.rotation,'scale',m.scale,'room_id',m.room_id,'version',m.version::text) ORDER BY m.id)
    FROM world_model_placements m WHERE m.land_id=l.id),'[]'::jsonb) AS models
  FROM land_plots l LEFT JOIN agents a ON a.id=l.owner_agent_id
  LEFT JOIN users u ON u.id=l.owner_user_id
  LEFT JOIN market_listings ml ON ml.land_id=l.id AND ml.status='active'`;

const agentQuery = `SELECT a.id,a.name,a.status,
  jsonb_build_object('id',u.id,'github_login',u.github_login,'display_name',u.display_name) AS owner,
  COALESCE(p.x,0) AS x,COALESCE(p.y,0) AS y,p.room_id,
  COALESCE(a.status='active' AND u.status='active' AND p.expires_at>clock_timestamp()
    AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp() AND k.agent_id=a.id,false) AS online
  FROM agents a JOIN users u ON u.id=a.owner_user_id
  LEFT JOIN world_positions p ON p.kind='agent' AND p.subject_id=a.id
  LEFT JOIN agent_keys k ON k.id=p.credential_id
  WHERE a.deleted_at IS NULL`;

const visitorQuery = `SELECT u.id,u.display_name AS name,u.github_login,p.x,p.y,p.room_id,true AS online
  FROM world_positions p JOIN users u ON u.id=p.user_id JOIN user_sessions s ON s.id=p.session_id
  WHERE p.kind='visitor' AND u.status='active' AND s.user_id=u.id
    AND p.expires_at>clock_timestamp() AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`;

export function worldSubject(actor: Actor) {
  if (actor.type === 'system') throw new AppError('ACCESS_DENIED', 403);
  return { kind: actor.type === 'user' ? 'visitor' as const : 'agent' as const,
    id: actor.type === 'user' ? actor.userId : actor.agentId,
    userId: actor.type === 'user' ? actor.userId : actor.ownerUserId };
}

function landBody(land: WorldLand): WorldLand {
  const tradeable = !land.trading_frozen && !landOverlapsPublicArea(land);
  return { ...land, tradeable, purchasable: tradeable && !land.owner,
    ...(land.showcase_hidden ? { name: '展示已屏蔽', works_url: null, showcase: [], decorations: [], models: [] } : {}) };
}

export function worldBounds(lands: WorldLand[], positions: { x: number; y: number; room_id?: string | null }[]) {
  const bounds = { ...WORLD_BOUNDS };
  const include = (x: number, y: number, padding: number, verticalPadding = padding) => {
    bounds.min_x = Math.max(-1000000, Math.min(bounds.min_x, x - padding));
    bounds.max_x = Math.min(1000000, Math.max(bounds.max_x, x + padding));
    bounds.min_y = Math.max(-1000000, Math.min(bounds.min_y, y - verticalPadding));
    bounds.max_y = Math.min(1000000, Math.max(bounds.max_y, y + verticalPadding));
  };
  for (const land of lands) {
    const size = worldLandDimensions(land);
    include(land.x, land.y, size.width / 2, size.height / 2);
  }
  for (const position of positions) if (!position.room_id) include(position.x, position.y, 4);
  return bounds;
}

export type WorldProjection = Omit<WorldSnapshot, 'self'>;
async function readWorld(tx: Tx, actor?: Actor) {
  const self = actor ? worldSubject(actor) : undefined;
  // One statement gives all clients a coherent committed view of ownership, placements and presence.
  const row = (await tx.query(`SELECT clock_timestamp() AS server_time,
    (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.x,l.y,l.id),'[]') FROM (${landQuery}) l) AS lands,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM (${agentQuery}) a) AS agents,
    (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id),'[]') FROM (${visitorQuery}) v) AS visitors,
    (SELECT jsonb_build_object('x',p.x,'y',p.y,'room_id',p.room_id) FROM world_positions p WHERE p.kind=$1 AND p.subject_id=$2) AS position`,
  [self?.kind ?? null, self?.id ?? null])).rows[0];
  const lands = (row.lands as WorldLand[]).map(landBody);
  const position = { x: row.position?.x ?? 0, y: row.position?.y ?? 0, room_id: row.position?.room_id ?? null };
  const projection: WorldProjection = { server_time: new Date(row.server_time).toISOString(), presence_ttl_seconds: PRESENCE_TTL_SECONDS,
    bounds: worldBounds(lands, [...row.agents, ...row.visitors, position]), public_areas: WORLD_PUBLIC_AREAS,
    places: WORLD_PLACES, lands, agents: row.agents, visitors: row.visitors };
  return { projection, position };
}

export async function worldProjection(tx: Tx): Promise<WorldProjection> {
  return (await readWorld(tx)).projection;
}

export async function worldSnapshot(tx: Tx, actor: Actor): Promise<WorldSnapshot> {
  const self = worldSubject(actor), { projection, position } = await readWorld(tx, actor);
  const online = self.kind === 'agent'
    ? projection.agents.some(a => a.id === self.id && a.online)
    : projection.visitors.some(v => v.id === self.id);
  return { ...projection, self: { kind: self.kind, id: self.id, ...position, online } };
}

export async function validateWorldPosition(tx: Tx, x: number, y: number, roomId: string | null) {
  if (!roomId) return;
  if (Math.abs(x) > WORLD_ROOM_DIMENSIONS.width / 2 || Math.abs(y) > WORLD_ROOM_DIMENSIONS.height / 2)
    throw new AppError('WORLD_ROOM_OUT_OF_BOUNDS', 400, '室内位置必须位于房间内');
  const room = await tx.query("SELECT m.id FROM world_model_placements m JOIN land_plots l ON l.id=m.land_id WHERE m.id=$1 AND m.room_id IS NULL AND m.model_id IN ('studio','cabin','shed') AND NOT l.showcase_hidden FOR SHARE OF l FOR KEY SHARE OF m", [roomId]);
  if (!room.rowCount) throw new AppError('WORLD_ROOM_INVALID', 400, '房屋不存在或已被移除');
}

export async function heartbeat(tx: Tx, actor: Actor, input: WorldPresenceInput): Promise<CommandResult> {
  const self = worldSubject(actor);
  const prior = (await tx.query('SELECT x,y,room_id FROM world_positions WHERE kind=$1 AND subject_id=$2', [self.kind, self.id])).rows[0];
  const position = 'x' in input ? input as { x: number; y: number; room_id?: string | null } : null;
  const x = position?.x ?? prior?.x ?? 0, y = position?.y ?? prior?.y ?? 0;
  const roomId = position?.room_id === undefined ? prior?.room_id ?? null : position.room_id;
  await validateWorldPosition(tx, x, y, roomId);
  const row = (await tx.query(`INSERT INTO world_positions(kind,subject_id,user_id,agent_id,session_id,credential_id,x,y,room_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '60 seconds')
    ON CONFLICT(kind,subject_id) DO UPDATE SET session_id=excluded.session_id,credential_id=excluded.credential_id,
      x=excluded.x,y=excluded.y,room_id=excluded.room_id,expires_at=excluded.expires_at,updated_at=clock_timestamp()
    RETURNING x,y,room_id,expires_at`,
  [self.kind, self.id, self.userId, actor.type === 'agent' ? actor.agentId : null,
    actor.type === 'user' ? actor.sessionId : null, actor.type === 'agent' ? actor.credentialId : null, x, y, roomId])).rows[0];
  const body: WorldSelf = { kind: self.kind, id: self.id, x: row.x, y: row.y, room_id: row.room_id, online: true };
  return { status: 200, body: { self: body, expires_at: new Date(row.expires_at).toISOString(), presence_ttl_seconds: PRESENCE_TTL_SECONDS },
    resourceType: 'world_position', resourceId: self.id };
}

export async function leaveWorld(tx: Tx, actor: Actor): Promise<CommandResult> {
  const self = worldSubject(actor);
  // An older session/key must not clear a newer connection's presence lease.
  await tx.query(`UPDATE world_positions SET expires_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE kind=$1 AND subject_id=$2 AND (session_id=$3 OR credential_id=$4)`,
  [self.kind, self.id, actor.type === 'user' ? actor.sessionId : null, actor.type === 'agent' ? actor.credentialId : null]);
  return { status: 200, body: { left: true }, resourceType: 'world_position', resourceId: self.id };
}

const eligibleParticipation = `(t.assignee_agent_id=$1 OR EXISTS(SELECT 1 FROM collaboration_agreements ca
  JOIN agreement_members am ON am.agreement_id=ca.id WHERE ca.task_id=t.id AND ca.status='active' AND am.agent_id=$1))`;
const publicWorkQuery = `SELECT p.task_id,p.summary,
  'https://github.com/'||r.owner||'/'||r.name||'/pull/'||d.pr_number::text AS pr_url,t.finalized_at AS settled_at,
  CASE WHEN t.assignee_agent_id=p.agent_id THEN 'lead' ELSE 'collaborator' END AS role,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'owner_user_id',a.owner_user_id) ORDER BY a.id)
    FROM world_publications other JOIN agents a ON a.id=other.agent_id
    WHERE other.task_id=p.task_id AND other.agent_id<>p.agent_id AND a.deleted_at IS NULL),'[]'::jsonb) AS collaborators
  FROM world_publications p JOIN tasks t ON t.id=p.task_id JOIN repositories r ON r.id=t.repository_id
  JOIN task_deliveries d ON d.id=t.latest_delivery_id
  WHERE t.status='settled' AND NOT r.is_private`;

export async function worldAgentProfile(tx: Tx, id: string): Promise<WorldAgentProfile> {
  const row = (await tx.query<WorldAgentProfile>(`SELECT to_jsonb(profile) AS agent,
    (SELECT COALESCE(jsonb_agg(to_jsonb(land) ORDER BY land.x,land.y,land.id),'[]')
      FROM (${landQuery} WHERE l.owner_agent_id=$1) land) AS lands,
    (SELECT COALESCE(jsonb_agg(to_jsonb(work) ORDER BY work.settled_at DESC,work.task_id),'[]')
      FROM (${publicWorkQuery} AND p.agent_id=$1) work) AS works
    FROM (${agentQuery} AND a.id=$1) profile`, [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, 'Agent 不存在');
  return { ...row, lands: row.lands.map(landBody) };
}

export async function worldStudio(tx: Tx, id: string): Promise<WorldStudio> {
  const row = (await tx.query<WorldStudio>(`SELECT to_jsonb(studio) AS land,
    (SELECT to_jsonb(profile) FROM (${agentQuery} AND a.id=studio.owner_agent_id) profile) AS agent,
    (SELECT COALESCE(jsonb_agg(to_jsonb(work) ORDER BY work.settled_at DESC,work.task_id),'[]')
      FROM (${publicWorkQuery} AND p.agent_id=studio.owner_agent_id) work) AS works
    FROM (${landQuery} WHERE l.id=$1) studio`, [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, '工作室不存在');
  return { ...row, land: landBody(row.land) };
}

export async function publicationOptions(tx: Tx, agentId: string): Promise<WorldPublicationOptions> {
  const rows = (await tx.query(`SELECT t.id AS task_id,t.title,p.summary,
    'https://github.com/'||r.owner||'/'||r.name||'/pull/'||d.pr_number::text AS pr_url,
    CASE WHEN t.assignee_agent_id=$1 THEN 'lead' ELSE 'collaborator' END AS role
    FROM tasks t JOIN repositories r ON r.id=t.repository_id JOIN task_deliveries d ON d.id=t.latest_delivery_id
    LEFT JOIN world_publications p ON p.task_id=t.id AND p.agent_id=$1
    WHERE t.status='settled' AND NOT r.is_private AND ${eligibleParticipation} ORDER BY t.finalized_at DESC,t.id`, [agentId])).rows;
  return { items: rows };
}

export async function publishWork(tx: Tx, actor: Actor, requestId: string, agentId: string, taskId: string, input: PublishWorldWorkInput): Promise<CommandResult> {
  if (actor.type !== 'user') throw new AppError('ACCESS_DENIED', 403, '公开成果需要所属用户授权');
  const eligible = (await tx.query(`SELECT t.id FROM tasks t JOIN repositories r ON r.id=t.repository_id
    JOIN task_deliveries d ON d.id=t.latest_delivery_id
    WHERE t.id=$2 AND t.status='settled' AND NOT r.is_private AND ${eligibleParticipation}`, [agentId, taskId])).rows[0];
  if (!eligible) throw new AppError('ACCESS_DENIED', 403, '只能公开本人 Agent 已结算的公开仓库成果');
  await tx.query(`INSERT INTO world_publications(agent_id,task_id,summary,published_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(agent_id,task_id) DO UPDATE SET summary=excluded.summary,published_by=excluded.published_by,published_at=clock_timestamp()`,
  [agentId, taskId, input.summary.trim(), actor.userId]);
  await audit(tx, actor, 'world.work_published', 'task', taskId, requestId, { agent_id: agentId, summary: input.summary.trim() });
  return { status: 200, body: { published: true, task_id: taskId }, resourceType: 'task', resourceId: taskId };
}

export async function unpublishWork(tx: Tx, actor: Actor, requestId: string, agentId: string, taskId: string): Promise<CommandResult> {
  await tx.query('DELETE FROM world_publications WHERE agent_id=$1 AND task_id=$2', [agentId, taskId]);
  await audit(tx, actor, 'world.work_unpublished', 'task', taskId, requestId, { agent_id: agentId });
  return { status: 200, body: { published: false, task_id: taskId }, resourceType: 'task', resourceId: taskId };
}
