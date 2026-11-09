import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { withTransaction, type Tx } from '@agentzero/database';
import {
  CreateRepositoryRequest, IdParams, PageQuery, RepositoryRequestStatus, ReviewRepositoryRequest,
  type CreateRepositoryRequestInput, type RepositoryRequestDto, type RepositoryRequestStatusValue, type ReviewRepositoryRequestInput,
} from '@agentzero/contracts';
import { AppError, audit, decodeCursor, lockActor, paginated } from '../../core.js';
import { command, replayCommand, requireUser, type ApiContext } from '../../http.js';
import type { GitHubRepository, GitHubRepositoryProvider } from './provider.js';
import { admitRepository, installationRevision } from './service.js';

const requestSelect = 'SELECT r.*,u.github_login AS applicant_login FROM repository_requests r JOIN users u ON u.id=r.user_id';
function parseRepositoryUrl(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new AppError('INVALID_REPOSITORY_URL', 400, '请填写完整的 GitHub 仓库链接'); }
  const match = /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !match) {
    throw new AppError('INVALID_REPOSITORY_URL', 400, '仅支持 https://github.com/所有者/仓库 格式的链接');
  }
  const owner = match[1]!, name = match[2]!.replace(/\.git$/, '');
  if (!name || name === '.' || name === '..') throw new AppError('INVALID_REPOSITORY_URL', 400);
  return { owner, name, repositoryUrl: `https://github.com/${owner}/${name}` };
}
async function loadRequest(tx: Tx, id: string, lock = false): Promise<RepositoryRequestDto> {
  const row = (await tx.query<RepositoryRequestDto>(`${requestSelect} WHERE r.id=$1${lock ? ' FOR UPDATE OF r' : ''}`, [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404);
  return row;
}
function requirePending(row: RepositoryRequestDto, version: string) {
  if (row.version !== version || row.status !== 'pending') throw new AppError('REPOSITORY_REQUEST_VERSION_CONFLICT', 409, '该仓库申请已处理或发生变化，请刷新后重试');
}

export async function registerRepositoryRequests(app: FastifyInstance, ctx: ApiContext, provider: GitHubRepositoryProvider) {
  type Query = { cursor?: string; limit?: string; status?: RepositoryRequestStatusValue };
  async function list(tx: Tx, query: Query, userId?: string) {
    const cursor = decodeCursor(query.cursor), limit = Number(query.limit ?? 30);
    const rows = (await tx.query<RepositoryRequestDto>(`${requestSelect} WHERE ($1::uuid IS NULL OR r.user_id=$1)
      AND ($2::text IS NULL OR r.status=$2) AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3,$4::uuid))
      ORDER BY r.created_at DESC,r.id DESC LIMIT $5`, [userId ?? null, query.status ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1])).rows;
    return paginated(rows, limit);
  }
  app.get<{ Querystring: Query }>('/api/v1/repository-requests', { schema: { querystring: PageQuery } }, async request => {
    const actor = requireUser(request);
    return withTransaction(ctx.pool, async tx => { await lockActor(tx, actor); return list(tx, request.query, actor.userId); });
  });
  app.post<{ Body: CreateRepositoryRequestInput }>('/api/v1/repository-requests', { schema: { body: CreateRepositoryRequest } }, async (request, reply) => {
    const actor = requireUser(request), body = request.body;
    const repository = parseRepositoryUrl(body.repository_url);
    return command(ctx, request, reply, {}, async tx => {
      const row = (await tx.query(`INSERT INTO repository_requests(user_id,owner,name,repository_url,reason) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING RETURNING id`, [actor.userId, repository.owner, repository.name, repository.repositoryUrl, body.reason.trim()])).rows[0];
      if (!row) throw new AppError('REPOSITORY_REQUEST_EXISTS', 409, '该仓库已有待审核申请，请等待管理员处理');
      await audit(tx, actor, 'github.repository_requested', 'repository_request', row.id, request.id, { repository_url: repository.repositoryUrl });
      return { status: 201, body: { ...await loadRequest(tx, row.id) }, resourceType: 'repository_request', resourceId: row.id };
    });
  });
  app.get<{ Querystring: Query }>('/api/v1/admin/repository-requests', { schema: { querystring: Type.Intersect([PageQuery, Type.Object({ status: Type.Optional(RepositoryRequestStatus) })]) } }, async request => {
    return withTransaction(ctx.pool, async tx => { await lockActor(tx, request.actor, { admin: true }); return list(tx, request.query); });
  });
  app.post<{ Params: { id: string }; Body: ReviewRepositoryRequestInput }>('/api/v1/admin/repository-requests/:id/review', { schema: { params: IdParams, body: ReviewRepositoryRequest } }, async (request, reply) => {
    const actor = requireUser(request), body = request.body;
    if (await replayCommand(ctx, request, reply, { admin: true })) return reply;
    if (body.decision === 'approve' && !body.installation_id) throw new AppError('INVALID_REQUEST', 400, '批准申请时请选择已核验的 GitHub App 安装');
    const before = await withTransaction(ctx.pool, async tx => {
      await lockActor(tx, actor, { admin: true });
      const row = await loadRequest(tx, request.params.id);
      requirePending(row, body.version);
      return { row, revision: body.decision === 'approve' ? await installationRevision(tx, body.installation_id!) : null };
    });
    let repository: GitHubRepository | undefined;
    if (body.decision === 'approve') repository = await provider.getRepository({ installationId: body.installation_id!, owner: before.row.owner, name: before.row.name });
    return command(ctx, request, reply, { admin: true, userIds: [before.row.user_id] }, async tx => {
      const current = await loadRequest(tx, request.params.id, true);
      requirePending(current, body.version);
      const admitted = repository ? await admitRepository(tx, { actor, requestId: request.id, installationId: body.installation_id!, installationRevision: before.revision!, repository }) : null;
      await tx.query(`UPDATE repository_requests SET status=$2,version=version+1,repository_id=$3,reviewer_user_id=$4,review_reason=$5,
        reviewed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
      [current.id, admitted ? 'approved' : 'rejected', admitted?.id ?? null, actor.userId, body.reason.trim()]);
      await audit(tx, actor, 'github.repository_request_reviewed', 'repository_request', current.id, request.id,
        { decision: body.decision, reason: body.reason.trim(), repository_id: admitted?.id ?? null });
      return { status: 200, body: { ...await loadRequest(tx, current.id) }, resourceType: 'repository_request', resourceId: current.id };
    });
  });
}
