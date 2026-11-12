import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '@agentzero/contracts';
import { AppError } from './core.js';

/** Single-instance, fixed-window admission control; entries never grow beyond the configured bound. */
export class RequestLimits {
  private buckets = new Map<string, { count: number; expires: number }>();
  private sweptAt = 0;

  constructor(private maxBuckets = 10000) {}

  take(key: string, limit: number, now = Date.now()): number {
    if (now - this.sweptAt >= 60000) {
      for (const [id, bucket] of this.buckets) if (bucket.expires <= now) this.buckets.delete(id);
      this.sweptAt = now;
    }
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.expires <= now) {
      if (!bucket && this.buckets.size >= this.maxBuckets) return 60;
      bucket = { count: 0, expires: now + 60000 };
      this.buckets.set(key, bucket);
    }
    if (++bucket.count > limit) return Math.max(1, Math.ceil((bucket.expires - now) / 1000));
    return 0;
  }

  private enforce(reply: FastifyReply, key: string, limit: number) {
    const retry = this.take(key, limit);
    if (!retry) return;
    reply.header('retry-after', retry);
    throw new AppError('RATE_LIMITED', 429, '请求过于频繁，请稍后重试');
  }

  request(request: FastifyRequest, reply: FastifyReply) {
    const path = request.routeOptions.url ?? request.url.split('?')[0]!;
    if (!path.startsWith('/api/') && path !== '/health' && !path.startsWith('/game-content/')) return;
    // request.ip uses only the explicitly configured proxy hop; never read X-Forwarded-For directly.
    this.enforce(reply, `ip:${request.ip}`, 600);
    if (path === '/api/v1/auth/github/start') this.enforce(reply, `oauth:${request.ip}`, 10);
    else if (request.method === 'POST' && path === '/api/v1/agent-registrations') this.enforce(reply, `registration:${request.ip}`, 10);
    else if (path === '/api/v1/world/stream') this.enforce(reply, `connect:${request.ip}`, 30);
  }

  mutation(request: FastifyRequest, reply: FastifyReply, actor: Actor) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || actor.type === 'system') return;
    const owner = actor.type === 'user' ? actor.userId : actor.ownerUserId;
    this.enforce(reply, `write:${owner}`, 120);
  }
}
