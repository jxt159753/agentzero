import { test, expect, type Page, type Route } from '@playwright/test';

const adminId = '10000000-0000-4000-8000-000000000001', ownerId = '10000000-0000-4000-8000-000000000002';
const agentId = '20000000-0000-4000-8000-000000000001', landId = '30000000-0000-4000-8000-000000000001';
const gameId = '40000000-0000-4000-8000-000000000001', itemId = '50000000-0000-4000-8000-000000000001';
const targetUserId = '10000000-0000-4000-8000-000000000003', targetAgentId = '20000000-0000-4000-8000-000000000002';
const custodyAgentId = '20000000-0000-4000-8000-000000000003', pausedAgentId = '20000000-0000-4000-8000-000000000004', deletedAgentId = '20000000-0000-4000-8000-000000000005';
const respond = (route: Route, json: unknown, status = 200) => route.fulfill({ status, json });
async function setup(page: Page, fail: 'network' | 'version' | null = null) {
  const land = { id: landId, code: 'ADMIN-01', x: 0, y: 10, area: 1600, points_price: '100', building_template: 'studio', owner_agent_id: agentId,
    owner_agent_name: '园艺 Agent', owner_user_id: ownerId, owner_github_login: 'alice', name: '花园工作室', works_url: 'https://example.com/work',
    showcase: [{ type: 'text', text: '原始展板内容' }], version: '1', active_listing_id: null, created_at: '2026-11-10T00:00:00Z', trading_frozen: false, showcase_hidden: false };
  const item = { id: itemId, name: '付费盆栽', owner_agent_id: agentId, owner_agent_name: '园艺 Agent', owner_github_login: 'alice', land_id: landId, version: '1', trading_frozen: false };
  const game = { id: gameId, name: '花园游戏', description: '供管理员核查的说明', owner_user_id: ownerId, author_agent_id: agentId, version: '1', moderation_blocked: false, status: 'active', pool_balance: '100', pool_committed: '20' };
  const writes: { path: string; body: Record<string, unknown>; key: string | undefined }[] = [], applied = new Map<string, object>(), reads: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/api/v1', '');
    if (route.request().method() === 'GET') reads.push(path + url.search);
    if (path === '/me') return respond(route, { actor: { type: 'user', userId: adminId }, user: { id: adminId, github_login: 'admin', display_name: '管理员', role: 'admin', status: 'active' } });
    if (path === '/public-config') return respond(route, { registration_mode: 'public' });
    if (path === '/admin/users') return respond(route, { items: url.searchParams.get('q') ? [{ id: targetUserId, github_login: 'target-owner', display_name: '接收用户', status: 'active', role: 'member' }] : [], next_cursor: null });
    if (path === '/agents') return respond(route, { items: [], next_cursor: null });
    if (path === `/admin/users/${targetUserId}/wallets` || path === `/admin/users/${adminId}/wallets`) {
      const custody = path.includes(adminId), userId = custody ? adminId : targetUserId;
      return respond(route, { user_id: userId, reward_pool_points: '1000', wallets: [
        { type: 'user', id: userId, name: '个人钱包', status: 'active', deleted_at: null, available: '10', reserved: '0' },
        { type: 'agent', id: custody ? custodyAgentId : targetAgentId, name: custody ? '管理员托管 Agent' : '目标 Agent', status: 'active', deleted_at: null, available: '0', reserved: '0' },
        { type: 'agent', id: pausedAgentId, name: '暂停 Agent', status: 'paused', deleted_at: null, available: '0', reserved: '0' },
        { type: 'agent', id: deletedAgentId, name: '已删除 Agent', status: 'active', deleted_at: '2026-11-09T00:00:00Z', available: '0', reserved: '0' },
      ] });
    }
    if (path === '/admin/assets') return respond(route, { lands: [land], items: [item], models: [], listings: [] });
    if (path === '/admin/assets/games') return respond(route, { items: [game] });
    if (route.request().method() !== 'GET' && path.startsWith('/admin/assets/')) {
      const body = route.request().postDataJSON() as Record<string, unknown>, key = route.request().headers()['idempotency-key'];
      writes.push({ path, body, key });
      if (fail === 'version') { fail = null; land.version = '2'; return respond(route, { error: { code: 'MARKET_VERSION_CONFLICT' } }, 409); }
      if (applied.has(key!)) return respond(route, applied.get(key!));
      const target = path.includes('/games/') ? game : path.includes('/items/') ? item : land;
      if (path.endsWith('/transfer')) {
        const custody = body.target_agent_id === custodyAgentId;
        Object.assign(target, { owner_agent_id: body.target_agent_id, owner_agent_name: custody ? '管理员托管 Agent' : '目标 Agent',
          owner_user_id: custody ? adminId : targetUserId, owner_github_login: custody ? 'admin' : 'target-owner' });
        if (path.includes('/lands/')) Object.assign(land, { name: '默认工作室', works_url: null, showcase: [] });
        else item.land_id = '';
      }
      if (path.endsWith('/return')) item.land_id = '';
      for (const field of ['trading_frozen', 'showcase_hidden', 'moderation_blocked']) if (field in body) Object.assign(target, { [field]: body[field] });
      target.version = String(Number(target.version) + 1);
      const result = { ...target, operation_id: '60000000-0000-4000-8000-000000000001' }; applied.set(key!, result);
      if (fail === 'network') { fail = null; return route.abort('failed'); }
      return respond(route, result);
    }
    return respond(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  await page.goto('/operations');
  await page.getByRole('tab', { name: '资产与展示', exact: true }).click();
  const panel = page.getByRole('region', { name: '资产与展示管理' });
  await expect(panel.getByText('ADMIN-01', { exact: false })).toBeVisible();
  return { panel, writes, reads };
}

test('资产管理要求理由，冻结与展示恢复使用当前版本，移动端可操作', async ({ page }) => {
  const { panel, writes } = await setup(page);
  await panel.locator('summary').filter({ hasText: 'ADMIN-01' }).click();
  await expect(panel.getByRole('button', { name: '确认执行' })).toBeDisabled();
  await panel.getByLabel('操作理由').fill('核实违规挂牌');
  await panel.getByRole('button', { name: '确认执行' }).click();
  await expect(panel.locator('summary').filter({ hasText: 'ADMIN-01' })).toContainText('交易冻结');
  expect(writes[0]!.body).toEqual({ version: '1', reason: '核实违规挂牌', trading_frozen: true });
  await panel.getByLabel('管理动作').selectOption({ label: '屏蔽地块展示并撤单' });
  await panel.getByLabel('操作理由').fill('暂时屏蔽待核查展示');
  await panel.getByRole('button', { name: '确认执行' }).click();
  await expect(panel.locator('summary').filter({ hasText: 'ADMIN-01' })).toContainText('展示屏蔽');
  expect(writes[1]!.body).toMatchObject({ version: '2', showcase_hidden: true });
  await panel.getByLabel('管理动作').selectOption({ label: '恢复地块展示' });
  await panel.getByLabel('操作理由').fill('核查完成恢复原始内容');
  await panel.getByRole('button', { name: '确认执行' }).click();
  await expect(panel.locator('summary').filter({ hasText: 'ADMIN-01' })).not.toContainText('展示屏蔽');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByLabel('管理动作').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({ path: '.local/admin-assets-mobile.png', fullPage: true });
});

test('资产操作响应丢失后锁定输入，刷新目录仍重试原版本和幂等键', async ({ page }) => {
  const { panel, writes } = await setup(page, 'network');
  await panel.locator('summary').filter({ hasText: 'ADMIN-01' }).click();
  await panel.getByLabel('操作理由').fill('已确认冻结依据');
  await panel.getByRole('button', { name: '确认执行' }).click();
  await expect(panel.getByRole('button', { name: '按原请求重试' })).toBeVisible();
  await expect(panel.getByLabel('操作理由')).toBeDisabled();
  await expect(panel.getByLabel('管理动作')).toBeDisabled();
  await panel.getByRole('button', { name: '刷新资产' }).click();
  await expect(panel.locator('summary').filter({ hasText: 'ADMIN-01' })).toContainText('交易冻结');
  await panel.getByRole('button', { name: '按原请求重试' }).click();
  await expect(panel.getByLabel('操作理由')).toHaveValue('');
  expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]);
});

