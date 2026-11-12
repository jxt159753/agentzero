import { test, expect, type Page, type Route } from '@playwright/test';
import type { TaskDto } from '../../packages/contracts/src/tasks.js';

// These tests exercise browser contracts. PostgreSQL and GitHub behavior are tested separately.
const publisherId = '11000000-0000-4000-8000-000000000001';
const reviewerId = '11000000-0000-4000-8000-000000000002';
const ownerId = '11000000-0000-4000-8000-000000000003';
const taskId = '22000000-0000-4000-8000-000000000001';
const repositoryId = '33000000-0000-4000-8000-000000000001';
const agentId = '44000000-0000-4000-8000-000000000001';
const holdId = '55000000-0000-4000-8000-000000000001';
const operationId = '66000000-0000-4000-8000-000000000001';
const deliveryId = '77000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(40);
const timestamp = '2026-11-07T08:00:00.000Z';
const repository = { id: repositoryId, github_id: '12345', installation_id: '54321', owner: 'example', name: 'agent-project', full_name: 'example/agent-project', is_private: false, status: 'approved', created_at: timestamp, updated_at: timestamp };
const permissions = { edit: false, publish: false, accept: false, submit: false, review: false, cancel: false, propose_cancel: false, dispute: false, resolve: false };
const initialTask: TaskDto = {
  id: taskId, title: '完善仓库测试与使用说明', description: '补全主要功能的测试，并说明本地验证步骤。', repository_id: repositoryId, issue_number: 42,
  acceptance_criteria: '测试覆盖主要功能，README 说明可复现。', required_checks: ['test', 'build'], reward_points: '100', deadline_at: '2099-11-14T10:00:00.000Z',
  publisher_user_id: publisherId, publisher_agent_id: null, payer_agent_id: null, reviewer_user_id: reviewerId, assignee_agent_id: null,
  status: 'open', version: '2', disputed: false, dispute_reason: null, hold_id: holdId, latest_delivery_id: null,
  review_due_at: null, review_reminded_at: null, settled_journal_id: null, created_at: timestamp, updated_at: timestamp, published_at: timestamp, accepted_at: null, finalized_at: null,
  publisher_name: '发布者', reviewer_name: '独立验收人', assignee_name: null, repository_name: repository.full_name,
  repository: { id: repositoryId, full_name: repository.full_name, status: 'approved', installation_status: 'active' },
  hold: { id: holdId, status: 'open', reserved_total: '100', captured_total: '0', released_total: '0', remaining: '100' },
  deliveries: [], reviews: [], cancellation_proposals: [], events: [{ id: 'event-1', task_id: taskId, kind: 'published', actor_type: 'user', actor_user_id: publisherId, actor_agent_id: null, details: {}, created_at: timestamp }],
};

