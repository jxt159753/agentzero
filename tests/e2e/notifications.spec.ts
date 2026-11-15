import { test, expect, type Page, type Route } from '@playwright/test';
import type { ConversationDto, MessageNotificationDto } from '../../packages/contracts/src/messages.js';
import { WORLD_BOUNDS, WORLD_PLACES, WORLD_PUBLIC_AREAS, type WorldSnapshot } from '../../packages/contracts/src/world.js';
import { notificationStorageKey } from '../../apps/web/src/notification-state.js';

const userId = '17000000-0000-4000-8000-000000000001', peerId = '17000000-0000-4000-8000-000000000002';
const agentId = '27000000-0000-4000-8000-000000000001', conversationId = '57000000-0000-4000-8000-000000000001';
const taskId = '47000000-0000-4000-8000-000000000001', timestamp = '2026-11-15T08:00:00.000Z';
const reply = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const mainNav = (page: Page) => page.getByRole('navigation', { name: '主导航', exact: true });
const navDot = (page: Page, name = '消息') => mainNav(page).getByRole('link', { name, exact: true }).getByRole('img', { name: '有未读提醒' });
const soundCount = (page: Page) => page.evaluate(() => (window as unknown as { notificationSounds: number }).notificationSounds);
const stored = (page: Page, id = userId) => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), notificationStorageKey(id));
const poll = (page: Page) => page.clock.fastForward(5100);

async function mockNotifications(page: Page, { fakeClock = true } = {}) {
  if (fakeClock) await page.clock.install();
  await page.addInitScript(() => {
    const tracker = window as unknown as { notificationSounds: number }; tracker.notificationSounds = 0;
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: class {
      state = 'running'; currentTime = 0; destination = {};
      async resume() {} async close() { this.state = 'closed'; }
      createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
      createOscillator() { return { frequency: { value: 0 }, type: 'sine', connect() {}, disconnect() {}, start() { tracker.notificationSounds++; }, stop() {}, onended: null }; }
    } });
  });
  const state = { userId, messages: [] as MessageNotificationDto[], reads: [] as URL[], failNext: false };
  const conversation: ConversationDto = { id: conversationId, kind: 'direct', task_id: null, title: null, created_at: timestamp, members: [
    { id: 'self-member', user_id: userId, agent_id: null, name: '探索者', owner_user_id: userId, role: 'member' },
    { id: 'peer-member', user_id: peerId, agent_id: null, name: '小镇邻居', owner_user_id: peerId, role: 'member' },
  ] };
  const add = (cursor: number, options: Partial<MessageNotificationDto> = {}) => {
    const message: MessageNotificationDto = { id: `message-${cursor}`, cursor: String(cursor), conversation_id: conversationId, conversation_kind: 'direct', task_id: null, sender_user_id: peerId, sender_agent_id: null, sender_owner_user_id: peerId, sender_name: '小镇邻居', body: `新消息 ${cursor}`, created_at: timestamp, ...options };
    state.messages.push(message); return message;
  };
  add(1, { body: '首次打开前的历史消息' });
  const world: WorldSnapshot = { server_time: timestamp, presence_ttl_seconds: 60, self: { kind: 'visitor', id: userId, x: 0, y: 0, online: true }, places: WORLD_PLACES, bounds: WORLD_BOUNDS, public_areas: WORLD_PUBLIC_AREAS, lands: [], agents: [], visitors: [{ id: userId, name: '探索者', github_login: 'explorer', online: true, x: 0, y: 0 }] };
  await page.routeWebSocket('**/api/v1/world/stream?v=2', socket => {
    socket.send(JSON.stringify({ type: 'snapshot', world }));
    socket.onMessage(data => {
      const input = JSON.parse(String(data));
      if (input.type === 'move') socket.send(JSON.stringify({ type: 'ack', ...input }));
      if (input.type === 'heartbeat') socket.send(JSON.stringify({ type: 'ping', server_time: timestamp }));
    });
  });
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/api/v1', '');
    if (path === '/me') return reply(route, { actor: { type: 'user', userId: state.userId }, user: { id: state.userId, display_name: '探索者', github_login: 'explorer', role: 'member', status: 'active' } });
    if (path === '/agents') return reply(route, { items: [], next_cursor: null });
    if (path === '/conversations') return reply(route, { items: [{ ...conversation, last_message: state.messages.filter(item => item.conversation_id === conversationId).at(-1) }], next_cursor: null });
    if (path === `/conversations/${conversationId}`) return reply(route, conversation);
    if (path === '/messages' || path === `/conversations/${conversationId}/messages`) {
      state.reads.push(url);
      if (path === '/messages' && state.failNext) { state.failNext = false; return reply(route, { error: { code: 'SERVER_ERROR' } }, 503); }
      const before = url.searchParams.get('before'), after = url.searchParams.get('after') ?? '0', limit = Number(url.searchParams.get('limit') ?? '30');
      const matching = state.messages.filter(item => (path === '/messages' || item.conversation_id === conversationId) && (before ? BigInt(item.cursor) < BigInt(before) : BigInt(item.cursor) > BigInt(after)));
      const items = before ? matching.slice(-limit) : matching.slice(0, limit);
      return reply(route, { items, next_cursor: (before ? items[0]?.cursor : items.at(-1)?.cursor) ?? before ?? after, has_more: matching.length > limit });
    }
    return reply(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  return { state, add };
}

