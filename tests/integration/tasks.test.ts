import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../packages/database/src/index.js';
import type { Actor } from '../../packages/contracts/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import type { GitHubRepositoryProvider, PullRequestEvidence } from '../../apps/api/src/modules/github/provider.js';
import { processTaskDeadlines } from '../../apps/api/src/modules/tasks/maintenance.js';
import { getWallet, issue, reconcile, setIssuanceLimit } from '../../apps/api/src/modules/ledger/service.js';
import { agent, context, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

// PostgreSQL, transactions, authentication, CSRF and all task routes are real.
// Only GitHub's remote repository/PR evidence is supplied by the injected provider.
const pools = testPools();
const origin = 'http://localhost:5173';
const sha = 'a'.repeat(40);
const repoGithubId = '880001';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string; githubId: string };
type TestAgent = Awaited<ReturnType<typeof agent>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Session, publisher: Session, worker: Session, reviewer: Session, outsider: Session;
let payer: TestAgent, recipient: TestAgent, competitor: TestAgent;
let repositoryId: string;
let evidence: PullRequestEvidence;
let evidenceReads = 0;

const repositoryGithub: GitHubRepositoryProvider = {
  async getInstallation({ installationId }) { return { installationId, accountLogin: 'fixture-org', status: 'active' }; },
  async getRepository({ owner, name }) { return { repositoryId: repoGithubId, owner, name, fullName: `${owner}/${name}`, isPrivate: false }; },
  async getPullRequest(input: { number: number }) {
    evidenceReads++;
    return { ...evidence, number: input.number, checks: evidence.checks.map(check => ({ ...check })) };
  },
};

async function session(role: 'admin' | 'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  const row = (await pools.runtime.query('SELECT github_user_id::text AS github_id FROM users WHERE id=$1', [actor.userId])).rows[0];
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf, githubId: row.github_id };
}
const headers = (s: Session, key: string = randomUUID()) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf, 'idempotency-key': key });
const wallet = (id: string) => withTransaction(pools.runtime, tx => getWallet(tx, id));
const request = (s: Session, method: 'POST' | 'PATCH' | 'DELETE', url: string, payload: Record<string, unknown>, key: string = randomUUID()) => app.inject({ method, url, headers: headers(s, key), payload });
const expectRejected = (response: { statusCode: number; body: string }) => expect([400, 403, 404, 409], response.body).toContain(response.statusCode);

