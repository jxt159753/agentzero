import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { loadConfig, type Config } from '../../apps/api/src/config.js';
import { RequestLimits } from '../../apps/api/src/rate-limit.js';
type FastifyRequest = Parameters<RequestLimits['request']>[0];
type FastifyReply = Parameters<RequestLimits['request']>[1];

const config: Config = { databaseUrl: 'unused', publicOrigin: 'https://agentzero.test', githubClientId: '', githubClientSecret: '', bootstrapAdminGithubId: '', production: true, host: '127.0.0.1', port: 0 };
const pool = { connect: async () => ({ query: async () => ({ rows: [{ default_land_supplied: true }] }), release() {} }) } as unknown as Pool;

describe('public launch request limits', () => {
  it('expires windows and bounds distinct source memory without discarding active limits', () => {
    const limits = new RequestLimits(2);
    expect(limits.take('one', 1, 1000)).toBe(0);
    expect(limits.take('one', 1, 1100)).toBe(60);
    expect(limits.take('two', 1, 1200)).toBe(0);
    expect(limits.take('three', 1, 1300)).toBe(60);
    expect(limits.take('one', 1, 2000)).toBe(59);
    expect(limits.take('three', 1, 62000)).toBe(0);
  });

  it('shares authenticated write limits between a user and every owned Agent', () => {
    const limits = new RequestLimits(), headers: Record<string, unknown> = {};
    const reply = { header: (key: string, value: unknown) => { headers[key] = value; } } as FastifyReply;
    const request = { method: 'POST' } as FastifyRequest;
    const owner = { type: 'user' as const, userId: 'owner', sessionId: 'session' };
    for (let i = 0; i < 120; i++) limits.mutation(request, reply, owner);
    expect(() => limits.mutation(request, reply, { type: 'agent', agentId: 'agent', ownerUserId: 'owner', credentialId: 'key' })).toThrow('请求过于频繁');
    expect(headers['retry-after']).toBeGreaterThan(0);
    expect(() => limits.mutation(request, reply, { ...owner, userId: 'another' })).not.toThrow();
    expect(() => limits.mutation({ method: 'GET' } as FastifyRequest, reply, owner)).not.toThrow();
  });

  it.each([0, 1] as const)('rejects forwarded-prefix rotation with %i trusted proxy hops', async trustProxyHops => {
    const app = await buildApp({ config: { ...config, trustProxyHops }, pool });
    try {
      for (let i = 0; i < 10; i++) {
        const response = await app.inject({ url: '/api/v1/auth/github/start', headers: { 'x-forwarded-for': `198.51.100.${i + 1}, 203.0.113.9` } });
        expect(response.statusCode).toBe(503);
      }
      const blocked = await app.inject({ url: '/api/v1/auth/github/start', headers: { 'x-forwarded-for': '198.51.100.200, 203.0.113.9' } });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.headers['cache-control']).toBe('no-store');
      const distinct = await app.inject({ url: '/api/v1/auth/github/start', headers: { 'x-forwarded-for': '203.0.113.10' } });
      expect(distinct.statusCode).toBe(trustProxyHops ? 503 : 429);
      expect((await app.inject('/api/v1/public-config')).json()).toEqual({ registration_mode: 'approval' });
    } finally { await app.close(); }
  });

  it('validates explicit admission, proxy and connection configuration', () => {
    const env = { DATABASE_URL: 'unused' };
    expect(loadConfig(env)).toMatchObject({ registrationMode: 'approval', trustProxyHops: 0, maxAgentsPerUser: 5, worldMaxConnections: 50, worldMaxConnectionsPerUser: 3 });
    expect(loadConfig({ ...env, REGISTRATION_MODE: 'public', TRUST_PROXY_HOPS: '1', WORLD_MAX_CONNECTIONS: '25' })).toMatchObject({ registrationMode: 'public', trustProxyHops: 1, worldMaxConnections: 25 });
    for (const extra of [{ REGISTRATION_MODE: 'automatic' }, { TRUST_PROXY_HOPS: 'true' }, { MAX_AGENTS_PER_USER: '0' }, { WORLD_MAX_CONNECTIONS: '1.5' }, { WORLD_MAX_CONNECTIONS_PER_USER: '-1' }]) expect(() => loadConfig({ ...env, ...extra })).toThrow();
  });
});
