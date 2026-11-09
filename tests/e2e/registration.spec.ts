import { test, expect, type Page, type Route } from '@playwright/test';

const id = '30000000-0000-4000-8000-000000000007';
const agentId = '20000000-0000-4000-8000-000000000007';
const code = 'r'.repeat(43);
const link = `/connect?request=${id}#code=${code}`;
const user = { id: '10000000-0000-4000-8000-000000000007', github_login: 'explorer', display_name: '探索者', status: 'active', role: 'member' };
const reply = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockRegistration(page: Page, options: { loggedIn?: boolean; expired?: boolean } = {}) {
  let loggedIn = options.loggedIn ?? true;
  let approved = false;
  const writes: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  await page.context().addCookies([{ name: 'az_csrf', value: 'registration-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/me') return reply(route, loggedIn ? { actor: { type: 'user', userId: user.id }, user } : { error: { code: 'UNAUTHENTICATED' } }, loggedIn ? 200 : 401);
    if (path === '/agents') return reply(route, { items: [{ id: agentId, owner_user_id: user.id, name: '已有工作伙伴', status: 'active' }], next_cursor: null });
    if (path === `/agent-registrations/${id}/approve`) {
      writes.push({ body: request.postDataJSON() as Record<string, unknown>, headers: request.headers() });
      approved = true;
      return reply(route, { id, status: 'approved', agent_id: agentId, operation_id: '40000000-0000-4000-8000-000000000007' });
    }
    if (path === `/agent-registrations/${id}`) {
      expect(url.searchParams.get('code')).toBe(code);
      if (options.expired) return reply(route, { error: { code: 'REGISTRATION_EXPIRED' } }, 410);
      return reply(route, { id, client: 'codex', name: '我的 Codex', expires_at: '2099-11-07T08:00:00Z', status: approved ? 'approved' : 'pending', ...(approved ? { agent_id: agentId } : {}) });
    }
    return reply(route, { error: { code: 'ACCESS_DENIED' } }, 403);
  });
  return { writes, signIn: () => { loggedIn = true; } };
}

test('注册确认经 GitHub 登录返回后保留，用户确认前不写入', async ({ page }) => {
  const state = await mockRegistration(page, { loggedIn: false });
  await page.goto(link);
  await expect(page.getByRole('link', { name: '使用 GitHub 登录' })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  state.signIn();
  // Existing OAuth callback returns to the root; only this tab's saved registration is resumed.
  await page.goto('/');
  await expect(page).toHaveURL(link);
  await expect(page.getByRole('heading', { name: '将 Codex 注册为 Agent' })).toBeVisible();
  await expect(page.getByRole('main').getByText('@explorer', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await page.getByLabel('Agent 名称', { exact: true }).fill('新工作伙伴');
  await page.getByRole('button', { name: '确认注册并连接' }).click();
  await expect(page.getByRole('heading', { name: '已确认注册' })).toBeVisible();
  await expect(page.getByRole('link', { name: '查看 Agent 与权限' })).toHaveAttribute('href', `/agents/${agentId}`);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body).toEqual({ verification_code: code, name: '新工作伙伴' });
  expect(state.writes[0].headers['x-csrf-token']).toBe('registration-csrf');
  expect(state.writes[0].headers['idempotency-key']).toMatch(/^[a-f\d-]{36}$/);
  expect(await page.evaluate(() => sessionStorage.getItem('agentzero.registration-return'))).toBeNull();
  await expect(page.getByLabel('完整访问凭证')).toHaveCount(0);
});

test('可直接连接已有 Agent，不要求复制凭证', async ({ page }) => {
  const { writes } = await mockRegistration(page);
  await page.goto(link);
  await page.getByLabel('注册方式').selectOption('existing');
  await page.getByLabel('选择你的 Agent').selectOption(agentId);
  await page.getByRole('button', { name: '确认注册并连接' }).click();
  await expect(page.getByText('无需复制或发送访问凭证。')).toBeVisible();
  expect(writes[0].body).toEqual({ verification_code: code, agent_id: agentId });
});

test('过期或不完整的注册链接不显示批准按钮', async ({ page }) => {
  const { writes } = await mockRegistration(page, { expired: true });
  await page.goto(link);
  await expect(page.getByRole('alert')).toContainText('注册链接已过期');
  await expect(page.getByRole('button', { name: '确认注册并连接' })).toHaveCount(0);
  await page.goto(`/connect?request=${id}`);
  await expect(page.getByRole('heading', { name: '注册链接不完整' })).toBeVisible();
  expect(writes).toHaveLength(0);
});

test('我的 Agent 提供当前平台的直接注册指令，窄屏可用', async ({ page }) => {
  await mockRegistration(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: '直接接入 Codex / DSH' })).toBeVisible();
  await expect(page.getByLabel('发送给客户端')).toHaveValue('把你注册为我的 Agent，平台地址是 http://localhost:5173');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
