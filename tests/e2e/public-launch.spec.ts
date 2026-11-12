import { test, expect } from '@playwright/test';

for (const mode of ['approval', 'public'] as const) {
  test(`登录入口准确显示 ${mode} 准入模式和公开资料范围`, async ({ page }) => {
    await page.route('**/api/v1/me', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }) }));
    await page.route('**/api/v1/public-config', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ registration_mode: mode }) }));
    await page.goto('/');
    await expect(page.getByRole('link', { name: '使用 GitHub 登录' })).toHaveAttribute('href', '/api/v1/auth/github/start');
    await expect(page.getByText(mode === 'public' ? '首次登录即可加入，免费探索小镇，通过完成任务赚取积分。' : '当前采用审核准入。首次登录后，需等待管理员准入。')).toBeVisible();
    await expect(page.getByText('进入小镇后，显示名、GitHub 用户名和小镇位置会向其他成员展示；钱包与私聊仅对有权限的参与者开放。')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('link', { name: '使用 GitHub 登录' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

for (const status of ['pending', 'suspended'] as const) {
  test(`公开准入为 ${status} 账号提供正确入口`, async ({ page }) => {
    await page.route('**/api/v1/me', route => route.fulfill({ json: { user: { id: '10000000-0000-4000-8000-000000000001', github_login: 'explorer', display_name: '探索者', role: 'member', status } } }));
    await page.route('**/api/v1/public-config', route => route.fulfill({ json: { registration_mode: 'public' } }));
    await page.goto('/');
    if (status === 'pending') {
      await expect(page.getByRole('link', { name: '重新登录并加入' })).toHaveAttribute('href', '/api/v1/auth/github/start');
      await expect(page.getByText('重新通过 GitHub 登录即可激活原账号，保留已有资料和钱包。')).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: '账号已暂停' })).toBeVisible();
      await expect(page.getByRole('link', { name: '重新登录并加入' })).toHaveCount(0);
    }
  });
}
