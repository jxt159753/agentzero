import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../apps/api/src/config.js';
import { githubRepositoryProvider, type GitHubContributionHistoryCursor } from '../../apps/api/src/modules/github/provider.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config: Config = { databaseUrl: 'unused', publicOrigin: 'http://localhost:5173', githubClientId: 'client', githubClientSecret: '',
  bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 3000, githubAppId: '123',
  githubPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const repo = { id: 81, owner: { login: 'allowed' }, name: 'repo', full_name: 'allowed/repo', private: false, archived: false, disabled: false };
const input = { installationId: '9', repositoryId: '81', owner: 'allowed', name: 'repo' };
const base = '/repos/allowed/repo';
const headA = 'a'.repeat(40), headB = 'b'.repeat(40), sharedCommit = 'c'.repeat(40);
const branchesPath = (page: number) => `${base}/branches?per_page=100&page=${page}`;
const commitsPath = (head: string, page: number) => `${base}/commits?sha=${head}&per_page=100&page=${page}`;
const issuesPath = (page: number) => `${base}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`;

function fixture(responses: Record<string, unknown | ((count: number) => unknown)>) {
  const paths: string[] = [], counts: Record<string, number> = {};
  const defaults: Record<string, unknown> = {
    '/app/installations/9': { id: 9, account: { login: 'allowed' }, suspended_at: null },
    '/app/installations/9/access_tokens': { token: 'installation-secret' },
    [base]: repo,
    '/installation/repositories?per_page=100&page=1': { repositories: [repo] },
  };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.github.com', '');
    paths.push(path);
    counts[path] = (counts[path] ?? 0) + 1;
    if (!path.startsWith('/app/')) expect((init!.headers as Record<string, string>).authorization).toBe('Bearer installation-secret');
    let response = Object.hasOwn(responses, path) ? responses[path] : defaults[path];
    if (typeof response === 'function') response = response(counts[path]!);
    if (response instanceof Response) return response;
    if (response === undefined) throw new Error(`Unexpected GitHub request: ${path}`);
    return Response.json(response);
  };
  const provider = githubRepositoryProvider(config, fetcher as typeof fetch);
  return { paths, read: (cursor: GitHubContributionHistoryCursor | null = null) => provider.listContributionHistory!({ ...input, cursor }), provider };
}

