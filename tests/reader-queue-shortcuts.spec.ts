import { test, expect, type Page } from '@playwright/test';
async function ready(page: Page) {
  await page.goto('/'); await expect(page.locator('.r2-article-body')).toBeVisible();
  await page.evaluate(async () => {
    const { app, controller } = window.reader; controller.setActive(false);
    // Explicit queues and inline syntax, independent of preview seed titles/dates.
    const paths: string[] = [];
    for (const status of ['inbox', 'later', 'feed', 'archive'] as const) {
      const article = await controller.repository.createArticle({ title: 'Keyboard ' + status,
        url: 'https://example.org/keyboard-' + status, status, extractor: 'manual',
        body: 'Keep ==these words== and [[Keyboard topic|this link]] intact.' });
      paths.push(article.path);
    }
    await app.refresh(); await app.open(paths[0]);
  });
}
async function queue(page: Page) { return page.evaluate(() => window.reader.app.getState().queue); }
async function snapshot(page: Page) { return page.evaluate(() => window.reader.store.snapshot()); }
async function command(page: Page, name: string) {
  await page.getByRole('button', { name: 'Command palette', exact: true }).click();
  await page.getByRole('dialog', { name: 'Reader commands', exact: true }).getByRole('button', { name, exact: true }).click();
}
test('h/l switch queues with notices, boundaries and unchanged files', async ({ page }, info) => {
  test.skip(info.project.name.includes('mobile'), 'Desktop shortcuts'); await ready(page); const before = await snapshot(page);
  await page.keyboard.press('h'); await expect(page.getByRole('status').filter({ hasText: 'Already at the first queue: Inbox.' })).toBeVisible();
  for (const [status, name] of [['later', 'Later'], ['feed', 'Stream'], ['archive', 'Treasury']]) {
    await page.keyboard.press('l'); await expect.poll(() => queue(page)).toBe(status);
    await expect(page.locator('.r2-article-body')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Queue: ' + name + '.' })).toBeVisible();
  }
  await page.keyboard.press('l'); await expect(page.getByRole('status').filter({ hasText: 'Already at the last queue: Treasury.' })).toBeVisible();
  await page.keyboard.press('h'); await expect.poll(() => queue(page)).toBe('feed'); await expect(page.locator('.r2-article-body')).toBeVisible();
  expect(await snapshot(page)).toEqual(before);
});
test('Shift+H/L move articles with notices and retain the origin queue', async ({ page }, info) => {
  test.skip(info.project.name.includes('mobile'), 'Desktop shortcuts'); await ready(page);
  const original = await page.evaluate(() => window.reader.app.getArticle()!);
  await page.keyboard.press('Shift+L'); await expect(page.getByRole('status').filter({ hasText: 'Moved to Later.' })).toBeVisible();
  expect(await queue(page)).toBe('inbox');
  const moved = await page.evaluate(async original => {
    const { controller, app } = window.reader, articles = await controller.repository.listArticles();
    const moved = articles.find(article => article.url === original.url)!; await app.open(moved.path); return moved;
  }, original);
  expect(moved.status).toBe('later'); expect(moved.body).toBe(original.body);
  expect(moved.highlights.map(item => item.quote)).toEqual(['these words']);
  expect(moved.body).toContain('[[Keyboard topic|this link]]');
  await page.keyboard.press('Shift+H'); await expect(page.getByRole('status').filter({ hasText: 'Moved to Inbox.' })).toBeVisible();
  expect(await queue(page)).toBe('later');
  const restored = await page.evaluate(async path => window.reader.controller.repository.getArticle(path), original.path);
  expect(restored.body).toBe(original.body); expect(restored.status).toBe('inbox');
});
test('queue shortcuts ignore inactive readers, typing, dialogs, and modified keys', async ({ page }, info) => {
  test.skip(info.project.name.includes('mobile'), 'Desktop shortcuts'); await ready(page); const before = await snapshot(page);
  await page.evaluate(() => { window.reader.ui.active = false; });
  await page.keyboard.press('l'); await page.keyboard.press('Shift+L');
  await page.evaluate(() => { window.reader.ui.active = true; });
  await command(page, 'Reading list');
  await page.keyboard.press('l'); await page.keyboard.press('Shift+L');
  // Escape first clears a native search input; explicitly dismiss the picker.
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => { const input = document.createElement('textarea'); input.id = 'shortcut-typing'; document.querySelector('.r2-content')!.append(input); input.focus(); });
  await expect(page.locator('#shortcut-typing')).toBeFocused();
  await page.keyboard.press('l'); await page.keyboard.press('Shift+L'); await expect(page.locator('#shortcut-typing')).toHaveValue('lL');
  await page.locator('#shortcut-typing').evaluate(node => node.remove());
  await page.locator('.r2-article-title').focus();
  for (const key of ['Control+l', 'Alt+l', 'Meta+l']) {
    await page.evaluate(key => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, ctrlKey: key === 'Control+l', altKey: key === 'Alt+l', metaKey: key === 'Meta+l' })), key);
  }
  expect(await queue(page)).toBe('inbox'); expect(await snapshot(page)).toEqual(before);
  await expect(page.getByRole('status').filter({ hasText: /^(Queue:|Moved to)/ })).toHaveCount(0);
});
test('h/l and shifted moves stay disabled on simulated mobile', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'), 'Mobile host only'); await ready(page); const before = await snapshot(page);
  for (const key of ['h', 'l', 'Shift+H', 'Shift+L']) await page.keyboard.press(key);
  expect(await queue(page)).toBe('inbox'); expect(await snapshot(page)).toEqual(before);
});
