import { test, expect, type Page, type Route } from '@playwright/test';
import type { AgreementDto, ParticipantDto, TaskDto } from '../../packages/contracts/src/index.js';

const owner = '11000000-0000-4000-8000-000000000001';
const publisher = '11000000-0000-4000-8000-000000000002';
const taskId = '22000000-0000-4000-8000-000000000001';
const lead = '44000000-0000-4000-8000-000000000001';
const helper = '44000000-0000-4000-8000-000000000002';
const agreementId = '55000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-07T08:00:00.000Z';
const deadline = '2099-11-14T10:00:00.000Z';
const operation = '66000000-0000-4000-8000-000000000001';
const respond = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const participant = (id: string, amount: string): ParticipantDto => ({ agent_id: id, owner_user_id: owner, owner_name: '开发者', name: id === lead ? '开发 Agent' : '测试 Agent', role: id === lead ? '主开发' : '测试', deliverable: id === lead ? '实现功能' : '提供测试记录', amount_points: amount, shared_owner: true });

async function mockCollaboration(page: Page, mode: 'initial' | 'pending' | 'active' = 'initial', reward = '100') {
  const members = [participant(lead, '70'), participant(helper, '30')];
  const agreement: AgreementDto = { id: agreementId, task_id: taskId, version: '1', status: mode === 'active' ? 'active' : 'pending', deadline_at: deadline, created_at: timestamp, activated_at: mode === 'active' ? timestamp : null, rejection_reason: null, members, confirmations: [{ subject_key: 'publisher', user_id: publisher, agent_id: null, accepted_at: timestamp }, { subject_key: `agent:${lead}`, user_id: owner, agent_id: lead, accepted_at: null }, { subject_key: `agent:${helper}`, user_id: owner, agent_id: helper, accepted_at: null }], can_accept: true, can_reject: true };
  let task: TaskDto = {
    id: taskId, title: '协作测试任务', description: '开发功能并验证结果。', repository_id: '33000000-0000-4000-8000-000000000001', issue_number: null, acceptance_criteria: '功能与测试通过。', required_checks: [], reward_points: reward, deadline_at: deadline,
    publisher_user_id: publisher, publisher_agent_id: null, payer_agent_id: null, reviewer_user_id: '11000000-0000-4000-8000-000000000003', assignee_agent_id: lead,
    status: 'in_progress', version: '3', disputed: false, dispute_reason: null, hold_id: agreementId, latest_delivery_id: null, review_due_at: null, review_reminded_at: null, settled_journal_id: null, created_at: timestamp, updated_at: timestamp, published_at: timestamp, accepted_at: timestamp, finalized_at: null,
    publisher_name: '发布者', assignee_name: '开发 Agent', reviewer_name: '验收人', repository_name: 'example/project', hold: { id: agreementId, status: 'open', reserved_total: reward, captured_total: '0', released_total: '0', remaining: reward },
    participants: mode === 'active' ? members : [{ ...participant(lead, reward), shared_owner: false }], active_agreement_id: mode === 'active' ? agreementId : null, agreements: mode === 'initial' ? [] : [agreement], contributions: [], deliveries: [], reviews: [], events: [], cancellation_proposals: [],
    permissions: { edit: false, publish: false, accept: false, submit: false, review: false, cancel: false, propose_cancel: true, dispute: false, resolve: false, propose_agreement: true, contribute: true, discuss: true },
  };
  const writes: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  await page.context().addCookies([{ name: 'az_csrf', value: 'phase3-csrf', url: 'http://localhost:5173' }]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const body = request.method() === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    if (request.method() !== 'GET') writes.push({ path, body, headers: request.headers() });
    if (path === '/me') return respond(route, { user: { id: owner, github_login: 'developer', display_name: '开发者', status: 'active', role: 'member' }, actor: { type: 'user', userId: owner } });
    if (path === '/world' || path.startsWith('/world/')) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND' } }) });
    if (path === '/agents') return respond(route, { items: members.map((member) => ({ id: member.agent_id, owner_user_id: owner, name: member.name, status: 'active', created_at: timestamp, updated_at: timestamp })), next_cursor: null });
    if (path === '/collaboration-agents') return respond(route, { items: members.map((member) => ({ id: member.agent_id, name: member.name, owner_user_id: owner, owner_name: '开发者' })) });
    if (path === `/tasks/${taskId}`) return respond(route, task);
    if (path === `/tasks/${taskId}/agreements`) {
      const proposed = body.members as { agent_id: string; role: string; deliverable: string; amount_points: string }[];
      task = { ...task, version: '4', agreements: [{ ...agreement, members: proposed.map((member) => ({ ...participant(member.agent_id, member.amount_points), ...member })), confirmations: agreement.confirmations.map((confirmation) => ({ ...confirmation, accepted_at: confirmation.agent_id === lead ? timestamp : null })) }] };
    }
    if (path === `/tasks/${taskId}/agreements/${agreementId}/accept`) {
      task = { ...task, version: (BigInt(task.version) + 1n).toString(), agreements: task.agreements?.map((item) => ({ ...item, confirmations: item.confirmations.map((confirmation) => ({ ...confirmation, accepted_at: confirmation.agent_id === body.agent_id ? timestamp : confirmation.accepted_at })) })) };
      const current = task.agreements![0]!;
      if (current.confirmations.every((confirmation) => confirmation.accepted_at)) task = { ...task, active_agreement_id: agreementId, participants: current.members, agreements: [{ ...current, status: 'active', can_accept: false, can_reject: false }] };
    }
    if (path === `/tasks/${taskId}/contributions`) task = { ...task, version: '4', contributions: [{ id: operation, task_id: taskId, agreement_id: agreementId, agent_id: String(body.agent_id), kind: body.kind as 'note', body: String(body.body), url: String(body.url), created_at: timestamp }] };
    if (path === `/tasks/${taskId}/cancellation-proposals`) task = { ...task, version: '5', cancellation_proposals: [{ id: operation, task_id: taskId, payment_points: String(body.payment_points), refund_points: String(body.refund_points), payments: body.payments as { agent_id: string; amount_points: string }[], reason: String(body.reason), status: 'pending', publisher_accepted: false, assignee_accepted: true, can_accept: false, confirmations: agreement.confirmations, created_at: timestamp }] };
    return respond(route, { ...task, operation_id: operation });
  });
  return writes;
}

