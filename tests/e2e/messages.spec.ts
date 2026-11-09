import { test, expect, type Page, type Route } from '@playwright/test';
import type { ConversationDto, MessageDto } from '../../packages/contracts/src/messages.js';

const userId = '11000000-0000-4000-8000-000000000001';
const visitorId = '11000000-0000-4000-8000-000000000002';
const ownAgent = '44000000-0000-4000-8000-000000000001';
const recipient = '44000000-0000-4000-8000-000000000002';
const conversationId = '55000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-07T08:00:00.000Z';
const reply = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function mockMessages(page: Page, lostResponse = false) {
  const conversation: ConversationDto = { id: conversationId, kind: 'direct', task_id: null, created_at: timestamp, members: [{ user_id: null, agent_id: ownAgent, name: '开发 Agent', owner_user_id: userId }, { user_id: null, agent_id: recipient, name: '测试 Agent', owner_user_id: '11000000-0000-4000-8000-000000000002' }] };
  const messages: MessageDto[] = [{ id: 'message-1', cursor: '1', conversation_id: conversationId, sender_user_id: null, sender_agent_id: recipient, sender_name: '测试 Agent', body: '可以协助测试；请在任务中发出协议。', created_at: timestamp }];
  const writes: { path: string; body: Record<string, unknown>; key: string; csrf: string }[] = [];
  let loseNext = lostResponse;
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
      if (request.method() === 'GET') return reply(route, { items: [conversation], next_cursor: null });
      conversation.members[0] = body.sender_agent_id
        ? { user_id: null, agent_id: ownAgent, name: '开发 Agent', owner_user_id: userId }
        : { user_id: userId, agent_id: null, name: '开发者', owner_user_id: userId };
      if (body.recipient_user_id) {
        const id = String(body.recipient_user_id);
        conversation.members[1] = { user_id: id, agent_id: null, name: id === userId ? '开发者' : '小镇邻居', owner_user_id: id };
        messages.length = 0;
      }
      return reply(route, { ...conversation, operation_id: conversationId });
    }
    if (path === `/conversations/${conversationId}`) return reply(route, conversation);
    if (path === `/conversations/${conversationId}/messages`) {
      if (request.method() === 'POST') {
        if (loseNext) { loseNext = false; return route.abort('failed'); }
        const message: MessageDto = { id: 'message-2', cursor: '2', conversation_id: conversationId, sender_user_id: body.sender_agent_id ? null : userId, sender_agent_id: body.sender_agent_id ? ownAgent : null, sender_name: body.sender_agent_id ? '开发 Agent' : '开发者', body: String(body.body), created_at: timestamp };
        messages.push(message);
        return reply(route, { ...message, operation_id: conversationId });
      }
      const after = BigInt(url.searchParams.get('after') ?? '0');
      const items = messages.filter((message) => BigInt(message.cursor) > after);
      return reply(route, { items, next_cursor: items.at(-1)?.cursor ?? after.toString(), has_more: false });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND' } }) });
  });
  return writes;
}

test('代表 Agent 开启私聊并发送消息，消息不调用合同或钱包接口', async ({ page }) => {
  const writes = await mockMessages(page);
  await page.goto('/messages');
  await page.getByRole('combobox', { name: '发起身份', exact: true }).selectOption(ownAgent);
  await page.getByRole('combobox', { name: '联系 Agent', exact: true }).selectOption(recipient);
  await page.getByRole('button', { name: '打开私聊', exact: true }).click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  await expect(page.getByText('可以协助测试；请在任务中发出协议。', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '发送身份', exact: true })).toHaveValue(ownAgent);
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill('同意 70 / 30 的分工，稍后显式确认协议。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('同意 70 / 30 的分工，稍后显式确认协议。', { exact: true })).toBeVisible();
  expect(writes.map((write) => write.path)).toEqual(['/conversations', `/conversations/${conversationId}/messages`]);
  expect(writes[0]!.body).toEqual({ recipient_agent_id: recipient, sender_agent_id: ownAgent });
  expect(writes[1]!.body.sender_agent_id).toBe(ownAgent);
  expect(writes.every((write) => write.csrf === 'messages-csrf' && Boolean(write.key))).toBe(true);
});

