import { test, expect, type Page, type Route } from '@playwright/test';

const adminId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const agentId = '20000000-0000-4000-8000-000000000001';
const operationId = '40000000-0000-4000-8000-000000000001';
const respond = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockAdmin(page: Page, lostResponse = false) {
  let personal = '80', agent = '50', pool = '100';
  const applied = new Set<string>();
  const writes: { body: { wallet: { type: string; id: string }; direction: string; amount: string; reason: string; business_id: string }; key: string | undefined }[] = [];
  await page.context().addCookies([{ name: 'az_csrf', value: 'test-admin-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path === '/public-config') return respond(route, { admission_mode: 'open' });
    if (path === '/me') return respond(route, { actor: { type: 'user', userId: adminId }, user: { id: adminId, github_login: 'admin', display_name: '管理员', status: 'active', role: 'admin' } });
    if (path === '/admin/users') return respond(route, { items: [{ id: userId, github_login: 'target-user', display_name: '目标用户', status: 'active', role: 'member' }], next_cursor: null });
    if (path === `/admin/users/${userId}/wallets`) return respond(route, { user_id: userId, reward_pool_points: pool, wallets: [
      { type: 'user', id: userId, name: '目标用户', status: 'active', deleted_at: null, available: personal, reserved: '20' },
      { type: 'agent', id: agentId, name: '目标 Agent', status: 'paused', deleted_at: null, available: agent, reserved: '10' },
    ] });
    if (path === '/admin/wallet-adjustments') {
      const body = route.request().postDataJSON() as (typeof writes)[number]['body'];
      writes.push({ body, key: route.request().headers()['idempotency-key'] });
      if (!applied.has(body.business_id)) {
        applied.add(body.business_id);
        const delta = BigInt(body.amount) * (body.direction === 'add' ? 1n : -1n);
        if (body.wallet.type === 'user') personal = (BigInt(personal) + delta).toString(); else agent = (BigInt(agent) + delta).toString();
        if (body.direction === 'add') pool = (BigInt(pool) - BigInt(body.amount)).toString();
      }
      if (lostResponse) { lostResponse = false; return route.abort('failed'); }
      return respond(route, { transaction_id: operationId, operation_id: operationId, ...body }, 201);
    }
    if (path === '/agents') return respond(route, { items: [], next_cursor: null });
    return respond(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  await page.goto('/operations');
  await page.getByText('调整积分', { exact: true }).click();
  const panel = page.getByRole('region', { name: '管理员积分调整' });
  await expect(panel.getByText('平台奖励池可用', { exact: false })).toBeVisible();
  return { panel, writes };
}

test('管理员给个人加分、从暂停Agent扣分，展示资金去向和冻结余额', async ({ page }) => {
  const { panel, writes } = await mockAdmin(page);
  await expect(panel).toContainText('冻结积分保持不变');
  await panel.getByLabel('调整积分数量').fill('25');
  await panel.getByLabel('调整原因').fill('已核实活动奖励');
  await panel.getByRole('button', { name: '确认添加积分' }).click();
  await expect(panel).toContainText('可用 105');
  expect(writes[0]!.body).toMatchObject({ wallet: { type: 'user', id: userId }, direction: 'add', amount: '25', reason: '已核实活动奖励' });
  await panel.getByLabel('调整钱包').selectOption(`agent:${agentId}`);
  await panel.getByLabel('调整方式').selectOption('remove');
  await panel.getByLabel('调整积分数量').fill('20');
  await panel.getByLabel('调整原因').fill('更正重复活动奖励');
  await panel.getByRole('button', { name: '确认移除积分' }).click();
  await expect(panel).toContainText('可用 30');
  await expect(panel).toContainText('冻结 10');
  expect(writes[1]!.body).toMatchObject({ wallet: { type: 'agent', id: agentId }, direction: 'remove', amount: '20' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await panel.getByLabel('调整钱包').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/admin-wallets-mobile.png', fullPage: true });
});

test('不能超奖励池加分，也不能用冻结余额补足管理员扣款', async ({ page }) => {
  const { panel, writes } = await mockAdmin(page);
  await panel.getByLabel('调整原因').fill('检查可用额度');
  await panel.getByLabel('调整积分数量').fill('101');
  await expect(panel.getByRole('button', { name: '确认添加积分' })).toBeDisabled();
  await expect(panel.getByRole('alert')).toContainText('奖励池可用积分不足');
  await panel.getByLabel('调整方式').selectOption('remove');
  await panel.getByLabel('调整积分数量').fill('81');
  await expect(panel.getByRole('button', { name: '确认移除积分' })).toBeDisabled();
  await expect(panel.getByRole('alert')).toContainText('冻结积分不能移除');
  expect(writes).toHaveLength(0);
});

test('响应丢失锁定目标金额并沿用原业务编号重试', async ({ page }) => {
  const { panel, writes } = await mockAdmin(page, true);
  await panel.getByLabel('调整积分数量').fill('20');
  await panel.getByLabel('调整原因').fill('已核实奖励');
  await panel.getByRole('button', { name: '确认添加积分' }).click();
  await expect(panel.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(panel.getByLabel('调整钱包')).toBeDisabled();
  await expect(panel.getByLabel('调整积分数量')).toBeDisabled();
  await panel.getByRole('button', { name: '按原请求重试' }).click();
  await expect(panel.getByLabel('调整积分数量')).toHaveValue('');
  await expect(panel).toContainText('可用 100');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body).toEqual(writes[1]!.body);
  expect(writes[0]!.key).toBe(writes[1]!.key);
});
