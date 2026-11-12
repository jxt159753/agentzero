import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../packages/contracts/src/index.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { reconcile } from '../../apps/api/src/modules/ledger/service.js';
import { createAgentZeroServer } from '../../packages/agentzero/src/server.js';
import { agent, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

// testPools enforces an explicitly named test database, separate from development.
// MCP, loopback HTTP, Bearer authentication and PostgreSQL are real. Only GitHub reads are mocked.
const pools = testPools();
const origin = 'http://localhost:5173';
const sha = 'd'.repeat(40);
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
let app: Awaited<ReturnType<typeof buildApp>>, apiUrl: string;
let publisher: Session, worker: Session, reviewer: Session;
let payer: Awaited<ReturnType<typeof agent>>, recipient: Awaited<ReturnType<typeof agent>>;
let repositoryId: string, workerGithubId: string, credential: { id: string; secret: string };
const connected: { client: Client; server: ReturnType<typeof createAgentZeroServer> }[] = [];

async function session(role: 'admin'|'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
async function write(s: Session, path: string, body: Record<string, unknown>, expectedStatus = 200) {
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: s.cookie, origin, 'x-csrf-token': s.csrf, 'idempotency-key': randomUUID() }, body: JSON.stringify(body),
  });
  const result = await response.json() as Record<string, any>;
  expect(response.status, JSON.stringify(result)).toBe(expectedStatus);
  return result;
}
async function connect(secret = credential.secret) {
  const server = createAgentZeroServer({ apiUrl, agentKey: secret });
  const client = new Client({ name: 'agentzero-postgres-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  connected.push({ client, server });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return client;
}
async function call(client: Client, name: string, arguments_: Record<string, unknown> = {}) {
  const result = await client.callTool({ name: `agentzero_${name}`, arguments: arguments_ });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent as Record<string, any>;
}
async function openTask() {
  const created = await write(publisher, '/tasks', {
    title: 'MCP真实接口任务', description: '通过客户端插件交付修复', repository_id: repositoryId,
    acceptance_criteria: 'CI通过并由验收人核对', required_checks: ['CI'], reward_points: '100',
    deadline_at: new Date(Date.now() + 86400_000).toISOString(), reviewer_user_id: reviewer.actor.userId, payer_agent_id: payer.id,
  }, 201);
  return write(publisher, `/tasks/${created.id}/publish`, { version: created.version });
}

beforeAll(async () => {
  app = await buildApp({
    pool: pools.runtime,
    config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test-client', githubClientSecret: 'test-secret', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 },
    repositoryGithub: {
      async getInstallation({ installationId }) { return { installationId, accountLogin: 'mcp-fixture', status: 'active' }; },
      async getRepository({ owner, name }) { return { repositoryId: '882001', owner, name, fullName: `${owner}/${name}`, isPrivate: false }; },
      async getPullRequest({ number }) { return { repositoryId: '882001', number, headSha: sha, authorGithubId: workerGithubId, merged: true, url: `https://github.com/mcp-fixture/work/pull/${number}`, checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }], fetchedAt: new Date().toISOString() }; },
    },
  });
  apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  const admin = await session('admin');
  publisher = await session(); worker = await session(); reviewer = await session();
  payer = await agent(pools.runtime, publisher.actor); recipient = await agent(pools.runtime, worker.actor);
  await fund(pools.runtime, admin.actor, payer.id, '200');
  workerGithubId = (await pools.runtime.query('SELECT github_user_id::text AS id FROM users WHERE id=$1', [worker.actor.userId])).rows[0].id;
  credential = await write(worker, `/agents/${recipient.id}/keys`, { label: 'isolated MCP test' }, 201) as { id: string; secret: string };
  repositoryId = randomUUID();
  await pools.migration.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES('8820','mcp-fixture','active')");
  await pools.migration.query("INSERT INTO repositories(id,github_id,installation_id,owner,name,full_name,is_private,status) VALUES($1,'882001','8820','mcp-fixture','work','mcp-fixture/work',false,'approved')", [repositoryId]);
});
afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('AgentZero MCP with real HTTP and PostgreSQL', () => {
  it('submits text-only work through MCP and pays once after the publisher accepts it', async () => {
    const draft = await write(publisher, '/tasks', {
      title: '整理产品反馈', description: '总结用户建议并给出分类', reward_points: '100',
      deadline_at: new Date(Date.now() + 86400_000).toISOString(), payer_agent_id: payer.id,
    }, 201);
    const task = await write(publisher, `/tasks/${draft.id}/publish`, { version: draft.version });
    const client = await connect();
    const contract = await call(client, 'get_task', { task_id: task.id });
    expect(contract).toMatchObject({ repository_id: null, repository: null, reviewer_user_id: publisher.actor.userId, required_checks: [] });
    const accepted = await call(client, 'accept_task', { task_id: task.id, version: contract.version, idempotency_key: randomUUID() });
    const input = { task_id: task.id, version: accepted.version, content: '反馈分为发布、交付、验收三类。\n每类已整理用户建议。', idempotency_key: randomUUID() };
    const submitted = await call(client, 'submit_delivery', input);
    expect(submitted.status).toBe('submitted');
    expect(await call(client, 'submit_delivery', input)).toEqual(submitted);
    expect((await call(client, 'get_task', { task_id: task.id })).deliveries).toEqual([
      expect.objectContaining({ content: input.content, pr_number: null, head_sha: null, pr_url: null }),
    ]);
    expect(await call(client, 'wallet')).toMatchObject({ available: '0' });
    const review = { version: submitted.version, decision: 'accept', reason: '已核对文字成果，符合说明' };
    await write(publisher, `/tasks/${task.id}/reviews`, review);
    await write(publisher, `/tasks/${task.id}/reviews`, review);
    expect((await call(client, 'get_task', { task_id: task.id })).status).toBe('settled');
    expect(await call(client, 'wallet')).toMatchObject({ available: '100', reserved: '0' });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM journal_transactions WHERE business_key=$1', [`hold:${task.hold_id}:finalize`])).rows[0].n).toBe(1);
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('redeems a private manual reward through MCP and refunds the original wallet exactly once', async () => {
    const administrator = await session('admin');
    await fund(pools.runtime, administrator.actor, recipient.id, '40');
    const month = (await pools.runtime.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-01') AS month")).rows[0].month;
    const configured = await app.inject({ method: 'PUT', url: `/api/v1/admin/reward-pools/${month}`,
      headers: { cookie: administrator.cookie, origin, 'x-csrf-token': administrator.csrf, 'idempotency-key': randomUUID() },
      payload: { version: '0', total_quantity: '1', user_monthly_limit: '1', contact_qq: '123456789', instructions: '独立测试库的人工奖励，通过QQ核对领取。', status: 'active', reason: 'MCP奖励验收' } });
    expect(configured.statusCode, configured.body).toBe(201);
    const offer = await write(administrator, '/admin/reward-offers', { pool_id: configured.json().id, title: 'MCP人工奖励', description: '测试奖励凭证，不执行真实支付', points_cost: '20', total_quantity: '1', reason: 'MCP报价验收' }, 201);
    const client = await connect();
    const catalog = await call(client, 'reward_catalog');
    expect(catalog.offers).toEqual([expect.objectContaining({ id: offer.id, remaining_quantity: '1' })]);
    const input = { offer_id: offer.id, claimant_qq: '234567890', idempotency_key: randomUUID() };
    const order = await call(client, 'redeem_reward', input);
    expect(await call(client, 'redeem_reward', input)).toEqual(order);
    expect(order).toMatchObject({ agent_id: recipient.id, user_id: worker.actor.userId, status: 'pending', claimant_qq: input.claimant_qq });
    expect((await call(client, 'list_reward_redemptions')).items).toEqual([expect.objectContaining({ id: order.id })]);
    expect(await call(client, 'get_reward_redemption', { redemption_id: order.id })).toMatchObject({ claim_code: order.claim_code });
    expect(await call(client, 'wallet')).toMatchObject({ available: '20' });
    const cancelledInput = { redemption_id: order.id, version: order.version, reason: '尚未领取，取消测试奖励', idempotency_key: randomUUID() };
    const cancelled = await call(client, 'cancel_reward_redemption', cancelledInput);
    expect(cancelled.status).toBe('cancelled');
    expect(await call(client, 'cancel_reward_redemption', cancelledInput)).toEqual(cancelled);
    expect(await call(client, 'wallet')).toMatchObject({ available: '40' });
    expect(await call(client, 'reward_catalog')).toMatchObject({ redeemed_count: '1', remaining_count: '0' });
    expect((await pools.runtime.query("SELECT kind,count(*)::int n FROM journal_transactions WHERE kind IN ('PAY','REFUND') GROUP BY kind ORDER BY kind")).rows).toEqual([{ kind: 'PAY', n: 1 }, { kind: 'REFUND', n: 1 }]);
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('connects two Agent clients, exchanges messages and settles an explicitly confirmed 70/30 agreement once', async () => {
    const collaborator = await session();
    const collaboratorAgent = await agent(pools.runtime, collaborator.actor);
    const collaboratorKey = await write(collaborator, `/agents/${collaboratorAgent.id}/keys`, { label: 'second isolated MCP client' }, 201);
    const publisherKey = await write(publisher, `/agents/${payer.id}/keys`, { label: 'publisher MCP client' }, 201);
    const leadClient = await connect(), partnerClient = await connect(collaboratorKey.secret), publisherClient = await connect(publisherKey.secret);
    let task = await openTask();
    task = await call(leadClient, 'accept_task', { task_id: task.id, version: task.version, idempotency_key: randomUUID() });
    const conversation = await call(leadClient, 'create_conversation', { recipient_agent_id: collaboratorAgent.id, idempotency_key: randomUUID() });
    const messageInput = { conversation_id: conversation.id, body: '邀请测试协作；聊天本身不确认协议。', idempotency_key: randomUUID() };
    const message = await call(leadClient, 'send_message', messageInput);
    expect(await call(leadClient, 'send_message', messageInput)).toEqual(message);
    const inbox = await call(partnerClient, 'poll_messages', { after: '0' });
    expect(inbox.items).toEqual([expect.objectContaining({ body: messageInput.body, sender_agent_id: recipient.id })]);
    expect((await call(partnerClient, 'poll_messages', { after: inbox.next_cursor })).items).toEqual([]);
    const agreedDeadline = new Date(Date.now() + 2 * 86400_000).toISOString();
    await call(leadClient, 'propose_agreement', { task_id: task.id, version: task.version, idempotency_key: randomUUID(), deadline_at: agreedDeadline,
      members: [{ agent_id: recipient.id, role: '主开发', deliverable: '已合并的 PR', amount_points: '70' }, { agent_id: collaboratorAgent.id, role: '测试', deliverable: '测试记录', amount_points: '30' }],
    });
    expect((await call(partnerClient, 'list_tasks', { mine: true })).items).toEqual([expect.objectContaining({ id: task.id })]);
    task = await call(partnerClient, 'get_task', { task_id: task.id });
    const agreement = task.agreements.find((item: { status: string }) => item.status === 'pending');
    expect(agreement).toBeDefined();
    expect(task.active_agreement_id).toBeNull();
    await call(publisherClient, 'respond_agreement', { task_id: task.id, version: task.version, agreement_id: agreement.id, decision: 'accept', as_publisher: true, idempotency_key: randomUUID() });
    task = await call(partnerClient, 'get_task', { task_id: task.id });
    await call(partnerClient, 'send_message', { conversation_id: conversation.id, body: '同意', idempotency_key: randomUUID() });
    expect((await call(partnerClient, 'get_task', { task_id: task.id })).active_agreement_id).toBeNull();
    const accept = { task_id: task.id, version: task.version, agreement_id: agreement.id, decision: 'accept', idempotency_key: randomUUID() };
    const accepted = await call(partnerClient, 'respond_agreement', accept);
    expect(await call(partnerClient, 'respond_agreement', accept)).toEqual(accepted);
    task = await call(partnerClient, 'get_task', { task_id: task.id });
    expect(task.active_agreement_id).toBe(agreement.id);
    await call(partnerClient, 'submit_contribution', { task_id: task.id, version: task.version, kind: 'test', body: 'CI及协作边界验证完成', idempotency_key: randomUUID() });
    await call(partnerClient, 'send_message', { task_id: task.id, body: '测试记录已登记，等待主PR送审。', idempotency_key: randomUUID() });
    expect((await call(leadClient, 'read_messages', { task_id: task.id })).items).toEqual([expect.objectContaining({ sender_agent_id: collaboratorAgent.id })]);
    task = await call(leadClient, 'get_task', { task_id: task.id });
    const submitted = await call(leadClient, 'submit_delivery', { task_id: task.id, version: task.version, pr_number: 20, head_sha: sha, idempotency_key: randomUUID() });
    await write(reviewer, `/tasks/${task.id}/reviews`, { version: submitted.version, decision: 'accept', reason: '核对主PR和协作测试记录后通过' });
    await write(reviewer, `/tasks/${task.id}/reviews`, { version: submitted.version, decision: 'accept', reason: '重复验收不重复分账' });
    expect(await call(leadClient, 'wallet')).toMatchObject({ available: '70', reserved: '0' });
    expect(await call(partnerClient, 'wallet')).toMatchObject({ available: '30', reserved: '0' });
    expect((await pools.runtime.query('SELECT status,captured_total,released_total FROM credit_holds WHERE id=$1', [task.hold_id])).rows[0]).toEqual({ status: 'closed', captured_total: '100', released_total: '0' });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM journal_transactions WHERE business_key=$1', [`hold:${task.hold_id}:finalize`])).rows[0].n).toBe(1);
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('completes Agent identity, task acceptance, delivery, receipt and wallet flow through MCP', async () => {
    const task = await openTask(), client = await connect();
    expect((await call(client, 'identity')).actor).toEqual({ type: 'agent', agentId: recipient.id });
    expect(await call(client, 'wallet')).toMatchObject({ available: '0', reserved: '0' });
    expect((await call(client, 'repositories')).items).toEqual([expect.objectContaining({ id: repositoryId })]);
    expect((await call(client, 'list_tasks', { status: 'open' })).items).toEqual([expect.objectContaining({ id: task.id })]);
    const contract = await call(client, 'get_task', { task_id: task.id });
    const acceptInput = { task_id: task.id, version: contract.version, idempotency_key: randomUUID() };
    const accepted = await call(client, 'accept_task', acceptInput);
    expect(accepted).toMatchObject({ status: 'in_progress', assignee_agent_id: recipient.id });
    expect(await call(client, 'accept_task', acceptInput)).toEqual(accepted);
    expect((await call(client, 'list_tasks', { mine: true })).items).toEqual([expect.objectContaining({ id: task.id })]);
    const deliveryInput = { task_id: task.id, version: accepted.version, pr_number: 19, head_sha: sha, idempotency_key: randomUUID() };
    const submitted = await call(client, 'submit_delivery', deliveryInput);
    expect(submitted.status).toBe('submitted');
    expect(await call(client, 'submit_delivery', deliveryInput)).toEqual(submitted);
    expect(await call(client, 'get_operation', { operation_id: submitted.operation_id })).toMatchObject({ resource_type: 'task', resource_id: task.id, result: { status: 'submitted' } });
    expect((await pools.runtime.query('SELECT count(*)::int AS n FROM task_deliveries WHERE task_id=$1', [task.id])).rows[0].n).toBe(1);
    await write(reviewer, `/tasks/${task.id}/reviews`, { version: submitted.version, decision: 'accept', reason: '独立验收人核对通过' });
    expect(await call(client, 'wallet')).toMatchObject({ available: '100', reserved: '0' });
    expect((await call(client, 'get_task', { task_id: task.id })).status).toBe('settled');
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('enforces backend task permission and operation ownership through the MCP tools', async () => {
    const task = await openTask(), client = await connect();
    await pools.runtime.query('UPDATE agent_policies SET can_accept_task=false WHERE agent_id=$1', [recipient.id]);
    const denied = await client.callTool({ name: 'agentzero_accept_task', arguments: { task_id: task.id, version: task.version, idempotency_key: randomUUID() } });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({ error: { code: 'ACCESS_DENIED', status: 403, uncertain: false } });
    const foreignReceipt = await client.callTool({ name: 'agentzero_get_operation', arguments: { operation_id: task.operation_id } });
    expect(foreignReceipt.isError).toBe(true);
    expect(foreignReceipt.structuredContent).toMatchObject({ error: { code: 'ACCESS_DENIED', status: 403 } });
    expect((await pools.runtime.query('SELECT status,assignee_agent_id FROM tasks WHERE id=$1', [task.id])).rows[0]).toEqual({ status: 'open', assignee_agent_id: null });
  });

  it('rejects a paused Agent and a revoked key without using earlier successful identity data', async () => {
    const client = await connect();
    await call(client, 'identity');
    await pools.runtime.query("UPDATE agents SET status='paused' WHERE id=$1", [recipient.id]);
    const paused = await client.callTool({ name: 'agentzero_wallet', arguments: {} });
    expect(paused.structuredContent).toMatchObject({ error: { code: 'AGENT_PAUSED', status: 403 } });
    await pools.runtime.query("UPDATE agents SET status='active' WHERE id=$1", [recipient.id]);
    await write(worker, `/agents/${recipient.id}/keys/${credential.id}/revoke`, {});
    const revoked = await client.callTool({ name: 'agentzero_identity', arguments: {} });
    expect(revoked.structuredContent).toMatchObject({ error: { code: 'CREDENTIAL_REVOKED', status: 401 } });
    expect(JSON.stringify(revoked)).not.toContain(credential.secret);
  });
});
