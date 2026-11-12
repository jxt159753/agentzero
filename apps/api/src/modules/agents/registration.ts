import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { IdParams } from '@agentzero/contracts';
import { withTransaction, type Tx } from '@agentzero/database';
import { AppError, audit, lockActor, safeEqual, tokenHash } from '../../core.js';
import { command, requireUser, type ApiContext } from '../../http.js';
import { createAgent } from './service.js';

const nameSchema = Type.String({ minLength: 1, maxLength: 80, pattern: '\\S' });
const codeSchema = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' });
const hashSchema = Type.String({ pattern: '^[0-9a-f]{64}$' });
const startSchema = Type.Object({
  id: Type.String({ format: 'uuid' }), client: Type.Union([Type.Literal('codex'), Type.Literal('dsh')]),
  name: nameSchema, credential_hash: hashSchema, verification_hash: hashSchema,
}, { additionalProperties: false });
const approveSchema = Type.Object({
  verification_code: codeSchema, name: Type.Optional(nameSchema), agent_id: Type.Optional(Type.String({ format: 'uuid' })),
}, { additionalProperties: false });
type RegistrationInput = { id: string; client: 'codex' | 'dsh'; name: string; credential_hash: string; verification_hash: string };
type Registration = { id: string; client: 'codex' | 'dsh'; name: string; credential_hash: Buffer; verification_hash: Buffer; expires_at: Date; owner_user_id: string | null; agent_id: string | null; approved_at: Date | null };
type ApprovalInput = { verification_code: string; name?: string; agent_id?: string };

function view(row: Registration) {
  return { id: row.id, client: row.client, name: row.name, expires_at: row.expires_at.toISOString(), status: row.approved_at ? 'approved' : 'pending',
    ...(row.approved_at ? { agent_id: row.agent_id, key_id: row.id } : {}) };
}
function checkExpiry(row: Registration) {
  if (!row.approved_at && row.expires_at.getTime() <= Date.now()) throw new AppError('REGISTRATION_EXPIRED', 410, '注册请求已过期，请在客户端重新发起注册');
}
async function read(tx: Tx, id: string, lock = false): Promise<Registration> {
  const row = (await tx.query<Registration>(`SELECT * FROM agent_registrations WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!row) throw new AppError('REGISTRATION_NOT_FOUND', 404, '注册请求不存在或已过期');
  return row;
}
function verifyBrowser(row: Registration, code: string) {
  if (!safeEqual(row.verification_hash, tokenHash(code))) throw new AppError('ACCESS_DENIED', 403, '注册验证链接无效');
  checkExpiry(row);
}

export async function registerPublicAgentRegistration(app: FastifyInstance, ctx: ApiContext) {
  // A small global creation limit bounds anonymous writes without trusting proxy headers.
  let windowStart = 0, starts = 0;
  app.post<{ Body: RegistrationInput }>('/api/v1/agent-registrations', { schema: { body: startSchema } }, async (request, reply) => {
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; starts = 0; }
    if (++starts > 60) {
      reply.header('retry-after', Math.ceil((windowStart + 60_000 - now) / 1000));
      throw new AppError('RATE_LIMITED', 429, '注册请求过于频繁，请稍后重试');
    }
    const input = request.body;
    const row = await withTransaction(ctx.pool, async tx => {
      // Keep expired IDs reserved so neither the old link nor a replacement credential can revive them.
      await tx.query(`INSERT INTO agent_registrations(id,client,name,credential_hash,verification_hash) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(id) DO NOTHING`, [input.id, input.client, input.name.trim(), Buffer.from(input.credential_hash, 'hex'), Buffer.from(input.verification_hash, 'hex')]);
      const registration = await read(tx, input.id);
      if (registration.client !== input.client || registration.name !== input.name.trim()
        || !safeEqual(registration.credential_hash, Buffer.from(input.credential_hash, 'hex'))
        || !safeEqual(registration.verification_hash, Buffer.from(input.verification_hash, 'hex'))) {
        throw new AppError('REGISTRATION_CONFLICT', 409, '此注册编号已用于其他请求');
      }
      checkExpiry(registration);
      return registration;
    });
    return reply.code(201).send(view(row));
  });
  app.get<{ Params: { id: string } }>('/api/v1/agent-registrations/:id/status', { schema: { params: IdParams } }, async request => {
    const match = /^Bearer (azk_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
    if (!match || match[2] !== request.params.id.toLowerCase()) throw new AppError('UNAUTHENTICATED', 401);
    return withTransaction(ctx.pool, async tx => {
      const row = await read(tx, request.params.id);
      if (!safeEqual(row.credential_hash, tokenHash(match[1]!))) throw new AppError('UNAUTHENTICATED', 401);
      checkExpiry(row);
      if (row.approved_at) {
        await lockActor(tx, { type: 'agent', ownerUserId: row.owner_user_id!, agentId: row.agent_id!, credentialId: row.id });
      }
      return view(row);
    });
  });
}

export async function registerAgentRegistrationApproval(app: FastifyInstance, ctx: ApiContext) {
  app.get<{ Params: { id: string }; Querystring: { code: string } }>('/api/v1/agent-registrations/:id', {
    schema: { params: IdParams, querystring: Type.Object({ code: codeSchema }, { additionalProperties: false }) },
  }, async request => {
    const actor = requireUser(request);
    return withTransaction(ctx.pool, async tx => {
      await lockActor(tx, actor);
      const row = await read(tx, request.params.id);
      verifyBrowser(row, request.query.code);
      if (row.owner_user_id && row.owner_user_id !== actor.userId) throw new AppError('ACCESS_DENIED', 403);
      return view(row);
    });
  });
  app.post<{ Params: { id: string }; Body: ApprovalInput }>('/api/v1/agent-registrations/:id/approve', {
    schema: { params: IdParams, body: approveSchema },
  }, async (request, reply) => {
    const actor = requireUser(request), input = request.body;
    if (input.agent_id && input.name) throw new AppError('INVALID_REQUEST', 400, '请选择已有 Agent 或填写新 Agent 名称');
    return command(ctx, request, reply, { agentId: input.agent_id }, async tx => {
      const row = await read(tx, request.params.id, true);
      verifyBrowser(row, input.verification_code);
      if (row.owner_user_id && row.owner_user_id !== actor.userId) throw new AppError('ACCESS_DENIED', 403);
      if (!row.approved_at) {
        const agentId = input.agent_id ?? (await createAgent(tx, actor, input.name ?? row.name, request.id, ctx.config.maxAgentsPerUser)).id as string;
        await tx.query('INSERT INTO agent_keys(id,agent_id,label,secret_hash) VALUES($1,$2,$3,$4)', [row.id, agentId, row.client === 'codex' ? 'Codex' : 'DSH', row.credential_hash]);
        const approved = (await tx.query<Registration>('UPDATE agent_registrations SET owner_user_id=$2,agent_id=$3,approved_at=clock_timestamp() WHERE id=$1 RETURNING *', [row.id, actor.userId, agentId])).rows[0]!;
        await audit(tx, { ...actor, representedAgentId: agentId }, 'key.created', 'key', row.id, request.id, { label: row.client === 'codex' ? 'Codex' : 'DSH' });
        await audit(tx, { ...actor, representedAgentId: agentId }, 'agent.registration_approved', 'agent', agentId, request.id, { client: row.client, key_id: row.id });
        return { status: 200, body: view(approved), resourceType: 'agent', resourceId: agentId };
      }
      return { status: 200, body: view(row), resourceType: 'agent', resourceId: row.agent_id! };
    });
  });
}
