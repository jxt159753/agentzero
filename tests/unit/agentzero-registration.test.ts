import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentZeroServer } from '../../packages/agentzero/src/server.js';
import { loadConfig } from '../../packages/agentzero/src/config.js';

const folders: string[] = [];
const connections: { client: Client; server: ReturnType<typeof createAgentZeroServer> }[] = [];
const fetcher = vi.fn<typeof fetch>();
const agentId = '11111111-1111-4111-8111-111111111111';
const input = { client: 'codex', name: '我的 Codex', api_url: 'https://agentzero.example' };
type Pending = { id: string; secret: string; verification_code: string; client: string; name: string; api_url: string };
let configFile: string;
let approved: boolean;
const pending = () => JSON.parse(readFileSync(`${configFile}.registration.json`, 'utf8')) as Pending;

beforeEach(() => {
  const folder = mkdtempSync(join(tmpdir(), 'agentzero-registration-'));
  folders.push(folder); configFile = join(folder, 'config.json'); approved = false;
  fetcher.mockReset(); vi.stubGlobal('fetch', fetcher);
  fetcher.mockImplementation(async (url, options) => {
    const request = new URL(String(url));
    const value = existsSync(`${configFile}.registration.json`) ? pending() : undefined;
    if (request.pathname === '/api/v1/me') return Response.json({ actor: { type: 'agent', agentId }, user: { github_login: 'owner' } });
    expect(value).toBeDefined();
    if (options?.method === 'POST') {
      const sent = JSON.parse(String(options.body));
      expect(sent).toEqual({ id: value!.id, client: input.client, name: input.name,
        credential_hash: createHash('sha256').update(value!.secret).digest('hex'), verification_hash: createHash('sha256').update(value!.verification_code).digest('hex') });
      expect(String(options.body)).not.toContain(value!.secret);
      expect(options.headers).not.toHaveProperty('authorization');
    } else expect(options?.headers).toMatchObject({ authorization: `Bearer ${value!.secret}` });
    return Response.json({ id: value!.id, status: approved ? 'approved' : 'pending', expires_at: new Date(Date.now() + 600000).toISOString(), ...(approved ? { agent_id: agentId, key_id: value!.id } : {}), injected_secret: value!.secret });
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(connections.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
async function connect() {
  const server = createAgentZeroServer(loadConfig({}, configFile));
  const client = new Client({ name: 'registration-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  connections.push({ client, server }); return client;
}
const register = (client: Client, args = input) => client.callTool({ name: 'agentzero_register', arguments: args });

describe('direct Agent registration through the local MCP plugin', () => {
  it('persists before sending, returns only a confirmation link, resumes after restart and connects without restarting MCP', async () => {
    const first = await register(await connect());
    expect(first.isError).not.toBe(true);
    const value = pending();
    const result = first.structuredContent as Record<string, string>;
    expect(result.status).toBe('pending');
    const uri = new URL(result.verification_uri!);
    expect(uri.origin).toBe(input.api_url);
    expect(uri.pathname).toBe('/connect');
    expect(uri.searchParams.get('request')).toBe(value.id);
    expect(new URLSearchParams(uri.hash.slice(1)).get('code')).toBe(value.verification_code);
    expect(JSON.stringify(first)).not.toContain(value.secret);
    expect(existsSync(configFile)).toBe(false);
    approved = true;
    const restarted = await connect();
    const complete = await register(restarted);
    expect(complete.structuredContent).toMatchObject({ status: 'connected', agent_id: agentId });
    expect(JSON.stringify(complete)).not.toContain(value.secret);
    expect(loadConfig({}, configFile)).toMatchObject({ agentKey: value.secret, apiUrl: input.api_url });
    expect(existsSync(`${configFile}.registration.json`)).toBe(false);
    expect((await restarted.callTool({ name: 'agentzero_identity', arguments: {} })).structuredContent).toMatchObject({ actor: { agentId } });
  });

  it('reuses the original request through retries and concurrent calls; refuses parameter changes', async () => {
    const client = await connect();
    await Promise.all([register(client), register(client)]);
    const value = pending();
    expect(fetcher.mock.calls.filter(([, opts]) => opts?.method === 'POST').map(([, opts]) => JSON.parse(String(opts!.body)).id)).toEqual([value.id]);
    const mismatch = await register(client, { ...input, name: '另一 Agent' });
    expect(mismatch.structuredContent).toMatchObject({ error: { code: 'REGISTRATION_IN_PROGRESS' } });
    expect(pending().id).toBe(value.id);
  });

  it('retains an unknown network result and retries the same id instead of creating another Agent', async () => {
    fetcher.mockRejectedValueOnce(new Error('network contains private details'));
    const client = await connect();
    const failure = await register(client);
    const id = pending().id;
    expect(failure.structuredContent).toMatchObject({ error: { code: 'REGISTRATION_NETWORK_ERROR', uncertain: true } });
    expect(JSON.stringify(failure)).not.toContain('private details');
    expect((await register(client)).structuredContent).toMatchObject({ status: 'pending' });
    expect(pending().id).toBe(id);
  });

  it('removes an expired local request and starts a new one only on the next call', async () => {
    const client = await connect();
    await register(client); const id = pending().id;
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'REGISTRATION_EXPIRED' } }, { status: 410 }));
    expect((await register(client)).structuredContent).toMatchObject({ error: { code: 'REGISTRATION_EXPIRED' } });
    expect(existsSync(`${configFile}.registration.json`)).toBe(false);
    await register(client); expect(pending().id).not.toBe(id);
  });

  it('retries an undelivered recent request with the original id when the status endpoint returns 404', async () => {
    const client = await connect();
    fetcher.mockRejectedValueOnce(new Error('request was not delivered'));
    await register(client); const original = pending();
    const before = fetcher.mock.calls.length;
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
    expect((await register(client)).structuredContent).toMatchObject({ status: 'pending' });
    expect(fetcher.mock.calls.slice(before).map(([, options]) => options?.method)).toEqual(['GET', 'POST', 'GET']);
    expect(pending().id).toBe(original.id);
    expect(pending().verification_code).toBe(original.verification_code);
  });

  it('keeps an approved request for retry when writing the final config fails without revealing its credential', async () => {
    const client = await connect(); await register(client); const value = pending(); approved = true;
    // Cause the final atomic rename to fail after the preceding config read.
    const realFetch = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, options) => {
      const response = await realFetch(url, options);
      if (String(url).endsWith('/status')) mkdirSync(configFile);
      return response;
    });
    const result = await register(client);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(value.secret);
    expect(pending().id).toBe(value.id);
  });

  it('does not replace an existing connection, including a file written since this process started', async () => {
    const client = await connect();
    const original = `azk_${agentId}.${'a'.repeat(43)}`;
    writeFileSync(configFile, JSON.stringify({ api_url: input.api_url, agent_key: original }));
    const result = await register(client);
    expect(result.structuredContent).toMatchObject({ status: 'already_connected', agent_id: agentId });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(loadConfig({}, configFile).agentKey).toBe(original);
    expect(existsSync(`${configFile}.registration.json`)).toBe(false);
  });
});
