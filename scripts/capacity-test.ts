import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, platform, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import type { WebSocket as Socket } from 'ws';
import type { Pool } from 'pg';
import { createPool, withTransaction } from '../packages/database/src/index.js';
import { WORLD_BOUNDS, WORLD_PLACES, WORLD_PUBLIC_AREAS, type WorldStreamMessage } from '../packages/contracts/src/index.js';
import { buildApp } from '../apps/api/src/app.js';
import { tokenHash } from '../apps/api/src/core.js';
import { generateDefaultLandPlots } from '../apps/api/src/modules/market/default-land.js';
import { WorldStream } from '../apps/api/src/modules/world/stream.js';

// Reuse the API's installed WebSocket transport; no separate load-tool dependency.
const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { WebSocket } = createRequire(apiRequire.resolve('@fastify/websocket'))('ws') as typeof import('ws');

const { values } = parseArgs({ options: {
  synthetic: { type: 'boolean', default: false }, clients: { type: 'string', default: '20,50,100' },
  seconds: { type: 'string', default: '60' }, 'moving-fraction': { type: 'string', default: '1' },
  'stop-start': { type: 'boolean', default: false }, output: { type: 'string' },
} });
const counts = [...new Set(values.clients!.split(',').map(Number))];
const seconds = Number(values.seconds), fraction = Number(values['moving-fraction']);
if (counts.some(n => !Number.isInteger(n) || n < 2 || n > 500)) throw new Error('--clients requires integers from 2 to 500');
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 300) throw new Error('--seconds requires 10 to 300');
if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error('--moving-fraction requires 0 to 1');
const rounded = (n: number) => Number(n.toFixed(3));
function distribution(samples: number[]) {
  if (!samples.length) return { samples: 0, median_ms: null, p95_ms: null, max_ms: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples: sorted.length, median_ms: rounded(sorted[Math.floor(sorted.length * 0.5)]!),
    p95_ms: rounded(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!), max_ms: rounded(sorted.at(-1)!) };
}

function synthetic() {
  const lands = generateDefaultLandPlots().map(land => ({ ...land, id: randomUUID(), name: '', works_url: null,
    showcase: [], owner_agent_id: null, owner_name: null, owner: null, version: '1', listing: null,
    decorations: [], models: [], tradeable: true, purchasable: true }));
  const results = [];
  for (const count of counts) for (const movingFraction of [0.25, 1]) {
    // This intentionally calls the real serializer without a DB, sockets, or changing application visibility.
    const stream = new WorldStream({} as Pool) as any;
    const peers = [], visitors = [];
    let bytes = 0;
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      visitors.push({ id, name: `访客${index}`, github_login: `capacity-user-${index}`, x: index % 30,
        y: Math.floor(index / 30), room_id: null, online: true });
      const peer = { id, kind: 'visitor', subjectId: id, key: `visitor:${id}`, x: index % 30, y: Math.floor(index / 30),
        roomId: null, expires: Date.now() + 3600000, ready: true, closed: false, v2: true, lastPing: Date.now(),
        socket: { readyState: 1, bufferedAmount: 0, send(value: string) { bytes += Buffer.byteLength(value); } } };
      peers.push(peer); stream.peers.add(peer); stream.owners.set(peer.key, peer);
    }
    stream.projection = { server_time: new Date().toISOString(), presence_ttl_seconds: 60, bounds: WORLD_BOUNDS,
      public_areas: WORLD_PUBLIC_AREAS, places: WORLD_PLACES, lands, agents: [], visitors };
    stream.publish();
    const initialBytes = Buffer.byteLength(JSON.stringify(stream.snapshot(stream.current(), stream.self(peers[0], stream.current()))));
    const times = [], payloads = [];
    for (let iteration = 0; iteration < 120; iteration++) {
      peers.slice(0, Math.ceil(count * movingFraction)).forEach((peer, index) => {
        peer.x = rounded(index % 30 + iteration * 0.013); peer.y = rounded(Math.floor(index / 30) + iteration * 0.017);
      });
      bytes = 0;
      const started = performance.now(); stream.publish();
      if (iteration >= 20) { times.push(performance.now() - started); payloads.push(bytes); }
    }
    const meanBytes = payloads.reduce((sum, n) => sum + n, 0) / payloads.length;
    results.push({ clients: count, moving_fraction: movingFraction, lands: lands.length, initial_snapshot_bytes: initialBytes,
      aggregate_payload_mbps_at_2hz: rounded(meanBytes * 2 * 8 / 1e6), mean_payload_bytes_per_client: Math.round(meanBytes / count),
      publish: distribution(times) });
  }
  return results;
}

