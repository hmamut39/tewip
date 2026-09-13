import { test, expect } from '@playwright/test';

// Intentional flake: fails roughly 50% of the time. The received value differs on
// every failure, so the error message varies between runs — like real-world flakes.
test('cart updates after click', async ({ page }) => {
  await page.goto('/');
  await page.locator('#add-to-cart').click();
  await expect(page.locator('#cart-count')).toHaveText('1');

  const roll = Math.random();
  expect(roll, 'simulated race: backend sync finished in time').toBeGreaterThanOrEqual(0.5);
});
