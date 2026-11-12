import { test, expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import { WORLD_BOUNDS, WORLD_PUBLIC_AREAS, WORLD_PLACES, WORLD_ROOM_DIMENSIONS, type WorldLand, type WorldModelDraft, type WorldModelPlacement, type WorldSnapshot } from '../../packages/contracts/src/index.js';

const userId = '14000000-0000-4000-8000-000000000001';
const agentId = '24000000-0000-4000-8000-000000000001';
const landId = '34000000-0000-4000-8000-000000000001';
const roomId = '74000000-0000-4000-8000-000000000001';
const respond = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const round = (value: number) => Math.round(value * 1000) / 1000;

async function roomFixture(page: Page) {
  const owner = { id: userId, github_login: 'owner', display_name: '小镇主人' };
  const furniture: WorldModelDraft[] = [
    { model_id: 'bookshelf', x: -0.25, y: -1.02, scale: 0.55, rotation: 0 },
    { model_id: 'arcade', x: 0.65, y: -0.85, scale: 1.4, rotation: 0 },
    { model_id: 'plant', x: 1.25, y: -0.8, scale: 0.65, rotation: 0 },
    { model_id: 'lamp', x: -1.12, y: -0.55, scale: 1, rotation: 0 },
    { model_id: 'picnic', x: -0.45, y: -0.2, scale: 0.65, rotation: 0 },
    { model_id: 'chair', x: 0.45, y: -0.2, scale: 2, rotation: 315 },
  ];
  const original: WorldModelPlacement[] = [
    { id: roomId, version: '1', model_id: 'cabin', x: 0, y: 0, rotation: 90, scale: 1 },
    ...furniture.map((item, index) => ({ ...item, id: `74000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`, version: '1', room_id: roomId })),
  ];
  const land: WorldLand = { id: landId, code: 'ROOM-01', x: 5, y: 4, width: 3, height: 3, area: 900, name: '林间工作室', works_url: null, owner_agent_id: agentId, owner_name: '设计伙伴', owner, tradeable: true, purchasable: false, points_price: '40', version: '1', listing: null, decorations: [], models: structuredClone(original) };
  const world: WorldSnapshot = { server_time: '2026-11-09T04:00:00.000Z', presence_ttl_seconds: 60,
    self: { kind: 'visitor', id: userId, x: 5.985, y: 4, online: true }, places: WORLD_PLACES, bounds: WORLD_BOUNDS, public_areas: WORLD_PUBLIC_AREAS, lands: [land],
    agents: [{ id: agentId, name: '设计伙伴', owner, status: 'active', online: false, x: 5, y: 4 }],
    visitors: [{ id: userId, name: owner.display_name, github_login: owner.github_login, online: true, x: 5.985, y: 4 }] };
  const connections = new Set<WebSocketRoute>();
  const moves: { x: number; y: number; room_id?: string | null }[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const broadcast = () => { for (const connection of connections) connection.send(JSON.stringify({ type: 'snapshot', world })); };
  await page.routeWebSocket('**/api/v1/world/stream?v=2', socket => {
    connections.add(socket); socket.send(JSON.stringify({ type: 'snapshot', world }));
    socket.onMessage(data => {
      const message = JSON.parse(String(data));
      if (message.type === 'move') {
        moves.push(message);
        Object.assign(world.self, { x: message.x, y: message.y, room_id: message.room_id });
        Object.assign(world.visitors[0]!, { x: message.x, y: message.y, room_id: message.room_id });
        socket.send(JSON.stringify({ type: 'ack', seq: message.seq, ...world.self, persisted: !message.moving }));
      } else if (message.type === 'heartbeat') socket.send(JSON.stringify({ type: 'ping', server_time: world.server_time }));
    });
    socket.onClose(() => connections.delete(socket));
  });
  const ping = setInterval(() => { for (const socket of connections) socket.send(JSON.stringify({ type: 'ping', server_time: world.server_time })); }, 2000);
  page.once('close', () => clearInterval(ping));
  await page.route('**/api/v1/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', '');
    const body = request.method() === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    if (request.method() !== 'GET') writes.push({ path, body });
    if (path === '/me') return respond(route, { actor: { type: 'user', userId }, user: { ...owner, status: 'active', role: 'member' } });
    if (path === '/world') return respond(route, world);
    if (path === '/world/presence') {
      Object.assign(world.self, body); Object.assign(world.visitors[0]!, body); broadcast();
      return respond(route, { self: world.self });
    }
    if (path === `/world/studios/${landId}/models` && request.method() === 'POST') {
      const placement = { ...body as unknown as WorldModelDraft, id: '74000000-0000-4000-8000-000000000099', version: '1' };
      land.models!.push(placement); land.version = String(Number(land.version) + 1); broadcast();
      return respond(route, { placement, land_version: land.version }, 201);
    }
    if (path === `/world/studios/${landId}`) return respond(route, { land, agent: world.agents[0], works: [] });
    if (path.startsWith('/games/machines/')) return respond(route, { placement_id: path.split('/').at(-1), game: null });
    return respond(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  return { world, land, original, moves, writes, broadcast };
}

test('扩大的房间可走过旧边界，第一人称在新墙前停止，原有布置与出口保持', async ({ page }) => {
  test.setTimeout(60000);
  const state = await roomFixture(page);
  await page.goto('/world'); const map = page.getByTestId('world-map');
  await page.getByRole('button', { name: 'E · 进入房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-self-y', String(round(WORLD_ROOM_DIMENSIONS.height / 2 - 0.25)));
  await map.focus(); await page.keyboard.down('s');
  await expect.poll(async () => Number(await map.getAttribute('data-self-y'))).toBe(round(WORLD_ROOM_DIMENSIONS.height / 2 - 0.08));
  await page.keyboard.up('s');
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  for (const x of [1, 2, round(WORLD_ROOM_DIMENSIONS.width / 2 - 0.08)]) {
    await page.getByRole('button', { name: '向右移动', exact: true }).click();
    await expect(map).toHaveAttribute('data-self-x', String(x), { timeout: 10000 });
  }
  expect(state.moves.some(move => move.room_id === roomId && move.x > 1.5 && move.y > 1.2)).toBe(true);
  expect(state.land.models).toEqual(state.original);
  expect(state.writes.map(write => write.path)).toEqual(['/world/presence']);
  // Return to the door along the unobstructed perimeter without relocating saved furniture.
  for (const x of [1.32, 0.32]) {
    await page.getByRole('button', { name: '向左移动', exact: true }).click();
    await expect(map).toHaveAttribute('data-self-x', String(x), { timeout: 10000 });
  }
  await page.getByRole('button', { name: '第一人称', exact: true }).click();
  await page.getByRole('button', { name: 'E · 离开房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-id', '');
  await expect(map).toHaveAttribute('data-self-x', '5.985');
  await expect(map).toHaveAttribute('data-self-y', '4');
  expect(state.writes.map(write => write.body.room_id)).toEqual([roomId, null]);
});

test('扩容区域可以保存家具，旧坐标不变，超出新边界时禁止保存', async ({ page }) => {
  const state = await roomFixture(page);
  await page.goto('/world'); const map = page.getByTestId('world-map');
  await page.getByRole('button', { name: '布置模型', exact: true }).click();
  const builder = page.getByRole('complementary', { name: '模型布置' });
  await builder.getByLabel('选择布置空间', { exact: true }).selectOption(roomId);
  await expect(map).toHaveAttribute('data-room-id', roomId);
  await builder.getByRole('group', { name: '免费模型库' }).getByRole('button', { name: /游戏机/ }).click();
  await builder.getByLabel('模型左右偏移', { exact: true }).fill('24');
  await expect(builder.getByRole('button', { name: '保存布置', exact: true })).toBeDisabled();
  await expect(builder.getByText('超出房间', { exact: true })).toBeVisible();
  await builder.getByLabel('模型左右偏移', { exact: true }).fill('20');
  await builder.getByLabel('模型前后偏移', { exact: true }).fill('15');
  await expect(builder.getByRole('button', { name: '保存布置', exact: true })).toBeEnabled();
  await builder.getByRole('button', { name: '保存布置', exact: true }).click();
  await expect(builder.getByText('模型布置已保存。', { exact: true })).toBeVisible();
  expect(state.land.models!.slice(0, -1)).toEqual(state.original);
  expect(state.land.models!.at(-1)).toMatchObject({ model_id: 'arcade', room_id: roomId, x: 2, y: 1.5 });
  await builder.getByRole('button', { name: '关闭模型布置', exact: true }).click();
  await page.getByRole('button', { name: 'E · 进入房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-id', roomId);
  await expect(map).toHaveAttribute('data-model-count', String(state.original.length + 1));
  expect(state.writes.filter(write => write.path.includes('/models'))).toHaveLength(1);
});

for (const mobile of [false, true]) test(`高挑室内保留昼夜照明与俯视布置，${mobile ? '手机' : '桌面'}可正常退出`, async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const state = await roomFixture(page);
  await page.goto('/world'); const map = page.getByTestId('world-map');
  await page.getByRole('button', { name: 'E · 进入房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-width', String(WORLD_ROOM_DIMENSIONS.width));
  await expect(map).toHaveAttribute('data-room-depth', String(WORLD_ROOM_DIMENSIONS.height));
  await expect(map).toHaveAttribute('data-room-height', '1.2');
  await expect(map).toHaveAttribute('data-room-shadow-lights', mobile ? '0' : '1');
  await expect(map).toHaveAttribute('data-day-phase', 'day');
  await expect.poll(async () => Number(await map.getAttribute('data-assets-loaded'))).toBeGreaterThanOrEqual(10);
  const dayWindowStrength = Number(await map.getAttribute('data-room-window-strength'));
  const device = mobile ? 'mobile' : 'desktop';
  await page.screenshot({ path: `.local/room-space-${device}-day.png`, fullPage: true });
  state.world.server_time = '2026-11-09T14:00:00.000Z'; state.broadcast();
  await expect(map).toHaveAttribute('data-day-phase', 'night');
  expect(Number(await map.getAttribute('data-room-window-strength'))).toBeLessThan(dayWindowStrength / 2);
  await page.screenshot({ path: `.local/room-space-${device}-night.png`, fullPage: true });
  await page.getByRole('button', { name: '俯视地图', exact: true }).click();
  await expect(map).toHaveAttribute('data-view', 'overview');
  await page.screenshot({ path: `.local/room-space-${device}-overview.png`, fullPage: true });
  await page.getByRole('button', { name: '第一人称', exact: true }).click();
  await page.getByRole('button', { name: 'E · 离开房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-id', '');
  await expect(map).toHaveAttribute('data-room-lights', '0');
  expect(state.land.models).toEqual(state.original);
  expect(errors).toEqual([]);
});