function capacityUrl(variable: string, role: string) {
  const raw = process.env[variable];
  if (!raw) throw new Error(`${variable} is required for real mode`);
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/[a-z0-9_]*capacity_test[a-z0-9_]*$/i.test(url.pathname) || url.search || url.hash
    || decodeURIComponent(url.username) !== role)
    throw new Error(`${variable} must use ${role}, a loopback host and a capacity_test database, without URL options`);
  return { raw, url };
}

async function real() {
  const runtime = capacityUrl('CAPACITY_DATABASE_URL', 'agentzero_app');
  const migration = capacityUrl('CAPACITY_MIGRATION_DATABASE_URL', 'agentzero_migrator');
  if (runtime.url.host !== migration.url.host || runtime.url.pathname !== migration.url.pathname)
    throw new Error('Capacity roles must address the same isolated database');
  const pool = createPool(runtime.raw), fixtures = createPool(migration.raw);
  const users: { id: string; cookie: string }[] = [];
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const results = [];
  try {
    for (const connection of [pool, fixtures]) {
      const row = (await connection.query("SELECT current_database() AS database, host(inet_server_addr()) AS address")).rows[0];
      if (row.database !== runtime.url.pathname.slice(1) || !['127.0.0.1', '::1'].includes(row.address))
        throw new Error('Connected database did not match the local capacity target');
    }
    await withTransaction(fixtures, async tx => {
      for (let index = 0; index < Math.max(...counts); index++) {
        const id = randomUUID(), session = randomUUID(), token = randomBytes(32).toString('base64url');
        const githubId = (BigInt('0x' + randomBytes(7).toString('hex')) + 1n).toString();
        await tx.query("INSERT INTO users(id,github_user_id,github_login,display_name,status) VALUES($1,$2,$3,$4,'active')",
          [id, githubId, `capacity-${id}`, `容量访客${index}`]);
        await tx.query("INSERT INTO user_sessions(id,user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour')",
          [session, id, tokenHash(token), tokenHash(randomBytes(32).toString('hex'))]);
        users.push({ id, cookie: `az_session=${token}` });
      }
    });
    for (const count of counts) {
      const origin = 'http://127.0.0.1';
      app = await buildApp({ pool, runJobs: false, serveWeb: false, config: { databaseUrl: runtime.raw, publicOrigin: origin,
        githubClientId: '', githubClientSecret: '', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0,
        worldMaxConnections: Math.max(...counts), worldMaxConnectionsPerUser: 1 } });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const sockets: Socket[] = [], firstFrames: number[] = [], ackTimes: number[] = [], syncTimes: number[] = [];
      const sent = new Map<string, number>(), errors: Record<string, number> = {};
      const bump = (key: string) => { errors[key] = (errors[key] ?? 0) + 1; };
      let measuring = false, closing = false, receivedBytes = 0, maxRss = 0, maxWaiting = 0, sequence = 0, sentMovements = 0;
      const movementCount = Math.ceil(count * fraction);
      try {
        const joins = [];
        for (let index = 0; index < count; index++) {
          const user = users[index]!, started = performance.now();
          const socket = new WebSocket(address.replace('http:', 'ws:') + '/api/v1/world/stream?v=2', { headers: { origin, cookie: user.cookie } });
          sockets.push(socket);
          joins.push(new Promise<void>((resolveJoin, rejectJoin) => {
            const timeout = setTimeout(() => rejectJoin(new Error('First snapshot timeout')), 30000);
            socket.on('message', raw => {
              if (measuring) receivedBytes += Buffer.byteLength(raw.toString());
              const message = JSON.parse(raw.toString()) as WorldStreamMessage;
              if (message.type === 'snapshot') { firstFrames.push(performance.now() - started); clearTimeout(timeout); resolveJoin(); }
              if (message.type === 'ack' && !message.persisted) {
                const began = sent.get(`${user.id}:${message.seq}`);
                if (began !== undefined) { ackTimes.push(performance.now() - began); sent.delete(`${user.id}:${message.seq}`); }
              }
              if (index === 0 && message.type === 'delta') for (const visitor of message.visitors?.upsert ?? []) {
                const key = `${visitor.id}:${visitor.x}:${visitor.y}`, began = sent.get(key);
                if (began !== undefined) { syncTimes.push(performance.now() - began); sent.delete(key); }
              }
            });
            socket.on('error', () => { bump('socket_error'); clearTimeout(timeout); rejectJoin(new Error('Local socket failed')); });
            socket.on('close', code => { if (!closing) bump(`close_${code}`); clearTimeout(timeout); rejectJoin(new Error('Socket closed before snapshot')); });
          }).then(() => true, () => false));
          await delay(10);
        }
        const joined = await Promise.all(joins);
        const failedJoins = joined.filter(result => !result).length;
        const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
        const cpu = process.cpuUsage(), started = performance.now(); measuring = true;
        const movement = setInterval(() => {
          sequence++;
          for (let index = 0; index < movementCount; index++) {
            const socket = sockets[index]!, user = users[index]!;
            if (socket.readyState !== WebSocket.OPEN) continue;
            const x = rounded(index % 20 + Math.sin(sequence * 0.1) * 0.5), y = rounded(Math.floor(index / 20) + Math.cos(sequence * 0.1) * 0.5);
            const now = performance.now(); sent.set(`${user.id}:${sequence}`, now); sent.set(`${user.id}:${x}:${y}`, now);
            sentMovements++;
            socket.send(JSON.stringify({ type: 'move', seq: sequence, x, y, moving: !values['stop-start'] || sequence % 2 === 1 }));
          }
          maxRss = Math.max(maxRss, process.memoryUsage().rss); maxWaiting = Math.max(maxWaiting, pool.waitingCount);
          for (const [key, timestamp] of sent) if (performance.now() - timestamp > 30000) sent.delete(key);
        }, 500);
        const heartbeat = setInterval(() => { for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"heartbeat"}'); }, 20000);
        await delay(seconds * 1000);
        clearInterval(movement); clearInterval(heartbeat);
        // Include the final 500 ms broadcast instead of counting a measurement-boundary miss as packet loss.
        await delay(1000); measuring = false; loop.disable();
        const elapsed = performance.now() - started, usage = process.cpuUsage(cpu);
        results.push({ clients: count, connected: count - failedJoins, active_seconds: seconds, seconds: rounded(elapsed / 1000), moving_fraction: fraction,
          stop_start: values['stop-start'], sent_movements: sentMovements, initial_snapshot: distribution(firstFrames), movement_ack: distribution(ackTimes),
          movement_to_observer: distribution(syncTimes), aggregate_received_mbps: rounded(receivedBytes * 8 / elapsed / 1000),
          process_peak_rss_mib: rounded(maxRss / 1048576), process_cpu_percent: rounded((usage.user + usage.system) / elapsed / 10),
          event_loop_p95_ms: rounded(loop.percentile(95) / 1e6), runtime_pool_max_waiting: maxWaiting, errors });
      } finally {
        closing = true; for (const socket of sockets) socket.terminate();
        await app.close(); app = undefined;
        await fixtures.query('DELETE FROM world_positions WHERE user_id=ANY($1::uuid[])', [users.map(user => user.id)]);
      }
      process.stderr.write(`Completed local capacity stage: ${count} clients\n`);
    }
    return results;
  } finally {
    await app?.close();
    try {
      if (users.length) await withTransaction(fixtures, async tx => {
        const ids = users.map(user => user.id);
        await tx.query('DELETE FROM world_positions WHERE user_id=ANY($1::uuid[])', [ids]);
        await tx.query('DELETE FROM user_sessions WHERE user_id=ANY($1::uuid[])', [ids]);
        await tx.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
      });
    } finally { await pool.end(); await fixtures.end(); }
  }
}

const report = { captured_at: new Date().toISOString(), mode: values.synthetic ? 'synthetic' : 'local_api_database_ws',
  environment: { node: process.version, platform: platform(), cpu: cpus()[0]?.model, logical_cpus: cpus().length, total_memory_mib: Math.round(totalmem() / 1048576) },
  limitations: values.synthetic ? ['Actual WorldStream serialization only; no database, socket, TLS or browser rendering.',
    'Payload bandwidth assumes 2 broadcasts/second, short display names and no Agent residents; excludes acknowledgements and cold assets.']
    : ['API and load generator share one process; RSS, CPU and event-loop samples include both. PostgreSQL resource use is excluded.',
      'Loopback sockets omit public bandwidth, latency, TLS, GitHub, background jobs and browser rendering.',
      'This isolated API raises its connection limit to the largest requested stage; production limits are unchanged.'],
  results: values.synthetic ? synthetic() : await real() };
const output = resolve(values.output ?? `.local/public-capacity-${values.synthetic ? 'synthetic' : 'local'}.json`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
