import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { RawData, WebSocket } from 'ws';
import { withTransaction, type Tx } from '@agentzero/database';
import type { Actor, WorldChanges, WorldSelf, WorldStreamDelta, WorldStreamInput, WorldStreamMessage } from '@agentzero/contracts';
import { isWorldRoom, WORLD_ROOM_DIMENSIONS } from '@agentzero/contracts';
import { AppError, lockActor } from '../../core.js';
import { heartbeat, validateWorldPosition, worldBounds, worldProjection, worldSubject, type WorldProjection } from './service.js';

const REFRESH_MS = 2000, SEND_MS = 500, CHECKPOINT_MS = 10000;
interface Peer {
  id: string; actor: Actor; socket: WebSocket; v2: boolean; ready: boolean; closed: boolean;
  key: string; kind: 'visitor' | 'agent'; subjectId: string;
  x: number; y: number; roomId: string | null; version: string; expires: number;
  sequence: number; savedSequence: number; moving: boolean; dirty: boolean;
  lastHeartbeat: number; lastCheckpoint: number; lastPing: number;
  windowStart: number; messageCount: number; lastSelf?: WorldSelf;
  flushing?: Promise<void>;
}
interface Authority {
  id: string; valid: boolean; x: number | null; y: number | null; room_id: string | null; version: string | null;
  expires: string | null; owns: boolean | null;
}

function changes<T extends { id: string }>(before: T[], after: T[]): WorldChanges<T> | undefined {
  if (before === after) return undefined;
  const previous = new Map(before.map(item => [item.id, JSON.stringify(item)]));
  const upsert = after.filter(item => previous.get(item.id) !== JSON.stringify(item));
  const ids = new Set(after.map(item => item.id)), remove = before.filter(item => !ids.has(item.id)).map(item => item.id);
  return upsert.length || remove.length ? { upsert, remove } : undefined;
}

/** One coherent database projection per town; frequent movement stays in this process. */
export class WorldStream {
  private peers = new Set<Peer>();
  private owners = new Map<string, Peer>();
  private projection?: WorldProjection;
  private published?: WorldProjection;
  private refreshing?: Promise<void>;
  private refreshAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private draining = new Set<Promise<void>>();
  private initializing = new Set<Promise<void>>();
  private connectionRevision = 0;
  private projectionRevision = 0;

  constructor(private pool: Pool) {}

  connect(socket: WebSocket, actor: Actor, v2: boolean) {
    const subject = worldSubject(actor), now = Date.now();
    const peer: Peer = { id: randomUUID(), actor, socket, v2, ready: false, closed: false,
      key: `${subject.kind}:${subject.id}`, kind: subject.kind, subjectId: subject.id,
      x: 0, y: 0, roomId: null, version: '', expires: 0, sequence: -1, savedSequence: -1,
      moving: false, dirty: false, lastHeartbeat: now, lastCheckpoint: now, lastPing: 0,
      windowStart: now, messageCount: 0 };
    this.peers.add(peer);
    socket.on('message', data => this.message(peer, data));
    socket.on('close', () => this.disconnect(peer));
    socket.on('error', () => this.disconnect(peer));
    if (!this.timer) { this.timer = setInterval(() => this.tick(), SEND_MS); this.timer.unref(); }
    const initialized = this.initialize(peer).catch(error => this.fail(peer, error));
    this.initializing.add(initialized);
    void initialized.finally(() => this.initializing.delete(initialized));
  }

  private send(peer: Peer, message: WorldStreamMessage) {
    if (peer.closed || peer.socket.readyState !== 1) return;
    // A suspended tab must not accumulate an unbounded stream of obsolete positions.
    if (peer.socket.bufferedAmount > 1024 * 1024) { this.fail(peer, new AppError('ACCESS_DENIED', 403, 'World connection is too slow')); return; }
    peer.socket.send(JSON.stringify(message));
  }

  private fail(peer: Peer, error: unknown) {
    if (peer.closed) return;
    peer.socket.close(error instanceof AppError ? 1008 : 1011, error instanceof AppError ? error.code : 'World unavailable');
    this.disconnect(peer);
  }