test('新消息红点、横幅、音效与已读状态跨路由和刷新保持一致', { tag: '@smoke' }, async ({ page }) => {
  const { add } = await mockNotifications(page);
  await page.goto('/agents');
  await expect.poll(async () => (await stored(page))?.cursor).toBe('1');
  await expect(navDot(page)).toHaveCount(0); expect(await soundCount(page)).toBe(0);
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.keyboard.press('Escape');
  add(2); await poll(page);
  await expect(navDot(page)).toBeVisible();
  await expect(page.getByRole('link', { name: /新消息 · 小镇邻居/ })).toContainText('新消息 2');
  expect(await soundCount(page)).toBe(2);
  await page.getByRole('button', { name: '关闭通知', exact: true }).click();
  add(3, { sender_user_id: userId, sender_owner_user_id: userId });
  add(4, { sender_user_id: null, sender_agent_id: agentId, sender_owner_user_id: userId });
  await poll(page); await expect.poll(async () => (await stored(page)).cursor).toBe('4');
  expect(await soundCount(page)).toBe(2);
  await poll(page); expect(await soundCount(page)).toBe(2);
  await page.reload(); await expect(navDot(page)).toBeVisible();
  expect(await soundCount(page)).toBe(0);
  await mainNav(page).getByRole('link', { name: '消息', exact: true }).click();
  const conversations = page.getByRole('navigation', { name: '会话列表', exact: true });
  await expect(conversations.getByRole('img', { name: '有未读提醒' })).toBeVisible();
  await conversations.getByRole('link').click();
  await expect(page.getByRole('list', { name: '消息记录', exact: true })).toContainText('新消息 4');
  await expect(navDot(page)).toHaveCount(0);
  add(5); await poll(page);
  await expect(page.getByRole('list', { name: '消息记录', exact: true })).toContainText('新消息 5');
  await expect(navDot(page)).toHaveCount(0); expect(await soundCount(page)).toBe(0);
});

test('分类、红点、横幅、音效和音量设置可保存，支持全部已读及账号隔离', async ({ page }) => {
  const { state, add } = await mockNotifications(page);
  await page.goto('/agents'); await expect.poll(async () => (await stored(page))?.cursor).toBe('1');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('switch', { name: '私聊与群聊', exact: true }).uncheck();
  await page.getByRole('slider', { name: '提示音量' }).fill('25');
  await page.getByRole('button', { name: '试听提示音', exact: true }).click(); expect(await soundCount(page)).toBe(2);
  await page.keyboard.press('Escape');
  add(2); await poll(page); await expect.poll(async () => (await stored(page)).cursor).toBe('2');
  await expect(navDot(page)).toHaveCount(0); expect(await soundCount(page)).toBe(2);
  add(3, { conversation_id: 'task-chat', conversation_kind: 'task', task_id: taskId }); await poll(page);
  await expect(navDot(page, '任务大厅')).toBeVisible();
  await expect(page.getByRole('link', { name: /任务讨论 · 小镇邻居/ })).toHaveAttribute('href', `/tasks/${taskId}`);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('switch', { name: '未读红点', exact: true }).uncheck();
  await page.getByRole('switch', { name: '横幅通知', exact: true }).uncheck();
  await page.getByRole('switch', { name: '提示音', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  add(4, { conversation_id: 'task-chat', conversation_kind: 'task', task_id: taskId }); await poll(page);
  await expect.poll(async () => (await stored(page)).cursor).toBe('4');
  await expect(navDot(page, '任务大厅')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '关闭通知', exact: true })).toHaveCount(0); expect(await soundCount(page)).toBe(4);
  await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click();
  for (const name of ['私聊与群聊', '未读红点', '横幅通知', '提示音']) await expect(page.getByRole('switch', { name, exact: true })).not.toBeChecked();
  await expect(page.getByRole('slider', { name: '提示音量' })).toHaveValue('25');
  await page.getByRole('button', { name: '全部标为已读', exact: true }).click();
  await expect.poll(async () => (await stored(page)).unread).toEqual({});
  state.userId = peerId; await page.reload();
  await expect.poll(async () => (await stored(page, peerId))?.cursor).toBe('4');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('switch', { name: '提示音', exact: true })).toBeChecked();
  await expect(page.getByRole('slider', { name: '提示音量' })).toHaveValue('40');
});

