import { test, expect } from '@playwright/test';

// Intentional failure: the fixture server answers /api/orders with HTTP 500.
test('orders load successfully', async ({ page }) => {
  await page.goto('/');
  const [response] = await Promise.all([
    page.waitForResponse('**/api/orders'),
    page.locator('#load-orders').click(),
  ]);
  expect(response.status(), 'GET /api/orders should return 200').toBe(200);
});