describe('GitHub historical contribution discovery', () => {
  it('walks every branch with pinned heads and resumes commit pagination without losing shared commits', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, '0') }));
    const { read, paths } = fixture({
      [branchesPath(1)]: [{ name: 'main', commit: { sha: headA } }, { name: 'feature', commit: { sha: headB } }],
      [commitsPath(headA, 1)]: firstPage,
      [commitsPath(headA, 2)]: [{ sha: sharedCommit }],
      [commitsPath(headB, 1)]: [{ sha: headB }, { sha: sharedCommit }],
      [issuesPath(1)]: [],
    });
    const branches = await read();
    expect(branches.items).toEqual([]);
    expect(branches.nextCursor).toEqual({ phase: 'commits', heads: [headA, headB], headIndex: 0, page: 1, nextBranchPage: null });
    const first = await read(branches.nextCursor);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toMatchObject({ phase: 'commits', heads: [headA, headB], headIndex: 0, page: 2 });
    const second = await read(first.nextCursor);
    expect(second.items).toEqual([{ kind: 'commit', objectId: sharedCommit }]);
    expect(second.nextCursor).toMatchObject({ phase: 'commits', headIndex: 1, page: 1 });
    const feature = await read(second.nextCursor);
    expect(feature.items).toEqual([{ kind: 'commit', objectId: headB }, { kind: 'commit', objectId: sharedCommit }]);
    expect(feature.nextCursor).toEqual({ phase: 'issues', page: 1 });
    expect(await read(feature.nextCursor)).toEqual({ items: [], nextCursor: null });
    expect(paths.filter(path => path.includes('/branches?'))).toEqual([branchesPath(1)]);
    expect(paths.filter(path => path.includes('/commits?'))).toEqual([commitsPath(headA, 1), commitsPath(headA, 2), commitsPath(headB, 1)]);
  });

  it('continues branch pagination even when a full page shares the same head', async () => {
    const { read } = fixture({
      [branchesPath(1)]: Array.from({ length: 100 }, (_, i) => ({ name: `branch-${i}`, commit: { sha: headA } })),
      [commitsPath(headA, 1)]: [{ sha: headA }],
      [branchesPath(2)]: [{ name: 'last-branch', commit: { sha: headB } }],
      [commitsPath(headB, 1)]: [{ sha: headB }],
    });
    const first = await read();
    expect(first.nextCursor).toMatchObject({ heads: [headA], nextBranchPage: 2 });
    const commits = await read(first.nextCursor);
    expect(commits.nextCursor).toEqual({ phase: 'branches', page: 2 });
    const second = await read(commits.nextCursor);
    expect(second.nextCursor).toMatchObject({ heads: [headB], nextBranchPage: null });
    expect((await read(second.nextCursor)).nextCursor).toEqual({ phase: 'issues', page: 1 });
  });

  it('paginates open and closed issues and PRs as distinct contribution kinds', async () => {
    const { read, paths } = fixture({
      [issuesPath(1)]: Array.from({ length: 100 }, (_, i) => ({ number: i + 1, state: 'closed', ...(i === 0 ? { pull_request: { url: 'unused' } } : {}) })),
      [issuesPath(2)]: [{ number: 101, state: 'open', pull_request: { url: 'unused' } }],
    });
    const first = await read({ phase: 'issues', page: 1 });
    expect(first.items).toHaveLength(100);
    expect(first.items[0]).toEqual({ kind: 'pull_request', objectId: '1' });
    expect(first.items[1]).toEqual({ kind: 'issue', objectId: '2' });
    expect(first.nextCursor).toEqual({ phase: 'issues', page: 2 });
    expect(await read(first.nextCursor)).toEqual({ items: [{ kind: 'pull_request', objectId: '101' }], nextCursor: null });
    expect(paths.filter(path => path.includes('/issues?'))).toEqual([issuesPath(1), issuesPath(2)]);
  });

  it('still discovers issues in a repository with no commits or branches', async () => {
    const { read, paths } = fixture({ [branchesPath(1)]: [], [issuesPath(1)]: [{ number: 1 }] });
    const empty = await read();
    expect(empty).toEqual({ items: [], nextCursor: { phase: 'issues', page: 1 } });
    expect(await read(empty.nextCursor)).toEqual({ items: [{ kind: 'issue', objectId: '1' }], nextCursor: null });
    expect(paths.some(path => path.includes('/commits?'))).toBe(false);
  });

  it('retains installation membership, public visibility, and stable repository identity checks', async () => {
    for (const overrides of [
      { '/installation/repositories?per_page=100&page=1': { repositories: [] } },
      { [base]: { ...repo, private: true } },
    ]) {
      const { read, paths } = fixture(overrides);
      await expect(read()).rejects.toMatchObject({ code: 'REPOSITORY_UNAVAILABLE' });
      expect(paths).not.toContain(branchesPath(1));
    }
    const { provider, paths } = fixture({});
    await expect(provider.listContributionHistory!({ ...input, repositoryId: '82', cursor: null })).rejects.toMatchObject({ code: 'REPOSITORY_UNAVAILABLE' });
    expect(paths).not.toContain(branchesPath(1));
  });

  it('propagates an upstream failure and allows retrying the same unmodified cursor', async () => {
    const { read, paths } = fixture({
      [commitsPath(headA, 2)]: (count: number) => count === 1 ? new Response('{}', { status: 429 }) : [{ sha: sharedCommit }],
    });
    const cursor: GitHubContributionHistoryCursor = { phase: 'commits', heads: [headA], headIndex: 0, page: 2, nextBranchPage: null };
    const before = structuredClone(cursor);
    await expect(read(cursor)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' });
    expect(cursor).toEqual(before);
    expect(await read(cursor)).toEqual({ items: [{ kind: 'commit', objectId: sharedCommit }], nextCursor: { phase: 'issues', page: 1 } });
    expect(paths.filter(path => path.includes('/commits?'))).toEqual([commitsPath(headA, 2), commitsPath(headA, 2)]);
  });

  it('rejects malformed GitHub object identifiers instead of enqueueing invalid contributions', async () => {
    await expect(fixture({ [branchesPath(1)]: [{ commit: { sha: 'main' } }] }).read()).rejects.toMatchObject({ code: 'GITHUB_INVALID_RESPONSE' });
    await expect(fixture({ [commitsPath(headA, 1)]: [{ sha: 'short' }] }).read({ phase: 'commits', heads: [headA], headIndex: 0, page: 1, nextBranchPage: null })).rejects.toMatchObject({ code: 'GITHUB_INVALID_RESPONSE' });
    await expect(fixture({ [issuesPath(1)]: [{ number: 0 }] }).read({ phase: 'issues', page: 1 })).rejects.toMatchObject({ code: 'GITHUB_INVALID_RESPONSE' });
  });
});
