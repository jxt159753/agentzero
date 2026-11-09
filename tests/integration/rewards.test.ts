import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../packages/contracts/src/index.js';
import type { RewardCatalogDto, RewardOfferDto, RewardPoolDto, RewardRedemptionDto } from '../../packages/contracts/src/rewards.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { getWallet, reconcile } from '../../apps/api/src/modules/ledger/service.js';
import { agent, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

// These tests exercise real PostgreSQL transactions, permissions, CSRF and routes.
// Manual fulfillment only records the operator's result; no QQ or payment service is called.
const pools = testPools(), origin = 'http://localhost:5173';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
type TestAgent = Awaited<ReturnType<typeof agent>> & { token: string };
type Client = Session | TestAgent;
type AdminCatalog = { pool: RewardPoolDto | null; offers: RewardOfferDto[] };
type Receipt = RewardRedemptionDto & { operation_id: string };
let app: Awaited<ReturnType<typeof buildApp>>;
let alice: Session, bob: Session, admin: Session, secondAdmin: Session;
let a: TestAgent, sibling: TestAgent, b: TestAgent;
let month: string, previousMonth: string, nextMonth: string;

async function session(role: 'admin' | 'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
async function credential(owner: Session): Promise<TestAgent> {
  const created = await agent(pools.runtime, owner.actor);
  const token = `azk_${created.actor.credentialId}.${randomBytes(32).toString('base64url')}`;
  await pools.migration.query('UPDATE agent_keys SET secret_hash=$2 WHERE id=$1', [created.actor.credentialId, tokenHash(token)]);
  return { ...created, token };
}
const headers = (client: Client, key: string = randomUUID()) => 'token' in client
  ? { authorization: `Bearer ${client.token}`, 'idempotency-key': key }
  : { cookie: client.cookie, origin, 'x-csrf-token': client.csrf, 'idempotency-key': key };
const write = (client: Client, method: 'POST' | 'PUT' | 'PATCH', url: string, payload: Record<string, unknown>, key?: string) => app.inject({ method, url, headers: headers(client, key), payload });
const post = (client: Client, url: string, payload: Record<string, unknown>, key?: string) => write(client, 'POST', url, payload, key);
const get = (client: Client, url: string) => app.inject({ url, headers: headers(client) });
const wallet = (id: string) => withTransaction(pools.runtime, tx => getWallet(tx, id));
const rejected = (response: { statusCode: number; body: string }) => expect([400, 403, 404, 409], response.body).toContain(response.statusCode);
const catalog = async (client: Client = alice): Promise<RewardCatalogDto> => {
  const response = await get(client, '/api/v1/rewards');
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
};
const adminCatalog = async (period = month): Promise<AdminCatalog> => {
  const response = await get(admin, `/api/v1/admin/reward-pools/${period}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
};
function poolBody(overrides: Record<string, unknown> = {}) {
  return { version: '0', total_quantity: '10', user_monthly_limit: '5', contact_qq: '123456789', instructions: '通过 QQ 提供领取编号与 GitHub 账号，经核对后人工发放。', status: 'active', reason: '独立测试库奖励预算', ...overrides };
}
async function configurePool(overrides: Record<string, unknown> = {}, period = month) {
  const response = await write(admin, 'PUT', `/api/v1/admin/reward-pools/${period}`, poolBody(overrides));
  expect([200, 201], response.body).toContain(response.statusCode);
  return (await adminCatalog(period)).pool!;
}
async function createOffer(pool: RewardPoolDto, overrides: Record<string, unknown> = {}) {
  const response = await post(admin, '/api/v1/admin/reward-offers', { pool_id: pool.id, title: '测试人工奖励', description: '由运营者人工发放测试奖励；兑换前展示固定条件。', points_cost: '10', total_quantity: '5', reason: '新增测试报价', ...overrides });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<RewardOfferDto>();
}
async function reward(overrides: { pool?: Record<string, unknown>; offer?: Record<string, unknown> } = {}) {
  const pool = await configurePool(overrides.pool);
  return { pool, offer: await createOffer(pool, overrides.offer) };
}
const redeem = (client: Client, payer: TestAgent, offer: RewardOfferDto, key?: string, qq = '234567890') => post(client, '/api/v1/reward-redemptions', { offer_id: offer.id, agent_id: payer.id, claimant_qq: qq }, key);
async function redemption(offer: RewardOfferDto, client: Client = alice, payer = a): Promise<Receipt> {
  const response = await redeem(client, payer, offer);
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}
async function detail(id: string, client: Client = alice): Promise<RewardRedemptionDto> {
  const response = await get(client, `/api/v1/reward-redemptions/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function adminAction(order: RewardRedemptionDto, action: 'process' | 'fulfill' | 'cancel', client = admin, key?: string) {
  return post(client, `/api/v1/admin/reward-redemptions/${order.id}/${action}`, { version: order.version, reason: action === 'cancel' ? '已确认未线下支付，退还积分' : '测试运营处理记录', ...(action === 'fulfill' ? { fulfillment_reference: 'manual-test-reference-001' } : {}) }, key);
}
async function assertConserved() {
  expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
}
async function journalCount(kind: 'PAY' | 'REFUND') {
  return (await pools.runtime.query('SELECT count(*)::int AS n FROM journal_transactions WHERE kind=$1', [kind])).rows[0].n as number;
}

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test-client', githubClientSecret: 'test-secret', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 3000 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); secondAdmin = await session('admin'); alice = await session(); bob = await session();
  a = await credential(alice); sibling = await credential(alice); b = await credential(bob);
  for (const target of [a, sibling, b]) await fund(pools.runtime, admin.actor, target.id, '100');
  const dates = (await pools.runtime.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-01') AS month,
    to_char((clock_timestamp() AT TIME ZONE 'Asia/Shanghai') - interval '1 month','YYYY-MM-01') AS previous,
    to_char((clock_timestamp() AT TIME ZONE 'Asia/Shanghai') + interval '1 month','YYYY-MM-01') AS next`)).rows[0];
  month = dates.month; previousMonth = dates.previous; nextMonth = dates.next;
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('phase 4 manual rewards with real PostgreSQL', () => {
  it('starts without supply and enforces explicit pool and offer budgets with versioned administration', async () => {
    expect(await catalog()).toMatchObject({ pool: null, offers: [], redeemed_count: '0', remaining_count: '0' });
    const empty = await configurePool({ total_quantity: '0', user_monthly_limit: '0' });
    rejected(await post(admin, '/api/v1/admin/reward-offers', { pool_id: empty.id, title: '超预算', description: '不应创建', points_cost: '10', total_quantity: '1', reason: '预算检查' }));
    const configured = await configurePool({ version: empty.version, total_quantity: '2', user_monthly_limit: '2' });
    const offer = await createOffer(configured, { total_quantity: '2' });
    rejected(await write(admin, 'PUT', `/api/v1/admin/reward-pools/${month}`, poolBody({ version: empty.version, total_quantity: '20' })));
    rejected(await write(admin, 'PUT', `/api/v1/admin/reward-pools/${month}`, poolBody({ version: (await adminCatalog()).pool!.version, total_quantity: '1', user_monthly_limit: '1' })));
    rejected(await write(admin, 'PATCH', `/api/v1/admin/reward-offers/${offer.id}`, { version: offer.version, status: 'active', add_quantity: '1', reason: '不能超过月池' }));
    expect((await adminCatalog()).pool).toMatchObject({ total_quantity: '2', allocated_quantity: '2' });
    expect(await journalCount('PAY')).toBe(0);
    expect((await wallet(a.id)).available).toBe('100');
  });

  it('commits payment, inventory, immutable terms and a private claim together, with durable idempotency', async () => {
    const { offer } = await reward();
    const key = randomUUID();
    const first = await redeem(a, a, offer, key), replay = await redeem(a, a, offer, key);
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const order = first.json<Receipt>();
    expect(order).toMatchObject({ user_id: alice.actor.userId, agent_id: a.id, offer_id: offer.id, title: offer.title, points_cost: '10', claimant_qq: '234567890', status: 'pending', version: '1', refund_transaction_id: null });
    expect(order.claim_code).toMatch(/^RWD-[A-F0-9]{32}$/);
    expect(order.payment_transaction_id).toBeTruthy();
    expect((await wallet(a.id)).available).toBe('90');
    expect((await catalog()).offers[0]).toMatchObject({ redeemed_quantity: '1', remaining_quantity: '4' });
    expect(await journalCount('PAY')).toBe(1);
    expect((await redeem(a, a, offer, key, '345678901')).statusCode).toBe(409);
    const operation = await get(alice, `/api/v1/operations/${order.operation_id}`);
    expect(operation.statusCode, operation.body).toBe(200);
    expect(operation.json().result.id).toBe(order.id);
    const journal = (await pools.runtime.query('SELECT actor_type,actor_agent_id,credential_id FROM journal_transactions WHERE id=$1', [order.payment_transaction_id])).rows[0];
    expect(journal).toEqual({ actor_type: 'agent', actor_agent_id: a.id, credential_id: a.actor.credentialId });
    await assertConserved();
  });

  it('rolls an unaffordable redemption back completely and allows the same request after funding', async () => {
    const { offer } = await reward({ offer: { points_cost: '150' } });
    const key = randomUUID();
    rejected(await redeem(alice, a, offer, key));
    expect((await wallet(a.id)).available).toBe('100');
    expect((await catalog()).offers[0]).toMatchObject({ redeemed_quantity: '0', remaining_quantity: '5' });
    expect((await get(alice, '/api/v1/reward-redemptions')).json().items).toEqual([]);
    expect(await journalCount('PAY')).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int AS n FROM idempotency_requests WHERE idempotency_key=$1', [key])).rows[0].n).toBe(0);
    await fund(pools.runtime, admin.actor, a.id, '100');
    expect((await redeem(alice, a, offer, key)).statusCode).toBe(201);
    expect((await wallet(a.id)).available).toBe('50');
    await assertConserved();
  });

  it('rolls back the wallet, stock, quota and receipt when persisting the claim fails after payment', async () => {
    const { offer } = await reward();
    await pools.migration.query(`CREATE FUNCTION public.reject_test_reward_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'isolated reward persistence failure'; END $$;
      CREATE TRIGGER reject_test_reward_redemption AFTER INSERT ON reward_redemptions
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_reward_redemption()`);
    const key = randomUUID();
    try {
      const response = await redeem(alice, a, offer, key);
      expect(response.statusCode, response.body).toBe(500);
      expect((await wallet(a.id)).available).toBe('100');
      expect((await catalog()).offers[0]).toMatchObject({ redeemed_quantity: '0', remaining_quantity: '5' });
      expect(await catalog()).toMatchObject({ redeemed_count: '0', remaining_count: '5' });
      expect((await get(alice, '/api/v1/reward-redemptions')).json().items).toEqual([]);
      expect(await journalCount('PAY')).toBe(0);
      expect((await pools.runtime.query('SELECT count(*)::int AS n FROM idempotency_requests WHERE idempotency_key=$1', [key])).rows[0].n).toBe(0);
      await assertConserved();
    } finally {
      await pools.migration.query('DROP TRIGGER reject_test_reward_redemption ON reward_redemptions; DROP FUNCTION public.reject_test_reward_redemption()');
    }
    expect((await redeem(alice, a, offer, key)).statusCode).toBe(201);
    expect(await journalCount('PAY')).toBe(1);
  });

  it('sells the final unit only once to concurrent users and leaves the loser wallet unchanged', async () => {
    const { offer } = await reward({ pool: { total_quantity: '1', user_monthly_limit: '1' }, offer: { total_quantity: '1' } });
    const results = await Promise.all([redeem(a, a, offer), redeem(b, b, offer)]);
    expect(results.filter(result => result.statusCode === 201)).toHaveLength(1);
    rejected(results.find(result => result.statusCode !== 201)!);
    expect([(await wallet(a.id)).available, (await wallet(b.id)).available].sort()).toEqual(['100', '90']);
    expect((await catalog()).offers[0]).toMatchObject({ remaining_quantity: '0', redeemed_quantity: '1' });
    expect(await journalCount('PAY')).toBe(1);
    await assertConserved();
  });

  it('shares the monthly limit across sibling Agents and does not reset it after a refund', async () => {
    const { offer } = await reward({ pool: { user_monthly_limit: '1' } });
    const results = await Promise.all([redeem(a, a, offer), redeem(sibling, sibling, offer)]);
    expect(results.filter(result => result.statusCode === 201)).toHaveLength(1);
    rejected(results.find(result => result.statusCode !== 201)!);
    const order = results.find(result => result.statusCode === 201)!.json<Receipt>();
    expect(await catalog()).toMatchObject({ redeemed_count: '1', remaining_count: '0' });
    const cancelled = await post(alice, `/api/v1/reward-redemptions/${order.id}/cancel`, { version: order.version, reason: '尚未发放，取消兑换' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await catalog()).offers[0]).toMatchObject({ remaining_quantity: '5', redeemed_quantity: '0' });
    rejected(await redeem(sibling, sibling, offer));
    expect(await catalog()).toMatchObject({ redeemed_count: '1', remaining_count: '0' });
    expect((await redeem(b, b, offer)).statusCode).toBe(201);
    await assertConserved();
  });

  it('enforces permission, spending limits, ownership, CSRF, pause and credential revocation before new commitments', async () => {
    const { offer } = await reward();
    await pools.migration.query('UPDATE agent_policies SET can_redeem_api=false WHERE agent_id=$1', [a.id]);
    rejected(await redeem(a, a, offer));
    rejected(await redeem(alice, a, offer));
    await pools.migration.query('UPDATE agent_policies SET can_redeem_api=true,single_spend_limit=9 WHERE agent_id=$1', [a.id]);
    rejected(await redeem(a, a, offer));
    await pools.migration.query('UPDATE agent_policies SET single_spend_limit=1000,daily_spend_limit=9 WHERE agent_id=$1', [a.id]);
    rejected(await redeem(a, a, offer));
    await pools.migration.query('UPDATE agent_policies SET daily_spend_limit=1000 WHERE agent_id=$1', [a.id]);
    rejected(await redeem(bob, a, offer));
    rejected(await redeem(sibling, a, offer));
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/reward-redemptions', headers: { cookie: alice.cookie, origin, 'idempotency-key': randomUUID() }, payload: { offer_id: offer.id, agent_id: a.id, claimant_qq: '234567890' } });
    expect(noCsrf.statusCode).toBe(403);
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [a.id]);
    rejected(await redeem(alice, a, offer));
    rejected(await redeem(a, a, offer));
    await pools.migration.query("UPDATE agents SET status='active' WHERE id=$1", [a.id]);
    const first = await redeem(a, a, offer);
    expect(first.statusCode, first.body).toBe(201);
    await pools.migration.query('UPDATE agent_keys SET revoked_at=clock_timestamp() WHERE id=$1', [a.actor.credentialId]);
    expect((await redeem(a, a, offer)).statusCode).toBe(401);
    expect(await journalCount('PAY')).toBe(1);
    expect((await catalog()).offers[0].redeemed_quantity).toBe('1');
  });

  it('keeps claims private to the owner and paying Agent while providing scoped lists and admin lookup', async () => {
    const { offer } = await reward();
    const first = await redemption(offer), second = await redemption(offer, alice, sibling);
    for (const client of [bob, b, sibling]) rejected(await get(client, `/api/v1/reward-redemptions/${first.id}`));
    expect((await detail(first.id, a)).claim_code).toBe(first.claim_code);
    expect((await get(a, '/api/v1/reward-redemptions')).json().items.map((item: RewardRedemptionDto) => item.id)).toEqual([first.id]);
    expect((await get(bob, '/api/v1/reward-redemptions')).json().items).toEqual([]);
    const page = (await get(alice, '/api/v1/reward-redemptions?limit=1')).json();
    expect(page.items).toHaveLength(1); expect(page.next_cursor).toBeTruthy();
    const rest = (await get(alice, `/api/v1/reward-redemptions?limit=1&cursor=${page.next_cursor}`)).json();
    expect([page.items[0].id, rest.items[0].id].sort()).toEqual([first.id, second.id].sort());
    rejected(await get(alice, `/api/v1/admin/reward-redemptions?claim_code=${first.claim_code}`));
    rejected(await adminAction(first, 'process', alice));
    const found = await get(admin, `/api/v1/admin/reward-redemptions?claim_code=${first.claim_code}`);
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json().items).toHaveLength(1);
    expect(found.json().items[0]).toMatchObject({ id: first.id, user_id: alice.actor.userId, claimant_qq: '234567890' });
    expect(found.json().items[0].github_login).toBeTruthy();
  });

  it('refunds a pending order once to its original wallet and permits the owner to cancel for a paused Agent', async () => {
    const { offer } = await reward();
    const order = await redemption(offer);
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [a.id]);
    const key = randomUUID(), payload = { version: order.version, reason: '尚未支付，所有者取消' };
    const response = await post(alice, `/api/v1/reward-redemptions/${order.id}/cancel`, payload, key);
    expect(response.statusCode, response.body).toBe(200);
    const cancelled = response.json<Receipt>();
    expect(cancelled).toMatchObject({ status: 'cancelled', points_cost: '10', payment_transaction_id: order.payment_transaction_id });
    expect(cancelled.refund_transaction_id).toBeTruthy();
    expect(cancelled.cancelled_at).toBeTruthy();
    expect((await post(alice, `/api/v1/reward-redemptions/${order.id}/cancel`, payload, key)).json()).toEqual(cancelled);
    rejected(await post(alice, `/api/v1/reward-redemptions/${order.id}/cancel`, { ...payload, version: cancelled.version }));
    expect((await wallet(a.id)).available).toBe('100');
    expect((await wallet(sibling.id)).available).toBe('100');
    expect((await wallet(a.id)).dailyUsed).toBe('10');
    expect((await catalog()).offers[0].remaining_quantity).toBe('5');
    expect(await journalCount('REFUND')).toBe(1);
    const refund = (await pools.runtime.query('SELECT correction_of,payer_agent_id FROM journal_transactions WHERE id=$1', [cancelled.refund_transaction_id])).rows[0];
    expect(refund).toEqual({ correction_of: order.payment_transaction_id, payer_agent_id: a.id });
    await assertConserved();
  });

  it('requires processing before fulfillment, blocks user refunds during manual payment and records the operator result', async () => {
    const { offer } = await reward();
    const order = await redemption(offer);
    rejected(await adminAction(order, 'fulfill'));
    const started = await adminAction(order, 'process');
    expect(started.statusCode, started.body).toBe(200);
    const processing = started.json<Receipt>();
    expect(processing.status).toBe('processing');
    expect(processing.processed_by).toBe(admin.actor.userId);
    rejected(await post(alice, `/api/v1/reward-redemptions/${order.id}/cancel`, { version: processing.version, reason: '支付中不能退款' }));
    rejected(await adminAction(order, 'process'));
    for (const action of ['fulfill', 'cancel'] as const) {
      const response = await adminAction(processing, action, secondAdmin);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe('REWARD_PROCESSOR_CONFLICT');
    }
    expect(await detail(order.id)).toMatchObject({ status: 'processing', version: processing.version, processed_by: admin.actor.userId, refund_transaction_id: null });
    expect((await wallet(a.id)).available).toBe('90');
    expect((await catalog()).offers[0].remaining_quantity).toBe('4');
    expect(await journalCount('REFUND')).toBe(0);
    const key = randomUUID(), completed = await adminAction(processing, 'fulfill', admin, key);
    expect(completed.statusCode, completed.body).toBe(200);
    const fulfilled = completed.json<Receipt>();
    expect(fulfilled).toMatchObject({ status: 'fulfilled', fulfillment_reference: 'manual-test-reference-001', refund_transaction_id: null });
    expect(fulfilled.fulfilled_at).toBeTruthy();
    expect((await adminAction(processing, 'fulfill', admin, key)).json()).toEqual(fulfilled);
    rejected(await adminAction(fulfilled, 'fulfill'));
    rejected(await adminAction(fulfilled, 'cancel'));
    expect((await wallet(a.id)).available).toBe('90');
    expect(await journalCount('REFUND')).toBe(0);

    const refundable = await redemption(offer);
    const originalPayment = async () => (await pools.runtime.query(`SELECT row_to_json(j) AS journal,
      (SELECT jsonb_agg(e ORDER BY e.line_no) FROM journal_entries e WHERE e.transaction_id=j.id) AS entries
      FROM journal_transactions j WHERE j.id=$1`, [refundable.payment_transaction_id])).rows[0];
    const paymentBeforeCorrection = await originalPayment();
    const refundProcessing = (await adminAction(refundable, 'process')).json<Receipt>();
    const blockedRefund = await adminAction(refundProcessing, 'cancel', secondAdmin);
    expect(blockedRefund.statusCode, blockedRefund.body).toBe(409);
    expect(blockedRefund.json().error.code).toBe('REWARD_PROCESSOR_CONFLICT');
    expect((await detail(refundable.id)).status).toBe('processing');
    const confirmedUnpaid = await adminAction(refundProcessing, 'cancel');
    expect(confirmedUnpaid.statusCode, confirmedUnpaid.body).toBe(200);
    const corrected = confirmedUnpaid.json<Receipt>();
    expect(corrected).toMatchObject({ status: 'cancelled', processed_by: admin.actor.userId });
    // A14: correction appends an attributed journal linked to the original payment, without rewriting history.
    expect(await originalPayment()).toEqual(paymentBeforeCorrection);
    expect((await pools.runtime.query('SELECT kind,correction_of,actor_type,actor_user_id,reason FROM journal_transactions WHERE id=$1', [corrected.refund_transaction_id])).rows[0]).toEqual({
      kind: 'REFUND', correction_of: refundable.payment_transaction_id, actor_type: 'user', actor_user_id: admin.actor.userId, reason: '取消奖励兑换：已确认未线下支付，退还积分',
    });
    expect((await pools.runtime.query("SELECT actor_user_id,details FROM audit_events WHERE action='rewards.cancelled' AND target_id=$1", [refundable.id])).rows).toEqual([
      { actor_user_id: admin.actor.userId, details: { version: refundProcessing.version, reason: '已确认未线下支付，退还积分', previous_status: 'processing' } },
    ]);
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM ledger_accounts WHERE balance<0')).rows[0].count).toBe(0);
    expect((await wallet(a.id)).available).toBe('90');
    expect((await catalog()).offers[0].remaining_quantity).toBe('4');
    expect(await journalCount('REFUND')).toBe(1);
    await assertConserved();
  });

  it('assigns processing to one competing administrator and prevents another from refunding during fulfillment', async () => {
    const { offer } = await reward();
    const order = await redemption(offer);
    const starts = await Promise.all([adminAction(order, 'process'), adminAction(order, 'process', secondAdmin)]);
    expect(starts.filter(result => result.statusCode === 200)).toHaveLength(1);
    rejected(starts.find(result => result.statusCode !== 200)!);
    const processing = starts.find(result => result.statusCode === 200)!.json<Receipt>();
    const processor = processing.processed_by === admin.actor.userId ? admin : secondAdmin;
    const other = processor === admin ? secondAdmin : admin;
    const [fulfilled, deniedRefund] = await Promise.all([adminAction(processing, 'fulfill', processor), adminAction(processing, 'cancel', other)]);
    expect(fulfilled.statusCode, fulfilled.body).toBe(200);
    expect(deniedRefund.statusCode, deniedRefund.body).toBe(409);
    const current = await detail(order.id);
    expect(current).toMatchObject({ status: 'fulfilled', processed_by: processor.actor.userId, refund_transaction_id: null });
    expect((await wallet(a.id)).available).toBe('90');
    expect(await journalCount('REFUND')).toBe(0);
    expect((await catalog()).offers[0].remaining_quantity).toBe('4');
    await assertConserved();
  });

  it('serializes a user cancellation against the operator beginning manual payment', async () => {
    const { offer } = await reward();
    const order = await redemption(offer);
    const results = await Promise.all([
      post(alice, `/api/v1/reward-redemptions/${order.id}/cancel`, { version: order.version, reason: '取消待领取奖励' }),
      adminAction(order, 'process'),
    ]);
    expect(results.filter(result => result.statusCode === 200)).toHaveLength(1);
    rejected(results.find(result => result.statusCode !== 200)!);
    const current = await detail(order.id);
    expect(['processing', 'cancelled']).toContain(current.status);
    expect((await wallet(a.id)).available).toBe(current.status === 'cancelled' ? '100' : '90');
    expect(await journalCount('REFUND')).toBe(current.status === 'cancelled' ? 1 : 0);
    await assertConserved();
  });

  it('keeps issued claims across months, rejects old and future sales, and restores refunds only to their original pool', async () => {
    const { pool, offer } = await reward();
    const oldClaim = await redemption(offer), refundable = await redemption(offer);
    // Only the isolated test fixture's month changes; no host clock or development data is modified.
    await pools.migration.query('UPDATE reward_pools SET month=$2 WHERE id=$1', [pool.id, previousMonth]);
    const current = await reward({ offer: { title: '新月份奖励', total_quantity: '3' } });
    const futurePool = await configurePool({}, nextMonth), futureOffer = await createOffer(futurePool);
    rejected(await redeem(b, b, offer));
    rejected(await redeem(b, b, futureOffer));
    expect((await detail(oldClaim.id)).status).toBe('pending');
    const processing = (await adminAction(oldClaim, 'process')).json<Receipt>();
    expect((await adminAction(processing, 'fulfill')).statusCode).toBe(200);
    const refunded = await post(alice, `/api/v1/reward-redemptions/${refundable.id}/cancel`, { version: refundable.version, reason: '旧月仍未发放，取消并退原池库存' });
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect((await adminCatalog(previousMonth)).offers[0]).toMatchObject({ redeemed_quantity: '1', remaining_quantity: '4' });
    expect((await catalog()).offers[0]).toMatchObject({ id: current.offer.id, redeemed_quantity: '0', remaining_quantity: '3' });
    expect(await catalog()).toMatchObject({ redeemed_count: '0', remaining_count: '5' });
    expect((await redeem(alice, a, current.offer)).statusCode).toBe(201);
    await assertConserved();
  });

  it('retains the sold reward and QQ contact snapshot when future pool terms change', async () => {
    const { pool, offer } = await reward();
    const order = await redemption(offer);
    await configurePool({ version: (await adminCatalog()).pool!.version, contact_qq: '987654321', instructions: '新订单使用新的联系说明' });
    const old = await detail(order.id);
    expect(old).toMatchObject({ title: offer.title, description: offer.description, points_cost: '10', contact_qq: '123456789', instructions: pool.instructions, claimant_qq: '234567890' });
    const newOrder = await redemption(offer);
    expect(newOrder).toMatchObject({ contact_qq: '987654321', instructions: '新订单使用新的联系说明' });
    const editPrice = await write(admin, 'PATCH', `/api/v1/admin/reward-offers/${offer.id}`, { version: offer.version, status: 'active', add_quantity: '0', points_cost: '1', reason: '报价条件不能被偷偷重写' });
    expect(editPrice.statusCode).toBe(400);
    expect((await detail(order.id)).points_cost).toBe('10');
  });

  it('pauses new redemptions without cancelling existing obligations and requires explicit extra inventory', async () => {
    const { offer } = await reward({ offer: { total_quantity: '1' } });
    const order = await redemption(offer);
    rejected(await redeem(b, b, offer));
    const beforeAdding = (await adminCatalog()).offers[0]!;
    const add = await write(admin, 'PATCH', `/api/v1/admin/reward-offers/${offer.id}`, { version: beforeAdding.version, status: 'paused', add_quantity: '1', reason: '人工补库存并暂时下架' });
    expect(add.statusCode, add.body).toBe(200);
    rejected(await redeem(b, b, offer));
    const latest = (await adminCatalog()).offers[0]!;
    expect(latest).toMatchObject({ total_quantity: '2', redeemed_quantity: '1', remaining_quantity: '1', status: 'paused' });
    rejected(await write(admin, 'PATCH', `/api/v1/admin/reward-offers/${offer.id}`, { version: offer.version, status: 'active', add_quantity: '1', reason: '旧版本不得重复补货' }));
    expect((await write(admin, 'PATCH', `/api/v1/admin/reward-offers/${offer.id}`, { version: latest.version, status: 'active', add_quantity: '0', reason: '恢复报价' })).statusCode).toBe(200);
    await configurePool({ version: (await adminCatalog()).pool!.version, status: 'paused' });
    rejected(await redeem(b, b, offer));
    const processing = (await adminAction(order, 'process')).json<Receipt>();
    expect((await adminAction(processing, 'fulfill')).statusCode).toBe(200);
    expect((await detail(order.id)).status).toBe('fulfilled');
    await assertConserved();
  });
});
