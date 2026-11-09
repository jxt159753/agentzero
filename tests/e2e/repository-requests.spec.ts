import { test, expect, type Page, type Route } from '@playwright/test';
import type { RepositoryRequestDto } from '../../packages/contracts/src/repository-requests.js';

const userId = '19000000-0000-4000-8000-000000000001';
const requestId = '29000000-0000-4000-8000-000000000001';
const secondRequestId = '29000000-0000-4000-8000-000000000002';
const repositoryId = '39000000-0000-4000-8000-000000000001';
const operationId = '49000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-07T08:00:00.000Z';
const repositoryUrl = 'https://github.com/contributor/own-project';
const respond = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function requestRecord(): RepositoryRequestDto {
  return { id: requestId, user_id: userId, applicant_login: 'contributor', owner: 'contributor', name: 'own-project', repository_url: repositoryUrl, reason: '开发自己的开源工具', status: 'pending', version: '1', repository_id: null, review_reason: null, reviewer_user_id: null, reviewed_at: null, created_at: timestamp, updated_at: timestamp };
}

async function mockRequests(page: Page, options: { admin?: boolean; lostSubmission?: boolean; lostReview?: boolean; reviewConflict?: boolean; paged?: boolean } = {}) {
  let rows: RepositoryRequestDto[] = options.admin ? [requestRecord(), { ...requestRecord(), id: secondRequestId, name: 'second-project', repository_url: 'https://github.com/contributor/second-project' }] : options.paged ? [{ ...requestRecord(), status: 'rejected', review_reason: '请先开放仓库并安装 App' }] : [];
  const pageTwo: RepositoryRequestDto = { ...requestRecord(), id: secondRequestId, name: 'approved-project', repository_url: 'https://github.com/contributor/approved-project', status: 'approved', repository_id: repositoryId, review_reason: '公开仓库与安装已核对' };
  let loseSubmission = options.lostSubmission ?? false, loseReview = options.lostReview ?? false, conflict = options.reviewConflict ?? false;
  let submissions = 0, approvals = 0;
  const replies = new Map<string, RepositoryRequestDto>();
  const writes: { path: string; body: Record<string, unknown>; key: string; csrf: string }[] = [];
  const cursors: (string | null)[] = [];
  await page.context().addCookies([{ name: 'az_csrf', value: 'request-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', '');
    const body = request.method() === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    const key = request.headers()['idempotency-key'] ?? '';
    if (request.method() !== 'GET' && path.includes('/repository-requests')) writes.push({ path, body, key, csrf: request.headers()['x-csrf-token'] ?? '' });
    if (path === '/me') return respond(route, { actor: { type: 'user', userId }, user: { id: userId, github_login: 'contributor', display_name: '仓库申请人', status: 'active', role: options.admin ? 'admin' : 'member' } });
    if (path === '/agents' || path === '/repositories' || path === '/admin/users') return respond(route, { items: [], next_cursor: null });
    if (path === '/contributions') return respond(route, { settings: { commit_points: '5', pull_request_points: '20', issue_points: '3', version: '1', updated_at: timestamp }, preference: { agent_id: null, version: '0', updated_at: null }, items: [], next_cursor: null });
    if (path === '/admin/github/installations') return respond(route, { items: [{ installation_id: '901', account_login: 'contributor', status: 'active', updated_at: timestamp }, { installation_id: '902', account_login: 'suspended-owner', status: 'suspended', updated_at: timestamp }] });
    if (path === '/repository-requests') {
      if (request.method() === 'GET') {
        const cursor = url.searchParams.get('cursor'); cursors.push(cursor);
        return respond(route, { items: options.paged && cursor ? [pageTwo] : rows, next_cursor: options.paged && !cursor ? 'next-request-page' : null });
      }
      if (!replies.has(key)) { const row = { ...requestRecord(), repository_url: String(body.repository_url), reason: String(body.reason) }; rows = [row]; replies.set(key, row); submissions++; }
      if (loseSubmission) { loseSubmission = false; return route.abort('failed'); }
      return respond(route, { ...replies.get(key), operation_id: operationId }, 201);
    }
    if (path === '/admin/repository-requests') {
      const status = url.searchParams.get('status');
      return respond(route, { items: rows.filter(row => !status || row.status === status), next_cursor: null });
    }
    const review = /^\/admin\/repository-requests\/([^/]+)\/review$/.exec(path);
    if (review) {
      const current = rows.find(row => row.id === review[1])!;
      if (conflict) { conflict = false; rows = rows.map(row => row.id === current.id ? { ...row, version: '2' } : row); return respond(route, { error: { code: 'REPOSITORY_REQUEST_VERSION_CONFLICT' } }, 409); }
      if (!replies.has(key)) {
        const updated: RepositoryRequestDto = { ...current, version: (BigInt(current.version) + 1n).toString(), status: body.decision === 'approve' ? 'approved' : 'rejected', repository_id: body.decision === 'approve' ? repositoryId : null, review_reason: String(body.reason) };
        rows = rows.map(row => row.id === updated.id ? updated : row); replies.set(key, updated); if (body.decision === 'approve') approvals++;
      }
      if (loseReview) { loseReview = false; return route.abort('failed'); }
      return respond(route, { ...replies.get(key), operation_id: operationId });
    }
    return respond(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  return { writes, cursors, submissions: () => submissions, approvals: () => approvals };
}

test('用户安装入口明确，申请响应丢失后原样重试且显示待审核', async ({ page }) => {
  const state = await mockRequests(page, { lostSubmission: true });
  await page.goto('/contributions');
  const panel = page.getByRole('region', { name: '自己的仓库申请', exact: true });
  await expect(panel.getByRole('link', { name: '安装 GitHub App ↗', exact: true })).toHaveAttribute('href', 'https://github.com/apps/agentzero-jxt159753/installations/new');
  await expect(panel.getByText('提交申请不会发放积分。', { exact: false })).toBeVisible();
  await panel.getByRole('textbox', { name: '仓库链接', exact: true }).fill(repositoryUrl);
  await panel.getByRole('textbox', { name: '申请说明', exact: true }).fill('开发自己的开源工具');
  await panel.getByRole('button', { name: '提交仓库申请', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(panel.getByRole('textbox', { name: '仓库链接', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '提交仓库申请', exact: true }).click();
  await expect(panel.getByText('待审核', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]!.key).toBe(state.writes[0]!.key);
  expect(state.writes[0]!.body).toEqual({ repository_url: repositoryUrl, reason: '开发自己的开源工具' });
  expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
  expect(state.writes.every(write => write.csrf === 'request-csrf' && Boolean(write.key))).toBe(true);
  expect(state.submissions()).toBe(1);
});

test('本人申请显示拒绝理由和准入结果，手机上可按游标翻页', async ({ page }) => {
  const state = await mockRequests(page, { paged: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/contributions');
  const panel = page.getByRole('region', { name: '自己的仓库申请', exact: true });
  await expect(panel.getByText('拒绝理由：请先开放仓库并安装 App', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(panel.getByText('已准入', { exact: true })).toBeVisible();
  await expect(panel.getByText('审核说明：公开仓库与安装已核对', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(panel.getByText('已拒绝', { exact: true })).toBeVisible();
  expect(state.cursors).toContain('next-request-page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('管理员逐条审批，仅选择有效安装，批准重试与拒绝均保留审核理由', async ({ page }) => {
  const state = await mockRequests(page, { admin: true, lostReview: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: '仓库准入', exact: true }).click();
  const panel = page.getByRole('region', { name: '仓库申请审核', exact: true });
  const first = panel.getByRole('article', { name: '审核 contributor/own-project', exact: true });
  await expect(first.getByRole('combobox', { name: '申请使用的安装', exact: true }).getByRole('option')).toHaveCount(2);
  await first.getByRole('combobox', { name: '申请使用的安装', exact: true }).selectOption('901');
  await first.getByRole('textbox', { name: '审核说明', exact: true }).fill('公开仓库和安装已核对');
  await first.getByRole('button', { name: '批准此申请', exact: true }).click();
  await expect(first.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(first.getByRole('combobox', { name: '审核决定', exact: true })).toBeDisabled();
  await first.getByRole('button', { name: '批准此申请', exact: true }).click();
  await expect(first).toHaveCount(0);
  const second = panel.getByRole('article', { name: '审核 contributor/second-project', exact: true });
  await second.getByRole('combobox', { name: '审核决定', exact: true }).selectOption('reject');
  await expect(second.getByRole('button', { name: '拒绝此申请', exact: true })).toBeDisabled();
  await second.getByRole('textbox', { name: '拒绝理由', exact: true }).fill('请先授权该仓库');
  await second.getByRole('button', { name: '拒绝此申请', exact: true }).click();
  await panel.getByRole('combobox', { name: '申请状态', exact: true }).selectOption('rejected');
  await expect(panel.getByText('拒绝理由：请先授权该仓库', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(3);
  expect(state.writes[0]!.body).toEqual({ version: '1', decision: 'approve', reason: '公开仓库和安装已核对', installation_id: '901' });
  expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
  expect(state.writes[1]!.key).toBe(state.writes[0]!.key);
  expect(state.writes[2]!.body).toEqual({ version: '1', decision: 'reject', reason: '请先授权该仓库' });
  expect(state.approvals()).toBe(1);
});

test('审核版本冲突后刷新申请并使用新版本，不自动批准', async ({ page }) => {
  const state = await mockRequests(page, { admin: true, reviewConflict: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: '仓库准入', exact: true }).click();
  const panel = page.getByRole('region', { name: '仓库申请审核', exact: true });
  const first = panel.getByRole('article', { name: '审核 contributor/own-project', exact: true });
  await first.getByRole('combobox', { name: '审核决定', exact: true }).selectOption('reject');
  await first.getByRole('textbox', { name: '拒绝理由', exact: true }).fill('需要补充说明');
  await first.getByRole('button', { name: '拒绝此申请', exact: true }).click();
  await expect(first.getByRole('alert')).toContainText('此仓库申请已由其他操作更新');
  expect(state.writes).toHaveLength(1);
  await panel.getByRole('button', { name: '刷新审核列表', exact: true }).click();
  await expect(first.getByRole('combobox', { name: '审核决定', exact: true })).toHaveValue('approve');
  await first.getByRole('combobox', { name: '审核决定', exact: true }).selectOption('reject');
  await first.getByRole('textbox', { name: '拒绝理由', exact: true }).fill('核对最新申请后拒绝');
  await first.getByRole('button', { name: '拒绝此申请', exact: true }).click();
  await expect(first).toHaveCount(0);
  expect(state.writes[1]!.body.version).toBe('2');
  expect(state.writes[1]!.key).not.toBe(state.writes[0]!.key);
  expect(state.approvals()).toBe(0);
});
