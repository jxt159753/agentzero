import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, ItemInstanceDto, ItemTemplateDto, LandPlotDto, MarketCatalogDto, MarketListingDto, MarketTradeDto, TaskDto, WorldAgentProfile, WorldModelDraft, WorldModelResult, WorldSnapshot, WorldStreamSnapshot, WorldStreamMessage, WorldStudio } from '../../packages/contracts/src/index.js';
import { WORLD_MODEL_CATALOG, WORLD_ROOM_DIMENSIONS } from '../../packages/contracts/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import type { GitHubRepositoryProvider } from '../../apps/api/src/modules/github/provider.js';
import { agent, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

// PostgreSQL and every application route are real. Only remote GitHub evidence is supplied locally.
const pools = testPools(), origin = 'http://localhost:5173', sha = 'd'.repeat(40);
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string; githubId: string };
type TestAgent = Awaited<ReturnType<typeof agent>> & { token: string };
type Principal = Session | TestAgent;
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Session, alice: Session, bob: Session;
let a: TestAgent, b: TestAgent, payer: TestAgent;
let repositoryId: string;

const repositoryGithub: GitHubRepositoryProvider = {
  async getInstallation({ installationId }) { return { installationId, accountLogin: 'world-fixture', status: 'active' }; },
  async getRepository({ owner, name }) { return { repositoryId: '880601', owner, name, fullName: `${owner}/${name}`, isPrivate: false }; },
  async getPullRequest({ number }) {
    return { repositoryId: '880601', number, headSha: sha, authorGithubId: alice.githubId, merged: true,
      url: `https://github.com/world-fixture/public-work/pull/${number}`, checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }], fetchedAt: new Date().toISOString() };
  },
};

async function session(role: 'admin' | 'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  const githubId = (await pools.runtime.query('SELECT github_user_id::text AS id FROM users WHERE id=$1', [actor.userId])).rows[0].id as string;
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf, githubId };
}
async function credential(owner: Session): Promise<TestAgent> {
  const created = await agent(pools.runtime, owner.actor);
  const token = `azk_${created.actor.credentialId}.${randomBytes(32).toString('base64url')}`;
  await pools.migration.query('UPDATE agent_keys SET secret_hash=$2 WHERE id=$1', [created.actor.credentialId, tokenHash(token)]);
  return { ...created, token };
}
const headers = (principal: Principal, key: string = randomUUID()) => 'token' in principal
  ? { authorization: `Bearer ${principal.token}`, 'idempotency-key': key }
  : { cookie: principal.cookie, origin, 'x-csrf-token': principal.csrf, 'idempotency-key': key };
const get = (principal: Principal, path: string) => app.inject({ url: `/api/v1${path}`, headers: headers(principal) });
const write = (principal: Principal, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, payload: Record<string, unknown>, key?: string) => app.inject({ method, url: `/api/v1${path}`, headers: headers(principal, key), payload });
const post = (principal: Principal, path: string, payload: Record<string, unknown>, key?: string) => write(principal, 'POST', path, payload, key);
const rejected = (response: { statusCode: number; body: string }) => expect([400, 401, 403, 404, 409], response.body).toContain(response.statusCode);
function body<T>(response: Awaited<ReturnType<typeof get>>): T {
  expect([200, 201], response.body).toContain(response.statusCode);
  return response.json<T>();
}
async function ownedStudio(area = 100) {
  body(await post(admin, '/admin/market/lands', { plots: [{ code: 'WORLD-01', x: 3, y: 4, area, points_price: '10', building_template: 'studio' }], reason: '独立测试世界供应' }));
  const offer = body<MarketCatalogDto>(await get(alice, '/market')).lands[0]!;
  body(await post(alice, `/market/lands/${offer.id}/buy`, { agent_id: a.id, version: offer.version }));
  const owned = body<LandPlotDto>(await get(alice, `/market/lands/${offer.id}`));
  return body<LandPlotDto>(await write(alice, 'PATCH', `/market/lands/${offer.id}/studio`, { agent_id: a.id, version: owned.version, name: '公开世界工作室', works_url: 'https://example.com/authorized-work' }));
}
async function settledTask() {
  const task = body<TaskDto>(await post(admin, '/tasks', { title: '已验收公开任务', description: 'PRIVATE CONTRACT DESCRIPTION', repository_id: repositoryId,
    acceptance_criteria: 'PRIVATE ACCEPTANCE CRITERIA', required_checks: ['CI'], reward_points: '10', deadline_at: new Date(Date.now() + 86400_000).toISOString(), reviewer_user_id: admin.actor.userId, payer_agent_id: payer.id }));
  async function action(principal: Principal, path: string, extra: Record<string, unknown> = {}) {
    const current = body<TaskDto>(await get(principal, `/tasks/${task.id}`));
    return body<TaskDto>(await post(principal, `/tasks/${task.id}/${path}`, { version: current.version, ...extra }));
  }
  await action(admin, 'publish');
  await action(alice, 'accept', { agent_id: a.id });
  await action(alice, 'agreements', { members: [{ agent_id: a.id, role: '主开发', deliverable: 'PRIVATE LEAD DELIVERABLE', amount_points: '7' }, { agent_id: b.id, role: '测试协作', deliverable: 'PRIVATE PARTNER DELIVERABLE', amount_points: '3' }], deadline_at: new Date(Date.now() + 86400_000).toISOString() });
  const agreement = body<TaskDto>(await get(alice, `/tasks/${task.id}`)).agreements![0]!;
  await action(admin, `agreements/${agreement.id}/accept`, { as_publisher: true });
  await action(bob, `agreements/${agreement.id}/accept`, { agent_id: b.id });
  await action(alice, 'deliveries', { pr_number: 17, head_sha: sha });
  await action(admin, 'reviews', { decision: 'accept', reason: 'PRIVATE REVIEW REASON' });
  return task.id;
}

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, repositoryGithub, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test-client', githubClientSecret: 'test-secret', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); alice = await session(); bob = await session();
  a = await credential(alice); b = await credential(bob); payer = await credential(admin);
  for (const target of [a, b, payer]) await fund(pools.runtime, admin.actor, target.id, '100');
  await pools.migration.query('UPDATE agents SET name=$2 WHERE id=$1', [a.id, '世界 Agent Alice']);
  await pools.migration.query('UPDATE agents SET name=$2 WHERE id=$1', [b.id, '世界 Agent Bob']);
  repositoryId = randomUUID();
  await pools.migration.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES('8806','world-fixture','active')");
  await pools.migration.query("INSERT INTO repositories(id,github_id,installation_id,owner,name,full_name,is_private,status) VALUES($1,'880601','8806','world-fixture','public-work','world-fixture/public-work',false,'approved')", [repositoryId]);
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

