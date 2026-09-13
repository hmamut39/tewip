import { test } from '@playwright/test';

// Intentional failure: the fixture app stays in 'loading' forever, so the test
// hits its own timeout and ends with status 'timedOut' (not 'failed').
test('app reaches ready state', async ({ page }) => {
  test.setTimeout(3_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).appState === 'ready', undefined, { timeout: 0 });
});
