import { expect, test, type Page, type Route } from '@playwright/test';
import { WORLD_BOUNDS, WORLD_PLACES, WORLD_PUBLIC_AREAS, type WorldLand, type WorldSnapshot } from '../../packages/contracts/src/world.js';

const userId = '14000000-0000-4000-8000-000000000001';
const agentId = '24000000-0000-4000-8000-000000000001';
const landId = '34000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-08T08:00:00.000Z';
const webpage = 'https://showcase.example/website';
const respond = (route: Route, data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });

async function mockStudio(page: Page) {
  const land: WorldLand = { id: landId, code: 'WEB-01', x: 5, y: 4, area: 900, width: 3, height: 3,
    name: '网页展示地块', works_url: null, owner_agent_id: agentId, owner_name: '展示 Agent',
    owner: { id: userId, github_login: 'owner', display_name: '主人' }, tradeable: true, purchasable: false,
    points_price: '40', version: '1', listing: null, decorations: [],
    showcase: [{ type: 'webpage', title: '个人主页', url: webpage }] };
  const world: WorldSnapshot = { server_time: timestamp, presence_ttl_seconds: 60,
    self: { kind: 'visitor', id: userId, x: 0, y: 0, online: true }, bounds: WORLD_BOUNDS,
    places: WORLD_PLACES, public_areas: WORLD_PUBLIC_AREAS, lands: [land], agents: [], visitors: [] };
  await page.routeWebSocket('**/api/v1/world/stream?v=2', socket => socket.send(JSON.stringify({ type: 'snapshot', world })));
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path === '/me') return respond(route, { actor: { type: 'user', userId }, user: { id: userId, github_login: 'owner', display_name: '主人', status: 'active', role: 'member' } });
    if (path === '/world') return respond(route, world);
    if (path === `/world/studios/${landId}`) return respond(route, { land, agent: null, works: [] });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND' } }) });
  });
}

for (const [policy, headers] of [
  ['X-Frame-Options', { 'X-Frame-Options': 'DENY' }],
  ['frame-ancestors', { 'Content-Security-Policy': "frame-ancestors 'none'" }],
] as const) {
  test(`网页默认内嵌被 ${policy} 拒绝时仍能在新标签正常浏览`, async ({ page, context }) => {
    await mockStudio(page);
    const requests: string[] = [], blocked: string[] = [];
    page.on('console', message => { if (message.type() === 'error') blocked.push(message.text()); });
    await context.route(webpage, route => {
      requests.push(route.request().url());
      return route.fulfill({ contentType: 'text/html; charset=utf-8', headers, body: '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>个人主页</h1><p id="state"></p><script>localStorage.setItem("website-access", "ok"); document.getElementById("state").textContent = "完整网页已打开";</script></body></html>' });
    });
    await page.goto(`/world/studios/${landId}`);
    const display = page.getByRole('region', { name: '地块展示', exact: true });
    await expect(display.getByRole('link', { name: '打开网页 ↗', exact: true })).toBeVisible();
    await expect(display.locator('iframe')).toHaveCount(1);
    await expect.poll(() => requests).toEqual([webpage]);
    await expect(display).toContainText('部分网站禁止内嵌或需要登录');
    await expect(display.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await expect.poll(() => blocked.some(message => message.includes(policy))).toBe(true);
    await expect(display.locator('iframe').contentFrame().getByRole('heading', { name: '个人主页', exact: true })).toHaveCount(0);
    const popupPromise = context.waitForEvent('page');
    await display.getByRole('link', { name: '打开网页 ↗', exact: true }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(webpage);
    await expect(popup.getByRole('heading', { name: '个人主页', exact: true })).toBeVisible();
    await expect(popup.getByText('完整网页已打开', { exact: true })).toBeVisible();
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.close();
    await display.getByRole('button', { name: '收起预览', exact: true }).click();
    await expect(display.locator('iframe')).toHaveCount(0);
    await expect(display.getByRole('link', { name: '打开网页 ↗', exact: true })).toBeVisible();
    await display.getByRole('button', { name: '展开预览', exact: true }).click();
    await expect(display.locator('iframe')).toHaveCount(1);
  });
}

test('默认内嵌网页在桌面和手机自动缩放完整宽度，长页仍可滚动操作', async ({ page, context }) => {
  await mockStudio(page);
  await context.route(webpage, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:1024px}main{width:1024px;height:1500px;background:#e2eddc}header{display:flex;justify-content:space-between;height:80px;background:#678963;color:white}button{margin-top:1300px}
    </style></head><body><main><header><span data-testid="left-edge">左侧内容</span><span data-testid="right-edge">右侧内容</span></header><button onclick="this.textContent='已浏览完整页面'">页面底部操作</button></main></body></html>` }));
  await page.goto(`/world/studios/${landId}`);
  const display = page.getByRole('region', { name: '地块展示', exact: true });
  const viewport = display.locator('[data-webpage-viewport]'), iframe = display.locator('iframe');
  const frame = iframe.contentFrame();
  let desktopWidth = 0;
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await expect(iframe).toBeVisible();
    await expect(frame.getByTestId('right-edge')).toBeVisible();
    await expect.poll(async () => {
      const outer = (await viewport.boundingBox())!, inner = (await iframe.boundingBox())!;
      return Math.abs(outer.width - inner.width);
    }).toBeLessThan(3);
    const outer = (await viewport.boundingBox())!, inner = (await iframe.boundingBox())!;
    const left = (await frame.getByTestId('left-edge').boundingBox())!, right = (await frame.getByTestId('right-edge').boundingBox())!;
    expect(inner.width).toBeGreaterThan(250);
    expect(inner.x).toBeGreaterThanOrEqual(outer.x); expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
    expect(left.x).toBeGreaterThanOrEqual(inner.x - 1); expect(right.x + right.width).toBeLessThanOrEqual(inner.x + inner.width + 1);
    expect(await frame.locator('html').evaluate(element => ({ width: window.innerWidth, overflow: element.scrollWidth > window.innerWidth }))).toEqual({ width: Math.max(1024, Math.round(inner.width)), overflow: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (name === 'desktop') desktopWidth = inner.width;
    else { expect(inner.width).toBeLessThan(1024); expect(inner.width).toBeLessThan(desktopWidth); }
    await viewport.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.local/showcase-web-scaled-${name}.png`, fullPage: true });
  }
  await frame.getByRole('button', { name: '页面底部操作', exact: true }).click();
  await expect(frame.getByRole('button', { name: '已浏览完整页面', exact: true })).toBeVisible();
});
