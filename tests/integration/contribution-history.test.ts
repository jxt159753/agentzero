import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../packages/contracts/src/index.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { AppError } from '../../apps/api/src/core.js';
import type { GitHubContributionEvidence, GitHubContributionHistoryCursor, GitHubRepositoryProvider } from '../../apps/api/src/modules/github/provider.js';
import { persistGithubDelivery } from '../../apps/api/src/modules/github/service.js';
import { processGithubDeliveries } from '../../apps/api/src/modules/github/jobs.js';
import { processContributionHistory } from '../../apps/api/src/modules/contributions/history.js';
import { processContributionEvents } from '../../apps/api/src/modules/contributions/jobs.js';
import { payContribution } from '../../apps/api/src/modules/contributions/service.js';
import { getWallet, issue, reconcile, setIssuanceLimit } from '../../apps/api/src/modules/ledger/service.js';
import { agent, context, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), installationId = '9700', githubRepositoryId = '970001';
const sha = 'a'.repeat(40), secondSha = 'b'.repeat(40);
type UserActor = Extract<Actor, { type: 'user' }>;
type HistoryPage = Awaited<ReturnType<NonNullable<GitHubRepositoryProvider['listContributionHistory']>>>;
let admin: UserActor, alice: UserActor, bob: UserActor;
let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;
let repositoryId: string, aliceGithubId: string, bobGithubId: string;
let pages: HistoryPage[], reads: (GitHubContributionHistoryCursor | null)[], failing: boolean;
let duringHistoryRead: (() => Promise<void>) | undefined;
const authors = new Map<string, string | null>();
const commitCursor: GitHubContributionHistoryCursor = { phase: 'commits', heads: [sha], headIndex: 0, page: 1, nextBranchPage: null };
const issuesCursor: GitHubContributionHistoryCursor = { phase: 'issues', page: 1 };
function evidence(kind: GitHubContributionEvidence['kind'], objectId: string): GitHubContributionEvidence {
  return { repositoryId: githubRepositoryId, kind, objectId, authorGithubId: authors.has(objectId) ? authors.get(objectId)! : aliceGithubId,
    url: `https://github.com/history-fixture/work/${kind === 'commit' ? 'commit' : kind === 'pull_request' ? 'pull' : 'issues'}/${objectId}`,
    title: 'Historical contribution fixture', createdAt: '2025-01-01T00:00:00Z' };
}
const provider: GitHubRepositoryProvider = {
  async getInstallation() { return { installationId, accountLogin: 'history-fixture', status: 'active' }; },
  async getRepository() { return { repositoryId: githubRepositoryId, owner: 'history-fixture', name: 'work', fullName: 'history-fixture/work', isPrivate: false }; },
  async getPullRequest() { throw new Error('History does not read task evidence'); },
  async getContribution({ kind, objectId }) { return evidence(kind, objectId); },
  async listContributionHistory({ installationId: installation, repositoryId: repository, owner, name, cursor }) {
    expect({ installation, repository, owner, name }).toEqual({ installation: installationId, repository: githubRepositoryId, owner: 'history-fixture', name: 'work' });
    reads.push(cursor);
    const callback = duringHistoryRead; duringHistoryRead = undefined;
    await callback?.();
    if (failing) throw new AppError('GITHUB_UNAVAILABLE', 503);
    const page = cursor === null ? pages[0] : pages.find((_, index) => index > 0 && isDeepStrictEqual(pages[index - 1]!.nextCursor, cursor));
    if (!page) throw new Error(`Unexpected history cursor ${JSON.stringify(cursor)}`);
    return page;
  },
};
const scan = async () => (await pools.runtime.query('SELECT * FROM contribution_history_scans WHERE repository_id=$1', [repositoryId])).rows[0];
const events = async () => (await pools.runtime.query('SELECT kind,object_id,status,is_historical,delivery_id,last_error FROM contribution_events ORDER BY kind,object_id')).rows;
const wallet = (target = aliceAgent) => withTransaction(pools.runtime, tx => getWallet(tx, target.id));
async function retryNow() {
  await pools.migration.query("UPDATE contribution_history_scans SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE status='pending'");
  await pools.migration.query("UPDATE contribution_events SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE status='pending'");
}
async function issuePool() {
  await withTransaction(pools.runtime, async tx => {
    const month = (await tx.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month")).rows[0].month as string;
    await setIssuanceLimit(tx, context(admin), { month, limitPoints: '1000', reason: 'historical contribution budget' });
    await issue(tx, context(admin), { amount: '100', businessKey: `contribution-history:${randomUUID()}`, reason: 'historical contribution pool' });
  });
}
async function webhook(eventName: string, data: Record<string, unknown>) {
  const payload = { installation: { id: Number(installationId) }, repository: { id: Number(githubRepositoryId) }, ...data };
  await withTransaction(pools.runtime, tx => persistGithubDelivery(tx, { deliveryId: randomUUID(), eventName, payload, raw: Buffer.from(JSON.stringify(payload)) }));
  await processGithubDeliveries(pools.runtime);
}

beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await identity(pools.runtime, 'admin') as UserActor;
  alice = await identity(pools.runtime) as UserActor; bob = await identity(pools.runtime) as UserActor;
  aliceAgent = await agent(pools.runtime, alice); bobAgent = await agent(pools.runtime, bob);
  aliceGithubId = (await pools.runtime.query('SELECT github_user_id FROM users WHERE id=$1', [alice.userId])).rows[0].github_user_id;
  bobGithubId = (await pools.runtime.query('SELECT github_user_id FROM users WHERE id=$1', [bob.userId])).rows[0].github_user_id;
  await pools.runtime.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES($1,'history-fixture','active')", [installationId]);
  repositoryId = (await pools.runtime.query(`INSERT INTO repositories(github_id,installation_id,owner,name,full_name)
    VALUES($1,$2,'history-fixture','work','history-fixture/work') RETURNING id`, [githubRepositoryId, installationId])).rows[0].id;
  await pools.runtime.query('INSERT INTO contribution_history_scans(repository_id) VALUES($1)', [repositoryId]);
  await pools.runtime.query('UPDATE contribution_reward_settings SET commit_points=2,pull_request_points=3,issue_points=1,version=1 WHERE id=1');
  await pools.runtime.query('INSERT INTO contribution_reward_preferences(user_id,agent_id) VALUES($1,$2),($3,$4)', [alice.userId, aliceAgent.id, bob.userId, bobAgent.id]);
  authors.clear(); reads = []; failing = false; duringHistoryRead = undefined;
  pages = [{ items: [{ kind: 'commit', objectId: sha }], nextCursor: null }];
});
afterAll(async () => { await pools.runtime.end(); await pools.migration.end(); });

