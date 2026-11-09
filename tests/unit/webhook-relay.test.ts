import { createHmac } from 'node:crypto';
import { createServer, request, type Server, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

const { createWebhookRelay } = await import(new URL('../../scripts/webhook-relay.mjs', import.meta.url).href) as {
  createWebhookRelay(options: { secret: string; upstreamPort: number; bodyLimit?: number; timeoutMs?: number }): Server;
};
const secret = 'isolated-test-webhook-secret';
const path = '/api/v1/github/webhook';
const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return (server.address() as { port: number }).port;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  })));
});
const headers = (body: Buffer) => ({
  'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  'x-github-event': 'pull_request', 'x-github-delivery': '12345678-1234-1234-1234-123456789abc',
});
async function send(port: number, body: Buffer, options: { method?: string; path?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method: options.method ?? 'POST', path: options.path ?? path, headers: { ...headers(body), ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

describe('webhook-only development relay', () => {
  it('forwards exact signed bytes and GitHub headers, without other request headers', async () => {
    const body = Buffer.from('{ "message": "原始字节", "action": "closed" }\n');
    let received: { body: Buffer; headers: IncomingHttpHeaders; url: string } | undefined;
    const upstreamPort = await listen(createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => { received = { body: Buffer.concat(chunks), headers: req.headers, url: req.url! }; res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"accepted":true}'); });
    }));
    const relayPort = await listen(createWebhookRelay({ secret, upstreamPort }));
    expect(await send(relayPort, body, { headers: { authorization: 'must-not-forward', cookie: 'must-not-forward' } })).toEqual({ status: 202, body: '{"accepted":true}' });
    expect(received?.body.equals(body)).toBe(true);
    expect(received?.url).toBe(path);
    expect(received?.headers).toMatchObject(headers(body));
    expect(received?.headers.authorization).toBeUndefined();
    expect(received?.headers.cookie).toBeUndefined();
  });

  it('rejects other paths, queries, methods and invalid signatures before reaching the API', async () => {
    let requests = 0;
    const upstreamPort = await listen(createServer((_req, res) => { requests++; res.end(); }));
    const relayPort = await listen(createWebhookRelay({ secret, upstreamPort }));
    const body = Buffer.from('{}');
    for (const options of [{ path: '/api/v1/agents' }, { path: `${path}?query=1` }, { path: `${path}/` }, { method: 'GET' }]) expect((await send(relayPort, body, options)).status).toBe(404);
    expect((await send(relayPort, body, { headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } })).status).toBe(401);
    expect((await send(relayPort, body, { headers: { 'x-hub-signature-256': 'bad-signature' } })).status).toBe(401);
    expect(requests).toBe(0);
  });

  it('rejects oversized uploads and returns 502 when the upstream cannot respond', async () => {
    let requests = 0;
    const upstreamPort = await listen(createServer((_req, res) => { requests++; res.destroy(); }));
    const relayPort = await listen(createWebhookRelay({ secret, upstreamPort, bodyLimit: 8 }));
    expect((await send(relayPort, Buffer.from('123456789'))).status).toBe(413);
    expect((await send(relayPort, Buffer.from('123456789'), { headers: { 'transfer-encoding': 'chunked' } })).status).toBe(413);
    expect(requests).toBe(0);
    expect((await send(relayPort, Buffer.from('{}'))).status).toBe(502);
    expect(requests).toBe(1);
  });

  it('bounds a stalled upstream request', async () => {
    const upstreamPort = await listen(createServer(() => { /* Deliberately leave the response pending. */ }));
    const relayPort = await listen(createWebhookRelay({ secret, upstreamPort, timeoutMs: 100 }));
    expect((await send(relayPort, Buffer.from('{}'))).status).toBe(502);
  });

  it('times out an incomplete incoming body without forwarding it', async () => {
    let requests = 0;
    const upstreamPort = await listen(createServer((_req, res) => { requests++; res.end(); }));
    const relayPort = await listen(createWebhookRelay({ secret, upstreamPort, timeoutMs: 100 }));
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: relayPort, method: 'POST', path, headers: { ...headers(Buffer.from('{}')), 'content-length': 2 } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject);
      req.write('{');
    });
    expect(status).toBe(408);
    expect(requests).toBe(0);
  });
});
