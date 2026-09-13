import { test, expect } from '@playwright/test';

// Intentional failure: the page shows $24.99, the test expects $19.99.
test('product shows sale price', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#price')).toHaveText('$19.99');
});
