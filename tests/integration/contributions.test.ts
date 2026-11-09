import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../packages/database/src/index.js';
import type { Actor, ContributionRewardDto, ContributionRewardSettingsDto } from '../../packages/contracts/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { AppError, tokenHash } from '../../apps/api/src/core.js';
import type { GitHubContributionEvidence, GitHubContributionKind, GitHubRepositoryProvider } from '../../apps/api/src/modules/github/provider.js';
import { getWallet, issue, reconcile, setIssuanceLimit } from '../../apps/api/src/modules/ledger/service.js';
import { agent, context, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

// The API, authorization and ledger use PostgreSQL; only remote GitHub evidence is mocked.
const pools = testPools(), origin = 'http://localhost:5173';
const repoGithubId = '890001', installationId = '8900', sha = 'a'.repeat(40);
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string; githubId: string };
type TestAgent = Awaited<ReturnType<typeof agent>>;
type Page = {
  settings: ContributionRewardSettingsDto;
  preference: { agent_id: string | null; version: string; updated_at: string | null };
  items: ContributionRewardDto[]; next_cursor: string | null;
};
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Session, alice: Session, bob: Session;
let recipient: TestAgent, sibling: TestAgent, foreignAgent: TestAgent;
let repositoryId: string, settingsVersion: string;
let evidenceOverrides: Partial<GitHubContributionEvidence>, evidenceReads: number;
let beforeEvidence: (() => Promise<void>) | undefined, unavailable: boolean;

