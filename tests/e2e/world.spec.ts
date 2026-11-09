import { test, expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import { WORLD_BOUNDS, WORLD_PUBLIC_AREAS, WORLD_PLACES, type PublicWorldWork, type WorldLand, type WorldSnapshot } from '../../packages/contracts/src/world.js';
import { WORLD_MODEL_CATALOG, type WorldModelDraft } from '../../packages/contracts/src/world-models.js';
import { WORLD_ASSETS } from '../../apps/web/src/world-assets.js';
import { generateDefaultLandPlots } from '../../apps/api/src/modules/market/default-land.js';

const userId = '14000000-0000-4000-8000-000000000001';
const otherUserId = '14000000-0000-4000-8000-000000000002';
const agentId = '24000000-0000-4000-8000-000000000001';
const otherAgentId = '24000000-0000-4000-8000-000000000002';
const landId = '34000000-0000-4000-8000-000000000001';
const taskId = '44000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-07T09:00:00.000Z';
const respond = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

async function mockWorld(page: Page) {
  const land: WorldLand = { id: landId, code: 'TOWN-01', x: 2, y: 1, area: 100, name: '青苔工作室', works_url: 'https://example.com/works', owner_agent_id: agentId, owner_name: '设计伙伴', owner: { id: userId, github_login: 'owner', display_name: '小镇主人' }, tradeable: true, purchasable: false, points_price: '40', version: '1', listing: { id: '54000000-0000-4000-8000-000000000001', version: '1', points_price: '50' }, decorations: [{ id: '64000000-0000-4000-8000-000000000001', name: '桌面绿植', appearance: 'plant' }] };
  const world: WorldSnapshot = { server_time: timestamp, presence_ttl_seconds: 60, self: { kind: 'visitor', id: userId, x: 0, y: 0, online: true }, places: WORLD_PLACES, bounds: WORLD_BOUNDS, public_areas: WORLD_PUBLIC_AREAS, lands: [land], agents: [{ id: agentId, name: '设计伙伴', owner: { id: userId, github_login: 'owner', display_name: '小镇主人' }, status: 'active', online: false, x: 2, y: 1 }, { id: otherAgentId, name: '代码伙伴', owner: { id: otherUserId, github_login: 'neighbor', display_name: '邻居' }, status: 'active', online: true, x: -2, y: 1 }], visitors: [{ id: userId, name: '小镇主人', github_login: 'owner', online: true, x: 0, y: 0 }, { id: otherUserId, name: '邻居', github_login: 'neighbor', online: true, x: 1, y: 0 }] };
  const writes: { path: string; body: Record<string, unknown>; key: string; csrf: string }[] = [];
  const moves: { type: string; seq: number; x: number; y: number; room_id?: string | null; moving: boolean }[] = [];
  const connections = new Set<WebSocketRoute>();
  let summary: string | null = null;
  const work = (): PublicWorldWork[] => summary ? [{ task_id: taskId, summary, pr_url: 'https://github.com/public/project/pull/1', settled_at: timestamp, role: 'lead', collaborators: [{ id: otherAgentId, name: '代码伙伴', owner_user_id: otherUserId }] }] : [];
  const broadcast = () => { for (const connection of connections) connection.send(JSON.stringify({ type: 'snapshot', world })); };
  await page.context().addCookies([{ name: 'az_csrf', value: 'world-csrf', url: 'http://localhost:5173' }]);
  await page.routeWebSocket('**/api/v1/world/stream?v=2', socket => {
    connections.add(socket); socket.send(JSON.stringify({ type: 'snapshot', world }));
    socket.onMessage(data => {
      const message = JSON.parse(String(data));
      if (message.type === 'move') {
        moves.push(message); world.self.x = message.x; world.self.y = message.y; world.self.room_id = message.room_id ?? null; world.visitors[0]!.room_id = message.room_id ?? null;
        world.visitors[0]!.x = message.x; world.visitors[0]!.y = message.y;
        socket.send(JSON.stringify({ type: 'ack', seq: message.seq, x: message.x, y: message.y, persisted: !message.moving }));
        for (const connection of connections) connection.send(JSON.stringify({ type: 'delta', server_time: world.server_time, visitors: { upsert: [world.visitors[0]], remove: [] }, self: world.self }));
      } else if (message.type === 'heartbeat') socket.send(JSON.stringify({ type: 'ping', server_time: world.server_time }));
    });
    // Match the real stream's idle ping cadence, including while the visitor only looks around.
    const ping = setInterval(() => socket.send(JSON.stringify({ type: 'ping', server_time: world.server_time })), 2000);
    const close = () => { clearInterval(ping); connections.delete(socket); page.off('close', close); };
    socket.onClose(close); page.once('close', close);
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', '');
    const body = request.method() === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    if (request.method() !== 'GET') writes.push({ path, body, key: request.headers()['idempotency-key'] ?? '', csrf: request.headers()['x-csrf-token'] ?? '' });
    if (path === '/me') return respond(route, { actor: { type: 'user', userId }, user: { id: userId, github_login: 'owner', display_name: '小镇主人', status: 'active', role: 'member' } });
    if (path.startsWith('/games/machines/')) return respond(route, { placement_id: path.split('/').at(-1), game: null });
    if (path === '/world') return respond(route, world);
    if (path === '/world/presence') {
      if (typeof body.x === 'number' && typeof body.y === 'number') { world.self.x = body.x; world.self.y = body.y; world.visitors[0]!.x = body.x; world.visitors[0]!.y = body.y; }
      if ('room_id' in body) { world.self.room_id = body.room_id as string | null; world.visitors[0]!.room_id = world.self.room_id; }
      broadcast(); return respond(route, { self: world.self });
    }
    if (path.startsWith(`/world/studios/${landId}/models`)) {
      const models = land.models ??= [], id = path.split('/')[5];
      land.version = String(Number(land.version) + 1);
      if (request.method() === 'DELETE') {
        land.models = models.filter(model => model.id !== id); broadcast();
        return respond(route, { deleted: true, id, land_version: land.version });
      }
      const existing = models.find(model => model.id === id);
      const placement = { ...existing, ...body as unknown as WorldModelDraft, id: existing?.id ?? `74000000-0000-4000-8000-${String(models.length + 1).padStart(12, '0')}`, version: String(Number(existing?.version ?? 0) + 1) };
      if (existing) models[models.indexOf(existing)] = placement; else models.push(placement);
      broadcast(); return respond(route, { placement, land_version: land.version }, existing ? 200 : 201);
    }
    if (path === `/world/studios/${landId}`) return respond(route, { land, agent: world.agents.find((agent) => agent.id === land.owner_agent_id) ?? null, works: land.owner_agent_id === agentId ? work() : [] });
    if (path === `/world/agents/${agentId}` || path === `/world/agents/${otherAgentId}`) { const id = path.split('/').at(-1); return respond(route, { agent: world.agents.find((agent) => agent.id === id), lands: world.lands.filter((value) => value.owner_agent_id === id), works: id === agentId ? work() : [] }); }
    if (path === `/world/agents/${agentId}/publication-options`) return respond(route, { items: [{ task_id: taskId, title: '公开仓库的已验收任务', pr_url: 'https://github.com/public/project/pull/1', summary, role: 'lead' }] });
    if (path === `/world/agents/${agentId}/works/${taskId}`) { summary = request.method() === 'DELETE' ? null : String(body.summary); return respond(route, { ok: true, operation_id: taskId }); }
    return respond(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  return { world, land, writes, moves, broadcast, connections };
}

test('房屋入口可进入独立室内，室内移动保留房间并从出口返回门外', async ({ page }) => {
  const state = await mockWorld(page), roomId = '74000000-0000-4000-8000-000000000001';
  Object.assign(state.land, { x: 5, y: 4, width: 3, height: 3, area: 900, listing: null, decorations: [], models: [
    { id: roomId, version: '1', model_id: 'cabin', x: 0, y: 0, rotation: 90, scale: 1 },
  ] });
  Object.assign(state.world.self, { x: 5.985, y: 4 }); Object.assign(state.world.visitors[0]!, { x: 5.985, y: 4 });
  await page.goto('/world'); const map = page.getByTestId('world-map');
  await page.getByRole('button', { name: 'E · 进入房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-id', roomId);
  await expect(map).toHaveAttribute('data-self-x', '0'); await expect(map).toHaveAttribute('data-self-y', '0.95');
  await page.screenshot({ path: '.local/room-interior.png', fullPage: true });
  await map.focus(); await page.keyboard.down('s');
  await expect.poll(async () => Number(await map.getAttribute('data-self-y'))).toBeGreaterThan(1.1);
  await page.keyboard.up('s');
  expect(Number(await map.getAttribute('data-self-y'))).toBeLessThanOrEqual(1.12);
  await expect.poll(() => state.moves.some(move => move.room_id === roomId)).toBe(true);
  await page.getByRole('button', { name: 'E · 离开房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-id', '');
  await expect(map).toHaveAttribute('data-self-x', '5.985'); await expect(map).toHaveAttribute('data-self-y', '4');
  expect(state.writes.filter(write => write.path === '/world/presence').map(write => write.body.room_id)).toEqual([roomId, null]);
});

test('布置面板选择房屋室内，保存游戏机后重新进入仍可看到布置', async ({ page }) => {
  const state = await mockWorld(page), roomId = '74000000-0000-4000-8000-000000000001';
  Object.assign(state.land, { x: 5, y: 4, width: 3, height: 3, area: 900, listing: null, decorations: [], models: [
    { id: roomId, version: '1', model_id: 'cabin', x: 0, y: 0, rotation: 0, scale: 1 },
  ] });
  Object.assign(state.world.self, { x: 5, y: 4.985 }); Object.assign(state.world.visitors[0]!, { x: 5, y: 4.985 });
  await page.goto('/world'); const map = page.getByTestId('world-map');
  await page.getByRole('button', { name: '布置模型', exact: true }).click();
  const builder = page.getByRole('complementary', { name: '模型布置' });
  await builder.getByLabel('选择布置空间', { exact: true }).selectOption(roomId);
  await expect(map).toHaveAttribute('data-room-id', roomId);
  const catalog = builder.getByRole('group', { name: '免费模型库' });
  await expect(catalog.getByRole('button', { name: /原木小屋/ })).toHaveCount(0);
  await catalog.getByRole('button', { name: /游戏机/ }).click();
  await builder.getByLabel('模型前后偏移', { exact: true }).fill('7');
  await builder.getByRole('button', { name: '保存布置', exact: true }).click();
  await expect(builder.getByText('模型布置已保存。', { exact: true })).toBeVisible();
  expect(state.land.models?.[1]).toMatchObject({ model_id: 'arcade', room_id: roomId, x: 0, y: 0.7 });
  await builder.getByRole('button', { name: '关闭模型布置', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-id', '');
  await page.getByRole('button', { name: 'E · 进入房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-id', roomId);
  await expect(map).toHaveAttribute('data-model-count', '2');
  await expect(page.getByRole('region', { name: '附近游戏机', exact: true })).toBeVisible();
  await page.screenshot({ path: '.local/room-arcade.png', fullPage: true });
});

for (const mobile of [false, true]) test(`室内暖灯冷窗和接触阴影随昼夜变化，${mobile ? '手机' : '桌面'}切换俯视与室外恢复正确`, async ({ page }) => {
  test.setTimeout(Math.max(test.info().timeout, 60000));
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  else await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const state = await mockWorld(page), roomId = '74000000-0000-4000-8000-000000000001';
  state.world.server_time = '2026-11-07T04:00:00.000Z';
  const furnishing: { model_id: keyof typeof WORLD_MODEL_CATALOG; x: number; y: number; scale: number; rotation: number }[] = [
    { model_id: 'bookshelf', x: -0.25, y: -1.02, scale: 0.55, rotation: 0 },
    { model_id: 'arcade', x: 0.65, y: -0.85, scale: 1.4, rotation: 0 },
    { model_id: 'plant', x: 1.25, y: -0.8, scale: 0.65, rotation: 0 },
    { model_id: 'lamp', x: -1.12, y: -0.55, scale: 1, rotation: 0 },
    { model_id: 'picnic', x: -0.45, y: -0.2, scale: 0.65, rotation: 0 },
    { model_id: 'chair', x: 0.45, y: -0.2, scale: 2, rotation: 315 },
  ];
  Object.assign(state.land, { x: 5, y: 4, width: 3, height: 3, area: 900, listing: null, decorations: [], models: [
    { id: roomId, version: '1', model_id: 'cabin', x: 0, y: 0, rotation: 90, scale: 1 },
    ...furnishing.map((item, index) => ({ ...item, id: `74000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`, version: '1', room_id: roomId })),
  ] });
  Object.assign(state.world.self, { x: 5.985, y: 4 }); Object.assign(state.world.visitors[0]!, { x: 5.985, y: 4 });
  await page.goto('/world'); const map = page.getByTestId('world-map');
  await page.getByRole('button', { name: 'E · 进入房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-id', roomId);
  await expect(map).toHaveAttribute('data-room-lights', mobile ? '2' : '3');
  await expect(map).toHaveAttribute('data-room-shadow-lights', mobile ? '0' : '1');
  await expect(map).toHaveAttribute('data-day-phase', 'day');
  await expect.poll(async () => Number(await map.getAttribute('data-assets-loaded'))).toBeGreaterThanOrEqual(10);
  const dayWindowStrength = Number(await map.getAttribute('data-room-window-strength'));
  const name = mobile ? 'mobile' : 'desktop';
  await page.screenshot({ path: `.local/room-lighting-${name}-day.png`, fullPage: true });
  state.world.server_time = '2026-11-07T14:00:00.000Z'; state.broadcast();
  await expect(map).toHaveAttribute('data-day-phase', 'night');
  expect(Number(await map.getAttribute('data-room-window-strength'))).toBeLessThan(dayWindowStrength / 2);
  await page.screenshot({ path: `.local/room-lighting-${name}-night.png`, fullPage: true });
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  await expect(map).toHaveAttribute('data-view', 'overview');
  await page.screenshot({ path: `.local/room-lighting-${name}-overview.png`, fullPage: true });
  await page.getByRole('button', { name: '第一人称', exact: true }).click();
  await expect(map).toHaveAttribute('data-view', 'first-person');
  await page.getByRole('button', { name: 'E · 离开房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-id', '');
  await expect(map).toHaveAttribute('data-room-lights', '0');
  await expect.poll(async () => Number(await map.getAttribute('data-point-lights'))).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('地块展示按访客到边缘的距离出现，实际靠近显示远离收起', async ({ page }) => {
  const state = await mockWorld(page);
  Object.assign(state.land, { x: 4, y: 5, width: 4, height: 4, area: 1600, listing: null, decorations: [],
    showcase: [{ type: 'text', title: '欢迎来访', text: '这里是主人的创作花园。' }] });
  Object.assign(state.world.self, { x: 0, y: 5 }); Object.assign(state.world.visitors[0]!, { x: 0, y: 5 });
  await page.goto('/world');
  const map = page.getByTestId('world-map'), bubble = page.getByRole('region', { name: '附近地块展示', exact: true });
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await expect(bubble).toHaveCount(0);
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  await page.getByRole('button', { name: '向右移动', exact: true }).click();
  await expect(map).toHaveAttribute('data-self-x', '1');
  await expect(bubble).toHaveAttribute('data-land-showcase', landId);
  await expect(bubble).toContainText('青苔工作室');
  await expect(bubble.getByRole('button', { name: /查看展示/ })).toBeVisible();
  // The centre is three units away; the visitor is one unit from the plot edge.
  await page.getByRole('button', { name: '向左移动', exact: true }).click();
  await expect(map).toHaveAttribute('data-self-x', '0');
  await expect(bubble).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
  expect(state.moves.some(move => move.x === 1)).toBe(true);
});

test('展示气泡锚定地块上方，随俯视镜头移动且第一人称转身后隐藏', async ({ page }) => {
  const state = await mockWorld(page);
  Object.assign(state.land, { x: 5, y: 4, width: 3, height: 3, area: 900, listing: null, decorations: [],
    showcase: [{ type: 'text', title: '地块上方的公告', text: '跟随地块，不固定在屏幕角落。' }] });
  const visitor = { x: 5 + Math.sin(-0.65) * 2.6, y: 4 + Math.cos(-0.65) * 2.6 };
  Object.assign(state.world.self, visitor); Object.assign(state.world.visitors[0]!, visitor);
  await page.goto('/world');
  const map = page.getByTestId('world-map'), bubble = page.getByRole('region', { name: '附近地块展示', exact: true });
  await expect(bubble).toBeVisible();
  const initial = (await bubble.boundingBox())!;
  const mapBox = (await map.boundingBox())!;
  expect(Math.abs(initial.x + initial.width / 2 - (mapBox.x + mapBox.width / 2))).toBeLessThan(25);
  // Exercise actual pointer look: the plot is now behind the visitor, then back in front.
  const lookPoint = { x: mapBox.x + 260, y: mapBox.y + mapBox.height * 0.75 };
  await page.mouse.move(lookPoint.x, lookPoint.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(lookPoint.x + 628, lookPoint.y, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await expect(bubble).toBeHidden();
  await page.mouse.move(lookPoint.x + 628, lookPoint.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(lookPoint.x, lookPoint.y, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await expect(bubble).toBeVisible();
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  await expect(bubble).toHaveAttribute('data-view', 'overview');
  await expect(bubble.getByRole('button', { name: /查看展示/ })).toBeVisible();
  const markerBox = (await bubble.boundingBox())!;
  expect(markerBox.width).toBeLessThanOrEqual(220); expect(markerBox.height).toBeLessThanOrEqual(70);
  await expect(bubble.locator('iframe')).toHaveCount(0);
  const label = map.locator(`[data-land-id="${landId}"]`);
  await expect(label).toBeVisible();
  const assertLandAnchor = async () => {
    const alignment = await bubble.evaluate((element, id) => {
      const host = element.closest('[data-testid="world-map"]')!, hostRect = host.getBoundingClientRect();
      const labelRect = host.querySelector(`[data-land-id="${id}"]`)!.getBoundingClientRect();
      const bubbleRect = element.getBoundingClientRect(), tail = getComputedStyle(element, '::after');
      const anchorX = hostRect.x + Number(element.getAttribute('data-anchor-x')), anchorY = hostRect.y + Number(element.getAttribute('data-anchor-y'));
      return { dx: anchorX - (labelRect.x + labelRect.width / 2), dy: labelRect.bottom - anchorY,
        tailDx: bubbleRect.x + parseFloat(tail.left) - anchorX,
        tailDy: bubbleRect.bottom + parseFloat(tail.borderTopWidth) - anchorY };
    }, landId);
    expect(Math.abs(alignment.dx)).toBeLessThan(2);
    // The plot label and the bubble anchor share x/z; the bubble sits slightly higher.
    expect(alignment.dy).toBeGreaterThanOrEqual(0); expect(alignment.dy).toBeLessThan(30);
    expect(Math.abs(alignment.tailDx)).toBeLessThan(2); expect(Math.abs(alignment.tailDy)).toBeLessThan(2);
  };
  await assertLandAnchor();
  const beforeRotate = { x: Number(await bubble.getAttribute('data-anchor-x')), y: Number(await bubble.getAttribute('data-anchor-y')) };
  await page.getByRole('button', { name: '向右旋转视角', exact: true }).click();
  await expect.poll(async () => Math.hypot(Number(await bubble.getAttribute('data-anchor-x')) - beforeRotate.x, Number(await bubble.getAttribute('data-anchor-y')) - beforeRotate.y)).toBeGreaterThan(15);
  await assertLandAnchor();
  const beforePan = Number(await bubble.getAttribute('data-anchor-x'));
  await page.mouse.move(mapBox.x + 100, mapBox.y + mapBox.height * 0.65);
  await page.mouse.down();
  await page.mouse.move(mapBox.x + 170, mapBox.y + mapBox.height * 0.65, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(Number(await bubble.getAttribute('data-anchor-x')) - beforePan)).toBeGreaterThan(30);
  await assertLandAnchor();
  const beforeRoofY = Number(await bubble.getAttribute('data-anchor-y'));
  state.land.models = [{ id: '74000000-0000-4000-8000-000000000001', version: '1', model_id: 'studio', x: 0, y: 0, rotation: 0, scale: 1 }];
  state.broadcast();
  await expect(map).toHaveAttribute('data-model-count', '1');
  await expect.poll(async () => Number(await bubble.getAttribute('data-world-height'))).toBeGreaterThan(WORLD_MODEL_CATALOG.studio.maxHeight);
  await expect.poll(async () => Number(await bubble.getAttribute('data-anchor-y'))).toBeLessThan(beforeRoofY - 10);
  await page.screenshot({ path: '.local/town-showcase-anchored-overview.png', fullPage: true });
  expect(state.moves).toHaveLength(0); expect(state.writes).toHaveLength(0);
});

for (const mobile of [false, true]) test(`平视靠近房屋和高树即可浏览展示，${mobile ? '手机' : '桌面'}无需仰视`, async ({ page }) => {
  test.setTimeout(Math.max(test.info().timeout, 60000));
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  const state = await mockWorld(page);
  // Keep the overview walking target clear of unrelated public-building hit areas.
  Object.assign(state.world, { places: [], public_areas: [] });
  const modelId = '74000000-0000-4000-8000-000000000001';
  Object.assign(state.land, { x: 5, y: 4, width: 3, height: 3, area: 900, listing: null, decorations: [],
    models: [{ id: modelId, version: '1', model_id: 'studio', x: 0, y: 0, rotation: 0, scale: 1 }],
    showcase: [{ type: 'webpage', title: '平视浏览个人主页', url: 'https://showcase.example/eye-level' }] });
  const visitor = { x: 5 + Math.sin(-0.65) * 2.6, y: 4 + Math.cos(-0.65) * 2.6 };
  Object.assign(state.world.self, visitor); Object.assign(state.world.visitors[0]!, visitor);
  await page.route('https://showcase.example/eye-level', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1024px;background:#e4eedc;color:#365840;font-family:sans-serif}header{padding:30px;background:#709266;color:white}main{padding:30px;display:flex;justify-content:space-between}</style></head><body><header><h1>平视即可浏览</h1></header><main><p>地块展示</p><p>完整网页宽度</p></main></body></html>' }));
  await page.goto('/world');
  const map = page.getByTestId('world-map'), bubble = page.getByRole('region', { name: '附近地块展示', exact: true });
  const assertReadable = async () => {
    await expect(bubble).toBeVisible();
    await expect(map).toHaveAttribute('data-camera-pitch', '-0.025');
    await expect(bubble.locator('iframe').contentFrame().getByRole('heading', { name: '平视即可浏览', exact: true })).toBeVisible();
    const mapBox = (await map.boundingBox())!, card = (await bubble.boundingBox())!, frame = (await bubble.locator('iframe').boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(mapBox.x); expect(card.y).toBeGreaterThanOrEqual(mapBox.y);
    expect(card.x + card.width).toBeLessThanOrEqual(mapBox.x + mapBox.width);
    expect(card.y + card.height).toBeLessThanOrEqual(mapBox.y + mapBox.height);
    expect(frame.y).toBeGreaterThanOrEqual(card.y); expect(frame.y + frame.height).toBeLessThanOrEqual(card.y + card.height);
    expect(frame.height).toBeGreaterThan(75);
    await expect(bubble.getByRole('button', { name: '查看工作室 →', exact: true })).toBeInViewport({ ratio: 1 });
  };
  await assertReadable();
  const initialAnchorY = Number(await bubble.getAttribute('data-anchor-y'));
  state.land.models = [{ id: modelId, version: '2', model_id: 'tree', x: 0, y: 0, rotation: 0, scale: 2 }];
  state.broadcast();
  await assertReadable();
  expect(Number(await bubble.getAttribute('data-anchor-y'))).toBeCloseTo(initialAnchorY, 1);
  await page.screenshot({ path: `.local/town-showcase-eye-level-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
  // Keep one actual pointer drag active so mobile can turn even beyond the narrow viewport.
  const mapBox = (await map.boundingBox())!, look = { x: mapBox.x + 55, y: mapBox.y + mapBox.height * 0.72 };
  await page.mouse.move(look.x, look.y); await page.mouse.down({ button: 'right' });
  await page.mouse.move(look.x + 628, look.y, { steps: 8 }); await expect(bubble).toBeHidden();
  await page.mouse.move(look.x, look.y, { steps: 8 }); await page.mouse.up({ button: 'right' });
  await assertReadable();
  expect(state.moves).toHaveLength(0); expect(state.writes).toHaveLength(0);
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  await expect(bubble).toHaveAttribute('data-view', 'overview');
  await expect(bubble.getByRole('button', { name: /查看展示/ })).toBeVisible();
  await expect(bubble.locator('iframe')).toHaveCount(0);
  const marker = (await bubble.boundingBox())!;
  expect(marker.width).toBeLessThanOrEqual(220); expect(marker.height).toBeLessThanOrEqual(70);
  await page.screenshot({ path: `.local/town-showcase-overview-marker-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
  if (!mobile) {
    const point = { x: marker.x + marker.width / 2 + 80, y: marker.y - 110 };
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point)).toBe('CANVAS');
    await page.mouse.click(point.x, point.y);
    await expect.poll(() => state.moves.length).toBeGreaterThan(0);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(bubble.getByRole('button', { name: /查看展示/ })).toBeVisible();
    await page.screenshot({ path: '.local/town-showcase-overview-marker.png', fullPage: true });
    await bubble.getByRole('button', { name: /查看展示/ }).click();
    await expect(page.getByTestId('world-studio')).toContainText('平视浏览个人主页');
    await expect(page.getByTestId('world-studio').locator('iframe')).toHaveCount(1);
    expect(state.writes).toHaveLength(0);
  }
});

test('地块展示气泡分页呈现四类内容，媒体按需加载且手机不溢出', async ({ page }) => {
  test.setTimeout(Math.max(test.info().timeout, 60000));
  const state = await mockWorld(page), requests: string[] = [], errors: string[] = [];
  Object.assign(state.land, { x: 5, y: 4, width: 3, height: 3, area: 900, listing: null, decorations: [], showcase: [
    { type: 'text', title: '创作笔记', text: '欢迎来到青苔工作室\n<script>window.untrustedShowcase = true</script>' },
    { type: 'image', title: '花园一角', url: 'https://showcase.example/garden.svg' },
    { type: 'video', title: '花园短片', url: 'https://showcase.example/garden.mp4' },
    { type: 'webpage', title: '个人作品集', url: 'https://showcase.example/portfolio' },
  ] });
  // Start outside the plot and face its centre with the scene's initial yaw.
  const visitor = { x: 5 + Math.sin(-0.65) * 2.6, y: 4 + Math.cos(-0.65) * 2.6 };
  Object.assign(state.world.self, visitor); Object.assign(state.world.visitors[0]!, visitor);
  Object.assign(state.world.agents[1]!, { x: visitor.x + 0.5, y: visitor.y });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://showcase.example/**', route => {
    const path = new URL(route.request().url()).pathname; requests.push(path);
    if (path === '/missing.svg') return route.abort('failed');
    if (path.endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#c9ddbc"/><path d="M0 260 Q160 160 320 250 T640 210 V360 H0Z" fill="#6f946b"/><circle cx="500" cy="90" r="42" fill="#f1d995"/><text x="40" y="70" font-size="30" fill="#365943">Garden studio</text></svg>' });
    if (path.endsWith('.mp4')) return route.abort('failed');
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1024px;background:#eef4e8;color:#38563c;font-family:sans-serif}header{padding:24px;background:#6f9165;color:white}section{display:flex;justify-content:space-between;padding:32px}article{width:42%;height:300px;background:#d4e3c9;padding:20px;box-sizing:border-box}</style></head><body><header><h1>个人作品集预览</h1></header><section><article>花园设计 · 左侧内容</article><article>建筑作品 · 右侧内容</article></section></body></html>' });
  });
  await page.goto('/world');
  const bubble = page.getByRole('region', { name: '附近地块展示', exact: true }), map = page.getByTestId('world-map');
  const assertActionsInView = async () => {
    const mapBox = (await map.boundingBox())!;
    for (const name of ['下一个展示', '查看工作室 →']) {
      const button = bubble.getByRole('button', { name, exact: true });
      await expect(button).toBeInViewport({ ratio: 1 });
      const box = (await button.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(mapBox.y); expect(box.y + box.height).toBeLessThanOrEqual(mapBox.y + mapBox.height);
    }
  };
  await expect(page.getByRole('region', { name: '附近的 Agent', exact: true })).toContainText('代码伙伴');
  await expect(bubble).toContainText('<script>window.untrustedShowcase = true</script>');
  expect((await bubble.boundingBox())!.width).toBeGreaterThanOrEqual(480);
  expect(await page.evaluate(() => 'untrustedShowcase' in window)).toBe(false);
  expect(requests).toEqual([]);
  await bubble.getByRole('button', { name: '下一个展示', exact: true }).click();
  await expect(bubble.getByRole('img', { name: '花园一角', exact: true })).toBeVisible();
  await expect.poll(() => bubble.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
  expect(requests).toEqual(['/garden.svg']);
  await assertActionsInView();
  await page.screenshot({ path: '.local/town-showcase-anchored-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(bubble).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const bounds = (await bubble.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(330);
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await assertActionsInView();
  await page.screenshot({ path: '.local/town-showcase-anchored-mobile.png', fullPage: true });
  await bubble.getByRole('button', { name: '下一个展示', exact: true }).click();
  const video = bubble.locator('video');
  await expect(video).toHaveAttribute('preload', 'none');
  expect(await video.evaluate(element => ({ autoplay: (element as HTMLVideoElement).autoplay, controls: (element as HTMLVideoElement).controls }))).toEqual({ autoplay: false, controls: true });
  expect(requests).toEqual(['/garden.svg']);
  await video.evaluate(element => { void (element as HTMLVideoElement).play().catch(() => undefined); });
  await expect(bubble).toContainText('视频暂时无法加载');
  await expect(bubble.getByRole('link', { name: '打开视频 ↗', exact: true })).toHaveAttribute('href', 'https://showcase.example/garden.mp4');
  await bubble.getByRole('button', { name: '下一个展示', exact: true }).click();
  await expect(bubble.locator('video')).toHaveCount(0);
  await expect(bubble.locator('iframe')).toHaveCount(1);
  await expect(bubble.getByRole('link', { name: '打开网页 ↗', exact: true })).toHaveAttribute('href', 'https://showcase.example/portfolio');
  await expect(bubble.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(bubble.locator('iframe')).toHaveAttribute('src', 'https://showcase.example/portfolio');
  await expect.poll(() => requests.includes('/portfolio')).toBe(true);
  await expect(bubble.locator('iframe').contentFrame().getByRole('heading', { name: '个人作品集预览', exact: true })).toBeVisible();
  const previewBounds = (await bubble.locator('[data-webpage-viewport]').boundingBox())!, iframeBounds = (await bubble.locator('iframe').boundingBox())!;
  expect(Math.abs(previewBounds.width - iframeBounds.width)).toBeLessThan(3);
  expect(iframeBounds.x).toBeGreaterThanOrEqual(bounds.x);
  expect(iframeBounds.x + iframeBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  const assertPreviewInView = () => expect.poll(() => bubble.locator('iframe').evaluate(iframe => {
    const frame = iframe.getBoundingClientRect(), item = iframe.closest('article')!.getBoundingClientRect();
    return frame.y >= item.y && frame.bottom <= item.bottom + 1;
  })).toBe(true);
  await assertPreviewInView();
  const games = (await page.getByRole('button', { name: '游戏工坊', exact: true }).boundingBox())!;
  const currentBubble = (await bubble.boundingBox())!;
  const overlap = { left: Math.max(games.x, currentBubble.x), top: Math.max(games.y, currentBubble.y), right: Math.min(games.x + games.width, currentBubble.x + currentBubble.width), bottom: Math.min(games.y + games.height, currentBubble.y + currentBubble.height) };
  if (overlap.right > overlap.left && overlap.bottom > overlap.top) {
    expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-land-showcase]')), { x: (overlap.left + overlap.right) / 2, y: (overlap.top + overlap.bottom) / 2 })).toBe(true);
  }
  await assertActionsInView();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: '.local/town-showcase-web-scaled-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(bubble).toBeVisible();
  await assertPreviewInView();
  await assertActionsInView();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: '.local/town-showcase-web-scaled-desktop.png', fullPage: true });
  state.land.showcase = [{ type: 'image', title: '已失效的图片', url: 'https://showcase.example/missing.svg' }]; state.broadcast();
  await expect(bubble.locator('iframe')).toHaveCount(0);
  await expect(bubble).toContainText('图片暂时无法加载');
  await expect(bubble.getByRole('link', { name: '打开图片 ↗', exact: true })).toHaveAttribute('href', 'https://showcase.example/missing.svg');
  expect(state.writes).toHaveLength(0); expect(state.moves).toHaveLength(0); expect(errors).toEqual([]);
});

test('展示气泡支持锁鼠V阅读，并在面板布置断线及展示撤回时收起', async ({ page }) => {
  const state = await mockWorld(page);
  Object.assign(state.land, { x: 5, y: 4, width: 3, height: 3, area: 900, listing: null, decorations: [],
    showcase: [{ type: 'text', title: '公告', text: '今天开放参观。' }] });
  const visitor = { x: 5 + Math.sin(-0.65) * 2.6, y: 4 + Math.cos(-0.65) * 2.6 };
  Object.assign(state.world.self, visitor); Object.assign(state.world.visitors[0]!, visitor);
  await page.goto('/world');
  const map = page.getByTestId('world-map'), bubble = page.getByRole('region', { name: '附近地块展示', exact: true });
  await expect(bubble).toBeVisible();
  await page.getByRole('button', { name: '进入漫游', exact: true }).click();
  await expect(map).toHaveAttribute('data-pointer-locked', 'true');
  await expect(bubble).toBeVisible();
  await page.keyboard.press('v');
  await expect(map).toHaveAttribute('data-pointer-locked', 'false');
  await expect(bubble).toBeFocused();
  await bubble.getByRole('button', { name: '查看工作室 →', exact: true }).click();
  await expect(page.getByTestId('world-studio')).toContainText('今天开放参观。');
  await expect(bubble).toHaveCount(0);
  await page.getByRole('button', { name: '关闭功能面板', exact: true }).click();
  await expect(bubble).toBeVisible();
  await page.getByRole('button', { name: '布置模型', exact: true }).click();
  await expect(bubble).toHaveCount(0);
  await page.getByRole('button', { name: '关闭模型布置', exact: true }).click();
  await expect(bubble).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(bubble).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(bubble).toBeVisible();
  state.land.showcase = []; state.broadcast();
  await expect(bubble).toHaveCount(0);
  state.land.showcase = [{ type: 'text', text: '更新后的地块展示' }]; state.broadcast();
  await expect(bubble).toContainText('更新后的地块展示');
  const ownerAgent = state.land.owner_agent_id;
  state.land.owner_agent_id = null; state.broadcast();
  await expect(bubble).toHaveCount(0);
  state.land.owner_agent_id = ownerAgent; state.broadcast();
  await expect(bubble).toBeVisible();
  state.world.lands = []; state.broadcast();
  await expect(bubble).toHaveCount(0);
  expect(state.writes).toHaveLength(0); expect(state.moves).toHaveLength(0);
});

test('灯椅比例：真实GLB、公共场景与占位模型采用一致人尺度，用户缩放仍等比', async ({ page }) => {
  test.setTimeout(Math.max(test.info().timeout, 60000));
  const state = await mockWorld(page);
  await page.goto('/world');
  await expect(page.getByTestId('world-map')).toHaveAttribute('data-assets-loaded', '7');
  const measured = await page.evaluate(async ({ catalog, world }) => {
    const modelPath = '/src/world-3d-models.ts', environmentPath = '/src/world-environment.ts', threePath = '/node_modules/three/build/three.module.js';
    const [{ TownModels }, { TownEnvironment }, THREE] = await Promise.all([import(modelPath), import(environmentPath), import(threePath)]);
    const models = new TownModels(), ids = ['lamp', 'bench', 'chair'] as const;
    const dimensions = (node: any): number[] => new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3()).multiplyScalar(10).toArray();
    // A fresh pool renders the real fallback before its asynchronous GLB requests complete.
    const fallback = Object.fromEntries(ids.map(id => {
      const spec = catalog[id]; return [id, dimensions(models.asset(id, spec.width, spec.depth, spec.maxHeight))];
    }));
    await models.load(ids);
    const free = Object.fromEntries(ids.map(id => {
      const spec = catalog[id], node = models.asset(id, spec.width, spec.depth, spec.maxHeight), base = dimensions(node);
      node.scale.multiplyScalar(2); return [id, { base, doubled: dimensions(node) }];
    }));
    const lamp = models.asset('lamp', catalog.lamp.width, catalog.lamp.depth, catalog.lamp.maxHeight);
    const lampBounds = new THREE.Box3().setFromObject(lamp);
    const lampHeads = (lamp.userData.lampAnchors as number[][]).map(point => lamp.localToWorld(new THREE.Vector3().fromArray(point)));
    const environment = new TownEnvironment(models); environment.update(world);
    const benches: number[][] = []; let publicLamp: number[] = [], publicHead = 0;
    environment.root.updateMatrixWorld(true);
    environment.root.traverse((node: any) => {
      if (Math.abs(node.position.x) === 1.08 && node.position.y === 0.025 && node.position.z === 0.45) benches.push(dimensions(node));
      if (!node.userData.lampAnchors || !node.children.some((part: any) => part.isInstancedMesh)) return;
      const bounds = new THREE.Box3(), instance = new THREE.Matrix4(), transform = new THREE.Matrix4();
      for (const part of node.children) if (part.isInstancedMesh) {
        part.geometry.computeBoundingBox(); part.getMatrixAt(0, instance); transform.multiplyMatrices(part.matrixWorld, instance);
        bounds.union(part.geometry.boundingBox.clone().applyMatrix4(transform));
      }
      publicLamp = bounds.getSize(new THREE.Vector3()).multiplyScalar(10).toArray();
      publicHead = node.userData.lampAnchors[0][1] * 10;
    });
    const result = { loaded: models.loadedCount, fallback, free, benches, publicLamp, publicHead,
      head: lampHeads[0].y * 10, headInsideModel: lampBounds.containsPoint(lampHeads[0]) };
    environment.dispose(); models.dispose(); return result;
  }, { catalog: WORLD_MODEL_CATALOG, world: state.world });
  expect(measured.loaded).toBe(3);
  expect(measured.free.lamp!.base[1]).toBeCloseTo(4, 4);
  expect(measured.free.bench!.base[0]).toBeCloseTo(1.8, 4);
  expect(measured.free.bench!.base[1]).toBeCloseTo(0.93521, 4);
  expect(measured.free.chair!.base[0]).toBeCloseTo(0.7, 4);
  expect(measured.free.chair!.base[1]).toBeCloseTo(0.98636, 3);
  for (const model of Object.values(measured.free)) model.base.forEach((size, axis) => expect(model.doubled[axis]).toBeCloseTo(size * 2, 5));
  expect(measured.benches).toHaveLength(2);
  for (const size of measured.benches) { expect(Math.max(size[0]!, size[2]!)).toBeCloseTo(1.8, 4); expect(size[1]).toBeCloseTo(0.93521, 4); }
  expect(measured.publicLamp[1]).toBeCloseTo(4, 4);
  expect(measured.headInsideModel).toBe(true); expect(measured.head).toBeGreaterThan(3.3); expect(measured.head).toBeLessThan(3.6);
  expect(measured.publicHead).toBeCloseTo(measured.head + 0.35, 4);
  expect(measured.fallback.lamp![1]).toBeCloseTo(4, 4);
  for (const id of ['bench', 'chair']) { expect(measured.fallback[id]![1]).toBeGreaterThan(0.8); expect(measured.fallback[id]![1]).toBeLessThan(1.05); }
  expect(state.writes).toHaveLength(0); expect(state.moves).toHaveLength(0);
  await test.info().attach('physical-model-dimensions', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
});

test('灯椅比例：近景日夜与手机显示正常，既有布置坐标旋转和用户倍率保持', async ({ page }) => {
  test.setTimeout(Math.max(test.info().timeout, 60000));
  const state = await mockWorld(page), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  state.world.server_time = '2026-11-08T04:00:00.000Z';
  Object.assign(state.world.self, { x: 0.35, y: 1.5 }); Object.assign(state.world.visitors[0]!, { x: 0.35, y: 1.5 });
  state.world.agents = [state.world.agents[1]!]; Object.assign(state.world.agents[0]!, { x: 1.65, y: 0.2 });
  state.world.visitors = [state.world.visitors[0]!];
  Object.assign(state.land, { x: 3, y: 2, width: 3, height: 3, area: 900, listing: null, decorations: [], models: [
    { id: '74000000-0000-4000-8000-000000000001', version: '1', model_id: 'bench', x: -0.6, y: -0.4, rotation: 90, scale: 1 },
    { id: '74000000-0000-4000-8000-000000000002', version: '1', model_id: 'chair', x: 0.4, y: -0.4, rotation: 45, scale: 2 },
    { id: '74000000-0000-4000-8000-000000000003', version: '1', model_id: 'lamp', x: 0.6, y: 0.5, rotation: 180, scale: 1 },
  ] });
  const original = structuredClone(state.land.models);
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-assets-loaded', '8'); await expect(map).toHaveAttribute('data-model-count', '3');
  await expect(map).toHaveAttribute('data-day-phase', 'day');
  await page.screenshot({ path: '.local/town-scale-day.png', fullPage: true });
  state.world.server_time = '2026-11-08T14:00:00.000Z'; state.broadcast();
  await expect(map).toHaveAttribute('data-day-phase', 'night');
  await expect.poll(async () => Number(await map.getAttribute('data-point-lights'))).toBeGreaterThan(0);
  await page.screenshot({ path: '.local/town-scale-night.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/town-scale-mobile.png', fullPage: true });
  expect(state.land.models).toEqual(original); expect(state.writes).toHaveLength(0);
  await page.getByRole('button', { name: '布置模型', exact: true }).click();
  const builder = page.getByRole('complementary', { name: '模型布置' });
  await builder.getByRole('button', { name: /露营椅.*调整/ }).click();
  await expect(builder.getByLabel('模型缩放', { exact: true })).toHaveValue('2');
  await expect(builder.getByLabel('模型旋转角度', { exact: true })).toHaveValue('45');
  await expect(builder.getByLabel('模型左右偏移', { exact: true })).toHaveValue('4');
  await expect(builder.getByLabel('模型前后偏移', { exact: true })).toHaveValue('-4');
  await expect(map).toHaveAttribute('data-placement-valid', 'true');
  await builder.getByRole('button', { name: '保存布置', exact: true }).click();
  await expect(builder.getByText('模型布置已保存。', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ path: `/world/studios/${landId}/models/74000000-0000-4000-8000-000000000002`, body: { x: 0.4, y: -0.4, rotation: 45, scale: 2, version: '1' } });
  expect(state.moves).toHaveLength(0); expect(errors).toEqual([]);
});

test('小镇按服务端北京时间昼夜切换，路灯夜间亮起且不增加同步请求', async ({ page }) => {
  const state = await mockWorld(page), apiRequests: string[] = [], errors: string[] = [];
  state.world.server_time = '2026-11-07T04:00:00.000Z';
  Object.assign(state.world.self, { x: 3, y: 1.5 });
  Object.assign(state.world.visitors[0]!, { x: 3, y: 1.5 });
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/v1/')) apiRequests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await expect(map).toHaveAttribute('data-day-phase', 'day');
  await expect.poll(async () => Number(await map.getAttribute('data-world-hour'))).toBeCloseTo(12, 1);
  await expect.poll(async () => Number(await map.getAttribute('data-lamp-strength'))).toBe(0);
  await expect(map).toHaveAttribute('data-point-lights', '0');
  await map.locator('canvas').evaluate(canvas => canvas.setAttribute('data-lighting-test', 'retained'));
  await page.screenshot({ path: '.local/town-daylight-first-person.png', fullPage: true });
  const initialRequests = apiRequests.length;

  state.world.server_time = '2026-11-07T14:00:00.000Z'; state.broadcast();
  await expect(map).toHaveAttribute('data-day-phase', 'night');
  await expect.poll(async () => Number(await map.getAttribute('data-world-hour'))).toBeCloseTo(22, 1);
  await expect.poll(async () => Number(await map.getAttribute('data-lamp-strength'))).toBeGreaterThan(0.9);
  await expect.poll(async () => Number(await map.getAttribute('data-point-lights'))).toBeGreaterThan(0);
  expect(Number(await map.getAttribute('data-point-lights'))).toBeLessThanOrEqual(4);
  await expect(map.locator('canvas')).toHaveAttribute('data-lighting-test', 'retained');
  await page.screenshot({ path: '.local/town-night-first-person.png', fullPage: true });
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  await page.screenshot({ path: '.local/town-night-overview.png', fullPage: true });
  await page.getByRole('button', { name: '第一人称', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(map).toHaveAttribute('data-day-phase', 'night');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/town-night-mobile.png', fullPage: true });

  state.world.server_time = '2026-11-08T04:00:00.000Z'; state.broadcast();
  await expect(map).toHaveAttribute('data-day-phase', 'day');
  await expect.poll(async () => Number(await map.getAttribute('data-lamp-strength'))).toBe(0);
  await expect(map).toHaveAttribute('data-point-lights', '0');
  await expect(map.locator('canvas')).toHaveAttribute('data-lighting-test', 'retained');
  expect(apiRequests).toHaveLength(initialRequests);
  expect(state.writes).toHaveLength(0);
  expect(state.moves).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('夜间新增的路灯立即参与照明，预览不保存，移除后释放灯位', async ({ page }) => {
  const state = await mockWorld(page);
  state.world.server_time = '2026-11-07T14:00:00.000Z';
  Object.assign(state.land, { listing: null, decorations: [], models: [] });
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await expect(map).toHaveAttribute('data-day-phase', 'night');
  const originalLamps = Number(await map.getAttribute('data-lamp-count'));
  expect(originalLamps).toBeGreaterThan(0);
  await page.getByRole('button', { name: '布置模型', exact: true }).click();
  const builder = page.getByRole('complementary', { name: '模型布置' });
  await builder.getByRole('group', { name: '免费模型库' }).getByRole('button', { name: /路灯/ }).click();
  await expect(map).toHaveAttribute('data-lamp-count', String(originalLamps));
  expect(state.writes).toHaveLength(0);
  await builder.getByRole('button', { name: '保存布置', exact: true }).click();
  await expect(builder.getByText('模型布置已保存。', { exact: true })).toBeVisible();
  await expect(map).toHaveAttribute('data-lamp-count', String(originalLamps + 1));
  await expect.poll(async () => Number(await map.getAttribute('data-lamp-strength'))).toBeGreaterThan(0.9);
  expect(Number(await map.getAttribute('data-point-lights'))).toBeLessThanOrEqual(4);
  expect(state.land.models?.[0]?.model_id).toBe('lamp');
  await builder.getByRole('button', { name: /路灯.*调整/ }).click();
  await builder.getByRole('button', { name: '移除模型', exact: true }).click();
  await expect(builder.getByText('模型已移除。', { exact: true })).toBeVisible();
  await expect(map).toHaveAttribute('data-lamp-count', String(originalLamps));
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0]).toMatchObject({ path: `/world/studios/${landId}/models`, body: { model_id: 'lamp' } });
  expect(state.writes[1]!.path).toBe(`/world/studios/${landId}/models/74000000-0000-4000-8000-000000000001`);
  expect(state.moves).toHaveLength(0);
});

test('离线 Agent 偶遇停留并轮流显示模拟闲聊，不写入消息或移动位置', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-07T09:04:00.000Z') });
  await page.clock.pauseAt(new Date('2026-11-07T09:04:07.000Z'));
  const state = await mockWorld(page);
  state.world.agents[1]!.online = false;
  Object.assign(state.world.self, { x: -1.9, y: -0.2 });
  Object.assign(state.world.visitors[0]!, { x: -1.9, y: -0.2 });
  // At this fixture time the two public walking routes meet on the plaza edge.
  state.world.server_time = '2026-11-07T09:04:07.000Z';
  const original = structuredClone(state.world.agents);
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect.poll(async () => {
    await page.clock.runFor(250);
    return await map.count() ? map.getAttribute('data-renderer') : null;
  }).toBe('three');
  // The six-second encounter must not advance while screenshots and UI assertions run.
  await page.clock.runFor(64);
  const chatting = map.locator('[data-agent-id][data-activity="chat"]');
  await expect(chatting).toHaveCount(2);
  await expect(map.locator('[data-agent-bubble]:visible')).toHaveCount(1);
  await page.screenshot({ path: '.local/town-social-first-person.png', fullPage: true });
  await page.getByRole('button', { name: '俯视地图', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  await page.clock.runFor(64);
  const bubble = map.locator('[data-agent-bubble]:visible');
  await expect(bubble).toHaveCount(1);
  await expect(bubble).toContainText('模拟闲聊');
  const firstLine = await bubble.innerText();
  const positions = await chatting.evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-x'), node.getAttribute('data-y')]));
  await page.clock.runFor(2100);
  await expect(bubble).not.toHaveText(firstLine);
  expect(await chatting.evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-x'), node.getAttribute('data-y')]))).toEqual(positions);
  await page.screenshot({ path: '.local/town-social-greeting.png', fullPage: true });
  await page.clock.runFor(4000);
  await expect(chatting).toHaveCount(0);
  await expect(bubble).toHaveCount(0);
  expect(state.world.agents).toEqual(original);
  expect(state.writes).toHaveLength(0);
  expect(state.moves).toHaveLength(0);
});

test('靠近可联系的 Agent 才显示消息入口，F 解锁鼠标并预选私聊对象', async ({ page }) => {
  const state = await mockWorld(page);
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/agents')) return respond(route, { items: [], next_cursor: null });
    if (path.endsWith('/conversations')) return respond(route, { items: [], next_cursor: null });
    if (path.endsWith('/message-recipients')) return respond(route, { items: state.world.agents.map(agent => ({ id: agent.id, name: agent.name, owner_user_id: agent.owner.id, owner_name: agent.owner.display_name })) });
    return route.fallback();
  });
  await page.goto('/world');
  const map = page.getByTestId('world-map'), nearby = page.getByRole('region', { name: '附近的 Agent', exact: true });
  await expect(map).toHaveAttribute('data-renderer', 'three');
  await expect(nearby).toHaveCount(0);
  Object.assign(state.world.agents[1]!, { x: 0.5, y: 0.2 }); state.broadcast();
  await expect(nearby).toContainText('代码伙伴');
  Object.assign(state.world.agents[1]!, { x: 3, y: 1 }); state.broadcast();
  await expect(nearby).toHaveCount(0);
  Object.assign(state.world.agents[1]!, { x: 0.5, y: 0.2, online: false, status: 'paused' }); state.broadcast();
  await expect(map.locator(`[data-agent-id="${otherAgentId}"]`)).toHaveAttribute('data-x', '0.5');
  await expect(nearby).toHaveCount(0);
  Object.assign(state.world.agents[1]!, { status: 'active', online: true }); state.broadcast();
  await expect(nearby).toContainText('代码伙伴');
  await page.getByRole('button', { name: '进入漫游', exact: true }).click();
  await expect(map).toHaveAttribute('data-pointer-locked', 'true');
  await page.keyboard.press('f');
  await expect(page).toHaveURL(`/messages?agent=${otherAgentId}`);
  await expect(page.getByRole('combobox', { name: '联系 Agent', exact: true })).toHaveValue(otherAgentId);
  expect(await page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  expect(state.writes).toHaveLength(0);
  expect(state.moves).toHaveLength(0);
  await page.getByRole('button', { name: '关闭功能面板', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nearby.getByRole('button', { name: 'F · 发消息', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/town-nearby-agent-mobile.png', fullPage: true });
  await nearby.getByRole('button', { name: 'F · 发消息', exact: true }).click();
  await expect(page).toHaveURL(`/messages?agent=${otherAgentId}`);
});

test('访客名称在头顶显示，靠近出现私聊入口并支持键盘和移动端', async ({ page }) => {
  const state = await mockWorld(page), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  state.world.agents = [];
  const visitor = state.world.visitors[1]!;
  Object.assign(visitor, { x: 1.2, y: -1.6 });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/agents') || path.endsWith('/conversations')) return respond(route, { items: [], next_cursor: null });
    if (path.endsWith('/message-recipients')) return respond(route, { items: [], users: [{ id: visitor.id, name: visitor.name, github_login: visitor.github_login }] });
    return route.fallback();
  });
  await page.goto('/world');
  const map = page.getByTestId('world-map'), name = map.locator(`[data-visitor-id="${otherUserId}"]`);
  const nearby = page.getByRole('region', { name: '附近的访客', exact: true });
  await expect(map).toHaveAttribute('data-renderer', 'three');
  await expect(name).toBeVisible();
  await expect(name).toHaveText('邻居');
  await expect(nearby).toHaveCount(0);
  await expect(map.locator(`[data-visitor-id="${userId}"]`)).toBeHidden();
  Object.assign(visitor, { x: 0.48, y: -0.64 }); state.broadcast();
  await expect(nearby).toContainText('邻居');
  await expect(name).toBeVisible();
  visitor.name = '新邻居'; state.broadcast();
  await expect(name).toHaveText('新邻居');
  await expect(nearby).toContainText('新邻居');
  Object.assign(visitor, { x: 1.2, y: -1.6 }); state.broadcast();
  await expect(nearby).toHaveCount(0);
  Object.assign(visitor, { x: 0.48, y: -0.64, room_id: '74000000-0000-4000-8000-000000000001' }); state.broadcast();
  await expect(name).toHaveCount(0);
  await expect(nearby).toHaveCount(0);
  visitor.room_id = null; state.broadcast();
  await expect(nearby).toContainText('新邻居');
  await page.screenshot({ path: '.local/town-nearby-visitor.png', fullPage: true });
  await page.getByRole('button', { name: '进入漫游', exact: true }).click();
  await expect(map).toHaveAttribute('data-pointer-locked', 'true');
  await page.keyboard.press('f');
  await expect(page).toHaveURL(`/messages?user=${otherUserId}`);
  await expect(page.getByRole('combobox', { name: '联系访客', exact: true })).toHaveValue(otherUserId);
  expect(await page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  await page.getByRole('button', { name: '关闭功能面板', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nearby.getByRole('button', { name: 'F · 发消息', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/town-nearby-visitor-mobile.png', fullPage: true });
  await nearby.getByRole('button', { name: 'F · 发消息', exact: true }).click();
  await expect(page).toHaveURL(`/messages?user=${otherUserId}`);
  await page.getByRole('button', { name: '关闭功能面板', exact: true }).click();
  state.world.visitors = [state.world.visitors[0]!]; state.broadcast();
  await expect(nearby).toHaveCount(0);
  await expect(name).toHaveCount(0);
  expect(state.writes).toHaveLength(0); expect(state.moves).toHaveLength(0); expect(errors).toEqual([]);
});

test('俯瞰时访客显示姓名与本人标识，点击其他访客打开私聊', async ({ page }) => {
  const state = await mockWorld(page);
  state.world.agents = [];
  Object.assign(state.world.visitors[1]!, { x: 0.5, y: -0.5 });
  await page.goto('/world');
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  const map = page.getByTestId('world-map'), name = map.locator(`[data-visitor-id="${otherUserId}"]`);
  await expect(map.locator(`[data-visitor-id="${userId}"]`)).toHaveText('小镇主人 · 你');
  await expect(map.locator(`[data-visitor-id="${userId}"]`)).toBeVisible();
  await expect(name).toBeVisible();
  // The name is projected 0.425 units above the avatar. The overview camera
  // projects that offset vertically, so point just below it at the avatar.
  const labelBox = await name.boundingBox();
  expect(labelBox).not.toBeNull();
  await page.mouse.click(labelBox!.x + labelBox!.width / 2, labelBox!.y + labelBox!.height + 10);
  await expect(page).toHaveURL(`/messages?user=${otherUserId}`);
});

test('共享地图显示真实工作室、独立访客与离线 Agent，移动只提交访客位置', { tag: '@smoke' }, async ({ page }) => {
  const state = await mockWorld(page);
  await page.goto('/world');
  await expect(page.getByTestId('world-connection')).toContainText('已同步');
  await page.getByRole('button', { name: '小镇目录' }).click();
  await expect(page.getByTestId(`world-agent-${agentId}`)).toContainText('离线');
  await expect(page.getByTestId(`world-visitor-${userId}`)).toContainText('用户访客');
  await expect(page.getByTestId(`world-land-${landId}`)).toContainText('设计伙伴');
  await expect(page.getByTestId(`world-land-${landId}`)).toContainText('产权人 @owner');
  await expect(page.getByTestId(`world-land-${landId}`)).toContainText('管理 Agent：设计伙伴');
  await expect(page.getByRole('navigation', { name: '小镇公共区域' }).getByRole('link')).toHaveCount(3);
  await page.getByRole('button', { name: '关闭小镇目录', exact: true }).click();
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  await page.getByRole('button', { name: '向右移动', exact: true }).click();
  await expect(page.getByRole('region', { name: '我的访客角色' })).toContainText('当前位置 (1, 0)');
  await expect.poll(() => state.moves.some(move => move.x === 1 && !move.moving)).toBe(true);
  const movement = state.moves.find(move => move.x === 1);
  expect(movement).toMatchObject({ type: 'move', x: 1, y: 0 });
  expect(Object.keys(movement!).sort()).toEqual(['moving', 'room_id', 'seq', 'type', 'x', 'y']);
  expect(movement!.seq).toBeGreaterThan(0);
  expect(state.writes.filter(write => write.path === '/world/presence')).toHaveLength(0);
  expect(state.world.agents[0]!.online).toBe(false);
  await expect(page.getByRole('region', { name: '小镇地图', exact: true }).locator('canvas')).toBeVisible();
  await page.screenshot({ path: '.local/town-map-desktop.png', fullPage: true });
});

test('断线隐藏旧产权，重复 online 事件仅建立一个新连接并重新取得产权', async ({ page }) => {
  const state = await mockWorld(page);
  await page.goto(`/world/studios/${landId}`);
  await expect(page.getByTestId('world-studio')).toContainText('产权人：@owner');
  await expect(page.getByTestId('world-studio')).toContainText('管理 Agent：设计伙伴');
  await expect(page.getByRole('link', { name: '编辑地块展示与管理挂牌 →', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByRole('region', { name: '小镇详情' })).toContainText('连接恢复后显示最新产权');
  await expect(page.getByTestId('world-studio')).toHaveCount(0);
  await expect(page.getByTestId(`world-land-${landId}`)).toHaveCount(0);
  state.land.owner_agent_id = otherAgentId; state.land.owner_name = '代码伙伴'; state.land.owner = state.world.agents[1]!.owner; state.land.name = '默认工作室'; state.land.works_url = null; state.land.decorations = []; state.land.listing = null; state.land.version = '2';
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online')); });
  await expect(page.getByTestId('world-studio')).toContainText('产权人：@neighbor');
  await expect(page.getByTestId('world-studio')).toContainText('管理 Agent：代码伙伴');
  await expect(page.getByRole('link', { name: '编辑地块展示与管理挂牌 →', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('world-studio')).not.toContainText('桌面绿植');
  await expect(page.getByRole('link', { name: '访问公开作品 ↗', exact: true })).toHaveCount(0);
  await expect.poll(() => state.connections.size).toBe(1);
});

test('所有者显式公开成果后展示协作，撤回后公开主页不再显示', async ({ page }) => {
  await mockWorld(page);
  await page.goto(`/world/agents/${agentId}`);
  await page.getByText('管理公开成果（仅你可见）', { exact: true }).click();
  await page.getByLabel('授权公开的成果摘要', { exact: true }).fill('公开授权：完成协作地图功能');
  await page.getByRole('button', { name: '公开此成果', exact: true }).click();
  const works = page.getByRole('region', { name: '公开成果', exact: true });
  await expect(works).toContainText('公开授权：完成协作地图功能');
  await expect(works).toContainText('代码伙伴');
  await page.getByRole('button', { name: '撤回公开', exact: true }).click();
  await expect(works).toContainText('尚未公开已验收成果');
  await expect(works.getByRole('link', { name: '查看已验收 PR ↗', exact: true })).toHaveCount(0);
});

test('390px 手机工作室展示装饰与公共入口，无横向溢出', async ({ page }) => {
  await mockWorld(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/world/studios/${landId}`);
  await expect(page.getByTestId('world-studio')).toContainText('桌面绿植');
  await expect(page.getByRole('link', { name: '访问公开作品 ↗', exact: true })).toHaveAttribute('href', 'https://example.com/works');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('section[aria-label="小镇地图"] canvas')).toBeVisible();
  await page.screenshot({ path: '.local/town-studio-mobile.png', fullPage: true });
});

test('WebGL 不可用时仍可通过目录访问工作室', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, options?: unknown) {
      if (type.includes('webgl')) return null;
      return original.call(this, type, options);
    } as typeof original;
  });
  await mockWorld(page);
  await page.goto('/world');
  await expect(page.getByRole('region', { name: '小镇地图', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '小镇目录' }).click();
  await page.getByRole('link', { name: '进入 青苔工作室', exact: true }).click();
  await expect(page.getByTestId('world-studio')).toContainText('桌面绿植');
});

test('待售矩形地块展示准确面积并链接到对应购地报价', async ({ page }) => {
  const state = await mockWorld(page);
  Object.assign(state.land, { owner_agent_id: null, owner_name: null, owner: null, x: -1.2750000000000001, y: 8, width: 1.85, height: 0.7, area: 129.50000000000003, name: '默认工作室', works_url: null, listing: null, decorations: [], purchasable: true, points_price: '301' });
  await page.goto(`/world/studios/${landId}`);
  await expect(page.getByTestId('world-studio')).toContainText('面积 129.5 m²');
  await expect(page.getByTestId('world-studio')).toContainText('(-1.275, 8)');
  await expect(page.getByRole('link', { name: '查看购地报价 · 301 积分 →', exact: true })).toHaveAttribute('href', `/market?land=${landId}`);
  await expect(page.getByTestId('world-map').locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: '关闭功能面板', exact: true }).click();
  await page.getByRole('button', { name: '小镇目录' }).click();
  await expect(page.getByTestId(`world-land-${landId}`)).toContainText('系统待售');
});

async function motionState(page: Page) {
  return page.getByTestId('world-map').evaluate(element => {
    const data = (element as HTMLElement).dataset;
    return { x: Number(data.selfX), y: Number(data.selfY), height: Number(data.jumpHeight),
      speed: Number(data.moveSpeed), airborne: data.airborne === 'true', running: data.running === 'true' };
  });
}

test('跑跳：Shift跑动实测两倍速度，松开恢复且位置同步保持节流', async ({ page }) => {
  test.setTimeout(Math.max(test.info().timeout, 60_000));
  await page.clock.install();
  const state = await mockWorld(page); state.world.agents = []; state.world.visitors = [state.world.visitors[0]!];
  Object.assign(state.world.self, { x: 10, y: 10 }); Object.assign(state.world.visitors[0]!, { x: 10, y: 10 });
  await page.goto('/world');
  const map = page.getByTestId('world-map'); await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await map.focus(); await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await page.keyboard.down('w'); await page.clock.runFor(64);
  const start = await motionState(page);
  await page.clock.runFor(480); const walked = await motionState(page);
  await page.keyboard.down('Shift'); await page.clock.runFor(480); const ran = await motionState(page);
  await page.keyboard.up('Shift'); await page.clock.runFor(480); const slowed = await motionState(page);
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  expect(walked.speed).toBe(0.45); expect(ran.speed).toBe(0.9); expect(ran.running).toBe(true); expect(slowed.running).toBe(false);
  expect(distance(walked, ran) / distance(start, walked)).toBeCloseTo(2, 1);
  expect(distance(ran, slowed) / distance(start, walked)).toBeCloseTo(1, 1);
  await page.keyboard.up('w'); await page.clock.runFor(64);
  expect(state.moves.at(-1)?.moving).toBe(false); expect(state.moves.length).toBeLessThanOrEqual(5);
  expect(state.writes).toHaveLength(0);
  await page.clock.resume(); await page.screenshot({ path: '.local/town-running-desktop.png', fullPage: true });
});

test('跑跳：原地跳跃升降落地，空中和长按不连跳且不写位置', async ({ page }) => {
  test.setTimeout(Math.max(test.info().timeout, 60_000));
  await page.clock.install();
  const state = await mockWorld(page); state.world.agents = []; state.world.visitors = [state.world.visitors[0]!];
  await page.goto('/world'); const map = page.getByTestId('world-map'); await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await map.focus(); await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  const initial = await motionState(page), scroll = await page.evaluate(() => scrollY);
  await page.keyboard.down('Space'); await page.clock.runFor(240); const rising = await motionState(page);
  await page.clock.runFor(240); const apex = await motionState(page);
  await page.keyboard.up('Space'); await page.keyboard.down('Space'); await page.clock.runFor(300); const falling = await motionState(page);
  expect(rising.airborne).toBe(true); expect(rising.height).toBeGreaterThan(0.07);
  expect(apex.height).toBeGreaterThan(rising.height); expect(apex.height).toBeLessThanOrEqual(0.128);
  expect(falling.height).toBeLessThan(apex.height); expect(falling.height).toBeGreaterThan(0);
  await page.clock.runFor(320); expect((await motionState(page)).height).toBe(0); expect((await motionState(page)).airborne).toBe(false);
  await page.keyboard.down('Space'); await page.clock.runFor(200); expect((await motionState(page)).height).toBe(0);
  await page.keyboard.up('Space'); expect(await page.evaluate(() => scrollY)).toBe(scroll);
  expect(await motionState(page)).toMatchObject({ x: initial.x, y: initial.y }); expect(state.moves).toHaveLength(0); expect(state.writes).toHaveLength(0);
  await page.keyboard.press('Space'); await page.clock.runFor(100); expect((await motionState(page)).airborne).toBe(true);
  await page.getByRole('link', { name: '任务大厅', exact: true }).first().evaluate(element => (element as HTMLElement).click());
  await page.clock.runFor(64); expect((await motionState(page)).airborne).toBe(false); expect((await motionState(page)).height).toBe(0);
  await page.getByRole('button', { name: '关闭功能面板', exact: true }).evaluate(element => (element as HTMLElement).click());
  await page.clock.runFor(64);
  await page.getByRole('button', { name: '切换跑动', exact: true }).evaluate(element => (element as HTMLElement).click());
  await map.evaluate(element => (element as HTMLElement).focus()); await page.keyboard.press('Space'); await page.clock.runFor(100);
  await page.getByRole('button', { name: '俯视地图', exact: true }).evaluate(element => (element as HTMLElement).click()); await page.clock.runFor(64);
  expect(await motionState(page)).toMatchObject({ running: false, airborne: false, height: 0 });
  await page.keyboard.press('Space'); await page.clock.runFor(100); expect((await motionState(page)).airborne).toBe(false);
});

test('跑跳：空中跑动仍受房屋碰撞约束，失焦立即停止并落地', async ({ page }) => {
  test.setTimeout(Math.max(test.info().timeout, 60_000));
  await page.clock.install();
  const state = await mockWorld(page), cabin = WORLD_MODEL_CATALOG.cabin, boundary = 4 + cabin.depth / 2 + 0.075;
  state.world.agents = []; state.world.visitors = [state.world.visitors[0]!];
  Object.assign(state.land, { x: 5, y: 4, width: 3, height: 3, area: 900, listing: null, decorations: [],
    models: [{ id: '74000000-0000-4000-8000-000000000001', version: '1', model_id: 'cabin', x: 0, y: 0, rotation: 0, scale: 1 }] });
  Object.assign(state.world.self, { x: 5, y: boundary + 0.1 }); Object.assign(state.world.visitors[0]!, { x: 5, y: boundary + 0.1 });
  await page.goto('/world'); const map = page.getByTestId('world-map'); await expect(map).toHaveAttribute('data-assets-loaded', '8');
  await map.focus(); await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await page.keyboard.down('Shift'); await page.keyboard.down('w'); await page.keyboard.press('Space'); await page.clock.runFor(480);
  const collided = await motionState(page);
  expect(collided.running).toBe(true); expect(collided.airborne).toBe(true); expect(collided.height).toBeGreaterThan(0.12);
  expect(collided.x).toBeGreaterThan(5.1); expect(collided.y).toBeGreaterThanOrEqual(boundary - 0.001);
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.clock.runFor(64);
  const stopped = await motionState(page); expect(stopped).toMatchObject({ running: false, airborne: false, height: 0 });
  await page.clock.runFor(480); expect(await motionState(page)).toMatchObject({ x: stopped.x, y: stopped.y });
  await page.keyboard.up('w'); await page.keyboard.up('Shift'); expect(state.moves.at(-1)?.moving).toBe(false); expect(state.writes).toHaveLength(0);
});

test('跑跳：手机多指移动跳跃、方向取消和短点一步正常，控件无溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockWorld(page); state.world.agents = []; state.world.visitors = [state.world.visitors[0]!];
  Object.assign(state.world.self, { x: 10, y: 10 }); Object.assign(state.world.visitors[0]!, { x: 10, y: 10 });
  await page.goto('/world'); const map = page.getByTestId('world-map'); await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await page.getByRole('button', { name: '切换跑动', exact: true }).click(); await expect(map).toHaveAttribute('data-running', 'true');
  const up = (await page.getByRole('button', { name: '向上移动', exact: true }).boundingBox())!, jump = (await page.getByRole('button', { name: '跳跃', exact: true }).boundingBox())!;
  const points = [{ id: 1, x: up.x + up.width / 2, y: up.y + up.height / 2 }, { id: 2, x: jump.x + jump.width / 2, y: jump.y + jump.height / 2 }];
  const initial = await motionState(page), touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]!] });
  await expect.poll(async () => (await motionState(page)).x).toBeGreaterThan(initial.x + 0.01);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
  await expect(map).toHaveAttribute('data-airborne', 'true'); expect((await motionState(page)).running).toBe(true);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [points[0]!] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect.poll(() => state.moves.at(-1)?.moving).toBe(false);
  const stopped = await motionState(page); await page.waitForTimeout(200); expect(await motionState(page)).toMatchObject({ x: stopped.x, y: stopped.y });
  await expect(map).toHaveAttribute('data-airborne', 'false');
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]!] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => (await motionState(page)).x).toBeGreaterThan(stopped.x);
  await expect.poll(() => state.moves.at(-1)?.moving).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await expect(map).toHaveAttribute('data-running', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const controls = (await page.getByRole('region', { name: '移动控制', exact: true }).boundingBox())!, tools = (await page.getByRole('button', { name: '全景', exact: true }).boundingBox())!;
  expect(controls.x).toBeGreaterThan(tools.x + tools.width);
  await page.screenshot({ path: '.local/town-running-mobile.png', fullPage: true });
  expect(state.writes).toHaveLength(0); for (const move of state.moves) expect(Object.keys(move).sort()).toEqual(['moving', 'room_id', 'seq', 'type', 'x', 'y']);
  await touch.detach();
});

test('按住方向键连续移动，旧快照不拉回本机，放开后最终位置保存且切换面板不重建地图', async ({ page }) => {
  const state = await mockWorld(page);
  await page.goto('/');
  const map = page.getByTestId('world-map');
  await expect(map.locator('canvas')).toBeVisible();
  await map.focus();
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(320);
  const first = Number(await map.getAttribute('data-self-x'));
  expect(first).toBeGreaterThan(0); expect(first % 1).not.toBe(0);
  state.world.self.x = 0; state.broadcast();
  await page.waitForTimeout(240);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(160);
  const final = Number(await map.getAttribute('data-self-x'));
  expect(final).toBeGreaterThan(first);
  await expect.poll(() => state.moves.some(move => move.x === final && !move.moving)).toBe(true);
  await map.locator('canvas').evaluate(canvas => canvas.setAttribute('data-persistent-test', 'yes'));
  await page.getByRole('button', { name: '小镇目录' }).click();
  await page.getByRole('link', { name: '进入 青苔工作室', exact: true }).click();
  await expect(page.getByTestId('world-studio')).toBeVisible();
  await expect(map.locator('canvas')).toHaveAttribute('data-persistent-test', 'yes');
  await page.getByRole('button', { name: '关闭功能面板' }).click();
  await expect(map).toHaveAttribute('data-self-x', String(final));
});

test('锁鼠异常位移与同帧输入积压不会甩头，正常连续转向保持灵敏度', async ({ page }) => {
  const state = await mockWorld(page);
  state.world.agents = []; state.world.visitors = [state.world.visitors[0]!];
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await page.getByRole('button', { name: '进入漫游', exact: true }).click();
  await expect(map).toHaveAttribute('data-pointer-locked', 'true');
  const angles = () => page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="world-map"]')!;
    return { yaw: Number(element.dataset.cameraYaw), pitch: Number(element.dataset.cameraPitch) };
  });
  const input = async (samples: { x: number; y: number }[], separateFrames = false) => page.evaluate(async ({ samples, separateFrames }) => {
    for (const sample of samples) {
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: sample.x, movementY: sample.y }));
      if (separateFrames) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, { samples, separateFrames });
  await input([{ x: 0, y: 0 }]);
  const initial = await angles();
  await input([{ x: 2500, y: -1800 }]);
  expect(await angles()).toEqual(initial);
  await input([{ x: 20, y: 5 }]);
  const normal = await angles();
  expect(normal.yaw).toBeCloseTo(initial.yaw - 20 * 0.0025, 5);
  expect(normal.pitch).toBeCloseTo(initial.pitch - 5 * 0.0025, 5);
  await input(Array.from({ length: 12 }, () => ({ x: 80, y: 0 })), true);
  const fast = await angles();
  expect(fast.yaw).toBeCloseTo(normal.yaw - 12 * 80 * 0.0025, 5);
  await input(Array.from({ length: 30 }, () => ({ x: 50, y: 10 })));
  const burst = await angles();
  expect(Math.hypot(burst.yaw - fast.yaw, burst.pitch - fast.pitch)).toBeLessThanOrEqual(Math.PI / 9 + 0.00001);
  await input(Array.from({ length: 6 }, () => ({ x: 0, y: 0 })), true);
  expect(await angles()).toEqual(burst);
  expect(state.moves).toHaveLength(0); expect(state.writes).toHaveLength(0);
});

test('锁鼠退出失焦及重新进入不会回放旧转向输入', async ({ page }) => {
  const state = await mockWorld(page);
  state.world.agents = []; state.world.visitors = [state.world.visitors[0]!];
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await page.getByRole('button', { name: '进入漫游', exact: true }).click();
  await expect(map).toHaveAttribute('data-pointer-locked', 'true');
  const yaw = () => map.evaluate(element => Number((element as HTMLElement).dataset.cameraYaw));
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 0 })));
  const initial = await yaw();
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 100, movementY: 0 }));
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: -80, movementY: 0 }));
  });
  await expect(map).toHaveAttribute('data-pointer-locked', 'false');
  expect(await yaw()).toBe(initial);
  await page.evaluate(() => {
    // Run after the app resets look state, before a native mousemove can consume the first sample.
    const reposition = () => {
      if (document.pointerLockElement !== document.querySelector('[data-testid="world-map"] canvas')) return;
      document.removeEventListener('pointerlockchange', reposition);
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 200, movementY: 100 }));
    };
    document.addEventListener('pointerlockchange', reposition);
  });
  await page.getByRole('button', { name: '进入漫游', exact: true }).click();
  await expect(map).toHaveAttribute('data-pointer-locked', 'true');
  await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  expect(await yaw()).toBe(initial);
  await page.evaluate(async () => {
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 40, movementY: 0 }));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  expect(await yaw()).toBeCloseTo(initial - 0.1, 5);
  await page.keyboard.press('Escape');
  await expect(map).toHaveAttribute('data-pointer-locked', 'false');
  const stopped = await yaw();
  await page.evaluate(async () => {
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 200, movementY: 100 }));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  expect(await yaw()).toBe(stopped);
  expect(state.moves).toHaveLength(0); expect(state.writes).toHaveLength(0);
});

test('点击第一人称场景隐藏并锁定鼠标，Esc和业务面板恢复光标', { tag: '@smoke' }, async ({ page }) => {
  const state = await mockWorld(page);
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-view', 'first-person');
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await expect(page.getByRole('button', { name: '进入漫游', exact: true })).toBeVisible();
  const box = (await map.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55);
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.55);
  await expect.poll(() => page.evaluate(() => document.pointerLockElement !== null && document.pointerLockElement === document.querySelector('[data-testid="world-map"] canvas'))).toBe(true);
  await expect(map.locator('canvas')).toHaveCSS('cursor', 'none');
  await expect(page).toHaveURL(/\/world$/);
  // CDP mouse.move uses absolute coordinates; supply relative samples after verifying the real lock.
  const turnedYaw = await page.evaluate(async () => {
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 0 }));
    for (let step = 0; step < 8; step++) {
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 150 / 8, movementY: 0 }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    return Number(document.querySelector<HTMLElement>('[data-testid="world-map"]')!.dataset.cameraYaw);
  });
  expect(turnedYaw).toBeLessThan(-0.9);
  await map.focus(); await page.keyboard.down('w');
  await expect.poll(async () => Number(await map.getAttribute('data-self-x'))).toBeGreaterThan(0.04);
  await page.keyboard.up('w');
  await expect.poll(() => state.moves.at(-1)?.moving).toBe(false);
  expect(Number(await map.getAttribute('data-self-y'))).toBeLessThan(0);
  await expect(map).toHaveAttribute('data-pointer-locked', 'true');
  await page.keyboard.press('Escape');
  await expect(map).toHaveAttribute('data-pointer-locked', 'false');
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  await expect(map.locator('canvas')).not.toHaveCSS('cursor', 'none');
  await page.getByRole('button', { name: '进入漫游', exact: true }).click();
  await expect(map).toHaveAttribute('data-pointer-locked', 'true');
  await map.focus(); await page.keyboard.down('d');
  await page.waitForTimeout(120);
  await page.getByRole('link', { name: '任务大厅', exact: true }).first().evaluate(link => (link as HTMLElement).click());
  await page.keyboard.up('d');
  await expect(page.getByRole('button', { name: '关闭功能面板', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  const stopped = await map.getAttribute('data-self-x');
  await page.waitForTimeout(160);
  expect(await map.getAttribute('data-self-x')).toBe(stopped);
  expect(state.writes.filter(write => write.path === '/world/presence')).toHaveLength(0);
  await page.getByRole('button', { name: '关闭功能面板', exact: true }).click();
  await page.screenshot({ path: '.local/town-first-person-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/town-first-person-mobile.png', fullPage: true });
});

test('完整209块待售地仍有自然环境，场景渲染不产生新服务器请求', async ({ page }) => {
  const state = await mockWorld(page), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  state.world.lands = generateDefaultLandPlots().map((plot, index) => ({ ...state.land, ...plot,
    id: `84000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, owner_agent_id: null, owner: null,
    owner_name: null, decorations: [], models: [], listing: null, purchasable: true, name: '默认工作室' }));
  state.world.agents = []; state.world.visitors = [state.world.visitors[0]!];
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await expect.poll(async () => Number(await map.getAttribute('data-draw-calls'))).toBeGreaterThan(0);
  expect(Number(await map.getAttribute('data-draw-calls'))).toBeLessThan(500);
  await page.screenshot({ path: '.local/town-natural-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.local/town-natural-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]); expect(state.writes).toHaveLength(0); expect(state.moves).toHaveLength(0);
});

test('离线Agent模拟散步不写位置，上线切回真实位置，暂停身份停止活动', async ({ page }) => {
  const state = await mockWorld(page);
  const before = structuredClone(state.world.agents[0]!);
  await page.goto('/world');
  const map = page.getByTestId('world-map'), actor = map.locator(`[data-agent-id="${agentId}"]`);
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await expect(map).toHaveAttribute('data-simulated-agents', '1');
  const point = () => actor.evaluate(label => `${(label as HTMLElement).dataset.x}:${(label as HTMLElement).dataset.y}`);
  const initial = await point();
  await expect.poll(point, { timeout: 8000 }).not.toBe(initial);
  expect(state.world.agents[0]).toEqual(before);
  expect(state.writes).toHaveLength(0); expect(state.moves).toHaveLength(0);
  Object.assign(state.world.agents[0]!, { status: 'paused' }); state.broadcast();
  await expect(map).toHaveAttribute('data-simulated-agents', '0');
  await expect.poll(point).toBe('2:1');
  const directlyPaused = await point(); await page.waitForTimeout(300); expect(await point()).toBe(directlyPaused);
  Object.assign(state.world.agents[0]!, { status: 'active' }); state.broadcast();
  await expect(map).toHaveAttribute('data-simulated-agents', '1');
  await page.getByRole('button', { name: '小镇目录', exact: false }).click();
  await expect(page.getByTestId(`world-agent-${agentId}`)).toContainText('离线 · 模拟活动');
  await page.getByRole('button', { name: '关闭小镇目录', exact: true }).click();
  // Opening a profile pauses background ambient animation, without removing the resident.
  await page.getByRole('link', { name: '任务大厅', exact: true }).first().click();
  await expect(map).toHaveAttribute('data-simulated-agents', '0');
  const paused = await point(); await page.waitForTimeout(300); expect(await point()).toBe(paused);
  await page.getByRole('button', { name: '关闭功能面板', exact: true }).click();
  await expect(map).toHaveAttribute('data-simulated-agents', '1');
  Object.assign(state.world.agents[0]!, { online: true, x: 0.5, y: 0.25 });
  state.broadcast();
  await expect(map).toHaveAttribute('data-simulated-agents', '0');
  await expect(actor).toHaveAttribute('data-activity', 'none');
  await expect.poll(point).toBe('0.5:0.25');
  Object.assign(state.world.agents[0]!, { online: false, status: 'paused' }); state.broadcast();
  await expect(actor).toContainText('已暂停');
  await expect(map).toHaveAttribute('data-simulated-agents', '0');
  const stopped = await point(); await page.waitForTimeout(300); expect(await point()).toBe(stopped);
  Object.assign(state.world.agents[0]!, { status: 'active' }); state.broadcast();
  await expect(map).toHaveAttribute('data-simulated-agents', '1');
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  await page.screenshot({ path: '.local/town-offline-agents.png', fullPage: true });
  expect(state.writes).toHaveLength(0); expect(state.moves).toHaveLength(0);
});

test('触屏继续拖动环视，浏览器拒绝锁定后可拖动且不会错误隐藏鼠标', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Test browser restriction', 'NotAllowedError'));
  });
  await mockWorld(page); await page.goto('/world');
  const map = page.getByTestId('world-map'), canvas = map.locator('canvas');
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  const box = (await canvas.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
  const before = Number(await map.getAttribute('data-camera-yaw'));
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 70, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => Number(await map.getAttribute('data-camera-yaw'))).toBeLessThan(before - 0.2);
  await expect(map).toHaveAttribute('data-pointer-locked', 'false');
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(map).toContainText('未能锁定鼠标');
  await expect(canvas).not.toHaveCSS('cursor', 'none');
  const failedYaw = Number(await map.getAttribute('data-camera-yaw'));
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 70, y, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => Number(await map.getAttribute('data-camera-yaw'))).toBeLessThan(failedYaw - 0.2);
  await touch.detach();
});

test('有主空地可直接穿行，用户自行添加房屋后碰撞生效，移除后恢复空地', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(Math.max(test.info().timeout, 90000));
  await page.clock.install();
  const pauseClock = async () => {
    const time = await page.evaluate(() => Date.now());
    // Freeze the wall clock while pauseAt waits for an in-flight animation callback.
    await page.clock.setFixedTime(time);
    await page.clock.pauseAt(time);
    await page.clock.setSystemTime(time);
  };
  const advanceWalk = async () => {
    // Advance at 20 FPS, matching the app's maximum 50 ms physics step.
    for (let frame = 0; frame < 30; frame++) await page.clock.fastForward(50);
  };
  const state = await mockWorld(page);
  let cabinRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === WORLD_ASSETS.cabin.url) cabinRequests++; });
  Object.assign(state.land, { x: 5, y: 4, width: 3, height: 3, area: 900, listing: null, decorations: [], models: [] });
  const resetVisitor = (y = 5) => {
    Object.assign(state.world.self, { x: 5, y });
    Object.assign(state.world.visitors[0]!, { x: 5, y });
  };
  resetVisitor();
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await expect(map).toHaveAttribute('data-model-count', '0');
  await map.focus(); await pauseClock();
  await page.keyboard.down('w'); await advanceWalk();
  await expect.poll(async () => Number(await map.getAttribute('data-self-y')), { timeout: 15000 }).toBeLessThan(4.5);
  await page.keyboard.up('w'); await page.clock.runFor(64); await page.clock.resume();
  // This path crosses the former implicit house footprint, instead of sliding around an invisible wall.
  expect(Number(await map.getAttribute('data-self-x'))).toBeLessThan(5.7);
  expect(state.writes).toHaveLength(0);
  const cabin = WORLD_MODEL_CATALOG.cabin, boundary = 4 + cabin.depth / 2 + 0.075;
  resetVisitor(boundary + 0.175); await page.reload();
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await page.getByRole('button', { name: '布置模型', exact: true }).click();
  const builder = page.getByRole('complementary', { name: '模型布置' });
  const catalog = builder.getByRole('group', { name: '免费模型库' }), categories = builder.getByRole('group', { name: '模型分类' });
  await expect(catalog.getByRole('button')).toHaveCount(Object.keys(WORLD_MODEL_CATALOG).length);
  await categories.getByRole('button', { name: '自然', exact: true }).click();
  await expect(catalog.getByRole('button', { name: /庭院树/ })).toBeVisible();
  await expect(catalog.getByRole('button', { name: new RegExp(cabin.label) })).toHaveCount(0);
  await categories.getByRole('button', { name: '建筑', exact: true }).click();
  await builder.getByRole('searchbox', { name: '搜索模型', exact: true }).fill(cabin.label);
  await expect(catalog.getByRole('button')).toHaveCount(1);
  expect(cabinRequests).toBe(0);
  await catalog.getByRole('button', { name: new RegExp(cabin.label) }).click();
  await expect.poll(() => cabinRequests).toBe(1);
  await expect(map).toHaveAttribute('data-assets-loaded', '8');
  await builder.getByRole('button', { name: '取消预览', exact: true }).click();
  await catalog.getByRole('button', { name: new RegExp(cabin.label) }).click();
  await builder.getByRole('button', { name: '保存布置', exact: true }).click();
  await expect(builder.getByText('模型布置已保存。', { exact: true })).toBeVisible();
  await expect(map).toHaveAttribute('data-model-count', '1');
  expect(state.land.models?.[0]?.model_id).toBe('cabin');
  expect(cabinRequests).toBe(1);
  await page.screenshot({ path: '.local/town-user-house.png', fullPage: true });
  await builder.getByRole('button', { name: '关闭模型布置', exact: true }).click();
  await expect(map).toHaveAttribute('data-view', 'first-person');
  await map.focus(); await pauseClock();
  await page.keyboard.down('w'); await advanceWalk();
  await expect.poll(async () => Number(await map.getAttribute('data-self-x')), { timeout: 15000 }).toBeGreaterThan(5.22);
  await page.keyboard.up('w'); await page.clock.runFor(64); await page.clock.resume();
  expect(Number(await map.getAttribute('data-self-y'))).toBeGreaterThan(boundary - 0.01);
  await page.getByRole('button', { name: '布置模型', exact: true }).click();
  await builder.getByRole('button', { name: new RegExp(cabin.label + '.*调整') }).click();
  await builder.getByRole('button', { name: '移除模型', exact: true }).click();
  await expect(builder.getByText('模型已移除。', { exact: true })).toBeVisible();
  await expect(map).toHaveAttribute('data-model-count', '0');
  await page.screenshot({ path: '.local/town-empty-owned-land.png', fullPage: true });
  await builder.getByRole('button', { name: '关闭模型布置', exact: true }).click();
  await expect(map).toHaveAttribute('data-view', 'first-person');
  await map.focus(); await pauseClock();
  await page.keyboard.down('w'); await advanceWalk();
  await expect.poll(async () => Number(await map.getAttribute('data-self-y')), { timeout: 15000 }).toBeLessThan(boundary - 0.25);
  await page.keyboard.up('w'); await page.clock.runFor(64); await page.clock.resume();
  expect(state.writes.map(write => write.path)).toEqual([
    `/world/studios/${landId}/models`, `/world/studios/${landId}/models/74000000-0000-4000-8000-000000000001`,
  ]);
  expect(state.land.models).toHaveLength(0);
  expect(cabinRequests).toBe(1);
});

test('免费模型仅保存时提交，支持预览、边界提示、修改、移除和手机布置', async ({ page }) => {
  const state = await mockWorld(page);
  Object.assign(state.land, { width: 3, height: 3, area: 900, listing: null, models: [] });
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await page.getByRole('button', { name: '布置模型', exact: true }).click();
  const builder = page.getByRole('complementary', { name: '模型布置' });
  await expect(builder).toBeVisible();
  await expect(map).toHaveAttribute('data-view', 'overview');
  await builder.getByRole('group', { name: '免费模型库' }).getByRole('button', { name: /灌木盆栽/ }).click();
  await builder.getByLabel('模型左右偏移', { exact: true }).fill('20');
  await expect(map).toHaveAttribute('data-placement-valid', 'false');
  await expect(builder.getByRole('button', { name: '保存布置', exact: true })).toBeDisabled();
  await builder.getByRole('button', { name: '收起选点', exact: true }).click();
  const canvasBox = (await map.locator('canvas').boundingBox())!;
  await map.locator('canvas').click({ position: { x: canvasBox.width / 2 + 25, y: canvasBox.height / 2 } });
  await builder.getByRole('button', { name: '展开面板', exact: true }).click();
  await expect(builder.getByLabel('模型左右偏移', { exact: true })).not.toHaveValue('20');
  await builder.getByLabel('模型左右偏移', { exact: true }).fill('8');
  await builder.getByLabel('模型前后偏移', { exact: true }).fill('8');
  await builder.getByRole('button', { name: '转 90° ↷', exact: true }).click();
  await expect(map).toHaveAttribute('data-placement-valid', 'true');
  expect(state.writes).toHaveLength(0);
  await page.screenshot({ path: '.local/town-model-builder-desktop.png', fullPage: true });
  await builder.getByRole('button', { name: '保存布置', exact: true }).click();
  await expect(builder.getByText('模型布置已保存。', { exact: true })).toBeVisible();
  expect(state.land.models).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ path: `/world/studios/${landId}/models`, body: { land_version: '1', model_id: 'plant', x: 0.8, y: 0.8, rotation: 90, scale: 1 }, csrf: 'world-csrf' });
  expect(state.writes[0]!.key).toBeTruthy();
  await builder.getByRole('button', { name: /灌木盆栽.*调整/ }).click();
  await builder.getByLabel('模型左右偏移', { exact: true }).fill('-8');
  await builder.getByRole('button', { name: '保存布置', exact: true }).click();
  await expect.poll(() => state.land.models?.[0]?.x).toBe(-0.8);
  await expect(builder.getByText('模型布置已保存。', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]!.body.version).toBe('1');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/town-model-builder-mobile.png', fullPage: true });
  await builder.getByRole('button', { name: /灌木盆栽.*调整/ }).click();
  await builder.getByRole('button', { name: '移除模型', exact: true }).click();
  await expect(builder.getByText('模型已移除。', { exact: true })).toBeVisible();
  expect(state.land.models).toHaveLength(0);
  await builder.getByRole('button', { name: '关闭模型布置', exact: true }).click();
  await expect(map).toHaveAttribute('data-view', 'first-person');
  expect(state.moves).toHaveLength(0);
});

test('模型提交结果不确定时冻结草稿，并沿用原请求重试', async ({ page }) => {
  const state = await mockWorld(page);
  Object.assign(state.land, { listing: null, models: [] });
  const attempts: { key: string; body: unknown }[] = [];
  await page.route(`**/api/v1/world/studios/${landId}/models`, async route => {
    attempts.push({ key: route.request().headers()['idempotency-key']!, body: route.request().postDataJSON() });
    if (attempts.length === 1) return route.abort('failed');
    return route.fallback();
  });
  await page.goto('/world');
  await page.getByRole('button', { name: '布置模型', exact: true }).click();
  const builder = page.getByRole('complementary', { name: '模型布置' });
  await builder.getByRole('group', { name: '免费模型库' }).getByRole('button', { name: /灌木盆栽/ }).click();
  await builder.getByRole('button', { name: '保存布置', exact: true }).click();
  await expect(builder.getByRole('button', { name: '重试原请求', exact: true })).toBeVisible();
  await expect(builder.getByLabel('模型左右偏移', { exact: true })).toBeDisabled();
  await expect(builder.getByRole('button', { name: '关闭模型布置', exact: true })).toBeDisabled();
  await builder.getByRole('button', { name: '重试原请求', exact: true }).click();
  await expect(builder.getByText('模型布置已保存。', { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  expect(state.land.models).toHaveLength(1);
});

test('3D 小镇加载本地免费模型，差量同步更新产权且保留画布', async ({ page }) => {
  const state = await mockWorld(page);
  const failures: string[] = [], models = new Set<string>();
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => {
    if (response.url().includes('/models/polyfork/') && response.url().endsWith('.glb') && response.ok()) models.add(response.url());
  });
  state.world.lands = [[-7, -5], [-3, -6], [3, -6], [7, -5], [-7, 3], [-3, 5], [3, 5], [7, 3]].map(([x, y], index) => ({
    ...state.land, id: index === 4 ? landId : `34000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    code: `TOWN-${index + 1}`, x: x!, y: y!, area: 900, width: 3, height: 3,
    name: ['青苔工作室', '松风工坊', '星光书屋', '晨光实验室'][index % 4]!,
    models: [{ id: `74000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, version: '1', model_id: 'studio', x: 0, y: 0, rotation: 0, scale: 1 }],
  }));
  await page.goto('/world');
  const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-renderer', 'three');
  await expect.poll(() => models.size).toBe(7);
  await expect(map).toHaveAttribute('data-assets-loaded', '7');
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  await map.locator('canvas').evaluate(canvas => canvas.setAttribute('data-delta-test', 'retained'));
  await page.screenshot({ path: '.local/town-3d-desktop.png', fullPage: true });
  const changed = { ...state.world.lands[4]!, owner: state.world.agents[1]!.owner, owner_agent_id: otherAgentId, owner_name: '代码伙伴', name: '新主人的工作室', version: '2', decorations: [] };
  Object.assign(state.land, changed); state.world.lands[4] = changed;
  for (const connection of state.connections) connection.send(JSON.stringify({ type: 'delta', server_time: timestamp, lands: { upsert: [changed], remove: [] } }));
  await page.getByRole('button', { name: '小镇目录' }).click();
  await expect(page.getByTestId(`world-land-${landId}`)).toContainText('新主人的工作室');
  await expect(page.getByTestId(`world-land-${landId}`)).toContainText('产权人 @neighbor');
  await expect(map.locator('canvas')).toHaveAttribute('data-delta-test', 'retained');
  expect(state.writes.filter(write => write.path === '/world/presence')).toHaveLength(0);
  expect(failures).toEqual([]);
  await page.getByRole('button', { name: '关闭小镇目录', exact: true }).click();
  const buildingLabel = map.locator('[class*="sceneLabel"]').filter({ hasText: /^新主人的工作室$/ });
  await expect(buildingLabel).toBeVisible();
  const labelBox = await buildingLabel.boundingBox(), mapBox = await map.boundingBox();
  expect(labelBox).not.toBeNull(); expect(mapBox).not.toBeNull();
  // Labels float above the roofs; exercise actual 3D ray casting into the building below.
  await map.locator('canvas').click({ position: { x: labelBox!.x + labelBox!.width / 2 - mapBox!.x, y: labelBox!.y + labelBox!.height + 30 - mapBox!.y } });
  await expect(page).toHaveURL(new RegExp(`/world/studios/${landId}$`));
  await expect(page.getByTestId('world-studio')).toContainText('产权人：@neighbor');
  await page.getByRole('button', { name: '关闭功能面板', exact: true }).click();
  await expect(buildingLabel).toBeVisible();
  const rotationLabel = map.locator('[class*="sceneLabel"]').filter({ hasText: /^资产市场$/ });
  await expect(rotationLabel).toBeVisible();
  const beforeRotation = (await rotationLabel.boundingBox())!.x;
  await page.getByRole('button', { name: '向右旋转视角', exact: true }).click();
  await expect.poll(async () => { const box = await rotationLabel.boundingBox(); return box ? Math.abs(box.x - beforeRotation) : 0; }).toBeGreaterThan(15);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(map.locator('canvas')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/town-3d-mobile.png', fullPage: true });
});
