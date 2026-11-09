import { test, expect, type Page, type Route } from '@playwright/test';
import type { RewardCatalogDto, RewardRedemptionDto } from '../../packages/contracts/src/rewards.js';

const userId = '12000000-0000-4000-8000-000000000001';
const agentId = '22000000-0000-4000-8000-000000000001';
const poolId = '32000000-0000-4000-8000-000000000001';
const offerId = '42000000-0000-4000-8000-000000000001';
const redemptionId = '52000000-0000-4000-8000-000000000001';
const operationId = '62000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-07T08:00:00.000Z';
const respond = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function receipt(status: RewardRedemptionDto['status'] = 'pending'): RewardRedemptionDto {
  return {
    id: redemptionId, claim_code: `RWD-${'A'.repeat(32)}`, user_id: userId, agent_id: agentId,
    github_login: 'reward-owner', agent_name: '奖励测试 Agent', pool_id: poolId, offer_id: offerId,
    title: '人工发放测试奖励', description: '一份测试奖励，由运营者在线下完成发放。', points_cost: '20',
    contact_qq: '12345678', instructions: '请使用登记 QQ，提供领取编号和 GitHub 账号，等待运营者核对。',
    claimant_qq: '23456789', status, version: '1', payment_transaction_id: operationId,
    refund_transaction_id: null, fulfillment_reference: null, admin_note: null,
    created_at: timestamp, updated_at: timestamp, processed_by: null, fulfilled_at: null, cancelled_at: null,
  };
}

