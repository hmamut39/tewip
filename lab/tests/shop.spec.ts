import { test, expect } from '@playwright/test';

// Written against lab/app/v1. The drift lab runs them against v2 to see what the agent does.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('adds a product to the cart', async ({ page }) => {
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.locator('#cart-count')).toHaveText('1');
});

test('starts checkout', async ({ page }) => {
  await page.locator('#checkout-button').click();
  await expect(page.locator('#order-status')).toHaveText('checking out');
});

test('applies a promo code', async ({ page }) => {
  await page.getByTestId('promo-input').fill('SAVE10');
  await expect(page.getByLabel('Promo code')).toHaveValue('SAVE10');
});

test('opens the account page', async ({ page }) => {
  await page.getByRole('link', { name: 'My account' }).click();
  await expect(page).toHaveURL(/#account$/);
});

test('shows the order summary', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Order summary' })).toBeVisible();
});

test('saves settings', async ({ page }) => {
  await page.locator('div#save').click();
  await expect(page.locator('#save-status')).toHaveText('saved');
});

test('removes an item', async ({ page }) => {
  await page.getByRole('button', { name: 'Add to cart' }).or(page.getByRole('button', { name: 'Add to bag' })).click();
  await page.getByRole('button', { name: 'Remove item' }).click();
  await expect(page.locator('#cart-count')).toHaveText('0');
});

test('shows the product price', async ({ page }) => {
  await expect(page.locator('#price')).toHaveText('$89.00');
});

test('places the order', async ({ page }) => {
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.locator('#order-status')).toHaveText('placed');
});

test('loads past orders', async ({ page }) => {
  await page.getByRole('button', { name: 'Load orders' }).click();
  await expect(page.locator('#orders')).toHaveText('loaded');
});

test('deletes the account', async ({ page }) => {
  await page.getByRole('button', { name: 'Delete account' }).click();
});

test('edits the shipping address', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('#address-status')).toHaveText('editing');
});

test('wraps a gift', async ({ page }) => {
  await page.getByRole('button', { name: 'Gift' }).click();
  await expect(page.locator('#gift-status')).toHaveText('wrapped');
});