test('冲突后刷新版本，付费物品仅退回库存，游戏下架独立于发布者状态', async ({ page }) => {
  const { panel, writes } = await setup(page, 'version');
  await panel.locator('summary').filter({ hasText: 'ADMIN-01' }).click();
  await panel.getByLabel('操作理由').fill('核实后处理');
  await panel.getByRole('button', { name: '确认执行' }).click();
  await panel.getByRole('button', { name: '刷新版本后重新确认' }).click();
  await expect(panel.getByText('版本 2', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '确认执行' }).click();
  await expect(panel.locator('summary').filter({ hasText: 'ADMIN-01' })).toContainText('交易冻结');
  expect(writes[0]!.body.version).toBe('1'); expect(writes[1]!.body.version).toBe('2'); expect(writes[1]!.key).not.toBe(writes[0]!.key);
  await panel.getByLabel('资产分类').selectOption('items');
  await panel.locator('summary').filter({ hasText: '付费盆栽' }).click();
  await panel.getByLabel('管理动作').selectOption({ label: '从展示取下并退回原主库存' });
  await panel.getByLabel('操作理由').fill('退回原主，保留所有权');
  await panel.getByRole('button', { name: '确认执行' }).click();
  await expect(panel.locator('summary').filter({ hasText: '付费盆栽' })).toContainText('库存中');
  expect(writes[2]!.path).toBe(`/admin/assets/items/${itemId}/return`);
  await panel.getByLabel('资产分类').selectOption('games');
  await panel.locator('summary').filter({ hasText: '花园游戏' }).click();
  await panel.getByLabel('操作理由').fill('停止违规内容展示');
  await panel.getByRole('button', { name: '确认执行' }).click();
  await expect(panel.locator('summary').filter({ hasText: '花园游戏' })).toContainText('管理员已下架');
  await expect(panel.locator('summary').filter({ hasText: '花园游戏' })).toContainText('发布者已开放');
  expect(writes[3]!.body).toMatchObject({ moderation_blocked: true, reason: '停止违规内容展示' });
});

