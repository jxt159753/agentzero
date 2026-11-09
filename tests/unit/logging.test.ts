import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/config.js';

const config: Config = {
  databaseUrl: 'unused', publicOrigin: 'http://localhost:5173', githubClientId: '', githubClientSecret: '',
  bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 3000,
};
// These logging tests use a database whose one-time town initialization is already complete.
const initializedPool = {
  connect: async () => ({ query: async () => ({ rows: [{ default_land_supplied: true }] }), release() {} }),
};

describe('request logging privacy and correlation', () => {
  it('does not echo OAuth query values in unknown-route logs or responses', async () => {
    const lines: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
    const app = await buildApp({ config, logger: true, pool: initializedPool as unknown as Pool });
    try {
      const response = await app.inject('/api/v1/auth/github/wrong-callback?code=oauth-code-canary&state=oauth-state-canary');
      expect(response.statusCode).toBe(404);
      expect(lines.join('')).not.toContain('oauth-code-canary');
      expect(lines.join('')).not.toContain('oauth-state-canary');
      expect(response.body).not.toContain('oauth-code-canary');
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND', request_id: expect.any(String) } });
      expect(response.headers['x-request-id']).toBe(response.json().error.request_id);
      const requests = lines.flatMap(line => line.trim().split('\n')).map(line => JSON.parse(line));
      expect(requests).toContainEqual(expect.objectContaining({ reqId: response.json().error.request_id }));
    } finally { await app.close(); stdout.mockRestore(); }
  });

  it('keeps headers, bodies, returned secrets and database error details out of logs', async () => {
    const lines: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
    const pool = { ...initializedPool, query: async () => { throw Object.assign(new Error('postgresql://user:database-password-canary@localhost/db'), { code: 'ECONNREFUSED', detail: 'database-detail-canary' }); } } as unknown as Pool;
    const app = await buildApp({ config, logger: true, pool });
    app.post('/log-fixture', async (_request, reply) => reply.setCookie('az_session', 'response-cookie-canary').send({ secret: 'response-secret-canary' }));
    try {
      const success = await app.inject({
        method: 'POST', url: '/log-fixture?token=query-token-canary',
        headers: { authorization: 'Bearer authorization-canary', cookie: 'az_session=request-cookie-canary', 'x-csrf-token': 'csrf-canary' },
        payload: { message: 'body-canary', github_token: 'github-token-canary', private_key: 'private-key-canary' },
      });
      expect(success.statusCode).toBe(200);
      expect(success.headers['x-request-id']).toEqual(expect.any(String));
      const rejection = await app.inject('/api/v1/me');
      expect(rejection.statusCode).toBe(401);
      const failure = await app.inject('/health');
      expect(failure.statusCode).toBe(500);
      const output = lines.join('');
      expect(output).not.toContain('canary');
      expect(failure.body).not.toContain('canary');
      const requests = lines.flatMap(line => line.trim().split('\n')).map(line => JSON.parse(line));
      expect(requests).toContainEqual(expect.objectContaining({ error_code: 'UNAUTHENTICATED', request_id: rejection.json().error.request_id, route: '/api/v1/me', msg: 'Request rejected' }));
      expect(requests).toContainEqual(expect.objectContaining({ error_code: 'INTERNAL_ERROR', cause_code: 'ECONNREFUSED', request_id: failure.json().error.request_id, route: '/health', msg: 'Request failed' }));
    } finally { await app.close(); stdout.mockRestore(); }
  });
});
