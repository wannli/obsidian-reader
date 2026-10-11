import { test, expect, type Page } from '@playwright/test';
async function command(page: Page, name: string) {
  await page.evaluate(() => window.reader.ui.more());
  await page.getByRole('dialog', { name: 'Reader commands', exact: true }).getByRole('button', { name, exact: true }).click();
}
for (const property of ['authors', 'topics'] as const) test(`${property} draft rejects a shadowed bare-link removal and allows explicit retry`, async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.r2-article-body')).toBeVisible();
  const fixture = await page.evaluate(async property => {
    const { store, app } = window.reader;
    const path = 'Reading/Inbox/Resolution browser.md', type = property === 'authors' ? 'person' : 'topic';
    const raw = `---\ntype: article\ntitle: Resolution browser\n${property}: ["[[Ada]]"]\ncustom: [keep, spacing]\n---\nUnchanged body.`;
    await store.create(path, raw); await store.create('People/Ada.md', `---\ntype: ${type}\n---\n`); await app.open(path);
    return { path, raw, type };
  }, property);
  await command(page, 'Assign ' + property);
  await expect(page.getByRole('checkbox', { name: 'People/Ada.md', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'People/Ada.md', exact: true }).uncheck();
  await page.evaluate(async type => { await window.reader.store.create('Ada.md', `---\ntype: ${type}\n---\n`); }, fixture.type);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign ' + property, exact: true });
  await expect(dialog.getByRole('alert')).toContainText('links resolve differently');
  expect(await page.evaluate(path => window.reader.store.read(path), fixture.path)).toBe(fixture.raw);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await command(page, 'Assign ' + property);
  await expect(page.getByRole('checkbox', { name: 'Ada.md', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Ada.md', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toBeHidden();
  expect(await page.evaluate(path => window.reader.store.read(path), fixture.path)).toBe(fixture.raw.replace(`${property}: ["[[Ada]]"]\n`, ''));
});
