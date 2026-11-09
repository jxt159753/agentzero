import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { testPools, resetLedgerTestData, fund } from '../integration/ledger-fixtures.js';
import { tokenHash } from '../../apps/api/src/core.js';

// PostgreSQL and application endpoints are real; only external GitHub OAuth and repository reads are simulated.
const pools = testPools();
const origin = 'http://localhost:3001';
test.beforeEach(async () => resetLedgerTestData(pools.migration));
test.afterAll(async () => { await pools.runtime.end(); await pools.migration.end(); });

async function login(page: Page, githubId: '71001' | '71002' | '71003' | '71004', startPath = '/') {
  await page.route('**/api/v1/auth/github/start', async (route) => {
    // Execute the real start route and preserve its state-binding cookie.
    // Simulate only the external consent redirect; page.route does not intercept redirect targets.
    const started = await route.fetch({ maxRedirects: 0 });
    expect(started.status()).toBe(302);
    const authorization = new URL(started.headers().location!);
    expect(authorization.origin).toBe('https://github.com');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toHaveLength(43);
    const callback = new URL(`${origin}/api/v1/auth/github/callback`);
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('code', githubId);
    await route.fulfill({ response: started, headers: { ...started.headers(), location: callback.toString() } });
  });
  await page.goto(startPath);
  await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
  await expect(page.getByRole('button', { name: '退出', exact: true })).toBeVisible();
}

async function csrf(page: Page) {
  return (await page.context().cookies()).find((cookie) => cookie.name === 'az_csrf')!.value;
}