test('分页追赶不丢消息，一批仅响一次，断线重试保留游标且未交互前不播放', async ({ page }) => {
  const { state, add } = await mockNotifications(page);
  await page.goto('/agents'); await expect.poll(async () => (await stored(page))?.cursor).toBe('1');
  add(2); await poll(page); await expect(navDot(page)).toBeVisible(); expect(await soundCount(page)).toBe(0);
  await page.getByRole('button', { name: '关闭通知', exact: true }).click();
  for (let cursor = 3; cursor <= 107; cursor++) add(cursor);
  await poll(page); await expect.poll(async () => (await stored(page)).cursor).toBe('107');
  expect(state.reads.some(url => url.searchParams.get('after') === '102')).toBe(true); expect(await soundCount(page)).toBe(2);
  await page.getByRole('button', { name: '关闭通知', exact: true }).click();
  add(108); state.failNext = true; await poll(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新连接提醒', exact: true })).toBeVisible(); expect((await stored(page)).cursor).toBe('107');
  await page.getByRole('button', { name: '重新连接提醒', exact: true }).click();
  await expect.poll(async () => (await stored(page)).cursor).toBe('108'); expect(await soundCount(page)).toBe(4);
});

test.describe('手机横屏', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('竖屏引导全屏并申请横屏，旋转后消息与设置面板可操作', { tag: '@smoke' }, async ({ page }) => {
    await mockNotifications(page, { fakeClock: false });
    await page.addInitScript(() => {
      const tracker = window as unknown as { landscapeCalls: string[] }; tracker.landscapeCalls = [];
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: async () => { tracker.landscapeCalls.push('fullscreen'); } });
      Object.defineProperty(screen.orientation, 'lock', { value: async (orientation: string) => { tracker.landscapeCalls.push(orientation); } });
    });
    await page.goto('/world');
    await expect(page.getByRole('dialog', { name: '横屏进入 Agent 小镇' })).toBeVisible();
    await expect(mainNav(page)).toHaveCount(0);
    await page.getByRole('button', { name: '切换横屏', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { landscapeCalls: string[] }).landscapeCalls)).toEqual(['fullscreen', 'landscape']);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const map = page.getByTestId('world-map'); await expect(map).toHaveAttribute('data-renderer', 'three');
    expect(await map.boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 390 });
    for (const name of ['向上移动', '向下移动', '向左移动', '向右移动']) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport();
    await page.screenshot({ path: '.local/issue-10-mobile-landscape.png' });
    await mainNav(page).getByRole('link', { name: '消息', exact: true }).click();
    await page.getByRole('navigation', { name: '会话列表' }).getByRole('link').click();
    await expect(page.getByRole('textbox', { name: '消息内容', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport();
    const feature = (await page.getByRole('region', { name: '功能面板', exact: true }).boundingBox())!, dock = (await mainNav(page).boundingBox())!;
    expect(feature.y + feature.height).toBeLessThan(dock.y);
    await page.screenshot({ path: '.local/issue-10-mobile-messages.png' });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('region', { name: '小镇设置', exact: true });
    const bounds = (await settings.boundingBox())!; expect(bounds.y + bounds.height).toBeLessThanOrEqual(390);
    await settings.getByRole('switch', { name: '提示音', exact: true }).uncheck();
    await settings.getByRole('button', { name: '退出', exact: true }).scrollIntoViewIfNeeded();
    await expect(settings.getByRole('button', { name: '退出', exact: true })).toBeInViewport();
    await page.screenshot({ path: '.local/issue-10-mobile-settings.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  });

  test('浏览器不支持横屏锁定时明确提示，手动旋转可继续使用', async ({ page }) => {
    await mockNotifications(page, { fakeClock: false });
    await page.addInitScript(() => { Object.defineProperty(screen.orientation, 'lock', { value: undefined }); });
    await page.goto('/world'); await page.getByRole('button', { name: '切换横屏', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('开启手机自动旋转');
    await page.setViewportSize({ width: 667, height: 375 });
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(mainNav(page)).toBeVisible();
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeInViewport();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('dialog')).toBeVisible(); await expect(mainNav(page)).toHaveCount(0);
  });
});
