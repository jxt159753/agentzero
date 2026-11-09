import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

const webhookPath = '/api/v1/github/webhook';
const maxBodyBytes = 26_214_400;

/** A development-only relay. The upstream host and exposed route are deliberately fixed. */
export function createWebhookRelay({ secret = process.env.GITHUB_WEBHOOK_SECRET, upstreamPort = 3000, bodyLimit = maxBodyBytes, timeoutMs = 15_000 } = {}) {
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('GITHUB_WEBHOOK_SECRET is required');
  const limit = Math.min(bodyLimit, maxBodyBytes);
  const server = createServer((incoming, outgoing) => {
    let upstream;
    let replied = false;
    outgoing.setHeader('connection', 'close');
    outgoing.setHeader('cache-control', 'no-store');
    const timer = setTimeout(() => {
      respond(upstream ? 502 : 408, upstream ? 'UPSTREAM_TIMEOUT' : 'REQUEST_TIMEOUT');
      upstream?.destroy();
    }, timeoutMs);
    timer.unref();
    function respond(status, code) {
      if (replied || outgoing.destroyed) return;
      replied = true;
      outgoing.writeHead(status, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: code }));
    }
    outgoing.on('close', () => { clearTimeout(timer); upstream?.destroy(); });
    incoming.on('aborted', () => { clearTimeout(timer); upstream?.destroy(); });
    incoming.on('error', () => respond(400, 'INVALID_REQUEST'));
    if (incoming.method !== 'POST' || incoming.url !== webhookPath) return respond(404, 'NOT_FOUND');
    const signature = incoming.headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return respond(401, 'INVALID_SIGNATURE');
    const event = incoming.headers['x-github-event'], delivery = incoming.headers['x-github-delivery'];
    if (typeof event !== 'string' || typeof delivery !== 'string') return respond(400, 'MISSING_GITHUB_HEADERS');
    if (Number(incoming.headers['content-length'] ?? 0) > limit) return respond(413, 'PAYLOAD_TOO_LARGE');
    const chunks = [];
    const hmac = createHmac('sha256', secret);
    let size = 0;
    incoming.on('data', chunk => {
      if (replied) return;
      size += chunk.length;
      if (size > limit) return respond(413, 'PAYLOAD_TOO_LARGE');
      hmac.update(chunk);
      chunks.push(chunk);
    });
    incoming.on('end', () => {
      if (replied) return;
      if (!timingSafeEqual(hmac.digest(), Buffer.from(signature.slice(7), 'hex'))) return respond(401, 'INVALID_SIGNATURE');
      const body = Buffer.concat(chunks, size);
      upstream = httpRequest({
        hostname: '127.0.0.1', port: upstreamPort, method: 'POST', path: webhookPath,
        headers: {
          'content-type': 'application/json', 'content-length': body.length,
          'x-hub-signature-256': signature, 'x-github-event': event, 'x-github-delivery': delivery,
        },
      }, response => {
        if (replied || outgoing.destroyed) { response.destroy(); return; }
        replied = true;
        outgoing.writeHead(response.statusCode ?? 502, { 'content-type': response.headers['content-type'] ?? 'application/json' });
        response.on('error', () => outgoing.destroy());
        response.pipe(outgoing);
      });
      upstream.on('error', () => respond(502, 'UPSTREAM_UNAVAILABLE'));
      upstream.end(body);
    });
  });
  server.headersTimeout = Math.min(timeoutMs, 10_000);
  server.requestTimeout = timeoutMs;
  server.keepAliveTimeout = 1_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createWebhookRelay();
  server.on('error', error => { process.stderr.write(`Webhook relay failed: ${error.code ?? 'UNKNOWN'}\n`); process.exitCode = 1; });
  server.listen(3002, '127.0.0.1', () => process.stdout.write('Webhook relay listening on http://127.0.0.1:3002/api/v1/github/webhook\n'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