test('直接注册：GitHub 登录返回确认页，一次确认创建 Agent 与客户端连接', async ({ page }) => {
  const id = randomUUID(), code = randomBytes(32).toString('base64url');
  const secret = `azk_${id}.${randomBytes(32).toString('base64url')}`;
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const started = await page.request.post('/api/v1/agent-registrations', { data: {
    id, client: 'codex', name: '我的 Codex', credential_hash: digest(secret), verification_hash: digest(code),
  } });
  expect(started.status()).toBe(201);
  await login(page, '71001', `/connect?request=${id}#code=${code}`);
  await expect(page.getByRole('heading', { name: '将 Codex 注册为 Agent' })).toBeVisible();
  expect((await pools.runtime.query('SELECT count(*)::int n FROM agents')).rows[0].n).toBe(0);
  await page.getByLabel('Agent 名称', { exact: true }).fill('直接注册的 Codex');
  await page.getByRole('button', { name: '确认注册并连接' }).click();
  await expect(page.getByRole('heading', { name: '已确认注册' })).toBeVisible();
  const result = await page.request.get(`/api/v1/agent-registrations/${id}/status`, { headers: { authorization: `Bearer ${secret}` } });
  expect(result.status()).toBe(200);
  const registration = await result.json();
  expect(registration.status).toBe('approved');
  const me = await page.request.get('/api/v1/me', { headers: { authorization: `Bearer ${secret}` } });
  expect((await me.json()).actor.agentId).toBe(registration.agent_id);
  const detailReads = ['', '/wallet', '/policy', '/keys', '/transactions'].map(suffix => page.waitForResponse(response =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/v1/agents/${registration.agent_id}${suffix}`));
  await page.getByRole('link', { name: '查看 Agent 与权限' }).click();
  // Finish every detail read before the next test truncates the isolated database.
  await Promise.all(detailReads);
  await expect(page.getByRole('heading', { level: 1, name: /直接注册的 Codex/ })).toBeVisible();
  await expect(page.getByTestId('available-balance')).toHaveText('0');
  await expect(page.getByRole('switch', { name: '承接任务' })).not.toBeChecked();
  expect((await pools.runtime.query('SELECT count(*)::int n FROM agent_keys')).rows[0].n).toBe(1);
});

test('真实共享小镇：双用户同步、访客隔离、工作室成交和断线后恢复最新产权', async ({ page, browser }) => {
  const memberContext = await browser.newContext({ baseURL: origin });
  try {
    const member = await memberContext.newPage();
    await login(page, '71001');
    await login(member, '71002');
    const users = (await pools.runtime.query('SELECT id,github_user_id FROM users')).rows;
    const administrator = users.find(user => user.github_user_id === '71001')!.id;
    const owner = users.find(user => user.github_user_id === '71002')!.id;
    async function write(actor: Page, method: 'POST' | 'PUT' | 'PATCH', path: string, data: unknown) {
      const response = await actor.request.fetch(`/api/v1${path}`, { method, headers: { origin, 'x-csrf-token': await csrf(actor), 'idempotency-key': randomUUID() }, data });
      const body = await response.json();
      expect(response.ok(), JSON.stringify(body)).toBe(true);
      return body;
    }
    await write(page, 'PATCH', `/admin/users/${owner}`, { status: 'active', reason: '独立测试库世界验收' });
    const seller = await write(page, 'POST', '/agents', { name: '小镇卖方 Agent' });
    const buyer = await write(member, 'POST', '/agents', { name: '小镇买方 Agent' });
    const session = (await pools.runtime.query('SELECT id FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL', [administrator])).rows[0];
    for (const [actor, agent] of [[page, seller], [member, buyer]] as const) {
      await write(actor, 'PUT', `/agents/${agent.id}/policy`, { version: '1', can_accept_task: false, can_collaborate: false, can_trade: true, can_redeem_api: false, single_spend_limit: '100', daily_spend_limit: '200' });
      await fund(pools.runtime, { type: 'user', userId: administrator, sessionId: session.id }, agent.id, '100');
    }
    await write(page, 'POST', '/admin/market/lands', { plots: [{ code: 'SHARED-TOWN-01', x: 4, y: 3, area: 100, points_price: '10', building_template: 'studio' }], reason: '独立测试库共享地图地块' });
    const catalog = await (await page.request.get('/api/v1/market')).json();
    const land = catalog.lands[0];
    await write(page, 'POST', `/market/lands/${land.id}/buy`, { agent_id: seller.id, version: land.version });
    let current = await (await page.request.get(`/api/v1/market/lands/${land.id}`)).json();
    await write(page, 'PATCH', `/market/lands/${land.id}/studio`, { agent_id: seller.id, version: current.version, name: '卖方公开工作室', works_url: 'https://example.com/authorized-studio-work' });
    current = await (await page.request.get(`/api/v1/market/lands/${land.id}`)).json();
    const model = await write(page, 'POST', `/world/studios/${land.id}/models`, { land_version: current.version, model_id: 'plant', x: 0.3, y: 0.3, rotation: 45, scale: 0.5 });
    expect(model.placement.model_id).toBe('plant');
    const sharedStudio = await (await member.request.get(`/api/v1/world/studios/${land.id}`)).json();
    expect(sharedStudio.land.models).toEqual([model.placement]);
    const credential = await write(page, 'POST', `/agents/${seller.id}/keys`, { label: '隔离世界心跳凭证' });

    await page.goto('/world');
    await member.goto('/world');
    for (const actor of [page, member]) {
      await expect(actor.getByTestId('world-connection')).toContainText('已同步');
      await actor.getByRole('button', { name: '小镇目录' }).click();
      await expect(actor.getByTestId(`world-land-${land.id}`)).toContainText('小镇卖方 Agent');
      await expect(actor.getByTestId(`world-agent-${seller.id}`)).toContainText('离线');
      await expect(actor.getByTestId(`world-visitor-${administrator}`)).toBeVisible();
      await expect(actor.getByTestId(`world-visitor-${owner}`)).toBeVisible();
    }
    await member.getByRole('button', { name: '关闭小镇目录', exact: true }).click();
    await member.getByRole('button', { name: '俯视地图', exact: true }).click();
    await member.getByRole('button', { name: '向右移动', exact: true }).click();
    await expect(member.getByText('当前位置 (1, 0)', { exact: true })).toBeVisible();
    // Local animation finishes before the throttled position write; wait for persistence before reloading.
    await expect.poll(async () => (await pools.runtime.query(
      "SELECT x,y FROM world_positions WHERE kind='visitor' AND subject_id=$1", [owner],
    )).rows[0]).toEqual({ x: 1, y: 0 });
    await member.reload();
    await expect(member.getByTestId('world-connection')).toContainText('已同步');
    await expect(member.getByText('当前位置 (1, 0)', { exact: true })).toBeVisible();
    await member.getByRole('button', { name: '小镇目录' }).click();
    const pulse = await page.request.post('/api/v1/world/presence', { headers: { authorization: `Bearer ${credential.secret}`, 'idempotency-key': randomUUID() }, data: { x: 2, y: 3 } });
    expect(pulse.status()).toBe(200);
    for (const actor of [page, member]) await expect(actor.getByTestId(`world-agent-${seller.id}`)).toContainText('在线');
    await write(page, 'POST', `/agents/${seller.id}/keys/${credential.id}/revoke`, {});
    for (const actor of [page, member]) await expect(actor.getByTestId(`world-agent-${seller.id}`)).toContainText('离线');

    await member.goto(`/world/studios/${land.id}`);
    await expect(member.getByRole('heading', { name: '卖方公开工作室', exact: true })).toBeVisible();
    await expect(member.locator('a[href="https://example.com/authorized-studio-work"]')).toBeVisible();
    await memberContext.setOffline(true);
    await expect(member.getByRole('region', { name: '小镇详情' })).toContainText('连接恢复后显示最新产权');
    await expect(member.locator('a[href="https://example.com/authorized-studio-work"]')).toHaveCount(0);

    current = await (await page.request.get(`/api/v1/market/lands/${land.id}`)).json();
    const listing = await write(page, 'POST', '/market/listings', { agent_id: seller.id, land_id: land.id, asset_version: current.version, points_price: '20' });
    // APIRequestContext remains available while the browser's network is offline.
    await write(member, 'POST', `/market/listings/${listing.id}/buy`, { agent_id: buyer.id, version: listing.version });
    await expect(page.getByTestId(`world-land-${land.id}`)).toContainText('小镇买方 Agent');
    await memberContext.setOffline(false);
    await expect(member.getByRole('heading', { name: '默认工作室', exact: true })).toBeVisible();
    await expect(member.getByTestId('world-studio')).toContainText('管理 Agent：小镇买方 Agent');
    await expect(member.locator('a[href="https://example.com/authorized-studio-work"]')).toHaveCount(0);
    await member.goto('/world');
    await member.getByRole('button', { name: '小镇目录' }).click();
    await expect(member.getByTestId(`world-land-${land.id}`)).toContainText('小镇买方 Agent');
    expect((await pools.runtime.query('SELECT owner_agent_id,owner_user_id,works_url FROM land_plots WHERE id=$1', [land.id])).rows[0]).toEqual({ owner_agent_id: buyer.id, owner_user_id: owner, works_url: null });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM world_model_placements WHERE land_id=$1', [land.id])).rows[0].n).toBe(0);
    expect((await (await member.request.get(`/api/v1/world/studios/${land.id}`)).json()).land.models).toEqual([]);
    await expect(page.getByRole('link', { name: '任务大厅', exact: true }).last()).toBeVisible();
    await expect(page.getByRole('link', { name: '资产市场', exact: true }).last()).toBeVisible();
    await expect(page.getByRole('link', { name: '奖励站', exact: true }).last()).toBeVisible();
    await expect(page.getByRole('region', { name: '小镇地图', exact: true }).locator('canvas')).toBeVisible();
    await page.screenshot({ path: '.local/phase-6-world-desktop.png', fullPage: true });
    await member.setViewportSize({ width: 390, height: 844 });
    await expect(member.getByTestId(`world-land-${land.id}`)).toBeVisible();
    await expect(member.getByRole('region', { name: '小镇地图', exact: true }).locator('canvas')).toBeVisible();
    await member.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await member.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await member.screenshot({ path: '.local/phase-6-world-mobile.png', fullPage: true });
  } finally { await memberContext.close(); }
});

test('真实人工奖励闭环：配置库存、兑换凭证、锁定发放、登记结果与取消退款', async ({ page, browser }) => {
  const memberContext = await browser.newContext({ baseURL: origin });
  try {
    const member = await memberContext.newPage();
    await login(page, '71001');
    await login(member, '71002');
    const users = (await pools.runtime.query('SELECT id,github_user_id FROM users')).rows;
    const administrator = users.find(user => user.github_user_id === '71001')!.id;
    const owner = users.find(user => user.github_user_id === '71002')!.id;
    async function write(actor: Page, method: 'POST' | 'PUT' | 'PATCH', path: string, data: unknown) {
      const response = await actor.request.fetch(`/api/v1${path}`, { method, headers: { origin, 'x-csrf-token': await csrf(actor), 'idempotency-key': randomUUID() }, data });
      const body = await response.json();
      expect(response.ok(), JSON.stringify(body)).toBe(true);
      return body;
    }
    await write(page, 'PATCH', `/admin/users/${owner}`, { status: 'active', reason: '独立测试奖励验收' });
    const agent = await write(member, 'POST', '/agents', { name: '人工奖励 Agent' });
    await write(member, 'PUT', `/agents/${agent.id}/policy`, { version: '1', can_accept_task: false, can_collaborate: false, can_trade: false, can_redeem_api: true, single_spend_limit: '100', daily_spend_limit: '100' });
    const session = (await pools.runtime.query('SELECT id FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL', [administrator])).rows[0];
    await fund(pools.runtime, { type: 'user', userId: administrator, sessionId: session.id }, agent.id, '100');

    await page.goto('/operations');
    await page.getByRole('tab', { name: '奖励管理', exact: true }).click();
    await page.getByRole('button', { name: '月度奖励配置', exact: true }).click();
    await page.getByLabel('月度奖励总份数', { exact: true }).fill('2');
    await page.getByLabel('每用户月度兑换上限（份）', { exact: true }).fill('2');
    await page.getByLabel('运营者联系 QQ', { exact: true }).fill('123456789');
    await page.getByRole('combobox', { name: '兑换状态', exact: true }).selectOption('active');
    await page.getByLabel('领取说明', { exact: true }).fill('独立测试库：凭编号与 GitHub 账号联系 QQ，不实际付款。');
    await page.getByLabel('配置理由', { exact: true }).fill('浏览器验收月池');
    await page.getByRole('button', { name: '保存月度配置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '发布奖励商品', exact: true })).toBeVisible();
    await page.getByLabel('奖励名称', { exact: true }).fill('人工领取测试奖励');
    await page.getByLabel('奖励内容', { exact: true }).fill('一份模拟奖励，仅验证人工领取流程。');
    await page.getByLabel('每份兑换积分', { exact: true }).fill('10');
    await page.getByLabel('商品总份数', { exact: true }).fill('2');
    await page.getByLabel('发布理由', { exact: true }).fill('浏览器验收报价');
    await page.getByRole('button', { name: '发布奖励商品', exact: true }).click();
    await expect(page.getByRole('heading', { name: '人工领取测试奖励', exact: true })).toBeVisible();

    async function redeem() {
      await member.goto('/rewards');
      await member.getByRole('button', { name: '选择兑换', exact: true }).click();
      await member.getByRole('combobox', { name: '付款 Agent', exact: true }).selectOption(agent.id);
      await member.getByLabel('本人领取 QQ', { exact: true }).fill('234567890');
      await member.getByRole('checkbox').check();
      await member.getByRole('button', { name: '支付 10 积分兑换', exact: true }).click();
      await expect(member.getByRole('heading', { name: '奖励领取凭证', exact: true })).toBeVisible();
      const id = new URL(member.url()).pathname.split('/').at(-1)!;
      return (await pools.runtime.query('SELECT * FROM reward_redemptions WHERE id=$1', [id])).rows[0];
    }
    const first = await redeem();
    expect(first).toMatchObject({ user_id: owner, agent_id: agent.id, status: 'pending', points_cost: '10' });
    await expect(member.getByLabel('领取信息')).toHaveValue(new RegExp(first.claim_code));
    await page.getByRole('button', { name: '领取单管理', exact: true }).click();
    await page.getByLabel('领取编号', { exact: true }).fill(first.claim_code);
    await page.getByRole('button', { name: '查询领取单', exact: true }).click();
    await expect(page.getByText('@browser-71002', { exact: true })).toBeVisible();
    await page.getByLabel('处理说明', { exact: true }).fill('核对领取 QQ，先锁定订单');
    await page.getByRole('button', { name: '标记发放中', exact: true }).click();
    await expect(page.getByText('没有符合条件的领取单。', { exact: true })).toBeVisible();
    await member.getByRole('button', { name: '刷新状态', exact: true }).click();
    await expect(member.getByText('发放中', { exact: true })).toBeVisible();
    await expect(member.getByRole('button', { name: '取消并退回积分', exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: '领取状态', exact: true }).selectOption('processing');
    await page.getByLabel('发放凭据', { exact: true }).fill('browser-test-manual-result');
    await page.getByLabel('处理说明', { exact: true }).fill('仅登记模拟发放结果，没有执行真实支付');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '确认已发放', exact: true }).click();
    await expect(page.getByText('没有符合条件的领取单。', { exact: true })).toBeVisible();
    await member.getByRole('button', { name: '刷新状态', exact: true }).click();
    await expect(member.getByText('已发放', { exact: true })).toBeVisible();
    expect((await pools.runtime.query('SELECT status,processed_by,fulfillment_reference FROM reward_redemptions WHERE id=$1', [first.id])).rows[0]).toEqual({ status: 'fulfilled', processed_by: administrator, fulfillment_reference: 'browser-test-manual-result' });

    const second = await redeem();
    await member.getByLabel('取消理由', { exact: true }).fill('未领取，测试原钱包退款');
    await member.getByRole('button', { name: '取消并退回积分', exact: true }).click();
    await expect(member.getByText('已取消并退款', { exact: true })).toBeVisible();
    expect((await pools.runtime.query('SELECT status,refund_transaction_id FROM reward_redemptions WHERE id=$1', [second.id])).rows[0].refund_transaction_id).toBeTruthy();
    expect((await pools.runtime.query("SELECT balance FROM ledger_accounts WHERE agent_id=$1 AND bucket='AVAILABLE'", [agent.id])).rows[0].balance).toBe('90');
    const catalog = await (await member.request.get('/api/v1/rewards')).json();
    expect(catalog).toMatchObject({ redeemed_count: '2', remaining_count: '0', offers: [{ redeemed_quantity: '1', remaining_quantity: '1' }] });
    const reconciliation = await write(page, 'POST', '/admin/reconciliation', {});
    expect(reconciliation.ok).toBe(true);
  } finally { await memberContext.close(); }
});

test('真实市场闭环：供应、购地购饰、工作室挂牌成交与装饰归还', async ({ page, browser }) => {
  const sellerContext = await browser.newContext({ baseURL: origin });
  const buyerContext = await browser.newContext({ baseURL: origin });
  try {
    const seller = await sellerContext.newPage(), buyer = await buyerContext.newPage();
    await login(page, '71001');
    await login(seller, '71002');
    await login(buyer, '71003');
    const users = (await pools.runtime.query('SELECT id,github_user_id FROM users')).rows;
    const adminId = users.find(user => user.github_user_id === '71001')!.id;
    async function write(actor: Page, method: 'POST' | 'PUT' | 'PATCH', path: string, data: unknown) {
      const response = await actor.request.fetch(`/api/v1${path}`, { method, headers: { origin, 'x-csrf-token': await csrf(actor), 'idempotency-key': randomUUID() }, data });
      const body = await response.json();
      expect(response.ok(), JSON.stringify(body)).toBe(true);
      return body;
    }
    for (const user of users.filter(user => user.github_user_id !== '71001')) await write(page, 'PATCH', `/admin/users/${user.id}`, { status: 'active', reason: '独立测试库市场浏览器验收' });
    const sellerAgent = await write(seller, 'POST', '/agents', { name: '市场卖方 Agent' });
    const buyerAgent = await write(buyer, 'POST', '/agents', { name: '市场买方 Agent' });
    const session = (await pools.runtime.query('SELECT id FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL', [adminId])).rows[0];
    for (const [actor, agent] of [[seller, sellerAgent], [buyer, buyerAgent]] as const) {
      await write(actor, 'PUT', `/agents/${agent.id}/policy`, { version: '1', can_accept_task: false, can_collaborate: false, can_trade: true, can_redeem_api: false, single_spend_limit: '100', daily_spend_limit: '200' });
      await fund(pools.runtime, { type: 'user', userId: adminId, sessionId: session.id }, agent.id, '100');
    }

    await page.goto('/operations');
    await page.getByRole('tab', { name: '市场供应', exact: true }).click();
    const supply = page.locator('section').filter({ has: page.getByRole('heading', { name: '批量发布土地', exact: true }) });
    await supply.getByLabel('地块编号', { exact: true }).fill('BROWSER-001');
    await supply.getByLabel('面积', { exact: true }).fill('100');
    await supply.getByLabel('位置 X', { exact: true }).fill('4');
    await supply.getByLabel('位置 Y', { exact: true }).fill('6');
    await supply.getByLabel('系统售价', { exact: true }).fill('40');
    await supply.getByLabel('操作理由', { exact: true }).fill('测试地块供应，不创建开发库数据');
    await supply.getByRole('button', { name: '发布土地供应', exact: true }).click();
    await expect(page.getByText('BROWSER-001：40 积分', { exact: true })).toBeVisible();
    const templateForm = page.locator('section').filter({ has: page.getByRole('heading', { name: '发布装饰模板', exact: true }) });
    await templateForm.getByLabel('物品名称', { exact: true }).fill('浏览器盆栽');
    await templateForm.getByLabel('物品说明', { exact: true }).fill('独立测试库装饰模板');
    await templateForm.getByLabel('物品单价', { exact: true }).fill('5');
    await templateForm.getByLabel('供应总量（件）', { exact: true }).fill('2');
    await templateForm.getByLabel('操作理由', { exact: true }).fill('测试物品供应');
    await templateForm.getByRole('button', { name: '发布物品模板', exact: true }).click();
    await expect(page.getByRole('heading', { name: '浏览器盆栽', exact: true })).toBeVisible();

    async function purchase(actor: Page, agent: string, button: string, price: string) {
      await actor.getByRole('button', { name: button, exact: true }).click();
      await actor.getByRole('combobox', { name: '付款 Agent', exact: true }).selectOption(agent);
      await actor.getByRole('checkbox', { name: '我已确认价格、卖方和交易范围，成交后不能单方撤销。', exact: true }).check();
      await actor.getByRole('button', { name: `支付 ${price} 积分购买`, exact: true }).click();
      await expect(actor.getByRole('status')).toContainText(`交易成功 · ${price} 积分`);
    }
    await seller.goto('/market');
    await purchase(seller, sellerAgent.id, '查看购地报价', '40');
    await seller.getByRole('tab', { name: '装饰物品', exact: true }).click();
    await purchase(seller, sellerAgent.id, '查看物品报价', '5');
    const land = (await pools.runtime.query('SELECT id,name FROM land_plots WHERE code=$1', ['BROWSER-001'])).rows[0];
    const originalName = land.name;
    await seller.getByRole('tab', { name: '我的资产', exact: true }).click();
    await seller.getByText('编辑工作室展示', { exact: true }).click();
    await seller.getByLabel('工作室名称', { exact: true }).fill('卖方个性工作室');
    await seller.getByLabel('公开作品链接', { exact: true }).fill('https://example.com/seller-work');
    await seller.getByRole('button', { name: '保存工作室', exact: true }).click();
    await expect(seller.getByRole('heading', { name: '卖方个性工作室', exact: true })).toBeVisible();
    const ownedItem = seller.getByRole('article').filter({ has: seller.getByRole('heading', { name: '浏览器盆栽', exact: true }) });
    await ownedItem.getByRole('combobox', { name: '物品位置', exact: true }).selectOption(land.id);
    await ownedItem.getByRole('button', { name: '放置到工作室', exact: true }).click();
    await expect(ownedItem.getByText('已放置', { exact: true })).toBeVisible();
    const studio = seller.getByRole('article').filter({ has: seller.getByRole('heading', { name: '卖方个性工作室', exact: true }) });
    await studio.getByText('固定价挂牌出售', { exact: true }).click();
    await studio.getByLabel('挂牌售价', { exact: true }).fill('50');
    await studio.getByRole('button', { name: '确认挂牌', exact: true }).click();
    await expect(studio.getByText('已挂牌 · 布置冻结', { exact: true })).toBeVisible();
    await expect(seller.getByText('编辑工作室展示', { exact: true })).toHaveCount(0);
    await expect(ownedItem.getByRole('combobox', { name: '物品位置', exact: true })).toHaveCount(0);

    await buyer.goto('/market?tab=resale');
    await expect(buyer.getByText('卖方：市场卖方 Agent', { exact: true })).toBeVisible();
    await purchase(buyer, buyerAgent.id, '查看交易报价', '50');
    await buyer.getByRole('tab', { name: '我的资产', exact: true }).click();
    await expect(buyer.getByRole('heading', { name: originalName, exact: true })).toBeVisible();
    await expect(buyer.getByRole('link', { name: '查看公开作品 ↗', exact: true })).toHaveCount(0);
    await expect(buyer.getByText('此 Agent 库存为空。', { exact: true })).toBeVisible();
    await seller.getByRole('button', { name: '刷新市场', exact: true }).click();
    await expect(seller.getByText('此 Agent 尚未管理土地。', { exact: true })).toBeVisible();
    await expect(ownedItem.getByText('库存中', { exact: true })).toBeVisible();
    expect((await pools.runtime.query('SELECT owner_agent_id,owner_user_id,name,works_url FROM land_plots WHERE id=$1', [land.id])).rows[0]).toEqual({ owner_agent_id: buyerAgent.id, owner_user_id: users.find(user => user.github_user_id === '71003')!.id, name: originalName, works_url: null });
    expect((await pools.runtime.query('SELECT owner_agent_id,land_id FROM item_instances')).rows).toEqual([{ owner_agent_id: sellerAgent.id, land_id: null }]);
    expect((await pools.runtime.query('SELECT status FROM market_listings')).rows).toEqual([{ status: 'sold' }]);
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM market_trades')).rows[0].count).toBe(3);
    await seller.goto(`/agents/${sellerAgent.id}`);
    await buyer.goto(`/agents/${buyerAgent.id}`);
    await expect(seller.getByTestId('available-balance')).toHaveText('105');
    await expect(buyer.getByTestId('available-balance')).toHaveText('50');
    expect((await pools.runtime.query("SELECT balance FROM ledger_accounts WHERE system_key='RECOVERY'")).rows[0].balance).toBe('45');
    expect((await write(page, 'POST', '/admin/reconciliation', {})).ok).toBe(true);
  } finally { await sellerContext.close(); await buyerContext.close(); }
});

test('真实数据库浏览器流程：OAuth、Agent、策略、凭证、隔离、钱包与退出', async ({ page, browser }) => {
  await login(page, '71001');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '我的 Agent', exact: true }).click();
  await page.getByRole('button', { name: '+ 创建 Agent', exact: true }).click();
  await page.getByLabel('Agent 名称').fill('浏览器集成 Agent');
  await page.getByRole('button', { name: '确认创建' }).click();
  await expect(page.getByRole('heading', { name: '浏览器集成 Agent 已启用' })).toBeVisible();
  const agentId = new URL(page.url()).pathname.split('/').at(-1)!;
  const initial = (await pools.runtime.query('SELECT a.id,a.owner_user_id,p.version,p.can_trade,p.single_spend_limit FROM agents a JOIN agent_policies p ON p.agent_id=a.id WHERE a.id=$1', [agentId])).rows[0];
  expect(initial).toMatchObject({ version: '1', can_trade: false, single_spend_limit: '0' });
  const accounts = (await pools.runtime.query('SELECT bucket,balance FROM ledger_accounts WHERE agent_id=$1 ORDER BY bucket', [agentId])).rows;
  expect(accounts).toEqual([{ bucket: 'AVAILABLE', balance: '0' }, { bucket: 'RESERVED', balance: '0' }]);
  await expect(page.getByTestId('available-balance')).toHaveText('0');

  await page.getByRole('switch', { name: '资产交易' }).check();
  await page.getByLabel('单笔支出上限').fill('100');
  await page.getByLabel('每日支出上限').fill('300');
  await page.getByRole('button', { name: '保存权限' }).click();
  await expect(page.getByText('当前版本 2')).toBeVisible();
  expect((await pools.runtime.query('SELECT version,can_trade,single_spend_limit,daily_spend_limit FROM agent_policies WHERE agent_id=$1', [agentId])).rows[0]).toEqual({ version: '2', can_trade: true, single_spend_limit: '100', daily_spend_limit: '300' });

  await page.getByLabel('凭证标签').fill('浏览器测试凭证');
  await page.getByRole('button', { name: '创建凭证', exact: true }).click();
  const secretField = page.getByLabel('完整访问凭证');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  const key = (await pools.runtime.query('SELECT id,secret_hash FROM agent_keys WHERE agent_id=$1', [agentId])).rows[0];
  expect(Buffer.compare(key.secret_hash, tokenHash(secret))).toBe(0);
  expect((await page.request.get(`/api/v1/agents/${agentId}/wallet`, { headers: { authorization: `Bearer ${secret}` } })).status()).toBe(200);
  expect(JSON.stringify((await pools.runtime.query('SELECT response_body FROM idempotency_requests')).rows)).not.toContain(secret);
  await page.reload();
  await expect(page.getByLabel('完整访问凭证')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByText('已撤销', { exact: true })).toBeVisible();
  expect((await page.request.get('/api/v1/me', { headers: { authorization: `Bearer ${secret}` } })).status()).toBe(401);
  expect((await pools.runtime.query('SELECT revoked_at IS NOT NULL AS revoked FROM agent_keys WHERE id=$1', [key.id])).rows[0].revoked).toBe(true);

  const secondContext = await browser.newContext({ baseURL: origin });
  const secondPage = await secondContext.newPage();
  await login(secondPage, '71002');
  await expect(secondPage.getByRole('heading', { name: '你的工作空间，即将开启' })).toBeVisible();
  const secondUser = (await pools.runtime.query('SELECT id FROM users WHERE github_user_id=71002')).rows[0].id;
  const admission = await page.request.patch(`/api/v1/admin/users/${secondUser}`, { headers: { origin, 'x-csrf-token': await csrf(page), 'idempotency-key': randomUUID() }, data: { status: 'active', reason: 'browser test admission' } });
  expect(admission.status()).toBe(200);
  await secondPage.reload();
  await expect(secondPage.getByRole('heading', { name: /我们的 Agent 小镇/ })).toBeVisible();
  await secondPage.goto(`/agents/${agentId}`);
  await expect(secondPage.getByRole('alert').first()).toContainText('你没有执行此操作的权限');
  await expect(secondPage.getByRole('heading', { name: '浏览器集成 Agent' })).toHaveCount(0);
  for (const suffix of ['policy', 'keys', 'wallet']) expect((await secondPage.request.get(`/api/v1/agents/${agentId}/${suffix}`)).status()).toBe(403);
  await secondContext.close();

  // A legitimate internal reward fixture validates bigint through PostgreSQL, HTTP and the actual UI.
  const session = (await pools.runtime.query('SELECT id,user_id FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [initial.owner_user_id])).rows[0];
  await fund(pools.runtime, { type: 'user', userId: session.user_id, sessionId: session.id }, agentId, '9007199254740993');
  await page.reload();
  await expect(page.getByTestId('available-balance')).toHaveText('9,007,199,254,740,993');
  await expect(page.getByText('可用 +9,007,199,254,740,993', { exact: true })).toBeVisible();
  const report = await page.request.post('/api/v1/admin/reconciliation', { headers: { origin, 'x-csrf-token': await csrf(page), 'idempotency-key': randomUUID() }, data: {} });
  expect((await report.json()).ok).toBe(true);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
  expect((await pools.runtime.query('SELECT revoked_at IS NOT NULL AS revoked FROM user_sessions WHERE id=$1', [session.id])).rows[0].revoked).toBe(true);
});

test('真实 Session 拒绝无 CSRF、错误来源及过期会话', async ({ page }) => {
  await login(page, '71001');
  const missingCsrf = await page.request.post('/api/v1/agents', { headers: { origin, 'idempotency-key': randomUUID() }, data: { name: 'forbidden' } });
  expect((await missingCsrf.json()).error.code).toBe('CSRF_INVALID');
  const foreignOrigin = await page.request.post('/api/v1/agents', { headers: { origin: 'https://foreign.invalid', 'x-csrf-token': await csrf(page), 'idempotency-key': randomUUID() }, data: { name: 'forbidden' } });
  expect((await foreignOrigin.json()).error.code).toBe('CSRF_INVALID');
  expect((await pools.runtime.query('SELECT count(*)::int AS count FROM agents')).rows[0].count).toBe(0);
  await pools.migration.query("UPDATE user_sessions SET expires_at=clock_timestamp()-interval '1 second'");
  await page.reload();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
});

test('完整内测旅程：协作分账、公开成果、购地、物品转售与人工奖励，100积分守恒', async ({ page, browser }) => {
  test.setTimeout(Math.max(test.info().timeout, 90_000));
  const workerContext = await browser.newContext({ baseURL: origin });
  const reviewerContext = await browser.newContext({ baseURL: origin });
  const partnerContext = await browser.newContext({ baseURL: origin });
  try {
    const worker = await workerContext.newPage(), reviewer = await reviewerContext.newPage();
    const partner = await partnerContext.newPage();
    await login(page, '71001');
    await login(worker, '71002');
    await login(reviewer, '71003');
    await login(partner, '71004');
    const users = (await pools.runtime.query('SELECT id,github_user_id FROM users ORDER BY github_user_id')).rows;
    const reviewerId = users.find((user) => user.github_user_id === '71003')!.id;
    async function write(actorPage: Page, method: 'POST' | 'PUT' | 'PATCH', path: string, data: unknown, expectedStatus = 200) {
      const response = await actorPage.request.fetch(path, { method, headers: { origin, 'x-csrf-token': await csrf(actorPage), 'idempotency-key': randomUUID() }, data });
      const body = await response.json();
      expect(response.status(), JSON.stringify(body)).toBe(expectedStatus);
      return body;
    }
    for (const user of users.filter((user) => user.github_user_id !== '71001')) {
      await write(page, 'PATCH', `/api/v1/admin/users/${user.id}`, { status: 'active', reason: '真实浏览器任务闭环验收准入' });
    }
    await worker.reload();
    await reviewer.reload();
    await partner.reload();
    const partnerAgent = await write(partner, 'POST', '/api/v1/agents', { name: '真实协作 Agent' }, 201);
    await write(partner, 'PUT', `/api/v1/agents/${partnerAgent.id}/policy`, { version: '1', can_accept_task: true, can_collaborate: true, can_trade: false, can_redeem_api: false, single_spend_limit: '0', daily_spend_limit: '0' });
    await write(page, 'POST', '/api/v1/admin/github/installations', { installation_id: '99001' });
    const repository = await write(page, 'POST', '/api/v1/admin/repositories', { installation_id: '99001', owner: 'browser-fixtures', name: 'phase-two' }, 201);
    const month = (await pools.runtime.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-01') AS month")).rows[0].month;
    await write(page, 'PUT', `/api/v1/admin/issuance-periods/${month}`, { limit_points: '100', reason: '独立测试库任务奖金预算' });
    await write(page, 'POST', '/api/v1/admin/issuances', { month, amount: '100', reason: '独立测试库任务奖金', business_id: randomUUID() }, 201);

    await worker.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '我的 Agent', exact: true }).click();
    await worker.getByRole('button', { name: '+ 创建 Agent', exact: true }).click();
    await worker.getByLabel('Agent 名称').fill('真实任务 Agent');
    await worker.getByRole('button', { name: '确认创建' }).click();
    await expect(worker.getByRole('heading', { name: '真实任务 Agent 已启用' })).toBeVisible();
    const agentId = new URL(worker.url()).pathname.split('/').at(-1)!;
    await worker.getByRole('switch', { name: '承接任务' }).check();
    await worker.getByRole('switch', { name: '参与协作' }).check();
    await worker.getByRole('button', { name: '保存权限' }).click();
    await expect(worker.getByText('当前版本 2')).toBeVisible();
    await expect(worker.getByTestId('available-balance')).toHaveText('0');

    await page.goto('/tasks/new');
    await page.getByLabel('任务标题', { exact: true }).fill('真实浏览器任务闭环');
    await page.getByLabel('任务目标与说明', { exact: true }).fill('修正文档并提供已合并的 PR。');
    await page.getByRole('combobox', { name: '获准仓库', exact: true }).selectOption(repository.id);
    await page.getByLabel('验收条件', { exact: true }).fill('文档描述准确，tests 检查通过。');
    await page.getByLabel('要求的 GitHub 检查项（每行一项）', { exact: true }).fill('tests');
    await page.getByLabel('固定奖金', { exact: true }).fill('100');
    const deadline = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
    await page.getByLabel('截止时间（北京时间）', { exact: true }).fill(deadline);
    await page.getByRole('combobox', { name: '奖金来源', exact: true }).selectOption('platform');
    await page.getByRole('combobox', { name: '指定验收人', exact: true }).selectOption(reviewerId);
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByRole('heading', { name: '真实浏览器任务闭环', exact: true })).toBeVisible();
    const taskId = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect(page.getByTestId('task-held-points')).toHaveText('0 积分');
    await page.getByRole('checkbox', { name: '已核对合同，确认冻结 100 积分' }).check();
    await page.getByRole('button', { name: '发布并冻结奖金', exact: true }).click();
    await expect(page.getByTestId('task-held-points')).toHaveText('100 积分');
    expect((await pools.runtime.query("SELECT system_key,balance FROM ledger_accounts WHERE system_key IN ('REWARD_POOL','REWARD_RESERVED') ORDER BY system_key")).rows).toEqual([{ system_key: 'REWARD_POOL', balance: '0' }, { system_key: 'REWARD_RESERVED', balance: '100' }]);

    await worker.goto(`/tasks/${taskId}`);
    await worker.getByRole('combobox', { name: '承接 Agent', exact: true }).selectOption(agentId);
    await worker.getByRole('button', { name: '确认接单', exact: true }).click();
    await expect(worker.getByRole('heading', { name: '提交 PR 成果', exact: true })).toBeVisible();
    await worker.getByRole('button', { name: '提出协作协议', exact: true }).click();
    await worker.getByLabel('成员 1 分账积分', { exact: true }).fill('70');
    await worker.getByRole('button', { name: '+ 增加协作者', exact: true }).click();
    await worker.getByRole('combobox', { name: '成员 Agent 2', exact: true }).selectOption(partnerAgent.id);
    await worker.getByRole('textbox', { name: '成员 2 角色', exact: true }).fill('测试协作者');
    await worker.getByRole('textbox', { name: '成员 2 具体交付', exact: true }).fill('验证协作与分账边界');
    await worker.getByLabel('成员 2 分账积分', { exact: true }).fill('30');
    await worker.getByRole('button', { name: '提交协议供确认', exact: true }).click();
    await expect(worker.getByRole('heading', { name: '协议版本 1 · 待全体确认', exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '以此身份接受方案', exact: true }).click();
    await partner.goto(`/tasks/${taskId}`);
    await partner.getByRole('button', { name: '以此身份接受方案', exact: true }).click();
    await expect(partner.getByRole('heading', { name: '当前生效分配 · 协议版本 1', exact: true })).toBeVisible();
    await partner.getByRole('combobox', { name: '记录类型', exact: true }).selectOption('test');
    await partner.getByRole('textbox', { name: '成果说明', exact: true }).fill('完成协作分账测试记录');
    await partner.getByRole('button', { name: '登记成员成果', exact: true }).click();
    await expect(partner.getByText('完成协作分账测试记录', { exact: true })).toBeVisible();
    await partner.getByRole('button', { name: '打开讨论', exact: true }).click();
    await partner.getByRole('combobox', { name: '发送身份', exact: true }).selectOption(partnerAgent.id);
    await partner.getByRole('textbox', { name: '消息内容', exact: true }).fill('协作测试已完成，请送审。');
    await partner.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(partner.getByText('协作测试已完成，请送审。', { exact: true })).toBeVisible();
    await partner.goto('/messages');
    await partner.getByRole('combobox', { name: '发起身份', exact: true }).selectOption(partnerAgent.id);
    await partner.getByRole('combobox', { name: '联系 Agent', exact: true }).selectOption(agentId);
    await partner.getByRole('button', { name: '打开私聊', exact: true }).click();
    await partner.getByRole('textbox', { name: '消息内容', exact: true }).fill('已按30积分协议交付测试记录。');
    await partner.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(partner.getByText('已按30积分协议交付测试记录。', { exact: true })).toBeVisible();
    const privatePath = new URL(partner.url()).pathname;
    await worker.goto(privatePath);
    await expect(worker.getByText('已按30积分协议交付测试记录。', { exact: true })).toBeVisible();
    await worker.goto(`/tasks/${taskId}`);
    await worker.getByLabel('PR 编号', { exact: true }).fill('7');
    await worker.getByLabel('完整提交 SHA', { exact: true }).fill('c'.repeat(40));
    await worker.getByRole('button', { name: '核验并提交成果', exact: true }).click();
    await expect(worker.getByRole('link', { name: 'PR #7 ↗' })).toBeVisible();
    await expect(worker.getByText('待验收', { exact: true })).toBeVisible();
    expect((await pools.runtime.query('SELECT balance FROM ledger_accounts WHERE agent_id=$1 AND bucket=\'AVAILABLE\'', [agentId])).rows[0].balance).toBe('0');
    const submitted = (await pools.runtime.query('SELECT status,version,hold_id,assignee_agent_id FROM tasks WHERE id=$1', [taskId])).rows[0];
    expect(submitted).toMatchObject({ status: 'submitted', assignee_agent_id: agentId });

    await reviewer.goto(`/tasks/${taskId}`);
    await reviewer.getByLabel('验收说明', { exact: true }).fill('已依据合同核对文档与测试结果，接受交付。');
    await reviewer.getByRole('checkbox', { name: '已核对成果满足约定条件，确认结算奖金。' }).check();
    await reviewer.getByRole('button', { name: '验收通过并结算', exact: true }).click();
    await expect(reviewer.getByText('已结算', { exact: true })).toBeVisible();
    await expect(reviewer.getByTestId('task-held-points')).toHaveText('0 积分');
    await worker.goto(`/agents/${agentId}`);
    await expect(worker.getByTestId('available-balance')).toHaveText('70');
    await partner.goto(`/agents/${partnerAgent.id}`);
    await expect(partner.getByTestId('available-balance')).toHaveText('30');
    expect((await pools.runtime.query('SELECT status,captured_total,released_total FROM credit_holds WHERE id=$1', [submitted.hold_id])).rows[0]).toEqual({ status: 'closed', captured_total: '100', released_total: '0' });
    expect((await pools.runtime.query('SELECT status FROM tasks WHERE id=$1', [taskId])).rows[0].status).toBe('settled');

    // A fresh request key cannot pay the completed task again; the authenticated API returns the recorded outcome.
    await write(reviewer, 'POST', `/api/v1/tasks/${taskId}/reviews`, { version: submitted.version, decision: 'accept', reason: '重复提交验收请求' });
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM rewarded_pull_requests WHERE task_id=$1', [taskId])).rows[0].count).toBe(1);
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM journal_transactions WHERE business_key=$1', [`hold:${submitted.hold_id}:finalize`])).rows[0].count).toBe(1);
    // The owner explicitly publishes an accepted result; another user sees only the public projection.
    await worker.goto(`/world/agents/${agentId}`);
    await expect(worker.getByRole('heading', { name: '真实任务 Agent', exact: true })).toBeVisible();
    await worker.getByText('管理公开成果（仅你可见）', { exact: true }).click();
    await worker.getByLabel('授权公开的成果摘要').fill('已完成文档修复与协作验证');
    await worker.getByRole('button', { name: '公开此成果', exact: true }).click();
    await expect(worker.getByRole('heading', { name: '已完成文档修复与协作验证', exact: true })).toBeVisible();
    await reviewer.goto(`/world/agents/${agentId}`);
    await expect(reviewer.getByRole('heading', { name: '已完成文档修复与协作验证', exact: true })).toBeVisible();
    await expect(reviewer.getByText('管理公开成果（仅你可见）', { exact: true })).toHaveCount(0);
    await expect(reviewer.getByText('已按30积分协议交付测试记录。', { exact: true })).toHaveCount(0);
    expect((await pools.runtime.query('SELECT summary FROM world_publications WHERE agent_id=$1 AND task_id=$2', [agentId, taskId])).rows[0].summary).toBe('已完成文档修复与协作验证');

    // Continue with the same earned points; this journey never uses fund() to top up either wallet.
    for (const [actor, id] of [[worker, agentId], [partner, partnerAgent.id]] as const) {
      const policy = await (await actor.request.get(`/api/v1/agents/${id}/policy`)).json();
      await write(actor, 'PUT', `/api/v1/agents/${id}/policy`, { version: policy.version, can_accept_task: true, can_collaborate: true, can_trade: true, can_redeem_api: true, single_spend_limit: '60', daily_spend_limit: '65' });
    }
    const supply = await write(page, 'POST', '/api/v1/admin/market/lands', { plots: [{ code: 'BETA-JOURNEY-01', x: 7, y: 1, area: 100, points_price: '40', building_template: 'studio' }], reason: '独立测试库完整旅程供应' }, 201);
    const landId = supply.lands[0].id;
    const template = await write(page, 'POST', '/api/v1/admin/market/templates', { name: '旅程盆栽', description: '完整旅程的系统购入及二手成交物品', appearance: 'plant', points_price: '5', total_quantity: '1', reason: '隔离测试物品供应' }, 201);
    async function purchase(actor: Page, id: string, button: string, price: string) {
      await actor.getByRole('button', { name: button, exact: true }).click();
      await actor.getByRole('combobox', { name: '付款 Agent', exact: true }).selectOption(id);
      await actor.getByRole('checkbox', { name: '我已确认价格、卖方和交易范围，成交后不能单方撤销。', exact: true }).check();
      await actor.getByRole('button', { name: `支付 ${price} 积分购买`, exact: true }).click();
      await expect(actor.getByRole('status')).toContainText(`交易成功 · ${price} 积分`);
    }
    await worker.goto('/market');
    await purchase(worker, agentId, '查看购地报价', '40');
    expect((await pools.runtime.query('SELECT owner_agent_id FROM land_plots WHERE id=$1', [landId])).rows[0].owner_agent_id).toBe(agentId);
    await worker.getByRole('tab', { name: '装饰物品', exact: true }).click();
    await purchase(worker, agentId, '查看物品报价', '5');
    const item = (await pools.runtime.query('SELECT id FROM item_instances WHERE template_id=$1', [template.id])).rows[0];
    await worker.getByRole('tab', { name: '我的资产', exact: true }).click();
    const ownedItem = worker.getByRole('article').filter({ has: worker.getByRole('heading', { name: '旅程盆栽', exact: true }) });
    await ownedItem.getByText('固定价挂牌出售', { exact: true }).click();
    await ownedItem.getByLabel('挂牌售价', { exact: true }).fill('10');
    await ownedItem.getByRole('button', { name: '确认挂牌', exact: true }).click();
    await expect(ownedItem.getByText('已挂牌', { exact: true })).toBeVisible();
    await partner.goto('/market?tab=resale');
    await purchase(partner, partnerAgent.id, '查看交易报价', '10');
    await partner.getByRole('tab', { name: '我的资产', exact: true }).click();
    await expect(partner.getByRole('heading', { name: '旅程盆栽', exact: true })).toBeVisible();
    expect((await pools.runtime.query('SELECT owner_agent_id FROM item_instances WHERE id=$1', [item.id])).rows[0].owner_agent_id).toBe(partnerAgent.id);

    const rewardPool = await write(page, 'PUT', `/api/v1/admin/reward-pools/${month}`, { version: '0', total_quantity: '1', user_monthly_limit: '1', contact_qq: '123456789', instructions: '完整旅程模拟奖励：仅登记测试结果，不联系 QQ、不执行支付。', status: 'active', reason: '独立测试库奖励预算' }, 201);
    await write(page, 'POST', '/api/v1/admin/reward-offers', { pool_id: rewardPool.id, title: '完整旅程模拟奖励', description: '仅供端到端验收的模拟领取凭证。', points_cost: '20', total_quantity: '1', reason: '隔离测试报价' }, 201);
    await worker.goto('/rewards');
    await worker.getByRole('button', { name: '选择兑换', exact: true }).click();
    await worker.getByRole('combobox', { name: '付款 Agent', exact: true }).selectOption(agentId);
    await worker.getByLabel('本人领取 QQ', { exact: true }).fill('234567890');
    await worker.getByRole('checkbox').check();
    await worker.getByRole('button', { name: '支付 20 积分兑换', exact: true }).click();
    await expect(worker.getByRole('heading', { name: '奖励领取凭证', exact: true })).toBeVisible();
    const redemptionId = new URL(worker.url()).pathname.split('/').at(-1)!;
    const redemption = await (await worker.request.get(`/api/v1/reward-redemptions/${redemptionId}`)).json();
    expect(redemption).toMatchObject({ agent_id: agentId, status: 'pending', points_cost: '20' });
    expect((await partner.request.get(`/api/v1/reward-redemptions/${redemptionId}`)).status()).toBe(403);
    const processing = await write(page, 'POST', `/api/v1/admin/reward-redemptions/${redemptionId}/process`, { version: redemption.version, reason: '模拟核对后锁定领取单' });
    await write(page, 'POST', `/api/v1/admin/reward-redemptions/${redemptionId}/fulfill`, { version: processing.version, reason: '仅登记模拟结果，无真实支付', fulfillment_reference: 'isolated-beta-journey-result' });
    await worker.getByRole('button', { name: '刷新状态', exact: true }).click();
    await expect(worker.getByText('已发放', { exact: true })).toBeVisible();
    expect((await (await worker.request.get('/api/v1/rewards')).json()).remaining_count).toBe('0');

    await worker.goto(`/agents/${agentId}`);
    await partner.goto(`/agents/${partnerAgent.id}`);
    await expect(worker.getByTestId('available-balance')).toHaveText('15');
    await expect(partner.getByTestId('available-balance')).toHaveText('20');
    expect((await pools.runtime.query("SELECT balance FROM ledger_accounts WHERE system_key='RECOVERY'")).rows[0].balance).toBe('65');
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM market_trades')).rows[0].count).toBe(3);
    expect((await pools.runtime.query('SELECT issued_points FROM credit_issuance_periods')).rows).toEqual([{ issued_points: '100' }]);
    await reviewer.goto(`/world/studios/${landId}`);
    await expect(reviewer.getByRole('heading', { name: '默认工作室', exact: true })).toBeVisible();
    await expect(reviewer.getByRole('heading', { name: '已完成文档修复与协作验证', exact: true })).toBeVisible();
    const report = await write(page, 'POST', '/api/v1/admin/reconciliation', {});
    expect(report.ok).toBe(true);
    expect(report.totals).toEqual({ circulating: '100', issuanceControl: '100', issued: '100' });
  } finally {
    await workerContext.close();
    await reviewerContext.close();
    await partnerContext.close();
  }
});
