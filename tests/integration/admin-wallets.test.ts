import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, AdminUserWalletsDto, AdminWalletAdjustmentInput } from '../../packages/contracts/src/index.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { lockActor, tokenHash } from '../../apps/api/src/core.js';
import { context, agent, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';
import { getWallet, issue, reconcile, reserve, setIssuanceLimit } from '../../apps/api/src/modules/ledger/service.js';

const pools = testPools(), origin = 'http://localhost:5173';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Session, secondAdmin: Session, member: Session;
let target: Awaited<ReturnType<typeof agent>>;
async function session(role: 'admin' | 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  await pools.runtime.query('SELECT ledger.open_user_account($1)', [actor.userId]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
const headers = (who = admin, key: string = randomUUID()) => ({ cookie: who.cookie, origin, 'x-csrf-token': who.csrf, 'idempotency-key': key });
const payload = (type: 'user' | 'agent', direction: 'add' | 'remove', amount: string): AdminWalletAdjustmentInput => ({
  wallet: { type, id: type === 'user' ? member.actor.userId : target.id }, direction, amount, reason: '核验后的管理员调整', business_id: randomUUID(),
});
const adjust = (body: AdminWalletAdjustmentInput, who = admin, key?: string) => app.inject({ method: 'POST', url: '/api/v1/admin/wallet-adjustments', headers: headers(who, key), payload: body });
async function apply(type: 'user' | 'agent', direction: 'add' | 'remove', amount: string) {
  const response = await adjust(payload(type, direction, amount));
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ transaction_id: string }>();
}
async function wallets() {
  const response = await app.inject({ url: `/api/v1/admin/users/${member.actor.userId}/wallets`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AdminUserWalletsDto>();
}
async function conserved() { expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true); }
beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin,
    githubClientId: '', githubClientSecret: '', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); secondAdmin = await session('admin'); member = await session('member');
  target = await agent(pools.runtime, member.actor);
  await withTransaction(pools.runtime, async tx => {
    await lockActor(tx, admin.actor, { admin: true });
    const month = (await tx.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month")).rows[0].month;
    await setIssuanceLimit(tx, context(admin.actor), { month, limitPoints: '500', reason: 'isolated operator budget' });
    await issue(tx, context(admin.actor), { businessKey: `test-budget:${randomUUID()}`, amount: '500', reason: 'isolated operator funding' });
  });
});
afterAll(async () => { await app.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('administrator wallet adjustments', () => {
  it('redistributes existing points to and from personal and Agent wallets with visible reasons and immutable audit', async () => {
    await apply('user', 'add', '100'); await apply('user', 'remove', '30');
    await apply('agent', 'add', '60'); await apply('agent', 'remove', '20');
    const view = await wallets();
    expect(view.reward_pool_points).toBe('340');
    expect(view.wallets).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'user', id: member.actor.userId, available: '70', reserved: '0' }),
      expect.objectContaining({ type: 'agent', id: target.id, available: '40', reserved: '0' }),
    ]));
    expect((await pools.runtime.query("SELECT balance FROM ledger_accounts WHERE system_key='RECOVERY'")).rows[0].balance).toBe('50');
    expect((await pools.runtime.query('SELECT issued_points FROM credit_issuance_periods')).rows[0].issued_points).toBe('500');
    expect((await withTransaction(pools.runtime, tx => getWallet(tx, target.id))).todaySpent).toBe('0');
    const journals = (await pools.runtime.query("SELECT actor_type,actor_user_id,payer_agent_id,spend_points,reason FROM journal_transactions WHERE kind='ADMIN_ADJUST'")).rows;
    expect(journals).toHaveLength(4);
    expect(journals.every(row => row.actor_type === 'user' && row.actor_user_id === admin.actor.userId && row.payer_agent_id === null && row.spend_points === '0')).toBe(true);
    const events = (await pools.runtime.query("SELECT details FROM audit_events WHERE action='ledger.posted' AND business_key LIKE 'admin-adjustment:%'")).rows;
    expect(events).toHaveLength(4);
    expect(events[0].details).toMatchObject({ commandHash: expect.any(String), result: { owner_user_id: member.actor.userId, reason: '核验后的管理员调整' } });
    const history = await app.inject({ url: '/api/v1/wallet/transactions', headers: headers(member) });
    expect(history.json().items).toHaveLength(2);
    expect(history.json().items[0]).toMatchObject({ kind: 'ADMIN_ADJUST', reason: '核验后的管理员调整' });
    await conserved();
  });

  it('cannot spend reserved balances or issue funds when the reward pool is empty', async () => {
    expect((await adjust(payload('user', 'add', '501'))).statusCode).toBe(409);
    await apply('user', 'add', '100'); await apply('agent', 'add', '100');
    await withTransaction(pools.runtime, async tx => {
      await lockActor(tx, member.actor, { agentId: target.id });
      await reserve(tx, context(member.actor), { businessRef: `user-hold:${randomUUID()}`, payerAgentId: null, payerUserId: member.actor.userId,
        amount: '80', permission: 'can_trade', reason: 'ongoing personal game' });
      await reserve(tx, context(member.actor), { businessRef: `agent-hold:${randomUUID()}`, payerAgentId: target.id,
        amount: '90', permission: 'can_trade', reason: 'ongoing Agent contract' });
    });
    const holds = (await pools.runtime.query('SELECT * FROM credit_holds ORDER BY id')).rows;
    expect((await adjust(payload('user', 'remove', '21'))).statusCode).toBe(409);
    expect((await adjust(payload('agent', 'remove', '11'))).statusCode).toBe(409);
    await apply('user', 'remove', '20'); await apply('agent', 'remove', '10');
    expect((await wallets()).wallets).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'user', available: '0', reserved: '80' }),
      expect.objectContaining({ type: 'agent', available: '0', reserved: '90' }),
    ]));
    expect((await pools.runtime.query('SELECT * FROM credit_holds ORDER BY id')).rows).toEqual(holds);
    await apply('user', 'add', '300');
    expect((await adjust(payload('user', 'add', '1'))).statusCode).toBe(409);
    expect((await pools.runtime.query('SELECT issued_points FROM credit_issuance_periods')).rows[0].issued_points).toBe('500');
    await conserved();
  });

  it('deduplicates concurrent retries across request keys and rejects changed business payloads', async () => {
    const body = payload('user', 'add', '75'), key = randomUUID();
    const results = await Promise.all([adjust(body, admin, key), adjust(body, admin, key), adjust(body)]);
    expect(results.every(result => result.statusCode === 201)).toBe(true);
    expect(new Set(results.map(result => result.json().transaction_id)).size).toBe(1);
    expect(results[0]!.json()).toEqual(results[1]!.json());
    expect((await adjust(body)).json().created).toBe(false);
    for (const requestKey of [key, randomUUID()]) expect((await adjust({ ...body, amount: '76' }, admin, requestKey)).statusCode).toBe(409);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions WHERE kind='ADMIN_ADJUST'")).rows[0].n).toBe(1);
    expect((await wallets()).wallets[0]!.available).toBe('75');
    await conserved();
  });

  it('serializes competing administrator removals without overdraft', async () => {
    await apply('user', 'add', '100');
    const results = await Promise.all([adjust(payload('user', 'remove', '70'), admin), adjust(payload('user', 'remove', '70'), secondAdmin)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
    expect((await wallets()).wallets[0]!.available).toBe('30');
    await conserved();
  });

  it('supports administrative corrections for suspended users and paused Agents, but rejects deleted or missing targets', async () => {
    await pools.runtime.query("UPDATE users SET status='suspended' WHERE id=$1", [member.actor.userId]);
    await pools.runtime.query("UPDATE agents SET status='paused' WHERE id=$1", [target.id]);
    await pools.runtime.query('UPDATE agent_policies SET can_trade=false,single_spend_limit=0,daily_spend_limit=0 WHERE agent_id=$1', [target.id]);
    await apply('user', 'add', '10'); await apply('user', 'remove', '10');
    await apply('agent', 'add', '10'); await apply('agent', 'remove', '10');
    expect((await wallets()).wallets).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'user', status: 'suspended' }), expect.objectContaining({ type: 'agent', status: 'paused' })]));
    await pools.runtime.query('UPDATE agents SET deleted_at=clock_timestamp() WHERE id=$1', [target.id]);
    expect((await adjust(payload('agent', 'add', '1'))).statusCode).toBe(410);
    for (const type of ['user', 'agent'] as const) expect((await adjust({ ...payload(type, 'add', '1'), wallet: { type, id: randomUUID() } })).statusCode).toBe(404);
    await conserved();
  });

  it('requires an active administrator session and CSRF, and validates positive amounts and reasons', async () => {
    const body = payload('user', 'add', '10'), before = await wallets();
    expect((await adjust(body, member)).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/admin/users/${member.actor.userId}/wallets`, headers: headers(member) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/wallet-adjustments', headers: { cookie: admin.cookie, 'idempotency-key': randomUUID() }, payload: body })).statusCode).toBe(403);
    const token = `azk_${target.actor.credentialId}.${randomBytes(32).toString('base64url')}`;
    await pools.migration.query('UPDATE agent_keys SET secret_hash=$2 WHERE id=$1', [target.actor.credentialId, tokenHash(token)]);
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/wallet-adjustments', headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, payload: body })).statusCode).toBe(403);
    for (const amount of ['0', '-1', '1.5', '01', '9223372036854775808']) expect((await adjust({ ...body, amount })).statusCode).toBe(400);
    expect((await adjust({ ...body, reason: ' ' })).statusCode).toBe(400);
    await pools.runtime.query("UPDATE users SET status='suspended' WHERE id=$1", [secondAdmin.actor.userId]);
    expect((await adjust(body, secondAdmin)).statusCode).toBe(403);
    expect(await wallets()).toEqual(before);
  });

  it('rejects forbidden account combinations at the database boundary and respects quarantine', async () => {
    const rows = (await pools.runtime.query('SELECT id,bucket FROM ledger_accounts WHERE user_id=$1 OR system_key IS NOT NULL', [member.actor.userId])).rows;
    const id = (bucket: string) => rows.find(row => row.bucket === bucket)!.id;
    for (const [source, destination] of [['REWARD_POOL', 'USER_RESERVED'], ['USER_RESERVED', 'RECOVERY'], ['ISSUANCE_CONTROL', 'USER_AVAILABLE'], ['RECOVERY', 'USER_AVAILABLE'], ['REWARD_POOL', 'RECOVERY']]) {
      await expect(pools.runtime.query('SELECT * FROM ledger.post_journal($1,$2)', [JSON.stringify({ kind: 'ADMIN_ADJUST', actor_type: 'user', actor_user_id: admin.actor.userId,
        business_key: `invalid-adjustment:${randomUUID()}`, business_date: '2026-11-10', spend_points: '0', reason: 'invalid direct journal' }),
      JSON.stringify([{ account_id: id(source!), side: 'credit', amount: '1' }, { account_id: id(destination!), side: 'debit', amount: '1' }])])).rejects.toThrow('INVALID_ACCOUNT_COMBINATION');
    }
    await pools.migration.query("INSERT INTO audit_events(actor_type,action,target_type,target_id,request_id,details) VALUES('system','ledger.quarantined','account',$1,$2,'{}')", [id('USER_AVAILABLE'), randomUUID()]);
    const blocked = await adjust(payload('user', 'add', '1'));
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error.code).toBe('LEDGER_QUARANTINED');
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions WHERE kind='ADMIN_ADJUST'")).rows[0].n).toBe(0);
  });

  it('searches users by login, display name and ID without treating wildcard characters as patterns', async () => {
    await pools.runtime.query("UPDATE users SET github_login='test_operator_target',display_name='钱包调整用户' WHERE id=$1", [member.actor.userId]);
    for (const q of ['test_operator_target', '钱包调整用户', member.actor.userId]) {
      const result = await app.inject({ url: `/api/v1/admin/users?q=${encodeURIComponent(q)}`, headers: headers() });
      expect(result.statusCode).toBe(200); expect(result.json().items.map((user: { id: string }) => user.id)).toEqual([member.actor.userId]);
    }
    const literal = await app.inject({ url: '/api/v1/admin/users?q=%25', headers: headers() });
    expect(literal.json().items).toEqual([]);
  });
});