const respond = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockTasks(page: Page, role: 'publisher' | 'assignee' | 'reviewer' = 'publisher', start: Partial<TaskDto> = {}) {
  let task = { ...structuredClone(initialTask), ...start };
  let repositories = [repository];
  const writes: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const userId = role === 'publisher' ? publisherId : role === 'reviewer' ? reviewerId : ownerId;
  function detail() {
    return { ...task, permissions: { ...permissions,
      edit: role === 'publisher' && ['draft', 'open'].includes(task.status), publish: role === 'publisher' && task.status === 'draft',
      accept: role === 'assignee' && task.status === 'open', submit: role === 'assignee' && ['in_progress', 'changes_requested'].includes(task.status),
      review: userId === task.reviewer_user_id && task.status === 'submitted', cancel: role === 'publisher' && task.status === 'open',
      propose_cancel: role !== 'reviewer' && ['in_progress', 'submitted', 'changes_requested'].includes(task.status),
      dispute: role !== 'reviewer' && ['in_progress', 'submitted', 'changes_requested'].includes(task.status) && !task.disputed,
    } };
  }
  function update(fields: Partial<TaskDto>) { task = { ...task, ...fields, version: (BigInt(task.version) + 1n).toString() }; }
  await page.context().addCookies([{ name: 'az_csrf', value: 'task-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const body = method === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    if (method !== 'GET') writes.push({ path, body, headers: request.headers() });
    if (path === '/me') return respond(route, { actor: { type: 'user', userId }, user: { id: userId, display_name: role === 'publisher' ? '发布者' : '工作成员', github_login: role, status: 'active', role: role === 'publisher' ? 'admin' : 'member' } });
    if (path === '/agents') return respond(route, { items: [{ id: agentId, owner_user_id: userId, name: '开发 Agent', status: 'active', created_at: timestamp }], next_cursor: null });
    if (path === '/task-reviewers') return respond(route, { items: [{ id: reviewerId, display_name: '独立验收人', github_login: 'reviewer' }] });
    if (path === '/repositories') return respond(route, { items: repositories });
    if (path === '/admin/users') return respond(route, { items: [], next_cursor: null });
    if (path === '/admin/github/installations') return respond(route, { items: [{ installation_id: '54321', account_login: 'example', status: 'active', updated_at: timestamp }], operation_id: method === 'POST' ? operationId : undefined });
    if (path === '/admin/repositories' && method === 'POST') { repositories = [{ ...repository, owner: String(body.owner), name: String(body.name), full_name: `${body.owner}/${body.name}` }]; return respond(route, { ...repositories[0], operation_id: operationId }, 201); }
    if (path === `/admin/repositories/${repositoryId}`) { repositories = repositories.map((item) => ({ ...item, status: String(body.status) })); return respond(route, { ...repositories[0], operation_id: operationId }); }
    if (path === '/tasks' && method === 'GET') return respond(route, { items: [detail()], next_cursor: null });
    if (path === '/tasks' && method === 'POST') {
      task = { ...task, ...body as Partial<TaskDto>, id: taskId, status: 'draft', version: '1', hold_id: null, hold: null, events: [] };
      if (!task.repository_id) task = { ...task, repository: null, repository_name: null, reviewer_name: '发布者' };
      return respond(route, { ...detail(), operation_id: operationId }, 201);
    }
    if (path === `/tasks/${taskId}` && method === 'GET') return respond(route, detail());
    if (path === `/tasks/${taskId}/publish`) { update({ status: 'open', hold_id: holdId, hold: { id: holdId, status: 'open', reserved_total: task.reward_points, captured_total: '0', released_total: '0', remaining: task.reward_points } }); return respond(route, { ...detail(), operation_id: operationId }); }
    if (path === `/tasks/${taskId}/accept`) { update({ status: 'in_progress', assignee_agent_id: agentId, assignee_name: '开发 Agent', accepted_at: timestamp }); return respond(route, { ...detail(), operation_id: operationId }); }
    if (path === `/tasks/${taskId}/deliveries`) {
      const delivery = { id: deliveryId, task_id: taskId, agent_id: agentId, created_at: timestamp, ...(task.repository_id
        ? { pr_number: Number(body.pr_number), head_sha: String(body.head_sha), pr_url: `https://github.com/example/agent-project/pull/${body.pr_number}`, evidence: { merged: true, fetchedAt: timestamp, checks: [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'build', status: 'completed', conclusion: 'success' }] } }
        : { pr_number: null, head_sha: null, pr_url: null, content: String(body.content), evidence: {} }) };
      update({ status: 'submitted', deliveries: [delivery], latest_delivery_id: deliveryId, review_due_at: '2099-11-17T10:00:00.000Z' });
      return respond(route, { ...detail(), operation_id: operationId });
    }
    if (path === `/tasks/${taskId}/reviews`) {
      update({ status: body.decision === 'accept' ? 'settled' : 'changes_requested', ...(body.decision === 'accept' ? { hold: { ...task.hold!, status: 'closed', remaining: '0', captured_total: task.reward_points }, settled_journal_id: operationId } : {}), reviews: [{ id: 'review-1', task_id: taskId, delivery_id: deliveryId, reviewer_user_id: reviewerId, decision: String(body.decision), reason: String(body.reason), unmet_criteria: body.unmet_criteria ? String(body.unmet_criteria) : null, created_at: timestamp }] });
      return respond(route, { ...detail(), operation_id: operationId });
    }
    if (path === `/tasks/${taskId}/cancellation-proposals`) { update({ cancellation_proposals: [{ id: 'proposal-1', task_id: taskId, payment_points: String(body.payment_points), refund_points: String(body.refund_points), reason: String(body.reason), status: 'pending', publisher_accepted: role === 'publisher', assignee_accepted: role === 'assignee', can_accept: false, created_at: timestamp }] }); return respond(route, { ...detail(), operation_id: operationId }); }
    return respond(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  return { writes };
}

test('创建任务草稿保留大整数金额，确认发布后显示冻结与业务编号', { tag: '@smoke' }, async ({ page }) => {
  const { writes } = await mockTasks(page);
  await page.goto('/tasks');
  await page.getByRole('link', { name: '+ 创建任务' }).click();
  await page.getByRole('combobox', { name: '任务类型', exact: true }).selectOption('github');
  await page.getByLabel('任务标题').fill('测试大整数任务奖励');
  await page.getByLabel('任务目标与说明').fill('验证真实交付后完整结算。');
  await page.getByLabel('获准仓库').selectOption(repositoryId);
  await page.getByLabel('验收条件', { exact: true }).fill('所有指定检查通过，文档可复现。');
  await page.getByLabel('要求的 GitHub 检查项').fill('test\nbuild');
  await page.getByLabel('固定奖金', { exact: true }).fill('9007199254740993');
  await page.getByLabel('截止时间（北京时间）').fill('2099-11-14T18:00');
  await page.getByLabel('奖金来源').selectOption('platform');
  await page.getByRole('combobox', { name: '指定验收人', exact: true }).selectOption(reviewerId);
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskId}`);
  await expect(page.getByTestId('task-held-points')).toHaveText('0 积分');
  await expect(page.getByRole('button', { name: '发布并冻结奖金' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /已核对合同/ }).check();
  await page.getByRole('button', { name: '发布并冻结奖金' }).click();
  await expect(page.getByTestId('task-held-points')).toHaveText('9,007,199,254,740,993 积分');
  await expect(page.getByRole('status')).toContainText(operationId);
  const create = writes.find((write) => write.path === '/tasks')!;
  expect(create.body).toMatchObject({ reward_points: '9007199254740993', deadline_at: '2099-11-14T10:00:00.000Z', required_checks: ['test', 'build'], issue_number: null, payer_agent_id: null });
  for (const write of writes) {
    expect(write.headers['x-csrf-token']).toBe('task-csrf');
    expect(write.headers['idempotency-key']).toMatch(/^[a-f\d-]{36}$/);
  }
  await page.screenshot({ path: 'test-results/task-published-desktop.png', fullPage: true });
});

test('默认纯文字任务无需仓库和额外验收条件即可发布', async ({ page }) => {
  const { writes } = await mockTasks(page);
  let githubOptionRequests = 0;
  await page.route(/\/api\/v1\/(repositories|task-reviewers)$/, async (route) => {
    githubOptionRequests++;
    return respond(route, { items: [] });
  });
  await page.goto('/tasks/new');
  await expect(page.getByRole('combobox', { name: '任务类型', exact: true })).toHaveValue('text');
  await expect(page.getByLabel('获准仓库')).toHaveCount(0);
  await expect(page.getByLabel('指定验收人', { exact: true })).toHaveCount(0);
  await page.getByLabel('任务标题').fill('整理活动安排');
  await page.getByLabel('任务目标与说明').fill('给出三天活动的文字安排。');
  await page.getByLabel('固定奖金', { exact: true }).fill('100');
  await page.getByLabel('截止时间（北京时间）').fill('2099-11-14T18:00');
  await page.getByLabel('奖金来源').selectOption('platform');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskId}`);
  await expect(page.getByText('纯文字任务', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /已核对合同/ }).check();
  await page.getByRole('button', { name: '发布并冻结奖金' }).click();
  await expect(page.getByText('待接单', { exact: true })).toBeVisible();
  expect(writes.find((write) => write.path === '/tasks')?.body).toMatchObject({
    repository_id: null, issue_number: null, required_checks: [], reviewer_user_id: publisherId,
    description: '给出三天活动的文字安排。', acceptance_criteria: '给出三天活动的文字安排。',
  });
  expect(githubOptionRequests).toBe(0);
});

test('纯文字任务提交成果后展示文字内容并等待审核', async ({ page }) => {
  const { writes } = await mockTasks(page, 'assignee', {
    repository_id: null, repository_name: null, repository: null, issue_number: null,
    required_checks: [], reviewer_user_id: publisherId, reviewer_name: '发布者',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('combobox', { name: '承接 Agent', exact: true }).selectOption(agentId);
  await page.getByRole('button', { name: '确认接单' }).click();
  await expect(page.getByLabel('PR 编号', { exact: true })).toHaveCount(0);
  await page.getByLabel('交付内容', { exact: true }).fill('第一天：需求讨论\n第二天：现场活动\n第三天：总结交流');
  await page.getByRole('button', { name: '提交成果', exact: true }).click();
  await expect(page.getByText('待验收', { exact: true })).toBeVisible();
  await expect(page.getByText('第一天：需求讨论\n第二天：现场活动\n第三天：总结交流', { exact: true })).toBeVisible();
  await expect(page.getByTestId('task-held-points')).toHaveText('100 积分');
  expect(writes.find((write) => write.path.endsWith('/deliveries'))?.body).toEqual({ version: '3', content: '第一天：需求讨论\n第二天：现场活动\n第三天：总结交流' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('纯文字任务由发布者审核通过后完成结算', async ({ page }) => {
  const { writes } = await mockTasks(page, 'publisher', {
    repository_id: null, repository_name: null, repository: null, issue_number: null, required_checks: [],
    reviewer_user_id: publisherId, reviewer_name: '发布者', status: 'submitted', assignee_agent_id: agentId,
    deliveries: [{ id: deliveryId, task_id: taskId, agent_id: agentId, pr_number: null, head_sha: null, pr_url: null, content: '活动安排已完成。', evidence: {}, created_at: timestamp }],
  });
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText('活动安排已完成。', { exact: true })).toBeVisible();
  await expect(page.getByText(/通过前核验 PR/)).toHaveCount(0);
  await page.getByLabel('验收说明', { exact: true }).fill('安排符合任务说明，审核通过。');
  await page.getByRole('checkbox', { name: /已核对成果/ }).check();
  await page.getByRole('button', { name: '验收通过并结算' }).click();
  await expect(page.getByText('已结算', { exact: true })).toBeVisible();
  await expect(page.getByTestId('task-held-points')).toHaveText('0 积分');
  expect(writes.find((write) => write.path.endsWith('/reviews'))?.body).toMatchObject({ version: '2', decision: 'accept', reason: '安排符合任务说明，审核通过。' });
});

test('Agent 接单提交完整 PR 版本，窄屏显示核验记录与冻结状态', { tag: '@smoke' }, async ({ page }) => {
  const { writes } = await mockTasks(page, 'assignee');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('combobox', { name: '承接 Agent', exact: true }).selectOption(agentId);
  await page.getByRole('button', { name: '确认接单' }).click();
  await page.getByLabel('PR 编号', { exact: true }).fill('56');
  await page.getByLabel('完整提交 SHA').fill(sha);
  await page.getByRole('button', { name: '核验并提交成果' }).click();
  await expect(page.getByRole('link', { name: 'PR #56' })).toBeVisible();
  await expect(page.getByText(sha, { exact: true })).toBeVisible();
  await expect(page.getByText('test · 通过', { exact: true })).toBeVisible();
  await expect(page.getByTestId('task-held-points')).toHaveText('100 积分');
  expect(writes.find((write) => write.path.endsWith('/deliveries'))?.body).toMatchObject({ version: '3', pr_number: 56, head_sha: sha });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/task-submitted-mobile.png', fullPage: true });
});

test('指定验收人遇到检查未通过时保留奖金，成功后显示唯一结算结果', { tag: '@smoke' }, async ({ page }) => {
  const { writes } = await mockTasks(page, 'reviewer', { status: 'submitted', assignee_agent_id: agentId, assignee_name: '开发 Agent' });
  let rejected = false;
  await page.route(`**/api/v1/tasks/${taskId}/reviews`, async (route) => {
    if (!rejected) { rejected = true; return respond(route, { error: { code: 'PR_CHECKS_PENDING', request_id: 'pending-checks' } }, 409); }
    return route.fallback();
  });
  await page.goto(`/tasks/${taskId}`);
  await page.getByLabel('验收说明', { exact: true }).fill('验收条件全部满足。');
  await page.getByRole('checkbox', { name: /已核对成果/ }).check();
  await page.getByRole('button', { name: '验收通过并结算' }).click();
  await expect(page.getByRole('alert')).toContainText('检查尚未全部通过');
  await expect(page.getByTestId('task-held-points')).toHaveText('100 积分');
  await page.getByRole('button', { name: '验收通过并结算' }).click();
  await expect(page.getByText('已结算', { exact: true })).toBeVisible();
  await expect(page.getByTestId('task-held-points')).toHaveText('0 积分');
  await expect(page.getByRole('button', { name: '验收通过并结算' })).toHaveCount(0);
  expect(writes.find((write) => write.path.endsWith('/reviews'))?.body).toMatchObject({ version: '2', decision: 'accept', reason: '验收条件全部满足。' });
});

test('接单后取消方案要求金额守恒并呈现双方确认状态', async ({ page }) => {
  const { writes } = await mockTasks(page, 'publisher', { status: 'in_progress', assignee_agent_id: agentId, assignee_name: '开发 Agent' });
  await page.goto(`/tasks/${taskId}`);
  await page.getByLabel('支付承接 Agent', { exact: true }).fill('30');
  await page.getByLabel('取消理由', { exact: true }).fill('部分工作已交付，双方协商终止。');
  await expect(page.getByRole('button', { name: '提出取消方案' })).toBeDisabled();
  await page.getByLabel('退回发布者', { exact: true }).fill('70');
  await page.getByRole('button', { name: '提出取消方案' }).click();
  await expect(page.getByText('待双方确认', { exact: true })).toBeVisible();
  await expect(page.getByText('发布者：已接受 · 承接方：未接受', { exact: true })).toBeVisible();
  await expect(page.getByTestId('task-held-points')).toHaveText('100 积分');
  expect(writes.find((write) => write.path.endsWith('/cancellation-proposals'))?.body).toMatchObject({ payment_points: '30', refund_points: '70' });
});

test('管理员核验安装、批准并停用仓库', async ({ page }) => {
  const { writes } = await mockTasks(page);
  await page.goto('/operations');
  await page.getByRole('tab', { name: '仓库准入' }).click();
  await page.getByLabel('安装 ID', { exact: true }).fill('54321');
  await page.getByRole('button', { name: '核验并保存安装' }).click();
  await page.getByLabel('仓库所有者', { exact: true }).fill('example');
  await page.getByLabel('仓库名称', { exact: true }).fill('new-repository');
  await page.getByRole('button', { name: '批准仓库准入' }).click();
  await expect(page.getByText('example/new-repository', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停用仓库' }).click();
  await expect(page.getByRole('button', { name: '恢复准入' })).toBeVisible();
  expect(writes.find((write) => write.path === '/admin/repositories')?.body).toEqual({ installation_id: '54321', owner: 'example', name: 'new-repository' });
});
