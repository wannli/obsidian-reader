import { test, expect } from '@playwright/test';
import { parseNote } from '../src/storage/markdown';

test('ordinary wikilinks open existing notes, change target and unlink without removing words', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.r2-article-body')).toBeVisible();
  const fixture = await page.evaluate(async () => {
    const { controller, app, store } = window.reader; controller.setActive(false);
    await store.create('Topics/Attention.md', '---\ntype: topic\n---\nA normal topic note.');
    await store.create('Topics/Other.md', '---\ntype: topic\n---\nAnother normal topic.');
    const article = await controller.repository.createArticle({ title: 'Ordinary inline links', url: 'https://example.org/inline-links', extractor: 'manual', body: 'An [[Topics/Attention|ordinary link]] stays inline.' });
    await app.open(article.path); return { path: article.path, files: await store.list() };
  });
  const link = page.getByRole('link', { name: 'ordinary link', exact: true });
  await expect(link).toBeVisible(); await expect(page.locator('.r2-article-body')).not.toContainText('[[');
  await link.click(); await page.getByRole('dialog', { name: 'Link actions' }).getByRole('button', { name: 'Open note', exact: true }).click();
  await expect(page.locator('.preview-inspector pre')).toContainText('A normal topic note.');
  await page.getByRole('button', { name: 'Close Markdown', exact: true }).click();
  await link.click(); await page.getByRole('button', { name: 'Edit link…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Link to an existing note', exact: true }).getByRole('button', { name: 'Topics/Other', exact: true }).click();
  await expect.poll(() => page.evaluate(path => window.reader.store.read(path), fixture.path)).toContain('[[Topics/Other|ordinary link]]');
  await link.click(); await page.getByRole('dialog', { name: 'Link actions' }).getByRole('button', { name: 'Unlink', exact: true }).click();
  await expect(link).toHaveCount(0);
  await expect(page.locator('.r2-article-body p')).toHaveText('An ordinary link stays inline.');
  const final = await page.evaluate(async path => ({ raw: await window.reader.store.read(path), files: await window.reader.store.list(), snapshot: window.reader.store.snapshot() }), fixture.path);
  expect(parseNote(final.raw).body).toBe('An ordinary link stays inline.');
  const yaml = parseNote(final.raw).doc.toJS();
  expect(yaml).toMatchObject({ type: 'article', title: 'Ordinary inline links', url: 'https://example.org/inline-links' });
  for (const key of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength', 'created-by']) expect(yaml).not.toHaveProperty(key);
  const reopened = await page.evaluate(path => window.reader.controller.repository.getArticle(path), fixture.path);
  expect(reopened.body).toBe('An ordinary link stays inline.');
  expect(reopened.content).toBe('protected'); expect(reopened.extractor).toBe('manual');
  expect(final.files.sort()).toEqual(fixture.files.sort());
  expect(Object.keys(final.snapshot).some(path => path.endsWith('.json') || path.startsWith('Daily/'))).toBe(false);
});

test('unresolved wikilink does not create a note on insertion or preview navigation', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.r2-article-body')).toBeVisible();
  const before = await page.evaluate(async () => {
    const { controller, app, store } = window.reader; controller.setActive(false);
    const article = await controller.repository.createArticle({ title: 'Unresolved link', url: 'https://example.org/unresolved', extractor: 'manual', body: 'A [[Missing topic|linked idea]] remains readable.' });
    await app.open(article.path); return store.snapshot();
  });
  await page.getByRole('link', { name: 'linked idea', exact: true }).click();
  await page.getByRole('button', { name: 'Open note', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Note not found' })).toBeVisible();
  expect(await page.evaluate(() => window.reader.store.snapshot())).toEqual(before);
});

test('removing an inline highlight restores the source text without a quote copy', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.r2-article-body')).toBeVisible();
  const path = await page.evaluate(async () => {
    const { controller, app } = window.reader; controller.setActive(false);
    const article = await controller.repository.createArticle({ title: 'Remove a mark', url: 'https://example.org/unmark', extractor: 'manual', body: 'Keep ==these exact words== in context.' });
    await app.open(article.path); return article.path;
  });
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1');
  await page.locator('.r2-article-body mark').click();
  await page.getByRole('dialog', { name: 'Highlight actions' }).getByRole('button', { name: 'Remove highlight', exact: true }).click();
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '0');
  await expect(page.locator('.r2-article-body p')).toHaveText('Keep these exact words in context.');
  const raw = await page.evaluate(path => window.reader.store.read(path), path);
  expect(parseNote(raw).body).toBe('Keep these exact words in context.');
  expect(raw).not.toContain('## Highlights'); expect(raw).not.toContain('highlights:'); expect(raw).not.toMatch(/\^hl-/);
});
