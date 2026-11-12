import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), origin = 'http://localhost:5173';
let app: Awaited<ReturnType<typeof buildApp>>;
type Session = { cookie: string; csrf: string; userId: string };
const headers = (session: Session, key: string = randomUUID()) => ({ cookie: session.cookie, origin, 'x-csrf-token': session.csrf, 'idempotency-key': key });

async function login(id: string): Promise<Session> {
  const start = await app.inject('/api/v1/auth/github/start');
  const state = new URL(start.headers.location!).searchParams.get('state')!;
  const result = await app.inject({ url: `/api/v1/auth/github/callback?state=${state}&code=${id}`, headers: { cookie: `az_oauth=${start.cookies.find(cookie => cookie.name === 'az_oauth')!.value}` } });
  expect(result.statusCode, result.body).toBe(302);
  const cookie = `az_session=${result.cookies.find(item => item.name === 'az_session')!.value}`, csrf = result.cookies.find(item => item.name === 'az_csrf')!.value;
  const me = (await app.inject({ url: '/api/v1/me', headers: { cookie } })).json();
  return { cookie, csrf, userId: me.user.id };
}

beforeEach(async () => {
  await app?.close();
  await resetLedgerTestData(pools.migration);
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test', githubClientSecret: 'test', bootstrapAdminGithubId: '1', production: false, host: '127.0.0.1', port: 0, registrationMode: 'public', maxAgentsPerUser: 2, worldMaxConnections: 2, worldMaxConnectionsPerUser: 1 },
    github: { exchange: async id => ({ id, login: `public-${id}`, name: `Public ${id}`, avatarUrl: null }) } });
  await app.ready();
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('public launch with real PostgreSQL', () => {
  it('admits new and pending members without reviving suspended users or granting admin rights', async () => {
    expect((await app.inject('/api/v1/public-config')).json()).toEqual({ registration_mode: 'public' });
    const member = await login('2');
    const me = async (session: Session) => (await app.inject({ url: '/api/v1/me', headers: { cookie: session.cookie } })).json().user;
    expect(await me(member)).toMatchObject({ role: 'member', status: 'active' });
    await pools.migration.query("UPDATE users SET status='pending' WHERE id=$1", [member.userId]);
    expect(await me(await login('2'))).toMatchObject({ role: 'member', status: 'active' });
    await pools.migration.query("UPDATE users SET status='suspended' WHERE id=$1", [member.userId]);
    expect(await me(await login('2'))).toMatchObject({ role: 'member', status: 'suspended' });
    const admin = await login('1');
    expect(await me(admin)).toMatchObject({ role: 'admin', status: 'active' });
    await pools.migration.query("UPDATE users SET status='suspended' WHERE id=$1", [admin.userId]);
    expect(await me(await login('1'))).toMatchObject({ role: 'admin', status: 'suspended' });
  });

  it('serializes Agent creation quotas while retaining idempotent retries and existing-Agent registration', async () => {
    const owner = await login('2'), keys = [randomUUID(), randomUUID(), randomUUID()];
    const create = (key: string) => app.inject({ method: 'POST', url: '/api/v1/agents', headers: headers(owner, key), payload: { name: 'Public Agent' } });
    const created = await Promise.all(keys.map(create));
    expect(created.filter(result => result.statusCode === 201)).toHaveLength(2);
    expect(created.find(result => result.statusCode === 409)?.json().error.code).toBe('AGENT_LIMIT_EXCEEDED');
    const success = created.findIndex(result => result.statusCode === 201);
    expect((await create(keys[success]!)).json()).toEqual(created[success]!.json());
    const id = randomUUID(), code = randomBytes(32).toString('base64url');
    await app.inject({ method: 'POST', url: '/api/v1/agent-registrations', payload: { id, client: 'codex', name: 'New Agent', credential_hash: tokenHash('credential').toString('hex'), verification_hash: tokenHash(code).toString('hex') } });
    const denied = await app.inject({ method: 'POST', url: `/api/v1/agent-registrations/${id}/approve`, headers: headers(owner), payload: { verification_code: code } });
    expect(denied.json().error.code).toBe('AGENT_LIMIT_EXCEEDED');
    const linked = await app.inject({ method: 'POST', url: `/api/v1/agent-registrations/${id}/approve`, headers: headers(owner), payload: { verification_code: code, agent_id: created[success]!.json().id } });
    expect(linked.statusCode, linked.body).toBe(200);
    expect((await pools.runtime.query('SELECT count(*)::int AS n FROM agents WHERE owner_user_id=$1', [owner.userId])).rows[0].n).toBe(2);
  });

  it('bounds all WebSocket protocols and owner connections while allowing reconnect at capacity', async () => {
    const alice = await login('2'), bob = await login('3'), carol = await login('4');
    const created = (await app.inject({ method: 'POST', url: '/api/v1/agents', headers: headers(alice), payload: { name: 'Alice Agent' } })).json();
    const key = (await app.inject({ method: 'POST', url: `/api/v1/agents/${created.id}/keys`, headers: headers(alice), payload: { label: 'capacity test' } })).json().secret as string;
    const sockets: WebSocket[] = [];
    async function connect(requestHeaders: Record<string, string>, legacy = false) {
      const state = { snapshots: 0, closeCode: 0, closeReason: '' };
      const socket = await app.injectWS(`/api/v1/world/stream${legacy ? '' : '?v=2'}`, { headers: requestHeaders }, { onInit: ws => {
        ws.on('message', data => { if (JSON.parse(data.toString()).type === 'snapshot') state.snapshots++; });
        ws.on('close', (code, reason) => { state.closeCode = code; state.closeReason = reason.toString(); });
      } });
      sockets.push(socket); return { socket, state };
    }
    try {
      const first = await connect({ cookie: alice.cookie, origin });
      await expect.poll(() => first.state.snapshots).toBe(1);
      const sibling = await connect({ authorization: `Bearer ${key}` }, true);
      await expect.poll(() => sibling.state.closeReason).toBe('WORLD_USER_CONNECTION_LIMIT');
      expect(sibling.state.closeCode).toBe(1008);
      const second = await connect({ cookie: bob.cookie, origin }, true);
      await expect.poll(() => second.state.snapshots).toBeGreaterThan(0);
      const excess = await connect({ cookie: carol.cookie, origin });
      await expect.poll(() => excess.state.closeReason).toBe('WORLD_CAPACITY_REACHED');
      expect(excess.state.closeCode).toBe(1013);
      const replacement = await connect({ cookie: alice.cookie, origin });
      await expect.poll(() => replacement.state.snapshots).toBe(1);
      await expect.poll(() => first.state.closeCode).toBe(1008);
      second.socket.terminate();
      await expect.poll(() => second.socket.readyState).toBe(second.socket.CLOSED);
      const admitted = await connect({ cookie: carol.cookie, origin });
      await expect.poll(() => admitted.state.snapshots).toBe(1);
    } finally { for (const socket of sockets) socket.terminate(); }
  });
});
