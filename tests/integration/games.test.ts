import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, GameDto, GameSessionDto } from '../../packages/contracts/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { processGameTimeouts } from '../../apps/api/src/modules/games/jobs.js';
import { reconcile } from '../../apps/api/src/modules/ledger/service.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { agent, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), origin = 'http://localhost:5173';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
type TestAgent = Awaited<ReturnType<typeof agent>> & { token: string };
type Principal = Session | TestAgent;
let app: Awaited<ReturnType<typeof buildApp>>;
let administrator: Session, author: Session, player: Session, other: Session;
let authorAgent: TestAgent, playerAgent: TestAgent, otherAgent: TestAgent;
async function session(role: 'admin' | 'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor, token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
async function credential(owner: Session): Promise<TestAgent> {
  const value = await agent(pools.runtime, owner.actor), token = `azk_${value.actor.credentialId}.${randomBytes(32).toString('base64url')}`;
  await pools.migration.query('UPDATE agent_keys SET secret_hash=$2 WHERE id=$1', [value.actor.credentialId, tokenHash(token)]);
  return { ...value, token };
}
const headers = (who: Principal, key: string = randomUUID()) => 'token' in who ? { authorization: `Bearer ${who.token}`, 'idempotency-key': key }
  : { cookie: who.cookie, origin, 'x-csrf-token': who.csrf, 'idempotency-key': key };
const get = (who: Principal, path: string) => app.inject({ url: `/api/v1${path}`, headers: headers(who) });
const write = (who: Principal, method: 'POST' | 'PATCH' | 'PUT', path: string, payload: Record<string, unknown>, key?: string) => app.inject({ method, url: `/api/v1${path}`, headers: headers(who, key), payload });
const post = (who: Principal, path: string, payload: Record<string, unknown>, key?: string) => write(who, 'POST', path, payload, key);
function body<T>(response: Awaited<ReturnType<typeof get>>): T { expect([200, 201], response.body).toContain(response.statusCode); return response.json<T>(); }
const reject = (response: Awaited<ReturnType<typeof get>>, code: string) => { expect([400, 403, 404, 409], response.body).toContain(response.statusCode); expect(response.json().error.code).toBe(code); };
const source = { type: 'url', url: 'https://games.example/play' };
async function game(pool = '60', minimum = '20') {
  let value = body<GameDto>(await post(authorAgent, '/games', { agent_id: authorAgent.id, name: '街机测试', description: '认证发布者核验成绩后结算', entry_fee: '5', max_reward: '10', minimum_pool: minimum, source }));
  if (pool !== '0') value = body<GameDto>(await post(authorAgent, `/games/${value.id}/fund`, { amount: pool }));
  return body<GameDto>(await write(author, 'PATCH', `/games/${value.id}`, { version: value.version, status: 'active' }));
}
async function start(value: GameDto, who: Principal = player, agentId = playerAgent.id, key?: string) {
  return body<GameSessionDto>(await post(who, `/games/${value.id}/sessions`, { agent_id: agentId, game_version: value.version }, key));
}
async function wallet(agentId: string) {
  return (await pools.runtime.query<{ bucket: string; balance: string }>('SELECT bucket,balance::text FROM ledger_accounts WHERE agent_id=$1 ORDER BY bucket', [agentId])).rows;
}
async function slots(pool = '30', rule = 'starlight_slots_v1') {
  let value = body<GameDto>(await post(authorAgent, '/games', { agent_id: authorAgent.id, name: '星光老虎机', description: '', entry_fee: '1', max_reward: '3', minimum_pool: '3', settlement_rule: rule, source }));
  value = body<GameDto>(await post(authorAgent, `/games/${value.id}/fund`, { amount: pool }));
  return body<GameDto>(await write(author, 'PATCH', `/games/${value.id}`, { version: value.version, status: 'active' }));
}
async function vectorRound(value: GameDto, vector: number, who: Principal = player, agentId = playerAgent.id) {
  const round = await start(value, who, agentId), id = `41000000-0000-4000-8000-${String(vector).padStart(12, '0')}`;
  // The test database fixes a server-issued ID to a published algorithm vector.
  // Clients still cannot supply session IDs through the start endpoint.
  await pools.migration.query('UPDATE arcade_game_sessions SET id=$2 WHERE id=$1', [round.id, id]);
  return { ...round, id };
}
async function expectGameLedger(gameId: string) {
  const row = (await pools.runtime.query(`SELECT g.pool_balance::text,g.pool_committed::text,
    (h.reserved_total-h.captured_total-h.released_total)::text AS remaining,
    (SELECT COALESCE(sum(s.max_reward),0)::text FROM arcade_game_sessions s WHERE s.game_id=g.id AND s.status IN ('playing','submitted')) AS commitments
    FROM arcade_games g JOIN credit_holds h ON h.id=g.pool_hold_id WHERE g.id=$1`, [gameId])).rows[0];
  expect(row.pool_balance).toBe(row.remaining); expect(row.pool_committed).toBe(row.commitments);
  expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
}
beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: '', githubClientSecret: '', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  administrator = await session('admin'); author = await session(); player = await session(); other = await session();
  authorAgent = await credential(author); playerAgent = await credential(player); otherAgent = await credential(other);
  await fund(pools.runtime, administrator.actor, authorAgent.id, '100');
  await fund(pools.runtime, administrator.actor, playerAgent.id, '50');
  await fund(pools.runtime, administrator.actor, otherAgent.id, '50');
});
afterAll(async () => { await app.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('付费游戏、发布者奖池与认证结果', () => {
  it.each([
    { vector: 1, score: '20', reward: '1' }, { vector: 2, score: '0', reward: '0' }, { vector: 23, score: '100', reward: '3' },
  ])('自动规则按公开向量 $vector 服务端计算并结算，忽略网页伪造成绩和奖金', async ({ vector, score, reward }) => {
    const value = await slots(), round = await vectorRound(value, vector);
    expect(round.settlement_rule).toBe('starlight_slots_v1');
    const result = body<GameSessionDto>(await post(player, `/games/sessions/${round.id}/score`, { score: '999999', reward_requested: '999999' }));
    expect(result).toMatchObject({ id: round.id, status: 'settled', settlement_rule: 'starlight_slots_v1', score, reward_requested: reward, reward_points: reward });
    expect(await wallet(playerAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: (49n + BigInt(reward)).toString() }, { bucket: 'RESERVED', balance: '0' }]);
    expect(await wallet(authorAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '71' }, { bucket: 'RESERVED', balance: (30n - BigInt(reward)).toString() }]);
    expect(body<GameDto>(await get(player, `/games/${value.id}`))).toMatchObject({ pool_balance: (30n - BigInt(reward)).toString(), pool_committed: '0' });
    await expectGameLedger(value.id);
  });
  it('自动结算的同键和跨键重试、并发提交只产生一次费用与奖励流水', async () => {
    const value = await slots('3'), round = await vectorRound(value, 23), key = randomUUID();
    const path = `/games/sessions/${round.id}/score`, input = { score: '0', reward_requested: '0' };
    const responses = await Promise.all([post(player, path, input, key), post(playerAgent, path, input), post(player, path, input, key)]);
    for (const response of responses) expect(body<GameSessionDto>(response)).toMatchObject({ status: 'settled', score: '100', reward_points: '3' });
    expect(body<GameSessionDto>(await post(player, path, { score: '20', reward_requested: '1' }))).toMatchObject({ status: 'settled', reward_points: '3' });
    expect(await wallet(playerAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '52' }, { bucket: 'RESERVED', balance: '0' }]);
    expect(body<GameDto>(await get(player, `/games/${value.id}`))).toMatchObject({ pool_balance: '0', pool_committed: '0', accepting_players: false });
    reject(await post(other, `/games/${value.id}/sessions`, { agent_id: otherAgent.id, game_version: value.version }), 'GAME_POOL_LOW');
    const payments = (await pools.runtime.query(`SELECT count(*)::int AS count FROM journal_transactions WHERE business_key=$1
      OR business_key=(SELECT 'hold:'||fee_hold_id||':finalize' FROM arcade_game_sessions WHERE id=$2)`, [`game:session:${round.id}:reward`, round.id])).rows[0];
    expect(payments.count).toBe(2);
    await expectGameLedger(value.id);
  });
  it('自动规则不允许人工覆写，过期输局由服务端扣费结算而不是退款', async () => {
    const value = await slots(), round = await vectorRound(value, 2);
    reject(await post(authorAgent, `/games/sessions/${round.id}/settle`, { reward_points: '3', reason: '尝试覆写输局' }), 'INVALID_INPUT');
    reject(await post(player, `/games/sessions/${round.id}/refund`, {}), 'GAME_SESSION_NOT_EXPIRED');
    await pools.migration.query("UPDATE arcade_game_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [round.id]);
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [authorAgent.id]);
    await processGameTimeouts(pools.runtime); await processGameTimeouts(pools.runtime);
    expect(body<GameSessionDto>(await get(player, `/games/sessions/${round.id}`))).toMatchObject({ status: 'settled', score: '0', reward_points: '0' });
    expect(body<GameSessionDto>(await post(player, `/games/sessions/${round.id}/refund`, {}))).toMatchObject({ status: 'settled', reward_points: '0' });
    expect(await wallet(playerAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '49' }, { bucket: 'RESERVED', balance: '0' }]);
    expect(await wallet(authorAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '71' }, { bucket: 'RESERVED', balance: '30' }]);
    await expectGameLedger(value.id);
  });
  it('过期自动局的迟交、退款请求和后台结算竞争时仍只结算一次', async () => {
    const value = await slots(), round = await vectorRound(value, 23);
    await pools.migration.query("UPDATE arcade_game_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [round.id]);
    const [submitted, refunded] = await Promise.all([
      post(playerAgent, `/games/sessions/${round.id}/score`, { score: '0', reward_requested: '0' }),
      post(player, `/games/sessions/${round.id}/refund`, {}), processGameTimeouts(pools.runtime),
    ]);
    for (const response of [submitted, refunded]) expect(body<GameSessionDto>(response)).toMatchObject({ status: 'settled', reward_points: '3' });
    expect(await wallet(playerAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '52' }, { bucket: 'RESERVED', balance: '0' }]);
    await expectGameLedger(value.id);
  });
  it('规则开关只影响新局，已付费对局保留原结算和超时合同', async () => {
    let value = await slots('30', 'manual');
    const manual = await start(value), oldTimeout = await start(value);
    value = body<GameDto>(await write(authorAgent, 'PATCH', `/games/${value.id}`, { version: value.version, settlement_rule: 'starlight_slots_v1' }));
    const automatic = await vectorRound(value, 1);
    value = body<GameDto>(await write(authorAgent, 'PATCH', `/games/${value.id}`, { version: value.version, settlement_rule: 'manual' }));
    expect(body<GameSessionDto>(await post(player, `/games/sessions/${manual.id}/score`, { score: '7', reward_requested: '2' }))).toMatchObject({ settlement_rule: 'manual', status: 'submitted' });
    expect(body<GameSessionDto>(await post(author, `/games/sessions/${manual.id}/settle`, { reward_points: '2', reason: '原规则人工核验' }))).toMatchObject({ status: 'settled', reward_points: '2' });
    expect(body<GameSessionDto>(await post(player, `/games/sessions/${automatic.id}/score`, { score: '999', reward_requested: '999' }))).toMatchObject({ settlement_rule: 'starlight_slots_v1', status: 'settled', score: '20', reward_points: '1' });
    await pools.migration.query("UPDATE arcade_game_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [oldTimeout.id]);
    await processGameTimeouts(pools.runtime);
    expect(body<GameSessionDto>(await get(player, `/games/sessions/${oldTimeout.id}`))).toMatchObject({ settlement_rule: 'manual', status: 'refunded' });
    expect((await start(value)).settlement_rule).toBe('manual');
    await expectGameLedger(value.id);
  });
  it('自动同钱包游玩只解除既有奖池冻结，未增发或重复付款', async () => {
    const value = await slots('3'), round = await vectorRound(value, 23, author, authorAgent.id);
    const issued = (await pools.runtime.query("SELECT count(*)::int AS count FROM journal_transactions WHERE kind='ISSUE'")).rows[0];
    expect(body<GameSessionDto>(await post(authorAgent, `/games/sessions/${round.id}/score`, { score: '100', reward_requested: '3' }))).toMatchObject({ status: 'settled', reward_points: '3' });
    expect(await wallet(authorAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '100' }, { bucket: 'RESERVED', balance: '0' }]);
    expect((await pools.runtime.query("SELECT count(*)::int AS count FROM journal_transactions WHERE kind='ISSUE'")).rows[0]).toEqual(issued);
    await expectGameLedger(value.id);
  });
  it('规则只接受平台白名单和固定金额，作者可原地更新包且不改变奖池与机器', async () => {
    const value = await slots(), file = { path: 'index.html', mime: 'text/html', content: Buffer.from('<h1>平台自动结算</h1>').toString('base64') };
    reject(await post(authorAgent, '/games', { agent_id: authorAgent.id, name: '不一致的规则', description: '', entry_fee: '2', max_reward: '3', settlement_rule: 'starlight_slots_v1', source }), 'INVALID_INPUT');
    expect((await write(authorAgent, 'PATCH', `/games/${value.id}`, { version: value.version, settlement_rule: 'client_reward' })).statusCode).toBe(400);
    const manual = await game();
    reject(await write(authorAgent, 'PATCH', `/games/${manual.id}`, { version: manual.version, settlement_rule: 'starlight_slots_v1' }), 'INVALID_INPUT');
    reject(await write(player, 'PATCH', `/games/${value.id}`, { version: value.version, description: '冒名更新' }), 'ACCESS_DENIED');
    const updated = body<GameDto>(await write(authorAgent, 'PATCH', `/games/${value.id}`, { version: value.version, description: ' 平台按固定规则自动结算 ', source: { type: 'bundle', entry: file.path, files: [file] } }));
    expect(updated).toMatchObject({ id: value.id, description: '平台按固定规则自动结算', source_type: 'bundle', pool_balance: value.pool_balance, pool_committed: value.pool_committed });
    expect(updated.version).not.toBe(value.version); expect((await app.inject(updated.entry_url)).body).toContain('平台自动结算');
    const audit = (await pools.runtime.query("SELECT details FROM audit_events WHERE target_id=$1 AND action='game.updated' ORDER BY created_at DESC LIMIT 1", [value.id])).rows[0];
    expect(audit.details).toMatchObject({ source_type: 'bundle' }); expect(audit.details).not.toHaveProperty('source');
    reject(await write(authorAgent, 'PATCH', `/games/${value.id}`, { version: value.version, description: '' }), 'GAME_VERSION_CONFLICT');
    reject(await write(authorAgent, 'PATCH', `/games/${value.id}`, { version: updated.version, source: { type: 'bundle', entry: '../index.html', files: [{ ...file, path: '../index.html' }] } }), 'INVALID_INPUT');
    expect(body<GameDto>(await get(author, `/games/${value.id}`))).toMatchObject({ version: updated.version, description: updated.description });
    await expectGameLedger(value.id);
  });
  it('锁定费用和最高奖励，分数不改钱包，作者结算原子转费派奖且跨请求键不重复', async () => {
    const value = await game(), key = randomUUID(), round = await start(value, player, playerAgent.id, key);
    expect((await start(value, player, playerAgent.id, key)).id).toBe(round.id);
    expect(await wallet(playerAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '45' }, { bucket: 'RESERVED', balance: '5' }]);
    expect(body<GameDto>(await get(player, `/games/${value.id}`)).pool_committed).toBe('10');
    body(await post(playerAgent, `/games/sessions/${round.id}/score`, { score: '1200', reward_requested: '8' }));
    expect(await wallet(playerAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '45' }, { bucket: 'RESERVED', balance: '5' }]);
    reject(await post(player, `/games/sessions/${round.id}/settle`, { reward_points: '8', reason: '玩家伪造奖励' }), 'ACCESS_DENIED');
    const settleKey = randomUUID(), input = { reward_points: '7', reason: '作者服务器核验实际结果' };
    expect(body<GameSessionDto>(await post(authorAgent, `/games/sessions/${round.id}/settle`, input, settleKey)).status).toBe('settled');
    body(await post(authorAgent, `/games/sessions/${round.id}/settle`, input, settleKey));
    reject(await post(authorAgent, `/games/sessions/${round.id}/settle`, input), 'GAME_SESSION_CLOSED');
    expect(await wallet(authorAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '45' }, { bucket: 'RESERVED', balance: '53' }]);
    expect(await wallet(playerAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '52' }, { bucket: 'RESERVED', balance: '0' }]);
    expect(body<GameDto>(await get(player, `/games/${value.id}`))).toMatchObject({ pool_balance: '53', pool_committed: '0', available_pool: '53' });
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
  it('奖池低于最低值停止开局，存取未承诺金额后自动恢复，手动暂停仍保留', async () => {
    const value = await game('20');
    expect(value.accepting_players).toBe(true);
    const round = await start(value);
    const after = body<GameDto>(await get(player, `/games/${value.id}`)); expect(after.accepting_players).toBe(false);
    reject(await post(other, `/games/${value.id}/sessions`, { agent_id: otherAgent.id, game_version: value.version }), 'GAME_POOL_LOW');
    reject(await post(author, `/games/${value.id}/withdraw`, { amount: '11' }), 'GAME_POOL_COMMITTED');
    expect(body<GameDto>(await post(author, `/games/${value.id}/withdraw`, { amount: '10' })).pool_balance).toBe('10');
    expect(body<GameDto>(await post(author, `/games/${value.id}/fund`, { amount: '20' })).accepting_players).toBe(true);
    body(await post(player, `/games/sessions/${round.id}/score`, { score: '0', reward_requested: '0' }));
    body(await post(author, `/games/sessions/${round.id}/settle`, { reward_points: '0', reason: '未中奖' }));
    const paused = body<GameDto>(await write(author, 'PATCH', `/games/${value.id}`, { version: value.version, status: 'paused' }));
    expect(body<GameDto>(await post(author, `/games/${value.id}/fund`, { amount: '1' })).accepting_players).toBe(false);
    reject(await post(player, `/games/${value.id}/sessions`, { agent_id: playerAgent.id, game_version: paused.version }), 'GAME_UNAVAILABLE');
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
  it('两个玩家并发开局不能超卖同一奖池，提现与结算均保留承诺', async () => {
    const value = await game('10', '10');
    const responses = await Promise.all([post(player, `/games/${value.id}/sessions`, { agent_id: playerAgent.id, game_version: value.version }), post(other, `/games/${value.id}/sessions`, { agent_id: otherAgent.id, game_version: value.version })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect(body<GameDto>(await get(author, `/games/${value.id}`))).toMatchObject({ pool_balance: '10', pool_committed: '10', accepting_players: false });
    reject(await post(author, `/games/${value.id}/withdraw`, { amount: '1' }), 'GAME_POOL_COMMITTED');
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
  it('超时自动退费且释放奖励额度，不依赖作者保持在线或启用', async () => {
    const value = await game(), round = await start(value);
    reject(await post(player, `/games/sessions/${round.id}/refund`, {}), 'GAME_SESSION_NOT_EXPIRED');
    await pools.migration.query("UPDATE arcade_game_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [round.id]);
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [authorAgent.id]);
    await processGameTimeouts(pools.runtime); await processGameTimeouts(pools.runtime);
    expect(body<GameSessionDto>(await get(player, `/games/sessions/${round.id}`)).status).toBe('refunded');
    expect(await wallet(playerAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '50' }, { bucket: 'RESERVED', balance: '0' }]);
    expect(body<GameDto>(await get(player, `/games/${value.id}`))).toMatchObject({ pool_balance: '60', pool_committed: '0' });
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
  it('互为发布者和玩家的两局可以并发结算，双方费用奖励均仅入账一次', async () => {
    const firstGame = await game('20', '10');
    let secondGame = body<GameDto>(await post(playerAgent, '/games', { agent_id: playerAgent.id, name: '另一家游戏厅', description: '', entry_fee: '5', max_reward: '10', minimum_pool: '10', source }));
    secondGame = body<GameDto>(await post(playerAgent, `/games/${secondGame.id}/fund`, { amount: '20' }));
    secondGame = body<GameDto>(await write(playerAgent, 'PATCH', `/games/${secondGame.id}`, { version: secondGame.version, status: 'active' }));
    const firstRound = await start(firstGame, playerAgent, playerAgent.id);
    const secondRound = await start(secondGame, authorAgent, authorAgent.id);
    body(await post(playerAgent, `/games/sessions/${firstRound.id}/score`, { score: '70', reward_requested: '7' }));
    body(await post(authorAgent, `/games/sessions/${secondRound.id}/score`, { score: '40', reward_requested: '4' }));
    const settled = await Promise.all([
      post(authorAgent, `/games/sessions/${firstRound.id}/settle`, { reward_points: '7', reason: '核验第一局' }),
      post(playerAgent, `/games/sessions/${secondRound.id}/settle`, { reward_points: '4', reason: '核验第二局' }),
    ]);
    expect(settled.map(response => body<GameSessionDto>(response).status)).toEqual(['settled', 'settled']);
    expect(await wallet(authorAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '84' }, { bucket: 'RESERVED', balance: '13' }]);
    expect(await wallet(playerAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '37' }, { bucket: 'RESERVED', balance: '16' }]);
    expect(body<GameDto>(await get(author, `/games/${firstGame.id}`))).toMatchObject({ pool_balance: '13', pool_committed: '0' });
    expect(body<GameDto>(await get(player, `/games/${secondGame.id}`))).toMatchObject({ pool_balance: '16', pool_committed: '0' });
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
  it('限制身份、钱包权限、过期报价和超过上限的奖励', async () => {
    const value = await game();
    reject(await post(playerAgent, '/games', { agent_id: authorAgent.id, name: '冒名', description: '', entry_fee: '1', max_reward: '1', source }), 'ACCESS_DENIED');
    reject(await post(player, `/games/${value.id}/fund`, { amount: '1' }), 'ACCESS_DENIED');
    reject(await post(player, `/games/${value.id}/sessions`, { agent_id: playerAgent.id, game_version: '1' }), 'GAME_VERSION_CONFLICT');
    await pools.migration.query('UPDATE agent_policies SET can_trade=false WHERE agent_id=$1', [playerAgent.id]);
    reject(await post(player, `/games/${value.id}/sessions`, { agent_id: playerAgent.id, game_version: value.version }), 'ACCESS_DENIED');
    await pools.migration.query('UPDATE agent_policies SET can_trade=true WHERE agent_id=$1', [playerAgent.id]);
    const round = await start(value);
    reject(await post(other, `/games/sessions/${round.id}/score`, { score: '100', reward_requested: '1' }), 'ACCESS_DENIED');
    reject(await post(player, `/games/sessions/${round.id}/score`, { score: '100', reward_requested: '11' }), 'INVALID_AMOUNT');
    body(await post(player, `/games/sessions/${round.id}/score`, { score: '100', reward_requested: '10' }));
    reject(await post(player, `/games/sessions/${round.id}/score`, { score: '200', reward_requested: '10' }), 'GAME_SESSION_CLOSED');
    reject(await post(author, `/games/sessions/${round.id}/settle`, { reward_points: '11', reason: '超出最高奖' }), 'INVALID_AMOUNT');
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
  it('同主人不同Agent可以付费游玩，第三个同主Agent不能冒充玩家或作者', async () => {
    const ownPlayer = await credential(author), bystander = await credential(author);
    await fund(pools.runtime, administrator.actor, ownPlayer.id, '10');
    const value = await game('20', '10'), round = await start(value, ownPlayer, ownPlayer.id);
    expect(body<GameSessionDto>(await get(ownPlayer, `/games/sessions/${round.id}`)).id).toBe(round.id);
    expect(body<GameSessionDto>(await get(authorAgent, `/games/sessions/${round.id}`)).id).toBe(round.id);
    reject(await get(bystander, `/games/sessions/${round.id}`), 'ACCESS_DENIED');
    reject(await post(bystander, `/games/sessions/${round.id}/score`, { score: '3', reward_requested: '3' }), 'ACCESS_DENIED');
    reject(await post(authorAgent, `/games/sessions/${round.id}/score`, { score: '3', reward_requested: '3' }), 'ACCESS_DENIED');
    body(await post(ownPlayer, `/games/sessions/${round.id}/score`, { score: '3', reward_requested: '3' }));
    reject(await post(ownPlayer, `/games/sessions/${round.id}/settle`, { reward_points: '3', reason: '玩家不可自行派奖' }), 'ACCESS_DENIED');
    reject(await post(bystander, `/games/sessions/${round.id}/settle`, { reward_points: '3', reason: '旁观Agent不可派奖' }), 'ACCESS_DENIED');
    body(await post(authorAgent, `/games/sessions/${round.id}/settle`, { reward_points: '3', reason: '发布者核验' }));
    expect(await wallet(ownPlayer.id)).toEqual([{ bucket: 'AVAILABLE', balance: '8' }, { bucket: 'RESERVED', balance: '0' }]);
    expect(await wallet(authorAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '85' }, { bucket: 'RESERVED', balance: '17' }]);
    const another = await start(value, ownPlayer, ownPlayer.id);
    await pools.migration.query("UPDATE arcade_game_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [another.id]);
    reject(await post(bystander, `/games/sessions/${another.id}/refund`, {}), 'ACCESS_DENIED');
    expect(body<GameSessionDto>(await post(ownPlayer, `/games/sessions/${another.id}/refund`, {})).status).toBe('refunded');
    expect(await wallet(ownPlayer.id)).toEqual([{ bucket: 'AVAILABLE', balance: '8' }, { bucket: 'RESERVED', balance: '0' }]);
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
  it('同一Agent可玩自己的游戏，费用收入抵消且奖励只释放既有奖池，无增发和重复派奖', async () => {
    const value = await game('20', '10'), round = await start(value, authorAgent, authorAgent.id);
    const issuance = (await pools.runtime.query("SELECT count(*)::int AS count,COALESCE(sum(e.amount),0)::text AS amount FROM journal_transactions j JOIN journal_entries e ON e.transaction_id=j.id AND e.side='credit' WHERE j.kind='ISSUE'")).rows[0];
    expect(await wallet(authorAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '75' }, { bucket: 'RESERVED', balance: '25' }]);
    expect(body<GameSessionDto>(await get(authorAgent, `/games/sessions/${round.id}`)).id).toBe(round.id);
    body(await post(authorAgent, `/games/sessions/${round.id}/score`, { score: '7', reward_requested: '7' }));
    const key = randomUUID(), settlement = { reward_points: '7', reason: '同钱包结果核验' };
    expect(body<GameSessionDto>(await post(authorAgent, `/games/sessions/${round.id}/settle`, settlement, key)).status).toBe('settled');
    body(await post(authorAgent, `/games/sessions/${round.id}/settle`, settlement, key));
    reject(await post(authorAgent, `/games/sessions/${round.id}/settle`, settlement), 'GAME_SESSION_CLOSED');
    expect(await wallet(authorAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '87' }, { bucket: 'RESERVED', balance: '13' }]);
    expect(body<GameDto>(await get(authorAgent, `/games/${value.id}`))).toMatchObject({ pool_balance: '13', pool_committed: '0' });
    expect((await pools.runtime.query("SELECT count(*)::int AS count,COALESCE(sum(e.amount),0)::text AS amount FROM journal_transactions j JOIN journal_entries e ON e.transaction_id=j.id AND e.side='credit' WHERE j.kind='ISSUE'")).rows[0]).toEqual(issuance);
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
  it('真人用户Session可选择自己Agent钱包开局、查对局和提交，发布者本人可结算自己的游戏', async () => {
    const ownPlayer = await credential(author);
    await fund(pools.runtime, administrator.actor, ownPlayer.id, '10');
    const value = await game('20', '10'), round = await start(value, author, ownPlayer.id);
    expect(body<GameSessionDto>(await get(author, `/games/sessions/${round.id}`))).toMatchObject({ player_user_id: author.actor.userId, player_agent_id: ownPlayer.id });
    body(await post(author, `/games/sessions/${round.id}/score`, { score: '6', reward_requested: '6' }));
    body(await post(author, `/games/sessions/${round.id}/settle`, { reward_points: '6', reason: '发布者本人核验并结算' }));
    expect(await wallet(ownPlayer.id)).toEqual([{ bucket: 'AVAILABLE', balance: '11' }, { bucket: 'RESERVED', balance: '0' }]);
    reject(await post(player, `/games/${value.id}/sessions`, { agent_id: ownPlayer.id, game_version: value.version }), 'ACCESS_DENIED');
    const selfRound = await start(value, author, authorAgent.id);
    body(await post(author, `/games/sessions/${selfRound.id}/score`, { score: '0', reward_requested: '0' }));
    body(await post(author, `/games/sessions/${selfRound.id}/settle`, { reward_points: '0', reason: '同钱包零奖励' }));
    expect(await wallet(authorAgent.id)).toEqual([{ bucket: 'AVAILABLE', balance: '85' }, { bucket: 'RESERVED', balance: '14' }]);
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
  it('奖池全部提现后能够重新存入，旧冻结正常关闭且新冻结守恒', async () => {
    const value = await game('20');
    expect(body<GameDto>(await post(author, `/games/${value.id}/withdraw`, { amount: '20' }))).toMatchObject({ pool_balance: '0', accepting_players: false });
    expect(body<GameDto>(await post(author, `/games/${value.id}/fund`, { amount: '20' }))).toMatchObject({ pool_balance: '20', accepting_players: true });
    expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
  });
  it('上传HTML/JS/WASM包保持沙箱响应，拒绝目录穿越、重复路径与伪造内容类型', async () => {
    const files = [
      { path: 'index.html', mime: 'text/html', content: Buffer.from('<script type="module" src="./app.js"></script>').toString('base64') },
      { path: 'app.js', mime: 'text/javascript', content: Buffer.from('document.body.textContent="可玩";').toString('base64') },
      { path: 'game.wasm', mime: 'application/wasm', content: Buffer.from([0,97,115,109,1,0,0,0]).toString('base64') },
    ];
    const input = { agent_id: authorAgent.id, name: '程序游戏', description: '', entry_fee: '1', max_reward: '2', source: { type: 'bundle', entry: 'index.html', files } };
    const value = body<GameDto>(await post(author, '/games', input));
    expect(value.entry_url).toBe(`/game-content/${value.id}/index.html`);
    const html = await app.inject(value.entry_url);
    expect(html.statusCode).toBe(200); expect(html.headers['content-type']).toContain('text/html');
    expect(html.headers['content-security-policy']).toContain('sandbox allow-scripts;');
    expect(html.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(html.headers['access-control-allow-origin']).toBe('*'); expect(html.headers['referrer-policy']).toBe('no-referrer');
    expect((await app.inject(`/game-content/${value.id}/game.wasm`)).headers['content-type']).toBe('application/wasm');
    for (const bad of [ { ...files[0]!, path: '../index.html' }, { ...files[0]!, mime: 'application/javascript' }, { ...files[0]!, content: 'not base64!' } ]) {
      reject(await post(author, '/games', { ...input, source: { type: 'bundle', entry: bad.path, files: [bad] } }), 'INVALID_INPUT');
    }
    reject(await post(author, '/games', { ...input, source: { type: 'bundle', entry: 'index.html', files: [files[0], files[0]] } }), 'INVALID_INPUT');
  });
  it('机器只能由土地所有者或管理Agent绑定，删除机器不清除作者作品', async () => {
    const value = await game(), landId = randomUUID(), placementId = randomUUID();
    await pools.migration.query("INSERT INTO land_plots(id,code,x,y,area,points_price,owner_agent_id,owner_user_id,created_by) VALUES($1,'ARCADE-TEST',10,10,1600,1,$2,$3,$3)", [landId, authorAgent.id, author.actor.userId]);
    await pools.migration.query("INSERT INTO world_model_placements(id,land_id,model_id,x,y,rotation,scale) VALUES($1,$2,'arcade',0,0,0,1)", [placementId, landId]);
    reject(await write(player, 'PUT', `/games/machines/${placementId}`, { game_id: value.id }), 'ACCESS_DENIED');
    expect(body<{ game: GameDto }>(await write(authorAgent, 'PUT', `/games/machines/${placementId}`, { game_id: value.id })).game.id).toBe(value.id);
    expect(body<{ game: GameDto }>(await get(player, `/games/machines/${placementId}`)).game.id).toBe(value.id);
    await pools.migration.query('DELETE FROM world_model_placements WHERE id=$1', [placementId]);
    expect((await pools.runtime.query('SELECT 1 FROM arcade_game_machines WHERE placement_id=$1', [placementId])).rowCount).toBe(0);
    expect(body<GameDto>(await get(author, `/games/${value.id}`)).id).toBe(value.id);
  });
});
