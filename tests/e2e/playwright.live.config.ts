import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

if (existsSync(resolve('.env'))) loadEnvFile(resolve('.env'));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.local/playwright');

export default defineConfig({
  testDir: '.',
  testMatch: 'live.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: process.env.CI ? 120_000 : 60_000,
  outputDir: '../../test-results/live',
  use: { baseURL: 'http://localhost:3001', trace: 'retain-on-failure' },
  webServer: {
    command: 'node --env-file-if-exists=.env --import tsx tests/e2e/server.ts',
    cwd: resolve('.'),
    url: 'http://localhost:3001/health',
    reuseExistingServer: false,
  },
});