async function openTransfer(page: Page, kind: 'lands' | 'items' = 'lands') {
  const panel = page.getByRole('region', { name: '资产与展示管理' });
  await panel.getByLabel('资产分类').selectOption(kind);
  await panel.locator('summary').filter({ hasText: kind === 'lands' ? 'ADMIN-01' : '付费盆栽' }).click();
  await panel.locator('summary').filter({ hasText: '改归属或回收资产' }).click();
  return panel.getByRole('region', { name: '资产产权管理', exact: true });
}

async function chooseTarget(page: Page) {
  const form = page.getByRole('region', { name: '资产产权管理', exact: true });
  await form.getByLabel('查找目标用户').fill('target-owner');
  await form.getByRole('button', { name: '搜索目标用户', exact: true }).click();
  await form.getByRole('combobox', { name: '目标用户', exact: true }).selectOption(targetUserId);
  await form.getByRole('combobox', { name: '目标 Agent', exact: true }).selectOption(targetAgentId);
  return form;
}

test('土地改归属按用户搜索选择活跃 Agent，并明确确认原主和清理影响', async ({ page }) => {
  const { writes, reads } = await setup(page);
  const form = await openTransfer(page);
  await chooseTarget(page);
  expect(reads).toContain('/admin/users?status=active&q=target-owner');
  expect(reads).toContain(`/admin/users/${targetUserId}/wallets`);
  await expect(form.getByRole('combobox', { name: '目标 Agent', exact: true }).locator('option')).toHaveCount(2);
  await expect(form.getByText(`原主：园艺 Agent · Agent ID：${agentId}`, { exact: true })).toBeVisible();
  await form.getByLabel('产权处理理由').fill('经核对转交资产给接收用户');
  const submit = form.getByRole('button', { name: '确认变更资产归属', exact: true });
  await expect(submit).toBeDisabled();
  await form.getByLabel('已核对原主与接收 Agent，确认变更这项资产的所有权。').check();
  await expect(submit).toBeDisabled();
  await form.getByLabel('确认撤销土地挂牌、退回付费装饰、清除免费模型与展示，并迁出室内访客。').check();
  await submit.click();
  await expect(form.getByLabel('产权处理理由')).toHaveValue('');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ path: `/admin/assets/lands/${landId}/transfer`, body: { mode: 'transfer', version: '1', expected_owner_agent_id: agentId, target_agent_id: targetAgentId, reason: '经核对转交资产给接收用户' } });
});

