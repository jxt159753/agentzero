import { buildApp } from '../../apps/api/src/app.js';
import { testPools } from '../integration/ledger-fixtures.js';

// This entry point is only used by browser tests. Production never loads this provider.
const pools = testPools();
const app = await buildApp({
  pool: pools.runtime,
  config: {
    databaseUrl: process.env.TEST_DATABASE_URL!,
    publicOrigin: 'http://localhost:3001',
    githubClientId: 'browser-test-app',
    githubClientSecret: 'browser-test-secret',
    bootstrapAdminGithubId: '71001',
    production: false,
    host: 'localhost',
    port: 3001,
  },
  serveWeb: true,
  github: {
    async exchange(code, verifier) {
      if (!['71001', '71002', '71003', '71004'].includes(code) || !/^[A-Za-z\d_-]{43}$/.test(verifier)) throw new Error('Invalid test OAuth exchange');
      return { id: code, login: `browser-${code}`, name: code === '71001' ? '浏览器管理员' : code === '71002' ? '浏览器成员' : code === '71003' ? '浏览器验收人' : '浏览器协作者', avatarUrl: null };
    },
  },
  repositoryGithub: {
    async getInstallation({ installationId }) {
      if (installationId !== '99001') throw new Error('Unexpected browser-test installation');
      return { installationId, accountLogin: 'browser-fixtures', status: 'active' };
    },
    async getRepository({ installationId, owner, name }) {
      if (installationId !== '99001' || owner !== 'browser-fixtures' || name !== 'phase-two') throw new Error('Unexpected browser-test repository');
      return { repositoryId: '88001', owner, name, fullName: `${owner}/${name}`, isPrivate: false };
    },
    async getPullRequest({ installationId, repositoryId, owner, name, number }) {
      if (installationId !== '99001' || repositoryId !== '88001' || owner !== 'browser-fixtures' || name !== 'phase-two' || number !== 7) throw new Error('Unexpected browser-test PR');
      return {
        repositoryId, number, headSha: 'c'.repeat(40), authorGithubId: '71002', merged: true,
        url: 'https://github.com/browser-fixtures/phase-two/pull/7',
        checks: [{ name: 'tests', status: 'completed', conclusion: 'success' }], fetchedAt: new Date().toISOString(),
      };
    },
  },
});

await app.listen({ host: 'localhost', port: 3001 });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  void app.close().then(() => Promise.all([pools.runtime.end(), pools.migration.end()])).then(() => process.exit(0));
});
