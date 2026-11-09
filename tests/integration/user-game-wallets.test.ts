import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, GameDto, GameSessionDto } from '../../packages/contracts/src/index.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { processGameTimeouts } from '../../apps/api/src/modules/games/jobs.js';
import { reconcile } from '../../apps/api/src/modules/ledger/service.js';
import { agent, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), origin = 'http://localhost:5173';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
type TestAgent = Awaited<ReturnType<typeof agent>> & { token: string };
type Principal = Session | TestAgent;
let app: Awaited<ReturnType<typeof buildApp>>;
let administrator: Session, author: Session, player: Session, other: Session;
let authorAgent: TestAgent;

async function session(role: 'admin' | 'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  await pools.runtime.query('SELECT ledger.open_user_account($1)', [actor.userId]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
async function credential(owner: Session): Promise<TestAgent> {
  const value = await agent(pools.runtime, owner.actor), token = `azk_${value.actor.credentialId}.${randomBytes(32).toString('base64url')}`;
  await pools.migration.query('UPDATE agent_keys SET secret_hash=$2 WHERE id=$1', [value.actor.credentialId, tokenHash(token)]);
  return { ...value, token };
}
const headers = (who: Principal, key: string = randomUUID()) => 'token' in who
  ? { authorization: `Bearer ${who.token}`, 'idempotency-key': key }
  : { cookie: who.cookie, origin, 'x-csrf-token': who.csrf, 'idempotency-key': key };
const get = (who: Principal, path: string) => app.inject({ url: `/api/v1${path}`, headers: headers(who) });
const write = (who: Principal, method: 'POST' | 'PATCH', path: string, payload: Record<string, unknown>, key?: string) =>
  app.inject({ method, url: `/api/v1${path}`, headers: headers(who, key), payload });
const post = (who: Principal, path: string, payload: Record<string, unknown>, key?: string) => write(who, 'POST', path, payload, key);
function body<T>(response: Awaited<ReturnType<typeof get>>): T {
  expect([200, 201], response.body).toContain(response.statusCode);
  return response.json<T>();
}
function denied(response: Awaited<ReturnType<typeof get>>, code = 'ACCESS_DENIED') {
  expect(response.statusCode, response.body).toBe(403);
  expect(response.json().error.code).toBe(code);
}
async function game(rule: 'manual' | 'starlight_slots_v1' = 'manual', fee = '5') {
  const automatic = rule === 'starlight_slots_v1';
  let value = body<GameDto>(await post(authorAgent, '/games', {
    agent_id: authorAgent.id, name: '个人钱包游戏', description: '从个人钱包支付',
    entry_fee: automatic ? '1' : fee, max_reward: automatic ? '3' : '10', minimum_pool: automatic ? '3' : '20',
    settlement_rule: rule, source: { type: 'url', url: 'https://games.example/personal' },
  }));
  value = body<GameDto>(await post(authorAgent, `/games/${value.id}/fund`, { amount: automatic ? '30' : '60' }));
  return body<GameDto>(await write(author, 'PATCH', `/games/${value.id}`, { version: value.version, status: 'active' }));
}
const start = (value: GameDto, who: Principal = player, key?: string) => post(who, `/games/${value.id}/sessions`, { game_version: value.version }, key);
async function userWallet(who = player) {
  const rows = (await pools.runtime.query<{ bucket: string; balance: string }>(
    'SELECT bucket,balance::text FROM ledger_accounts WHERE user_id=$1 ORDER BY bucket', [who.actor.userId])).rows;
  return Object.fromEntries(rows.map(row => [row.bucket, row.balance]));
}
async function agentWallet(id: string) {
  const rows = (await pools.runtime.query<{ bucket: string; balance: string }>(
    'SELECT bucket,balance::text FROM ledger_accounts WHERE agent_id=$1 ORDER BY bucket', [id])).rows;
  return Object.fromEntries(rows.map(row => [row.bucket, row.balance]));
}
async function expire(id: string) {
  await pools.migration.query("UPDATE arcade_game_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
}
async function vectorRound(value: GameDto, vector: number) {
  const round = body<GameSessionDto>(await start(value));
  const id = `41000000-0000-4000-8000-${String(vector).padStart(12, '0')}`;
  // Fix only the isolated database's server-issued ID to the published result vector.
  await pools.migration.query('UPDATE arcade_game_sessions SET id=$2 WHERE id=$1', [round.id, id]);
  return { ...round, id };
}
async function expectConserved(gameId: string) {
  const row = (await pools.runtime.query(`SELECT g.pool_balance::text,g.pool_committed::text,
    (h.reserved_total-h.captured_total-h.released_total)::text AS held,
    (SELECT COALESCE(sum(s.max_reward),0)::text FROM arcade_game_sessions s
      WHERE s.game_id=g.id AND s.status IN ('playing','submitted')) AS committed
    FROM arcade_games g JOIN credit_holds h ON h.id=g.pool_hold_id WHERE g.id=$1`, [gameId])).rows[0];
  expect(row.pool_balance).toBe(row.held);
  expect(row.pool_committed).toBe(row.committed);
  expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
}

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin,
    githubClientId: '', githubClientSecret: '', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  administrator = await session('admin'); author = await session(); player = await session(); other = await session();
  authorAgent = await credential(author);
  await fund(pools.runtime, administrator.actor, authorAgent.id, '100');
});
afterAll(async () => { await app.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('games paid directly from personal wallets', () => {
  it.each(['player', 'author'] as const)('freezes and settles the %s personal wallet, including an author playing with a distinct personal account', async payer => {
    const who = payer === 'player' ? player : author;
    if (payer === 'player') expect((await pools.runtime.query('SELECT count(*)::int n FROM agents WHERE owner_user_id=$1', [who.actor.userId])).rows[0].n).toBe(0);
    const value = await game(), key = randomUUID();
    const started = await Promise.all([start(value, who, key), start(value, who, key)]);
    const round = body<GameSessionDto>(started[0]!);
    expect(body<GameSessionDto>(started[1]!).id).toBe(round.id);
    expect(round).toMatchObject({ player_agent_id: null, player_user_id: who.actor.userId, status: 'playing', entry_fee: '5' });
    expect(await userWallet(who)).toEqual({ USER_AVAILABLE: '995', USER_RESERVED: '5' });
    expect(body(await get(who, '/wallet'))).toMatchObject({ available: '995', reserved: '5', initial_grant: '1000' });
    expect((await pools.runtime.query(`SELECT h.payer_agent_id,h.payer_user_id FROM credit_holds h
      JOIN arcade_game_sessions s ON s.fee_hold_id=h.id WHERE s.id=$1`, [round.id])).rows[0]).toEqual({ payer_agent_id: null, payer_user_id: who.actor.userId });
    const history = body<{ items: { id: string; kind: string; entries: { bucket: string; amount: string }[] }[] }>(await get(who, '/wallet/transactions?limit=1'));
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ kind: 'RESERVE', entries: expect.arrayContaining([
      expect.objectContaining({ bucket: 'USER_AVAILABLE', amount: '5' }), expect.objectContaining({ bucket: 'USER_RESERVED', amount: '5' }),
    ]) });
    expect(body<GameDto>(await get(who, `/games/${value.id}`)).pool_committed).toBe('10');
    expect(body<GameSessionDto>(await post(who, `/games/sessions/${round.id}/score`, { score: '20', reward_requested: '8' })).status).toBe('submitted');
    expect(await userWallet(who)).toEqual({ USER_AVAILABLE: '995', USER_RESERVED: '5' });
    const settleKey = randomUUID(), settlement = { reward_points: '7', reason: '核验个人钱包玩家成绩' };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(body<GameSessionDto>(await post(authorAgent, `/games/sessions/${round.id}/settle`, settlement, settleKey))).toMatchObject({ status: 'settled', reward_points: '7' });
    }
    expect(await userWallet(who)).toEqual({ USER_AVAILABLE: '1002', USER_RESERVED: '0' });
    expect(await agentWallet(authorAgent.id)).toEqual({ AVAILABLE: '45', RESERVED: '53' });
    expect(body<GameDto>(await get(who, `/games/${value.id}`))).toMatchObject({ pool_balance: '53', pool_committed: '0' });
    await pools.runtime.query('SELECT ledger.open_user_account($1)', [who.actor.userId]);
    expect(await userWallet(who)).toEqual({ USER_AVAILABLE: '1002', USER_RESERVED: '0' });
    expect((await pools.runtime.query('SELECT count(*)::int n FROM journal_transactions WHERE business_key=$1', [`initial-funds:user:${who.actor.userId}`])).rows[0].n).toBe(1);
    await expectConserved(value.id);
  });

  it('refunds a timed-out manual round to its original personal wallet once under competing retries', async () => {
    const value = await game(), round = body<GameSessionDto>(await start(value));
    body(await post(player, `/games/sessions/${round.id}/score`, { score: '12', reward_requested: '4' }));
    await expire(round.id);
    const key = randomUUID();
    const [first, second] = await Promise.all([
      post(player, `/games/sessions/${round.id}/refund`, {}, key),
      post(player, `/games/sessions/${round.id}/refund`, {}), processGameTimeouts(pools.runtime),
    ]);
    for (const response of [first, second]) expect(body<GameSessionDto>(response)).toMatchObject({ status: 'refunded', reward_points: '0', player_agent_id: null });
    expect(body<GameSessionDto>(await post(player, `/games/sessions/${round.id}/refund`, {}, key)).status).toBe('refunded');
    expect(await userWallet()).toEqual({ USER_AVAILABLE: '1000', USER_RESERVED: '0' });
    expect(await agentWallet(authorAgent.id)).toEqual({ AVAILABLE: '40', RESERVED: '60' });
    expect((await pools.runtime.query(`SELECT count(*)::int n FROM journal_transactions WHERE business_key=
      (SELECT 'hold:'||fee_hold_id||':finalize' FROM arcade_game_sessions WHERE id=$1)`, [round.id])).rows[0].n).toBe(1);
    await expectConserved(value.id);
  });

  it('pays fixed automatic rewards to the personal wallet and settles abandoned losing rounds without refunding the fee', async () => {
    const value = await game('starlight_slots_v1'), win = await vectorRound(value, 23);
    const result = await Promise.all([
      post(player, `/games/sessions/${win.id}/score`, { score: '999999', reward_requested: '999999' }),
      post(player, `/games/sessions/${win.id}/score`, { score: '0', reward_requested: '0' }),
    ]);
    for (const response of result) expect(body<GameSessionDto>(response)).toMatchObject({ status: 'settled', score: '100', reward_points: '3', reward_requested: '3', player_agent_id: null });
    expect(await userWallet()).toEqual({ USER_AVAILABLE: '1002', USER_RESERVED: '0' });
    const loss = await vectorRound(value, 2);
    await expire(loss.id);
    const [expired] = await Promise.all([post(player, `/games/sessions/${loss.id}/refund`, {}), processGameTimeouts(pools.runtime)]);
    expect(body<GameSessionDto>(expired)).toMatchObject({ status: 'settled', score: '0', reward_points: '0' });
    await processGameTimeouts(pools.runtime);
    expect(await userWallet()).toEqual({ USER_AVAILABLE: '1001', USER_RESERVED: '0' });
    expect(await agentWallet(authorAgent.id)).toEqual({ AVAILABLE: '72', RESERVED: '27' });
    expect(body<GameDto>(await get(player, `/games/${value.id}`))).toMatchObject({ pool_balance: '27', pool_committed: '0' });
    await expectConserved(value.id);
  });

  it('rolls back an unaffordable concurrent start and prevents transfers from consuming the frozen fee', async () => {
    const value = await game('manual', '600'), keys = [randomUUID(), randomUUID()];
    const requests = await Promise.all(keys.map(key => start(value, player, key)));
    expect(requests.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const winner = requests.findIndex(response => response.statusCode === 201), round = body<GameSessionDto>(requests[winner]!);
    const failed = requests.find(response => response.statusCode !== 201)!;
    expect(failed.json().error.code).toBe('INSUFFICIENT_FUNDS');
    expect(body<GameSessionDto>(await start(value, player, keys[winner])).id).toBe(round.id);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM arcade_game_sessions WHERE game_id=$1', [value.id])).rows[0].n).toBe(1);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM credit_holds WHERE payer_user_id=$1', [player.actor.userId])).rows[0].n).toBe(1);
    expect(body<GameDto>(await get(player, `/games/${value.id}`)).pool_committed).toBe('10');
    expect(await userWallet()).toEqual({ USER_AVAILABLE: '400', USER_RESERVED: '600' });
    const recipient = await credential(other);
    const transfer = (amount: string) => post(player, '/wallet/transfers', { transfer_id: randomUUID(),
      from: { type: 'user', id: player.actor.userId }, to: { type: 'agent', id: recipient.id }, amount });
    const tooMuch = await transfer('401');
    expect(tooMuch.statusCode, tooMuch.body).toBe(409);
    expect(tooMuch.json().error.code).toBe('INSUFFICIENT_FUNDS');
    body(await transfer('400'));
    expect(await userWallet()).toEqual({ USER_AVAILABLE: '0', USER_RESERVED: '600' });
    expect(await agentWallet(recipient.id)).toEqual({ AVAILABLE: '400', RESERVED: '0' });
    await expire(round.id); await processGameTimeouts(pools.runtime);
    expect(await userWallet()).toEqual({ USER_AVAILABLE: '600', USER_RESERVED: '0' });
    await pools.runtime.query('SELECT ledger.open_user_account($1)', [player.actor.userId]);
    expect(await userWallet()).toEqual({ USER_AVAILABLE: '600', USER_RESERVED: '0' });
    await expectConserved(value.id);
  });

  it('keeps personal sessions private from other users and even the player’s own Agent credentials, and honors suspension', async () => {
    const value = await game(), ownAgent = await credential(player), foreignAgent = await credential(other);
    await pools.runtime.query('UPDATE agent_policies SET can_trade=false,single_spend_limit=0,daily_spend_limit=0 WHERE agent_id=$1', [ownAgent.id]);
    const round = body<GameSessionDto>(await start(value));
    for (const who of [other, ownAgent, foreignAgent]) {
      denied(await get(who, `/games/sessions/${round.id}`));
      denied(await post(who, `/games/sessions/${round.id}/score`, { score: '1', reward_requested: '1' }));
      denied(await post(who, `/games/sessions/${round.id}/refund`, {}));
    }
    expect(body<{ items: GameSessionDto[] }>(await get(ownAgent, '/games/sessions')).items).toEqual([]);
    expect(body<{ items: GameSessionDto[] }>(await get(player, '/games/sessions')).items.map(value => value.id)).toEqual([round.id]);
    expect(body<GameSessionDto>(await get(authorAgent, `/games/sessions/${round.id}`)).id).toBe(round.id);
    denied(await start(value, ownAgent));
    const csrf = await app.inject({ method: 'POST', url: `/api/v1/games/${value.id}/sessions`, headers: { cookie: player.cookie }, payload: { game_version: value.version } });
    denied(csrf, 'CSRF_INVALID');
    await pools.runtime.query("UPDATE users SET status='suspended' WHERE id=$1", [player.actor.userId]);
    denied(await start(value), 'ACCOUNT_SUSPENDED');
    denied(await post(player, `/games/sessions/${round.id}/score`, { score: '1', reward_requested: '1' }), 'ACCOUNT_SUSPENDED');
    await expire(round.id); await processGameTimeouts(pools.runtime);
    expect(await userWallet()).toEqual({ USER_AVAILABLE: '1000', USER_RESERVED: '0' });
    expect((await pools.runtime.query('SELECT status FROM arcade_game_sessions WHERE id=$1', [round.id])).rows[0].status).toBe('refunded');
    await expectConserved(value.id);
  });

  it('retains explicit Agent payment and credential submission without charging the owner’s personal wallet', async () => {
    const value = await game(), legacy = await credential(player);
    await fund(pools.runtime, administrator.actor, legacy.id, '50');
    const round = body<GameSessionDto>(await post(legacy, `/games/${value.id}/sessions`, { agent_id: legacy.id, game_version: value.version }));
    expect(round).toMatchObject({ player_agent_id: legacy.id, player_user_id: player.actor.userId });
    expect(await agentWallet(legacy.id)).toEqual({ AVAILABLE: '45', RESERVED: '5' });
    expect(await userWallet()).toEqual({ USER_AVAILABLE: '1000', USER_RESERVED: '0' });
    body(await post(legacy, `/games/sessions/${round.id}/score`, { score: '20', reward_requested: '7' }));
    body(await post(authorAgent, `/games/sessions/${round.id}/settle`, { reward_points: '7', reason: '原Agent流程仍可用' }));
    expect(await agentWallet(legacy.id)).toEqual({ AVAILABLE: '52', RESERVED: '0' });
    expect(await userWallet()).toEqual({ USER_AVAILABLE: '1000', USER_RESERVED: '0' });
    await expectConserved(value.id);
  });
});
