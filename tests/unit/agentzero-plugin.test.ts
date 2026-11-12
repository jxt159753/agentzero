import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentZeroServer } from '../../packages/agentzero/src/server.js';

const agentId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const agentKey = `azk_${agentId}.${'x'.repeat(43)}`;
const config = { apiUrl: 'https://agentzero.example', agentKey };
const identity = { actor: { type: 'agent', agentId }, user: { id: 'owner', github_login: 'worker', display_name: 'Worker', status: 'active', role: 'member' }, policy: { can_accept_task: true, single_spend_limit: '9007199254740993', daily_spend_limit: '9007199254740993', version: '1' } };
const acceptedInput = { task_id: taskId, version: '4', idempotency_key: 'accept-request-001' };
const deliveryInput = { task_id: taskId, version: '5', idempotency_key: 'delivery-request-001', pr_number: 27, head_sha: 'a'.repeat(40) };
const connections: { client: Client; server: ReturnType<typeof createAgentZeroServer> }[] = [];
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals();
  await Promise.all(connections.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
});
async function connect(agentKeyOverride = agentKey) {
  const server = createAgentZeroServer({ ...config, agentKey: agentKeyOverride });
  const client = new Client({ name: 'agentzero-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('shared AgentZero MCP adapter', () => {
  it('queries only public world routes and binds presence to its credential with stable retries', async () => {
    fetcher.mockImplementation(async () => Response.json({ online: true, operation_id: operationId }));
    const client = await connect();
    await client.callTool({ name: 'agentzero_world', arguments: {} });
    await client.callTool({ name: 'agentzero_world_studio', arguments: { land_id: taskId } });
    await client.callTool({ name: 'agentzero_world_agent', arguments: { agent_id: agentId } });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/world', `/api/v1/world/studios/${taskId}`, `/api/v1/world/agents/${agentId}`,
    ]);
    const input = { x: 0.25, y: -7.125, idempotency_key: 'world-presence-001' };
    for (let retry = 0; retry < 2; retry++) {
      expect((await client.callTool({ name: 'agentzero_world_presence', arguments: input })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(new URL(String(url)).pathname).toBe('/api/v1/world/presence');
      expect(options).toMatchObject({ method: 'POST', headers: { authorization: `Bearer ${agentKey}`, 'idempotency-key': input.idempotency_key } });
      expect(JSON.parse(options!.body as string)).toEqual({ x: 0.25, y: -7.125 });
    }
    await client.callTool({ name: 'agentzero_world_presence', arguments: { idempotency_key: 'world-presence-002' } });
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual({});
    await client.callTool({ name: 'agentzero_world_leave', arguments: { idempotency_key: 'world-leave-001' } });
    expect(new URL(String(fetcher.mock.calls.at(-1)![0])).pathname).toBe('/api/v1/world/leave');
    const before = fetcher.mock.calls.length;
    for (const args of [{ ...input, agent_id: taskId }, { ...input, x: 1000001 }, { x: 1, idempotency_key: input.idempotency_key }]) {
      expect((await client.callTool({ name: 'agentzero_world_presence', arguments: args })).isError).toBe(true);
    }
    expect(fetcher).toHaveBeenCalledTimes(before);
    expect((await client.listTools()).tools.some(tool => /publish|publication/.test(tool.name))).toBe(false);
  });
  it('discovers strict Agent tools without credentials and reports actionable configuration errors', async () => {
    const client = await connect('');
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(['agentzero_register','agentzero_identity','agentzero_wallet','agentzero_repositories','agentzero_list_tasks','agentzero_get_task','agentzero_accept_task','agentzero_submit_delivery','agentzero_get_operation',
      'agentzero_propose_agreement','agentzero_respond_agreement','agentzero_submit_contribution','agentzero_propose_cancellation','agentzero_accept_cancellation','agentzero_dispute_task',
      'agentzero_list_conversations','agentzero_list_agents','agentzero_create_conversation','agentzero_read_messages','agentzero_send_message','agentzero_poll_messages',
      'agentzero_reward_catalog','agentzero_redeem_reward','agentzero_list_reward_redemptions','agentzero_get_reward_redemption','agentzero_cancel_reward_redemption',
      'agentzero_market_catalog','agentzero_market_assets','agentzero_get_market_asset','agentzero_buy_market_asset',
      'agentzero_create_market_listing','agentzero_cancel_market_listing','agentzero_update_studio','agentzero_place_market_item',
      'agentzero_world','agentzero_world_studio','agentzero_world_agent','agentzero_world_presence','agentzero_world_leave',
      'agentzero_world_models','agentzero_games','agentzero_create_game','agentzero_update_game','agentzero_game_pool','agentzero_bind_game_machine','agentzero_start_game_session','agentzero_game_session']);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      const write = ['agentzero_accept_task','agentzero_submit_delivery','agentzero_propose_agreement','agentzero_respond_agreement','agentzero_submit_contribution','agentzero_propose_cancellation','agentzero_accept_cancellation','agentzero_dispute_task','agentzero_create_conversation','agentzero_send_message','agentzero_redeem_reward','agentzero_cancel_reward_redemption',
        'agentzero_buy_market_asset','agentzero_create_market_listing','agentzero_cancel_market_listing','agentzero_update_studio','agentzero_place_market_item',
        'agentzero_world_models','agentzero_create_game','agentzero_update_game','agentzero_game_pool','agentzero_bind_game_machine','agentzero_start_game_session','agentzero_game_session'].includes(tool.name);
      const presence = ['agentzero_register', 'agentzero_world_presence', 'agentzero_world_leave'].includes(tool.name);
      expect(tool.annotations).toMatchObject({ readOnlyHint: !write && !presence, destructiveHint: write, idempotentHint: true, openWorldHint: true });
      expect(tool.inputSchema.properties).not.toHaveProperty('agent_key');
      if (tool.name !== 'agentzero_world_agent') expect(tool.inputSchema.properties).not.toHaveProperty('agent_id');
    }
    const result = await client.callTool({ name: 'agentzero_identity', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'CONFIG_REQUIRED', uncertain: false } });
    expect(JSON.stringify(result)).toContain('agentzero_register');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes read tools with Bearer auth, preserves string amounts and converts query parameters', async () => {
    const wallet = { available: '9007199254740993', reserved: '0', daily_spent: '0', held: '0', daily_usage: '0', business_date: '2026-11-07' };
    fetcher.mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/me') return Response.json(identity);
      if (url.pathname.endsWith('/wallet')) return Response.json(wallet);
      if (url.pathname === '/api/v1/repositories') return Response.json({ items: [] });
      if (url.pathname === '/api/v1/tasks') return Response.json({ items: [], next_cursor: null });
      if (url.pathname.startsWith('/api/v1/operations/')) return Response.json({ id: operationId, status: 200, result: { reward_points: '9007199254740993' } });
      return Response.json({ id: taskId, reward_points: '9007199254740993' });
    });
    const client = await connect();
    expect((await client.callTool({ name: 'agentzero_identity', arguments: {} })).structuredContent).toEqual(identity);
    expect((await client.callTool({ name: 'agentzero_wallet', arguments: {} })).structuredContent).toEqual(wallet);
    await client.callTool({ name: 'agentzero_repositories', arguments: {} });
    await client.callTool({ name: 'agentzero_list_tasks', arguments: { status: 'open', mine: true, cursor: 'cursor+/=', limit: 17 } });
    await client.callTool({ name: 'agentzero_list_tasks', arguments: { mine: false } });
    expect((await client.callTool({ name: 'agentzero_get_task', arguments: { task_id: taskId } })).structuredContent).toMatchObject({ reward_points: '9007199254740993' });
    expect((await client.callTool({ name: 'agentzero_get_operation', arguments: { operation_id: operationId } })).structuredContent).toMatchObject({ id: operationId });
    const urls = fetcher.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map(url => url.pathname)).toContain(`/api/v1/agents/${agentId}/wallet`);
    expect(Object.fromEntries(urls.find(url => url.searchParams.has('cursor'))!.searchParams)).toEqual({ status: 'open', mine: 'true', cursor: 'cursor+/=', limit: '17' });
    expect(urls.filter(url => url.pathname === '/api/v1/tasks').at(-1)!.search).toBe('');
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${agentKey}` } });
      expect(options?.headers).not.toHaveProperty('cookie');
      expect(options?.headers).not.toHaveProperty('x-csrf-token');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('binds acceptance to fresh identity and keeps caller version and request key unchanged', async () => {
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname === '/api/v1/me' ? identity : { id: taskId, status: 'in_progress', operation_id: operationId }));
    const client = await connect();
    const result = await client.callTool({ name: 'agentzero_accept_task', arguments: acceptedInput });
    expect(result.structuredContent).toMatchObject({ operation_id: operationId });
    const [url, options] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe(`${config.apiUrl}/api/v1/tasks/${taskId}/accept`);
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'idempotency-key': acceptedInput.idempotency_key } });
    expect(JSON.parse(options!.body as string)).toEqual({ version: '4', agent_id: agentId });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects extra identity parameters and invalid write fields before making API requests', async () => {
    const client = await connect();
    for (const arguments_ of [
      { ...acceptedInput, agent_id: operationId },
      { task_id: taskId, version: '4' },
      { ...acceptedInput, version: 4 },
      { ...acceptedInput, idempotency_key: 'short' },
    ]) expect((await client.callTool({ name: 'agentzero_accept_task', arguments: arguments_ })).isError).toBe(true);
    expect((await client.callTool({ name: 'agentzero_submit_delivery', arguments: { ...deliveryInput, head_sha: 'invalid' } })).isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('forwards delivery and explicit retries with the exact same payload and request key', async () => {
    fetcher.mockResolvedValue(Response.json({ id: taskId, status: 'submitted', operation_id: operationId }));
    const client = await connect();
    const first = await client.callTool({ name: 'agentzero_submit_delivery', arguments: deliveryInput });
    // Supply fresh Response bodies; real retries are separate HTTP responses.
    fetcher.mockResolvedValue(Response.json({ id: taskId, status: 'submitted', operation_id: operationId }));
    const second = await client.callTool({ name: 'agentzero_submit_delivery', arguments: deliveryInput });
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/tasks/${taskId}/deliveries`);
      expect(options?.headers).toMatchObject({ 'idempotency-key': deliveryInput.idempotency_key });
      expect(JSON.parse(options!.body as string)).toEqual({ version: '5', pr_number: 27, head_sha: 'a'.repeat(40) });
    }
  });

  it('forwards text delivery and retries without adding PR fields', async () => {
    fetcher.mockImplementation(async () => Response.json({ id: taskId, status: 'submitted', operation_id: operationId }));
    const client = await connect();
    const input = { ...acceptedInput, content: '已完成需求调研。\n结论与依据见这份成果说明。' };
    const first = await client.callTool({ name: 'agentzero_submit_delivery', arguments: input });
    expect(first.isError).not.toBe(true);
    const second = await client.callTool({ name: 'agentzero_submit_delivery', arguments: input });
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/tasks/${taskId}/deliveries`);
      expect(options?.headers).toMatchObject({ 'idempotency-key': input.idempotency_key });
      expect(JSON.parse(options!.body as string)).toEqual({ version: input.version, content: input.content });
    }
  });

  it('rejects empty, incomplete and mixed deliveries before making API requests', async () => {
    const client = await connect();
    for (const fields of [
      {}, { content: '' }, { content: ' \n\t' }, { content: 'x'.repeat(8001) },
      { pr_number: 27 }, { head_sha: 'a'.repeat(40) },
      { content: '成果说明', pr_number: 27 }, { content: '成果说明', head_sha: 'a'.repeat(40) },
      { content: '成果说明', pr_number: 27, head_sha: 'a'.repeat(40) },
    ]) {
      expect((await client.callTool({ name: 'agentzero_submit_delivery', arguments: { ...acceptedInput, ...fields } })).isError).toBe(true);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not reuse a cached identity after revocation and rejects non-Agent identities', async () => {
    fetcher.mockResolvedValueOnce(Response.json(identity))
      .mockResolvedValueOnce(Response.json({ available: '10' }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'CREDENTIAL_REVOKED', message: '凭证已撤销', request_id: 'request-1' } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ actor: { type: 'user', userId: 'owner' } }));
    const client = await connect();
    expect((await client.callTool({ name: 'agentzero_wallet', arguments: {} })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'agentzero_wallet', arguments: {} })).structuredContent).toMatchObject({ error: { code: 'CREDENTIAL_REVOKED', status: 401 } });
    expect((await client.callTool({ name: 'agentzero_accept_task', arguments: acceptedInput })).structuredContent).toMatchObject({ error: { code: 'AGENT_IDENTITY_REQUIRED' } });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });

  it('preserves actionable API conflicts while removing reflected credentials from errors and success data', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: `冲突 ${agentKey}`, request_id: `request-${agentKey}` } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ id: taskId, description: agentKey, nested: [{ [agentKey]: agentKey }] }));
    const client = await connect();
    const conflict = await client.callTool({ name: 'agentzero_submit_delivery', arguments: deliveryInput });
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT', status: 409, uncertain: false, idempotency_key: deliveryInput.idempotency_key } });
    expect(JSON.stringify(conflict)).not.toContain(agentKey);
    const task = await client.callTool({ name: 'agentzero_get_task', arguments: { task_id: taskId } });
    expect(JSON.stringify(task)).not.toContain(agentKey);
    expect(JSON.stringify(task)).toContain('[REDACTED]');
  });

  it('reports network failures as unknown write results without logging credentials or automatically retrying', async () => {
    fetcher.mockRejectedValue(new Error(`fetch failed: Bearer ${agentKey}`));
    const client = await connect();
    const result = await client.callTool({ name: 'agentzero_submit_delivery', arguments: deliveryInput });
    expect(result.structuredContent).toMatchObject({ error: { code: 'NETWORK_ERROR', uncertain: true, idempotency_key: deliveryInput.idempotency_key } });
    expect(JSON.stringify(result)).not.toContain(agentKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
  });

  it('aborts an overdue fetch and returns the original write key for reconciliation', async () => {
    const client = await connect();
    vi.useFakeTimers();
    fetcher.mockImplementation((_input, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error(`aborted ${agentKey}`)), { once: true });
    }));
    const pending = client.callTool({ name: 'agentzero_submit_delivery', arguments: deliveryInput });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({ error: { code: 'REQUEST_TIMEOUT', uncertain: true, idempotency_key: deliveryInput.idempotency_key } });
    expect(JSON.stringify(result)).not.toContain(agentKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('binds agreement acceptance and contribution identity to the credential instead of caller input', async () => {
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname === '/api/v1/me' ? identity : { id: taskId }));
    const client = await connect();
    const input = { ...acceptedInput, agreement_id: operationId, decision: 'accept' };
    expect((await client.callTool({ name: 'agentzero_respond_agreement', arguments: input })).isError).not.toBe(true);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({ version: '4', agent_id: agentId });
    expect(String(fetcher.mock.calls[1]![0])).toContain(`/agreements/${operationId}/accept`);
    expect((await client.callTool({ name: 'agentzero_submit_contribution', arguments: { ...acceptedInput, kind: 'test', body: 'CI evidence' } })).isError).not.toBe(true);
    expect(JSON.parse(fetcher.mock.calls[3]![1]!.body as string)).toEqual({ version: '4', agent_id: agentId, kind: 'test', body: 'CI evidence' });
    const before = fetcher.mock.calls.length;
    expect((await client.callTool({ name: 'agentzero_respond_agreement', arguments: { ...input, decision: 'reject' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'agentzero_respond_agreement', arguments: { ...input, agent_id: operationId } })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(before);
    await client.callTool({ name: 'agentzero_respond_agreement', arguments: { ...input, as_publisher: true } });
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual({ version: '4', as_publisher: true });
    await client.callTool({ name: 'agentzero_accept_cancellation', arguments: { ...acceptedInput, proposal_id: operationId, as_publisher: true } });
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual({ version: '4', as_publisher: true });
  });

  it('discovers visitor contacts and creates private conversations with exactly one recipient identity', async () => {
    const contacts = { items: [{ id: taskId, name: '协作 Agent', owner_user_id: operationId, owner_name: '邻居' }], users: [{ id: operationId, name: '邻居', github_login: 'neighbor' }] };
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname.endsWith('/message-recipients') ? contacts : { id: operationId }));
    const client = await connect();
    expect((await client.callTool({ name: 'agentzero_list_agents', arguments: {} })).structuredContent).toEqual(contacts);
    for (const [index, recipient] of [{ recipient_agent_id: taskId }, { recipient_user_id: operationId }].entries()) {
      const input = { ...recipient, idempotency_key: `conversation-request-${index}` };
      expect((await client.callTool({ name: 'agentzero_create_conversation', arguments: input })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/conversations`);
      expect(options).toMatchObject({ method: 'POST', headers: { authorization: `Bearer ${agentKey}`, 'idempotency-key': input.idempotency_key } });
      expect(JSON.parse(options!.body as string)).toEqual(recipient);
    }
    const before = fetcher.mock.calls.length;
    for (const recipient of [{}, { recipient_agent_id: taskId, recipient_user_id: operationId }, { recipient_user_id: 'not-a-user-id' }, { recipient_user_id: operationId, sender_agent_id: taskId }]) {
      expect((await client.callTool({ name: 'agentzero_create_conversation', arguments: { ...recipient, idempotency_key: 'conversation-invalid-001' } })).isError).toBe(true);
    }
    expect(fetcher).toHaveBeenCalledTimes(before);
  });

  it('routes message polling and sends one idempotent message only to an explicit target', async () => {
    fetcher.mockImplementation(async () => Response.json({ items: [], next_cursor: '9007199254740993', has_more: false }));
    const client = await connect();
    await client.callTool({ name: 'agentzero_poll_messages', arguments: { after: '9007199254740992', limit: 17 } });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${config.apiUrl}/api/v1/messages?after=9007199254740992&limit=17`);
    const input = { conversation_id: operationId, body: '同意仅是聊天文字', idempotency_key: 'message-request-001' };
    await client.callTool({ name: 'agentzero_send_message', arguments: input });
    await client.callTool({ name: 'agentzero_send_message', arguments: input });
    for (const [url, options] of fetcher.mock.calls.slice(1)) {
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/conversations/${operationId}/messages`);
      expect(JSON.parse(options!.body as string)).toEqual({ body: input.body });
      expect(options!.headers).toMatchObject({ 'idempotency-key': input.idempotency_key });
    }
    expect((await client.callTool({ name: 'agentzero_send_message', arguments: { ...input, task_id: taskId } })).isError).toBe(true);
    expect((await client.callTool({ name: 'agentzero_read_messages', arguments: {} })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('binds reward spending to the credential, preserves QQ and retries, and exposes no payout tools', async () => {
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname === '/api/v1/me' ? identity : { id: operationId, status: 'pending' }));
    const client = await connect();
    const input = { offer_id: taskId, claimant_qq: '12345678', idempotency_key: 'reward-request-001' };
    await client.callTool({ name: 'agentzero_reward_catalog', arguments: { month: '2026-11-01' } });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${config.apiUrl}/api/v1/rewards?month=2026-11-01`);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await client.callTool({ name: 'agentzero_redeem_reward', arguments: input })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/reward-redemptions`);
      expect(JSON.parse(options!.body as string)).toEqual({ offer_id: taskId, agent_id: agentId, claimant_qq: input.claimant_qq });
      expect(options!.headers).toMatchObject({ 'idempotency-key': input.idempotency_key });
    }
    const before = fetcher.mock.calls.length;
    expect((await client.callTool({ name: 'agentzero_redeem_reward', arguments: { ...input, agent_id: operationId } })).isError).toBe(true);
    expect((await client.callTool({ name: 'agentzero_redeem_reward', arguments: { ...input, claimant_qq: 'unknown' } })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(before);
    await client.callTool({ name: 'agentzero_list_reward_redemptions', arguments: { cursor: 'a+/=', limit: 2 } });
    const listUrl = new URL(String(fetcher.mock.calls.at(-1)![0]));
    expect(Object.fromEntries(listUrl.searchParams)).toEqual({ cursor: 'a+/=', limit: '2' });
    await client.callTool({ name: 'agentzero_get_reward_redemption', arguments: { redemption_id: operationId } });
    await client.callTool({ name: 'agentzero_cancel_reward_redemption', arguments: { redemption_id: operationId, version: '1', reason: '用户取消', idempotency_key: 'reward-cancel-001' } });
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual({ version: '1', reason: '用户取消' });
    expect(fetcher.mock.calls.every(([input]) => new URL(String(input)).origin === config.apiUrl)).toBe(true);
    expect((await client.listTools()).tools.some(tool => /fulfill|payout/.test(tool.name))).toBe(false);
  });

  it('reads the market and current Agent assets without accepting an alternative identity', async () => {
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname === '/api/v1/me' ? identity : { points_price: '9007199254740993' }));
    const client = await connect();
    await client.callTool({ name: 'agentzero_market_catalog', arguments: {} });
    await client.callTool({ name: 'agentzero_market_assets', arguments: {} });
    for (const kind of ['land', 'item', 'listing']) {
      expect((await client.callTool({ name: 'agentzero_get_market_asset', arguments: { kind, asset_id: taskId } })).structuredContent).toEqual({ points_price: '9007199254740993' });
    }
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/market', '/api/v1/me', `/api/v1/agents/${agentId}/assets`,
      `/api/v1/market/lands/${taskId}`, `/api/v1/market/items/${taskId}`, `/api/v1/market/listings/${taskId}`,
    ]);
    expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    expect((await client.callTool({ name: 'agentzero_market_assets', arguments: { agent_id: operationId } })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('binds every market purchase to fresh identity and preserves exact quote version and retry key', async () => {
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname === '/api/v1/me' ? identity : { id: operationId, points_price: '9007199254740993' }));
    const client = await connect();
    for (const [kind, collection] of [['land', 'lands'], ['template', 'templates'], ['listing', 'listings']]) {
      const input = { kind, asset_id: taskId, version: '9007199254740993', idempotency_key: `market-${kind}-request` };
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await client.callTool({ name: 'agentzero_buy_market_asset', arguments: input });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ points_price: '9007199254740993' });
        const [url, options] = fetcher.mock.calls.at(-1)!;
        expect(String(url)).toBe(`${config.apiUrl}/api/v1/market/${collection}/${taskId}/buy`);
        expect(options).toMatchObject({ method: 'POST', headers: { 'idempotency-key': input.idempotency_key } });
        expect(JSON.parse(options!.body as string)).toEqual({ agent_id: agentId, version: input.version });
      }
    }
    const before = fetcher.mock.calls.length;
    const input = { kind: 'land', asset_id: taskId, version: '1', idempotency_key: 'market-invalid-input' };
    for (const arguments_ of [{ ...input, agent_id: operationId }, { ...input, kind: 'item' }, { ...input, version: 1 }]) {
      expect((await client.callTool({ name: 'agentzero_buy_market_asset', arguments: arguments_ })).isError).toBe(true);
    }
    expect(fetcher).toHaveBeenCalledTimes(before);
    expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/v1/me')).toHaveLength(6);
  });

  it('keeps an unknown purchase result pending and stops a new purchase when identity is revoked', async () => {
    fetcher.mockResolvedValueOnce(Response.json(identity)).mockRejectedValueOnce(new Error('connection lost'));
    const client = await connect();
    const input = { kind: 'listing', asset_id: taskId, version: '7', idempotency_key: 'market-unknown-result' };
    const result = await client.callTool({ name: 'agentzero_buy_market_asset', arguments: input });
    expect(result.structuredContent).toMatchObject({ error: { code: 'NETWORK_ERROR', uncertain: true, idempotency_key: input.idempotency_key } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'CREDENTIAL_REVOKED', message: '凭证已撤销' } }, { status: 401 }));
    const revoked = await client.callTool({ name: 'agentzero_buy_market_asset', arguments: input });
    expect(revoked.structuredContent).toMatchObject({ error: { code: 'CREDENTIAL_REVOKED', uncertain: false } });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetcher.mock.calls.at(-1)![0])).pathname).toBe('/api/v1/me');
  });

  it('creates one fixed-price listing for the selected asset and cancels only the named listing', async () => {
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname === '/api/v1/me' ? identity : { id: operationId }));
    const client = await connect();
    const input = { asset_id: taskId, asset_version: '4', points_price: '9007199254740993', idempotency_key: 'market-listing-create' };
    for (const kind of ['land', 'item']) {
      const result = await client.callTool({ name: 'agentzero_create_market_listing', arguments: { ...input, kind } });
      expect(result.isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/market/listings`);
      expect(JSON.parse(options!.body as string)).toEqual({ agent_id: agentId, [`${kind}_id`]: taskId, asset_version: input.asset_version, points_price: input.points_price });
    }
    const before = fetcher.mock.calls.length;
    expect((await client.callTool({ name: 'agentzero_create_market_listing', arguments: { ...input, kind: 'land', points_price: '0' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'agentzero_create_market_listing', arguments: { ...input, kind: 'land', agent_id: operationId } })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(before);
    await client.callTool({ name: 'agentzero_cancel_market_listing', arguments: { listing_id: operationId, version: '3', idempotency_key: 'market-listing-cancel' } });
    const [url, options] = fetcher.mock.calls.at(-1)!;
    expect(String(url)).toBe(`${config.apiUrl}/api/v1/market/listings/${operationId}/cancel`);
    expect(JSON.parse(options!.body as string)).toEqual({ version: '3' });
    expect(options!.headers).toMatchObject({ 'idempotency-key': 'market-listing-cancel' });
  });

  it('patches studio display and preserves explicit null when clearing links or returning items to inventory', async () => {
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname === '/api/v1/me' ? identity : { id: taskId, version: '2' }));
    const client = await connect();
    const studio = { land_id: taskId, version: '1', name: '小书房', works_url: 'https://github.com/example/project', idempotency_key: 'market-studio-update' };
    for (const worksUrl of [studio.works_url, null]) {
      expect((await client.callTool({ name: 'agentzero_update_studio', arguments: { ...studio, works_url: worksUrl } })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/market/lands/${taskId}/studio`);
      expect(options).toMatchObject({ method: 'PATCH', headers: { 'idempotency-key': studio.idempotency_key } });
      expect(JSON.parse(options!.body as string)).toEqual({ agent_id: agentId, version: '1', name: studio.name, works_url: worksUrl });
    }
    for (const landId of [operationId, null]) {
      expect((await client.callTool({ name: 'agentzero_place_market_item', arguments: { item_id: taskId, version: '2', land_id: landId, idempotency_key: 'market-place-item' } })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/market/items/${taskId}/place`);
      expect(JSON.parse(options!.body as string)).toEqual({ agent_id: agentId, version: '2', land_id: landId });
    }
    const before = fetcher.mock.calls.length;
    expect((await client.callTool({ name: 'agentzero_update_studio', arguments: { ...studio, works_url: 'javascript:alert(1)' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'agentzero_place_market_item', arguments: { item_id: taskId, version: '1', idempotency_key: 'market-missing-target' } })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(before);
  });

  it('passes mixed showcase items and explicit clearing while rejecting unsafe or malformed items before HTTP', async () => {
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname === '/api/v1/me' ? identity : { id: taskId, version: '2' }));
    const client = await connect();
    const studio = { land_id: taskId, version: '1', name: '展示地块', works_url: null, idempotency_key: 'market-studio-showcase' };
    const items = [{ type: 'text', title: '介绍', text: '欢迎来到我的地块' }, { type: 'image', url: 'https://example.com/image.png' },
      { type: 'video', url: 'https://example.com/video.mp4' }, { type: 'webpage', url: 'https://example.com/site' }];
    for (const showcase of [items, []]) {
      expect((await client.callTool({ name: 'agentzero_update_studio', arguments: { ...studio, showcase } })).isError).not.toBe(true);
      const [, options] = fetcher.mock.calls.at(-1)!;
      expect(JSON.parse(options!.body as string)).toEqual({ agent_id: agentId, version: studio.version, name: studio.name, works_url: null, showcase });
    }
    const before = fetcher.mock.calls.length;
    for (const showcase of [null, Array.from({ length: 9 }, () => items[0]), [{ type: 'text', text: ' ' }], [{ type: 'text', text: 'x'.repeat(2001) }],
      [{ type: 'video', url: 'http://example.com/file.mp4' }], [{ type: 'webpage', url: 'javascript:alert(1)' }], [{ type: 'image' }],
      [{ type: 'text', text: 'hello', html: '<script>alert(1)</script>' }]])
      expect((await client.callTool({ name: 'agentzero_update_studio', arguments: { ...studio, showcase } })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(before);
  });

  it('reads game terms, machines and authorized sessions without starting or settling a game', async () => {
    fetcher.mockImplementation(async () => Response.json({ items: [] }));
    const client = await connect();
    const queries = [
      [{ action: 'list' }, '/games'], [{ action: 'list', mine: true }, '/games?mine=true'],
      [{ action: 'get', game_id: taskId }, `/games/${taskId}`], [{ action: 'machine', placement_id: operationId }, `/games/machines/${operationId}`],
      [{ action: 'sessions' }, '/games/sessions?mine=true'], [{ action: 'sessions', game_id: taskId }, `/games/${taskId}/sessions`],
      [{ action: 'session', session_id: operationId }, `/games/sessions/${operationId}`],
    ] as const;
    for (const [query, path] of queries) {
      expect((await client.callTool({ name: 'agentzero_games', arguments: { query } })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1${path}`);
      expect(options!.method).toBe('GET');
    }
    expect(fetcher).toHaveBeenCalledTimes(queries.length);
  });

  it('binds submitted URL and bundled games and paid session starts to fresh Agent identity', async () => {
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname === '/api/v1/me' ? identity : { id: taskId }));
    const client = await connect();
    const common = { name: '小型游戏', description: '经授权公开的作品', entry_fee: '2', max_reward: '9007199254740993', minimum_pool: '9007199254740993', idempotency_key: 'create-game-request' };
    const sources = [{ type: 'url', url: 'https://example.com/play' },
      { type: 'bundle', entry: 'index.html', files: [{ path: 'index.html', mime: 'text/html', content: Buffer.from('<h1>Game</h1>').toString('base64') }] }];
    for (const source of sources) {
      expect((await client.callTool({ name: 'agentzero_create_game', arguments: { ...common, source } })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/games`);
      const { idempotency_key: _key, ...body } = common;
      expect(JSON.parse(options!.body as string)).toEqual({ ...body, source, agent_id: agentId });
    }
    const start = { game_id: taskId, game_version: '9007199254740993', idempotency_key: 'start-game-request' };
    for (let retry = 0; retry < 2; retry++) {
      expect((await client.callTool({ name: 'agentzero_start_game_session', arguments: start })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/games/${taskId}/sessions`);
      expect(options!.headers).toMatchObject({ 'idempotency-key': start.idempotency_key });
      expect(JSON.parse(options!.body as string)).toEqual({ agent_id: agentId, game_version: start.game_version });
    }
    const before = fetcher.mock.calls.length;
    for (const input of [{ ...common, source: sources[0], agent_id: operationId }, { ...common, source: { type: 'url', url: 'javascript:alert(1)' } }, { ...common, source: { type: 'executable', path: 'game.exe' } }])
      expect((await client.callTool({ name: 'agentzero_create_game', arguments: input })).isError).toBe(true);
    expect((await client.callTool({ name: 'agentzero_start_game_session', arguments: { ...start, agent_id: operationId } })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(before);
    expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/v1/me')).toHaveLength(4);
  });

  it('passes explicit game rules and content updates while preserving server settlement results', async () => {
    const settled = { id: operationId, settlement_rule: 'starlight_slots_v1', status: 'settled', score: '100', reward_requested: '3', reward_points: '3' };
    fetcher.mockImplementation(async input => Response.json(new URL(String(input)).pathname === '/api/v1/me' ? identity : settled));
    const client = await connect(), key = 'game-rules-request';
    const source = { type: 'url', url: 'https://example.com/starlight' };
    const bundle = { type: 'bundle', entry: 'index.html', files: [{ path: 'index.html', mime: 'text/html', content: Buffer.from('<h1>Slots</h1>').toString('base64') }] };
    const create = { name: '星光老虎机', description: '服务端固定规则结算', entry_fee: '1', max_reward: '3', minimum_pool: '3', settlement_rule: 'starlight_slots_v1', source };
    expect((await client.callTool({ name: 'agentzero_create_game', arguments: { ...create, idempotency_key: key } })).isError).not.toBe(true);
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual({ ...create, agent_id: agentId });

    for (const changes of [{ settlement_rule: 'manual' }, { settlement_rule: 'starlight_slots_v1' }, { description: '' }, { source }, { source: bundle }]) {
      expect((await client.callTool({ name: 'agentzero_update_game', arguments: { game_id: taskId, version: '3', ...changes, idempotency_key: key } })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1/games/${taskId}`);
      expect(options!.method).toBe('PATCH');
      expect(options!.headers).toMatchObject({ 'idempotency-key': key });
      expect(JSON.parse(options!.body as string)).toEqual({ version: '3', ...changes });
    }

    const beforeResults = fetcher.mock.calls.length;
    for (const operation of [{ action: 'submit', session_id: operationId, score: '0', reward_requested: '0' }, { action: 'refund', session_id: operationId }]) {
      expect((await client.callTool({ name: 'agentzero_game_session', arguments: { operation, idempotency_key: key } })).structuredContent).toEqual(settled);
    }
    expect(fetcher.mock.calls.slice(beforeResults).map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/v1/games/sessions/${operationId}/score`, `/api/v1/games/sessions/${operationId}/refund`,
    ]);
    const beforeInvalid = fetcher.mock.calls.length;
    expect((await client.callTool({ name: 'agentzero_create_game', arguments: { ...create, settlement_rule: 'client_amount', idempotency_key: key } })).isError).toBe(true);
    for (const changes of [{ settlement_rule: 'client_amount' }, { source: { type: 'url', url: 'javascript:alert(1)' } }, { source: { type: 'executable', path: 'game.exe' } }, { description: 'x'.repeat(1001) }]) {
      expect((await client.callTool({ name: 'agentzero_update_game', arguments: { game_id: taskId, version: '3', ...changes, idempotency_key: key } })).isError).toBe(true);
    }
    expect(fetcher).toHaveBeenCalledTimes(beforeInvalid);
  });

  it('routes one explicit game operation without extra funding, play or settlement requests', async () => {
    fetcher.mockImplementation(async () => Response.json({ id: taskId, operation_id: operationId }));
    const client = await connect(), key = 'game-operation-request';
    const calls = [
      ['agentzero_update_game', { game_id: taskId, version: '2', status: 'paused', minimum_pool: '20' }, `/games/${taskId}`, 'PATCH', { version: '2', status: 'paused', minimum_pool: '20' }],
      ['agentzero_game_pool', { game_id: taskId, action: 'fund', amount: '9007199254740993' }, `/games/${taskId}/fund`, 'POST', { amount: '9007199254740993' }],
      ['agentzero_game_pool', { game_id: taskId, action: 'withdraw', amount: '3' }, `/games/${taskId}/withdraw`, 'POST', { amount: '3' }],
      ['agentzero_bind_game_machine', { placement_id: operationId, game_id: taskId }, `/games/machines/${operationId}`, 'PUT', { game_id: taskId }],
      ['agentzero_bind_game_machine', { placement_id: operationId, game_id: null }, `/games/machines/${operationId}`, 'PUT', { game_id: null }],
      ['agentzero_game_session', { operation: { action: 'submit', session_id: operationId, score: '9007199254740993', reward_requested: '5' } }, `/games/sessions/${operationId}/score`, 'POST', { score: '9007199254740993', reward_requested: '5' }],
      ['agentzero_game_session', { operation: { action: 'settle', session_id: operationId, reward_points: '5', score: '100', reason: '核验游戏记录' } }, `/games/sessions/${operationId}/settle`, 'POST', { reward_points: '5', score: '100', reason: '核验游戏记录' }],
      ['agentzero_game_session', { operation: { action: 'refund', session_id: operationId } }, `/games/sessions/${operationId}/refund`, 'POST', {}],
    ] as const;
    for (const [name, args, path, method, body] of calls) {
      expect((await client.callTool({ name, arguments: { ...args, idempotency_key: key } })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1${path}`);
      expect(options!.method).toBe(method);
      expect(options!.headers).toMatchObject({ 'idempotency-key': key });
      expect(JSON.parse(options!.body as string)).toEqual(body);
    }
    expect(fetcher).toHaveBeenCalledTimes(calls.length);
    const before = fetcher.mock.calls.length;
    expect((await client.callTool({ name: 'agentzero_game_session', arguments: { idempotency_key: key, operation: { action: 'refund', session_id: operationId, reward_points: '99' } } })).isError).toBe(true);
    expect((await client.callTool({ name: 'agentzero_update_game', arguments: { game_id: taskId, version: '1', idempotency_key: key } })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(before);
    fetcher.mockRejectedValueOnce(new Error('response lost'));
    const uncertain = await client.callTool({ name: 'agentzero_game_session', arguments: { idempotency_key: key, operation: { action: 'settle', session_id: operationId, reward_points: '5', reason: '核验完成' } } });
    expect(uncertain.structuredContent).toMatchObject({ error: { code: 'NETWORK_ERROR', uncertain: true, idempotency_key: key } });
  });

  it('passes room transitions and versioned model CRUD while rejecting mixed operations', async () => {
    fetcher.mockImplementation(async () => Response.json({ id: operationId }));
    const client = await connect(), key = 'world-room-request';
    for (const room_id of [taskId, null]) {
      expect((await client.callTool({ name: 'agentzero_world_presence', arguments: { x: 0.2, y: 0.3, room_id, idempotency_key: key } })).isError).not.toBe(true);
      expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual({ x: 0.2, y: 0.3, room_id });
    }
    const transform = { x: 0.1, y: -0.3, rotation: 90, scale: 1 };
    const operations = [
      [{ action: 'add', land_id: taskId, land_version: '2', model_id: 'arcade', room_id: operationId, ...transform }, `/world/studios/${taskId}/models`, 'POST', { land_version: '2', model_id: 'arcade', room_id: operationId, ...transform }],
      [{ action: 'patch', land_id: taskId, placement_id: operationId, version: '1', ...transform }, `/world/studios/${taskId}/models/${operationId}`, 'PATCH', { version: '1', ...transform }],
      [{ action: 'delete', land_id: taskId, placement_id: operationId, version: '2' }, `/world/studios/${taskId}/models/${operationId}`, 'DELETE', { version: '2' }],
    ] as const;
    for (const [operation, path, method, body] of operations) {
      expect((await client.callTool({ name: 'agentzero_world_models', arguments: { operation, idempotency_key: key } })).isError).not.toBe(true);
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${config.apiUrl}/api/v1${path}`);
      expect(options!.method).toBe(method);
      expect(JSON.parse(options!.body as string)).toEqual(body);
    }
    const before = fetcher.mock.calls.length;
    expect((await client.callTool({ name: 'agentzero_world_presence', arguments: { room_id: taskId, idempotency_key: key } })).isError).toBe(true);
    expect((await client.callTool({ name: 'agentzero_world_models', arguments: { operation: { ...operations[1][0], room_id: taskId }, idempotency_key: key } })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(before);
  });
});
