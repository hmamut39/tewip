import { defineConfig } from '@playwright/test';
import { resolveRunId } from '../reporters/run-context.ts';

// Drift-lab config. LAB_VERSION picks the app version (v1 / v2); LAB_TEST_DIR points at the
// sandbox copy of the tests that the auto-fix loop is allowed to edit.
const PORT = Number(process.env.LAB_PORT ?? 4180);
const runId = resolveRunId();

export default defineConfig({
  testDir: process.env.LAB_TEST_DIR ?? './tests',
  outputDir: `../test-results/lab/${runId}`,
  timeout: 8_000,
  expect: { timeout: 1_500 },
  retries: 0,
  workers: 1,
  reporter: [['list'], ['../reporters/triage-reporter.ts']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    actionTimeout: 1_500,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node lab/server.ts',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
