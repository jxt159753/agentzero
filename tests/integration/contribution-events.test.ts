import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../packages/contracts/src/index.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { AppError } from '../../apps/api/src/core.js';
import type { GitHubContributionEvidence, GitHubRepositoryProvider } from '../../apps/api/src/modules/github/provider.js';
import { processGithubDeliveries } from '../../apps/api/src/modules/github/jobs.js';
import { processContributionEvents } from '../../apps/api/src/modules/contributions/jobs.js';
import { payContribution } from '../../apps/api/src/modules/contributions/service.js';
import { getWallet, issue, reconcile, setIssuanceLimit } from '../../apps/api/src/modules/ledger/service.js';
import { agent, context, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), secret = 'isolated-contribution-webhook-secret';
const installationId = '9800', githubRepositoryId = '980001', sha = 'a'.repeat(40), unlinkedSha = 'b'.repeat(40);
type UserActor = Extract<Actor, { type: 'user' }>;
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: UserActor, member: UserActor, first: Awaited<ReturnType<typeof agent>>, second: Awaited<ReturnType<typeof agent>>;
let repositoryId: string, githubUserId: string, failing = false;
let duringRead: (() => Promise<void>) | undefined;
const evidenceByObject = new Map<string, Partial<GitHubContributionEvidence>>();
function evidence(kind: GitHubContributionEvidence['kind'], objectId: string): GitHubContributionEvidence {
  return { repositoryId: githubRepositoryId, kind, objectId, authorGithubId: githubUserId,
    url: `https://github.com/contribution-fixture/work/${kind === 'commit' ? 'commit' : kind === 'pull_request' ? 'pull' : 'issues'}/${objectId}`,
    title: 'Independent contribution fixture', createdAt: '2026-11-07T00:00:00Z', ...evidenceByObject.get(objectId) };
}
const provider: GitHubRepositoryProvider = {
  async getInstallation() { return { installationId, accountLogin: 'contribution-fixture', status: 'active' }; },
  async getRepository() { return { repositoryId: githubRepositoryId, owner: 'contribution-fixture', name: 'work', fullName: 'contribution-fixture/work', isPrivate: false }; },
  async getPullRequest() { throw new Error('Task evidence is not part of contribution payout'); },
  async getContribution({ kind, objectId }) {
    const callback = duringRead;
    duringRead = undefined;
    if (callback) await callback();
    if (failing) throw new AppError('GITHUB_UNAVAILABLE', 503);
    return evidence(kind, objectId);
  },
};
function webhook(eventName: string, payload: Record<string, unknown>, id = randomUUID(), signature?: string) {
  const raw = JSON.stringify({ installation: { id: Number(installationId) }, repository: { id: Number(githubRepositoryId) }, ...payload });
  return app.inject({ method: 'POST', url: '/api/v1/github/webhook', payload: raw,
    headers: { 'content-type': 'application/json', 'x-github-event': eventName, 'x-github-delivery': id,
      'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } });
}
const push = (ids = [sha]) => webhook('push', { commits: ids.map(id => ({ id, author: { username: 'untrusted-payload-author' } })) });
const wallet = (target = first) => withTransaction(pools.runtime, tx => getWallet(tx, target.id));
const eventRows = () => pools.runtime.query('SELECT kind,object_id,status,attempts,last_error,lease_id FROM contribution_events ORDER BY kind,object_id').then(result => result.rows);
async function issuePool(amount = '100') {
  await withTransaction(pools.runtime, async tx => {
    const month = (await tx.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month")).rows[0].month as string;
    await setIssuanceLimit(tx, context(admin), { month, limitPoints: '10000', reason: 'isolated contribution events budget' });
    await issue(tx, context(admin), { amount, businessKey: `contribution-events:${randomUUID()}`, reason: 'isolated contribution events issuance' });
  });
}
async function readyEvents() { await processGithubDeliveries(pools.runtime); }
async function retryNow() { await pools.migration.query("UPDATE contribution_events SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE status='pending'"); }

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, repositoryGithub: provider, config: { databaseUrl: process.env.TEST_DATABASE_URL!,
    publicOrigin: 'http://localhost:5173', githubClientId: 'test', githubClientSecret: 'test', bootstrapAdminGithubId: '',
    production: false, host: '127.0.0.1', port: 0, githubWebhookSecret: secret } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await identity(pools.runtime, 'admin') as UserActor;
  member = await identity(pools.runtime) as UserActor;
  first = await agent(pools.runtime, member); second = await agent(pools.runtime, member);
  githubUserId = (await pools.runtime.query('SELECT github_user_id FROM users WHERE id=$1', [member.userId])).rows[0].github_user_id;
  await pools.runtime.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES($1,'contribution-fixture','active')", [installationId]);
  repositoryId = (await pools.runtime.query(`INSERT INTO repositories(github_id,installation_id,owner,name,full_name)
    VALUES($1,$2,'contribution-fixture','work','contribution-fixture/work') RETURNING id`, [githubRepositoryId, installationId])).rows[0].id;
  await pools.runtime.query('UPDATE contribution_reward_settings SET commit_points=2,pull_request_points=3,issue_points=1,version=1 WHERE id=1');
  await pools.runtime.query('INSERT INTO contribution_reward_preferences(user_id,agent_id) VALUES($1,$2)', [member.userId, first.id]);
  failing = false; duringRead = undefined; evidenceByObject.clear();
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('durable GitHub contribution auto payouts', () => {
  it('queues signed commit, opened PR and Issue events and isolates a commit without a linked author', async () => {
    await issuePool();
    evidenceByObject.set(unlinkedSha, { authorGithubId: null });
    expect((await push([sha, unlinkedSha, sha, 'invalid'])).statusCode).toBe(202);
    expect((await webhook('pull_request', { action: 'opened', pull_request: { number: 7, merged: false } })).statusCode).toBe(202);
    expect((await webhook('issues', { action: 'opened', issue: { number: 8, state: 'open' } })).statusCode).toBe(202);
    await readyEvents();
    expect(await eventRows()).toHaveLength(4);
    expect(await processContributionEvents(pools.runtime, provider)).toBe(3);
    expect(await wallet()).toMatchObject({ available: '6' });
    expect((await eventRows()).filter(row => row.status === 'skipped')).toEqual([
      expect.objectContaining({ object_id: unlinkedSha, last_error: 'CONTRIBUTION_AUTHOR_UNLINKED' }),
    ]);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_rewards')).rows[0].n).toBe(3);
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('deduplicates across deliveries, concurrent workers and a preceding manual claim', async () => {
    await issuePool();
    await push(); await push();
    await readyEvents();
    expect(await eventRows()).toHaveLength(1);
    await withTransaction(pools.runtime, tx => payContribution(tx, { actor: member, requestId: randomUUID(), userId: member.userId,
      agentId: first.id, repositoryId, evidence: evidence('commit', sha) }));
    await pools.runtime.query('UPDATE contribution_reward_preferences SET agent_id=$2 WHERE user_id=$1', [member.userId, second.id]);
    await Promise.all([processContributionEvents(pools.runtime, provider), processContributionEvents(pools.runtime, provider)]);
    expect(await wallet()).toMatchObject({ available: '2' });
    expect(await wallet(second)).toMatchObject({ available: '0' });
    expect((await eventRows())[0]).toMatchObject({ status: 'processed', attempts: 1 });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_rewards')).rows[0].n).toBe(1);
  });

  it('skips an unset recipient while allowing a later link claim', async () => {
    await issuePool();
    await pools.runtime.query('UPDATE contribution_reward_preferences SET agent_id=NULL WHERE user_id=$1', [member.userId]);
    await push(); await readyEvents();
    await processContributionEvents(pools.runtime, provider);
    expect((await eventRows())[0]).toMatchObject({ status: 'skipped', last_error: 'CONTRIBUTION_RECEIVER_UNSET' });
    expect(await wallet()).toMatchObject({ available: '0' });
    await withTransaction(pools.runtime, tx => payContribution(tx, { actor: member, requestId: randomUUID(), userId: member.userId,
      agentId: first.id, repositoryId, evidence: evidence('commit', sha) }));
    expect(await wallet()).toMatchObject({ available: '2' });
  });

  it('pays once when the automatic worker and a manual claim race for the same contribution', async () => {
    await issuePool(); await push(); await readyEvents();
    await Promise.all([
      processContributionEvents(pools.runtime, provider),
      withTransaction(pools.runtime, tx => payContribution(tx, { actor: member, requestId: randomUUID(), userId: member.userId,
        agentId: first.id, repositoryId, evidence: evidence('commit', sha) })),
    ]);
    expect(await wallet()).toMatchObject({ available: '2' });
    expect((await eventRows())[0]).toMatchObject({ status: 'processed' });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_rewards')).rows[0].n).toBe(1);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM credit_holds')).rows[0].n).toBe(1);
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('skips disabled reward types and unknown authors without consuming pool funds', async () => {
    await issuePool();
    await pools.runtime.query('UPDATE contribution_reward_settings SET issue_points=0 WHERE id=1');
    evidenceByObject.set(sha, { authorGithubId: '987654321' });
    await push(); await webhook('issues', { action: 'opened', issue: { number: 8 } }); await readyEvents();
    await processContributionEvents(pools.runtime, provider);
    expect((await eventRows()).map(row => row.last_error).sort()).toEqual(['CONTRIBUTION_DISABLED', 'CONTRIBUTION_USER_UNAVAILABLE']);
    expect(await wallet()).toMatchObject({ available: '0' });
    expect((await pools.runtime.query("SELECT balance FROM ledger_accounts WHERE system_key='REWARD_POOL'")).rows[0].balance).toBe('100');
  });

  it('retries transient GitHub failures and insufficient funds without leaving partial rewards', async () => {
    await push(); await readyEvents();
    failing = true;
    await processContributionEvents(pools.runtime, provider);
    expect((await eventRows())[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'GITHUB_UNAVAILABLE', lease_id: null });
    failing = false; await retryNow();
    await processContributionEvents(pools.runtime, provider);
    expect((await eventRows())[0]).toMatchObject({ status: 'pending', attempts: 2, last_error: 'P0001', lease_id: null });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM credit_holds')).rows[0].n).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_rewards')).rows[0].n).toBe(0);
    await issuePool(); await retryNow();
    expect(await processContributionEvents(pools.runtime, provider)).toBe(1);
    expect(await wallet()).toMatchObject({ available: '2' });
    expect((await eventRows())[0]).toMatchObject({ status: 'processed', attempts: 3, last_error: null });
  });

  it('uses the latest receiving preference after network I/O and rejects repository changes during that read', async () => {
    await issuePool(); await push(); await readyEvents();
    duringRead = async () => { await pools.runtime.query('UPDATE contribution_reward_preferences SET agent_id=$2 WHERE user_id=$1', [member.userId, second.id]); };
    await processContributionEvents(pools.runtime, provider);
    expect(await wallet()).toMatchObject({ available: '0' });
    expect(await wallet(second)).toMatchObject({ available: '2' });
    await webhook('issues', { action: 'opened', issue: { number: 8 } }); await readyEvents();
    duringRead = async () => { await pools.runtime.query("UPDATE repositories SET name='renamed',full_name='contribution-fixture/renamed' WHERE id=$1", [repositoryId]); };
    await processContributionEvents(pools.runtime, provider);
    expect((await eventRows()).find(row => row.kind === 'issue')).toMatchObject({ status: 'skipped', last_error: 'REPOSITORY_UNAVAILABLE' });
    expect(await wallet(second)).toMatchObject({ available: '2' });
  });

  it('rejects invalid signatures, wrong installations, non-creation events and mismatched API evidence', async () => {
    expect((await webhook('push', { commits: [{ id: sha }] }, randomUUID(), 'sha256=' + '0'.repeat(64))).statusCode).toBe(401);
    await webhook('push', { installation: { id: 123 }, commits: [{ id: sha }] });
    await webhook('pull_request', { action: 'synchronize', pull_request: { number: 7 } });
    await webhook('issues', { action: 'opened', issue: { number: 8, pull_request: { url: 'https://github.com/contribution-fixture/work/pull/8' } } });
    await readyEvents();
    expect(await eventRows()).toEqual([]);
    await issuePool(); await push(); await readyEvents();
    evidenceByObject.set(sha, { kind: 'issue', objectId: '8' });
    await processContributionEvents(pools.runtime, provider);
    expect((await eventRows())[0]).toMatchObject({ status: 'skipped', last_error: 'CONTRIBUTION_BINDING_MISMATCH' });
    expect(await wallet()).toMatchObject({ available: '0' });
  });

  it('recovers an expired lease without a stale worker paying twice', async () => {
    await issuePool(); await push(); await readyEvents();
    let started!: () => void, release!: () => void;
    const startedGate = new Promise<void>(resolve => { started = resolve; });
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    duringRead = async () => { started(); await releaseGate; };
    const oldWorker = processContributionEvents(pools.runtime, provider);
    await startedGate;
    try {
      await retryNow();
      expect(await processContributionEvents(pools.runtime, provider)).toBe(1);
    } finally { release(); }
    expect(await oldWorker).toBe(0);
    expect(await wallet()).toMatchObject({ available: '2' });
    expect((await eventRows())[0]).toMatchObject({ status: 'processed', attempts: 2 });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_rewards')).rows[0].n).toBe(1);
  });
});