  private async initialize(peer: Peer) {
    const position = await withTransaction(this.pool, async tx => {
      await lockActor(tx, peer.actor, { allowPaused: true });
      if (peer.v2) await heartbeat(tx, peer.actor, {});
      return (await tx.query('SELECT x,y,room_id,updated_at::text AS version,expires_at::text AS expires FROM world_positions WHERE kind=$1 AND subject_id=$2', [peer.kind, peer.subjectId])).rows[0];
    });
    if (peer.closed || this.stopped) return;
    peer.x = position?.x ?? 0; peer.y = position?.y ?? 0; peer.roomId = position?.room_id ?? null;
    peer.version = position?.version ?? ''; peer.expires = position ? Date.parse(position.expires) : 0;
    if (peer.v2) {
      const prior = this.owners.get(peer.key);
      this.owners.set(peer.key, peer);
      if (prior) this.fail(prior, new AppError('ACCESS_DENIED', 403, 'World opened in another connection'));
    }
    // New/reconnected clients start with a current committed view, never a cached ownership view.
    // A join that commits during an older query shares the next refresh with other joins.
    const revision = ++this.connectionRevision;
    do { await this.refresh(); } while (!peer.closed && !this.stopped && this.projectionRevision < revision);
    if (peer.closed || !this.projection) return;
    peer.ready = true;
    const projection = this.current(), self = this.self(peer, projection);
    peer.lastSelf = self; peer.lastPing = Date.now();
    this.send(peer, this.snapshot(projection, self));
  }

  private async authorities(tx: Tx, peers: Peer[]) {
    const identities = peers.map(peer => {
      const actor = peer.actor, subject = worldSubject(actor);
      return { id: peer.id, kind: subject.kind, subject_id: subject.id, user_id: subject.userId,
        session_id: actor.type === 'user' ? actor.sessionId : null,
        credential_id: actor.type === 'agent' ? actor.credentialId : null };
    });
    return (await tx.query<Authority>(`SELECT c.id,
      COALESCE(u.status='active' AND ((c.kind='visitor' AND s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
        OR (c.kind='agent' AND a.owner_user_id=u.id AND a.deleted_at IS NULL AND a.status='active'
          AND k.agent_id=a.id AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp())),false) AS valid,
      p.x,p.y,p.room_id,p.updated_at::text AS version,p.expires_at::text AS expires,
      (p.session_id=c.session_id OR p.credential_id=c.credential_id) AS owns
      FROM jsonb_to_recordset($1::jsonb) AS c(id text,kind text,subject_id uuid,user_id uuid,session_id uuid,credential_id uuid)
      LEFT JOIN users u ON u.id=c.user_id
      LEFT JOIN user_sessions s ON s.id=c.session_id
      LEFT JOIN agents a ON c.kind='agent' AND a.id=c.subject_id
      LEFT JOIN agent_keys k ON k.id=c.credential_id
      LEFT JOIN world_positions p ON p.kind=c.kind AND p.subject_id=c.subject_id`, [JSON.stringify(identities)])).rows;
  }

