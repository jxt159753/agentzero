import { test, expect, type Page, type Route } from '@playwright/test';

// UI contract tests use mocked HTTP responses. Real OAuth and PostgreSQL acceptance are separate.
const userId = '10000000-0000-4000-8000-000000000001';
const agentId = '20000000-0000-4000-8000-000000000001';
const keyId = '30000000-0000-4000-8000-000000000001';
const operationId = '40000000-0000-4000-8000-000000000001';
const user = { id: userId, github_login: 'explorer', display_name: '探索者', status: 'active', role: 'member' };
const initialAgent = { id: agentId, name: '研究助手', status: 'active', owner_user_id: userId, version: '1', deleted_at: null as string | null, created_at: '2026-11-07T08:00:00.000Z' };
const initialPolicy = { version: '1', can_accept_task: false, can_collaborate: false, can_trade: false, can_redeem_api: false, single_spend_limit: '0', daily_spend_limit: '0' };
const respond = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockConsole(page: Page, options: { pending?: boolean; largeBalance?: boolean; empty?: boolean; admin?: boolean; deleted?: boolean; deleteBlocked?: boolean; recycleLostResponse?: boolean } = {}) {
  let signedIn = true;
  let agent = { ...initialAgent, deleted_at: options.deleted ? '2026-11-07T09:00:00.000Z' : null };
  let policy = { ...initialPolicy };
  let agents = options.empty ? [] : [agent];
  let keys: { id: string; label: string; expires_at: string; revoked_at: string | null; created_at: string }[] = [];
  const writes: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  let limit = '0'; let issued = '0';
  let recycled = '0', recovery = '100', lastRecycle: string | undefined;
  let loseRecycleResponse = options.recycleLostResponse ?? false;
  await page.context().addCookies([{ name: 'az_csrf', value: 'csrf-test-token', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const body = method === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    if (method !== 'GET') writes.push({ path, headers: request.headers(), body });
    if (path === '/me') return respond(route, signedIn ? { actor: { type: 'user', userId }, user: { ...user, status: options.pending ? 'pending' : 'active', role: options.admin ? 'admin' : 'member' } } : { error: { code: 'UNAUTHENTICATED' } }, signedIn ? 200 : 401);
    if (path === '/auth/logout') { signedIn = false; return respond(route, {}); }
    if (path === '/agents' && method === 'GET') return respond(route, { items: agents, next_cursor: null });
    if (path === '/agents' && method === 'POST') { agent = { ...agent, name: body.name as string }; agents = [agent]; return respond(route, { ...agent, operation_id: operationId }, 201); }
    if (path === `/agents/${agentId}`) {
      if (method === 'DELETE') {
        if (options.deleteBlocked) return respond(route, { error: { code: 'AGENT_DELETE_BLOCKED', message: '暂时无法删除：仍持有土地，请先完成转让。' } }, 409);
        agent = { ...agent, deleted_at: '2026-11-07T09:00:00.000Z', version: '2' }; agents = [];
        return respond(route, { id: agentId, deleted: true, deleted_at: agent.deleted_at, version: '2', operation_id: operationId });
      }
      if (method === 'PATCH') agent = { ...agent, ...body, version: (BigInt(agent.version) + 1n).toString() };
      return respond(route, { ...agent, ...(method === 'PATCH' ? { operation_id: operationId } : {}) });
    }
    if (path === `/agents/${agentId}/policy`) { if (method === 'PUT') policy = { ...policy, ...body, version: (BigInt(policy.version) + 1n).toString() }; return respond(route, { ...policy, ...(method === 'PUT' ? { operation_id: operationId } : {}) }); }
    if (path === `/agents/${agentId}/wallet`) return respond(route, { available: options.largeBalance ? '9007199254740993' : '0', reserved: '0', daily_spent: '0', held: '0', daily_usage: '0', business_date: '2026-11-07' });
    if (path === `/agents/${agentId}/transactions`) return respond(route, { items: [], next_cursor: null });
    if (path === `/agents/${agentId}/keys` && method === 'GET') return respond(route, { items: keys, next_cursor: null });
    if (path === `/agents/${agentId}/keys` && method === 'POST') { const key = { id: keyId, label: body.label as string, expires_at: '2099-02-05T08:00:00.000Z', revoked_at: null, created_at: '2026-11-07T08:00:00.000Z' }; keys.push(key); return respond(route, { ...key, secret: `az_${keyId}.one-time-only-secret`, secret_shown: false, operation_id: operationId }, 201); }
    if (path === `/agents/${agentId}/keys/${keyId}/revoke`) { keys = keys.map((key) => ({ ...key, revoked_at: '2026-11-07T09:00:00.000Z' })); return respond(route, { id: keyId, operation_id: operationId }); }
    if (path === '/admin/users') return respond(route, { items: [], next_cursor: null });
    if (path.startsWith('/admin/issuance-periods/')) { if (method === 'PUT') limit = body.limit_points as string; return respond(route, { period: path.split('/').at(-1), limit_points: limit, issued_points: issued, ...(method === 'PUT' ? { operation_id: operationId } : {}) }); }
    if (path === '/admin/issuances') { issued = (BigInt(issued) + BigInt(body.amount as string)).toString(); return respond(route, { id: operationId, operation_id: operationId }); }
    if (path === '/admin/economy') return respond(route, { user_available_points: '0', user_reserved_points: '0', reward_pool_points: (BigInt(issued) + BigInt(recycled)).toString(), reward_reserved_points: '0', recovery_points: recovery, refund_reserve_points: '40', recyclable_points: (BigInt(recovery) - 40n).toString(), total_issued_points: issued, recycled_points: recycled });
    if (path === '/admin/recycles') {
      if (lastRecycle !== body.business_id) { lastRecycle = String(body.business_id); recycled = (BigInt(recycled) + BigInt(body.amount as string)).toString(); recovery = (BigInt(recovery) - BigInt(body.amount as string)).toString(); }
      if (loseRecycleResponse) { loseRecycleResponse = false; return route.abort('failed'); }
      return respond(route, { transaction_id: operationId, operation_id: operationId });
    }
    if (path === '/admin/ledger' || path === '/admin/audit-events') return respond(route, { items: [], next_cursor: null });
    if (path === '/admin/reconciliation') return respond(route, { ok: true, differences: [] });
    return respond(route, { error: { code: 'ACCESS_DENIED', request_id: 'hidden-resource' } }, 403);
  });
  return { writes };
}

test('登录入口与待准入页面不显示 Agent 写操作', async ({ page }) => {
  await page.route('**/api/v1/me', (route) => respond(route, { error: { code: 'UNAUTHENTICATED' } }, 401));
  await page.goto('/');
  await expect(page.getByRole('link', { name: '使用 GitHub 登录' })).toHaveAttribute('href', '/api/v1/auth/github/start');
  await page.screenshot({ path: 'test-results/login-desktop.png', fullPage: true });
  await page.unroute('**/api/v1/me');
  await mockConsole(page, { pending: true });
  await page.reload();
  await expect(page.getByRole('heading', { name: '你的工作空间，即将开启' })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建 Agent', exact: true })).toHaveCount(0);
});

test('创建 Agent、权限版本、一次性凭证、撤销、暂停与退出', async ({ page }) => {
  const { writes } = await mockConsole(page, { empty: true });
  await page.goto('/agents');
  await page.getByRole('button', { name: '+ 创建 Agent', exact: true }).click();
  await page.getByLabel('Agent 名称').fill('研究助手');
  await page.getByRole('button', { name: '确认创建' }).click();
  await expect(page).toHaveURL(`/agents/${agentId}`);
  await expect(page.getByTestId('available-balance')).toHaveText('0');
  await expect(page.getByRole('switch', { name: '资产交易' })).not.toBeChecked();
  await page.getByRole('switch', { name: '资产交易' }).check();
  await page.getByLabel('单笔支出上限').fill('100');
  await page.getByLabel('每日支出上限').fill('300');
  await page.getByRole('button', { name: '保存权限' }).click();
  await expect(page.getByText('当前版本 2')).toBeVisible();
  expect(writes.find((write) => write.path.endsWith('/policy'))?.body).toMatchObject({ version: '1', can_trade: true, single_spend_limit: '100', daily_spend_limit: '300' });
  await page.getByLabel('凭证标签').fill('本机助手');
  await page.getByRole('button', { name: '创建凭证', exact: true }).click();
  await expect(page.getByLabel('完整访问凭证')).toHaveValue(`az_${keyId}.one-time-only-secret`);
  await page.getByRole('button', { name: '已保存，关闭' }).click();
  await expect(page.getByLabel('完整访问凭证')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('完整访问凭证')).toHaveCount(0);
  await expect(page.getByText('本机助手', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByText('已撤销', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停 Agent' }).click();
  await expect(page.getByRole('button', { name: '恢复 Agent' })).toBeVisible();
  await page.screenshot({ path: 'test-results/agent-desktop.png', fullPage: true });
  for (const write of writes) {
    expect(write.headers['x-csrf-token']).toBe('csrf-test-token');
    expect(write.headers['idempotency-key']).toMatch(/^[a-f\d-]{36}$/);
  }
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
});

test('大整数钱包及权限输入不损失精度，窄屏没有页面溢出', async ({ page }) => {
  const { writes } = await mockConsole(page, { largeBalance: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/agents/${agentId}`);
  await expect(page.getByTestId('available-balance')).toHaveText('9,007,199,254,740,993');
  await page.getByLabel('单笔支出上限').fill('9007199254740993');
  await page.getByLabel('每日支出上限').fill('9007199254740993');
  await page.getByRole('button', { name: '保存权限' }).click();
  await expect(page.getByText('当前版本 2')).toBeVisible();
  expect(writes.find((write) => write.path.endsWith('/policy'))?.body.daily_spend_limit).toBe('9007199254740993');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/agent-mobile.png', fullPage: true });
});

test('权限版本冲突保留输入，并明确提示刷新', async ({ page }) => {
  await mockConsole(page);
  await page.route(`**/api/v1/agents/${agentId}/policy`, async (route) => route.request().method() === 'PUT' ? respond(route, { error: { code: 'POLICY_VERSION_CONFLICT', request_id: 'policy-conflict' } }, 409) : route.fallback());
  await page.goto(`/agents/${agentId}`);
  await page.getByLabel('每日支出上限').fill('700');
  await page.getByRole('button', { name: '保存权限' }).click();
  await expect(page.getByRole('alert')).toContainText('权限已在别处修改');
  await expect(page.getByLabel('每日支出上限')).toHaveValue('700');
  await expect(page.getByRole('button', { name: '刷新权限' })).toBeVisible();
});

test('响应丢失后相同命令沿用原幂等键', async ({ page }) => {
  await mockConsole(page, { empty: true });
  const requestKeys: string[] = [];
  await page.route('**/api/v1/agents', async (route) => {
    if (route.request().method() === 'POST') {
      requestKeys.push(route.request().headers()['idempotency-key'] ?? '');
      if (requestKeys.length === 1) return route.abort('failed');
    }
    return route.fallback();
  });
  await page.goto('/agents');
  await page.getByRole('button', { name: '+ 创建 Agent', exact: true }).click();
  await page.getByLabel('Agent 名称').fill('研究助手');
  await page.getByRole('button', { name: '确认创建' }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
  await page.getByRole('button', { name: '确认创建' }).click();
  await expect(page).toHaveURL(`/agents/${agentId}`);
  expect(requestKeys).toHaveLength(2);
  expect(requestKeys[0]).toBe(requestKeys[1]);
});

test('管理员设置预算、发行并查看对账', async ({ page }) => {
  const { writes } = await mockConsole(page, { admin: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: '发行管理' }).click();
  await page.getByLabel('月发行上限', { exact: true }).fill('100');
  await page.getByLabel('预算调整理由').fill('内测奖励预算');
  await page.getByRole('button', { name: '保存预算' }).click();
  await expect(page.getByLabel('月发行上限', { exact: true })).toHaveValue('100');
  await page.getByLabel('本次发行积分').fill('80');
  await page.getByLabel('发行理由', { exact: true }).fill('首批任务奖励');
  await page.getByRole('button', { name: '确认发行' }).click();
  await expect(page.getByText('20', { exact: true })).toBeVisible();
  expect(writes.find((write) => write.path === '/admin/issuances')?.body).toMatchObject({ amount: '80', reason: '首批任务奖励' });
  await page.getByRole('tab', { name: '账本与审计' }).click();
  await page.getByRole('button', { name: '生成对账报告' }).click();
  await expect(page.getByLabel('对账报告')).toContainText('"ok": true');
});

test('管理员按可回流额度补充奖励池，响应丢失后保留原请求重试', async ({ page }) => {
  const { writes } = await mockConsole(page, { admin: true, recycleLostResponse: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: '发行管理' }).click();
  const panel = page.getByRole('region', { name: '经济运行与回流' });
  await expect(panel).toContainText('兑换退款准备金');
  await page.getByLabel('本次回流积分').fill('70');
  await page.getByLabel('回流用途与依据').fill('补充已审核任务预算');
  await expect(page.getByRole('button', { name: '回流到平台奖励池' })).toBeDisabled();
  await page.getByLabel('本次回流积分').fill('40');
  await page.getByRole('button', { name: '回流到平台奖励池' }).click();
  await expect(page.getByLabel('本次回流积分')).toBeDisabled();
  await expect(panel.getByRole('alert')).toContainText('操作结果尚未确认');
  await page.getByRole('button', { name: '按原请求重试' }).click();
  await expect(page.getByLabel('本次回流积分')).toHaveValue('');
  await expect(panel).toContainText('累计回流 40');
  const attempts = writes.filter(write => write.path === '/admin/recycles');
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.body).toEqual(attempts[1]!.body);
  expect(attempts[0]!.headers['idempotency-key']).toBe(attempts[1]!.headers['idempotency-key']);
  await page.getByRole('heading', { name: '运营管理', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/public-economy-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.getByRole('heading', { name: '经济运行与回流', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/public-economy-mobile.png', fullPage: true });
});

test('删除 Agent 需要确认名称，并携带当前版本与防重放信息', async ({ page }) => {
  const { writes } = await mockConsole(page);
  await page.goto(`/agents/${agentId}`);
  await page.getByRole('button', { name: '删除 Agent', exact: true }).click();
  const confirm = page.getByRole('button', { name: '确认删除 Agent', exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('输入 Agent 名称以确认删除').fill('研究助手');
  await confirm.click();
  await expect(page).toHaveURL('/agents');
  await expect(page.getByRole('heading', { name: '第一个 Agent，从这里开始' })).toBeVisible();
  const deletion = writes.find(write => write.path === `/agents/${agentId}` && write.body.version);
  expect(deletion?.body).toEqual({ version: '1' });
  expect(deletion?.headers['x-csrf-token']).toBe('csrf-test-token');
  expect(deletion?.headers['idempotency-key']).toMatch(/^[a-f\d-]{36}$/);
});

test('有资产时显示具体删除阻止原因，保留身份', async ({ page }) => {
  await mockConsole(page, { deleteBlocked: true });
  await page.goto(`/agents/${agentId}`);
  await page.getByRole('button', { name: '删除 Agent', exact: true }).click();
  await page.getByLabel('输入 Agent 名称以确认删除').fill('研究助手');
  await page.getByRole('button', { name: '确认删除 Agent', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('仍持有土地，请先完成转让');
  await expect(page).toHaveURL(`/agents/${agentId}`);
});

test('已删除身份可查看历史，但没有恢复和凭证写入入口', async ({ page }) => {
  const { writes } = await mockConsole(page, { deleted: true });
  await page.goto(`/agents/${agentId}`);
  await expect(page.getByText('已删除', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '钱包流水' })).toBeVisible();
  await expect(page.getByRole('button', { name: /恢复 Agent|暂停 Agent|创建凭证|删除 Agent/ })).toHaveCount(0);
  expect(writes).toHaveLength(0);
});
