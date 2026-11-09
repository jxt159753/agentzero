import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type Tx } from '@agentzero/database';
import type { Actor } from '@agentzero/contracts';

export class AppError extends Error {
  constructor(public code: string, public status = 400, message?: string) { super(message ?? code); }
}
export function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = (value: unknown): Buffer => createHash('sha256').update(canonical(value)).digest();
export const tokenHash = (value: string): Buffer => createHash('sha256').update(value).digest();
export function safeEqual(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a,b); }
export function principal(actor: Actor): string { return actor.type === 'user' ? `user:${actor.userId}` : actor.type === 'agent' ? `agent:${actor.agentId}` : 'system'; }

export interface LockOptions { agentId?: string; allowInactive?: boolean; allowPaused?: boolean; allowDeleted?: boolean; admin?: boolean; userIds?: string[] }
export async function lockActor(tx: Tx, actor: Actor, options: LockOptions = {}) {
  if (actor.type === 'system') return { user: null, agent: null };
  const userId = actor.type === 'user' ? actor.userId : actor.ownerUserId;
  const ids = [...new Set([userId, ...(options.userIds ?? [])])].sort();
  // Identity keys stay unchanged: serialize status changes while allowing foreign-key checks.
  const users = (await tx.query('SELECT * FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE', [ids])).rows;
  const user = users.find(u => u.id === userId);
  if (!user) throw new AppError('UNAUTHENTICATED',401);
  const agentId = options.agentId ?? (actor.type === 'agent' ? actor.agentId : actor.representedAgentId);
  let agent = null;
  if (agentId) {
    agent = (await tx.query('SELECT * FROM agents WHERE id=$1 AND owner_user_id=$2 FOR NO KEY UPDATE', [agentId,userId])).rows[0];
    if (!agent || (actor.type === 'agent' && actor.agentId !== agentId)) throw new AppError('ACCESS_DENIED',403);
  }
  if (actor.type === 'user') {
    const session = (await tx.query('SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',[actor.sessionId,userId])).rows[0];
    if (!session) throw new AppError('UNAUTHENTICATED',401);
  } else {
    const key = (await tx.query('SELECT id FROM agent_keys WHERE id=$1 AND agent_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',[actor.credentialId,actor.agentId])).rows[0];
    if (!key) throw new AppError('CREDENTIAL_REVOKED',401);
  }
  if (!options.allowInactive && user.status !== 'active') throw new AppError(user.status === 'pending' ? 'ACCOUNT_PENDING' : 'ACCOUNT_SUSPENDED',403);
  if (agent?.deleted_at && (!options.allowDeleted || actor.type !== 'user')) throw new AppError('AGENT_DELETED',410,'Agent 已删除，不能再执行此操作');
  if (agent?.status === 'paused' && (!options.allowPaused || actor.type === 'agent')) throw new AppError('AGENT_PAUSED',403);
  if (options.admin && (actor.type !== 'user' || user.role !== 'admin')) throw new AppError('ACCESS_DENIED',403);
  return { user, agent };
}

export async function audit(tx: Tx, actor: Actor, action: string, targetType: string, targetId: string, requestId: string, details: Record<string, unknown> = {}, businessKey?: string) {
  await tx.query(`INSERT INTO audit_events(id,actor_type,actor_user_id,actor_agent_id,represented_agent_id,credential_id,action,target_type,target_id,request_id,business_key,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[randomUUID(),actor.type,actor.type==='user'?actor.userId:null,actor.type==='agent'?actor.agentId:null,actor.type==='user'?actor.representedAgentId??null:actor.type==='agent'?actor.agentId:null,actor.type==='agent'?actor.credentialId:null,action,targetType,targetId,requestId,businessKey??null,JSON.stringify(details)]);
}

export interface CommandResult { status: number; body: Record<string, unknown>; resourceType?: string; resourceId?: string }
export interface CommandOptions extends LockOptions { route: string; key: string; payload: unknown; requestId: string }
export async function runCommand(pool: Pool, actor: Actor, options: CommandOptions, fn: (tx: Tx, operationId: string) => Promise<CommandResult>): Promise<CommandResult> {
  if (!/^[\w.:-]{8,128}$/.test(options.key)) throw new AppError('INVALID_REQUEST',400,'请提供 8–128 位 Idempotency-Key');
  return withTransaction(pool, async tx => {
    await lockActor(tx,actor,options);
    const requestHash = hash(options.payload);
    const operationId = randomUUID();
    const inserted = await tx.query(`INSERT INTO idempotency_requests(id,principal_key,route_key,idempotency_key,request_hash,status) VALUES($1,$2,$3,$4,$5,'processing') ON CONFLICT(principal_key,route_key,idempotency_key) DO NOTHING RETURNING id`,[operationId,principal(actor),options.route,options.key,requestHash]);
    if (!inserted.rowCount) {
      const prior = (await tx.query('SELECT * FROM idempotency_requests WHERE principal_key=$1 AND route_key=$2 AND idempotency_key=$3',[principal(actor),options.route,options.key])).rows[0];
      if (!safeEqual(prior.request_hash,requestHash)) throw new AppError('IDEMPOTENCY_CONFLICT',409);
      if (prior.status !== 'completed') throw new AppError('LEDGER_INCONSISTENT',409);
      return {status:prior.response_status,body:prior.response_body,resourceType:prior.resource_type,resourceId:prior.resource_id};
    }
    const result = await fn(tx,operationId);
    result.body = {...result.body,operation_id:operationId};
    // One-time key material goes only into this response, never the durable receipt.
    const storedBody = {...result.body};
    delete storedBody.secret;
    await tx.query(`UPDATE idempotency_requests SET status='completed',response_status=$2,response_body=$3,resource_type=$4,resource_id=$5 WHERE id=$1`,[operationId,result.status,JSON.stringify(storedBody),result.resourceType??null,result.resourceId??null]);
    return result;
  });
}

export function encodeCursor(row: {created_at: Date|string; id: string}): string { return Buffer.from(JSON.stringify([new Date(row.created_at).toISOString(),row.id])).toString('base64url'); }
export function decodeCursor(cursor?: string): [string,string]|null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor,'base64url').toString());
    if (!Array.isArray(value) || value.length!==2 || !/^\d{4}-\d{2}-\d{2}T/.test(value[0]) || !/^[0-9a-f-]{36}$/i.test(value[1]) || !Number.isFinite(Date.parse(value[0]))) throw new Error();
    return value as [string,string];
  } catch { throw new AppError('INVALID_REQUEST',400,'无效分页游标'); }
}
export function paginated(rows: any[], limit: number) {
  const items = rows.slice(0,limit);
  return {items,next_cursor:rows.length>limit?encodeCursor(items[items.length-1]):null};
}