  private refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshAt = Date.now();
    const peers = [...this.peers], versions = new Map(peers.map(peer => [peer.id, peer.version]));
    const revision = this.connectionRevision;
    this.refreshing = withTransaction(this.pool, async tx => {
      const authority = await this.authorities(tx, peers);
      const projection = await worldProjection(tx);
      return { authority, projection };
    }).then(({ authority, projection }) => {
      if (this.stopped) return;
      const byId = new Map(authority.map(row => [row.id, row]));
      for (const peer of peers) {
        if (peer.closed) continue;
        const row = byId.get(peer.id);
        if (!row?.valid) { this.fail(peer, new AppError('UNAUTHENTICATED', 401)); continue; }
        if (peer.v2 && this.owners.get(peer.key) === peer) {
          if (!peer.flushing && peer.version === versions.get(peer.id)
            && (!row.owns || row.version !== peer.version || Date.parse(row.expires ?? '') <= Date.now())) {
            this.owners.delete(peer.key);
            const expired = row.owns && row.version === peer.version && Date.parse(row.expires ?? '') <= Date.now();
            this.fail(peer, new AppError(expired ? 'WORLD_PRESENCE_EXPIRED' : 'ACCESS_DENIED', 403));
          }
        } else { peer.x = row.x ?? 0; peer.y = row.y ?? 0; peer.roomId = row.room_id; }
      }
      this.projection = projection; this.projectionRevision = revision;
      this.publish(true);
    }).catch(error => {
      for (const peer of peers) this.fail(peer, error);
    }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private current(): WorldProjection {
    const source = this.projection!;
    const point = (kind: 'agent' | 'visitor', id: string) => {
      const peer = this.owners.get(`${kind}:${id}`);
      return peer && !peer.closed && peer.expires > Date.now() ? { x: peer.x, y: peer.y, room_id: peer.roomId } : undefined;
    };
    const agents = source.agents.map(agent => { const p = agent.online && point('agent', agent.id); return p ? { ...agent, ...p } : agent; });
    const visitors = source.visitors.map(visitor => { const p = point('visitor', visitor.id); return p ? { ...visitor, ...p } : visitor; });
    return { ...source, server_time: new Date().toISOString(), agents, visitors, bounds: worldBounds(source.lands, [...agents, ...visitors]) };
  }

  private self(peer: Peer, projection: WorldProjection): WorldSelf {
    const actor = peer.kind === 'agent' ? projection.agents.find(item => item.id === peer.subjectId) : projection.visitors.find(item => item.id === peer.subjectId);
    return { kind: peer.kind, id: peer.subjectId, x: actor?.x ?? peer.x, y: actor?.y ?? peer.y, room_id: actor ? actor.room_id ?? null : peer.roomId, online: actor?.online ?? false };
  }

  private snapshot(projection: WorldProjection, self: WorldSelf): WorldStreamMessage {
    return { type: 'snapshot', world: { ...projection, self,
      bounds: worldBounds(projection.lands, [...projection.agents, ...projection.visitors, self]) } };
  }

  private publish(databaseRefresh = false) {
    if (!this.projection) return;
    const next = this.current(), prior = this.published;
    const delta: WorldStreamDelta = { type: 'delta', server_time: next.server_time,
      lands: changes(prior?.lands ?? [], next.lands), agents: changes(prior?.agents ?? [], next.agents), visitors: changes(prior?.visitors ?? [], next.visitors),
      bounds: !prior || JSON.stringify(prior.bounds) !== JSON.stringify(next.bounds) ? next.bounds : undefined };
    const changed = Boolean(delta.lands || delta.agents || delta.visitors || delta.bounds);
    this.published = next;
    for (const peer of this.peers) {
      if (!peer.ready || peer.closed) continue;
      const self = this.self(peer, next), selfChanged = JSON.stringify(self) !== JSON.stringify(peer.lastSelf);
      peer.lastSelf = self;
      if (!peer.v2) { if (databaseRefresh) this.send(peer, this.snapshot(next, self)); }
      else if (changed || selfChanged) this.send(peer, { ...delta, ...(selfChanged ? { self } : {}) });
      else if (Date.now() - peer.lastPing >= REFRESH_MS) this.send(peer, { type: 'ping', server_time: next.server_time });
      if (databaseRefresh) peer.lastPing = Date.now();
    }
  }

  private message(peer: Peer, raw: RawData) {
    if (!peer.v2 || !peer.ready || peer.closed || this.owners.get(peer.key) !== peer) {
      this.fail(peer, new AppError('ACCESS_DENIED', 403)); return;
    }
    const now = Date.now();
    if (now - peer.windowStart >= 1000) { peer.windowStart = now; peer.messageCount = 0; }
    if (++peer.messageCount > 12) { this.fail(peer, new AppError('INVALID_REQUEST', 400)); return; }
    let message: WorldStreamInput;
    try { message = JSON.parse(raw.toString()) as WorldStreamInput; } catch { this.fail(peer, new AppError('INVALID_REQUEST', 400)); return; }
    if (message && message.type === 'heartbeat' && Object.keys(message).length === 1) {
      if (now - peer.lastHeartbeat >= 10000) { peer.lastHeartbeat = now; void this.checkpoint(peer, true); }
      return;
    }
    if (!message || message.type !== 'move' || Object.keys(message).some(key => !['type','seq','x','y','room_id','moving'].includes(key))
      || !Number.isSafeInteger(message.seq) || message.seq < 0 || typeof message.moving !== 'boolean'
      || message.room_id !== undefined && message.room_id !== null && (typeof message.room_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.room_id))
      || !Number.isFinite(message.x) || !Number.isFinite(message.y) || Math.abs(message.x) > 1000000 || Math.abs(message.y) > 1000000) {
      this.fail(peer, new AppError('INVALID_REQUEST', 400)); return;
    }
    if (message.seq <= peer.sequence) {
      this.send(peer, { type: 'ack', seq: peer.sequence, x: peer.x, y: peer.y, room_id: peer.roomId, persisted: peer.savedSequence >= peer.sequence }); return;
    }
    const roomId = message.room_id === undefined ? peer.roomId : message.room_id;
    if (roomId && (!this.projection?.lands.some(land => land.models?.some(model => model.id === roomId && !model.room_id && isWorldRoom(model.model_id)))
      || Math.abs(message.x) > WORLD_ROOM_DIMENSIONS.width / 2 || Math.abs(message.y) > WORLD_ROOM_DIMENSIONS.height / 2)) {
      this.fail(peer, new AppError('WORLD_ROOM_INVALID', 400)); return;
    }
    const roomChanged = roomId !== peer.roomId;
    peer.sequence = message.seq; peer.x = message.x; peer.y = message.y; peer.roomId = roomId;
    peer.dirty = true; peer.moving = message.moving;
    this.send(peer, { type: 'ack', seq: peer.sequence, x: peer.x, y: peer.y, room_id: peer.roomId, persisted: false });
    // Stop is a checkpoint request, coalesced with in-flight writes and bounded to 1 Hz.
    if (roomChanged || !peer.moving && now - peer.lastCheckpoint >= 1000) void this.checkpoint(peer);
  }

