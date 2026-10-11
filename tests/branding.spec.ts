import { expect, test } from '@playwright/test';

test('brands the preview and command menu as Reader', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Reader');
  await page.getByRole('button', { name: 'Command palette', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Reader commands', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