async function detail(id: string, s = publisher) {
  const response = await app.inject({ url: `/api/v1/tasks/${id}`, headers: { cookie: s.cookie } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function createTask(overrides: Record<string, unknown> = {}, s = publisher) {
  const response = await request(s, 'POST', '/api/v1/tasks', {
    title: '补全任务集成测试', description: '交付通过测试的修复 PR', repository_id: repositoryId,
    acceptance_criteria: '实现测试并通过 CI', required_checks: ['CI'], reward_points: '100',
    deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(), reviewer_user_id: reviewer.actor.userId,
    payer_agent_id: payer.id, ...overrides,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}
async function action(id: string, name: string, s: Session, extra: Record<string, unknown> = {}, key?: string) {
  const task = await detail(id, s);
  return request(s, 'POST', `/api/v1/tasks/${id}/${name}`, { version: task.version, ...extra }, key);
}
async function openTask(overrides: Record<string, unknown> = {}, s = publisher) {
  const task = await createTask(overrides, s);
  const response = await action(task.id, 'publish', s);
  expect(response.statusCode, response.body).toBe(200);
  return detail(task.id, s);
}
async function acceptedTask(overrides: Record<string, unknown> = {}) {
  const task = await openTask(overrides);
  const response = await action(task.id, 'accept', worker, { agent_id: recipient.id });
  expect(response.statusCode, response.body).toBe(200);
  return detail(task.id);
}
async function submittedTask(number = 17) {
  const task = await acceptedTask();
  const response = await action(task.id, 'deliveries', worker, { pr_number: number, head_sha: sha });
  expect(response.statusCode, response.body).toBe(201);
  return detail(task.id);
}
async function assertConserved() {
  expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
}
async function finalJournalCount(taskId: string) {
  const row = (await pools.runtime.query("SELECT count(*)::int AS n FROM journal_transactions j JOIN tasks t ON j.business_key='hold:'||t.hold_id||':finalize' WHERE t.id=$1", [taskId])).rows[0];
  return row.n as number;
}

beforeAll(async () => {
  app = await buildApp({
    pool: pools.runtime, repositoryGithub,
    config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test-client', githubClientSecret: 'test-secret', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 3000 },
  });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); publisher = await session(); worker = await session(); reviewer = await session(); outsider = await session();
  payer = await agent(pools.runtime, publisher.actor);
  recipient = await agent(pools.runtime, worker.actor);
  competitor = await agent(pools.runtime, outsider.actor);
  await fund(pools.runtime, admin.actor, payer.id, '1000');
  repositoryId = randomUUID();
  await pools.migration.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES('8800','fixture-org','active')");
  await pools.migration.query("INSERT INTO repositories(id,github_id,installation_id,owner,name,full_name,is_private,status) VALUES($1,$2,'8800','fixture-org','work','fixture-org/work',false,'approved')", [repositoryId, repoGithubId]);
  evidence = { repositoryId: repoGithubId, number: 17, headSha: sha, authorGithubId: worker.githubId, merged: true, url: 'https://github.com/fixture-org/work/pull/17', checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }], fetchedAt: new Date().toISOString() };
  evidenceReads = 0;
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('phase 2 task contracts with real PostgreSQL', () => {
  it('drafts keep wallets untouched; publish and pre-acceptance edits adjust one hold atomically', async () => {
    const task = await createTask();
    expect(task.status).toBe('draft');
    expect(await wallet(payer.id)).toMatchObject({ available: '1000', reserved: '0' });
    const key = randomUUID(), payload = { version: task.version };
    const first = await request(publisher, 'POST', `/api/v1/tasks/${task.id}/publish`, payload, key);
    const replay = await request(publisher, 'POST', `/api/v1/tasks/${task.id}/publish`, payload, key);
    expect(first.statusCode, first.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(await wallet(payer.id)).toMatchObject({ available: '900', reserved: '100' });
    let current = await detail(task.id);
    const increased = await request(publisher, 'PATCH', `/api/v1/tasks/${task.id}`, { version: current.version, reward_points: '150' });
    expect(increased.statusCode, increased.body).toBe(200);
    expect(await wallet(payer.id)).toMatchObject({ available: '850', reserved: '150' });
    const stale = await request(publisher, 'PATCH', `/api/v1/tasks/${task.id}`, { version: current.version, reward_points: '1' });
    expect(stale.statusCode).toBe(409);
    current = await detail(task.id);
    const decreased = await request(publisher, 'PATCH', `/api/v1/tasks/${task.id}`, { version: current.version, reward_points: '80' });
    expect(decreased.statusCode, decreased.body).toBe(200);
    expect(await wallet(payer.id)).toMatchObject({ available: '920', reserved: '80', dailyUsed: '80' });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM credit_holds WHERE payer_agent_id=$1', [payer.id])).rows[0].n).toBe(1);
    await assertConserved();
  });

  it('publication enforces funds, authorization, budget and repository admission without partial contracts', async () => {
    const task = await createTask({ reward_points: '1001' });
    const overBudget = await action(task.id, 'publish', publisher);
    expect(overBudget.statusCode).toBe(409);
    expect((await detail(task.id)).status).toBe('draft');
    expect(await wallet(payer.id)).toMatchObject({ available: '1000', reserved: '0' });
    await pools.runtime.query('UPDATE agent_policies SET single_spend_limit=2000,daily_spend_limit=2000 WHERE agent_id=$1', [payer.id]);
    const overBalance = await action(task.id, 'publish', publisher);
    expect(overBalance.json().error.code).toBe('INSUFFICIENT_FUNDS');
    expect((await detail(task.id)).hold_id).toBeNull();
    const valid = await createTask();
    await pools.runtime.query('UPDATE agent_policies SET can_accept_task=false WHERE agent_id=$1', [payer.id]);
    expect((await action(valid.id, 'publish', publisher)).statusCode).toBe(403);
    await pools.runtime.query('UPDATE agent_policies SET can_accept_task=true WHERE agent_id=$1', [payer.id]);
    await pools.migration.query("UPDATE repositories SET status='disabled' WHERE id=$1", [repositoryId]);
    expectRejected(await action(valid.id, 'publish', publisher));
    expect(await wallet(payer.id)).toMatchObject({ available: '1000', reserved: '0' });
    await assertConserved();
  });

  it('platform rewards reserve the issued pool and cannot be created by a member', async () => {
    const denied = await request(publisher, 'POST', '/api/v1/tasks', {
      title: 'Unauthorised platform task', description: 'test', repository_id: repositoryId,
      acceptance_criteria: 'test', required_checks: ['CI'], reward_points: '100', deadline_at: new Date(Date.now() + 86400_000).toISOString(), reviewer_user_id: reviewer.actor.userId, payer_agent_id: null,
    });
    expect(denied.statusCode).toBe(403);
    await withTransaction(pools.runtime, async tx => {
      const month = (await tx.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month")).rows[0].month as string;
      await setIssuanceLimit(tx, context(admin.actor), { month, limitPoints: '2000', reason: 'isolated platform task budget' });
      await issue(tx, context(admin.actor), { amount: '100', businessKey: `platform-fixture:${randomUUID()}`, reason: 'isolated platform reward' });
    });
    const task = await openTask({ payer_agent_id: null }, admin);
    expect((await pools.runtime.query("SELECT balance FROM ledger_accounts WHERE system_key='REWARD_RESERVED'")).rows[0].balance).toBe('100');
    const cancelled = await action(task.id, 'cancel', admin, { reason: 'not needed' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await pools.runtime.query("SELECT balance FROM ledger_accounts WHERE system_key='REWARD_POOL'")).rows[0].balance).toBe('100');
    expect(await wallet(payer.id)).toMatchObject({ available: '1000', reserved: '0' });
    await assertConserved();
  });

  it('private drafts and mutations are owner-scoped; only one concurrent Agent can accept', async () => {
    const draft = await createTask();
    expectRejected(await app.inject({ url: `/api/v1/tasks/${draft.id}`, headers: { cookie: outsider.cookie } }));
    expectRejected(await request(outsider, 'PATCH', `/api/v1/tasks/${draft.id}`, { version: draft.version, title: 'intrusion' }));
    const listed = await app.inject({ url: '/api/v1/tasks', headers: { cookie: outsider.cookie } });
    expect(listed.json().items.map((task: { id: string }) => task.id)).not.toContain(draft.id);
    const task = await openTask();
    await pools.runtime.query('UPDATE agent_policies SET can_accept_task=false WHERE agent_id=$1', [recipient.id]);
    expect((await action(task.id, 'accept', worker, { agent_id: recipient.id })).statusCode).toBe(403);
    await pools.runtime.query('UPDATE agent_policies SET can_accept_task=true WHERE agent_id=$1', [recipient.id]);
    expect((await action(task.id, 'accept', worker, { agent_id: competitor.id })).statusCode).toBe(403);
    const results = await Promise.all([
      request(worker, 'POST', `/api/v1/tasks/${task.id}/accept`, { version: task.version, agent_id: recipient.id }),
      request(outsider, 'POST', `/api/v1/tasks/${task.id}/accept`, { version: task.version, agent_id: competitor.id }),
    ]);
    expect(results.filter(response => response.statusCode === 200)).toHaveLength(1);
    expect(results.filter(response => response.statusCode === 409)).toHaveLength(1);
    expect((await detail(task.id)).status).toBe('in_progress');
    expect((await request(publisher, 'PATCH', `/api/v1/tasks/${task.id}`, { version: (await detail(task.id)).version, reward_points: '1' })).statusCode).toBe(409);
    expect(await wallet(payer.id)).toMatchObject({ available: '900', reserved: '100' });
  });

  it('a designated reviewer cannot accept through one of their own Agents', async () => {
    const reviewerAgent = await agent(pools.runtime, reviewer.actor);
    const task = await openTask();
    const denied = await action(task.id, 'accept', reviewer, { agent_id: reviewerAgent.id });
    expectRejected(denied);
    expect((await detail(task.id)).status).toBe('open');
    expect(await wallet(payer.id)).toMatchObject({ available: '900', reserved: '100' });
  });

  it('Agent credentials accept only for their bound identity; revocation blocks new work and the owner can fulfil a paused contract', async () => {
    const task = await openTask();
    const created = await request(worker, 'POST', `/api/v1/agents/${recipient.id}/keys`, { label: 'task integration worker' });
    expect(created.statusCode, created.body).toBe(201);
    const credential = created.json();
    const bearer = () => ({ authorization: `Bearer ${credential.secret}`, 'idempotency-key': randomUUID() });
    const denied = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.id}/accept`, headers: bearer(), payload: { version: task.version, agent_id: competitor.id } });
    expect(denied.statusCode).toBe(403);
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.id}/accept`, headers: bearer(), payload: { version: task.version, agent_id: recipient.id } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const revocation = await request(worker, 'POST', `/api/v1/agents/${recipient.id}/keys/${credential.id}/revoke`, {});
    expect(revocation.statusCode, revocation.body).toBe(200);
    const current = await detail(task.id);
    const revoked = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.id}/deliveries`, headers: bearer(), payload: { version: current.version, pr_number: 17, head_sha: sha } });
    expect(revoked.statusCode).toBe(401);
    expect((await detail(task.id)).status).toBe('in_progress');
    await pools.runtime.query("UPDATE agents SET status='paused' WHERE id=$1", [recipient.id]);
    const submitted = await action(task.id, 'deliveries', worker, { pr_number: 17, head_sha: sha });
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect((await action(task.id, 'reviews', reviewer, { decision: 'accept', reason: 'owner completed existing contract' })).statusCode).toBe(200);
    expect(await wallet(recipient.id)).toMatchObject({ available: '100' });
    await assertConserved();
  });

  it('PR submission binds the repository, author and exact commit and stores server evidence', async () => {
    const task = await acceptedTask();
    const valid = { ...evidence };
    for (const mismatch of [{ authorGithubId: outsider.githubId }, { repositoryId: '880002' }, { headSha: 'b'.repeat(40) }]) {
      evidence = { ...valid, ...mismatch };
      const denied = await action(task.id, 'deliveries', worker, { pr_number: 17, head_sha: sha });
      expectRejected(denied);
      expect((await detail(task.id)).status).toBe('in_progress');
    }
    evidence = valid;
    const foreign = await action(task.id, 'deliveries', outsider, { pr_number: 17, head_sha: sha });
    expectRejected(foreign);
    const submit = await action(task.id, 'deliveries', worker, { pr_number: 17, head_sha: sha });
    expect(submit.statusCode, submit.body).toBe(201);
    const stored = await detail(task.id);
    expect(stored.status).toBe('submitted');
    expect(stored.deliveries).toHaveLength(1);
    expect(JSON.stringify(stored.deliveries)).toContain(sha);
    expect(await wallet(recipient.id)).toMatchObject({ available: '0' });
  });

  it('human acceptance re-reads current GitHub evidence and requires merged, successful checks and unchanged SHA', async () => {
    const task = await submittedTask();
    const valid = { ...evidence };
    for (const mismatch of [
      { merged: false },
      { checks: [{ name: 'CI', status: 'completed', conclusion: 'failure' }] },
      { checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }, { name: 'CI', status: 'completed', conclusion: 'failure' }] },
      { checks: [] },
      { headSha: 'b'.repeat(40) },
    ]) {
      evidence = { ...valid, ...mismatch };
      const denied = await action(task.id, 'reviews', reviewer, { decision: 'accept', reason: '验收通过' });
      expectRejected(denied);
      expect((await detail(task.id)).status).toBe('submitted');
      expect(await wallet(recipient.id)).toMatchObject({ available: '0' });
    }
    evidence = valid;
    const outsiderReview = await action(task.id, 'reviews', outsider, { decision: 'accept', reason: 'intrusion' });
    expect(outsiderReview.statusCode).toBe(403);
    expect(evidenceReads).toBeGreaterThanOrEqual(5);
    const key = randomUUID(), payload = { version: task.version, decision: 'accept', reason: '测试和成果符合约定' };
    const first = await request(reviewer, 'POST', `/api/v1/tasks/${task.id}/reviews`, payload, key);
    expect(first.statusCode, first.body).toBe(200);
    expect((await detail(task.id)).status).toBe('settled');
    expect(await wallet(payer.id)).toMatchObject({ available: '900', reserved: '0', dailyUsed: '100' });
    expect(await wallet(recipient.id)).toMatchObject({ available: '100' });
    const replay = await request(reviewer, 'POST', `/api/v1/tasks/${task.id}/reviews`, payload, key);
    expect(replay.json()).toEqual(first.json());
    await action(task.id, 'reviews', reviewer, { decision: 'accept', reason: '测试和成果符合约定' });
    expect(await finalJournalCount(task.id)).toBe(1);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM rewarded_pull_requests WHERE task_id=$1', [task.id])).rows[0].n).toBe(1);
    expect((await pools.runtime.query("SELECT actor_type,actor_user_id FROM audit_events WHERE action='task.settled' AND target_id=$1", [task.id])).rows).toEqual([{ actor_type: 'user', actor_user_id: reviewer.actor.userId }]);
    const receipt = await app.inject({ url: `/api/v1/operations/${first.json().operation_id}`, headers: { cookie: reviewer.cookie } });
    expect(receipt.statusCode, receipt.body).toBe(200);
    expect(receipt.json()).toMatchObject({ resource_type: 'task', resource_id: task.id, result: { status: 'settled' } });
    expect(await wallet(recipient.id)).toMatchObject({ available: '100' });
    await assertConserved();
  });

  it('review rejection cites unmet criteria, keeps the hold and permits an updated submission', async () => {
    const task = await submittedTask();
    await expect(pools.runtime.query(`INSERT INTO task_reviews(task_id,delivery_id,reviewer_user_id,decision,reason,unmet_criteria)
      VALUES($1,$2,$3,'request_changes','缺少条件引用',NULL)`, [task.id, task.latest_delivery_id, reviewer.actor.userId])).rejects.toMatchObject({ code: '23514', constraint: 'task_reviews_check' });
    const missingCriteria = await action(task.id, 'reviews', reviewer, { decision: 'request_changes', reason: '需要修改' });
    expectRejected(missingCriteria);
    const changes = await action(task.id, 'reviews', reviewer, { decision: 'request_changes', reason: '补充失败路径测试', unmet_criteria: '实现测试并通过 CI' });
    expect(changes.statusCode, changes.body).toBe(200);
    expect((await detail(task.id)).status).toBe('changes_requested');
    expect(await wallet(payer.id)).toMatchObject({ available: '900', reserved: '100' });
    evidence.headSha = 'c'.repeat(40);
    const submitted = await action(task.id, 'deliveries', worker, { pr_number: 17, head_sha: evidence.headSha });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const reviewed = await action(task.id, 'reviews', reviewer, { decision: 'accept', reason: '补充测试已通过' });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(await finalJournalCount(task.id)).toBe(1);
    expect((await detail(task.id)).deliveries).toHaveLength(2);
    await assertConserved();
  });

  it('one PR cannot earn a second task reward even under a different task and request key', async () => {
    const first = await submittedTask();
    expect((await action(first.id, 'reviews', reviewer, { decision: 'accept', reason: 'accepted' })).statusCode).toBe(200);
    const second = await acceptedTask();
    const submitted = await action(second.id, 'deliveries', worker, { pr_number: 17, head_sha: sha });
    if (submitted.statusCode < 400) {
      const repeated = await action(second.id, 'reviews', reviewer, { decision: 'accept', reason: 'same PR' });
      expectRejected(repeated);
    } else expectRejected(submitted);
    expect(await wallet(recipient.id)).toMatchObject({ available: '100' });
    expect(await wallet(payer.id)).toMatchObject({ available: '800', reserved: '100' });
    expect(await finalJournalCount(second.id)).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM rewarded_pull_requests')).rows[0].n).toBe(1);
    await assertConserved();
  });

  it('cancelling before acceptance refunds once and cannot race into an accepted contract', async () => {
    const task = await openTask();
    const responses = await Promise.all([
      request(publisher, 'POST', `/api/v1/tasks/${task.id}/cancel`, { version: task.version, reason: 'cancel before start' }),
      request(worker, 'POST', `/api/v1/tasks/${task.id}/accept`, { version: task.version, agent_id: recipient.id }),
    ]);
    expect(responses.filter(response => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter(response => response.statusCode === 409)).toHaveLength(1);
    const current = await detail(task.id);
    if (current.status === 'cancelled') {
      expect(await wallet(payer.id)).toMatchObject({ available: '1000', reserved: '0' });
      await action(task.id, 'cancel', publisher, { reason: 'cancel before start' });
      expect(await finalJournalCount(task.id)).toBe(1);
    } else {
      expect(current.status).toBe('in_progress');
      expect((await action(task.id, 'cancel', publisher, { reason: 'unilateral' })).statusCode).toBe(409);
      expect(await wallet(payer.id)).toMatchObject({ available: '900', reserved: '100' });
      expect(await finalJournalCount(task.id)).toBe(0);
    }
    await assertConserved();
  });

  it('accepted cancellation requires both parties to agree on the same conserving split', async () => {
    const task = await acceptedTask();
    const invalid = await action(task.id, 'cancellation-proposals', publisher, { payment_points: '30', refund_points: '80', reason: 'invalid sum' });
    expectRejected(invalid);
    const proposed = await action(task.id, 'cancellation-proposals', publisher, { payment_points: '30', refund_points: '70', reason: 'agreed partial work' });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const current = await detail(task.id);
    const proposal = current.cancellation_proposals[0];
    expect(await wallet(payer.id)).toMatchObject({ available: '900', reserved: '100' });
    const stranger = await action(task.id, `cancellation-proposals/${proposal.id}/accept`, outsider);
    expectRejected(stranger);
    const accepted = await action(task.id, `cancellation-proposals/${proposal.id}/accept`, worker);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await detail(task.id)).status).toBe('cancelled');
    expect(await wallet(payer.id)).toMatchObject({ available: '970', reserved: '0', dailyUsed: '30' });
    expect(await wallet(recipient.id)).toMatchObject({ available: '30' });
    await action(task.id, `cancellation-proposals/${proposal.id}/accept`, worker);
    expect(await finalJournalCount(task.id)).toBe(1);
    await assertConserved();
  });

  it('existing contracts remain payable after the payer is paused and its key revoked', async () => {
    const task = await submittedTask();
    await pools.runtime.query("UPDATE agents SET status='paused' WHERE id=$1", [payer.id]);
    await pools.runtime.query('UPDATE agent_keys SET revoked_at=clock_timestamp() WHERE agent_id=$1', [payer.id]);
    await pools.runtime.query('UPDATE agent_policies SET can_accept_task=false,single_spend_limit=0,daily_spend_limit=0 WHERE agent_id=$1', [payer.id]);
    const result = await action(task.id, 'reviews', reviewer, { decision: 'accept', reason: '履行原合同' });
    expect(result.statusCode, result.body).toBe(200);
    expect(await wallet(recipient.id)).toMatchObject({ available: '100' });
    expect(await wallet(payer.id)).toMatchObject({ reserved: '0', dailyUsed: '100' });
    await assertConserved();
  });

  it('revoked repository access prevents new verification and acceptance but preserves prior history', async () => {
    const task = await submittedTask();
    await pools.migration.query("UPDATE github_installations SET status='suspended' WHERE installation_id='8800'");
    const result = await action(task.id, 'reviews', reviewer, { decision: 'accept', reason: 'cannot verify' });
    expectRejected(result);
    expect((await detail(task.id)).deliveries).toHaveLength(1);
    expect(await wallet(payer.id)).toMatchObject({ reserved: '100' });
    expect(await wallet(recipient.id)).toMatchObject({ available: '0' });
    await assertConserved();
  });

  it('a failed final task update rolls back the payment, review, PR claim and idempotent receipt', async () => {
    const task = await submittedTask();
    await pools.migration.query(`CREATE FUNCTION public.reject_test_task_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='settled' THEN RAISE EXCEPTION 'isolated settlement failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_test_task_settlement BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION public.reject_test_task_settlement()`);
    const key = randomUUID();
    try {
      const result = await request(reviewer, 'POST', `/api/v1/tasks/${task.id}/reviews`, { version: task.version, decision: 'accept', reason: 'accepted' }, key);
      expect(result.statusCode).toBe(500);
      expect((await detail(task.id)).status).toBe('submitted');
      expect(await wallet(payer.id)).toMatchObject({ available: '900', reserved: '100' });
      expect(await wallet(recipient.id)).toMatchObject({ available: '0' });
      expect(await finalJournalCount(task.id)).toBe(0);
      expect((await pools.runtime.query('SELECT count(*)::int n FROM rewarded_pull_requests WHERE task_id=$1', [task.id])).rows[0].n).toBe(0);
      expect((await pools.runtime.query('SELECT count(*)::int n FROM idempotency_requests WHERE idempotency_key=$1', [key])).rows[0].n).toBe(0);
      expect((await detail(task.id)).reviews).toHaveLength(0);
      await assertConserved();
    } finally {
      await pools.migration.query('DROP TRIGGER reject_test_task_settlement ON tasks; DROP FUNCTION public.reject_test_task_settlement()');
    }
    expect((await request(reviewer, 'POST', `/api/v1/tasks/${task.id}/reviews`, { version: task.version, decision: 'accept', reason: 'accepted' }, key)).statusCode).toBe(200);
    expect(await finalJournalCount(task.id)).toBe(1);
  });

  it('disputes stop normal acceptance and only an administrator can allocate the existing hold', async () => {
    const task = await submittedTask();
    const disputed = await action(task.id, 'disputes', worker, { reason: 'scope dispute' });
    expect(disputed.statusCode, disputed.body).toBe(200);
    expect((await detail(task.id)).disputed).toBe(true);
    expect((await action(task.id, 'reviews', reviewer, { decision: 'accept', reason: 'ordinary review' })).statusCode).toBe(409);
    const current = await detail(task.id);
    const payload = { version: current.version, outcome: 'cancelled', payment_points: '40', refund_points: '60', reason: 'operator reviewed partial work' };
    expect((await request(publisher, 'POST', `/api/v1/admin/tasks/${task.id}/resolve`, payload)).statusCode).toBe(403);
    const extraMoney = await request(admin, 'POST', `/api/v1/admin/tasks/${task.id}/resolve`, { ...payload, payment_points: '50' });
    expectRejected(extraMoney);
    const resolved = await request(admin, 'POST', `/api/v1/admin/tasks/${task.id}/resolve`, payload);
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(await detail(task.id)).toMatchObject({ status: 'cancelled', disputed: false });
    expect(await wallet(payer.id)).toMatchObject({ available: '960', reserved: '0', dailyUsed: '40' });
    expect(await wallet(recipient.id)).toMatchObject({ available: '40' });
    await assertConserved();
  });

  it('recoverable deadline scans mark overdue work disputed and remind a 72-hour review without paying or refunding', async () => {
    const unfinished = await acceptedTask();
    const submitted = await submittedTask(18);
    await pools.migration.query("UPDATE tasks SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [unfinished.id]);
    await pools.migration.query("UPDATE tasks SET review_due_at=clock_timestamp()-interval '1 second' WHERE id=$1", [submitted.id]);
    await processTaskDeadlines(pools.runtime);
    const expired = await detail(unfinished.id), reminded = await detail(submitted.id);
    expect(expired).toMatchObject({ status: 'in_progress', disputed: true });
    expect(reminded.status).toBe('submitted');
    expect(reminded.review_reminded_at).toBeTruthy();
    expect(await wallet(payer.id)).toMatchObject({ available: '800', reserved: '200' });
    expect(await wallet(recipient.id)).toMatchObject({ available: '0' });
    const eventCount = expired.events.length + reminded.events.length;
    await processTaskDeadlines(pools.runtime);
    expect((await detail(unfinished.id)).events.length + (await detail(submitted.id)).events.length).toBe(eventCount);
    expect(await finalJournalCount(unfinished.id)).toBe(0);
    expect(await finalJournalCount(submitted.id)).toBe(0);
    await assertConserved();
  });
});