  private checkpoint(peer: Peer, renew = false): Promise<void> {
    if (peer.flushing) return peer.flushing;
    if (this.owners.get(peer.key) !== peer || (!peer.dirty && !renew)) return Promise.resolve();
    const sequence = peer.sequence, x = peer.x, y = peer.y, roomId = peer.roomId, version = peer.version;
    peer.lastCheckpoint = Date.now();
    peer.flushing = withTransaction(this.pool, async tx => {
      await lockActor(tx, peer.actor);
      await validateWorldPosition(tx, x, y, roomId);
      const actor = peer.actor;
      const row = (await tx.query(`UPDATE world_positions SET x=$3,y=$4,room_id=$8,expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
        WHERE kind=$1 AND subject_id=$2 AND updated_at=$5::timestamptz AND expires_at>clock_timestamp()
          AND (session_id=$6 OR credential_id=$7)
        RETURNING updated_at::text AS version,expires_at::text AS expires`,
      [peer.kind, peer.subjectId, x, y, version, actor.type === 'user' ? actor.sessionId : null, actor.type === 'agent' ? actor.credentialId : null, roomId])).rows[0];
      if (row) return row;
      const expired = (await tx.query(`SELECT updated_at=$3::timestamptz AND expires_at<=clock_timestamp()
        AND (session_id=$4 OR credential_id=$5) AS expired FROM world_positions WHERE kind=$1 AND subject_id=$2`,
      [peer.kind, peer.subjectId, version, actor.type === 'user' ? actor.sessionId : null, actor.type === 'agent' ? actor.credentialId : null])).rows[0]?.expired;
      return { rejected: expired ? 'WORLD_PRESENCE_EXPIRED' : 'ACCESS_DENIED' };
    }).then(row => {
      if (row.rejected) { if (this.owners.get(peer.key) === peer) this.owners.delete(peer.key); this.fail(peer, new AppError(row.rejected, 403)); return; }
      peer.version = row.version; peer.expires = Date.parse(row.expires); peer.savedSequence = sequence;
      peer.dirty = peer.sequence !== sequence;
      if (sequence >= 0) this.send(peer, { type: 'ack', seq: sequence, x, y, room_id: roomId, persisted: true });
    }).catch(error => this.fail(peer, error)).finally(() => { peer.flushing = undefined; });
    return peer.flushing;
  }

  private tick() {
    if (this.stopped) return;
    for (const peer of this.peers) if (peer.socket.readyState !== 1) this.disconnect(peer);
    if (!this.peers.size) { clearInterval(this.timer); this.timer = undefined; this.projection = this.published = undefined; return; }
    if (Date.now() - this.refreshAt >= REFRESH_MS) void this.refresh();
    for (const peer of this.owners.values()) {
      if (peer.dirty && (Date.now() - peer.lastCheckpoint >= CHECKPOINT_MS || !peer.moving && Date.now() - peer.lastCheckpoint >= 1000)) void this.checkpoint(peer);
    }
    this.publish();
  }

  private disconnect(peer: Peer) {
    if (peer.closed) return;
    peer.closed = true; this.peers.delete(peer);
    // A conditional checkpoint cannot revive an expired/revoked/replaced lease.
    if (this.owners.get(peer.key) === peer) {
      const drain = (async () => {
        await peer.flushing;
        if (this.owners.get(peer.key) === peer && peer.dirty) await this.checkpoint(peer);
        if (this.owners.get(peer.key) === peer) this.owners.delete(peer.key);
      })();
      this.draining.add(drain);
      void drain.finally(() => this.draining.delete(drain));
    }
  }

  async close() {
    this.stopped = true; clearInterval(this.timer);
    for (const peer of this.peers) { peer.socket.close(1001, 'Server closing'); this.disconnect(peer); }
    await Promise.all(this.initializing);
    await this.refreshing;
    await Promise.all([...this.owners.values()].map(peer => peer.flushing ?? this.checkpoint(peer)));
    await Promise.all(this.draining);
    this.owners.clear();
  }
}
