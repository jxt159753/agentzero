import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { createAgentZeroServer } from '../../packages/agentzero/src/server.js';
import { loadConfig } from '../../packages/agentzero/src/config.js';
import { identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools();
const origin = 'http://localhost:5173';
let app: Awaited<ReturnType<typeof buildApp>>, apiUrl: string, folder: string;
const connected: { client: Client; server: ReturnType<typeof createAgentZeroServer> }[] = [];

async function connect(file: string) {
  const server = createAgentZeroServer(loadConfig({ AGENTZERO_API_URL: apiUrl }, file));
  const client = new Client({ name: 'registration-integration', version: '1.0.0' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  connected.push({ client, server });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name: `agentzero_${name}`, arguments: args });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  expect(JSON.stringify(result)).not.toContain('azk_');
  return result.structuredContent as Record<string, any>;
}

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: {
    databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: '', githubClientSecret: '',
    bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0,
  } });
  apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  folder = await mkdtemp(join(tmpdir(), 'agentzero-registration-integration-'));
});
afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
  await rm(folder, { recursive: true, force: true });
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

it.each(['codex', 'dsh'] as const)('%s registers through real MCP and HTTP, resumes after restart and connects without exposing a key', async host => {
  const file = join(folder, 'config.json');
  let client = await connect(file);
  const input = { client: host, name: `${host} 注册测试`, api_url: apiUrl };
  const started = await call(client, 'register', input);
  expect(started.status).toBe('pending');
  const url = new URL(started.verification_uri);
  expect(url.pathname).toBe('/connect');
  const id = url.searchParams.get('request')!;
  const code = new URLSearchParams(url.hash.slice(1)).get('code')!;
  expect((await pools.runtime.query('SELECT count(*)::int n FROM agents')).rows[0].n).toBe(0);
  await client.close();
  client = await connect(file);
  expect((await call(client, 'register', input)).verification_uri).toBe(started.verification_uri);

  const actor = await identity(pools.runtime);
  if (actor.type !== 'user') throw new Error('User fixture required');
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  const approved = await app.inject({ method: 'POST', url: `/api/v1/agent-registrations/${id}/approve`,
    headers: { cookie: `az_session=${token}`, origin, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() },
    payload: { verification_code: code, name: `${host} 已确认` },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  expect(approved.body).not.toContain('azk_');
  const completed = await call(client, 'register', input);
  expect(completed).toMatchObject({ status: 'connected', agent_id: approved.json().agent_id });
  const me = await call(client, 'identity');
  expect(me.actor.agentId).toBe(completed.agent_id);
  expect(me.user.id).toBe(actor.userId);
  expect(me.policy).toMatchObject({ can_accept_task: false, can_collaborate: false, can_trade: false, can_redeem_api: false });
  expect(await call(client, 'wallet')).toMatchObject({ available: '0', reserved: '0' });
  const saved = await readFile(file, 'utf8');
  expect(loadConfig({}, file).agentKey).toMatch(/^azk_/);
  await call(client, 'register', input);
  expect(await readFile(file, 'utf8')).toBe(saved);
  expect((await pools.runtime.query('SELECT count(*)::int n FROM agents')).rows[0].n).toBe(1);
  expect((await pools.runtime.query('SELECT count(*)::int n FROM agent_keys')).rows[0].n).toBe(1);
  const restarted = await connect(file);
  expect((await call(restarted, 'identity')).actor.agentId).toBe(completed.agent_id);
});
