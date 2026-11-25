// First-run setup tests. They need a server whose database has no accounts yet, and that
// has a setup code, so they can't share the main e2e server. Run with: npm run test:e2e:first-run
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

process.env.E2E_PORT ??= '3101';
process.env.E2E_SETUP_CODE ??= 'e2e-setup-code';
process.env.E2E_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'parts-e2e-first-run-'));
const baseURL = `http://127.0.0.1:${process.env.E2E_PORT}`;

export default defineConfig({
  testDir: 'e2e/first-run',
  outputDir: 'e2e/test-results-first-run',
  reporter: [['list']],
  // The steps depend on each other (wrong code, then right code), so run them in order.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: { baseURL, locale: 'en-US', timezoneId: 'UTC', screenshot: 'only-on-failure', trace: 'off' },
  globalTeardown: './e2e/support/global-teardown.js',
  webServer: {
    command: 'node e2e/support/serve.js',
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
