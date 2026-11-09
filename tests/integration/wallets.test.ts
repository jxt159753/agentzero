import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../packages/contracts/src/index.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { lockActor, tokenHash } from '../../apps/api/src/core.js';
import { reconcile, reserve, setIssuanceLimit } from '../../apps/api/src/modules/ledger/service.js';
import { agent, context, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), origin = 'http://localhost:5173';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
type WalletRef = { type: 'user' | 'agent'; id: string };
type Transfer = { transfer_id: string; from: WalletRef; to: WalletRef; amount: string; reason?: string };
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: Session, other: Session;
let ownAgent: Awaited<ReturnType<typeof agent>>, otherAgent: Awaited<ReturnType<typeof agent>>;

async function session(role: 'admin' | 'member' = 'member', openWallet = true): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  if (openWallet) await pools.runtime.query('SELECT ledger.open_user_account($1)', [actor.userId]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
const userRef = (user: Session): WalletRef => ({ type: 'user', id: user.actor.userId });
const agentRef = (value: { id: string }): WalletRef => ({ type: 'agent', id: value.id });
const headers = (user = owner, key = randomUUID()) => ({ cookie: user.cookie, origin, 'x-csrf-token': user.csrf, 'idempotency-key': key });
const get = (path: string, user = owner) => app.inject({ url: `/api/v1${path}`, headers: { cookie: user.cookie } });
const transfer = (payload: Transfer, user = owner, key = randomUUID()) => app.inject({ method: 'POST', url: '/api/v1/wallet/transfers', headers: headers(user, key), payload });
const input = (from: WalletRef, to: WalletRef, amount: string): Transfer => ({ transfer_id: randomUUID(), from, to, amount });
async function send(from: WalletRef, to: WalletRef, amount: string, user = owner) {
  const response = await transfer(input(from, to, amount), user);
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { transaction_id: string };
}
async function balances() {
  return (await pools.runtime.query(`SELECT COALESCE(user_id,agent_id)::text id,bucket,balance
    FROM ledger_accounts WHERE user_id IS NOT NULL OR agent_id IS NOT NULL ORDER BY id,bucket`)).rows;
}
const report = () => withTransaction(pools.runtime, tx => reconcile(tx));

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin,
    githubClientId: 'wallet-test', githubClientSecret: 'wallet-test', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 3000 },
  github: { exchange: async code => ({ id: code, login: `wallet-oauth-${code}`, name: 'Wallet OAuth user', avatarUrl: null }) } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  owner = await session('admin'); other = await session();
  ownAgent = await agent(pools.runtime, owner.actor); otherAgent = await agent(pools.runtime, other.actor);
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('personal wallets, initial funds and owner-authorized transfers', () => {
  it('grants exactly 1000 once, including concurrent retries, without consuming the monthly issuance budget', async () => {
    const month = (await pools.runtime.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month")).rows[0].month as string;
    await withTransaction(pools.runtime, tx => setIssuanceLimit(tx, context(owner.actor), { month, limitPoints: '0', reason: 'no manual issuance' }));
    const fresh = await session('member', false);
    await Promise.all(Array.from({ length: 3 }, () => pools.runtime.query('SELECT ledger.open_user_account($1)', [fresh.actor.userId])));
    await pools.runtime.query('SELECT ledger.open_user_account($1)', [fresh.actor.userId]);
    expect((await get('/wallet', fresh)).json()).toMatchObject({ user_id: fresh.actor.userId, available: '1000', initial_grant: '1000' });
    expect((await pools.runtime.query("SELECT count(*)::int n FROM ledger_accounts WHERE user_id=$1", [fresh.actor.userId])).rows[0].n).toBe(2);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions WHERE kind='INITIAL_GRANT'")).rows[0].n).toBe(3);
    expect((await pools.runtime.query('SELECT limit_points,issued_points FROM credit_issuance_periods')).rows[0]).toEqual({ limit_points: '0', issued_points: '0' });
    expect(await report()).toMatchObject({ ok: true, totals: { circulating: '3000', issuanceControl: '3000', issued: '3000' } });
  });

  it('opens the wallet on real OAuth callback and keeps the grant unchanged on later logins', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = await app.inject({ url: '/api/v1/auth/github/start' });
      expect(start.statusCode, start.body).toBe(302);
      const state = new URL(start.headers.location!).searchParams.get('state')!;
      const cookie = `az_oauth=${start.cookies.find(value => value.name === 'az_oauth')!.value}`;
      const callback = await app.inject({ url: `/api/v1/auth/github/callback?state=${state}&code=987654321`, headers: { cookie } });
      expect(callback.statusCode, callback.body).toBe(302);
    }
    expect((await pools.runtime.query(`SELECT a.balance FROM users u JOIN ledger_accounts a ON a.user_id=u.id
      WHERE u.github_user_id=987654321 AND a.bucket='USER_AVAILABLE'`)).rows).toEqual([{ balance: '1000' }]);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions WHERE kind='INITIAL_GRANT'")).rows[0].n).toBe(3);
    expect((await report()).ok).toBe(true);
  });

  it('rolls back wallet creation, initial issuance and audit together if the enclosing transaction fails', async () => {
    const fresh = await session('member', false);
    const before = await balances();
    const auditCount = (await pools.runtime.query('SELECT count(*)::int n FROM audit_events')).rows[0].n;
    await expect(withTransaction(pools.runtime, async tx => {
      await tx.query('SELECT ledger.open_user_account($1)', [fresh.actor.userId]);
      throw new Error('abort initial grant');
    })).rejects.toThrow('abort initial grant');
    expect(await balances()).toEqual(before);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM audit_events')).rows[0].n).toBe(auditCount);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions WHERE kind='INITIAL_GRANT'")).rows[0].n).toBe(2);
    await pools.runtime.query('SELECT ledger.open_user_account($1)', [fresh.actor.userId]);
    expect((await get('/wallet', fresh)).json().available).toBe('1000');
    expect((await report()).ok).toBe(true);
  });

  it('supports all four user/Agent transfer directions with conserved balances and private paginated history', async () => {
    await pools.runtime.query('UPDATE agent_policies SET can_trade=false,single_spend_limit=0,daily_spend_limit=0');
    await send(userRef(owner), userRef(other), '100');
    await send(userRef(owner), agentRef(ownAgent), '200');
    const betweenAgents = await send(agentRef(ownAgent), agentRef(otherAgent), '75');
    await send(agentRef(ownAgent), userRef(owner), '25');
    await send(agentRef(otherAgent), userRef(owner), '75', other);
    expect((await get('/wallet')).json()).toMatchObject({ user_id: owner.actor.userId, available: '800' });
    expect((await get('/wallet', other)).json()).toMatchObject({ user_id: other.actor.userId, available: '1100' });
    expect((await get(`/agents/${ownAgent.id}/wallet`)).json()).toMatchObject({ available: '100', reserved: '0', daily_spent: '100' });
    expect((await get(`/agents/${otherAgent.id}/wallet`, other)).json()).toMatchObject({ available: '0', reserved: '0', daily_spent: '75' });
    expect((await get(`/agents/${ownAgent.id}/wallet`, other)).statusCode).toBe(403);
    const firstPage = (await get('/wallet/transactions?limit=2')).json();
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    const nextPage = (await get(`/wallet/transactions?limit=2&cursor=${encodeURIComponent(firstPage.next_cursor)}`)).json();
    const ids = [...firstPage.items, ...nextPage.items].map((row: { id: string }) => row.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain(betweenAgents.transaction_id);
    expect((await get('/wallet/transactions', other)).json().items).toHaveLength(2);
    expect(await report()).toMatchObject({ ok: true, totals: { circulating: '2000', issuanceControl: '2000', issued: '2000' } });
  });

  it('deduplicates retries across request keys and rejects changed payloads for either idempotency key', async () => {
    const payload = input(userRef(owner), userRef(other), '125'), key = randomUUID();
    const responses = await Promise.all([transfer(payload, owner, key), transfer(payload, owner, key), transfer(payload)]);
    for (const response of responses) expect(response.statusCode, response.body).toBe(201);
    expect(responses[0].json()).toEqual(responses[1].json());
    expect(new Set(responses.map(response => response.json().transaction_id)).size).toBe(1);
    const replay = await transfer(payload);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().created).toBe(false);
    for (const requestKey of [key, randomUUID()]) {
      const conflict = await transfer({ ...payload, amount: '126' }, owner, requestKey);
      expect(conflict.statusCode, conflict.body).toBe(409);
    }
    expect((await get('/wallet')).json().available).toBe('875');
    expect((await get('/wallet', other)).json().available).toBe('1125');
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions WHERE kind='TRANSFER'")).rows[0].n).toBe(1);
  });

  it('serializes competing withdrawals and opposite-direction transfers without lost money or partial receipts', async () => {
    const withdrawals = await Promise.all([transfer(input(userRef(owner), userRef(other), '700')), transfer(input(userRef(owner), agentRef(otherAgent), '700'))]);
    expect(withdrawals.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect((await get('/wallet')).json().available).toBe('300');
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions WHERE kind='TRANSFER'")).rows[0].n).toBe(1);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM idempotency_requests')).rows[0].n).toBe(1);
    const opposite = await Promise.all([transfer(input(userRef(owner), userRef(other), '100')), transfer(input(userRef(other), userRef(owner), '100'), other)]);
    for (const response of opposite) expect(response.statusCode, response.body).toBe(201);
    expect((await get('/wallet')).json().available).toBe('300');
    expect((await report()).ok).toBe(true);
  });

  it('requires a human owner session and CSRF, rejecting foreign source wallets without creating any transfer', async () => {
    const payload = input(userRef(owner), userRef(other), '1'), before = await balances();
    expect((await transfer(payload, other)).statusCode).toBe(403);
    expect((await transfer(input(agentRef(otherAgent), userRef(owner), '1'))).statusCode).toBe(403);
    const csrf = await app.inject({ method: 'POST', url: '/api/v1/wallet/transfers', headers: { cookie: owner.cookie }, payload });
    expect(csrf.statusCode, csrf.body).toBe(403);
    expect(csrf.json().error.code).toBe('CSRF_INVALID');
    const token = `azk_${ownAgent.actor.credentialId}.${randomBytes(32).toString('base64url')}`;
    await pools.migration.query('UPDATE agent_keys SET secret_hash=$2 WHERE id=$1', [ownAgent.actor.credentialId, tokenHash(token)]);
    const bearer = { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() };
    const automated = await app.inject({ method: 'POST', url: '/api/v1/wallet/transfers', headers: bearer, payload: input(agentRef(ownAgent), userRef(owner), '1') });
    expect(automated.statusCode, automated.body).toBe(403);
    expect((await app.inject({ url: '/api/v1/wallet', headers: bearer })).statusCode).toBe(403);
    expect(await balances()).toEqual(before);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions WHERE kind='TRANSFER'")).rows[0].n).toBe(0);
  });

  it('rejects invalid, same-wallet and unaffordable amounts with no journal or receipt left behind', async () => {
    const before = await balances();
    for (const amount of ['0', '-1', '1.5', '01', '9223372036854775808']) {
      const result = await transfer(input(userRef(owner), userRef(other), amount));
      expect(result.statusCode, result.body).toBe(400);
    }
    const same = await transfer(input(userRef(owner), userRef(owner), '1'));
    expect([400, 409]).toContain(same.statusCode);
    const tooMuch = await transfer(input(userRef(owner), userRef(other), '1001'));
    expect(tooMuch.statusCode, tooMuch.body).toBe(409);
    expect(tooMuch.json().error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balances()).toEqual(before);
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions WHERE kind='TRANSFER'")).rows[0].n).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM idempotency_requests')).rows[0].n).toBe(0);
    expect((await report()).ok).toBe(true);
  });

  it('keeps held funds unavailable while allowing the owner to recover a paused Agent balance', async () => {
    await send(userRef(owner), agentRef(ownAgent), '200');
    await withTransaction(pools.runtime, async tx => {
      await lockActor(tx, owner.actor, { agentId: ownAgent.id });
      await reserve(tx, context(owner.actor), { businessRef: `wallet-hold:${randomUUID()}`, payerAgentId: ownAgent.id, amount: '150', permission: 'can_trade', reason: 'retain committed funds' });
    });
    await pools.runtime.query("UPDATE agents SET status='paused' WHERE id=$1", [ownAgent.id]);
    const blocked = await transfer(input(agentRef(ownAgent), userRef(owner), '100'));
    expect(blocked.statusCode, blocked.body).toBe(409);
    await send(agentRef(ownAgent), userRef(owner), '50');
    expect((await get('/wallet')).json().available).toBe('850');
    expect((await get(`/agents/${ownAgent.id}/wallet`)).json()).toMatchObject({ available: '0', reserved: '150', held: '150' });
    expect((await report()).ok).toBe(true);
  });

  it('excludes suspended users and deleted Agents from search and rejects transfers to their wallets', async () => {
    const foundUser = (await get(`/wallet/recipients?q=${other.actor.userId}`)).json().items;
    expect(foundUser).toContainEqual(expect.objectContaining({ type: 'user', id: other.actor.userId }));
    expect(JSON.stringify(foundUser)).not.toMatch(/available|balance|secret/);
    expect((await get(`/wallet/recipients?q=${otherAgent.id}`)).json().items).toContainEqual(expect.objectContaining({ type: 'agent', id: otherAgent.id }));
    await pools.runtime.query("UPDATE users SET status='suspended' WHERE id=$1", [other.actor.userId]);
    expect((await get(`/wallet/recipients?q=${other.actor.userId}`)).json().items).toEqual([]);
    expect((await get(`/wallet/recipients?q=${otherAgent.id}`)).json().items).toEqual([]);
    for (const target of [userRef(other), agentRef(otherAgent)]) {
      const blocked = await transfer(input(userRef(owner), target, '1'));
      expect([403, 404, 409]).toContain(blocked.statusCode);
    }
    expect((await transfer(input(userRef(other), userRef(owner), '1'), other)).statusCode).toBe(403);
    await pools.runtime.query("UPDATE users SET status='active' WHERE id=$1", [other.actor.userId]);
    await pools.runtime.query("UPDATE agents SET status='paused',deleted_at=clock_timestamp() WHERE id=$1", [otherAgent.id]);
    expect((await get(`/wallet/recipients?q=${otherAgent.id}`)).json().items).toEqual([]);
    const deleted = await transfer(input(userRef(owner), agentRef(otherAgent), '1'));
    expect([403, 404, 410]).toContain(deleted.statusCode);
    expect((await get('/wallet')).json().available).toBe('1000');
  });

  it('preserves bigint amounts beyond Number precision when moving Agent funds into a personal wallet', async () => {
    const amount = '9007199254740993';
    await fund(pools.runtime, owner.actor, ownAgent.id, amount);
    const moved = await send(agentRef(ownAgent), userRef(owner), amount);
    expect((await get('/wallet')).json().available).toBe('9007199254741993');
    const history = (await get('/wallet/transactions')).json().items;
    expect(history.find((row: { id: string }) => row.id === moved.transaction_id)).toMatchObject({ amount, side: 'debit' });
    expect((await get(`/agents/${ownAgent.id}/wallet`)).json()).toMatchObject({ available: '0', daily_spent: amount });
    expect((await report()).ok).toBe(true);
  });
});
