import { defineConfig } from '@playwright/test';
import { resolveRunId } from './reporters/run-context.ts';

const PORT = Number(process.env.FIXTURE_PORT ?? 4173);
const runId = resolveRunId();

export default defineConfig({
  testDir: './tests',
  // One output folder per run so trace/screenshot paths in data/triage.jsonl stay
  // valid after later runs (Playwright wipes outputDir at the start of each run).
  outputDir: `./test-results/${runId}`,
  timeout: 10_000,
  expect: { timeout: 2_000 },
  retries: 0,
  workers: 1,
  reporter: [['list'], ['./reporters/triage-reporter.ts']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    actionTimeout: 2_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node fixtures/server.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
