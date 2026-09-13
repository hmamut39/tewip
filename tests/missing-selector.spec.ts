import { test } from '@playwright/test';

// Intentional failure: the checkout button does not exist on the fixture page.
test('checkout button can be clicked', async ({ page }) => {
  await page.goto('/');
  await page.locator('#checkout-button').click();
});
