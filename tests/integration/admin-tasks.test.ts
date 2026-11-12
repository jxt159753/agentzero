import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, TaskDto } from '../../packages/contracts/src/index.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { getWallet, reconcile } from '../../apps/api/src/modules/ledger/service.js';
import { agent, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), origin = 'http://localhost:5173';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Session, publisher: Session, worker: Session;
let payer: Awaited<ReturnType<typeof agent>>, receiver: Awaited<ReturnType<typeof agent>>;

async function session(role: 'member' | 'admin' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
const headers = (user: Session, key: string = randomUUID()) => ({ cookie: user.cookie, origin, 'x-csrf-token': user.csrf, 'idempotency-key': key });
const get = (user: Session, path: string) => app.inject({ url: '/api/v1' + path, headers: { cookie: user.cookie } });
const post = (user: Session, path: string, payload: Record<string, unknown>, key?: string) => app.inject({ method: 'POST', url: '/api/v1' + path, headers: headers(user, key), payload });
async function detail(id: string, user = admin) {
  const response = await get(user, `/tasks/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TaskDto>();
}
async function task(open = true) {
  const created = await post(publisher, '/tasks', { title: '管理测试合同', description: '须保留的原始任务说明', acceptance_criteria: '须保留的验收条件',
    reward_points: '100', deadline_at: new Date(Date.now() + 86400000).toISOString(), payer_agent_id: payer.id });
  expect(created.statusCode, created.body).toBe(201);
  const draft = created.json<TaskDto>();
  if (open) {
    const published = await post(publisher, `/tasks/${draft.id}/publish`, { version: draft.version });
    expect(published.statusCode, published.body).toBe(200);
  }
  return detail(draft.id);
}
async function accepted(owner = worker, target = receiver) {
  const current = await task();
  const response = await post(owner, `/tasks/${current.id}/accept`, { version: current.version, agent_id: target.id });
  expect(response.statusCode, response.body).toBe(200);
  return detail(current.id);
}
const wallet = (id: string) => withTransaction(pools.runtime, tx => getWallet(tx, id));
const conserved = async () => expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin,
    githubClientId: '', githubClientSecret: '', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); publisher = await session(); worker = await session();
  payer = await agent(pools.runtime, publisher.actor); receiver = await agent(pools.runtime, worker.actor);
  await fund(pools.runtime, admin.actor, payer.id, '1000');
});
afterAll(async () => { await app.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('administrator task management', () => {
  it('cancels another publisher open task with exactly one full refund and preserves the contract and audit', async () => {
    const current = await task(), key = randomUUID(), payload = { version: current.version, reason: '重复任务，关闭未接单供应' };
    expect(current.permissions).toMatchObject({ edit: false, admin_cancel: true, admin_intervene: false });
    expect((await post(worker, `/admin/tasks/${current.id}/cancel`, payload)).statusCode).toBe(403);
    expect((await post(admin, `/admin/tasks/${current.id}/cancel`, { ...payload, payment_points: '1' })).statusCode).toBe(400);
    const first = await post(admin, `/admin/tasks/${current.id}/cancel`, payload, key);
    expect(first.statusCode, first.body).toBe(200);
    expect((await post(admin, `/admin/tasks/${current.id}/cancel`, payload, key)).json()).toEqual(first.json());
    expect((await post(admin, `/admin/tasks/${current.id}/cancel`, { ...payload, reason: 'changed' }, key)).statusCode).toBe(409);
    const closed = await detail(current.id);
    expect(closed).toMatchObject({ status: 'cancelled', description: current.description, acceptance_criteria: current.acceptance_criteria,
      reward_points: current.reward_points, hold: { remaining: '0', captured_total: '0', released_total: '100' } });
    expect(await wallet(payer.id)).toMatchObject({ available: '1000', reserved: '0' });
    expect(closed.events?.find(event => event.kind === 'cancelled')).toMatchObject({ actor_user_id: admin.actor.userId, details: { reason: payload.reason, refund_points: '100' } });
    expect((await pools.runtime.query("SELECT count(*)::int AS n FROM audit_events WHERE action='task.cancelled' AND target_id=$1", [current.id])).rows[0].n).toBe(1);
    expect((await post(admin, `/admin/tasks/${current.id}/cancel`, { ...payload, version: closed.version })).statusCode).toBe(409);
    await conserved();
  });

  it.each(['in_progress', 'submitted', 'changes_requested'] as const)('intervenes in %s without rewriting or releasing the existing contract', async state => {
    let current = await accepted();
    if (state !== 'in_progress') {
      expect((await post(worker, `/tasks/${current.id}/deliveries`, { version: current.version, content: '现有文字交付' })).statusCode).toBe(201);
      current = await detail(current.id);
      if (state === 'changes_requested') {
        expect((await post(publisher, `/tasks/${current.id}/reviews`, { version: current.version, decision: 'request_changes', reason: '补齐约定成果', unmet_criteria: '原验收条件未完成' })).statusCode).toBe(200);
        current = await detail(current.id);
      }
    }
    expect(current.permissions).toMatchObject({ admin_cancel: false, admin_intervene: true, resolve: false });
    const payload = { version: current.version, reason: '管理员收到履约投诉，介入核查' }, key = randomUUID();
    const first = await post(admin, `/admin/tasks/${current.id}/intervene`, payload, key);
    expect(first.statusCode, first.body).toBe(200);
    expect((await post(admin, `/admin/tasks/${current.id}/intervene`, payload, key)).json()).toEqual(first.json());
    const frozen = await detail(current.id);
    expect(frozen).toMatchObject({ status: state, disputed: true, dispute_reason: payload.reason, description: current.description,
      acceptance_criteria: current.acceptance_criteria, reward_points: '100', hold: { remaining: '100' }, permissions: { resolve: true, admin_intervene: false } });
    expect(frozen.events?.filter(event => event.kind === 'admin_intervened')).toHaveLength(1);
    expect((await pools.runtime.query("SELECT count(*)::int AS n FROM audit_events WHERE action='task.admin_intervened' AND target_id=$1", [current.id])).rows[0].n).toBe(1);
    const ordinary = state === 'submitted'
      ? await post(publisher, `/tasks/${current.id}/reviews`, { version: frozen.version, decision: 'accept', reason: '普通验收' })
      : await post(worker, `/tasks/${current.id}/deliveries`, { version: frozen.version, content: '继续交付' });
    expect(ordinary.statusCode).toBe(409);
    const resolution = await post(admin, `/admin/tasks/${current.id}/resolve`, { version: frozen.version, outcome: 'cancelled', payment_points: '40', refund_points: '60', reason: '核对原合同后部分支付' });
    expect(resolution.statusCode, resolution.body).toBe(200);
    expect(await wallet(payer.id)).toMatchObject({ available: '960', reserved: '0' });
    expect(await wallet(receiver.id)).toMatchObject({ available: '40' });
    await conserved();
  });

  it('supersedes pending cancellation proposals, keeps state guards and rejects unauthorized contract edits', async () => {
    const draft = await task(false), open = await task();
    for (const action of ['cancel', 'intervene']) expect((await post(admin, `/admin/tasks/${draft.id}/${action}`, { version: draft.version, reason: '禁止草稿操作' })).statusCode).toBe(409);
    expect((await post(admin, `/admin/tasks/${open.id}/intervene`, { version: open.version, reason: '尚未接单' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/tasks/${open.id}`, headers: headers(admin), payload: { version: open.version, description: '不能冒充展示文案改合同' } })).statusCode).toBe(403);
    let current = await accepted();
    expect((await post(admin, `/admin/tasks/${current.id}/cancel`, { version: current.version, reason: '不能直接取消已接单任务' })).statusCode).toBe(409);
    expect((await post(publisher, `/tasks/${current.id}/cancellation-proposals`, { version: current.version, payment_points: '0', refund_points: '100', reason: '等待双方确认' })).statusCode).toBe(201);
    current = await detail(current.id);
    expect((await post(admin, `/admin/tasks/${current.id}/intervene`, { version: current.version, reason: '改由管理员核查' })).statusCode).toBe(200);
    expect((await detail(current.id)).cancellation_proposals?.[0]?.status).toBe('superseded');
    await conserved();
  });

  it('preserves the conflict restriction when the administrator owns a participating Agent', async () => {
    const own = await agent(pools.runtime, admin.actor), current = await accepted(admin, own);
    expect(current.permissions).toMatchObject({ admin_intervene: false, resolve: false });
    expect((await post(admin, `/admin/tasks/${current.id}/intervene`, { version: current.version, reason: '不能处理自己的承接任务' })).json().error.code).toBe('REVIEWER_CONFLICT');
    expect((await post(publisher, `/tasks/${current.id}/disputes`, { version: current.version, reason: '发布者发起争议' })).statusCode).toBe(200);
    const disputed = await detail(current.id);
    expect((await post(admin, `/admin/tasks/${current.id}/resolve`, { version: disputed.version, outcome: 'cancelled', payment_points: '0', refund_points: '100', reason: '不能裁定自身参与' })).json().error.code).toBe('REVIEWER_CONFLICT');
    expect(disputed.hold?.remaining).toBe('100');
  });

  it('serializes acceptance against administrator cancellation without double-refunding or changing an accepted contract', async () => {
    const current = await task();
    const outcomes = await Promise.all([
      post(worker, `/tasks/${current.id}/accept`, { version: current.version, agent_id: receiver.id }),
      post(admin, `/admin/tasks/${current.id}/cancel`, { version: current.version, reason: '与接单竞争关闭' }),
    ]);
    expect(outcomes.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const final = await detail(current.id);
    expect(['cancelled', 'in_progress']).toContain(final.status);
    expect(await wallet(payer.id)).toMatchObject(final.status === 'cancelled' ? { available: '1000', reserved: '0' } : { available: '900', reserved: '100' });
    await conserved();
  });

  it('lists drafts and disputed tasks for administrators with pagination and server-side filters', async () => {
    const draft = await task(false), open = await task(), busy = await accepted();
    expect((await post(admin, `/admin/tasks/${busy.id}/intervene`, { version: busy.version, reason: '管理列表筛选' })).statusCode).toBe(200);
    expect((await get(worker, '/admin/tasks')).statusCode).toBe(403);
    const all = (await get(admin, '/admin/tasks')).json();
    expect(all.items.map((item: TaskDto) => item.id).sort()).toEqual([draft.id, open.id, busy.id].sort());
    const filtered = (await get(admin, '/admin/tasks?disputed=true&status=in_progress')).json();
    expect(filtered.items.map((item: TaskDto) => item.id)).toEqual([busy.id]);
    const first = (await get(admin, '/admin/tasks?limit=1')).json();
    expect(first.items).toHaveLength(1); expect(first.next_cursor).toBeTruthy();
    const next = (await get(admin, '/admin/tasks?limit=1&cursor=' + encodeURIComponent(first.next_cursor))).json();
    expect(next.items[0].id).not.toBe(first.items[0].id);
  });
});
