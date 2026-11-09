import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { PageQuery, UserWalletResponse, WalletTransfer, type WalletTransferInput } from '@agentzero/contracts';
import { withTransaction } from '@agentzero/database';
import { AppError, decodeCursor, lockActor, paginated } from '../../core.js';
import { command, requireUser, type ApiContext } from '../../http.js';
import { transfer } from '../ledger/service.js';

export async function registerWallets(app: FastifyInstance, ctx: ApiContext) {
  app.get('/api/v1/wallet', { schema: { response: { 200: UserWalletResponse } } }, async request => {
    const actor = requireUser(request);
    return withTransaction(ctx.pool, async tx => {
      await lockActor(tx, actor);
      const wallet = (await tx.query(`SELECT user_id,balance::text AS available,
        COALESCE((SELECT balance FROM ledger_accounts WHERE user_id=a.user_id AND bucket='USER_RESERVED'),0)::text AS reserved,
        COALESCE((SELECT e.amount FROM journal_transactions j JOIN journal_entries e ON e.transaction_id=j.id
          WHERE j.business_key='initial-funds:user:'||a.user_id::text AND e.account_id=a.id),0)::text AS initial_grant
        FROM ledger_accounts a WHERE user_id=$1 AND bucket='USER_AVAILABLE'`, [actor.userId])).rows[0];
      if (!wallet) throw new AppError('LEDGER_INCONSISTENT', 409, '钱包账户尚未建立');
      return wallet;
    });
  });
  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/api/v1/wallet/transactions', { schema: { querystring: PageQuery } }, async request => {
    const actor = requireUser(request);
    return withTransaction(ctx.pool, async tx => {
      await lockActor(tx, actor);
      const cursor = decodeCursor(request.query.cursor), limit = Number(request.query.limit ?? 30);
      return paginated((await tx.query(`SELECT j.id,j.kind,j.business_key,j.reason,j.created_at,j.business_date,
        abs(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END))::text AS amount,
        CASE WHEN sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)>0 THEN 'debit' WHEN sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)<0 THEN 'credit' ELSE 'mixed' END AS side,
        jsonb_agg(jsonb_build_object('bucket',a.bucket,'side',e.side,'amount',e.amount::text) ORDER BY e.line_no) AS entries
        FROM journal_transactions j JOIN journal_entries e ON e.transaction_id=j.id JOIN ledger_accounts a ON a.id=e.account_id
        WHERE a.user_id=$1 AND ($2::timestamptz IS NULL OR (j.created_at,j.id)<($2,$3::uuid))
        GROUP BY j.id ORDER BY j.created_at DESC,j.id DESC LIMIT $4`, [actor.userId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1])).rows, limit);
    });
  });
  app.get<{ Querystring: { q: string; limit?: string } }>('/api/v1/wallet/recipients', { schema: { querystring: Type.Object({
    q: Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' }),
    limit: Type.Optional(Type.String({ pattern: '^([1-9]|[1-4][0-9]|50)$' })),
  }, { additionalProperties: false }) } }, async request => {
    const actor = requireUser(request);
    return withTransaction(ctx.pool, async tx => {
      await lockActor(tx, actor);
      // Treat search text literally; public identity fields only, never another wallet's balance.
      const search = `%${request.query.q.trim().replace(/[\\%_]/g, '\\$&')}%`;
      const items = (await tx.query(`SELECT * FROM (
        SELECT 'user' AS type,u.id,u.display_name AS name,u.github_login FROM users u
          WHERE u.status='active' AND (u.github_login ILIKE $1 OR u.display_name ILIKE $1 OR u.id::text=$2)
        UNION ALL
        SELECT 'agent' AS type,a.id,a.name,u.github_login FROM agents a JOIN users u ON u.id=a.owner_user_id
          WHERE u.status='active' AND a.deleted_at IS NULL AND (a.name ILIKE $1 OR u.github_login ILIKE $1 OR a.id::text=$2)
        ) recipients ORDER BY type DESC,github_login,name,id LIMIT $3`, [search, request.query.q.trim().toLowerCase(), Number(request.query.limit ?? 20)])).rows;
      return { items };
    });
  });
  app.post<{ Body: WalletTransferInput }>('/api/v1/wallet/transfers', { schema: { body: WalletTransfer } }, async (request, reply) => {
    const actor = requireUser(request);
    const from = { ...request.body.from, id: request.body.from.id.toLowerCase() };
    const to = { ...request.body.to, id: request.body.to.id.toLowerCase() };
    // Resolve the immutable owner before command() so both user rows are locked in UUID order.
    const recipientId = to.type === 'user' ? to.id
      : (await ctx.pool.query<{ owner_user_id: string }>('SELECT owner_user_id FROM agents WHERE id=$1', [to.id])).rows[0]?.owner_user_id;
    return command(ctx, request, reply, { userIds: recipientId ? [recipientId] : [] }, async tx => {
      const result = await transfer(tx, { actor, requestId: request.id }, {
        businessKey: `wallet-transfer:${actor.userId}:${request.body.transfer_id.toLowerCase()}`,
        from, to, amount: request.body.amount, reason: request.body.reason?.trim() || '钱包转账',
      });
      return { status: 201, body: { id: result.transactionId, transaction_id: result.transactionId,
        from: result.from, to: result.to, amount: result.amount, created: result.created }, resourceType: 'journal', resourceId: result.transactionId };
    });
  });
}
