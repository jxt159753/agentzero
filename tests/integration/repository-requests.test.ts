import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, RepositoryRequestDto } from '../../packages/contracts/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { AppError, tokenHash } from '../../apps/api/src/core.js';
import type { GitHubRepositoryProvider } from '../../apps/api/src/modules/github/provider.js';
import { agent, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), origin = 'http://localhost:5173', installationId = '9200', repositoryGithubId = '920001';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string; login: string };
type Page = { items: RepositoryRequestDto[]; next_cursor: string | null };
let app: Awaited<ReturnType<typeof buildApp>>, admin: Session, secondAdmin: Session, alice: Session, bob: Session;
let upstreamFailure: boolean, privateRepository: boolean, repositoryReads: number;
let duringRepositoryRead: (() => Promise<void>) | undefined;
const provider: GitHubRepositoryProvider = {
  async getInstallation({ installationId: id }) { return { installationId: id, accountLogin: 'fixture-org', status: 'active' }; },
  async getRepository({ owner, name }) {
    repositoryReads++;
    const hook = duringRepositoryRead; duringRepositoryRead = undefined; await hook?.();
    if (upstreamFailure) throw new AppError('GITHUB_UNAVAILABLE', 503);
    return { repositoryId: repositoryGithubId, owner, name, fullName: `${owner}/${name}`, isPrivate: privateRepository };
  },
  async getPullRequest() { throw new Error('Repository requests do not read PRs'); },
};
async function session(role: 'admin' | 'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  const row = (await pools.runtime.query('SELECT github_login FROM users WHERE id=$1', [actor.userId])).rows[0];
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf, login: row.github_login };
}
const headers = (client: Session, key: string = randomUUID()) => ({ cookie: client.cookie, origin, 'x-csrf-token': client.csrf, 'idempotency-key': key });
const get = (client: Session, path: string) => app.inject({ url: `/api/v1${path}`, headers: headers(client) });
const post = (client: Session, path: string, payload: Record<string, unknown>, key?: string) => app.inject({ method: 'POST', url: `/api/v1${path}`, headers: headers(client, key), payload });
function successful<T>(response: { statusCode: number; body: string; json: <T>() => T }): T {
  expect([200, 201], response.body).toContain(response.statusCode); return response.json<T>();
}
const list = async (client = alice, path = '/repository-requests') => successful<Page>(await get(client, path));
async function submit(client = alice, url = 'https://github.com/fixture-org/project', key?: string) {
  return post(client, '/repository-requests', { repository_url: url, reason: '申请为自己的公开项目启用提交奖励' }, key);
}
async function create(client = alice, url?: string) { return successful<RepositoryRequestDto>(await submit(client, url)); }
const review = (row: RepositoryRequestDto, decision: 'approve' | 'reject', client = admin, key?: string) => post(client, `/admin/repository-requests/${row.id}/review`, {
  version: row.version, decision, reason: decision === 'approve' ? '已核实仓库控制权限与 GitHub App 安装' : '请补充仓库授权说明', ...(decision === 'approve' ? { installation_id: installationId } : {}),
}, key);
const repositoryCount = async () => (await pools.runtime.query('SELECT count(*)::int n FROM repositories')).rows[0].n as number;

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, repositoryGithub: provider,
    config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test', githubClientSecret: 'test', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); secondAdmin = await session('admin'); alice = await session(); bob = await session();
  upstreamFailure = false; privateRepository = false; repositoryReads = 0; duringRepositoryRead = undefined;
  await pools.migration.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES($1,'fixture-org','active')", [installationId]);
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('user repository admission requests with real PostgreSQL', () => {
  it('accepts personal and organization proposals without admitting repositories or paying rewards', async () => {
    const organization = await create();
    const personal = await create(alice, `https://github.com/${alice.login}/personal.git/`);
    expect(organization).toMatchObject({ user_id: alice.actor.userId, applicant_login: alice.login, owner: 'fixture-org', status: 'pending', version: '1', repository_id: null, review_reason: null });
    expect(personal.repository_url).toBe(`https://github.com/${alice.login}/personal`);
    expect(await repositoryCount()).toBe(0); expect(repositoryReads).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_history_scans')).rows[0].n).toBe(0);
    const recipient = await agent(pools.runtime, alice.actor);
    const claim = await post(alice, '/contributions/claim', { agent_id: recipient.id, url: 'https://github.com/fixture-org/project/issues/1', version: '1' });
    expect(claim.statusCode).toBe(409); expect(claim.json().error.code).toBe('REPOSITORY_UNAVAILABLE');
    expect((await pools.runtime.query('SELECT count(*)::int n FROM journal_transactions')).rows[0].n).toBe(0);
  });

  it('requires an authenticated active user and CSRF, and rejects non-repository URLs', async () => {
    const payload = { repository_url: 'https://github.com/fixture-org/project', reason: 'test' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/repository-requests', payload })).statusCode).toBe(401);
    const csrf = await app.inject({ method: 'POST', url: '/api/v1/repository-requests', headers: { cookie: alice.cookie, 'idempotency-key': randomUUID() }, payload });
    expect(csrf.json().error.code).toBe('CSRF_INVALID');
    for (const url of ['https://example.com/org/repo', 'http://github.com/org/repo', 'https://github.com/org/repo/issues/1', 'https://user:pass@github.com/org/repo']) {
      const result = await submit(alice, url); expect(result.statusCode).toBe(400); expect(result.json().error.code).toBe('INVALID_REPOSITORY_URL');
    }
    await pools.migration.query("UPDATE users SET status='suspended' WHERE id=$1", [alice.actor.userId]);
    expect((await submit()).statusCode).toBe(403);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM repository_requests')).rows[0].n).toBe(0);
  });

  it('replays the same submission and prevents concurrent case-insensitive pending duplicates', async () => {
    const key = randomUUID();
    const first = successful<RepositoryRequestDto>(await submit(alice, undefined, key));
    expect(successful<RepositoryRequestDto>(await submit(alice, undefined, key))).toEqual(first);
    const results = await Promise.all([submit(alice, 'https://github.com/FIXTURE-ORG/PROJECT'), submit(alice, 'https://github.com/fixture-org/project.git')]);
    for (const result of results) { expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe('REPOSITORY_REQUEST_EXISTS'); }
    expect((await list()).items).toHaveLength(1);
    expect((await create(bob)).user_id).toBe(bob.actor.userId);
    const concurrent = await Promise.all([submit(alice, 'https://github.com/org/other'), submit(alice, 'https://github.com/ORG/OTHER')]);
    expect(concurrent.map(result => result.statusCode).sort()).toEqual([201, 409]);
  });

  it('keeps user lists private and provides administrator status filters and stable pagination', async () => {
    const first = await create(); await create(alice, 'https://github.com/org/second'); const other = await create(bob);
    successful(await review(first, 'reject'));
    const ownFirst = await list(alice, '/repository-requests?limit=1');
    expect(ownFirst.items).toHaveLength(1); expect(ownFirst.next_cursor).not.toBeNull();
    const ownNext = await list(alice, `/repository-requests?limit=1&cursor=${encodeURIComponent(ownFirst.next_cursor!)}`);
    expect(ownNext.items).toHaveLength(1); expect(ownNext.next_cursor).toBeNull();
    expect([...ownFirst.items, ...ownNext.items].every(row => row.user_id === alice.actor.userId)).toBe(true);
    expect((await list(bob)).items.map(row => row.id)).toEqual([other.id]);
    expect((await get(alice, '/admin/repository-requests')).statusCode).toBe(403);
    const pending = await list(admin, '/admin/repository-requests?status=pending');
    expect(pending.items).toHaveLength(2); expect(pending.items.every(row => row.status === 'pending')).toBe(true);
    expect((await list(admin, '/admin/repository-requests?status=rejected')).items.map(row => row.id)).toEqual([first.id]);
  });

  it('atomically approves into the existing repository catalog and replays without GitHub', async () => {
    const row = await create(), key = randomUUID();
    const approved = successful<RepositoryRequestDto>(await review(row, 'approve', admin, key));
    expect(approved).toMatchObject({ status: 'approved', version: '2', reviewer_user_id: admin.actor.userId, review_reason: '已核实仓库控制权限与 GitHub App 安装' });
    const repo = (await pools.runtime.query('SELECT * FROM repositories WHERE id=$1', [approved.repository_id])).rows[0];
    expect(repo).toMatchObject({ github_id: repositoryGithubId, installation_id: installationId, owner: 'fixture-org', name: 'project', status: 'approved', is_private: false });
    expect((await pools.runtime.query('SELECT repository_id,status,cursor FROM contribution_history_scans')).rows).toEqual([{ repository_id: approved.repository_id, status: 'pending', cursor: null }]);
    const visible = successful<{ items: { id: string }[] }>(await get(alice, '/repositories'));
    expect(visible.items.map(item => item.id)).toContain(approved.repository_id);
    upstreamFailure = true;
    expect(successful<RepositoryRequestDto>(await review(row, 'approve', admin, key))).toEqual(approved);
    expect(repositoryReads).toBe(1); expect(await repositoryCount()).toBe(1);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_history_scans')).rows[0].n).toBe(1);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM audit_events WHERE action='github.repository_request_reviewed'")).rows[0].n).toBe(1);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM journal_transactions')).rows[0].n).toBe(0);
  });

  it('requires an administrator and an active installation to approve', async () => {
    const row = await create();
    expect((await review(row, 'approve', alice)).statusCode).toBe(403);
    const missing = await post(admin, `/admin/repository-requests/${row.id}/review`, { version: row.version, decision: 'approve', reason: 'missing installation' });
    expect(missing.statusCode).toBe(400);
    await pools.migration.query("UPDATE github_installations SET status='suspended' WHERE installation_id=$1", [installationId]);
    expect((await review(row, 'approve')).json().error.code).toBe('REPOSITORY_UNAVAILABLE');
    expect(repositoryReads).toBe(0); expect(await repositoryCount()).toBe(0);
    expect((await list()).items[0]!.status).toBe('pending');
  });

  it('rejects without GitHub or repository mutation and allows a new corrected application', async () => {
    const row = await create(); upstreamFailure = true;
    const rejected = successful<RepositoryRequestDto>(await review(row, 'reject'));
    expect(rejected).toMatchObject({ status: 'rejected', version: '2', repository_id: null, review_reason: '请补充仓库授权说明' });
    expect(repositoryReads).toBe(0); expect(await repositoryCount()).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM contribution_history_scans')).rows[0].n).toBe(0);
    const next = await create(); expect(next.id).not.toBe(row.id); expect(next.status).toBe('pending');
    const stale = await review(row, 'approve');
    expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('REPOSITORY_REQUEST_VERSION_CONFLICT');
  });

  it('rejects private or inaccessible repositories without consuming the pending request', async () => {
    const row = await create(); privateRepository = true;
    expect((await review(row, 'approve')).json().error.code).toBe('REPOSITORY_UNAVAILABLE');
    expect((await list()).items[0]!.status).toBe('pending'); expect(await repositoryCount()).toBe(0);
    privateRepository = false; upstreamFailure = true;
    expect((await review(row, 'approve')).statusCode).toBe(503);
    expect((await list()).items[0]!.version).toBe('1'); expect(await repositoryCount()).toBe(0);
    upstreamFailure = false; expect(successful<RepositoryRequestDto>(await review(row, 'approve')).status).toBe('approved');
  });

  it.each(['suspend', 'revision'] as const)('rechecks installation %s after remote verification and rolls back admission', async change => {
    const row = await create();
    duringRepositoryRead = async () => {
      await pools.migration.query(`UPDATE github_installations SET ${change === 'suspend' ? "status='suspended'," : ''}updated_at=clock_timestamp() WHERE installation_id=$1`, [installationId]);
    };
    const failed = await review(row, 'approve');
    expect(failed.statusCode).toBe(409); expect(failed.json().error.code).toBe('REPOSITORY_UNAVAILABLE');
    expect(await repositoryCount()).toBe(0); expect((await list()).items[0]!.status).toBe('pending');
    expect((await pools.runtime.query("SELECT count(*)::int n FROM audit_events WHERE action='github.repository_approved'")).rows[0].n).toBe(0);
  });

  it('allows one concurrent decision and upserts the same repository across independent approved requests', async () => {
    const row = await create();
    const results = await Promise.all([review(row, 'approve'), review(row, 'reject', secondAdmin)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect(results.find(result => result.statusCode === 409)!.json().error.code).toBe('REPOSITORY_REQUEST_VERSION_CONFLICT');
    const final = (await list()).items[0]!;
    expect(await repositoryCount()).toBe(final.status === 'approved' ? 1 : 0);
    const other = await create(bob);
    const accepted = successful<RepositoryRequestDto>(await review(other, 'approve'));
    expect(await repositoryCount()).toBe(1);
    if (final.status === 'approved') expect(accepted.repository_id).toBe(final.repository_id);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM audit_events WHERE action='github.repository_request_reviewed'")).rows[0].n).toBe(2);
  });
});
