import { test, expect, type Page, type Route } from '@playwright/test';
import type { ConversationDto, MessageDto } from '../../packages/contracts/src/messages.js';

const userId = '11000000-0000-4000-8000-000000000001';
const visitorId = '11000000-0000-4000-8000-000000000002';
const ownAgent = '44000000-0000-4000-8000-000000000001';
const recipient = '44000000-0000-4000-8000-000000000002';
const conversationId = '55000000-0000-4000-8000-000000000001';
const secondConversationId = '55000000-0000-4000-8000-000000000002';
const timestamp = '2026-11-07T08:00:00.000Z';
const reply = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const composer = (page: Page) => page.getByRole('textbox', { name: '消息内容', exact: true });
const history = (page: Page) => page.getByRole('list', { name: '消息记录', exact: true });

async function mockMessages(page: Page, options: { lostResponse?: boolean; historyCount?: number; secondConversation?: boolean } = {}) {
  const conversation: ConversationDto = { id: conversationId, kind: 'direct', task_id: null, title: null, created_at: timestamp, members: [{ id: 'member-own', user_id: null, agent_id: ownAgent, name: '开发 Agent', owner_user_id: userId, role: 'member' }, { id: 'member-recipient', user_id: null, agent_id: recipient, name: '测试 Agent', owner_user_id: visitorId, role: 'member' }] };
  const conversations: ConversationDto[] = [conversation];
  if (options.secondConversation) conversations.push({ id: secondConversationId, kind: 'direct', task_id: null, title: null, created_at: timestamp, members: [{ id: 'member-self-2', user_id: userId, agent_id: null, name: '开发者', owner_user_id: userId, role: 'member' }, { id: 'member-visitor-2', user_id: visitorId, agent_id: null, name: '小镇邻居', owner_user_id: visitorId, role: 'member' }] });
  const messages: MessageDto[] = Array.from({ length: options.historyCount ?? 1 }, (_, index) => ({ id: `message-${index + 1}`, cursor: String(index + 1), conversation_id: conversationId, sender_user_id: null, sender_agent_id: recipient, sender_name: '测试 Agent', body: options.historyCount ? `历史消息 ${index + 1}` : '可以协助测试；请在任务中发出协议。', created_at: new Date(Date.parse(timestamp) + index * 1000).toISOString() }));
  const writes: { path: string; body: Record<string, unknown>; key: string; csrf: string }[] = [];
  const messageReads: URL[] = [];
  const committed = new Map<string, MessageDto>();
  let loseNext = options.lostResponse;
  let cursor = messages.length;
  const withSummary = (item: ConversationDto) => ({ ...item, last_message: messages.filter(message => message.conversation_id === item.id).at(-1) ?? null });
  await page.context().addCookies([{ name: 'az_csrf', value: 'messages-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = request.method() === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    if (request.method() !== 'GET') writes.push({ path, body, key: request.headers()['idempotency-key']!, csrf: request.headers()['x-csrf-token']! });
    if (path === '/me') return reply(route, { actor: { type: 'user', userId }, user: { id: userId, display_name: '开发者', github_login: 'developer', status: 'active', role: 'member' } });
    if (path === '/agents') return reply(route, { items: [{ id: ownAgent, owner_user_id: userId, name: '开发 Agent', status: 'active', created_at: timestamp, updated_at: timestamp }], next_cursor: null });
    if (path === '/message-recipients') return reply(route, { items: [{ id: ownAgent, name: '开发 Agent', owner_user_id: userId, owner_name: '开发者' }, { id: recipient, name: '测试 Agent', owner_user_id: visitorId, owner_name: '测试者' }], users: [{ id: visitorId, name: '小镇邻居', github_login: 'neighbor' }] });
    if (path === '/conversations') {
      if (request.method() === 'GET') return reply(route, { items: conversations.map(withSummary), next_cursor: null });
      conversation.members[0] = body.sender_agent_id
        ? { id: 'member-own', user_id: null, agent_id: ownAgent, name: '开发 Agent', owner_user_id: userId, role: 'member' }
        : { id: 'member-self', user_id: userId, agent_id: null, name: '开发者', owner_user_id: userId, role: 'member' };
      if (body.recipient_user_id) {
        const id = String(body.recipient_user_id);
        conversation.members[1] = { id: 'member-peer', user_id: id, agent_id: null, name: id === userId ? '开发者' : '小镇邻居', owner_user_id: id, role: 'member' };
        messages.length = 0;
      }
      return reply(route, { ...withSummary(conversation), operation_id: conversationId });
    }
    const detail = conversations.find(item => path === `/conversations/${item.id}`);
    if (detail) return reply(route, withSummary(detail));
    const target = conversations.find(item => path === `/conversations/${item.id}/messages`);
    if (target) {
      if (request.method() === 'POST') {
        const key = request.headers()['idempotency-key']!;
        let message = committed.get(key);
        if (!message) {
          cursor += 1;
          message = { id: `message-${cursor}`, cursor: String(cursor), conversation_id: target.id, sender_user_id: body.sender_agent_id ? null : userId, sender_agent_id: body.sender_agent_id ? ownAgent : null, sender_name: body.sender_agent_id ? '开发 Agent' : '开发者', body: String(body.body), created_at: new Date(Date.parse(timestamp) + cursor * 1000).toISOString() };
          messages.push(message);
          committed.set(key, message);
        }
        // The server committed the write, but the response was lost. A retry must reuse the key.
        if (loseNext) { loseNext = false; return route.abort('failed'); }
        return reply(route, { ...message, operation_id: target.id });
      }
      messageReads.push(url);
      const before = url.searchParams.get('before');
      const after = url.searchParams.get('after') ?? '0';
      const limit = Number(url.searchParams.get('limit') ?? '30');
      const matching = messages.filter(message => message.conversation_id === target.id && (before ? BigInt(message.cursor) < BigInt(before) : BigInt(message.cursor) > BigInt(after)));
      const items = before ? matching.slice(-limit) : matching.slice(0, limit);
      return reply(route, { items, next_cursor: (before ? items[0]?.cursor : items.at(-1)?.cursor) ?? before ?? after, has_more: matching.length > limit });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND' } }) });
  });
  return { writes, messages, messageReads };
}

test('代表 Agent 一键开启私聊并发送消息，不调用合同或钱包接口', async ({ page }) => {
  const { writes } = await mockMessages(page);
  await page.goto('/messages');
  await page.getByRole('button', { name: '发起私聊', exact: true }).click();
  await page.getByRole('combobox', { name: '发起身份', exact: true }).selectOption(ownAgent);
  await page.getByRole('button', { name: '联系 测试 Agent', exact: true }).click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  await expect(history(page).getByText('可以协助测试；请在任务中发出协议。', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '发送身份', exact: true })).toHaveCount(0);
  await composer(page).fill('同意 70 / 30 的分工，稍后显式确认协议。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(history(page).getByText('同意 70 / 30 的分工，稍后显式确认协议。', { exact: true })).toBeVisible();
  expect(writes.map(write => write.path)).toEqual(['/conversations', `/conversations/${conversationId}/messages`]);
  expect(writes[0]!.body).toEqual({ recipient_agent_id: recipient, sender_agent_id: ownAgent });
  expect(writes[1]!.body.sender_agent_id).toBe(ownAgent);
  expect(writes.every(write => write.csrf === 'messages-csrf' && Boolean(write.key))).toBe(true);
  await page.screenshot({ path: '.local/chat-desktop.png', fullPage: true });
});

test('网络结果未知时切换会话发送再返回，保留原草稿和请求键且重试不重复', async ({ page }) => {
  const { writes, messages } = await mockMessages(page, { lostResponse: true, secondConversation: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/messages/${conversationId}`);
  await composer(page).fill('测试进度：回归检查全部通过。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(composer(page)).toHaveValue('测试进度：回归检查全部通过。');
  await page.getByRole('link', { name: '返回会话列表', exact: true }).click();
  await page.getByRole('navigation', { name: '会话列表', exact: true }).getByRole('link').filter({ hasText: '小镇邻居' }).click();
  await expect(composer(page)).toHaveValue('');
  await composer(page).fill('另一会话的正常消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(history(page).getByText('另一会话的正常消息', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回会话列表', exact: true }).click();
  await page.getByRole('navigation', { name: '会话列表', exact: true }).getByRole('link').filter({ hasText: '测试 Agent' }).click();
  await expect(composer(page)).toHaveValue('测试进度：回归检查全部通过。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(history(page).getByText('测试进度：回归检查全部通过。', { exact: true })).toHaveCount(1);
  await expect(composer(page)).toHaveValue('');
  expect(writes).toHaveLength(3);
  expect(writes[0]!.key).toBe(writes[2]!.key);
  expect(writes[0]!.body).toEqual(writes[2]!.body);
  expect(writes[1]!.key).not.toBe(writes[0]!.key);
  expect(writes[1]!.path).toBe(`/conversations/${secondConversationId}/messages`);
  expect(messages.filter(message => message.body === '测试进度：回归检查全部通过。')).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(composer(page)).toBeInViewport();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport();
  await page.screenshot({ path: '.local/chat-mobile.png', fullPage: true });
  await page.getByRole('link', { name: '返回会话列表', exact: true }).or(page.getByRole('button', { name: '返回会话列表', exact: true })).click();
  await expect(page).toHaveURL('/messages');
  await expect(page.getByRole('navigation', { name: '会话列表', exact: true })).toBeVisible();
});

test('小镇 Agent 入口默认本人，点击联系人后才开始私聊', async ({ page }) => {
  const { writes } = await mockMessages(page);
  await page.goto(`/messages?agent=${recipient}`);
  await expect(page.getByRole('combobox', { name: '发起身份', exact: true })).toHaveValue('');
  const contact = page.getByRole('button', { name: '联系 测试 Agent', exact: true });
  await expect(contact).toBeVisible();
  expect(writes).toHaveLength(0);
  await contact.click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  await expect(page.getByRole('heading', { name: '测试 Agent', exact: true })).toBeVisible();
  await composer(page).fill('刚在小镇遇见你，想聊聊合作。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(history(page).getByText('刚在小镇遇见你，想聊聊合作。', { exact: true })).toBeVisible();
  expect(writes.map(write => ({ path: write.path, body: write.body }))).toEqual([
    { path: '/conversations', body: { recipient_agent_id: recipient } },
    { path: `/conversations/${conversationId}/messages`, body: { body: '刚在小镇遇见你，想聊聊合作。' } },
  ]);
});

test('无效入口不创建会话，切换入口重置发起身份', async ({ page }) => {
  const { writes } = await mockMessages(page);
  await page.goto('/messages?agent=unavailable-agent');
  await expect(page.getByText('这个 Agent 暂不可联系，请选择其他联系对象。', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '发起身份', exact: true }).selectOption(ownAgent);
  await page.evaluate((id) => {
    window.history.pushState({}, '', `/messages?agent=${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, ownAgent);
  await expect(page.getByRole('combobox', { name: '发起身份', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '联系 开发 Agent', exact: true })).toBeVisible();
  await expect(page.getByText('这个 Agent 暂不可联系，请选择其他联系对象。', { exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test('小镇访客入口以本人身份联系并发送消息', async ({ page }) => {
  const { writes } = await mockMessages(page);
  await page.goto(`/messages?user=${visitorId}`);
  await expect(page.getByRole('combobox', { name: '发起身份', exact: true })).toHaveValue('');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '联系 小镇邻居', exact: true }).click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  await expect(page.getByRole('heading', { name: '小镇邻居', exact: true })).toBeVisible();
  await composer(page).fill('你好，刚刚在小镇遇见你。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(history(page).getByText('你好，刚刚在小镇遇见你。', { exact: true })).toBeVisible();
  expect(writes.map(write => ({ path: write.path, body: write.body }))).toEqual([
    { path: '/conversations', body: { recipient_user_id: visitorId } },
    { path: `/conversations/${conversationId}/messages`, body: { body: '你好，刚刚在小镇遇见你。' } },
  ]);
});

test('代表 Agent 联系访客并以 Agent 身份发送消息', async ({ page }) => {
  const { writes } = await mockMessages(page);
  await page.goto(`/messages?user=${visitorId}`);
  await page.getByRole('combobox', { name: '发起身份', exact: true }).selectOption(ownAgent);
  await page.getByRole('button', { name: '联系 小镇邻居', exact: true }).click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  await composer(page).fill('我是开发 Agent，可以一起讨论项目。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(history(page).getByText('我是开发 Agent，可以一起讨论项目。', { exact: true })).toBeVisible();
  expect(writes[0]!.body).toEqual({ recipient_user_id: visitorId, sender_agent_id: ownAgent });
  expect(writes[1]!.body).toEqual({ body: '我是开发 Agent，可以一起讨论项目。', sender_agent_id: ownAgent });
});

test('本人不能联系自己，但可以代表 Agent 联系主人', async ({ page }) => {
  const { writes } = await mockMessages(page);
  await page.goto(`/messages?user=${userId}`);
  const sender = page.getByRole('combobox', { name: '发起身份', exact: true });
  const contact = page.getByRole('button', { name: '联系 开发者', exact: true });
  await expect(sender).toHaveValue('');
  await expect(contact).toHaveCount(0);
  await sender.selectOption(ownAgent);
  await expect(contact).toBeVisible();
  await sender.selectOption('');
  await expect(contact).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await sender.selectOption(ownAgent);
  await contact.click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  expect(writes[0]!.body).toEqual({ recipient_user_id: userId, sender_agent_id: ownAgent });
  await composer(page).fill('以 Agent 身份给主人留言');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(history(page).getByText('以 Agent 身份给主人留言', { exact: true })).toBeVisible();
  expect(writes[1]!.body).toEqual({ body: '以 Agent 身份给主人留言', sender_agent_id: ownAgent });
});

test('无效访客入口可直接搜索其他联系人，无需选择联系类型', async ({ page }) => {
  const { writes } = await mockMessages(page);
  await page.goto('/messages?user=unavailable-visitor');
  await expect(page.getByText('这位访客暂不可联系，请选择其他联系对象。', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索会话或联系人', exact: true }).fill('测试');
  await expect(page.getByRole('button', { name: '联系 测试 Agent', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '联系 小镇邻居', exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '联系 测试 Agent', exact: true }).click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  expect(writes[0]!.body).toEqual({ recipient_agent_id: recipient });
});

test('Enter 发送、Shift+Enter 换行，中文输入法候选确认不会误发', async ({ page }) => {
  const { writes } = await mockMessages(page);
  await page.goto(`/messages/${conversationId}`);
  const input = composer(page);
  await input.fill('正在输入中文');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  await expect(input).toHaveValue('正在输入中文');
  expect(writes).toHaveLength(0);
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('正在输入中文\n');
  expect(writes).toHaveLength(0);
  await input.press('End');
  await input.press('Enter');
  await expect(history(page).getByText('正在输入中文', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body).toEqual({ body: '正在输入中文', sender_agent_id: ownAgent });
});

test('桌面切换会话保留各自草稿，联系人列表和输入区保持同屏', async ({ page }) => {
  const { writes } = await mockMessages(page, { secondConversation: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/messages/${conversationId}`);
  const list = page.getByRole('navigation', { name: '会话列表', exact: true });
  await expect(list).toBeVisible();
  await composer(page).fill('尚未发给测试 Agent 的草稿');
  await list.getByRole('link').filter({ hasText: '小镇邻居' }).click();
  await expect(page).toHaveURL(`/messages/${secondConversationId}`);
  await expect(composer(page)).toHaveValue('');
  await composer(page).fill('邻居的另一份草稿');
  await list.getByRole('link').filter({ hasText: '测试 Agent' }).click();
  await expect(composer(page)).toHaveValue('尚未发给测试 Agent 的草稿');
  await list.getByRole('link').filter({ hasText: '小镇邻居' }).click();
  await expect(composer(page)).toHaveValue('邻居的另一份草稿');
  await expect(composer(page)).toBeInViewport();
  expect(writes).toHaveLength(0);
});

test('长会话初次显示最新消息，可向上加载历史且发送后看见新消息', async ({ page }) => {
  const { messageReads, writes } = await mockMessages(page, { historyCount: 75 });
  await page.goto(`/messages/${conversationId}`);
  await expect(history(page).getByText('历史消息 75', { exact: true })).toBeInViewport();
  await expect(history(page).getByText('历史消息 1', { exact: true })).toHaveCount(0);
  expect(messageReads[0]!.searchParams.get('before')).toBe('9223372036854775807');
  await page.getByRole('button', { name: '查看更早消息', exact: true }).click();
  await expect(history(page).getByRole('listitem')).toHaveCount(60);
  await page.getByRole('button', { name: '查看更早消息', exact: true }).click();
  await expect(history(page).getByText('历史消息 1', { exact: true })).toHaveCount(1);
  await expect(history(page).getByRole('listitem')).toHaveCount(75);
  await composer(page).fill('这是最新回复');
  await composer(page).press('Enter');
  await expect(history(page).getByText('这是最新回复', { exact: true })).toBeInViewport();
  expect(writes).toHaveLength(1);
});

test('聊天自动接收新消息，无需手动刷新', async ({ page }) => {
  const { messages, writes } = await mockMessages(page);
  await page.goto(`/messages/${conversationId}`);
  await expect(history(page).getByText('可以协助测试；请在任务中发出协议。', { exact: true })).toBeVisible();
  messages.push({ id: 'message-2', cursor: '2', conversation_id: conversationId, sender_user_id: null, sender_agent_id: recipient, sender_name: '测试 Agent', body: '新的回复已自动到达', created_at: '2026-11-07T08:01:00.000Z' });
  await expect(history(page).getByText('新的回复已自动到达', { exact: true })).toBeInViewport({ timeout: 12000 });
  expect(writes).toHaveLength(0);
});

test('阅读历史时暂停轮询保持位置，回到底部后继续接收消息', async ({ page }) => {
  await page.clock.install();
  const { messages, messageReads } = await mockMessages(page, { historyCount: 75 });
  await page.goto(`/messages/${conversationId}`);
  await expect(history(page).getByText('历史消息 75', { exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '查看更早消息', exact: true }).click();
  await expect(history(page).getByRole('listitem')).toHaveCount(60);
  await page.getByRole('button', { name: '查看更早消息', exact: true }).click();
  await expect(history(page).getByRole('listitem')).toHaveCount(75);
  await history(page).evaluate(list => {
    const timeline = list.parentElement!;
    timeline.scrollTop = 0;
    timeline.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(history(page).getByText('历史消息 1', { exact: true })).toBeInViewport();
  messages.push({ id: 'message-76', cursor: '76', conversation_id: conversationId, sender_user_id: null, sender_agent_id: recipient, sender_name: '测试 Agent', body: '读完历史后收到的新消息', created_at: '2026-11-07T08:02:00.000Z' });
  const readsWhileReading = messageReads.length;
  await page.clock.runFor(6000);
  expect(messageReads).toHaveLength(readsWhileReading);
  await expect(history(page).getByText('历史消息 1', { exact: true })).toBeInViewport();
  await expect(history(page).getByText('读完历史后收到的新消息', { exact: true })).toHaveCount(0);
  expect(await history(page).evaluate(list => list.parentElement!.scrollTop)).toBe(0);
  await history(page).evaluate(list => {
    const timeline = list.parentElement!;
    timeline.scrollTop = timeline.scrollHeight;
    timeline.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(history(page).getByText('历史消息 75', { exact: true })).toBeInViewport();
  await page.clock.runFor(6000);
  await expect(history(page).getByText('读完历史后收到的新消息', { exact: true })).toBeInViewport();
  expect(messageReads.length).toBeGreaterThan(readsWhileReading);
});
