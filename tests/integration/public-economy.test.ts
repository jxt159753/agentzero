import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, EconomySnapshot } from '../../packages/contracts/src/index.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { lockActor, tokenHash } from '../../apps/api/src/core.js';
import { pay, reconcile, recycle } from '../../apps/api/src/modules/ledger/service.js';
import { createRewardRedemption } from '../../apps/api/src/modules/rewards/service.js';
import { readOperationsReport } from '../../scripts/operations-report.js';
import { agent, concurrent, context, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), origin = 'http://localhost:5173';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Session, secondAdmin: Session, member: Session;
let buyer: Awaited<ReturnType<typeof agent>>;
async function session(role: 'admin' | 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
const headers = (who = admin, key: string = randomUUID()) => ({ cookie: who.cookie, origin, 'x-csrf-token': who.csrf, 'idempotency-key': key });
const write = (path: string, payload: object, who = admin, key?: string, method: 'POST' | 'PUT' = 'POST') =>
  app.inject({ method, url: `/api/v1${path}`, headers: headers(who, key), payload });
async function snapshot(who = admin) {
  const response = await app.inject({ url: '/api/v1/admin/economy', headers: headers(who) });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<EconomySnapshot>();
}
async function recover(amount = '100') {
  await withTransaction(pools.runtime, async tx => {
    await lockActor(tx, member.actor, { agentId: buyer.id });
    await pay(tx, context(member.actor), { businessKey: `test-land:${randomUUID()}`, payerAgentId: buyer.id, amount, permission: 'can_trade', reason: 'isolated land purchase' });
  });
}
async function redemption() {
  const month = (await pools.runtime.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-01') AS month")).rows[0].month;
  const pool = await write(`/admin/reward-pools/${month}`, { version: '0', total_quantity: '4', user_monthly_limit: '4', contact_qq: '123456', instructions: '测试兑换说明', status: 'active', reason: 'test supply' }, admin, undefined, 'PUT');
  expect(pool.statusCode, pool.body).toBe(201);
  const offer = await write('/admin/reward-offers', { pool_id: pool.json().id, title: '测试奖励', description: '隔离测试', points_cost: '20', total_quantity: '4', reason: 'test offer' });
  expect(offer.statusCode, offer.body).toBe(201);
  const claims: { id: string; version: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const claim = await write('/reward-redemptions', { offer_id: offer.json().id, agent_id: buyer.id, claimant_qq: '123456' }, member);
    expect(claim.statusCode, claim.body).toBe(201); claims.push(claim.json());
  }
  const processing = await write(`/admin/reward-redemptions/${claims[1]!.id}/process`, { version: claims[1]!.version, reason: 'test processing' });
  expect(processing.statusCode, processing.body).toBe(200); claims[1] = processing.json();
  return claims;
}
beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin,
    githubClientId: '', githubClientSecret: '', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); secondAdmin = await session('admin'); member = await session('member');
  buyer = await agent(pools.runtime, member.actor);
  await fund(pools.runtime, admin.actor, buyer.id, '200');
});
afterAll(async () => { await app.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('public economy without registration issuance', () => {
  it('preserves historical grants through migration and refuses new INITIAL_GRANT journals', async () => {
    const old = await readFile(new URL('../../packages/database/migrations/0029_user_game_wallets.sql', import.meta.url), 'utf8');
    const migration = await readFile(new URL('../../packages/database/migrations/0031_public_economy.sql', import.meta.url), 'utf8');
    const tx = await pools.migration.connect();
    try {
      await tx.query('BEGIN');
      // Install only the old function definitions inside this isolated transaction.
      await tx.query(old.slice(old.indexOf('CREATE OR REPLACE FUNCTION ledger.post_journal')));
      await tx.query('SELECT ledger.open_user_account($1)', [member.actor.userId]);
      const before = (await tx.query('SELECT id,bucket,balance FROM ledger_accounts ORDER BY id')).rows;
      const journals = (await tx.query('SELECT id,kind,business_key FROM journal_transactions ORDER BY id')).rows;
      await tx.query(migration);
      await tx.query('SELECT ledger.open_user_account($1)', [member.actor.userId]);
      expect((await tx.query('SELECT id,bucket,balance FROM ledger_accounts ORDER BY id')).rows).toEqual(before);
      expect((await tx.query('SELECT id,kind,business_key FROM journal_transactions ORDER BY id')).rows).toEqual(journals);
      // Keep later installed ledger functions intact after this historical migration rehearsal.
      await tx.query('ROLLBACK');
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
    await pools.runtime.query('SELECT ledger.open_user_account($1)', [secondAdmin.actor.userId]);
    const account = (await pools.runtime.query("SELECT id,balance FROM ledger_accounts WHERE user_id=$1 AND bucket='USER_AVAILABLE'", [secondAdmin.actor.userId])).rows[0];
    expect(account.balance).toBe('0');
    const control = (await pools.runtime.query("SELECT id FROM ledger_accounts WHERE system_key='ISSUANCE_CONTROL'")).rows[0].id;
    await expect(pools.runtime.query('SELECT * FROM ledger.post_journal($1,$2)', [JSON.stringify({ kind: 'INITIAL_GRANT', business_key: `initial-funds:user:${secondAdmin.actor.userId}`,
      actor_type: 'system', spend_points: '0', business_date: '2026-11-10', reason: 'forbidden new grant' }),
    JSON.stringify([{ account_id: account.id, side: 'debit', amount: '1000' }, { account_id: control, side: 'credit', amount: '1000' }])])).rejects.toThrow('INITIAL_GRANT_DISABLED');
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('preserves pending and processing refunds while recycling existing money with audit and idempotency', async () => {
    await recover(); const claims = await redemption();
    expect(await snapshot()).toMatchObject({ user_available_points: '60', user_reserved_points: '0', recovery_points: '140', refund_reserve_points: '40', recyclable_points: '100', total_issued_points: '200' });
    const payload = { business_id: randomUUID(), amount: '100', reason: 'fund reviewed tasks' };
    const key = randomUUID();
    const first = await write('/admin/recycles', payload, admin, key);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ amount: '100', created: true });
    expect((await write('/admin/recycles', payload, admin, key)).json()).toEqual(first.json());
    expect((await write('/admin/recycles', payload)).json()).toMatchObject({ transaction_id: first.json().transaction_id, created: false });
    expect((await write('/admin/recycles', { ...payload, amount: '99' })).statusCode).toBe(409);
    expect((await write('/admin/recycles', { ...payload, business_id: randomUUID(), amount: '1' })).statusCode).toBe(409);
    expect(await snapshot()).toMatchObject({ reward_pool_points: '100', recovery_points: '40', refund_reserve_points: '40', recyclable_points: '0', total_issued_points: '200', recycled_points: '100' });
    for (const claim of claims) {
      const cancelled = await write(`/admin/reward-redemptions/${claim.id}/cancel`, { version: claim.version, reason: 'cancel without fulfillment' });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
    }
    expect(await snapshot()).toMatchObject({ user_available_points: '100', recovery_points: '0', refund_reserve_points: '0', reward_pool_points: '100' });
    expect((await pools.runtime.query("SELECT count(*)::int n FROM audit_events WHERE action='ledger.posted' AND business_key=$1", [`recycle:${payload.business_id}`])).rows[0].n).toBe(1);
    const report = await readOperationsReport(pools.runtime, { environment: 'test', connection_variable: 'TEST_DATABASE_URL' });
    expect(report.ledger).toMatchObject({ refunded_points: '40', recovered_net_points: '0' });
    expect(report.economy).toMatchObject({ recycled_points: '100', total_issued_points: '200' });
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('allows only one competing administrator to consume a limited recovery balance', async () => {
    await recover();
    const results = await concurrent(pools.runtime, [admin, secondAdmin].map(who => ({ actor: who.actor,
      action: (tx, ctx) => recycle(tx, ctx, { businessKey: `recycle:${randomUUID()}`, amount: '60', reason: 'competing recycled budget' }),
    })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await snapshot()).toMatchObject({ recovery_points: '40', reward_pool_points: '60', total_issued_points: '200' });
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('includes a newly committed refund obligation after waiting for a concurrent redemption', async () => {
    await recover(); await redemption();
    const offerId = (await pools.runtime.query('SELECT id FROM reward_offers LIMIT 1')).rows[0].id;
    const payer = await pools.runtime.connect(), recycler = await pools.runtime.connect();
    try {
      await payer.query('BEGIN'); await recycler.query('BEGIN');
      await lockActor(payer, member.actor, { agentId: buyer.id });
      await createRewardRedemption(payer, member.actor, randomUUID(), { offer_id: offerId, agent_id: buyer.id, claimant_qq: '123456' });
      const pid = (await recycler.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      // This starts while the new PAY and its refund obligation are uncommitted.
      const attempted = recycle(recycler, context(admin.actor), { businessKey: `recycle:${randomUUID()}`, amount: '120', reason: 'must wait for current refund reserve' })
        .then(() => 'unexpected success', error => (error as { message: string }).message);
      await expect.poll(async () => (await pools.runtime.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type).toBe('Lock');
      await payer.query('COMMIT');
      expect(await attempted).toBe('INSUFFICIENT_FUNDS');
      await recycler.query('ROLLBACK');
    } finally {
      await payer.query('ROLLBACK'); await recycler.query('ROLLBACK'); payer.release(); recycler.release();
    }
    expect(await snapshot()).toMatchObject({ recovery_points: '160', refund_reserve_points: '60', recyclable_points: '100', reward_pool_points: '0' });
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('rejects member access, invalid amounts and quarantined recycling without changing balances', async () => {
    await recover(); const before = await snapshot();
    const payload = { business_id: randomUUID(), amount: '10', reason: 'test authority' };
    expect((await write('/admin/recycles', payload, member)).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/admin/economy', headers: headers(member) })).statusCode).toBe(403);
    for (const amount of ['0', '-1', '1.5', '101', '9223372036854775808']) expect([400, 409]).toContain((await write('/admin/recycles', { ...payload, amount })).statusCode);
    await pools.migration.query("INSERT INTO audit_events(actor_type,action,target_type,target_id,request_id,details) VALUES('system','ledger.quarantined','ledger','global',$1,'{}')", [randomUUID()]);
    const blocked = await write('/admin/recycles', payload);
    expect(blocked.statusCode, blocked.body).toBe(409); expect(blocked.json().error.code).toBe('LEDGER_QUARANTINED');
    expect(await snapshot()).toEqual(before);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions WHERE kind='RECYCLE'")).rows[0].n).toBe(0);
  });
});
