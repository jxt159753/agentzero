import { expect, test, type Page } from '@playwright/test';
import type { ConversationDto } from '../../packages/contracts/src/messages.js';

const userId = '11000000-0000-4000-8000-000000000001';
const visitorId = '11000000-0000-4000-8000-000000000002';
const agentId = '44000000-0000-4000-8000-000000000001';
const groupId = '55000000-0000-4000-8000-000000000001';
const createdAt = '2026-11-07T08:00:00.000Z';

async function mockGroup(page: Page) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const group: ConversationDto = { id: groupId, kind: 'group', task_id: null, title: '测试群', created_at: createdAt, members: [
    { id: 'agent-member', user_id: null, agent_id: agentId, owner_user_id: userId, name: '开发 Agent', role: 'owner' },
    { id: 'visitor-member', user_id: visitorId, agent_id: null, owner_user_id: visitorId, name: '小镇邻居', role: 'member' },
  ] };
  await page.context().addCookies([{ name: 'az_csrf', value: 'csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const body = request.method() === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    if (request.method() !== 'GET') writes.push({ path, body });
    let result: unknown;
    if (path === '/me') result = { actor: { type: 'user', userId }, user: { id: userId, display_name: '开发者', github_login: 'developer', status: 'active', role: 'member' } };
    else if (path === '/agents') result = { items: [{ id: agentId, owner_user_id: userId, name: '开发 Agent', status: 'active' }], next_cursor: null };
    else if (path === '/message-recipients') result = { items: [{ id: agentId, name: '开发 Agent', owner_user_id: userId, owner_name: '开发者' }], users: [{ id: visitorId, name: '小镇邻居', github_login: 'neighbor' }] };
    else if (path === '/conversations') result = { items: [group], next_cursor: null };
    else if (path === '/conversations/groups') result = group;
    else if (path === `/conversations/${groupId}/members`) {
      group.members.push({ id: 'self-member', user_id: userId, agent_id: null, owner_user_id: userId, name: '开发者', role: 'member' });
      result = group;
    } else if (path === `/conversations/${groupId}`) result = group;
    else if (path === `/conversations/${groupId}/messages`) result = { items: [], next_cursor: '0', has_more: false };
    else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND' } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  return writes;
}

test('建群时仅以 Agent 为群主可邀请本人，切换群主身份后清除本人', async ({ page }) => {
  const writes = await mockGroup(page);
  await page.goto('/messages');
  await page.getByRole('button', { name: '创建群聊', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建群聊' });
  await expect(dialog.getByRole('checkbox', { name: /开发者（我本人）/ })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: '群主身份' }).selectOption(agentId);
  const self = dialog.getByRole('checkbox', { name: /开发者（我本人）/ });
  await self.check();
  await dialog.getByRole('combobox', { name: '群主身份' }).selectOption('');
  await expect(self).toHaveCount(0);
  await expect(dialog.getByText('已选 0 位受邀成员', { exact: false })).toBeVisible();
  await dialog.getByRole('combobox', { name: '群主身份' }).selectOption(agentId);
  await expect(self).not.toBeChecked();
  await self.check();
  await dialog.getByRole('textbox', { name: '群聊名称' }).fill('测试群');
  await dialog.getByRole('button', { name: '创建群聊', exact: true }).click();
  await expect(page).toHaveURL(`/messages/${groupId}`);
  expect(writes[0]).toEqual({ path: '/conversations/groups', body: { title: '测试群', sender_agent_id: agentId, member_user_ids: [userId] } });
});

test('代表群主 Agent 管理群聊时可以邀请尚未加入的本人', async ({ page }) => {
  const writes = await mockGroup(page);
  await page.goto(`/messages/${groupId}`);
  await page.getByRole('button', { name: '群成员与管理', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '群成员与管理' });
  await dialog.getByRole('combobox', { name: '操作身份' }).selectOption(agentId);
  await dialog.getByRole('combobox', { name: '邀请类型' }).selectOption('user');
  await dialog.getByRole('combobox', { name: '邀请对象' }).selectOption(userId);
  await dialog.getByRole('button', { name: '邀请加入' }).click();
  await expect(dialog.getByText('开发者', { exact: true })).toBeVisible();
  expect(writes[0]).toEqual({ path: `/conversations/${groupId}/members`, body: { sender_agent_id: agentId, member_user_ids: [userId] } });
  await expect(dialog.getByRole('option', { name: /开发者（我本人）/ })).toHaveCount(0);
});
