import { test, expect, type Page } from '@playwright/test';
import { expectOnlyReadingPositionChanged } from './helpers/reading-position-note';
import { agents, fixture, position, progress, turnTo, expectVisiblePosition, expectNoPageBar } from './helpers/eink-browser';

async function ready(page: Page) {
  await page.goto('/?mobile=1'); await expect(page.locator('.r2-article-body')).toBeVisible();
  await page.evaluate(async () => {
    const { app, controller } = window.reader; controller.setActive(false);
    const first = (await controller.repository.listArticles()).find(article => article.status === 'inbox')!;
    await app.refresh(); await app.open(first.path);
  });
}
const snapshot = (page: Page) => page.evaluate(() => window.reader.store.snapshot());
const queue = (page: Page) => page.evaluate(() => window.reader.app.getState().queue);
async function commands(page: Page) {
  await page.evaluate(() => window.reader.ui.more()); // Simulated native command palette.
  return page.getByRole('dialog', { name: 'Reader commands', exact: true });
}
async function command(page: Page, name: string) {
  await (await commands(page)).getByRole('button', { name, exact: true }).click();
}
async function pickQueue(page: Page, label: string) {
  await command(page, 'Switch queue');
  await page.getByRole('dialog', { name: 'Switch queue', exact: true }).getByRole('button', { name: label, exact: true }).click();
  return page.getByRole('dialog', { name: 'Reading list · ' + label, exact: true });
}

test('native commands and queue lists replace the mobile toolbar without mutating notes', async ({ page }) => {
  await ready(page); const before = await snapshot(page);
  await expect(page.locator('.r2-reader-toolbar')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Article navigation', exact: true })).toHaveCount(0);
  const menu = await commands(page); await expect(menu.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  await menu.getByRole('button', { name: 'Close', exact: true }).click();
  const original = await page.evaluate(() => window.reader.app.getState().file);
  await command(page, 'Next');
  await expect.poll(() => page.evaluate(() => window.reader.app.getState().file)).not.toBe(original);
  expect(await queue(page)).toBe('inbox');
  await command(page, 'Previous');
  await expect.poll(() => page.evaluate(() => window.reader.app.getState().file)).toBe(original);
  for (const [status, label] of [['later', 'Later'], ['feed', 'Stream'], ['archive', 'Treasury'], ['feed', 'Stream'], ['later', 'Later'], ['inbox', 'Inbox']]) {
    const list = await pickQueue(page, label);
    await list.locator('.preview-suggestions button').first().click();
    await expect.poll(() => queue(page)).toBe(status); await expect(page.locator('.r2-article-body')).toBeVisible();
    const menu = await commands(page); await expect(menu.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
    await menu.getByRole('button', { name: 'Close', exact: true }).click();
  }
  const list = await pickQueue(page, 'Treasury');
  await list.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await queue(page)).toBe('inbox'); expect(await snapshot(page)).toEqual(before);
});

test('empty queues retain identity and native queue/list navigation remains available', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const { app, controller } = window.reader;
    for (const article of await controller.repository.listArticles()) {
      if (article.status === 'later' || article.status === 'feed') await controller.move(article.path, 'archive');
    }
    await app.refresh();
  });
  const before = await snapshot(page);
  const emptyList = await pickQueue(page, 'Later'); await expect(emptyList).toContainText('No matching items.');
  await emptyList.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(await queue(page)).toBe('inbox');
  for (const [status, label] of [['later', 'Later'], ['feed', 'Stream']]) {
    // An empty native picker has no article to choose; exercise the source-navigation method.
    await page.evaluate(() => window.reader.app.navigateQueue(1));
    expect(await queue(page)).toBe(status); await expect(page.locator('.r2-article-title')).toHaveText('No articles in ' + label + '.');
    await expect(page.getByRole('navigation', { name: 'After reading', exact: true })).toHaveCount(0);
    const menu = await commands(page);
    for (const name of ['Previous', 'Next']) await expect(menu.getByRole('button', { name, exact: true })).toBeDisabled();
    for (const name of ['Switch queue', 'Reading list']) await expect(menu.getByRole('button', { name, exact: true })).toBeEnabled();
    await menu.getByRole('button', { name: 'Close', exact: true }).click();
  }
  const list = await pickQueue(page, 'Treasury'); await list.locator('.preview-suggestions button').first().click();
  await expect(page.locator('.r2-article-body')).toBeVisible(); expect(await queue(page)).toBe('archive');
  expect(await snapshot(page)).toEqual(before); await expect(page.locator('.r2-reader-toolbar')).toHaveCount(0);
});

test.describe('Android e-ink queue roundtrip (synthetic)', () => {
  test.use({ userAgent: agents.android });
  test('native queue lists preserve the Boox later-page anchor without a page bar', async ({ page }) => {
    const article = await fixture(page, true);
    await page.evaluate(async path => {
      const { app, controller } = window.reader;
      for (const other of await controller.repository.listArticles()) {
        if (other.status === 'later' && other.path !== path) await controller.move(other.path, 'archive');
      }
      await app.refresh(); await app.open(path);
    }, article.path);
    await expectNoPageBar(page);
    await expect(page.locator('.r2-reader-toolbar')).toHaveCount(0);
    await expect(page.locator('.r2-article-end')).toBeHidden();
    await turnTo(page, 3);
    const anchor = await position(page), before = await snapshot(page);
    const stream = await pickQueue(page, 'Stream'); await stream.locator('.preview-suggestions button').first().click();
    await expect.poll(() => queue(page)).toBe('feed');
    const later = await pickQueue(page, 'Later'); await later.locator('.preview-suggestions button').first().click();
    await expect.poll(() => page.evaluate(() => window.reader.app.getState().file)).toBe(article.path);
    // Repeated five-word markers may resolve to an earlier occurrence.
    expect((await progress(page)).page).toBeGreaterThan(0);
    await expectVisiblePosition(page, anchor);
    const after = await snapshot(page);
    expectOnlyReadingPositionChanged(before[article.path], after[article.path]);
    expect({ ...after, [article.path]: before[article.path] }).toEqual(before);
    expect(await page.evaluate(async path =>
      (await window.reader.controller.repository.getArticle(path)).readingPosition, article.path)).toEqual(anchor);
    await expect(page.locator('.r2-article-end')).toBeHidden();
  });
});
