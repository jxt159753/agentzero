import { test, expect, type Page, type Route } from '@playwright/test';
import type { ItemInstanceDto, ItemTemplateDto, LandPlotDto, MarketAssetsDto, MarketCatalogDto, MarketListingDto } from '../../packages/contracts/src/market.js';

const userId = '13000000-0000-4000-8000-000000000001';
const sellerUser = '13000000-0000-4000-8000-000000000002';
const agentId = '23000000-0000-4000-8000-000000000001';
const landId = '33000000-0000-4000-8000-000000000001';
const templateId = '43000000-0000-4000-8000-000000000001';
const itemId = '53000000-0000-4000-8000-000000000001';
const listingId = '63000000-0000-4000-8000-000000000001';
const operationId = '73000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-07T08:00:00.000Z';
const respond = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockMarket(page: Page, options: { lostResponse?: boolean; ownedListed?: boolean; staleQuote?: boolean; full?: boolean; admin?: boolean; publicLand?: boolean; manyLands?: boolean; stalePrice?: boolean; lostStudioResponse?: boolean } = {}) {
  const land: LandPlotDto = { id: landId, code: 'NORTH-001', x: 4, y: 6, area: 100, points_price: '40', building_template: 'studio', owner_agent_id: options.ownedListed || options.staleQuote ? agentId : null, owner_agent_name: options.ownedListed ? '市场测试 Agent' : null, owner_user_id: options.ownedListed ? userId : null, owner_github_login: options.ownedListed ? 'market-owner' : null, tradeable: !options.publicLand, name: options.ownedListed ? '青绿工作室' : '默认工作室', works_url: options.ownedListed ? 'https://example.com/portfolio' : null, version: '1', active_listing_id: options.ownedListed || options.staleQuote ? listingId : null, created_at: timestamp };
  const template: ItemTemplateDto = { id: templateId, name: '桌面绿植', description: '系统装饰模板，不增加积分产出。', appearance: 'plant', points_price: '5', total_quantity: '2', issued_quantity: '0', remaining_quantity: '2', status: 'active', version: '1', created_at: timestamp };
  const item: ItemInstanceDto = { id: itemId, template_id: templateId, owner_agent_id: agentId, land_id: options.ownedListed ? landId : null, name: '桌面绿植', description: template.description, appearance: 'plant', version: '1', active_listing_id: null, created_at: timestamp };
  const listing: MarketListingDto = { id: listingId, seller_agent_id: agentId, seller_agent_name: '卖方 Agent', seller_user_id: options.staleQuote ? sellerUser : userId, land_id: landId, item_id: null, points_price: '50', status: 'active', version: '1', land, item: null, created_at: timestamp };
  const lands = [land];
  if (options.manyLands) for (let index = 2; index <= 30; index++) lands.push({ ...land, id: `33000000-0000-4000-8000-${String(index).padStart(12, '0')}`, code: `NORTH-${String(index).padStart(3, '0')}`, x: index * 4, y: 6 });
  let hasItem = options.ownedListed ?? false;
  let loseNext = options.lostResponse ?? false;
  let loseStudio = options.lostStudioResponse ?? false;
  let purchases = 0;
  const keys = new Set<string>();
  const writes: { path: string; body: Record<string, unknown>; key: string; csrf: string }[] = [];
  await page.context().addCookies([{ name: 'az_csrf', value: 'market-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', '');
    const body = request.method() === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    const key = request.headers()['idempotency-key'] ?? '';
    if (request.method() !== 'GET') writes.push({ path, body, key, csrf: request.headers()['x-csrf-token'] ?? '' });
    if (path === '/me') return respond(route, { actor: { type: 'user', userId }, user: { id: userId, github_login: 'market-owner', display_name: '资产测试者', status: 'active', role: options.admin ? 'admin' : 'member' } });
    if (path === '/agents') return respond(route, { items: [{ id: agentId, name: '市场测试 Agent', owner_user_id: userId, status: 'active', created_at: timestamp, updated_at: timestamp }], next_cursor: null });
    if (path === '/market' || path === '/admin/market') {
      const catalog: MarketCatalogDto = { settings: { version: '1', user_land_limit: 3 }, user_land_count: options.full ? 3 : land.owner_agent_id ? 1 : 0, lands, templates: [template], listings: land.active_listing_id ? [listing] : [] };
      return respond(route, catalog);
    }
    if (path === `/agents/${agentId}/assets`) {
      const assets: MarketAssetsDto = { agent_id: agentId, settings: { version: '1', user_land_limit: 3 }, user_land_count: land.owner_agent_id ? 1 : 0, lands: land.owner_agent_id ? [land] : [], items: hasItem ? [item] : [], listings: land.active_listing_id ? [listing] : [] };
      return respond(route, assets);
    }
    if (path === `/market/lands/${landId}/buy` || path === `/market/templates/${templateId}/buy`) {
      if (!keys.has(key)) {
        keys.add(key); purchases++;
        if (path.includes('/lands/')) { land.owner_agent_id = agentId; land.owner_agent_name = '市场测试 Agent'; land.owner_user_id = userId; land.owner_github_login = 'market-owner'; }
        else { hasItem = true; template.issued_quantity = '1'; template.remaining_quantity = '1'; }
      }
      if (loseNext) { loseNext = false; return route.abort('failed'); }
      return respond(route, { id: operationId, listing_id: null, land_id: path.includes('/lands/') ? landId : null, item_id: path.includes('/templates/') ? itemId : null, buyer_agent_id: agentId, seller_agent_id: null, points_price: path.includes('/lands/') ? '40' : '5', transaction_id: operationId, created_at: timestamp, operation_id: operationId }, 201);
    }
    if (path === `/market/listings/${listingId}/buy`) return respond(route, { error: { code: 'MARKET_VERSION_CONFLICT', request_id: 'quote-changed' } }, 409);
    if (path === `/market/listings/${listingId}/cancel`) { land.active_listing_id = null; land.version = '2'; listing.status = 'cancelled'; return respond(route, { ...listing, operation_id: operationId }); }
    if (path === `/market/items/${itemId}/place`) { item.land_id = body.land_id as string | null; item.version = '2'; return respond(route, { ...item, operation_id: operationId }); }
    if (path === `/market/lands/${landId}/studio`) {
      if (!keys.has(key)) { keys.add(key); land.name = String(body.name); land.works_url = body.works_url as string | null; land.showcase = body.showcase as LandPlotDto['showcase']; land.version = String(Number(land.version) + 1); }
      if (loseStudio) { loseStudio = false; return route.abort('failed'); }
      return respond(route, { ...land, operation_id: operationId });
    }
    if (path === '/market/listings') { item.active_listing_id = listingId; return respond(route, { ...listing, land: null, land_id: null, item_id: itemId, item, operation_id: operationId }, 201); }
    if (path === '/admin/users') return respond(route, { items: [], next_cursor: null });
    if (path === `/admin/market/lands/${landId}`) {
      if (options.stalePrice) return respond(route, { error: { code: 'MARKET_VERSION_CONFLICT' } }, 409);
      land.points_price = String(body.points_price); land.version = '2';
      return respond(route, { ...land, operation_id: operationId });
    }
    if (path === '/admin/market/lands') {
      const plots = body.plots as { code: string; x: number; y: number; area: number; points_price: string }[];
      const supplied = plots.map((plot, index) => ({ ...land, ...plot, id: `${landId.slice(0, -1)}${index + 2}`, name: '默认工作室', owner_agent_id: null, created_at: timestamp }));
      lands.push(...supplied);
      return respond(route, { lands: supplied, operation_id: operationId }, 201);
    }
    return respond(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  return { writes, lands, purchases: () => purchases };
}

async function confirmPurchase(page: Page, price: string) {
  await page.getByRole('combobox', { name: '付款 Agent', exact: true }).selectOption(agentId);
  await page.getByRole('checkbox', { name: '我已确认价格、卖方和交易范围，成交后不能单方撤销。', exact: true }).check();
  await page.getByRole('button', { name: `支付 ${price} 积分购买`, exact: true }).click();
}

test('购地响应丢失保留原报价与请求键，重试只成交一次并显示回执', async ({ page }) => {
  const state = await mockMarket(page, { lostResponse: true });
  await page.goto('/market');
  await page.getByRole('button', { name: '查看购地报价', exact: true }).click();
  await expect(page.getByRole('region', { name: '确认交易' })).toContainText('积分从该 Agent 钱包支付');
  await expect(page.getByRole('region', { name: '确认交易' })).toContainText('土地产权登记在主人（用户）名下');
  await confirmPurchase(page, '40');
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(page.getByRole('combobox', { name: '付款 Agent', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '支付 40 积分购买', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('交易成功 · 40 积分');
  await expect(page.getByRole('status')).toContainText(operationId);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0]!.body).toEqual({ agent_id: agentId, version: '1' });
  expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
  expect(state.writes[0]!.key).toBe(state.writes[1]!.key);
  expect(state.writes.every((write) => Boolean(write.key) && write.csrf === 'market-csrf')).toBe(true);
  expect(state.purchases()).toBe(1);
  await expect(page.getByText('产权人：@market-owner', { exact: true })).toBeVisible();
  await expect(page.getByText('管理 Agent：市场测试 Agent', { exact: true })).toBeVisible();
  expect(state.lands[0]).toMatchObject({ owner_user_id: userId, owner_agent_id: agentId });
  await page.screenshot({ path: '.local/phase-5-market-desktop.png', fullPage: true });
});

test('失效二手报价显示冲突，不显示成交成功', async ({ page }) => {
  const state = await mockMarket(page, { staleQuote: true });
  await page.goto('/market?tab=resale');
  await page.getByRole('button', { name: '查看交易报价', exact: true }).click();
  await expect(page.getByRole('region', { name: '确认交易' })).toContainText('卖方 Agent');
  await expect(page.getByRole('region', { name: '确认交易' })).toContainText('卖方装饰物回到原 Agent 库存');
  await expect(page.getByRole('region', { name: '确认交易' })).toContainText('产权转移给买方主人');
  await confirmPurchase(page, '50');
  await expect(page.getByRole('alert')).toContainText('报价或资产已变化');
  await expect(page.getByText('交易成功', { exact: false })).toHaveCount(0);
  expect(state.purchases()).toBe(0);
});

test('窄屏挂牌冻结布置，撤单后取回物品并挂牌', async ({ page }) => {
  const state = await mockMarket(page, { ownedListed: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/market?tab=assets&agent=${agentId}`);
  await expect(page.getByText('产权人：@market-owner', { exact: true })).toBeVisible();
  await expect(page.getByText('管理 Agent：市场测试 Agent', { exact: true })).toBeVisible();
  await expect(page.getByText('土地产权归你所有', { exact: false })).toBeVisible();
  await expect(page.getByText('已挂牌 · 布置冻结', { exact: true })).toBeVisible();
  await expect(page.getByText('编辑工作室展示', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取回库存', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '撤销挂牌', exact: true }).click();
  await expect(page.getByText('编辑工作室展示', { exact: true })).toBeVisible();
  const item = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '桌面绿植', exact: true }) });
  await item.getByRole('combobox', { name: '物品位置', exact: true }).selectOption('');
  await item.getByRole('button', { name: '取回库存', exact: true }).click();
  await expect(item.getByText('库存中', { exact: true })).toBeVisible();
  await item.getByText('固定价挂牌出售', { exact: true }).click();
  await item.getByLabel('挂牌售价', { exact: true }).fill('7');
  await item.getByRole('button', { name: '确认挂牌', exact: true }).click();
  await expect(item.getByText('已挂牌', { exact: true })).toBeVisible();
  expect(state.writes.map((write) => write.path)).toEqual([`/market/listings/${listingId}/cancel`, `/market/items/${itemId}/place`, '/market/listings']);
  expect(state.writes[2]!.body).toEqual({ agent_id: agentId, item_id: itemId, asset_version: '2', points_price: '7' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/phase-5-assets-mobile.png', fullPage: true });
});

test('用户持地上限阻止新购地，模板物品仍可购买', async ({ page }) => {
  const state = await mockMarket(page, { full: true });
  await page.goto('/market');
  await expect(page.getByRole('button', { name: '已达持有上限', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: '装饰物品', exact: true }).click();
  await page.getByRole('button', { name: '查看物品报价', exact: true }).click();
  await confirmPurchase(page, '5');
  await expect(page.getByRole('status')).toContainText('交易成功 · 5 积分');
  await page.getByRole('tab', { name: '我的资产', exact: true }).click();
  await expect(page.getByText('库存中', { exact: true })).toBeVisible();
  expect(state.writes[0]!.path).toBe(`/market/templates/${templateId}/buy`);
});

test('管理员批量发布地块，公开新增数量和每块原定价', async ({ page }) => {
  const state = await mockMarket(page, { admin: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: '市场供应', exact: true }).click();
  const form = page.locator('section').filter({ has: page.getByRole('heading', { name: '批量发布土地', exact: true }) });
  await form.getByLabel('地块编号', { exact: true }).fill('SOUTH-001');
  await form.getByLabel('面积', { exact: true }).fill('80');
  await form.getByLabel('位置 X', { exact: true }).fill('4');
  await form.getByLabel('位置 Y', { exact: true }).fill('6');
  await form.getByLabel('系统售价', { exact: true }).fill('30');
  await form.getByRole('button', { name: '添加一块土地', exact: true }).click();
  await form.getByLabel('地块编号', { exact: true }).nth(1).fill('SOUTH-002');
  await form.getByLabel('面积', { exact: true }).nth(1).fill('90');
  await form.getByLabel('位置 X', { exact: true }).nth(1).fill('5');
  await form.getByLabel('位置 Y', { exact: true }).nth(1).fill('6');
  await form.getByLabel('系统售价', { exact: true }).nth(1).fill('35');
  await form.getByLabel('操作理由', { exact: true }).fill('新区域土地供应');
  await form.getByRole('button', { name: '发布土地供应', exact: true }).click();
  await expect(page.getByText('SOUTH-001：30 积分；SOUTH-002：35 积分', { exact: false })).toBeVisible();
  expect(state.writes[0]!.body).toEqual({ plots: [{ code: 'SOUTH-001', x: 4, y: 6, area: 80, points_price: '30', building_template: 'studio' }, { code: 'SOUTH-002', x: 5, y: 6, area: 90, points_price: '35', building_template: 'studio' }], reason: '新区域土地供应' });
});

test('公共地块展示不可购买且不发起交易', async ({ page }) => {
  const state = await mockMarket(page, { publicLand: true });
  await page.goto('/market');
  await expect(page.getByRole('button', { name: '公共区域不可购买', exact: true })).toBeDisabled();
  await expect(page.getByText('公共区域 · 不可买卖', { exact: true })).toBeVisible();
  expect(state.purchases()).toBe(0);
});

test('从小镇指定地块直接打开报价，列表按需加载且可搜索', async ({ page }) => {
  const state = await mockMarket(page, { manyLands: true });
  await page.goto(`/market?land=${landId}`);
  await expect(page.getByRole('region', { name: '确认交易' })).toContainText('确认购买：NORTH-001');
  await expect(page.getByRole('article')).toHaveCount(24);
  await page.getByRole('button', { name: '收起报价', exact: true }).click();
  await page.getByRole('button', { name: '加载更多地块', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(30);
  await page.getByRole('searchbox', { name: '查找地块', exact: true }).fill('NORTH-030');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article')).toContainText('NORTH-030');
  expect(state.writes).toHaveLength(0);
});

test('管理员单独改价携带版本并更新报价，不改动其他地块', async ({ page }) => {
  const state = await mockMarket(page, { admin: true, manyLands: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: '市场供应', exact: true }).click();
  const pricing = page.getByRole('region', { name: '逐块调整售价', exact: true });
  await pricing.getByRole('searchbox', { name: '筛选待售地块', exact: true }).fill('NORTH-001');
  await pricing.getByLabel('新的系统售价', { exact: true }).fill('125');
  await pricing.getByLabel('操作理由', { exact: true }).fill('单独调整中心地块售价');
  await pricing.getByRole('button', { name: '保存此地块售价', exact: true }).click();
  await expect(pricing).toContainText('当前售价 125 积分 · 报价版本 2');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ path: `/admin/market/lands/${landId}`, body: { version: '1', points_price: '125', reason: '单独调整中心地块售价' }, csrf: 'market-csrf' });
  expect(state.writes[0]!.key).toBeTruthy();
  expect(state.lands.slice(1).every(land => land.points_price === '40')).toBe(true);
  await page.goto(`/market?land=${landId}`);
  await expect(page.getByRole('region', { name: '确认交易' })).toContainText('固定价格 125 积分');
});

test('调价冲突显示刷新提示，已售地不提供管理员改价', async ({ page }) => {
  await mockMarket(page, { admin: true, stalePrice: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: '市场供应', exact: true }).click();
  const pricing = page.getByRole('region', { name: '逐块调整售价', exact: true });
  await pricing.getByLabel('新的系统售价', { exact: true }).fill('125');
  await pricing.getByLabel('操作理由', { exact: true }).fill('调价冲突检查');
  await pricing.getByRole('button', { name: '保存此地块售价', exact: true }).click();
  await expect(pricing.getByRole('alert')).toContainText('报价或资产已变化');
  await expect(pricing).toContainText('当前售价 40 积分');
  await page.unrouteAll();
  await mockMarket(page, { admin: true, ownedListed: true });
  await page.reload();
  await page.getByRole('tab', { name: '市场供应', exact: true }).click();
  await expect(pricing.getByRole('button', { name: '保存此地块售价', exact: true })).toHaveCount(0);
  await expect(pricing).toContainText('没有可调价的地块');
});

test('运营供地在提交前标记公共广场重叠', async ({ page }) => {
  const state = await mockMarket(page, { admin: true });
  await page.goto('/operations');
  await page.getByRole('tab', { name: '市场供应', exact: true }).click();
  const form = page.locator('section').filter({ has: page.getByRole('heading', { name: '批量发布土地', exact: true }) });
  await form.getByLabel('地块编号', { exact: true }).fill('PUBLIC-CONFLICT');
  await form.getByLabel('面积', { exact: true }).fill('100');
  await form.getByLabel('位置 X', { exact: true }).fill('0');
  await form.getByLabel('位置 Y', { exact: true }).fill('0');
  await form.getByLabel('系统售价', { exact: true }).fill('30');
  await form.getByLabel('操作理由', { exact: true }).fill('测试公共区域边界');
  await expect(form.getByText('所选地块与公共区域重叠，请调整位置或面积。')).toBeVisible();
  await expect(form.getByRole('button', { name: '发布土地供应', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});

test('地块展示保存文字图片视频网页、调整顺序，刷新后可编辑和清空', async ({ page }) => {
  const state = await mockMarket(page, { ownedListed: true });
  await page.goto(`/market?tab=assets&agent=${agentId}`);
  await page.getByRole('button', { name: '撤销挂牌', exact: true }).click();
  await page.getByText('编辑工作室展示', { exact: true }).click();
  const form = page.getByRole('form', { name: '工作室展示设置' });
  await form.getByRole('button', { name: '添加展示内容', exact: true }).click();
  await form.getByLabel('展示 1 标题', { exact: true }).fill('欢迎来到我的地块');
  await form.getByLabel('展示 1 文字', { exact: true }).fill('第一行介绍\n第二行介绍');
  for (const [index, type, url] of [[2, 'image', 'https://example.com/image.png'], [3, 'video', 'https://example.com/video.mp4'], [4, 'webpage', 'https://example.com/portfolio']] as const) {
    await form.getByRole('button', { name: '添加展示内容', exact: true }).click();
    await form.getByLabel(`展示 ${index} 类型`, { exact: true }).selectOption(type);
    await form.getByLabel(`展示 ${index} 链接`, { exact: true }).fill(url);
  }
  await form.getByRole('button', { name: '上移展示 4', exact: true }).click();
  await form.getByRole('button', { name: '保存工作室', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('已保存');
  const saved = state.writes.at(-1)!;
  expect(saved).toMatchObject({ path: `/market/lands/${landId}/studio`, csrf: 'market-csrf', body: { version: '2', agent_id: agentId, showcase: [
    { type: 'text', title: '欢迎来到我的地块', text: '第一行介绍\n第二行介绍' },
    { type: 'image', url: 'https://example.com/image.png' },
    { type: 'webpage', url: 'https://example.com/portfolio' },
    { type: 'video', url: 'https://example.com/video.mp4' },
  ] } });
  expect(saved.key).toBeTruthy();
  await page.reload();
  await page.getByText('编辑工作室展示', { exact: true }).click();
  await expect(form.getByLabel('展示 1 文字', { exact: true })).toHaveValue('第一行介绍\n第二行介绍');
  await expect(form.getByLabel('展示 3 类型', { exact: true })).toHaveValue('webpage');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await form.getByLabel('展示 1 标题', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/town-showcase-editor-mobile.png', fullPage: true });
  for (let count = 4; count > 0; count--) await form.getByRole('button', { name: '移除展示 1', exact: true }).click();
  await form.getByRole('button', { name: '保存工作室', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('已保存');
  expect(state.writes.at(-1)!.body.showcase).toEqual([]);
});

test('展示编辑限制八项与HTTPS，空白文字不能提交', async ({ page }) => {
  const state = await mockMarket(page, { ownedListed: true });
  await page.goto(`/market?tab=assets&agent=${agentId}`);
  await page.getByRole('button', { name: '撤销挂牌', exact: true }).click();
  await page.getByText('编辑工作室展示', { exact: true }).click();
  const form = page.getByRole('form', { name: '工作室展示设置' });
  await form.getByRole('button', { name: '添加展示内容', exact: true }).click();
  await form.getByLabel('展示 1 文字', { exact: true }).fill('   ');
  await expect(form.getByRole('button', { name: '保存工作室', exact: true })).toBeDisabled();
  await form.getByLabel('展示 1 类型', { exact: true }).selectOption('webpage');
  await form.getByLabel('展示 1 链接', { exact: true }).fill('http://example.com');
  await form.getByRole('button', { name: '保存工作室', exact: true }).click();
  expect(await form.getByLabel('展示 1 链接', { exact: true }).evaluate((node: HTMLInputElement) => node.validity.valid)).toBe(false);
  expect(state.writes).toHaveLength(1);
  for (let index = 1; index < 8; index++) await form.getByRole('button', { name: '添加展示内容', exact: true }).click();
  await expect(form.getByRole('button', { name: '添加展示内容', exact: true })).toBeDisabled();
  await expect(form.getByLabel('展示 8 类型', { exact: true })).toHaveValue('text');
});

test('展示保存响应丢失后刷新市场仍保留编辑，用相同版本与请求键重试', async ({ page }) => {
  const state = await mockMarket(page, { ownedListed: true, lostStudioResponse: true });
  await page.goto(`/market?tab=assets&agent=${agentId}`);
  await page.getByRole('button', { name: '撤销挂牌', exact: true }).click();
  await page.getByText('编辑工作室展示', { exact: true }).click();
  const form = page.getByRole('form', { name: '工作室展示设置' });
  await form.getByRole('button', { name: '添加展示内容', exact: true }).click();
  await form.getByLabel('展示 1 文字', { exact: true }).fill('请保留这条展示');
  await form.getByRole('button', { name: '保存工作室', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(form.getByLabel('展示 1 文字', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '刷新市场', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(form.getByLabel('展示 1 文字', { exact: true })).toHaveValue('请保留这条展示');
  await form.getByRole('button', { name: '保存工作室', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('已保存');
  expect(state.writes).toHaveLength(3);
  expect(state.writes[1]!.key).toBe(state.writes[2]!.key);
  expect(state.writes[1]!.body).toEqual(state.writes[2]!.body);
  expect(state.writes[2]!.body.version).toBe('2');
  expect(state.lands[0]!.version).toBe('3');
});