async function mockRewards(page: Page, options: { lostResponse?: boolean; existing?: RewardRedemptionDto['status']; admin?: boolean } = {}) {
  let record = options.existing ? receipt(options.existing) : null;
  let loseNext = options.lostResponse ?? false;
  let creations = 0;
  const committedKeys = new Set<string>();
  const writes: { path: string; body: Record<string, unknown>; key: string; csrf: string }[] = [];
  await page.context().addCookies([{ name: 'az_csrf', value: 'rewards-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', '');
    const body = request.method() === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    const key = request.headers()['idempotency-key'] ?? '';
    if (request.method() !== 'GET') writes.push({ path, body, key, csrf: request.headers()['x-csrf-token'] ?? '' });
    if (path === '/me') return respond(route, { actor: { type: 'user', userId }, user: { id: userId, github_login: 'reward-owner', display_name: '奖励领取者', status: 'active', role: options.admin ? 'admin' : 'member' } });
    if (path === '/agents') return respond(route, { items: [{ id: agentId, name: '奖励测试 Agent', owner_user_id: userId, status: 'active', created_at: timestamp, updated_at: timestamp }], next_cursor: null });
    if (path === '/rewards') {
      const catalog: RewardCatalogDto = {
        pool: { id: poolId, month: '2026-11-01', total_quantity: '2', user_monthly_limit: '2', contact_qq: '12345678', instructions: '请使用登记 QQ 联系运营者，核对身份后领取。', status: 'active', version: '1', allocated_quantity: '2' },
        offers: [{ id: offerId, pool_id: poolId, title: '人工发放测试奖励', description: '一份测试奖励，由运营者在线下完成发放。', points_cost: '20', total_quantity: '2', redeemed_quantity: record ? '1' : '0', remaining_quantity: record ? '1' : '2', status: 'active', version: '1', created_at: timestamp }],
        redeemed_count: record ? '1' : '0', remaining_count: record ? '1' : '2',
      };
      return respond(route, catalog);
    }
    if (path === '/reward-redemptions') {
      if (request.method() === 'GET') return respond(route, { items: record ? [record] : [], next_cursor: null });
      if (!committedKeys.has(key)) { committedKeys.add(key); record = receipt(); creations += 1; }
      if (loseNext) { loseNext = false; return route.abort('failed'); }
      return respond(route, { ...record, operation_id: operationId }, 201);
    }
    if (path === `/reward-redemptions/${redemptionId}`) return respond(route, record);
    if (path === `/reward-redemptions/${redemptionId}/cancel` && record) {
      record = { ...record, status: 'cancelled', version: '2', refund_transaction_id: operationId, cancelled_at: timestamp };
      return respond(route, { ...record, operation_id: operationId });
    }
    if (path === '/admin/users') return respond(route, { items: [], next_cursor: null });
    if (path === '/admin/reward-redemptions') {
      const status = url.searchParams.get('status');
      return respond(route, { items: record && (!status || record.status === status) ? [record] : [], next_cursor: null });
    }
    if (path === `/admin/reward-redemptions/${redemptionId}/process` && record) {
      record = { ...record, status: 'processing', version: '2', admin_note: String(body.reason), processed_by: userId };
      return respond(route, { ...record, operation_id: operationId });
    }
    if (path === `/admin/reward-redemptions/${redemptionId}/fulfill` && record) {
      record = { ...record, status: 'fulfilled', version: '3', admin_note: String(body.reason), fulfillment_reference: String(body.fulfillment_reference), fulfilled_at: timestamp };
      return respond(route, { ...record, operation_id: operationId });
    }
    return respond(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  return { writes, creations: () => creations };
}

test('兑换结果丢失时保留请求键，重试取得同一领取凭证', async ({ page }) => {
  const state = await mockRewards(page, { lostResponse: true });
  await page.goto('/rewards');
  await page.getByRole('button', { name: '选择兑换', exact: true }).click();
  await page.getByRole('combobox', { name: '付款 Agent', exact: true }).selectOption(agentId);
  await page.getByRole('textbox', { name: '本人领取 QQ', exact: true }).fill('23456789');
  await page.getByRole('checkbox', { name: '我已确认奖励内容、积分价格和领取说明，并确认填写的 QQ 属于本人。', exact: true }).check();
  await page.getByRole('button', { name: '支付 20 积分兑换', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(page.getByRole('textbox', { name: '本人领取 QQ', exact: true })).toHaveValue('23456789');
  await page.getByRole('button', { name: '支付 20 积分兑换', exact: true }).click();
  await expect(page).toHaveURL(`/rewards/${redemptionId}`);
  await expect(page.getByRole('heading', { name: '奖励领取凭证', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0]!.key).toBe(state.writes[1]!.key);
  expect(state.writes[0]!.body).toEqual({ offer_id: offerId, agent_id: agentId, claimant_qq: '23456789' });
  expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
  expect(state.writes.every((write) => write.csrf === 'rewards-csrf' && Boolean(write.key))).toBe(true);
  expect(state.creations()).toBe(1);
});

test('窄屏显示领取身份、复制信息并取消未发放凭证，发放中不提供自退', async ({ page, context }) => {
  const state = await mockRewards(page, { existing: 'pending' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/rewards/${redemptionId}`);
  await expect(page.getByRole('main').getByText('@reward-owner', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '复制领取信息', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('领取信息已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`领取编号：RWD-${'A'.repeat(32)}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/phase-4-rewards-mobile.png', fullPage: true });
  await page.getByRole('textbox', { name: '取消理由', exact: true }).fill('暂时不需要该奖励');
  await page.getByRole('button', { name: '取消并退回积分', exact: true }).click();
  await expect(page.getByText('已取消并退款', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消并退回积分', exact: true })).toHaveCount(0);
  expect(state.writes[0]!.body).toEqual({ version: '1', reason: '暂时不需要该奖励' });
  await page.unroute('**/api/v1/**');
  const processing = await mockRewards(page, { existing: 'processing' });
  await page.reload();
  await expect(page.getByText('发放中', { exact: true })).toBeVisible();
  await expect(page.getByText('运营者正在处理发放，暂不能自行取消。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消并退回积分', exact: true })).toHaveCount(0);
  expect(processing.writes).toHaveLength(0);
});

test('运营者先锁定领取单，确认线下发放后记录凭据', async ({ page }) => {
  const state = await mockRewards(page, { existing: 'pending', admin: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: '奖励管理', exact: true }).click();
  await expect(page.getByRole('main').getByText('@reward-owner', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '处理说明', exact: true }).fill('已核对领取 QQ 和 GitHub 身份');
  await page.getByRole('button', { name: '标记发放中', exact: true }).click();
  await page.getByRole('combobox', { name: '领取状态', exact: true }).selectOption('processing');
  await expect(page.getByRole('button', { name: '确认已发放', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '发放凭据', exact: true }).fill('QQ人工发放记录-001');
  await page.getByRole('textbox', { name: '处理说明', exact: true }).fill('已完成线下发放');
  await expect(page.getByRole('button', { name: '确认已发放', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: '我已核对领取人，并确认该奖励已经线下发放。', exact: true }).check();
  await page.getByRole('button', { name: '确认已发放', exact: true }).click();
  await page.getByRole('combobox', { name: '领取状态', exact: true }).selectOption('fulfilled');
  await expect(page.getByRole('article').getByText('已发放', { exact: true })).toBeVisible();
  await expect(page.getByText('QQ人工发放记录-001', { exact: false })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '处理动作', exact: true })).toHaveCount(0);
  expect(state.writes.map((write) => write.path)).toEqual([`/admin/reward-redemptions/${redemptionId}/process`, `/admin/reward-redemptions/${redemptionId}/fulfill`]);
  expect(state.writes[1]!.body).toEqual({ version: '2', fulfillment_reference: 'QQ人工发放记录-001', reason: '已完成线下发放' });
});
