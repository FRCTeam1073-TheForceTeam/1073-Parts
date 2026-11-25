// End-to-end tests: real browser, real server, fresh database per run. See e2e/AGENTS.md.
// Kept apart from the unit (test/unit) and database (test/db) suites, which node:test runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Set here so the worker processes, which load this file again, see the same values.
process.env.E2E_PORT ??= '3100';
process.env.E2E_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'parts-e2e-'));
const baseURL = `http://127.0.0.1:${process.env.E2E_PORT}`;

export default defineConfig({
  testDir: 'e2e/specs',
  outputDir: 'e2e/test-results',
  reporter: [['list'], ['html', { outputFolder: 'e2e/playwright-report', open: 'never' }]],

  // One server and one SQLite file, shared by every spec, so run one worker and keep specs independent.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  globalSetup: './e2e/support/global-setup.js',
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