test('协作提案校验大整数分账，待确认协议保留原有效分配', async ({ page }) => {
  const writes = await mockCollaboration(page, 'initial', '9007199254740993');
  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('button', { name: '提出协作协议', exact: true }).click();
  await page.getByRole('button', { name: '+ 增加协作者' }).click();
  await page.getByRole('combobox', { name: '成员 Agent 2', exact: true }).selectOption(helper);
  await page.getByRole('textbox', { name: '成员 2 角色', exact: true }).fill('测试');
  await page.getByRole('textbox', { name: '成员 2 具体交付', exact: true }).fill('完整测试记录');
  await page.getByRole('textbox', { name: '成员 2 分账积分', exact: true }).fill('3');
  await expect(page.getByRole('button', { name: '提交协议供确认' })).toBeDisabled();
  await page.getByRole('textbox', { name: '成员 1 分账积分', exact: true }).fill('9007199254740990');
  await page.getByRole('button', { name: '提交协议供确认' }).click();
  await expect(page.getByText('协议版本 1 · 待全体确认', { exact: true })).toBeVisible();
  await expect(page.getByText('当前生效分配 · 单 Agent 合同', { exact: true })).toBeVisible();
  const write = writes.find((item) => item.path.endsWith('/agreements'))!;
  expect(write.body).toMatchObject({ version: '3', members: [{ agent_id: lead, amount_points: '9007199254740990' }, { agent_id: helper, amount_points: '3' }] });
  expect(write.headers['x-csrf-token']).toBe('phase3-csrf');
  expect(write.headers['idempotency-key']).toBeTruthy();
});

test('同一所有者逐个代表 Agent 确认，全部同意后展示新协议', async ({ page }) => {
  const writes = await mockCollaboration(page, 'pending');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('combobox', { name: '确认身份', exact: true }).selectOption(`agent:${helper}`);
  await page.getByRole('button', { name: '以此身份接受方案' }).click();
  await expect(page.getByText('当前生效分配 · 单 Agent 合同', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '确认身份', exact: true }).selectOption(`agent:${lead}`);
  await page.getByRole('button', { name: '以此身份接受方案' }).click();
  await expect(page.getByText('当前生效分配 · 协议版本 1', { exact: true })).toBeVisible();
  expect(writes.filter((item) => item.path.endsWith('/accept')).map((item) => item.body.agent_id)).toEqual([helper, lead]);
  await expect(page.getByText('与其他成员同属一位所有者', { exact: false }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/phase-3-collaboration-mobile.png', fullPage: true });
});

test('成员成果及多人取消方案保留各成员金额与确认状态', async ({ page }) => {
  const writes = await mockCollaboration(page, 'active');
  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('combobox', { name: '交付成员', exact: true }).selectOption(helper);
  await page.getByRole('combobox', { name: '记录类型', exact: true }).selectOption('test');
  await page.getByRole('textbox', { name: '成果说明', exact: true }).fill('已完成兼容性和回归测试。');
  await page.getByRole('textbox', { name: '成果链接（可选，HTTPS）', exact: true }).fill('https://github.com/example/project/pull/1');
  await page.getByRole('button', { name: '登记成员成果' }).click();
  await expect(page.getByText('测试 Agent · 测试记录', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '支付 开发 Agent', exact: true }).fill('40');
  await page.getByRole('textbox', { name: '支付 测试 Agent', exact: true }).fill('20');
  await page.getByRole('textbox', { name: '取消理由', exact: true }).fill('双方完成部分工作后共同终止。');
  await expect(page.getByRole('button', { name: '提出取消方案', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '退回发布者', exact: true }).fill('40');
  await page.getByRole('button', { name: '提出取消方案', exact: true }).click();
  await expect(page.getByText('测试 Agent 获得 20 积分', { exact: true })).toBeVisible();
  expect(writes.find((item) => item.path.endsWith('/cancellation-proposals'))?.body).toMatchObject({ payment_points: '60', refund_points: '40', payments: [{ agent_id: lead, amount_points: '40' }, { agent_id: helper, amount_points: '20' }] });
});
