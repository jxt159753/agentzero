import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../packages/database/src/index.js';
import type { Actor } from '../../packages/contracts/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { AppError, tokenHash } from '../../apps/api/src/core.js';
import type { GitHubRepositoryProvider } from '../../apps/api/src/modules/github/provider.js';
import { processGithubDeliveries } from '../../apps/api/src/modules/github/jobs.js';
import { getWallet, issue, reconcile, setIssuanceLimit } from '../../apps/api/src/modules/ledger/service.js';
import { agent, context, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools();
const origin = 'http://localhost:5173';
const webhookSecret = 'isolated-github-webhook-test-secret';
const installationId = '9900', githubRepositoryId = '990001', sha = 'd'.repeat(40);
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string; githubId: string };
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Session, member: Session, reviewer: Session;
let upstreamFailure = false, privateRepository = false;
let installationReads = 0, repositoryReads = 0;
let duringRepositoryRead: (() => Promise<void>) | undefined;

const repositoryGithub: GitHubRepositoryProvider = {
  async getInstallation({ installationId: id }) {
    installationReads++;
    if (upstreamFailure) throw new AppError('GITHUB_UNAVAILABLE', 503);
    return { installationId: id, accountLogin: 'fixture-org', status: 'active' };
  },
  async getRepository({ owner, name }) {
    repositoryReads++;
    const callback = duringRepositoryRead;
    duringRepositoryRead = undefined;
    if (callback) await callback();
    if (upstreamFailure) throw new AppError('GITHUB_UNAVAILABLE', 503);
    return { repositoryId: name === 'second' ? '990002' : githubRepositoryId, owner, name, fullName: `${owner}/${name}`, isPrivate: privateRepository };
  },
  async getPullRequest({ repositoryId, number }) {
    if (upstreamFailure) throw new AppError('GITHUB_UNAVAILABLE', 503);
    return { repositoryId, number, headSha: sha, authorGithubId: member.githubId, merged: true, url: `https://github.com/fixture-org/work/pull/${number}`, checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }], fetchedAt: new Date().toISOString() };
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
const write = (s: Session, method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>, key: string = randomUUID()) => app.inject({ method, url, headers: headers(s, key), payload });
const sign = (raw: string) => `sha256=${createHmac('sha256', webhookSecret).update(raw).digest('hex')}`;
function webhook(eventName: string, payload: Record<string, unknown>, options: { id?: string; raw?: string; signature?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(payload);
  return app.inject({ method: 'POST', url: '/api/v1/github/webhook', headers: { 'content-type': 'application/json', 'x-github-event': eventName, 'x-github-delivery': options.id ?? randomUUID(), 'x-hub-signature-256': options.signature ?? sign(raw) }, payload: raw });
}
async function install(key?: string) {
  const response = await write(admin, 'POST', '/api/v1/admin/github/installations', { installation_id: installationId }, key);
  expect(response.statusCode, response.body).toBe(200);
  return response;
}
async function approve(name = 'work', key?: string) {
  const response = await write(admin, 'POST', '/api/v1/admin/repositories', { installation_id: installationId, owner: 'fixture-org', name }, key);
  expect(response.statusCode, response.body).toBe(201);
  return response;
}
const visibleRepositories = async (s = member) => (await app.inject({ url: '/api/v1/repositories', headers: { cookie: s.cookie } })).json().items;
async function submittedTask(repositoryId: string) {
  const worker = await agent(pools.runtime, member.actor);
  await withTransaction(pools.runtime, async tx => {
    const month = (await tx.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month")).rows[0].month as string;
    await setIssuanceLimit(tx, context(admin.actor), { month, limitPoints: '100', reason: 'isolated task event budget' });
    await issue(tx, context(admin.actor), { amount: '100', businessKey: `github-task:${randomUUID()}`, reason: 'isolated task event issuance' });
  });
  const created = await write(admin, 'POST', '/api/v1/tasks', { title: 'Webhook task', description: 'Verify the recorded delivery', repository_id: repositoryId, acceptance_criteria: 'CI passes', required_checks: ['CI'], reward_points: '100', deadline_at: new Date(Date.now() + 86400_000).toISOString(), reviewer_user_id: reviewer.actor.userId, payer_agent_id: null });
  expect(created.statusCode, created.body).toBe(201);
  let task = created.json();
  for (const step of [
    { actor: admin, name: 'publish', extra: {} },
    { actor: member, name: 'accept', extra: { agent_id: worker.id } },
    { actor: member, name: 'deliveries', extra: { pr_number: 31, head_sha: sha } },
  ]) {
    const response = await write(step.actor, 'POST', `/api/v1/tasks/${task.id}/${step.name}`, { version: task.version, ...step.extra });
    expect(response.statusCode, response.body).toBe(step.name === 'deliveries' ? 201 : 200);
    task = response.json();
  }
  return { task, worker };
}

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, repositoryGithub, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test-client', githubClientSecret: 'test-client-secret', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 3000, githubWebhookSecret: webhookSecret } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); member = await session(); reviewer = await session();
  upstreamFailure = false; privateRepository = false; installationReads = 0; repositoryReads = 0; duringRepositoryRead = undefined;
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('GitHub installation, repository admission and durable signed events', () => {
  it('only administrators approve installations and public repositories; disabled repositories leave the task selector', async () => {
    for (const [url, payload] of [
      ['/api/v1/admin/github/installations', { installation_id: installationId }],
      ['/api/v1/admin/repositories', { installation_id: installationId, owner: 'fixture-org', name: 'work' }],
    ] as const) expect((await write(member, 'POST', url, payload)).statusCode).toBe(403);
    expect(installationReads + repositoryReads).toBe(0);
    expect((await app.inject({ url: '/api/v1/admin/github/installations', headers: { cookie: member.cookie } })).statusCode).toBe(403);
    await install();
    privateRepository = true;
    const privateResult = await write(admin, 'POST', '/api/v1/admin/repositories', { installation_id: installationId, owner: 'fixture-org', name: 'work' });
    expect(privateResult.statusCode).toBe(409);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM repositories')).rows[0].n).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_history_scans')).rows[0].n).toBe(0);
    privateRepository = false;
    const repository = (await approve()).json();
    expect(repository).toMatchObject({ github_id: githubRepositoryId, installation_id: installationId, status: 'approved', is_private: false });
    expect((await pools.runtime.query('SELECT repository_id,status,cursor FROM contribution_history_scans')).rows).toEqual([{ repository_id: repository.id, status: 'pending', cursor: null }]);
    expect((await visibleRepositories()).map((row: { id: string }) => row.id)).toEqual([repository.id]);
    expect((await write(member, 'PATCH', `/api/v1/admin/repositories/${repository.id}`, { status: 'disabled' })).statusCode).toBe(403);
    const disabled = await write(admin, 'PATCH', `/api/v1/admin/repositories/${repository.id}`, { status: 'disabled' });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(await visibleRepositories()).toEqual([]);
    expect((await visibleRepositories(admin))[0].status).toBe('disabled');
    const restored = await write(admin, 'PATCH', `/api/v1/admin/repositories/${repository.id}`, { status: 'approved' });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_history_scans')).rows[0].n).toBe(1);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM audit_events WHERE action='github.repository_approved'")).rows[0].n).toBe(1);
  });

  it('retains completed history on repeated admission and queues legacy repositories when restored', async () => {
    await install();
    const repository = (await approve()).json();
    await pools.runtime.query("UPDATE contribution_history_scans SET status='completed',completed_at=clock_timestamp() WHERE repository_id=$1", [repository.id]);
    const completed = (await pools.runtime.query('SELECT * FROM contribution_history_scans WHERE repository_id=$1', [repository.id])).rows[0];
    await approve();
    expect((await pools.runtime.query('SELECT * FROM contribution_history_scans WHERE repository_id=$1', [repository.id])).rows).toEqual([completed]);
    expect((await write(admin, 'PATCH', `/api/v1/admin/repositories/${repository.id}`, { status: 'disabled' })).statusCode).toBe(200);
    await pools.migration.query('DELETE FROM contribution_history_scans WHERE repository_id=$1', [repository.id]);
    expect((await write(admin, 'PATCH', `/api/v1/admin/repositories/${repository.id}`, { status: 'approved' })).statusCode).toBe(200);
    expect((await pools.runtime.query('SELECT repository_id,status,cursor FROM contribution_history_scans')).rows).toEqual([{ repository_id: repository.id, status: 'pending', cursor: null }]);
  });

  it('remote failures leave no installation, repository or receipt; completed commands replay during an outage', async () => {
    const installKey = randomUUID(), repoKey = randomUUID();
    upstreamFailure = true;
    expect((await write(admin, 'POST', '/api/v1/admin/github/installations', { installation_id: installationId }, installKey)).statusCode).toBe(503);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM github_installations')).rows[0].n).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM idempotency_requests')).rows[0].n).toBe(0);
    upstreamFailure = false;
    const installed = await install(installKey);
    upstreamFailure = true;
    expect((await write(admin, 'POST', '/api/v1/admin/repositories', { installation_id: installationId, owner: 'fixture-org', name: 'work' }, repoKey)).statusCode).toBe(503);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM repositories')).rows[0].n).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM idempotency_requests WHERE idempotency_key=$1', [repoKey])).rows[0].n).toBe(0);
    upstreamFailure = false;
    const approved = await approve('work', repoKey);
    const reads = { installation: installationReads, repository: repositoryReads };
    upstreamFailure = true;
    expect((await install(installKey)).json()).toEqual(installed.json());
    expect((await approve('work', repoKey)).json()).toEqual(approved.json());
    expect({ installation: installationReads, repository: repositoryReads }).toEqual(reads);
    const conflict = await write(admin, 'POST', '/api/v1/admin/repositories', { installation_id: installationId, owner: 'fixture-org', name: 'second' }, repoKey);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('authenticates the exact raw body and atomically deduplicates deliveries, including concurrent retries', async () => {
    const payload = { action: 'opened', repository: { id: 990001 }, pull_request: { number: 31, head: { sha } } };
    const raw = JSON.stringify(payload, null, 2), compact = JSON.stringify(payload), id = randomUUID();
    const wrong = await webhook('pull_request', payload, { raw, signature: sign(compact) });
    expect(wrong.statusCode).toBe(401);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM github_deliveries')).rows[0].n).toBe(0);
    const malformed = await webhook('pull_request', {}, { raw: '{ broken json' });
    expect(malformed.statusCode).toBe(400);
    const results = await Promise.all([webhook('pull_request', payload, { raw, id }), webhook('pull_request', payload, { raw, id })]);
    expect(results.map(response => response.statusCode)).toEqual([202, 202]);
    expect(results.map(response => response.json().duplicate).sort()).toEqual([false, true]);
    const stored = (await pools.runtime.query('SELECT delivery_id,event_name,payload,status,attempts FROM github_deliveries')).rows;
    expect(stored).toEqual([{ delivery_id: id, event_name: 'pull_request', payload, status: 'pending', attempts: 0 }]);
    expect((await webhook('pull_request', payload, { raw: compact, id })).statusCode).toBe(409);
    expect((await webhook('check_run', payload, { raw, id })).statusCode).toBe(409);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM github_deliveries')).rows[0].n).toBe(1);
    const hidden = await app.inject({ url: '/api/v1/admin/github/deliveries', headers: { cookie: member.cookie } });
    expect(hidden.statusCode).toBe(403);
    const adminView = await app.inject({ url: '/api/v1/admin/github/deliveries', headers: { cookie: admin.cookie } });
    expect(adminView.statusCode).toBe(200);
    expect(adminView.body).not.toContain('payload_hash');
    expect(adminView.body).not.toContain('pull_request":{');
  });

  it.each(['suspend', 'deleted'] as const)('installation %s disables new repository use before the background worker runs', async action => {
    await install(); await approve();
    const result = await webhook('installation', { action, installation: { id: 9900, account: { login: 'fixture-org' } } });
    expect(result.statusCode, result.body).toBe(202);
    expect((await pools.runtime.query('SELECT status FROM github_installations WHERE installation_id=$1', [installationId])).rows[0].status).toBe(action === 'suspend' ? 'suspended' : 'deleted');
    expect(await visibleRepositories()).toEqual([]);
    expect((await pools.runtime.query('SELECT status FROM github_deliveries')).rows[0].status).toBe('pending');
    const repository = (await visibleRepositories(admin))[0];
    const reenable = await write(admin, 'PATCH', `/api/v1/admin/repositories/${repository.id}`, { status: 'approved' });
    expect(reenable.statusCode).toBe(409);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM audit_events WHERE action='github.installation_revoked'")).rows[0].n).toBe(1);
  });

  it('repository removal disables only removed repositories and defeats admission already awaiting GitHub', async () => {
    await install();
    const first = (await approve()).json(), second = (await approve('second')).json();
    duringRepositoryRead = async () => {
      const removed = await webhook('installation_repositories', { action: 'removed', installation: { id: 9900 }, repositories_removed: [{ id: 990001 }] });
      expect(removed.statusCode, removed.body).toBe(202);
    };
    const raced = await write(admin, 'POST', '/api/v1/admin/repositories', { installation_id: installationId, owner: 'fixture-org', name: 'work' });
    expect(raced.statusCode, raced.body).toBe(409);
    expect((await visibleRepositories()).map((row: { id: string }) => row.id)).toEqual([second.id]);
    expect((await pools.runtime.query('SELECT status FROM repositories WHERE id=$1', [first.id])).rows[0].status).toBe('disabled');
    expect((await pools.runtime.query('SELECT status FROM github_installations')).rows[0].status).toBe('active');
  });

  it('a repository privatized event immediately revokes admission and keeps the metadata for history', async () => {
    await install();
    const repository = (await approve()).json();
    const result = await webhook('repository', { action: 'privatized', installation: { id: 9900 }, repository: { id: 990001, private: true } });
    expect(result.statusCode, result.body).toBe(202);
    expect((await pools.runtime.query('SELECT id,status,is_private FROM repositories')).rows).toEqual([{ id: repository.id, status: 'disabled', is_private: true }]);
    expect(await visibleRepositories()).toEqual([]);
    const denied = await write(admin, 'PATCH', `/api/v1/admin/repositories/${repository.id}`, { status: 'approved' });
    expect(denied.statusCode).toBe(409);
  });

  it('persistent delivery retries append one task event and never settle or release a task hold', async () => {
    await install();
    const repository = (await approve()).json();
    const { task, worker } = await submittedTask(repository.id);
    const deliveryId = randomUUID(), payload = { action: 'closed', installation: { id: 9900 }, repository: { id: 990001 }, pull_request: { number: 31, merged: true, head: { sha } } };
    const response = await webhook('pull_request', payload, { id: deliveryId });
    expect(response.statusCode).toBe(202);
    await pools.migration.query(`CREATE FUNCTION public.reject_test_github_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='github_event' THEN RAISE EXCEPTION 'upstream secret must never be saved'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_test_github_event BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION public.reject_test_github_event()`);
    try {
      expect(await processGithubDeliveries(pools.runtime)).toBe(0);
      expect((await pools.runtime.query('SELECT status,attempts,last_error FROM github_deliveries WHERE delivery_id=$1', [deliveryId])).rows[0]).toEqual({ status: 'pending', attempts: 1, last_error: 'P0001' });
      expect((await pools.runtime.query("SELECT count(*)::int n FROM task_events WHERE kind='github_event'")).rows[0].n).toBe(0);
    } finally {
      await pools.migration.query('DROP TRIGGER reject_test_github_event ON task_events; DROP FUNCTION public.reject_test_github_event()');
    }
    await pools.migration.query("UPDATE github_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE delivery_id=$1", [deliveryId]);
    expect(await processGithubDeliveries(pools.runtime)).toBe(1);
    expect(await processGithubDeliveries(pools.runtime)).toBe(0);
    const retried = await webhook('pull_request', payload, { id: deliveryId });
    expect(retried.json()).toEqual({ accepted: true, duplicate: true });
    expect(await processGithubDeliveries(pools.runtime)).toBe(0);
    // Recovery of an old pending marker must also preserve the task-level event identity.
    await pools.migration.query("UPDATE github_deliveries SET status='pending',next_attempt_at=clock_timestamp() WHERE delivery_id=$1", [deliveryId]);
    expect(await processGithubDeliveries(pools.runtime)).toBe(1);
    const events = (await pools.runtime.query("SELECT details FROM task_events WHERE task_id=$1 AND kind='github_event'", [task.id])).rows;
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ delivery_id: deliveryId, event_name: 'pull_request', pr_number: 31, head_sha: sha });
    expect((await pools.runtime.query('SELECT status FROM tasks WHERE id=$1', [task.id])).rows[0].status).toBe('submitted');
    expect((await pools.runtime.query('SELECT status,reserved_total,captured_total,released_total FROM credit_holds WHERE id=$1', [task.hold_id])).rows[0]).toEqual({ status: 'open', reserved_total: '100', captured_total: '0', released_total: '0' });
    expect(await withTransaction(pools.runtime, tx => getWallet(tx, worker.id))).toMatchObject({ available: '0' });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM rewarded_pull_requests')).rows[0].n).toBe(0);
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
});
