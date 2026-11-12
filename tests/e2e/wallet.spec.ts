import { test, expect, type Page, type Route } from '@playwright/test';

const userId = '19000000-0000-4000-8000-000000000001';
const agentId = '29000000-0000-4000-8000-000000000001';
const otherId = '19000000-0000-4000-8000-000000000002';
const otherAgentId = '29000000-0000-4000-8000-000000000002';
const transactionId = '39000000-0000-4000-8000-000000000001';
const operationId = '49000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-08T08:00:00.000Z';
const respond = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockWallet(page: Page, options: { lostResponse?: boolean; largeBalance?: boolean } = {}) {
  let balance = options.largeBalance ? '9007199254740993' : '1000', agentBalance = '500', loseNext = options.lostResponse ?? false;
  const writes: { body: Record<string, unknown>; key: string; csrf: string }[] = [];
  const completed = new Set<string>(), searches: string[] = [];
  await page.context().addCookies([{ name: 'az_csrf', value: 'wallet-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', '');
    if (path === '/me') return respond(route, { actor: { type: 'user', userId }, user: { id: userId, github_login: 'explorer', display_name: '探索者', status: 'active', role: 'member' } });
    if (path === '/agents') return respond(route, { items: [{ id: agentId, name: '研究助手', owner_user_id: userId, status: 'active', version: '1', deleted_at: null, created_at: timestamp, updated_at: timestamp }], next_cursor: null });
    if (path === '/wallet') return respond(route, { user_id: userId, available: balance, initial_grant: '1000' });
    if (path === `/agents/${agentId}/wallet`) return respond(route, { available: agentBalance, reserved: '0', daily_spent: '0', held: '0', daily_usage: '0', business_date: '2026-11-08' });
    if (path === '/wallet/transactions') return respond(route, { items: [{ id: transactionId, kind: 'INITIAL_GRANT', business_key: `initial-funds:user:${userId}`, reason: '用户初始资金', created_at: timestamp, amount: '1000', side: 'debit', entries: [{ bucket: 'USER_AVAILABLE', side: 'debit', amount: '1000' }] }], next_cursor: null });
    if (path === '/wallet/recipients') {
      searches.push(url.searchParams.get('q') ?? '');
      return respond(route, { items: [{ type: 'user', id: otherId, name: '创作者', github_login: 'creator' }, { type: 'agent', id: otherAgentId, name: '创作助手', github_login: 'creator' }] });
    }
    if (path === '/wallet/transfers') {
      const body = request.postDataJSON() as { transfer_id: string; from: { type: string; id: string }; to: { type: string; id: string }; amount: string };
      writes.push({ body, key: request.headers()['idempotency-key'] ?? '', csrf: request.headers()['x-csrf-token'] ?? '' });
      if (!completed.has(body.transfer_id)) {
        completed.add(body.transfer_id);
        if (body.from.id === userId) balance = (BigInt(balance) - BigInt(body.amount)).toString();
        if (body.to.id === userId) balance = (BigInt(balance) + BigInt(body.amount)).toString();
        if (body.from.id === agentId) agentBalance = (BigInt(agentBalance) - BigInt(body.amount)).toString();
        if (body.to.id === agentId) agentBalance = (BigInt(agentBalance) + BigInt(body.amount)).toString();
      }
      if (loseNext) { loseNext = false; return route.abort('failed'); }
      return respond(route, { id: transactionId, transaction_id: transactionId, operation_id: operationId, ...body, created: true }, 201);
    }
    return respond(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  return { writes, searches, transfers: () => completed.size };
}

test('个人钱包显示初始资金，响应丢失时保留同一转账重试并刷新余额', { tag: '@smoke' }, async ({ page }) => {
  const state = await mockWallet(page, { lostResponse: true });
  await page.goto('/wallet');
  await expect(page.getByRole('heading', { name: '我的钱包', exact: true })).toBeVisible();
  await expect(page.getByTestId('user-available-balance')).toHaveText('1,000');
  await expect(page.getByRole('region', { name: '个人钱包流水', exact: true })).toContainText('初始资金');
  await page.screenshot({ path: '.local/wallet-desktop.png', fullPage: true });
  await page.getByRole('combobox', { name: '收款钱包', exact: true }).selectOption(`agent:${agentId}`);
  await page.getByRole('textbox', { name: '转账金额', exact: true }).fill('250');
  await page.getByRole('button', { name: '确认转账', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(page.getByRole('combobox', { name: '收款钱包', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '转账金额', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '刷新钱包', exact: true }).click();
  await expect(page.getByTestId('user-available-balance')).toHaveText('750');
  await page.getByRole('button', { name: '重试确认转账', exact: true }).click();
  await expect(page.getByText('已向 Agent · 研究助手 · @explorer 转账 250 积分。', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '转账金额', exact: true })).toHaveValue('');
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
  expect(state.writes[1]!.key).toBe(state.writes[0]!.key);
  expect(state.writes[0]!.csrf).toBe('wallet-csrf');
  expect(state.transfers()).toBe(1);
});

test('可从 Agent 向用户或其他 Agent 转账，手机布局保持可用', async ({ page }) => {
  const state = await mockWallet(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/wallet?from=agent:${agentId}`);
  await expect(page.getByRole('combobox', { name: '转出钱包', exact: true })).toHaveValue(`agent:${agentId}`);
  await page.screenshot({ path: '.local/wallet-mobile.png', fullPage: true });
  await page.getByRole('textbox', { name: '搜索收款方', exact: true }).fill('creator');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('combobox', { name: '收款钱包', exact: true }).selectOption(`user:${otherId}`);
  await page.getByRole('textbox', { name: '转账金额', exact: true }).fill('35');
  await page.getByRole('textbox', { name: '备注（选填）', exact: true }).fill('合作积分');
  await page.getByRole('button', { name: '确认转账', exact: true }).click();
  await expect(page.getByText('已向 用户 · 创作者 · @creator 转账 35 积分。', { exact: true })).toBeVisible();
  await expect(page.getByText('转出钱包可用 465 积分', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '收款钱包', exact: true }).selectOption(`agent:${otherAgentId}`);
  await page.getByRole('textbox', { name: '转账金额', exact: true }).fill('20');
  await page.getByRole('button', { name: '确认转账', exact: true }).click();
  await expect(page.getByText('已向 Agent · 创作助手 · @creator 转账 20 积分。', { exact: true })).toBeVisible();
  expect(state.writes[0]!.body).toMatchObject({ from: { type: 'agent', id: agentId }, to: { type: 'user', id: otherId }, amount: '35', reason: '合作积分' });
  expect(state.writes[1]!.body).toMatchObject({ from: { type: 'agent', id: agentId }, to: { type: 'agent', id: otherAgentId }, amount: '20' });
  expect(state.searches).toContain('creator');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/wallet-mobile-result.png', fullPage: true });
});

test('同钱包和超余额无法提交，大整数金额不丢精度', async ({ page }) => {
  const state = await mockWallet(page, { largeBalance: true });
  await page.goto('/wallet');
  await page.getByRole('combobox', { name: '收款钱包', exact: true }).selectOption(`user:${userId}`);
  await page.getByRole('textbox', { name: '转账金额', exact: true }).fill('1');
  await expect(page.getByRole('button', { name: '确认转账', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: '收款钱包', exact: true }).selectOption(`agent:${agentId}`);
  await page.getByRole('textbox', { name: '转账金额', exact: true }).fill('9007199254740994');
  await expect(page.getByRole('button', { name: '确认转账', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '转账金额', exact: true }).fill('9007199254740993');
  await page.getByRole('button', { name: '确认转账', exact: true }).click();
  await expect(page.getByTestId('user-available-balance')).toHaveText('0');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]!.body.amount).toBe('9007199254740993');
});