describe('durable repository contribution history', () => {
  it('persists each page and pays historical commits, PRs and issues to their respective authors', async () => {
    await issuePool();
    authors.set('7', bobGithubId); authors.set('9', null);
    pages = [
      { items: [{ kind: 'commit', objectId: sha }], nextCursor: commitCursor },
      { items: [{ kind: 'commit', objectId: sha }, { kind: 'pull_request', objectId: '7' }], nextCursor: issuesCursor },
      { items: [{ kind: 'issue', objectId: '8' }, { kind: 'issue', objectId: '9' }], nextCursor: null },
    ];
    expect(await processContributionHistory(pools.runtime, provider)).toBe(1);
    expect(await scan()).toMatchObject({ status: 'pending', cursor: commitCursor, lease_id: null });
    expect(await events()).toHaveLength(1);
    expect(await processContributionHistory(pools.runtime, provider)).toBe(1);
    expect(await scan()).toMatchObject({ status: 'pending', cursor: issuesCursor });
    expect(await processContributionHistory(pools.runtime, provider)).toBe(1);
    expect(await scan()).toMatchObject({ status: 'completed', lease_id: null });
    expect((await scan()).completed_at).not.toBeNull();
    expect(reads).toEqual([null, commitCursor, issuesCursor]);
    expect(await processContributionHistory(pools.runtime, provider)).toBe(0);
    expect(reads).toHaveLength(3);
    expect((await events()).every(row => row.is_historical && row.delivery_id === null)).toBe(true);
    expect(await processContributionEvents(pools.runtime, provider)).toBe(3);
    expect(await wallet()).toMatchObject({ available: '3' });
    expect(await wallet(bobAgent)).toMatchObject({ available: '3' });
    expect((await events()).find(row => row.object_id === '9')).toMatchObject({ status: 'skipped', last_error: 'CONTRIBUTION_AUTHOR_UNLINKED' });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_rewards')).rows[0].n).toBe(3);
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });

  it('deduplicates manual claims and webhooks, preserving completed events and reopening skipped contributions', async () => {
    await issuePool();
    await withTransaction(pools.runtime, tx => payContribution(tx, { actor: alice, requestId: randomUUID(), userId: alice.userId,
      agentId: aliceAgent.id, repositoryId, evidence: evidence('commit', sha) }));
    await webhook('push', { commits: [{ id: sha }] });
    await pools.runtime.query('UPDATE contribution_reward_settings SET issue_points=0 WHERE id=1');
    await webhook('issues', { action: 'opened', issue: { number: 8 } });
    expect(await processContributionEvents(pools.runtime, provider)).toBe(1);
    expect((await events()).find(row => row.kind === 'issue')).toMatchObject({ status: 'skipped' });
    await webhook('pull_request', { action: 'opened', pull_request: { number: 7 } });
    pages = [{ items: [{ kind: 'commit', objectId: sha }, { kind: 'pull_request', objectId: '7' }, { kind: 'issue', objectId: '8' }], nextCursor: null }];
    await processContributionHistory(pools.runtime, provider);
    expect((await events()).map(row => [row.kind, row.status])).toEqual([['commit', 'processed'], ['issue', 'pending'], ['pull_request', 'pending']]);
    expect((await events()).every(row => row.is_historical)).toBe(true);
    await pools.runtime.query('UPDATE contribution_reward_settings SET issue_points=1 WHERE id=1');
    await Promise.all([processContributionEvents(pools.runtime, provider), processContributionEvents(pools.runtime, provider)]);
    expect(await wallet()).toMatchObject({ available: '6' });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_rewards')).rows[0].n).toBe(3);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM credit_holds')).rows[0].n).toBe(3);
  });

  it('retries a failed page from its persisted cursor without losing earlier events', async () => {
    pages = [{ items: [{ kind: 'commit', objectId: sha }], nextCursor: issuesCursor },
      { items: [{ kind: 'issue', objectId: '8' }], nextCursor: null }];
    await processContributionHistory(pools.runtime, provider);
    failing = true;
    expect(await processContributionHistory(pools.runtime, provider)).toBe(0);
    expect(await scan()).toMatchObject({ status: 'pending', cursor: issuesCursor, lease_id: null, last_error: 'GITHUB_UNAVAILABLE' });
    expect(await events()).toHaveLength(1);
    failing = false; await retryNow();
    expect(await processContributionHistory(pools.runtime, provider)).toBe(1);
    expect(reads).toEqual([null, issuesCursor, issuesCursor]);
    expect(await scan()).toMatchObject({ status: 'completed', last_error: null });
    expect(await events()).toHaveLength(2);
  });

  it.each(['repository', 'installation'] as const)('does not enqueue a page if its %s becomes unavailable during the GitHub read', async target => {
    duringHistoryRead = async () => {
      if (target === 'repository') await pools.runtime.query("UPDATE repositories SET status='disabled' WHERE id=$1", [repositoryId]);
      else await pools.runtime.query("UPDATE github_installations SET status='suspended' WHERE installation_id=$1", [installationId]);
    };
    expect(await processContributionHistory(pools.runtime, provider)).toBe(0);
    expect(await scan()).toMatchObject({ status: 'pending', cursor: null, lease_id: null });
    expect(await events()).toEqual([]);
    await retryNow();
    expect(await processContributionHistory(pools.runtime, provider)).toBe(0);
    expect(reads).toEqual([null]);
    await pools.runtime.query("UPDATE repositories SET status='approved' WHERE id=$1", [repositoryId]);
    await pools.runtime.query("UPDATE github_installations SET status='active' WHERE installation_id=$1", [installationId]);
    expect(await processContributionHistory(pools.runtime, provider)).toBe(1);
    expect(await events()).toHaveLength(1);
  });

  it('keeps historical rewards pending until the receiving Agent, reward rate and account become available', async () => {
    await issuePool();
    await pools.runtime.query('UPDATE contribution_reward_preferences SET agent_id=NULL WHERE user_id=$1', [alice.userId]);
    await pools.runtime.query('UPDATE contribution_reward_settings SET commit_points=0 WHERE id=1');
    await processContributionHistory(pools.runtime, provider);
    await processContributionEvents(pools.runtime, provider);
    expect((await events())[0]).toMatchObject({ status: 'pending', last_error: 'CONTRIBUTION_RECEIVER_UNSET' });
    await pools.runtime.query('UPDATE contribution_reward_preferences SET agent_id=$2 WHERE user_id=$1', [alice.userId, aliceAgent.id]);
    await retryNow(); await processContributionEvents(pools.runtime, provider);
    expect((await events())[0]).toMatchObject({ status: 'pending', last_error: 'CONTRIBUTION_DISABLED' });
    await pools.runtime.query('UPDATE contribution_reward_settings SET commit_points=2 WHERE id=1');
    await pools.runtime.query("UPDATE agents SET status='paused' WHERE id=$1", [aliceAgent.id]);
    await retryNow(); await processContributionEvents(pools.runtime, provider);
    expect((await events())[0]).toMatchObject({ status: 'pending', last_error: 'AGENT_PAUSED' });
    await pools.runtime.query("UPDATE agents SET status='active' WHERE id=$1", [aliceAgent.id]);
    await pools.runtime.query("UPDATE users SET status='pending' WHERE id=$1", [alice.userId]);
    await retryNow(); await processContributionEvents(pools.runtime, provider);
    expect((await events())[0]).toMatchObject({ status: 'pending', last_error: 'CONTRIBUTION_USER_UNAVAILABLE' });
    expect(await wallet()).toMatchObject({ available: '0' });
    await pools.runtime.query("UPDATE users SET status='active' WHERE id=$1", [alice.userId]);
    await retryNow();
    expect(await processContributionEvents(pools.runtime, provider)).toBe(1);
    expect((await events())[0]).toMatchObject({ status: 'processed', last_error: null });
    expect(await wallet()).toMatchObject({ available: '2' });
  });

  it('allows one active history lease and prevents an expired worker from overwriting the completed scan', async () => {
    let started!: () => void, release!: () => void;
    const startedGate = new Promise<void>(resolve => { started = resolve; });
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    duringHistoryRead = async () => { started(); await releaseGate; };
    const oldWorker = processContributionHistory(pools.runtime, provider);
    await startedGate;
    try {
      expect(await processContributionHistory(pools.runtime, provider)).toBe(0);
      expect(reads).toHaveLength(1);
      await retryNow();
      expect(await processContributionHistory(pools.runtime, provider)).toBe(1);
      pages = [{ items: [{ kind: 'commit', objectId: secondSha }], nextCursor: issuesCursor }];
    } finally { release(); }
    expect(await oldWorker).toBe(0);
    expect(await scan()).toMatchObject({ status: 'completed', lease_id: null });
    expect((await events()).map(row => row.object_id)).toEqual([sha]);
  });
});
