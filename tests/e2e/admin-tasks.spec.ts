import { expect, test, type Page } from '@playwright/test';
import type { TaskDto } from '../../packages/contracts/src/tasks.js';

const adminId = '11000000-0000-4000-8000-000000000001', publisherId = '11000000-0000-4000-8000-000000000002';
const taskId = '22000000-0000-4000-8000-000000000001', agentId = '33000000-0000-4000-8000-000000000001';
const holdId = '44000000-0000-4000-8000-000000000001', operationId = '55000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-10T10:00:00.000Z';

async function mockAdminTasks(page: Page, state: 'open' | 'in_progress' = 'open', conflict = false) {
  let task: TaskDto = { id: taskId, title: '待管理员处理的任务', description: '必须保留的原合同说明', acceptance_criteria: '必须保留的验收条件',
    repository_id: null, issue_number: null, required_checks: [], reward_points: '100', deadline_at: '2099-11-10T10:00:00.000Z',
    publisher_user_id: publisherId, publisher_agent_id: null, payer_agent_id: null, reviewer_user_id: publisherId,
    assignee_agent_id: state === 'open' ? null : agentId, assignee_name: state === 'open' ? null : '执行 Agent',
    publisher_name: '任务发布者', reviewer_name: '任务发布者', status: state, version: '3', disputed: false, dispute_reason: null,
    hold_id: holdId, latest_delivery_id: null, review_due_at: null, review_reminded_at: null, settled_journal_id: null,
    created_at: timestamp, updated_at: timestamp, published_at: timestamp, accepted_at: state === 'open' ? null : timestamp, finalized_at: null,
    hold: { id: holdId, status: 'open', reserved_total: '100', captured_total: '0', released_total: '0', remaining: '100' },
    deliveries: [], reviews: [], cancellation_proposals: [], events: [] };
  const writes: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [], listQueries: string[] = [];
  const detail = () => ({ ...task, permissions: { edit: false, publish: false, accept: false, submit: false, review: false,
    cancel: false, propose_cancel: false, dispute: false, resolve: !conflict && task.disputed,
    admin_cancel: !conflict && task.status === 'open', admin_intervene: !conflict && task.status === 'in_progress' && !task.disputed } });
  await page.context().addCookies([{ name: 'az_csrf', value: 'admin-tasks-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', ''), method = request.method();
    const body = method === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    const respond = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (method !== 'GET') writes.push({ path, body, headers: request.headers() });
    if (path === '/me') return respond({ actor: { type: 'user', userId: adminId }, user: { id: adminId, display_name: '管理员', github_login: 'admin', role: 'admin', status: 'active' } });
    if (path === '/admin/users' || path === '/agents') return respond({ items: [], next_cursor: null });
    if (path === '/admin/tasks') { listQueries.push(url.search); return respond({ items: [task], next_cursor: null }); }
    if (path === `/tasks/${taskId}` && method === 'GET') return respond(detail());
    if (path === `/admin/tasks/${taskId}/intervene`) {
      task = { ...task, version: '4', disputed: true, dispute_reason: String(body.reason), events: [{ id: 'event-intervened', task_id: taskId,
        kind: 'admin_intervened', actor_type: 'user', actor_user_id: adminId, actor_agent_id: null, created_at: timestamp, details: { reason: body.reason } }] };
      return respond({ ...detail(), operation_id: operationId });
    }
    if (path === `/admin/tasks/${taskId}/cancel` || path === `/admin/tasks/${taskId}/resolve`) {
      task = { ...task, version: '5', status: 'cancelled', disputed: false, dispute_reason: null, finalized_at: timestamp,
        settled_journal_id: operationId, hold: { ...task.hold!, status: 'closed', remaining: '0', released_total: '100' } };
      return respond({ ...detail(), operation_id: operationId });
    }
    return respond({ error: { code: 'NOT_FOUND' } }, 404);
  });
  return { writes, listQueries };
}

test('管理员从管理列表筛选任务并跳转原合同详情', async ({ page }) => {
  const { listQueries } = await mockAdminTasks(page, 'in_progress');
  await page.goto('/operations');
  await page.getByRole('tab', { name: '任务管理', exact: true }).click();
  await page.getByLabel('管理任务状态').selectOption('in_progress');
  await page.getByLabel('仅看争议任务').check();
  await expect.poll(() => listQueries.some(query => query.includes('status=in_progress') && query.includes('disputed=true'))).toBe(true);
  await page.getByRole('link', { name: /待管理员处理的任务/ }).click();
  await expect(page.getByRole('heading', { name: '任务合同', exact: true })).toBeVisible();
  await expect(page.getByText('必须保留的原合同说明', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '编辑任务' })).toHaveCount(0);
});

test('管理员关闭未接单任务前明确全额退款并提交理由和原版本', async ({ page }) => {
  const { writes } = await mockAdminTasks(page);
  await page.goto(`/tasks/${taskId}`);
  const submit = page.getByRole('button', { name: '管理员关闭任务并退款', exact: true });
  await expect(submit).toBeDisabled();
  await expect(page.getByText('此任务尚未接单。关闭后将 100 积分全部退回原付款来源，并保留合同与处理记录。')).toBeVisible();
  await page.getByLabel('管理员处理理由').fill('重复供应，关闭未接单任务');
  await expect(submit).toBeDisabled();
  await page.getByLabel('已核对当前状态，确认关闭任务并全额退款。').check();
  await submit.click();
  await expect(page.getByTestId('task-held-points')).toHaveText('0 积分');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ path: `/admin/tasks/${taskId}/cancel`, body: { version: '3', reason: '重复供应，关闭未接单任务' } });
  expect(writes[0]!.headers['x-csrf-token']).toBe('admin-tasks-csrf');
  expect(writes[0]!.headers['idempotency-key']).toBeTruthy();
  await expect(page.getByText('必须保留的验收条件', { exact: true })).toBeVisible();
});

test('管理员介入后保持冻结并显示既有争议裁定入口', async ({ page }) => {
  const { writes } = await mockAdminTasks(page, 'in_progress');
  await page.goto(`/tasks/${taskId}`);
  await page.getByLabel('管理员处理理由').fill('核查履约投诉');
  await page.getByLabel('已核对任务记录，确认介入并保持奖金冻结。').check();
  await page.getByRole('button', { name: '管理员介入任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理员裁定', exact: true })).toBeVisible();
  await expect(page.getByTestId('task-held-points')).toHaveText('100 积分');
  await expect(page.getByText('管理员介入并保持冻结', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ path: `/admin/tasks/${taskId}/intervene`, body: { version: '3', reason: '核查履约投诉' } });
  await expect(page.getByRole('button', { name: '管理员介入任务', exact: true })).toHaveCount(0);
});

test('管理员参与承接的任务不显示介入或裁定操作', async ({ page }) => {
  await mockAdminTasks(page, 'in_progress', true);
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: '任务合同', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '管理员处理', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '管理员裁定', exact: true })).toHaveCount(0);
});
