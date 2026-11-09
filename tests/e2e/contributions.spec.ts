import { test, expect, type Page, type Route } from '@playwright/test';
import type { ContributionRewardDto, ContributionRewardPreferenceDto, ContributionRewardSettingsDto } from '../../packages/contracts/src/contributions.js';

const userId = '18000000-0000-4000-8000-000000000001';
const agentId = '28000000-0000-4000-8000-000000000001';
const rewardId = '38000000-0000-4000-8000-000000000001';
const operationId = '48000000-0000-4000-8000-000000000001';
const repositoryId = '58000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-07T08:00:00.000Z';
const contributionUrl = 'https://github.com/example/project/pull/123';
const respond = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function reward(): ContributionRewardDto {
  return { id: rewardId, repository_id: repositoryId, kind: 'pull_request', object_id: '123', user_id: userId, agent_id: agentId, points: '20', settings_version: '1', url: contributionUrl, title: '补充贡献说明', github_created_at: timestamp, transaction_id: operationId, created_at: timestamp };
}

async function mockContributions(page: Page, options: { admin?: boolean; lostResponse?: boolean; disabled?: boolean; staleSettings?: boolean; records?: boolean } = {}) {
  let settings: ContributionRewardSettingsDto = { commit_points: options.disabled ? '0' : '5', pull_request_points: options.disabled ? '0' : '20', issue_points: options.disabled ? '0' : '3', version: '1', updated_at: timestamp };
  let preference: ContributionRewardPreferenceDto = { agent_id: null, version: '0', updated_at: null };
  let record: ContributionRewardDto | null = options.records ? reward() : null;
  let loseNext = options.lostResponse ?? false, rejectNext = options.staleSettings ?? false, payouts = 0;
  const keys = new Set<string>();
  const writes: { path: string; body: Record<string, unknown>; key: string; csrf: string }[] = [];
  const cursors: (string | null)[] = [];
  await page.context().addCookies([{ name: 'az_csrf', value: 'contributions-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', '');
    const body = request.method() === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    const key = request.headers()['idempotency-key'] ?? '';
    if (request.method() !== 'GET' && (path.startsWith('/contributions') || path === '/admin/contribution-rewards')) writes.push({ path, body, key, csrf: request.headers()['x-csrf-token'] ?? '' });
    if (path === '/me') return respond(route, { actor: { type: 'user', userId }, user: { id: userId, github_login: 'contributor', display_name: '贡献者', status: 'active', role: options.admin ? 'admin' : 'member' } });
    if (path === '/agents') return respond(route, { items: [{ id: agentId, name: '贡献收款 Agent', owner_user_id: userId, status: 'active', created_at: timestamp, updated_at: timestamp }], next_cursor: null });
    if (path === '/repository-requests') return respond(route, { items: [], next_cursor: null });
    if (path === '/contributions') {
      const cursor = url.searchParams.get('cursor'); cursors.push(cursor);
      return respond(route, { settings, preference, items: record && !cursor ? [record] : [], next_cursor: record && !cursor ? 'next-contribution-page' : null });
    }
    if (path === '/contributions/preference') {
      preference = { agent_id: body.agent_id as string | null, version: (BigInt(preference.version) + 1n).toString(), updated_at: timestamp };
      return respond(route, { ...preference, operation_id: operationId });
    }
    if (path === '/contributions/claim') {
      if (!keys.has(key)) { keys.add(key); record = reward(); payouts++; }
      if (loseNext) { loseNext = false; return route.abort('failed'); }
      return respond(route, { ...record, operation_id: operationId });
    }
    if (path === '/admin/users') return respond(route, { items: [], next_cursor: null });
    if (path === '/admin/contribution-rewards') {
      if (request.method() === 'GET') return respond(route, settings);
      if (rejectNext) { rejectNext = false; settings = { ...settings, commit_points: '9', version: '2' }; return respond(route, { error: { code: 'CONTRIBUTION_VERSION_CONFLICT' } }, 409); }
      settings = { commit_points: String(body.commit_points), pull_request_points: String(body.pull_request_points), issue_points: String(body.issue_points), version: (BigInt(settings.version) + 1n).toString(), updated_at: timestamp };
      return respond(route, { ...settings, operation_id: operationId });
    }
    return respond(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  return { writes, cursors, payouts: () => payouts, changeSettings: () => { settings = { ...settings, pull_request_points: '30', version: '2' }; } };
}

test('设置和关闭自动收款使用当前版本，手机页面保持可用', async ({ page }) => {
  const state = await mockContributions(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/contributions');
  await expect(page.getByRole('heading', { name: 'GitHub 贡献', exact: true })).toBeVisible();
  await expect(page.getByText('奖励归贡献作者，PR 无需合并', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: '自动收款 Agent', exact: true }).selectOption(agentId);
  await page.getByRole('button', { name: '保存自动收款', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存自动收款', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: '自动收款 Agent', exact: true }).selectOption('');
  await page.getByRole('button', { name: '保存自动收款', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存自动收款', exact: true })).toBeDisabled();
  expect(state.writes.map(write => write.body)).toEqual([{ agent_id: agentId, version: '0' }, { agent_id: null, version: '1' }]);
  expect(state.writes.every(write => write.csrf === 'contributions-csrf' && Boolean(write.key))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('补领响应丢失后即使金额刷新也用原请求重试，仅记一次到账', async ({ page }) => {
  const state = await mockContributions(page, { lostResponse: true });
  await page.goto('/contributions');
  await page.getByRole('combobox', { name: '补领收款 Agent', exact: true }).selectOption(agentId);
  await page.getByRole('textbox', { name: 'GitHub 贡献链接', exact: true }).fill(contributionUrl);
  await page.getByRole('button', { name: '核验并领取积分', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(page.getByRole('textbox', { name: 'GitHub 贡献链接', exact: true })).toBeDisabled();
  state.changeSettings();
  await page.getByRole('button', { name: '刷新贡献', exact: true }).click();
  await expect(page.getByText('30 积分 / 个', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核验并领取积分', exact: true }).click();
  await expect(page.getByText('此贡献已到账 20 积分。', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: '补充贡献说明', exact: true })).toHaveAttribute('href', contributionUrl);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0]!.body).toEqual({ agent_id: agentId, url: contributionUrl, version: '1' });
  expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
  expect(state.writes[1]!.key).toBe(state.writes[0]!.key);
  expect(state.payouts()).toBe(1);
});

test('未配置金额时显示关闭状态，到账记录按游标分页', async ({ page }) => {
  const state = await mockContributions(page, { disabled: true, records: true });
  await page.goto('/contributions');
  await expect(page.getByText('暂未开启', { exact: true })).toHaveCount(3);
  await page.getByRole('combobox', { name: '补领收款 Agent', exact: true }).selectOption(agentId);
  await page.getByRole('textbox', { name: 'GitHub 贡献链接', exact: true }).fill(contributionUrl);
  await expect(page.getByRole('button', { name: '核验并领取积分', exact: true })).toBeDisabled();
  await page.getByRole('region', { name: '积分到账记录', exact: true }).getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('link', { name: '补充贡献说明', exact: true })).toHaveCount(0);
  await page.getByRole('region', { name: '积分到账记录', exact: true }).getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.getByRole('link', { name: '补充贡献说明', exact: true })).toBeVisible();
  expect(state.cursors).toContain('next-contribution-page');
  expect(state.writes).toHaveLength(0);
});

test('后台保存三类整数金额，保留超过安全整数的精度并允许关闭一类', async ({ page }) => {
  const state = await mockContributions(page, { admin: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: 'GitHub 奖励', exact: true }).click();
  await page.getByRole('textbox', { name: 'Commit 奖励积分', exact: true }).fill('9007199254740993');
  await page.getByRole('textbox', { name: 'Pull Request 奖励积分', exact: true }).fill('25');
  await page.getByRole('textbox', { name: 'Issue 奖励积分', exact: true }).fill('0');
  await page.getByRole('textbox', { name: '配置理由', exact: true }).fill('调整提交奖励');
  await page.getByRole('button', { name: '保存奖励配置', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '配置理由', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Commit 奖励积分', exact: true })).toHaveValue('9007199254740993');
  expect(state.writes[0]!.body).toEqual({ version: '1', commit_points: '9007199254740993', pull_request_points: '25', issue_points: '0', reason: '调整提交奖励' });
});

test('后台遇到版本冲突先显示错误，刷新后使用新版本保存', async ({ page }) => {
  const state = await mockContributions(page, { admin: true, staleSettings: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: 'GitHub 奖励', exact: true }).click();
  await page.getByRole('textbox', { name: '配置理由', exact: true }).fill('保存配置');
  await page.getByRole('button', { name: '保存奖励配置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('GitHub 奖励金额或设置已变化');
  await page.getByRole('button', { name: '刷新奖励配置', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Commit 奖励积分', exact: true })).toHaveValue('9');
  await page.getByRole('textbox', { name: '配置理由', exact: true }).fill('确认更新后的配置');
  await page.getByRole('button', { name: '保存奖励配置', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '配置理由', exact: true })).toHaveValue('');
  expect(state.writes[1]!.body.version).toBe('2');
  expect(state.writes[1]!.key).not.toBe(state.writes[0]!.key);
});
