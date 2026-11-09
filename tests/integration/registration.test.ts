import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools();
const origin = 'http://localhost:5173';
let app: Awaited<ReturnType<typeof buildApp>>;
let githubId = 1000;
type Session = { userId: string; cookie: string; csrf: string };
function registration(client: 'codex' | 'dsh' = 'codex') {
  const id = randomUUID(), secret = `azk_${id}.${randomBytes(32).toString('base64url')}`, code = randomBytes(32).toString('base64url');
  return { id, secret, code, input: { id, client, name: `${client} 助手`, credential_hash: tokenHash(secret).toString('hex'), verification_hash: tokenHash(code).toString('hex') } };
}
type Registration = ReturnType<typeof registration>;
async function session(status = 'active'): Promise<Session> {
  const userId = randomUUID(), sessionId = randomUUID(), csrf = randomBytes(32).toString('base64url'), token = randomBytes(32).toString('base64url');
  await pools.migration.query('INSERT INTO users(id,github_user_id,github_login,display_name,status) VALUES($1,$2,$3,$3,$4)', [userId, ++githubId, `registration-${userId}`, status]);
  await pools.migration.query("INSERT INTO user_sessions(id,user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 day')", [sessionId, userId, tokenHash(token), tokenHash(csrf)]);
  return { userId, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
const headers = (owner: Session, key = randomUUID()) => ({ cookie: owner.cookie, origin, 'x-csrf-token': owner.csrf, 'idempotency-key': key });
const start = (input: Registration['input']) => app.inject({ method: 'POST', url: '/api/v1/agent-registrations', payload: input });
const status = (r: Registration, secret = r.secret) => app.inject({ url: `/api/v1/agent-registrations/${r.id}/status`, headers: { authorization: `Bearer ${secret}` } });
const inspect = (r: Registration, owner: Session, code = r.code) => app.inject({ url: `/api/v1/agent-registrations/${r.id}?code=${code}`, headers: { cookie: owner.cookie } });
const approve = (r: Registration, owner: Session, extra: { name?: string; agent_id?: string } = {}, key = randomUUID()) => app.inject({ method: 'POST', url: `/api/v1/agent-registrations/${r.id}/approve`, headers: headers(owner, key), payload: { verification_code: r.code, ...extra } });
async function counts() {
  return (await pools.runtime.query('SELECT (SELECT count(*)::int FROM agents) agents,(SELECT count(*)::int FROM agent_keys) keys')).rows[0];
}

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test', githubClientSecret: 'test', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 3000 } });
  await app.ready();
});
beforeEach(() => resetLedgerTestData(pools.migration));
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('client initiated Agent registration', () => {
  it('creates an owned zero-budget Agent and usable client credential after browser approval only', async () => {
    const r = registration(), owner = await session();
    const created = await start(r.input);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ id: r.id, client: 'codex', name: r.input.name, status: 'pending' });
    expect(await counts()).toEqual({ agents: 0, keys: 0 });
    expect((await status(r)).json().status).toBe('pending');
    expect((await inspect(r, owner)).json().status).toBe('pending');
    expect((await app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${r.secret}` } })).statusCode).toBe(401);
    const approved = await approve(r, owner, { name: '我的 Codex' });
    expect(approved.statusCode, approved.body).toBe(200);
    const result = approved.json();
    expect(result).toMatchObject({ id: r.id, key_id: r.id, status: 'approved' });
    expect((await status(r)).json()).toMatchObject({ agent_id: result.agent_id, key_id: r.id, status: 'approved' });
    const me = await app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${r.secret}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({ actor: { type: 'agent', agentId: result.agent_id }, user: { id: owner.userId }, policy: { can_accept_task: false, can_collaborate: false, can_trade: false, can_redeem_api: false, single_spend_limit: '0', daily_spend_limit: '0' } });
    expect((await pools.runtime.query('SELECT name,owner_user_id FROM agents WHERE id=$1', [result.agent_id])).rows[0]).toEqual({ name: '我的 Codex', owner_user_id: owner.userId });
    expect((await pools.runtime.query('SELECT balance FROM ledger_accounts WHERE agent_id=$1', [result.agent_id])).rows.map(row => row.balance)).toEqual(['0', '0']);
    const stored = JSON.stringify((await pools.runtime.query('SELECT response_body FROM idempotency_requests')).rows)
      + JSON.stringify((await pools.runtime.query('SELECT details FROM audit_events')).rows);
    for (const privateValue of [r.secret, r.code, r.input.credential_hash, r.input.verification_hash]) {
      expect(created.body + approved.body + stored).not.toContain(privateValue);
    }
  });

  it('replays starts and concurrent approvals without duplicate Agents or keys', async () => {
    const r = registration(), owner = await session(), key = randomUUID();
    const first = await start(r.input), replay = await start(r.input);
    expect(replay.json()).toEqual(first.json());
    const approvals = await Promise.all([approve(r, owner, {}, key), approve(r, owner, {}, key), approve(r, owner)]);
    expect(approvals.map(response => response.statusCode)).toEqual([200, 200, 200]);
    expect(new Set(approvals.map(response => response.json().agent_id)).size).toBe(1);
    expect(await counts()).toEqual({ agents: 1, keys: 1 });
    expect((await start(r.input)).json().status).toBe('approved');
    const conflict = await start({ ...r.input, name: 'another request' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('REGISTRATION_CONFLICT');
  });

  it('binds an existing owned active Agent without changing its wallet or policy', async () => {
    const r = registration('dsh'), owner = await session();
    const created = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: headers(owner), payload: { name: '已有 Agent' } });
    const agentId = created.json().id as string;
    await start(r.input);
    const response = await approve(r, owner, { agent_id: agentId });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ agent_id: agentId, status: 'approved' });
    expect(await counts()).toEqual({ agents: 1, keys: 1 });
    expect((await pools.runtime.query('SELECT name FROM agents WHERE id=$1', [agentId])).rows[0].name).toBe('已有 Agent');
    expect((await pools.runtime.query('SELECT label FROM agent_keys WHERE id=$1', [r.id])).rows[0].label).toBe('DSH');
  });

  it('rejects foreign ownership, invalid browser proofs, and Agent credentials approving registration', async () => {
    const r = registration(), owner = await session(), other = await session();
    await start(r.input);
    expect((await inspect(r, owner, randomBytes(32).toString('base64url'))).statusCode).toBe(403);
    const wrongCode = await app.inject({ method: 'POST', url: `/api/v1/agent-registrations/${r.id}/approve`, headers: headers(owner), payload: { verification_code: randomBytes(32).toString('base64url') } });
    expect(wrongCode.statusCode).toBe(403);
    const accepted = await approve(r, owner);
    expect((await inspect(r, other)).statusCode).toBe(403);
    expect((await approve(r, other)).statusCode).toBe(403);
    const next = registration(); await start(next.input);
    expect((await approve(next, other, { agent_id: accepted.json().agent_id })).statusCode).toBe(403);
    const selfApproved = await app.inject({ method: 'POST', url: `/api/v1/agent-registrations/${next.id}/approve`, headers: { authorization: `Bearer ${r.secret}`, 'idempotency-key': randomUUID() }, payload: { verification_code: next.code } });
    expect(selfApproved.statusCode).toBe(403);
    expect(await counts()).toEqual({ agents: 1, keys: 1 });
  });

  it('requires login, same-origin CSRF proof and active account before approval', async () => {
    const r = registration(), owner = await session(), pending = await session('pending'), suspended = await session('suspended');
    await start(r.input);
    expect((await app.inject({ url: `/api/v1/agent-registrations/${r.id}?code=${r.code}` })).statusCode).toBe(401);
    for (const invalid of [{ cookie: owner.cookie }, { ...headers(owner), origin: 'https://foreign.example' }, { ...headers(owner), 'x-csrf-token': 'wrong' }]) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/agent-registrations/${r.id}/approve`, headers: invalid, payload: { verification_code: r.code } });
      expect(response.json().error.code).toBe('CSRF_INVALID');
    }
    expect((await approve(r, pending)).json().error.code).toBe('ACCOUNT_PENDING');
    expect((await approve(r, suspended)).json().error.code).toBe('ACCOUNT_SUSPENDED');
    expect(await counts()).toEqual({ agents: 0, keys: 0 });
  });

  it('rejects expired requests and incorrect credential proofs without issuing credentials', async () => {
    const r = registration(), owner = await session();
    await start(r.input);
    expect((await app.inject({ url: `/api/v1/agent-registrations/${r.id}/status` })).statusCode).toBe(401);
    expect((await status(r, `azk_${r.id}.${randomBytes(32).toString('base64url')}`)).statusCode).toBe(401);
    expect((await status(r, registration().secret)).statusCode).toBe(401);
    await pools.migration.query("UPDATE agent_registrations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [r.id]);
    expect((await status(r)).statusCode).toBe(410);
    expect((await inspect(r, owner)).statusCode).toBe(410);
    expect((await approve(r, owner)).statusCode).toBe(410);
    expect((await start(r.input)).statusCode).toBe(410);
    expect(await counts()).toEqual({ agents: 0, keys: 0 });
  });

  it('requires an active existing Agent and rejects revoked, expired, paused or suspended approved access', async () => {
    const r = registration(), owner = await session();
    const created = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: headers(owner), payload: { name: 'existing' } });
    const agentId = created.json().id as string;
    await start(r.input);
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [agentId]);
    expect((await approve(r, owner, { agent_id: agentId })).json().error.code).toBe('AGENT_PAUSED');
    await pools.migration.query("UPDATE agents SET status='active' WHERE id=$1", [agentId]);
    expect((await approve(r, owner, { agent_id: agentId })).statusCode).toBe(200);
    await pools.migration.query("UPDATE agent_registrations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [r.id]);
    expect((await status(r)).statusCode).toBe(200);
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [agentId]);
    expect((await status(r)).json().error.code).toBe('AGENT_PAUSED');
    await pools.migration.query("UPDATE agents SET status='active' WHERE id=$1", [agentId]);
    await pools.migration.query("UPDATE users SET status='suspended' WHERE id=$1", [owner.userId]);
    expect((await status(r)).json().error.code).toBe('ACCOUNT_SUSPENDED');
    await pools.migration.query("UPDATE users SET status='active' WHERE id=$1", [owner.userId]);
    await pools.migration.query("UPDATE agent_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [r.id]);
    expect((await status(r)).json().error.code).toBe('CREDENTIAL_REVOKED');
    await pools.migration.query("UPDATE agent_keys SET expires_at=clock_timestamp()+interval '1 day',revoked_at=clock_timestamp() WHERE id=$1", [r.id]);
    expect((await status(r)).json().error.code).toBe('CREDENTIAL_REVOKED');
  });

  it('reserves expired registration IDs across later requests so old links cannot be revived', async () => {
    const expired = registration(), later = registration(), owner = await session();
    await start(expired.input);
    await pools.migration.query("UPDATE agent_registrations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
    expect((await start(later.input)).statusCode).toBe(201);
    const replay = await start(expired.input);
    expect(replay.statusCode).toBe(410);
    expect(replay.json().error.code).toBe('REGISTRATION_EXPIRED');
    const replaced = await start({ ...expired.input, credential_hash: tokenHash(`azk_${expired.id}.${randomBytes(32).toString('base64url')}`).toString('hex') });
    expect(replaced.statusCode).toBe(409);
    expect(replaced.json().error.code).toBe('REGISTRATION_CONFLICT');
    expect((await inspect(expired, owner)).statusCode).toBe(410);
    expect((await approve(expired, owner)).statusCode).toBe(410);
    expect(await counts()).toEqual({ agents: 0, keys: 0 });
  });
});