test('物品回收仅选择当前管理员托管 Agent，保留原主与版本并适配手机', async ({ page }) => {
  const { writes, reads } = await setup(page);
  const form = await openTransfer(page, 'items');
  await form.getByLabel('产权处理方式').selectOption('recover');
  await expect(form.getByLabel('查找目标用户')).toHaveCount(0);
  await form.getByRole('combobox', { name: '托管 Agent', exact: true }).selectOption(custodyAgentId);
  expect(reads).toContain(`/admin/users/${adminId}/wallets`);
  expect(reads).not.toContain(`/admin/users/${targetUserId}/wallets`);
  await expect(form.getByRole('combobox', { name: '托管 Agent', exact: true }).locator('option')).toHaveCount(2);
  await form.getByLabel('产权处理理由').fill('管理员回收违规摆放资产到托管库存');
  await form.getByLabel('已核对原主与接收 Agent，确认变更这项资产的所有权。').check();
  await page.setViewportSize({ width: 390, height: 844 });
  await form.getByRole('button', { name: '确认回收到托管 Agent' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({ path: '.local/admin-asset-transfer-mobile.png', fullPage: true });
  await form.getByRole('button', { name: '确认回收到托管 Agent' }).click();
  await expect(form.getByLabel('产权处理理由')).toHaveValue('');
  expect(writes[0]).toMatchObject({ path: `/admin/assets/items/${itemId}/transfer`, body: { mode: 'recover', version: '1', expected_owner_agent_id: agentId, target_agent_id: custodyAgentId, reason: '管理员回收违规摆放资产到托管库存' } });
});

test('产权变更响应丢失后即使目录已换原主，也按原请求与幂等键重试', async ({ page }) => {
  const { panel, writes } = await setup(page, 'network');
  await panel.getByLabel('查找资产', { exact: true }).fill('alice');
  const form = await openTransfer(page);
  await chooseTarget(page);
  await form.getByLabel('产权处理理由').fill('保留本次已确认的产权指令');
  await form.getByLabel('已核对原主与接收 Agent，确认变更这项资产的所有权。').check();
  await form.getByLabel('确认撤销土地挂牌、退回付费装饰、清除免费模型与展示，并迁出室内访客。').check();
  await form.getByRole('button', { name: '确认变更资产归属', exact: true }).click();
  await expect(form.getByRole('button', { name: '按原产权请求重试' })).toBeVisible();
  await expect(panel.getByLabel('查找资产', { exact: true })).toBeDisabled();
  await expect(panel.getByLabel('资产分类')).toBeDisabled();
  await panel.getByRole('button', { name: '刷新资产', exact: true }).click();
  await expect(panel.locator('summary').filter({ hasText: 'ADMIN-01' })).toContainText('@target-owner');
  await expect(form.getByLabel('产权处理方式')).toBeDisabled();
  await expect(form.getByLabel('产权处理理由')).toBeDisabled();
  await expect(form.getByText(`原主：园艺 Agent · Agent ID：${agentId}`, { exact: true })).toBeVisible();
  await expect(form.getByText('资产版本 1', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: '按原产权请求重试' }).click();
  await expect(panel.getByLabel('查找资产', { exact: true })).toBeEnabled();
  await expect(panel.getByLabel('资产分类')).toBeEnabled();
  await expect(panel.locator('summary').filter({ hasText: 'ADMIN-01' })).toHaveCount(0);
  expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]); expect(writes[0]!.key).toBeTruthy();
});

test('产权版本冲突后必须刷新并重新勾选，才可按新版本提交', async ({ page }) => {
  const { writes } = await setup(page, 'version');
  const form = await openTransfer(page);
  await chooseTarget(page);
  await form.getByLabel('产权处理理由').fill('核对新版本后变更');
  await form.getByLabel('已核对原主与接收 Agent，确认变更这项资产的所有权。').check();
  await form.getByLabel('确认撤销土地挂牌、退回付费装饰、清除免费模型与展示，并迁出室内访客。').check();
  await form.getByRole('button', { name: '确认变更资产归属', exact: true }).click();
  await form.getByRole('button', { name: '刷新原主与版本后重新确认' }).click();
  await expect(form.getByText('资产版本 2', { exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: '确认变更资产归属', exact: true })).toBeDisabled();
  await form.getByLabel('已核对原主与接收 Agent，确认变更这项资产的所有权。').check();
  await form.getByLabel('确认撤销土地挂牌、退回付费装饰、清除免费模型与展示，并迁出室内访客。').check();
  await form.getByRole('button', { name: '确认变更资产归属', exact: true }).click();
  await expect(form.getByLabel('产权处理理由')).toHaveValue('');
  expect(writes).toHaveLength(2); expect(writes[0]!.body.version).toBe('1'); expect(writes[1]!.body.version).toBe('2'); expect(writes[1]!.key).not.toBe(writes[0]!.key);
});
