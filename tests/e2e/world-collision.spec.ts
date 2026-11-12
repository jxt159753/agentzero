import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { WORLD_BOUNDS, WORLD_PUBLIC_AREAS, WORLD_PLACES, WORLD_ROOM_DIMENSIONS, type WorldModelPlacement, type WorldSnapshot } from '../../packages/contracts/src/index.js';

const userId = '15000000-0000-4000-8000-000000000001', roomId = '75000000-0000-4000-8000-000000000001';
const owner = { id: userId, github_login: 'owner', display_name: '小镇主人' };

async function collisionWorld(page: Page, placements: WorldModelPlacement[], x: number, y: number) {
  const world: WorldSnapshot = {
    server_time: '2026-11-09T04:00:00.000Z', presence_ttl_seconds: 60,
    self: { kind: 'visitor', id: userId, x, y, online: true },
    bounds: WORLD_BOUNDS, public_areas: WORLD_PUBLIC_AREAS, places: WORLD_PLACES, agents: [],
    visitors: [{ id: userId, name: owner.display_name, github_login: owner.github_login, online: true, x, y }],
    lands: [{ id: '35000000-0000-4000-8000-000000000001', code: 'ROOM-01', x: 8, y: 5, width: 4, height: 4, area: 1600,
      name: '碰撞工作室', works_url: null, owner_agent_id: '25000000-0000-4000-8000-000000000001', owner_name: '房主', owner,
      tradeable: true, purchasable: false, points_price: '40', version: '1', listing: null, decorations: [], models: placements }],
  };
  const sockets = new Set<WebSocketRoute>(), moves: Record<string, unknown>[] = [], writes: string[] = [];
  const broadcast = () => { for (const socket of sockets) socket.send(JSON.stringify({ type: 'snapshot', world })); };
  await page.context().addCookies([{ name: 'az_csrf', value: 'collision-csrf', url: 'http://localhost:5173' }]);
  await page.routeWebSocket('**/api/v1/world/stream?v=2', socket => {
    sockets.add(socket); socket.send(JSON.stringify({ type: 'snapshot', world }));
    socket.onMessage(data => {
      const message = JSON.parse(String(data));
      if (message.type === 'move') {
        moves.push(message); Object.assign(world.self, { x: message.x, y: message.y, room_id: message.room_id });
        Object.assign(world.visitors[0]!, { x: message.x, y: message.y, room_id: message.room_id });
        socket.send(JSON.stringify({ ...message, type: 'ack', persisted: !message.moving }));
      }
    });
    socket.onClose(() => sockets.delete(socket));
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', '');
    let body: unknown = { error: { code: 'NOT_FOUND' } }, status = 200;
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/me') body = { actor: { type: 'user', userId }, user: { ...owner, status: 'active', role: 'member' } };
    else if (path === '/world') body = world;
    else if (path === '/world/presence') {
      Object.assign(world.self, request.postDataJSON()); Object.assign(world.visitors[0]!, request.postDataJSON()); body = { self: world.self };
    } else if (path.startsWith('/games/machines/')) body = { placement_id: path.split('/').at(-1), game: null };
    else status = 404;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { world, broadcast, moves, writes };
}

test('室内摆放家具阻挡跑跳，实时删除后通行且移动保留房间', async ({ page }) => {
  test.setTimeout(60000); await page.clock.install();
  const spawnY = WORLD_ROOM_DIMENSIONS.height / 2 - 0.25, fenceY = spawnY - 0.3;
  const state = await collisionWorld(page, [
    { id: roomId, version: '1', model_id: 'cabin', x: 0, y: 0, rotation: 0, scale: 1 },
    { id: '75000000-0000-4000-8000-000000000002', version: '1', model_id: 'fence', x: 0, y: fenceY, rotation: 0, scale: 1, room_id: roomId },
  ], 8, 5.985);
  await page.goto('/world'); const map = page.getByTestId('world-map');
  await page.getByRole('button', { name: 'E · 进入房屋', exact: true }).click();
  await expect(map).toHaveAttribute('data-room-id', roomId); await expect(map).toHaveAttribute('data-camera-yaw', '0');
  await map.focus(); await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.keyboard.down('Shift'); await page.keyboard.down('w'); await page.keyboard.press('Space'); await page.clock.runFor(480);
  expect(Number(await map.getAttribute('data-self-y'))).toBeCloseTo(fenceY + 0.04 + 0.075, 3);
  await expect(map).toHaveAttribute('data-airborne', 'true');
  await page.keyboard.up('w'); await page.keyboard.up('Shift'); await page.clock.runFor(64);
  state.world.lands[0]!.models = state.world.lands[0]!.models!.slice(0, 1); state.broadcast();
  await page.clock.runFor(64); await expect(map).toHaveAttribute('data-model-count', '1');
  await map.evaluate(element => (element as HTMLElement).focus()); await page.keyboard.down('w'); await page.clock.runFor(1000);
  await page.keyboard.up('w'); await page.clock.runFor(64);
  expect(Number(await map.getAttribute('data-self-y'))).toBeLessThan(fenceY - 0.1);
  expect(state.moves.length).toBeGreaterThan(0); expect(state.moves.every(move => move.room_id === roomId)).toBe(true);
  expect(state.writes).toEqual(['/world/presence']);
});

test('室外旋转缩小的围栏阻挡跑跳，俯视行走同样不能穿过模型', async ({ page }) => {
  test.setTimeout(60000); await page.clock.install();
  const yaw = -0.65, x = 8 + Math.sin(yaw) * 0.25, y = 5 + Math.cos(yaw) * 0.25;
  const state = await collisionWorld(page, [{ id: '75000000-0000-4000-8000-000000000002', version: '1', model_id: 'fence', x: 0, y: 0,
    rotation: 360 + yaw * 180 / Math.PI, scale: 0.25 }], x, y);
  await page.goto('/world'); const map = page.getByTestId('world-map');
  await expect(map).toHaveAttribute('data-renderer', 'three'); await map.focus();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.keyboard.down('Shift'); await page.keyboard.down('w'); await page.keyboard.press('Space'); await page.clock.runFor(480);
  const point = { x: Number(await map.getAttribute('data-self-x')) - 8, y: Number(await map.getAttribute('data-self-y')) - 5 };
  expect(Math.sin(yaw) * point.x + Math.cos(yaw) * point.y).toBeCloseTo(0.01 + 0.075, 3);
  await expect(map).toHaveAttribute('data-airborne', 'true');
  await page.keyboard.up('w'); await page.keyboard.up('Shift');
  // Put an axis-aligned fence across the next overview step; update arrives through the real snapshot path.
  state.world.lands[0]!.models![0]!.rotation = 0; state.world.lands[0]!.models![0]!.scale = 2; state.broadcast();
  await page.getByRole('button', { name: '俯视地图', exact: true }).evaluate(element => (element as HTMLElement).click());
  await page.clock.runFor(64); await expect(map).toHaveAttribute('data-view', 'overview');
  // Spawn is now inside the enlarged footprint: first leave it, then verify re-entry is blocked.
  await page.getByRole('button', { name: '向下移动', exact: true }).evaluate(element => (element as HTMLElement).click()); await page.clock.runFor(400);
  await page.getByRole('button', { name: '向上移动', exact: true }).evaluate(element => (element as HTMLElement).click()); await page.clock.runFor(400);
  expect(Number(await map.getAttribute('data-self-y'))).toBeGreaterThanOrEqual(5.155 - 0.001);
  state.world.lands[0]!.models = []; state.broadcast(); await page.clock.runFor(64);
  await page.getByRole('button', { name: '向上移动', exact: true }).evaluate(element => (element as HTMLElement).click()); await page.clock.runFor(400);
  expect(Number(await map.getAttribute('data-self-y'))).toBeLessThan(5);
  expect(state.writes).toHaveLength(0);
});
