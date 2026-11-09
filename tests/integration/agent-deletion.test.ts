import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../packages/contracts/src/index.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { lockActor, tokenHash } from '../../apps/api/src/core.js';
import { pay, reserve } from '../../apps/api/src/modules/ledger/service.js';
import { agent, context, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), origin = 'http://localhost:5173';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: Session, other: Session;
let target: Awaited<ReturnType<typeof agent>> & { token: string };

async function session(role: 'admin' | 'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
const headers = (user = owner, key = randomUUID()) => ({ cookie: user.cookie, origin, 'x-csrf-token': user.csrf, 'idempotency-key': key });
const remove = (user = owner, version = '1', key = randomUUID()) => app.inject({ method: 'DELETE', url: `/api/v1/agents/${target.id}`, headers: headers(user, key), payload: { version } });
const get = (path: string, user = owner) => app.inject({ url: `/api/v1${path}`, headers: headers(user) });
const blocked = (response: Awaited<ReturnType<typeof remove>>, message: string) => {
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().error.code).toBe('AGENT_DELETE_BLOCKED');
  expect(response.json().error.message).toContain(message);
};
async function spend(amount = '10') {
  await fund(pools.runtime, owner.actor, target.id, amount);
  return withTransaction(pools.runtime, async tx => {
    await lockActor(tx, owner.actor, { agentId: target.id });
    return pay(tx, context(owner.actor), { businessKey: `deletion-test:${randomUUID()}`, payerAgentId: target.id, amount, permission: 'can_trade', reason: 'isolated deletion history fixture' });
  });
}
async function task(agentId: string | null) {
  const repoId = randomUUID(), id = randomUUID();
  await pools.migration.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES('1','test','active') ON CONFLICT DO NOTHING");
  await pools.migration.query("INSERT INTO repositories(id,github_id,installation_id,owner,name,full_name) VALUES($1,$2,'1','test','repo','test/repo')", [repoId, String(Date.now())]);
  await pools.migration.query(`INSERT INTO tasks(id,title,description,repository_id,acceptance_criteria,required_checks,reward_points,deadline_at,publisher_user_id,publisher_agent_id,reviewer_user_id)
    VALUES($1,'deletion test','fixture',$2,'fixture','[]',1,clock_timestamp()+interval '1 day',$3,$4,$5)`, [id, repoId, owner.actor.userId, agentId, other.actor.userId]);
  return id;
}

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test', githubClientSecret: 'test', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 3000 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  owner = await session('admin'); other = await session();
  const created = await agent(pools.runtime, owner.actor);
  const token = `azk_${created.actor.credentialId}.${randomBytes(32).toString('base64url')}`;
  await pools.migration.query('UPDATE agent_keys SET secret_hash=$2 WHERE id=$1', [created.actor.credentialId, tokenHash(token)]);
  target = { ...created, token };
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('owned Agent deletion', () => {
  it('deletes once under concurrent retries, revokes access and hides the Agent while retaining history', async () => {
    await spend();
    const before = await get(`/agents/${target.id}/transactions`);
    expect(before.json().items.length).toBeGreaterThan(0);
    const bearer = { authorization: `Bearer ${target.token}`, 'idempotency-key': randomUUID() };
    expect((await app.inject({ method: 'POST', url: '/api/v1/world/presence', headers: bearer, payload: {} })).statusCode).toBe(200);
    const key = randomUUID();
    const results = await Promise.all([remove(owner, '1', key), remove(owner, '1', key), remove()]);
    expect(results.map(result => result.statusCode)).toEqual([200, 200, 200]);
    expect(results[0].json()).toMatchObject({ id: target.id, deleted: true, version: '2' });
    expect(results[0].json()).toEqual(results[1].json());
    expect((await pools.runtime.query("SELECT count(*)::int n FROM audit_events WHERE action='agent.deleted'")).rows[0].n).toBe(1);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM ledger_accounts WHERE agent_id=$1', [target.id])).rows[0].n).toBe(2);
    expect((await get(`/agents/${target.id}/transactions`)).json().items).toEqual(before.json().items);
    expect((await get(`/agents/${target.id}/wallet`)).json()).toMatchObject({ available: '0', reserved: '0' });
    expect((await get(`/agents/${target.id}`)).json()).toMatchObject({ status: 'paused', version: '2', deleted_at: expect.any(String) });
    expect((await get('/agents')).json().items).toEqual([]);
    expect((await get('/world')).json().agents).toEqual([]);
    expect((await app.inject({ url: '/api/v1/me', headers: bearer })).json().error.code).toBe('CREDENTIAL_REVOKED');
    expect((await pools.runtime.query('SELECT expires_at<=clock_timestamp() expired FROM world_positions WHERE agent_id=$1', [target.id])).rows[0].expired).toBe(true);
  });

  it('requires the owner, CSRF and a fresh version, and never permits reactivation or a new key', async () => {
    expect((await remove(other)).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/agents/${target.id}`, headers: { cookie: owner.cookie }, payload: { version: '1' } })).json().error.code).toBe('CSRF_INVALID');
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/agents/${target.id}`, headers: { authorization: `Bearer ${target.token}`, 'idempotency-key': randomUUID() }, payload: { version: '1' } })).statusCode).toBe(403);
    const changed = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${target.id}`, headers: headers(), payload: { name: 'Renamed' } });
    expect(changed.json().version).toBe('2');
    expect((await remove()).json().error.code).toBe('AGENT_VERSION_CONFLICT');
    expect((await remove(owner, '2')).statusCode).toBe(200);
    for (const [method, suffix, payload] of [['PATCH', '', { status: 'active' }], ['POST', '/keys', { label: 'revive' }]] as const) {
      const denied = await app.inject({ method, url: `/api/v1/agents/${target.id}${suffix}`, headers: headers(), payload });
      expect(denied.json().error.code).toBe('AGENT_DELETED');
    }
    expect((await get(`/agents/${target.id}`, other)).statusCode).toBe(403);
  });

  it('blocks available funds, reserved funds and open commitments without changing balances', async () => {
    await fund(pools.runtime, owner.actor, target.id, '10');
    blocked(await remove(), '钱包仍有');
    await withTransaction(pools.runtime, async tx => {
      await lockActor(tx, owner.actor, { agentId: target.id });
      await reserve(tx, context(owner.actor), { businessRef: `deletion-hold:${randomUUID()}`, payerAgentId: target.id, amount: '10', permission: 'can_trade', reason: 'isolated deletion hold fixture' });
    });
    const result = await remove();
    blocked(result, '资金冻结');
    expect((await get(`/agents/${target.id}/wallet`)).json()).toMatchObject({ available: '0', reserved: '10', held: '10' });
    expect((await get(`/agents/${target.id}`)).json().deleted_at).toBeNull();
  });

  it('blocks owned land, items and active listings even with an empty wallet', async () => {
    const landId = randomUUID(), templateId = randomUUID(), itemId = randomUUID();
    await pools.migration.query("INSERT INTO land_plots(id,code,x,y,area,points_price,owner_agent_id,owner_user_id,created_by) VALUES($1,'DELETE-TEST',20,20,1,1,$2,$3,$3)", [landId, target.id, owner.actor.userId]);
    await pools.migration.query("INSERT INTO item_templates(id,name,description,appearance,points_price,total_quantity,issued_quantity,created_by) VALUES($1,'plant','fixture','plant',1,1,1,$2)", [templateId, owner.actor.userId]);
    await pools.migration.query('INSERT INTO item_instances(id,template_id,owner_agent_id) VALUES($1,$2,$3)', [itemId, templateId, target.id]);
    await pools.migration.query('INSERT INTO market_listings(seller_agent_id,land_id,points_price) VALUES($1,$2,1)', [target.id, landId]);
    const result = await remove();
    for (const reason of ['土地', '物品', '有效挂牌']) blocked(result, reason);
    expect((await get(`/agents/${target.id}`)).json().deleted_at).toBeNull();
  });

  it('blocks task drafts and pending collaboration obligations', async () => {
    const draft = await task(target.id);
    blocked(await remove(), '任务草稿');
    await pools.migration.query('UPDATE tasks SET publisher_agent_id=NULL WHERE id=$1', [draft]);
    const agreementId = randomUUID();
    await pools.migration.query("INSERT INTO collaboration_agreements(id,task_id,version,deadline_at) VALUES($1,$2,1,clock_timestamp()+interval '1 day')", [agreementId, draft]);
    await pools.migration.query("INSERT INTO agreement_members(agreement_id,agent_id,role,deliverable,amount_points) VALUES($1,$2,'review','fixture',1)", [agreementId, target.id]);
    blocked(await remove(), '协作协议');
    await pools.migration.query("UPDATE collaboration_agreements SET status='rejected',rejection_reason='test release' WHERE id=$1", [agreementId]);
    expect((await remove()).statusCode).toBe(200);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM agreement_members WHERE agent_id=$1', [target.id])).rows[0].n).toBe(1);
  });

  it('keeps pending reward claims alive and allows deletion after fulfillment while retaining their record', async () => {
    const payment = await spend('1'), poolId = randomUUID(), offerId = randomUUID(), rewardId = randomUUID();
    await pools.migration.query("INSERT INTO reward_pools(id,month,total_quantity,allocated_quantity,user_monthly_limit,contact_qq,instructions,created_by,updated_by) VALUES($1,'2026-11-01',1,1,1,'12345','fixture',$2,$2)", [poolId, owner.actor.userId]);
    await pools.migration.query("INSERT INTO reward_offers(id,pool_id,title,description,points_cost,total_quantity,redeemed_quantity,created_by) VALUES($1,$2,'reward','fixture',1,1,1,$3)", [offerId, poolId, owner.actor.userId]);
    await pools.migration.query(`INSERT INTO reward_redemptions(id,claim_code,user_id,agent_id,pool_id,offer_id,title,description,points_cost,contact_qq,instructions,claimant_qq,payment_transaction_id)
      VALUES($1,$2,$3,$4,$5,$6,'reward','fixture',1,'12345','fixture','12345',$7)`, [rewardId, `RWD-${randomUUID().replaceAll('-', '').toUpperCase()}`, owner.actor.userId, target.id, poolId, offerId, payment.transactionId]);
    blocked(await remove(), '奖励兑换');
    await pools.migration.query("UPDATE reward_redemptions SET status='processing',processed_by=$2 WHERE id=$1", [rewardId, owner.actor.userId]);
    blocked(await remove(), '奖励兑换');
    await pools.migration.query("UPDATE reward_redemptions SET status='fulfilled',fulfilled_at=clock_timestamp(),fulfillment_reference='test receipt' WHERE id=$1", [rewardId]);
    expect((await remove()).statusCode).toBe(200);
    expect((await get(`/reward-redemptions/${rewardId}`)).json()).toMatchObject({ id: rewardId, agent_id: target.id, status: 'fulfilled' });
  });
});