function contributionUrl(kind: GitHubContributionKind, objectId: string) {
  return `https://github.com/fixture-org/contributions/${kind === 'pull_request' ? 'pull' : kind === 'issue' ? 'issues' : 'commit'}/${objectId}`;
}
const repositoryGithub: GitHubRepositoryProvider = {
  async getInstallation({ installationId }) { return { installationId, accountLogin: 'fixture-org', status: 'active' }; },
  async getRepository({ owner, name }) { return { repositoryId: repoGithubId, owner, name, fullName: `${owner}/${name}`, isPrivate: false }; },
  async getPullRequest() { throw new Error('Submission rewards must not use task merge/check evidence'); },
  async getContribution(input) {
    evidenceReads++;
    if (unavailable) throw new AppError('GITHUB_UNAVAILABLE', 503);
    const hook = beforeEvidence; beforeEvidence = undefined; await hook?.();
    return { repositoryId: repoGithubId, kind: input.kind, objectId: input.objectId, authorGithubId: alice.githubId,
      url: contributionUrl(input.kind, input.objectId), title: `Submitted ${input.kind}`, createdAt: '2026-11-01T00:00:00.000Z', ...evidenceOverrides };
  },
};
async function session(role: 'admin' | 'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  const user = (await pools.runtime.query('SELECT github_user_id FROM users WHERE id=$1', [actor.userId])).rows[0];
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf, githubId: user.github_user_id };
}
const headers = (client: Session, key: string = randomUUID()) => ({ cookie: client.cookie, origin, 'x-csrf-token': client.csrf, 'idempotency-key': key });
const write = (client: Session, method: 'POST' | 'PUT', path: string, payload: Record<string, unknown>, key?: string) => app.inject({ method, url: `/api/v1${path}`, headers: headers(client, key), payload });
const get = (client: Session, path: string) => app.inject({ url: `/api/v1${path}`, headers: headers(client) });
function successful<T>(response: { statusCode: number; body: string; json: <T>() => T }): T {
  expect([200, 201], response.body).toContain(response.statusCode);
  return response.json<T>();
}
const page = async (client = alice, query = '') => successful<Page>(await get(client, `/contributions${query}`));
const wallet = (id = recipient.id) => withTransaction(pools.runtime, tx => getWallet(tx, id));
const poolBalance = async () => (await pools.runtime.query("SELECT balance FROM ledger_accounts WHERE system_key='REWARD_POOL'")).rows[0].balance as string;
const conserved = async () => expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
const claim = (kind: GitHubContributionKind = 'commit', objectId = sha, target = recipient, client = alice, key?: string) => write(client, 'POST', '/contributions/claim', { agent_id: target.id, url: contributionUrl(kind, objectId), version: settingsVersion }, key);
async function configure(overrides: Record<string, string> = {}) {
  const settings = successful<ContributionRewardSettingsDto>(await get(admin, '/admin/contribution-rewards'));
  const updated = successful<ContributionRewardSettingsDto>(await write(admin, 'PUT', '/admin/contribution-rewards', {
    version: settings.version, commit_points: settings.commit_points, pull_request_points: settings.pull_request_points,
    issue_points: settings.issue_points, reason: 'isolated contribution reward test', ...overrides,
  }));
  settingsVersion = updated.version;
  return updated;
}
async function fundPool(amount: string) {
  await withTransaction(pools.runtime, async tx => {
    const month = (await tx.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month")).rows[0].month as string;
    await setIssuanceLimit(tx, context(admin.actor), { month, limitPoints: '10000', reason: 'isolated contribution test budget' });
    await issue(tx, context(admin.actor), { amount, businessKey: `contribution-test:${randomUUID()}`, reason: 'isolated contribution reward pool' });
  });
}

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, repositoryGithub,
    config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test-client', githubClientSecret: 'test-secret', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); alice = await session(); bob = await session();
  recipient = await agent(pools.runtime, alice.actor); sibling = await agent(pools.runtime, alice.actor); foreignAgent = await agent(pools.runtime, bob.actor);
  repositoryId = randomUUID();
  await pools.migration.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES($1,'fixture-org','active')", [installationId]);
  await pools.migration.query("INSERT INTO repositories(id,github_id,installation_id,owner,name,full_name,is_private,status) VALUES($1,$2,$3,'fixture-org','contributions','fixture-org/contributions',false,'approved')", [repositoryId, repoGithubId, installationId]);
  evidenceOverrides = {}; evidenceReads = 0; beforeEvidence = undefined; unavailable = false;
  await fundPool('200');
  await configure({ commit_points: '2', pull_request_points: '5', issue_points: '3' });
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('GitHub contribution rewards with real PostgreSQL', () => {
  it('pays commit, unmerged PR and Issue submissions directly without task evidence', async () => {
    const commit = successful<ContributionRewardDto>(await claim());
    const pr = successful<ContributionRewardDto>(await claim('pull_request', '7'));
    const issueReward = successful<ContributionRewardDto>(await claim('issue', '8'));
    expect([commit.points, pr.points, issueReward.points]).toEqual(['2', '5', '3']);
    expect(pr).toMatchObject({ repository_id: repositoryId, kind: 'pull_request', object_id: '7', agent_id: recipient.id, user_id: alice.actor.userId });
    expect(await wallet()).toMatchObject({ available: '10', reserved: '0' });
    expect(await poolBalance()).toBe('190');
    expect((await pools.runtime.query('SELECT count(*)::int n FROM rewarded_pull_requests')).rows[0].n).toBe(0);
    await conserved();
  });

  it('deduplicates concurrent claims and another owned Agent across distinct request keys', async () => {
    const responses = await Promise.all([claim(), claim('commit', sha, sibling)]);
    const records = responses.map(response => successful<ContributionRewardDto>(response));
    expect(records[0]!.id).toBe(records[1]!.id);
    expect(records[0]!.agent_id).toBe(records[1]!.agent_id);
    expect(BigInt((await wallet()).available) + BigInt((await wallet(sibling.id)).available)).toBe(2n);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_rewards')).rows[0].n).toBe(1);
    expect(await poolBalance()).toBe('198');
    await conserved();
  });

  it('replays a completed request while GitHub is unavailable and rejects changed payloads under its key', async () => {
    const key = randomUUID();
    const first = successful<ContributionRewardDto>(await claim('commit', sha, recipient, alice, key));
    unavailable = true;
    expect(successful<ContributionRewardDto>(await claim('commit', sha, recipient, alice, key))).toEqual(first);
    expect(evidenceReads).toBe(1);
    const changed = await claim('commit', 'b'.repeat(40), recipient, alice, key);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await poolBalance()).toBe('198');
    await conserved();
  });

  it('rejects another GitHub author, an unlinked commit author and a foreign recipient wallet', async () => {
    evidenceOverrides = { authorGithubId: bob.githubId };
    const otherAuthor = await claim();
    expect(otherAuthor.statusCode).toBe(409);
    expect(otherAuthor.json().error.code).toBe('CONTRIBUTION_IDENTITY_MISMATCH');
    evidenceOverrides = { authorGithubId: null };
    expect((await claim()).json().error.code).toBe('CONTRIBUTION_IDENTITY_MISMATCH');
    evidenceOverrides = {};
    expect((await claim('commit', sha, foreignAgent)).statusCode).toBe(403);
    expect(await wallet()).toMatchObject({ available: '0' });
    expect(await poolBalance()).toBe('200');
    await conserved();
  });

  it('rejects unsupported URLs before fetching remote evidence', async () => {
    for (const url of ['https://example.com/fixture-org/contributions/issues/1', 'https://github.com/fixture-org/contributions/commit/main', 'https://github.com/fixture-org/contributions/discussions/1']) {
      const result = await write(alice, 'POST', '/contributions/claim', { agent_id: recipient.id, url, version: settingsVersion });
      expect(result.statusCode, result.body).toBe(400);
      expect(result.json().error.code).toBe('INVALID_CONTRIBUTION_URL');
    }
    expect(evidenceReads).toBe(0);
  });

  it('validates fetched repository, kind and object identity before paying', async () => {
    for (const overrides of [{ repositoryId: '999999' }, { kind: 'issue' as const }, { objectId: 'b'.repeat(40) }]) {
      evidenceOverrides = overrides;
      const response = await claim();
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONTRIBUTION_BINDING_MISMATCH');
    }
    expect(await poolBalance()).toBe('200');
    await conserved();
  });

  it('rolls back insufficient-pool claims and pays the same request after funding', async () => {
    await configure({ commit_points: '300' });
    const key = randomUUID(), failed = await claim('commit', sha, recipient, alice, key);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error.code).toBe('INSUFFICIENT_FUNDS');
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_rewards')).rows[0].n).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM credit_holds')).rows[0].n).toBe(0);
    expect(await poolBalance()).toBe('200');
    await fundPool('200');
    expect(successful<ContributionRewardDto>(await claim('commit', sha, recipient, alice, key)).points).toBe('300');
    expect(await wallet()).toMatchObject({ available: '300' });
    expect(await poolBalance()).toBe('100');
    await conserved();
  });

  it('keeps paid amounts unchanged after configuration changes and rejects stale quotes', async () => {
    const original = successful<ContributionRewardDto>(await claim()), oldVersion = settingsVersion;
    await configure({ commit_points: '9' });
    const repeated = successful<ContributionRewardDto>(await claim());
    expect(repeated.id).toBe(original.id); expect(repeated.points).toBe('2');
    const stale = await write(alice, 'POST', '/contributions/claim', { agent_id: recipient.id, url: contributionUrl('commit', 'b'.repeat(40)), version: oldVersion });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CONTRIBUTION_VERSION_CONFLICT');
    expect(successful<ContributionRewardDto>(await claim('commit', 'b'.repeat(40))).points).toBe('9');
    expect(await wallet()).toMatchObject({ available: '11' });
    await conserved();
  });

  it('keeps reward configuration administrator-only and allows a type to be disabled', async () => {
    const denied = await write(alice, 'PUT', '/admin/contribution-rewards', { version: settingsVersion, commit_points: '1000', pull_request_points: '5', issue_points: '3', reason: 'unauthorized' });
    expect(denied.statusCode).toBe(403);
    const oldVersion = settingsVersion;
    await configure({ commit_points: '0' });
    const stale = await write(admin, 'PUT', '/admin/contribution-rewards', { version: oldVersion, commit_points: '1000', pull_request_points: '5', issue_points: '3', reason: 'stale configuration' });
    expect(stale.statusCode).toBe(409);
    const disabled = await claim();
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().error.code).toBe('CONTRIBUTION_DISABLED');
    expect(successful<ContributionRewardDto>(await claim('issue', '9')).points).toBe('3');
    await conserved();
  });

  it.each(['repository', 'installation', 'agent'] as const)('rechecks %s eligibility after remote evidence is read', async target => {
    beforeEvidence = async () => {
      if (target === 'repository') await pools.migration.query("UPDATE repositories SET status='disabled' WHERE id=$1", [repositoryId]);
      else if (target === 'installation') await pools.migration.query("UPDATE github_installations SET status='suspended' WHERE installation_id=$1", [installationId]);
      else await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [recipient.id]);
    };
    const response = await claim();
    expect([403, 409], response.body).toContain(response.statusCode);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_rewards')).rows[0].n).toBe(0);
    expect(await poolBalance()).toBe('200');
    await conserved();
  });

  it('sets, changes and disables an owned automatic recipient with preference version checks', async () => {
    const initial = (await page()).preference;
    expect(initial).toMatchObject({ agent_id: null, version: '0' });
    successful(await write(alice, 'PUT', '/contributions/preference', { agent_id: recipient.id, version: initial.version }));
    const saved = (await page()).preference;
    expect(saved.agent_id).toBe(recipient.id);
    expect((await write(alice, 'PUT', '/contributions/preference', { agent_id: sibling.id, version: initial.version })).statusCode).toBe(409);
    expect((await write(alice, 'PUT', '/contributions/preference', { agent_id: foreignAgent.id, version: saved.version })).statusCode).toBe(403);
    successful(await write(alice, 'PUT', '/contributions/preference', { agent_id: sibling.id, version: saved.version }));
    const changed = (await page()).preference;
    expect(changed.agent_id).toBe(sibling.id);
    successful(await write(alice, 'PUT', '/contributions/preference', { agent_id: null, version: changed.version }));
    expect((await page()).preference.agent_id).toBeNull();
    expect((await page(bob)).preference).toMatchObject({ agent_id: null, version: '0' });
    expect(await poolBalance()).toBe('200');
  });

  it('lists only owner rewards and paginates without losing records', async () => {
    const owned = [successful<ContributionRewardDto>(await claim()), successful<ContributionRewardDto>(await claim('issue', '12'))];
    evidenceOverrides = { authorGithubId: bob.githubId };
    successful<ContributionRewardDto>(await claim('pull_request', '13', foreignAgent, bob));
    const first = await page(alice, '?limit=1');
    expect(first.items).toHaveLength(1); expect(first.next_cursor).not.toBeNull();
    const next = await page(alice, `?limit=1&cursor=${encodeURIComponent(first.next_cursor!)}`);
    expect(next.items).toHaveLength(1); expect(next.next_cursor).toBeNull();
    expect([...first.items, ...next.items].map(item => item.id).sort()).toEqual(owned.map(item => item.id).sort());
    const other = await page(bob);
    expect(other.items).toHaveLength(1); expect(other.items[0]!.user_id).toBe(bob.actor.userId);
    await conserved();
  });

  it('clears the automatic recipient and advances its version when an empty Agent is deleted', async () => {
    successful(await write(alice, 'PUT', '/contributions/preference', { agent_id: recipient.id, version: '0' }));
    const prior = (await page()).preference;
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/agents/${recipient.id}`, headers: headers(alice), payload: { version: '1' } });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const current = (await page()).preference;
    expect(current.agent_id).toBeNull();
    expect(BigInt(current.version)).toBe(BigInt(prior.version) + 1n);
    expect(await poolBalance()).toBe('200');
  });
});
