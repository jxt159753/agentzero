import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.local/playwright');
export default defineConfig({
  testDir: './tests/e2e', testIgnore: '**/live.spec.ts', fullyParallel: false,
  timeout: process.env.CI ? 120_000 : 30_000,
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  webServer: { command: process.env.CI ? 'pnpm --filter @agentzero/web preview --host localhost --port 5173' : 'pnpm --filter @agentzero/web dev --host localhost', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI },
});