test('消息发送网络结果未知时保留内容与请求键，窄屏重试后只显示一次', async ({ page }) => {
  const writes = await mockMessages(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/messages/${conversationId}`);
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill('测试进度：回归检查全部通过。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(page.getByRole('textbox', { name: '消息内容', exact: true })).toHaveValue('测试进度：回归检查全部通过。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('测试进度：回归检查全部通过。', { exact: true })).toHaveCount(1);
  expect(writes).toHaveLength(2);
  expect(writes[0]!.key).toBe(writes[1]!.key);
  expect(writes[0]!.body).toEqual(writes[1]!.body);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/phase-3-messages-mobile.png', fullPage: true });
});

test('小镇私聊入口预选 Agent，以本人身份明确打开并发送消息', async ({ page }) => {
  const writes = await mockMessages(page);
  await page.goto(`/messages?agent=${recipient}`);
  await expect(page.getByRole('combobox', { name: '联系 Agent', exact: true })).toHaveValue(recipient);
  await expect(page.getByRole('combobox', { name: '发起身份', exact: true })).toHaveValue('');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '打开私聊', exact: true }).click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  await expect(page.getByRole('combobox', { name: '发送身份', exact: true })).toHaveValue('');
  expect(writes).toHaveLength(1);
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill('刚在小镇遇见你，想聊聊合作。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('刚在小镇遇见你，想聊聊合作。', { exact: true })).toBeVisible();
  expect(writes.map((write) => ({ path: write.path, body: write.body }))).toEqual([
    { path: '/conversations', body: { recipient_agent_id: recipient } },
    { path: `/conversations/${conversationId}/messages`, body: { body: '刚在小镇遇见你，想聊聊合作。' } },
  ]);
  expect(writes.every((write) => write.csrf === 'messages-csrf' && Boolean(write.key))).toBe(true);
});

test('不可联系的 Agent 不会创建会话，切换入口目标后重新预选', async ({ page }) => {
  const writes = await mockMessages(page);
  await page.goto('/messages?agent=unavailable-agent');
  const contact = page.getByRole('combobox', { name: '联系 Agent', exact: true });
  await expect(page.getByText('这个 Agent 暂不可联系，请选择其他联系对象。', { exact: true })).toBeVisible();
  await expect(contact).toHaveValue('');
  await expect(page.getByRole('button', { name: '打开私聊', exact: true })).toBeDisabled();
  await contact.selectOption(ownAgent);
  await expect(page.getByRole('button', { name: '打开私聊', exact: true })).toBeEnabled();
  await page.evaluate((id) => {
    window.history.pushState({}, '', `/messages?agent=${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, recipient);
  await expect(contact).toHaveValue(recipient);
  await expect(page.getByText('这个 Agent 暂不可联系，请选择其他联系对象。', { exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: '发起身份', exact: true }).selectOption(ownAgent);
  await page.evaluate((id) => {
    window.history.pushState({}, '', `/messages?agent=${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, ownAgent);
  await expect(contact).toHaveValue(ownAgent);
  await expect(page.getByRole('combobox', { name: '发起身份', exact: true })).toHaveValue('');
  expect(writes).toHaveLength(0);
});

test('小镇访客入口预选对象，以本人身份私聊并发送消息', async ({ page }) => {
  const writes = await mockMessages(page);
  await page.goto(`/messages?user=${visitorId}`);
  await expect(page.getByRole('combobox', { name: '联系类型', exact: true })).toHaveValue('user');
  await expect(page.getByRole('combobox', { name: '联系访客', exact: true })).toHaveValue(visitorId);
  await expect(page.getByRole('combobox', { name: '发起身份', exact: true })).toHaveValue('');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '打开私聊', exact: true }).click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  await expect(page.getByRole('heading', { name: '开发者 ↔ 小镇邻居', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '发送身份', exact: true })).toHaveValue('');
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill('你好，刚刚在小镇遇见你。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('你好，刚刚在小镇遇见你。', { exact: true })).toBeVisible();
  expect(writes.map(write => ({ path: write.path, body: write.body }))).toEqual([
    { path: '/conversations', body: { recipient_user_id: visitorId } },
    { path: `/conversations/${conversationId}/messages`, body: { body: '你好，刚刚在小镇遇见你。' } },
  ]);
});

test('代表 Agent 联系访客并以 Agent 身份发送消息', async ({ page }) => {
  const writes = await mockMessages(page);
  await page.goto(`/messages?user=${visitorId}`);
  await page.getByRole('combobox', { name: '发起身份', exact: true }).selectOption(ownAgent);
  await page.getByRole('button', { name: '打开私聊', exact: true }).click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  await expect(page.getByRole('combobox', { name: '发送身份', exact: true })).toHaveValue(ownAgent);
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill('我是开发 Agent，可以一起讨论项目。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('我是开发 Agent，可以一起讨论项目。', { exact: true })).toBeVisible();
  expect(writes[0]!.body).toEqual({ recipient_user_id: visitorId, sender_agent_id: ownAgent });
  expect(writes[1]!.body).toEqual({ body: '我是开发 Agent，可以一起讨论项目。', sender_agent_id: ownAgent });
});

test('本人不能与自己私聊，但可以代表 Agent 联系主人', async ({ page }) => {
  const writes = await mockMessages(page);
  await page.goto(`/messages?user=${userId}`);
  const sender = page.getByRole('combobox', { name: '发起身份', exact: true });
  const contact = page.getByRole('combobox', { name: '联系访客', exact: true });
  const open = page.getByRole('button', { name: '打开私聊', exact: true });
  await expect(contact).toHaveValue('');
  await expect(open).toBeDisabled();
  await sender.selectOption(ownAgent);
  await expect(contact).toHaveValue(userId);
  await expect(open).toBeEnabled();
  await sender.selectOption('');
  await expect(contact).toHaveValue('');
  await expect(open).toBeDisabled();
  await sender.selectOption(ownAgent);
  await contact.selectOption(userId);
  await open.click();
  await expect(page).toHaveURL(`/messages/${conversationId}`);
  expect(writes[0]!.body).toEqual({ recipient_user_id: userId, sender_agent_id: ownAgent });
});

test('不可联系访客不能打开会话，切换联系人类型后清空旧选择', async ({ page }) => {
  const writes = await mockMessages(page);
  await page.goto('/messages?user=unavailable-visitor');
  await expect(page.getByText('这位访客暂不可联系，请选择其他联系对象。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开私聊', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: '联系访客', exact: true }).selectOption(visitorId);
  await page.getByRole('combobox', { name: '联系类型', exact: true }).selectOption('agent');
  await expect(page.getByRole('combobox', { name: '联系 Agent', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '打开私聊', exact: true })).toBeDisabled();
  expect(writes).toHaveLength(0);
});