const world = async (principal: Principal = alice) => body<WorldSnapshot>(await get(principal, '/world'));
const profile = async (id: string = a.id, principal: Principal = bob) => body<WorldAgentProfile>(await get(principal, `/world/agents/${id}`));
const pulse = (principal: Principal, position: Record<string, unknown> = {}, key?: string) => post(principal, '/world/presence', position, key);

describe('phase 6 shared world with real PostgreSQL', () => {
  it('shares committed state while keeping user visitors separate from Agent identities', async () => {
    expect((await app.inject({ url: '/api/v1/world' })).statusCode).toBe(401);
    const start = await world();
    expect(start).toMatchObject({ lands: [], visitors: [], self: { kind: 'visitor', id: alice.actor.userId, online: false }, presence_ttl_seconds: 60 });
    expect(start.agents.every(agent => !agent.online)).toBe(true);
    body(await pulse(alice, { x: 10, y: 20 }));
    body(await pulse(bob, { x: 30, y: 40 }));
    const [first, second] = await Promise.all([world(alice), world(bob)]);
    expect(first.self).toMatchObject({ kind: 'visitor', id: alice.actor.userId, x: 10, y: 20, online: true });
    expect(second.self).toMatchObject({ kind: 'visitor', id: bob.actor.userId, x: 30, y: 40, online: true });
    expect(first.visitors).toEqual(second.visitors);
    expect(first.agents).toEqual(second.agents);
    expect(first.agents.find(agent => agent.id === a.id)?.online).toBe(false);
    for (const forged of [{ agent_id: a.id }, { kind: 'agent', id: a.id, x: 0, y: 0 }, { x: 1000001, y: 0 }, { x: null, y: 0 }, { x: 1 }]) rejected(await pulse(alice, forged));
    body(await pulse(a, { x: 7, y: 8 }));
    expect((await world(a)).self).toMatchObject({ kind: 'agent', id: a.id, online: true, x: 7, y: 8 });
    expect((await world(bob)).agents.find(agent => agent.id === a.id)).toMatchObject({ online: true, x: 7, y: 8 });
    expect((await pools.runtime.query('SELECT count(*)::int AS n FROM world_positions')).rows[0].n).toBe(3);
  });

  it('preserves continuous positions and exposes expanded world-space boundaries and public areas', async () => {
    const initial = await world();
    expect(initial.bounds).toEqual({ min_x: -32, max_x: 32, min_y: -24, max_y: 24 });
    expect(initial.public_areas.map(area => area.kind)).toEqual(expect.arrayContaining(['plaza', 'road', 'facility']));
    const key = randomUUID();
    const first = body(await pulse(alice, { x: 1.25, y: -2.375 }, key));
    expect(body(await pulse(alice, { x: 1.25, y: -2.375 }, key))).toEqual(first);
    expect((await world()).self).toMatchObject({ x: 1.25, y: -2.375 });
    body(await post(admin, '/admin/market/lands', { plots: [{ code: 'DISTANT', x: 120, y: -140, area: 100, points_price: '10', building_template: 'studio' }], reason: '既有外侧地块边界兼容' }));
    body(await pulse(bob, { x: -220.5, y: 250.75 }));
    const expanded = await world();
    expect(expanded.bounds.min_x).toBeLessThan(-220.5);
    expect(expanded.bounds.max_x).toBeGreaterThan(120);
    expect(expanded.bounds.min_y).toBeLessThan(-140);
    expect(expanded.bounds.max_y).toBeGreaterThan(250.75);
    expect(expanded.lands[0]).toMatchObject({ owner: null, tradeable: true, purchasable: true });
  });

  it('projects the human owner alongside the Agent and never advertises public plots for purchase', async () => {
    const land = await ownedStudio();
    const owned = (await world()).lands.find(plot => plot.id === land.id)!;
    expect(owned).toMatchObject({ owner_agent_id: a.id, owner: { id: alice.actor.userId }, tradeable: true, purchasable: false });
    expect(owned.owner?.github_login).toMatch(/^fixture-/);
    await pools.migration.query("INSERT INTO land_plots(code,x,y,area,points_price,building_template,created_by) VALUES('LEGACY-PUBLIC',0,0,100,10,'studio',$1)", [admin.actor.userId]);
    const legacy = (await world()).lands.find(plot => plot.code === 'LEGACY-PUBLIC')!;
    expect(legacy).toMatchObject({ tradeable: false, purchasable: false, owner: null });
    expect(body<WorldStudio>(await get(bob, `/world/studios/${legacy.id}`)).land).toMatchObject({ tradeable: false, purchasable: false });
  });

  it('requires CSRF, validates heartbeat input and preserves the result of an idempotent move', async () => {
    const missingCsrf = await app.inject({ method: 'POST', url: '/api/v1/world/presence', headers: { cookie: alice.cookie, origin, 'idempotency-key': randomUUID() }, payload: {} });
    expect(missingCsrf.statusCode).toBe(403);
    const key = randomUUID(), first = await pulse(alice, { x: 1, y: 2 }, key);
    body(first);
    expect((await pulse(alice, { x: 1, y: 2 }, key)).json()).toEqual(first.json());
    expect((await pulse(alice, { x: 2, y: 2 }, key)).statusCode).toBe(409);
    expect((await world()).self).toMatchObject({ x: 1, y: 2 });
    expect((await pools.runtime.query('SELECT count(*)::int AS n FROM world_positions WHERE subject_id=$1', [alice.actor.userId])).rows[0].n).toBe(1);
  });

  it('expires presence but retains position, and leaves without removing the studio', async () => {
    const land = await ownedStudio();
    body(await pulse(alice, { x: 12, y: -8 }));
    body(await pulse(a, { x: 3, y: 4 }));
    await pools.migration.query("UPDATE world_positions SET expires_at=clock_timestamp()-interval '1 second'");
    const expired = await world();
    expect(expired.visitors).toEqual([]);
    expect(expired.self).toMatchObject({ online: false, x: 12, y: -8 });
    expect(expired.agents.find(agent => agent.id === a.id)).toMatchObject({ online: false, x: 3, y: 4 });
    expect(expired.lands.find(plot => plot.id === land.id)).toMatchObject({ name: '公开世界工作室', owner_agent_id: a.id });
    body(await pulse(alice));
    expect((await world()).self).toMatchObject({ online: true, x: 12, y: -8 });
    body(await post(alice, '/world/leave', {}));
    expect((await world()).self).toMatchObject({ online: false, x: 12, y: -8 });
    expect((await world()).lands).toHaveLength(1);
  });

  it('immediately excludes revoked credentials, expired sessions and paused Agents from online state', async () => {
    body(await pulse(a)); body(await pulse(b)); body(await pulse(alice));
    await pools.migration.query('UPDATE agent_keys SET revoked_at=clock_timestamp() WHERE id=$1', [a.actor.credentialId]);
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [b.id]);
    await pools.migration.query("UPDATE user_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [alice.actor.sessionId]);
    const snapshot = await world(admin);
    expect(snapshot.agents.find(agent => agent.id === a.id)?.online).toBe(false);
    expect(snapshot.agents.find(agent => agent.id === b.id)).toMatchObject({ online: false, status: 'paused' });
    expect(snapshot.visitors).toEqual([]);
    rejected(await pulse(a)); rejected(await pulse(b)); rejected(await pulse(alice));
  });

  it('does not expose private messages, wallet details or keys through the map or public profile', async () => {
    const conversation = body<{ id: string }>(await post(alice, '/conversations', { recipient_agent_id: b.id }));
    body(await post(alice, `/conversations/${conversation.id}/messages`, { body: 'PRIVATE CHAT SENTINEL' }));
    const outputs = JSON.stringify([await world(bob), await profile(a.id, bob)]);
    for (const privateValue of ['PRIVATE CHAT SENTINEL', a.token, alice.cookie, alice.csrf, 'secret_hash', 'credential_id', 'session_id', 'single_spend_limit', 'daily_spend_limit', 'available', 'reserved', 'transactions', 'messages']) expect(outputs).not.toContain(privateValue);
    rejected(await get(bob, `/world/agents/${a.id}/publication-options`));
    await pools.migration.query("UPDATE users SET status='suspended' WHERE id=$1", [alice.actor.userId]);
    rejected(await get(alice, '/world'));
    expect((await world(bob)).visitors.some(visitor => visitor.id === alice.actor.userId)).toBe(false);
  });

  it('publishes only an owner-authorized summary and independently consented collaborators', async () => {
    const taskId = await settledTask(), path = `/world/agents/${a.id}/works/${taskId}`;
    expect((await profile()).works).toEqual([]);
    rejected(await write(bob, 'PUT', path, { summary: '未经所有者同意' }));
    rejected(await write(a, 'PUT', path, { summary: 'Agent 不能代替人的公开授权' }));
    rejected(await write(admin, 'PUT', `/world/agents/${payer.id}/works/${taskId}`, { summary: '付款方不是承接成员' }));
    body(await write(alice, 'PUT', path, { summary: '获授权的修复摘要' }));
    const published = await profile();
    expect(published.works).toHaveLength(1);
    expect(published.works[0]).toMatchObject({ task_id: taskId, summary: '获授权的修复摘要', role: 'lead', pr_url: 'https://github.com/world-fixture/public-work/pull/17' });
    expect(published.works[0]!.collaborators.some(member => member.id === b.id)).toBe(false);
    const serialized = JSON.stringify(published);
    for (const secret of ['PRIVATE CONTRACT DESCRIPTION', 'PRIVATE ACCEPTANCE CRITERIA', 'PRIVATE LEAD DELIVERABLE', 'PRIVATE PARTNER DELIVERABLE', 'PRIVATE REVIEW REASON', 'reward_points', 'amount_points']) expect(serialized).not.toContain(secret);
    body(await write(bob, 'PUT', `/world/agents/${b.id}/works/${taskId}`, { summary: '公开测试成果' }));
    expect((await profile()).works[0]!.collaborators.some(member => member.id === b.id)).toBe(true);
    expect((await profile(b.id, alice)).works[0]).toMatchObject({ role: 'collaborator', summary: '公开测试成果' });
    body(await write(bob, 'DELETE', `/world/agents/${b.id}/works/${taskId}`, {}));
    expect((await profile()).works[0]!.collaborators.some(member => member.id === b.id)).toBe(false);
    body(await write(alice, 'DELETE', path, {}));
    expect((await profile()).works).toEqual([]);
  });

  it('retains accepted public history after installation removal, but hides a newly private repository', async () => {
    const taskId = await settledTask(), path = `/world/agents/${a.id}/works/${taskId}`;
    body(await write(alice, 'PUT', path, { summary: '已验收历史摘要' }));
    await pools.migration.query("UPDATE repositories SET status='disabled' WHERE id=$1", [repositoryId]);
    await pools.migration.query("UPDATE github_installations SET status='deleted' WHERE installation_id='8806'");
    expect((await profile()).works).toHaveLength(1);
    await pools.migration.query('UPDATE repositories SET is_private=true WHERE id=$1', [repositoryId]);
    expect((await profile()).works).toEqual([]);
    rejected(await write(alice, 'PUT', path, { summary: '不公开私有仓库' }));
  });

  it('shows only placed decorations and refreshes ownership and works after an atomic sale', async () => {
    const land = await ownedStudio();
    const template = body<ItemTemplateDto>(await post(admin, '/admin/market/templates', { name: '公开盆栽', description: '装饰模板', appearance: 'plant', points_price: '5', total_quantity: '2', reason: '独立测试库物品' }));
    const purchased = body<MarketTradeDto>(await post(alice, `/market/templates/${template.id}/buy`, { agent_id: a.id, version: template.version }));
    const decoration = body<ItemInstanceDto>(await get(alice, `/market/items/${purchased.item_id}`));
    const studio = () => get(bob, `/world/studios/${land.id}`).then(body<WorldStudio>);
    expect((await studio()).land.decorations).toEqual([]);
    body(await post(alice, `/market/items/${decoration.id}/place`, { agent_id: a.id, version: decoration.version, land_id: land.id }));
    expect((await studio()).land.decorations).toMatchObject([{ id: decoration.id, name: '公开盆栽', appearance: 'plant' }]);
    const owned = body<LandPlotDto>(await get(alice, `/market/lands/${land.id}`));
    const listing = body<MarketListingDto>(await post(alice, '/market/listings', { agent_id: a.id, land_id: land.id, asset_version: owned.version, points_price: '20' }));
    expect((await studio()).land.listing).toMatchObject({ id: listing.id, points_price: '20' });
    body(await post(bob, `/market/listings/${listing.id}/buy`, { agent_id: b.id, version: listing.version }));
    expect(await studio()).toMatchObject({ land: { owner_agent_id: b.id, name: '默认工作室', works_url: null, showcase: [], listing: null, decorations: [] }, agent: { id: b.id } });
    const [aliceView, bobView] = await Promise.all([world(alice), world(bob)]);
    expect(aliceView.lands).toEqual(bobView.lands);
    expect((await pools.runtime.query('SELECT owner_agent_id,land_id FROM item_instances WHERE id=$1', [decoration.id])).rows[0]).toEqual({ owner_agent_id: a.id, land_id: null });
  });

  it('lets only the land owner freely place approved models, with idempotent versioned edits', async () => {
    const land = await ownedStudio(), path = `/world/studios/${land.id}/models`;
    const draft: WorldModelDraft = { model_id: 'bench', x: 0, y: 0, rotation: 0, scale: 1 };
    const input = { ...draft, land_version: land.version }, key = randomUUID();
    expect((await post(bob, path, input)).statusCode).toBe(403);
    expect((await post(b, path, input)).statusCode).toBe(403);
    expect((await post(admin, path, input)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1${path}`, headers: { cookie: alice.cookie, origin, 'idempotency-key': key }, payload: input })).statusCode).toBe(403);
    for (const invalid of [{ model_id: 'remote-script' }, { url: 'https://example.com/model.glb' }, { scale: 2.1 }, { rotation: 360 }, { x: 1 }, { model_id: 'studio' }])
      expect((await post(alice, path, { ...input, ...invalid })).statusCode).toBe(400);
    const ledgerCount = (await pools.runtime.query('SELECT count(*)::int AS count FROM journal_transactions')).rows[0].count;
    const created = body<WorldModelResult>(await post(alice, path, input, key));
    expect(body<WorldModelResult>(await post(alice, path, input, key))).toEqual(created);
    expect(created).toMatchObject({ placement: { ...draft, version: '1' }, land_version: String(BigInt(land.version) + 1n) });
    expect((await post(alice, path, input)).statusCode).toBe(409);
    const updated = body<WorldModelResult>(await write(alice, 'PATCH', `${path}/${created.placement.id}`, { version: '1', x: 0.1, y: 0.05, rotation: 90, scale: 0.75 }));
    expect(updated.placement).toMatchObject({ version: '2', x: 0.1, y: 0.05, rotation: 90, scale: 0.75 });
    expect((await write(alice, 'PATCH', `${path}/${created.placement.id}`, { version: '1', x: 0, y: 0, rotation: 0, scale: 1 })).statusCode).toBe(409);
    expect((await write(bob, 'DELETE', `${path}/${created.placement.id}`, { version: '2' })).statusCode).toBe(403);
    expect((await write(alice, 'DELETE', `${path}/${created.placement.id}`, { version: '1' })).statusCode).toBe(409);
    const [aliceWorld, bobWorld] = await Promise.all([world(alice), world(bob)]);
    expect(aliceWorld.lands.find(item => item.id === land.id)?.models).toEqual([updated.placement]);
    expect(bobWorld.lands).toEqual(aliceWorld.lands);
    expect(body<WorldStudio>(await get(bob, `/world/studios/${land.id}`)).land.models).toEqual([updated.placement]);
    const removed = body(await write(alice, 'DELETE', `${path}/${created.placement.id}`, { version: '2' }, key));
    expect(removed).toMatchObject({ deleted: true, id: created.placement.id });
    expect(body(await write(alice, 'DELETE', `${path}/${created.placement.id}`, { version: '2' }, key))).toEqual(removed);
    expect((await world()).lands.find(item => item.id === land.id)?.models).toEqual([]);
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM journal_transactions')).rows[0].count).toBe(ledgerCount);
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM item_instances')).rows[0].count).toBe(0);
  });

  it('starts purchased land empty and persists every expanded catalog model without replacing existing placements', async () => {
    const land = await ownedStudio(900), path = `/world/studios/${land.id}/models`;
    expect(body<WorldStudio>(await get(alice, `/world/studios/${land.id}`)).land).toMatchObject({ models: [], decorations: [] });
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM world_model_placements WHERE land_id=$1', [land.id])).rows[0].count).toBe(0);
    const modelIds = Object.keys(WORLD_MODEL_CATALOG) as WorldModelDraft['model_id'][];
    expect(modelIds.length).toBeGreaterThan(7);
    const ledgerCount = (await pools.runtime.query('SELECT count(*)::int AS count FROM journal_transactions')).rows[0].count;
    const placements: WorldModelResult['placement'][] = [];
    let landVersion = land.version;
    for (const modelId of modelIds) {
      const added = body<WorldModelResult>(await post(alice, path, { land_version: landVersion, model_id: modelId, x: 0, y: 0, rotation: 35, scale: 0.25 }));
      expect(added.placement.model_id).toBe(modelId);
      placements.push(added.placement); landVersion = added.land_version;
    }
    const observed = body<WorldStudio>(await get(bob, `/world/studios/${land.id}`)).land.models!;
    expect(observed).toHaveLength(modelIds.length);
    expect(observed).toEqual(expect.arrayContaining(placements));
    expect((await pools.runtime.query('SELECT model_id FROM world_model_placements WHERE land_id=$1 ORDER BY model_id', [land.id])).rows.map(row => row.model_id)).toEqual([...modelIds].sort());
    expect((await post(alice, path, { land_version: landVersion, model_id: 'unapproved-house', x: 0, y: 0, rotation: 0, scale: 0.25 })).statusCode).toBe(400);
    expect((await world()).lands.find(item => item.id === land.id)?.models).toEqual(expect.arrayContaining(placements));
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM journal_transactions')).rows[0].count).toBe(ledgerCount);
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM item_instances')).rows[0].count).toBe(0);
  });

  it('lets the managing Agent furnish rooms while preserving room ownership, bounds and removal rules', async () => {
    const land = await ownedStudio(), path = `/world/studios/${land.id}/models`;
    const house = body<WorldModelResult>(await post(a, path, { land_version: land.version, model_id: 'cabin', x: 0, y: 0, rotation: 0, scale: 0.5 }));
    const input = { land_version: house.land_version, model_id: 'arcade', room_id: house.placement.id, x: 2, y: 1.5, rotation: 0, scale: 1 };
    const sibling = await credential(alice);
    expect((await post(sibling, path, input)).statusCode).toBe(403);
    expect((await post(b, path, input)).statusCode).toBe(403);
    expect((await post(a, path, { ...input, room_id: randomUUID() })).statusCode).toBe(404);
    expect((await post(a, path, { ...input, model_id: 'studio' })).statusCode).toBe(400);
    expect((await post(a, path, { ...input, x: WORLD_ROOM_DIMENSIONS.width / 2 - 0.01 })).statusCode).toBe(400);
    const key = randomUUID(), cabinet = body<WorldModelResult>(await post(a, path, input, key));
    expect(body<WorldModelResult>(await post(a, path, input, key))).toEqual(cabinet);
    expect(cabinet.placement).toMatchObject({ model_id: 'arcade', room_id: house.placement.id, x: 2, y: 1.5 });
    expect(body<WorldStudio>(await get(bob, `/world/studios/${land.id}`)).land.models).toEqual(expect.arrayContaining([house.placement, cabinet.placement]));
    expect((await write(alice, 'DELETE', `${path}/${house.placement.id}`, { version: '1' })).json().error.code).toBe('WORLD_ROOM_NOT_EMPTY');
    const moved = body<WorldModelResult>(await write(a, 'PATCH', `${path}/${cabinet.placement.id}`, { version: '1', x: -1, y: 0.5, rotation: 90, scale: 1 }));
    expect(moved.placement.room_id).toBe(house.placement.id);
    expect((await write(a, 'PATCH', `${path}/${cabinet.placement.id}`, { version: '2', room_id: null, x: 0, y: 0, rotation: 0, scale: 1 })).statusCode).toBe(400);
    const listed = body<MarketListingDto>(await post(alice, '/market/listings', { agent_id: a.id, land_id: land.id, asset_version: moved.land_version, points_price: '20' }));
    expect((await write(a, 'DELETE', `${path}/${cabinet.placement.id}`, { version: '2' })).statusCode).toBe(409);
    body(await pulse(bob, { room_id: house.placement.id, x: 0.2, y: 0.3 }));
    body(await post(bob, `/market/listings/${listed.id}/buy`, { agent_id: b.id, version: listed.version }));
    expect((await world(bob)).self).toMatchObject({ room_id: null, x: land.x, y: land.y + 1 });
    expect((await world()).lands.find(item => item.id === land.id)?.models).toEqual([]);
  });

  it('keeps visitor and Agent interior presence separate and returns occupants outside a removed house', async () => {
    const land = await ownedStudio(), path = `/world/studios/${land.id}/models`;
    const house = body<WorldModelResult>(await post(alice, path, { land_version: land.version, model_id: 'studio', x: 0, y: 0, rotation: 0, scale: 0.5 }));
    expect((await pulse(bob, { room_id: house.placement.id, x: WORLD_ROOM_DIMENSIONS.width / 2 + 0.01, y: 0 })).statusCode).toBe(400);
    expect((await pulse(bob, { room_id: randomUUID(), x: 0, y: 0 })).statusCode).toBe(400);
    body(await pulse(bob, { room_id: house.placement.id, x: 2, y: 1.5 }));
    body(await pulse(b, { room_id: house.placement.id, x: -1, y: -1 }));
    body(await pulse(bob));
    expect((await world(bob)).self).toMatchObject({ room_id: house.placement.id, x: 2, y: 1.5 });
    expect((await world()).agents.find(item => item.id === b.id)).toMatchObject({ room_id: house.placement.id, x: -1, y: -1 });
    body(await pulse(bob, { room_id: null, x: 4, y: 5 }));
    expect((await world(bob)).self).toMatchObject({ room_id: null, x: 4, y: 5 });
    body(await write(alice, 'DELETE', `${path}/${house.placement.id}`, { version: '1' }));
    expect((await world(b)).self).toMatchObject({ room_id: null, x: land.x, y: land.y + 1 });
    expect((await world(bob)).self).toMatchObject({ room_id: null, x: 4, y: 5 });
  });

  it('streams room entry and exit and persists room positions across a reconnect', async () => {
    const land = await ownedStudio(), path = `/world/studios/${land.id}/models`;
    const house = body<WorldModelResult>(await post(alice, path, { land_version: land.version, model_id: 'shed', x: 0, y: 0, rotation: 0, scale: 1 }));
    const messages: WorldStreamMessage[] = [];
    const socket = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: bob.cookie, origin } },
      { onInit: ws => ws.on('message', data => messages.push(JSON.parse(data.toString()) as WorldStreamMessage)) });
    try {
      await expect.poll(() => messages.some(message => message.type === 'snapshot')).toBe(true);
      socket.send(JSON.stringify({ type: 'move', seq: 1, x: 2.1, y: -1.5, room_id: house.placement.id, moving: false }));
      await expect.poll(() => messages.some(message => message.type === 'ack' && message.seq === 1 && message.persisted && message.room_id === house.placement.id)).toBe(true);
      expect((await world(bob)).self).toMatchObject({ room_id: house.placement.id, x: 2.1, y: -1.5 });
      socket.close();
      let snapshot: WorldSnapshot | undefined;
      const reopened = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: bob.cookie, origin } },
        { onInit: ws => ws.on('message', data => { const message = JSON.parse(data.toString()) as WorldStreamMessage; if (message.type === 'snapshot') snapshot = message.world; }) });
      try {
        await expect.poll(() => snapshot?.self).toMatchObject({ room_id: house.placement.id, x: 2.1, y: -1.5 });
        reopened.send(JSON.stringify({ type: 'move', seq: 1, x: 4, y: 5, room_id: null, moving: false }));
        await expect.poll(async () => (await world(bob)).self).toMatchObject({ room_id: null, x: 4, y: 5 });
      } finally { reopened.close(); }
    } finally { socket.close(); }
  });

  it('serializes the 32-model limit and competing edits on the same land', async () => {
    const land = await ownedStudio(), path = `/world/studios/${land.id}/models`;
    const draft: WorldModelDraft = { model_id: 'plant', x: 0, y: 0, rotation: 0, scale: 0.25 };
    let landVersion = land.version;
    for (let index = 0; index < 31; index++) landVersion = body<WorldModelResult>(await post(alice, path, { ...draft, land_version: landVersion })).land_version;
    const concurrent = await Promise.all([post(alice, path, { ...draft, land_version: landVersion }), post(alice, path, { ...draft, land_version: landVersion })]);
    expect(concurrent.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const added = body<WorldModelResult>(concurrent.find(response => response.statusCode === 201)!);
    expect((await post(alice, path, { ...draft, land_version: added.land_version })).json().error.code).toBe('WORLD_MODEL_LIMIT');
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM world_model_placements WHERE land_id=$1', [land.id])).rows[0].count).toBe(32);
    const updates = await Promise.all([
      write(alice, 'PATCH', `${path}/${added.placement.id}`, { version: '1', x: 0.1, y: 0, rotation: 0, scale: 0.25 }),
      write(alice, 'PATCH', `${path}/${added.placement.id}`, { version: '1', x: -0.1, y: 0, rotation: 0, scale: 0.25 }),
    ]);
    expect(updates.map(response => response.statusCode).sort()).toEqual([200, 409]);
  });

  it('freezes models while land is listed and clears the seller layout in the sale transaction', async () => {
    const land = await ownedStudio(), path = `/world/studios/${land.id}/models`;
    const created = body<WorldModelResult>(await post(alice, path, { land_version: land.version, model_id: 'plant', x: 0, y: 0, rotation: 0, scale: 1 }));
    const listing = body<MarketListingDto>(await post(alice, '/market/listings', { agent_id: a.id, land_id: land.id, asset_version: created.land_version, points_price: '20' }));
    const listed = body<LandPlotDto>(await get(alice, `/market/lands/${land.id}`));
    expect((await post(alice, path, { land_version: listed.version, model_id: 'plant', x: 0, y: 0, rotation: 0, scale: 1 })).statusCode).toBe(409);
    expect((await write(alice, 'PATCH', `${path}/${created.placement.id}`, { version: '1', x: 0, y: 0, rotation: 90, scale: 1 })).statusCode).toBe(409);
    expect((await write(alice, 'DELETE', `${path}/${created.placement.id}`, { version: '1' })).statusCode).toBe(409);
    body(await post(bob, `/market/listings/${listing.id}/buy`, { agent_id: b.id, version: listing.version }));
    expect(body<WorldStudio>(await get(bob, `/world/studios/${land.id}`)).land).toMatchObject({ owner: { id: bob.actor.userId }, name: '默认工作室', models: [] });
    expect((await pools.runtime.query('SELECT count(*)::int AS count FROM world_model_placements WHERE land_id=$1', [land.id])).rows[0].count).toBe(0);
    expect((await write(alice, 'PATCH', `${path}/${created.placement.id}`, { version: '1', x: 0, y: 0, rotation: 0, scale: 1 })).statusCode).toBe(403);
    const bought = body<LandPlotDto>(await get(bob, `/market/lands/${land.id}`));
    expect(body<WorldModelResult>(await post(bob, path, { land_version: bought.version, model_id: 'lamp', x: 0, y: 0, rotation: 0, scale: 1 })).placement.model_id).toBe('lamp');
  });

  it('publishes model additions, transforms and removals to another visitor through world deltas', async () => {
    const land = await ownedStudio(), path = `/world/studios/${land.id}/models`;
    let observed: WorldStudio['land'] | undefined, snapshots = 0;
    const socket = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: bob.cookie, origin } },
      { onInit: ws => ws.on('message', data => {
        const message = JSON.parse(data.toString()) as WorldStreamMessage;
        if (message.type === 'snapshot') { snapshots++; observed = message.world.lands.find(item => item.id === land.id); }
        if (message.type === 'delta') observed = message.lands?.upsert.find(item => item.id === land.id) ?? observed;
      }) });
    try {
      await expect.poll(() => observed?.models).toEqual([]);
      const added = body<WorldModelResult>(await post(alice, path, { land_version: land.version, model_id: 'bench', x: 0, y: 0, rotation: 0, scale: 1 }));
      await expect.poll(() => observed?.models, { timeout: 6000 }).toEqual([added.placement]);
      const moved = body<WorldModelResult>(await write(alice, 'PATCH', `${path}/${added.placement.id}`, { version: '1', x: 0.1, y: 0, rotation: 90, scale: 0.75 }));
      await expect.poll(() => observed?.models, { timeout: 6000 }).toEqual([moved.placement]);
      body(await write(alice, 'DELETE', `${path}/${added.placement.id}`, { version: '2' }));
      await expect.poll(() => observed?.models, { timeout: 6000 }).toEqual([]);
      expect(snapshots).toBe(1);
    } finally { socket.terminate(); }
  });

  it('publishes showcase edits and clears to studio views, profiles, snapshots and v2 land deltas', async () => {
    const land = await ownedStudio(), messages: WorldStreamMessage[] = [];
    const socket = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: bob.cookie, origin } },
      { onInit: ws => ws.on('message', data => messages.push(JSON.parse(data.toString()))) });
    const showcase = [{ type: 'text', text: '附近展示' }, { type: 'webpage', url: 'https://example.com/showcase' }];
    try {
      await expect.poll(() => messages.some(message => message.type === 'snapshot' && message.world.lands.some(plot => plot.id === land.id && plot.showcase?.length === 0))).toBe(true);
      const updated = body<LandPlotDto>(await write(alice, 'PATCH', `/market/lands/${land.id}/studio`, { agent_id: a.id, version: land.version, name: land.name, works_url: land.works_url, showcase }));
      expect(body<WorldStudio>(await get(bob, `/world/studios/${land.id}`)).land.showcase).toEqual(showcase);
      expect((await profile(a.id, bob)).lands.find(plot => plot.id === land.id)?.showcase).toEqual(showcase);
      expect((await world(bob)).lands.find(plot => plot.id === land.id)?.showcase).toEqual(showcase);
      await expect.poll(() => messages.flatMap(message => message.type === 'delta' ? message.lands?.upsert ?? [] : [])
        .find(plot => plot.id === land.id && plot.version === updated.version)?.showcase, { timeout: 6000 }).toEqual(showcase);
      const cleared = body<LandPlotDto>(await write(alice, 'PATCH', `/market/lands/${land.id}/studio`, { agent_id: a.id, version: updated.version, name: land.name, works_url: land.works_url, showcase: [] }));
      await expect.poll(() => messages.some(message => message.type === 'delta' && message.lands?.upsert.some(plot => plot.id === land.id && plot.version === cleared.version && plot.showcase?.length === 0)), { timeout: 6000 }).toBe(true);
      expect(messages.filter(message => message.type === 'snapshot')).toHaveLength(1);
    } finally { socket.terminate(); }
  });

  it('authenticates WebSocket snapshots, shares updates, and closes an expired session', async () => {
    await expect(app.injectWS('/api/v1/world/stream', { headers: { cookie: alice.cookie, origin: 'https://foreign.invalid' } })).rejects.toThrow();
    await expect(app.injectWS('/api/v1/world/stream', { headers: { origin } })).rejects.toThrow();
    let aliceSnapshot: WorldSnapshot | undefined, bobSnapshot: WorldSnapshot | undefined;
    const first = await app.injectWS('/api/v1/world/stream', { headers: { cookie: alice.cookie, origin } }, { onInit: socket => socket.on('message', data => { aliceSnapshot = (JSON.parse(data.toString()) as WorldStreamSnapshot).world; }) });
    const second = await app.injectWS('/api/v1/world/stream', { headers: { cookie: bob.cookie, origin } }, { onInit: socket => socket.on('message', data => { bobSnapshot = (JSON.parse(data.toString()) as WorldStreamSnapshot).world; }) });
    try {
      await expect.poll(() => aliceSnapshot?.self.id).toBe(alice.actor.userId);
      await expect.poll(() => bobSnapshot?.self.id).toBe(bob.actor.userId);
      const land = await ownedStudio();
      await expect.poll(() => aliceSnapshot?.lands.find(plot => plot.id === land.id)?.owner_agent_id, { timeout: 6000 }).toBe(a.id);
      await expect.poll(() => bobSnapshot?.lands.find(plot => plot.id === land.id)?.owner_agent_id, { timeout: 6000 }).toBe(a.id);
      await pools.migration.query('UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [alice.actor.sessionId]);
      await expect.poll(() => first.readyState, { timeout: 6000 }).toBe(first.CLOSED);
    } finally { first.terminate(); second.terminate(); }
  });

  it('streams v2 deltas and checkpoints movement without creating durable command receipts', async () => {
    const messages: WorldStreamMessage[] = [], otherMessages: WorldStreamMessage[] = [];
    const first = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: alice.cookie, origin } },
      { onInit: socket => socket.on('message', data => messages.push(JSON.parse(data.toString()))) });
    const second = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: bob.cookie, origin } },
      { onInit: socket => socket.on('message', data => otherMessages.push(JSON.parse(data.toString()))) });
    const position = async () => (await pools.runtime.query('SELECT x,y FROM world_positions WHERE subject_id=$1', [alice.actor.userId])).rows[0];
    const receiptCount = async () => (await pools.runtime.query("SELECT count(*)::int AS n FROM idempotency_requests WHERE route_key='POST:/api/v1/world/presence'")).rows[0].n;
    try {
      await expect.poll(() => messages.some(message => message.type === 'snapshot')).toBe(true);
      await expect.poll(() => otherMessages.some(message => message.type === 'snapshot')).toBe(true);
      const receipts = await receiptCount();
      first.send(JSON.stringify({ type: 'move', seq: 1, x: 4.25, y: 5.5, moving: true }));
      await expect.poll(() => messages.some(message => message.type === 'ack' && message.seq === 1)).toBe(true);
      await expect.poll(() => otherMessages.some(message => message.type === 'delta' && message.visitors?.upsert.some(visitor => visitor.id === alice.actor.userId && visitor.x === 4.25)), { timeout: 6000 }).toBe(true);
      expect(await position()).toEqual({ x: 0, y: 0 });
      first.send(JSON.stringify({ type: 'move', seq: 0, x: 99, y: 99, moving: true }));
      first.send(JSON.stringify({ type: 'move', seq: 2, x: 4.5, y: 6, moving: false }));
      await expect.poll(position, { timeout: 4000 }).toEqual({ x: 4.5, y: 6 });
      await expect.poll(() => messages.some(message => message.type === 'ack' && message.seq === 2 && message.persisted)).toBe(true);
      expect(await receiptCount()).toBe(receipts);
      const land = await ownedStudio();
      await expect.poll(() => messages.some(message => message.type === 'delta' && message.lands?.upsert.some(plot => plot.id === land.id && plot.owner_agent_id === a.id)), { timeout: 6000 }).toBe(true);
      expect(messages.filter(message => message.type === 'snapshot')).toHaveLength(1);
      const sent = JSON.stringify(messages);
      for (const secret of ['session_id', 'credential_id', alice.csrf, alice.cookie, a.token]) expect(sent).not.toContain(secret);
      first.send(JSON.stringify({ type: 'move', seq: 3, x: 7, y: 8, moving: true }));
      await expect.poll(() => messages.some(message => message.type === 'ack' && message.seq === 3)).toBe(true);
      first.close();
      await expect.poll(position, { timeout: 4000 }).toEqual({ x: 7, y: 8 });
    } finally { first.terminate(); second.terminate(); }
  });

  it('shares one recurring world aggregation across connected clients', async () => {
    const snapshots = new Set<string>();
    const first = await app.injectWS('/api/v1/world/stream', { headers: { cookie: alice.cookie, origin } },
      { onInit: socket => socket.on('message', () => snapshots.add('alice')) });
    const second = await app.injectWS('/api/v1/world/stream', { headers: { cookie: bob.cookie, origin } },
      { onInit: socket => socket.on('message', () => snapshots.add('bob')) });
    let aggregations = 0;
    const client = await pools.runtime.connect();
    const prototype = Object.getPrototypeOf(client), query = prototype.query;
    client.release();
    const spy = vi.spyOn(prototype, 'query').mockImplementation(function(this: unknown, ...args: unknown[]) {
      if (typeof args[0] === 'string' && args[0].includes('AS lands,') && args[0].includes('AS visitors,')) aggregations++;
      return query.apply(this, args);
    });
    try {
      await expect.poll(() => snapshots.size).toBe(2);
      // Count only recurring refreshes, after both initial snapshots have arrived.
      aggregations = 0;
      await new Promise(resolve => setTimeout(resolve, 4800));
      expect(aggregations).toBeGreaterThanOrEqual(2);
      expect(aggregations).toBeLessThanOrEqual(3);
    } finally { spy.mockRestore(); first.terminate(); second.terminate(); }
  });

  it('does not let a revoked stream or an older connection overwrite a newer position', async () => {
    const initial: WorldStreamMessage[] = [], replacement: WorldStreamMessage[] = [];
    const first = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: alice.cookie, origin } },
      { onInit: socket => socket.on('message', data => initial.push(JSON.parse(data.toString()))) });
    await expect.poll(() => initial.some(message => message.type === 'snapshot')).toBe(true);
    first.send(JSON.stringify({ type: 'move', seq: 1, x: 15, y: 16, moving: true }));
    await expect.poll(() => initial.some(message => message.type === 'ack')).toBe(true);
    const second = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: alice.cookie, origin } },
      { onInit: socket => socket.on('message', data => replacement.push(JSON.parse(data.toString()))) });
    const position = async () => (await pools.runtime.query('SELECT x,y FROM world_positions WHERE subject_id=$1', [alice.actor.userId])).rows[0];
    try {
      await expect.poll(() => replacement.some(message => message.type === 'snapshot')).toBe(true);
      await expect.poll(() => first.readyState).toBe(first.CLOSED);
      second.send(JSON.stringify({ type: 'move', seq: 1, x: 25, y: 26, moving: false }));
      await expect.poll(position, { timeout: 4000 }).toEqual({ x: 25, y: 26 });
      second.send(JSON.stringify({ type: 'move', seq: 2, x: 35, y: 36, moving: true }));
      await expect.poll(() => replacement.some(message => message.type === 'ack' && message.seq === 2)).toBe(true);
      await pools.migration.query('UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [alice.actor.sessionId]);
      await expect.poll(() => second.readyState, { timeout: 6000 }).toBe(second.CLOSED);
      expect(await position()).toEqual({ x: 25, y: 26 });
      expect((await world(bob)).visitors.some(visitor => visitor.id === alice.actor.userId)).toBe(false);
    } finally { first.terminate(); second.terminate(); }
  });

  it('rejects forged v2 commands and never revives an expired presence checkpoint', async () => {
    const messages: WorldStreamMessage[] = [];
    let closeReason = '';
    const socket = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: alice.cookie, origin } },
      { onInit: ws => { ws.on('message', data => messages.push(JSON.parse(data.toString()))); ws.on('close', (_code, reason) => { closeReason = reason.toString(); }); } });
    try {
      await expect.poll(() => messages.some(message => message.type === 'snapshot')).toBe(true);
      socket.send(JSON.stringify({ type: 'move', seq: 1, x: 30, y: 40, moving: true }));
      await expect.poll(() => messages.some(message => message.type === 'ack')).toBe(true);
      await pools.migration.query("UPDATE world_positions SET expires_at=clock_timestamp()-interval '1 second' WHERE subject_id=$1", [alice.actor.userId]);
      socket.send(JSON.stringify({ type: 'move', seq: 2, x: 50, y: 60, moving: false }));
      await expect.poll(() => socket.readyState, { timeout: 6000 }).toBe(socket.CLOSED);
      expect(closeReason).toBe('WORLD_PRESENCE_EXPIRED');
      expect((await world()).self).toMatchObject({ x: 0, y: 0, online: false });
    } finally { socket.terminate(); }
    const forgedMessages: WorldStreamMessage[] = [];
    const forged = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: alice.cookie, origin } },
      { onInit: ws => ws.on('message', data => forgedMessages.push(JSON.parse(data.toString()))) });
    try {
      await expect.poll(() => forgedMessages.some(message => message.type === 'snapshot')).toBe(true);
      forged.send(JSON.stringify({ type: 'move', seq: 1, x: 1, y: 1, moving: false, agent_id: a.id }));
      await expect.poll(() => forged.readyState).toBe(forged.CLOSED);
      expect((await world()).agents.find(item => item.id === a.id)?.online).toBe(false);
    } finally { forged.terminate(); }
  });

  it('includes an offline visitor own persisted position in legacy snapshot bounds', async () => {
    body(await pulse(alice, { x: 120, y: 130 }));
    await pools.migration.query("UPDATE world_positions SET expires_at=clock_timestamp()-interval '1 second' WHERE subject_id=$1", [alice.actor.userId]);
    let snapshot: WorldSnapshot | undefined;
    const socket = await app.injectWS('/api/v1/world/stream', { headers: { cookie: alice.cookie, origin } },
      { onInit: ws => ws.on('message', data => { snapshot = (JSON.parse(data.toString()) as WorldStreamSnapshot).world; }) });
    try {
      await expect.poll(() => snapshot?.self).toMatchObject({ x: 120, y: 130, online: false });
      expect(snapshot!.bounds.max_x).toBeGreaterThan(120);
      expect(snapshot!.bounds.max_y).toBeGreaterThan(130);
    } finally { socket.terminate(); }
  });

  it('waits for a projection begun after the new connection commits, even with an older refresh in flight', async () => {
    const client = await pools.runtime.connect();
    const prototype = Object.getPrototypeOf(client), query = prototype.query;
    client.release();
    let release!: () => void, captured = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(prototype, 'query').mockImplementation(function(this: unknown, ...args: unknown[]) {
      const result = query.apply(this, args);
      if (!captured && typeof args[0] === 'string' && args[0].includes('AS lands,') && args[0].includes('AS visitors,')) {
        captured = true;
        return result.then(async (rows: unknown) => { await gate; return rows; });
      }
      return result;
    });
    const first = await app.injectWS('/api/v1/world/stream', { headers: { cookie: bob.cookie, origin } });
    let second: Awaited<ReturnType<typeof app.injectWS>> | undefined;
    let initial: WorldSnapshot | undefined;
    try {
      await expect.poll(() => captured).toBe(true);
      const land = await ownedStudio();
      second = await app.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: alice.cookie, origin } },
        { onInit: ws => ws.on('message', data => { const message = JSON.parse(data.toString()) as WorldStreamMessage; if (message.type === 'snapshot') initial = message.world; }) });
      await expect.poll(async () => (await pools.runtime.query('SELECT count(*)::int AS n FROM world_positions WHERE subject_id=$1', [alice.actor.userId])).rows[0].n).toBe(1);
      release();
      await expect.poll(() => initial?.self.online).toBe(true);
      expect(initial?.lands.find(plot => plot.id === land.id)?.owner_agent_id).toBe(a.id);
    } finally { release(); spy.mockRestore(); first.terminate(); second?.terminate(); }
  });

  it('waits for a connection initialization transaction before the server finishes closing', async () => {
    const closingApp = await buildApp({ pool: pools.runtime, repositoryGithub, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test-client', githubClientSecret: 'test-secret', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
    await closingApp.ready();
    const client = await pools.runtime.connect();
    const prototype = Object.getPrototypeOf(client), query = prototype.query;
    client.release();
    let release!: () => void, waiting = false, closed = false;
    const initializedClients = new Set<unknown>();
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(prototype, 'query').mockImplementation(function(this: unknown, ...args: unknown[]) {
      if (typeof args[0] === 'string' && args[0].includes('INSERT INTO world_positions')) initializedClients.add(this);
      if (initializedClients.has(this) && args[0] === 'COMMIT' && !waiting) {
        waiting = true;
        return gate.then(() => query.apply(this, args));
      }
      return query.apply(this, args);
    });
    const socket = await closingApp.injectWS('/api/v1/world/stream?v=2', { headers: { cookie: alice.cookie, origin } });
    let closing: Promise<void> | undefined;
    try {
      await expect.poll(() => waiting).toBe(true);
      closing = closingApp.close().then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(closed).toBe(false);
      release();
      await closing;
      expect(closed).toBe(true);
    } finally { release(); spy.mockRestore(); socket.terminate(); await closing; await closingApp.close(); }
  });
});

