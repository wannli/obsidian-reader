import { test, expect, type Page } from '@playwright/test';
import { parseNote } from '../src/storage/markdown';

async function command(page: Page, name: string) {
  await page.evaluate(() => window.reader.ui.more()); // Simulated native command palette, not Reader chrome.
  await page.getByRole('dialog', { name: 'Reader commands', exact: true }).getByRole('button', { name, exact: true }).click();
}
async function boot(page: Page) {
  await page.goto('/');
  await expect(page.locator('.r2-article-body')).toBeVisible();
  await page.evaluate(() => window.reader.controller.setActive(false));
}
const files = (page: Page): Promise<Record<string, string>> => page.evaluate(() => window.reader.store.snapshot());
function markdownState(raw: string) {
  const yaml = parseNote(raw).doc.toJS();
  expect(yaml).toMatchObject({ type: 'article' });
  for (const key of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength', 'created-by', 'highlights', 'queueMove']) expect(yaml).not.toHaveProperty(key);
  expect(raw).not.toContain('<!--');
}
function noSidecars(snapshot: Record<string, string>) {
  expect(Object.keys(snapshot).filter(path => /\.json$/i.test(path))).toEqual([]);
}

test('selection survives reload as inline Markdown with YAML state and unchanged authored headings', async ({ page }) => {
  await boot(page);
  const before = await page.evaluate(async () => {
    const { controller, app, store } = window.reader;
    const article = await controller.repository.createArticle({ title: 'Inline persistence', url: 'https://example.org/persistence', status: 'inbox', extractor: 'manual', body: 'Opening source paragraph.\n\n## Authored source heading\n\nA durable quote preserves this exact source paragraph.' });
    await store.process(article.path, text => text.replace('type: article', 'type: article\ncustom: preserved'));
    await app.refresh(); await app.open(article.path);
    return { path: article.path, body: article.body };
  });
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.r2-article-body p')].find(p => p.textContent?.startsWith('A durable quote'))!;
    p.scrollIntoView({ block: 'center' });
    const range = document.createRange(); range.selectNodeContents(p);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1');
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  const saved = await files(page), raw = saved[before.path];
  markdownState(raw); noSidecars(saved);
  const note = parseNote(raw);
  expect(note.doc.get('custom')).toBe('preserved');
  expect(note.doc.get('title')).toBe('Inline persistence');
  expect(note.doc.get('url')).toBe('https://example.org/persistence');
  expect(note.body).toBe(before.body.replace('A durable quote preserves this exact source paragraph.', '==A durable quote preserves this exact source paragraph.=='));
  expect(raw).not.toContain('## Highlights'); expect(raw).not.toContain('## Comments'); expect(raw).not.toMatch(/\^hl-/);
  expect(Object.keys(saved).some(path => path.startsWith('Daily/'))).toBe(false);
  await command(page, 'Open Markdown');
  await expect(page.locator('.preview-inspector pre')).toHaveText(raw);
  await page.reload(); await expect(page.locator('.r2-article-body')).toBeVisible();
  await page.evaluate(async path => { window.reader.controller.setActive(false); await window.reader.app.open(path); }, before.path);
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1');
  await expect(page.locator('.r2-article-body h2')).toHaveText('Authored source heading');
  await expect(page.locator('.r2-article-body')).not.toContainText('==');
  const reloaded = await page.evaluate(path => window.reader.controller.repository.getArticle(path), before.path);
  expect(reloaded.content).toBe('protected'); expect(reloaded.extractor).toBe('manual');
  expect(reloaded.body).toBe(note.body); expect(reloaded.highlights).toHaveLength(1);
  expect((await files(page))[before.path]).toBe(raw);
});
test('inline annotations preserve existing journal bytes and create no copies', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const { controller, store } = window.reader;
    const dailyPath = 'Daily/retired-journal.md', daily = '## Reading\n\n> My edited journal entry stays.\n';
    await store.create(dailyPath, daily);
    const article = await controller.repository.createArticle({ title: 'No daily mirror', url: 'https://example.org/retired', body: 'A word worth keeping.', extractor: 'manual' });
    const modulePath = '/src/inline/index.ts', { parseInlineMarkdown } = await import(modulePath);
    const revision = parseInlineMarkdown(article.body, { stripTitle: article.title }).revision;
    const marked = await controller.repository.addHighlight(article.path, { quote: 'word worth keeping', revision });
    const unmarked = await controller.repository.deleteHighlight(article.path, marked.highlights[0].id);
    const again = await controller.repository.addHighlight(article.path, { quote: 'word worth keeping', revision: parseInlineMarkdown(unmarked.body, { stripTitle: unmarked.title }).revision });
    const linked = await controller.repository.setHighlightLink(article.path, again.highlights[0].id, 'Thoughts');
    return { path: article.path, originalBody: article.body, marked: marked.body, unmarked: unmarked.body, linked: linked.body, highlights: linked.highlights, daily, snapshot: store.snapshot() };
  });
  expect(result.marked).toBe('A ==word worth keeping==.');
  expect(result.unmarked).toBe(result.originalBody);
  expect(result.linked).toBe('A [[Thoughts|word worth keeping]].');
  expect(result.highlights).toHaveLength(0);
  expect(result.snapshot['Daily/retired-journal.md']).toBe(result.daily);
  expect(result.snapshot['Daily/must-not-exist.md']).toBeUndefined();
  markdownState(result.snapshot[result.path]); noSidecars(result.snapshot);
});

test('unsupported cross-paragraph selection reports an error without changing the note', async ({ page }) => {
  await boot(page);
  const before = await page.evaluate(async () => {
    const { controller, app, store } = window.reader;
    const article = await controller.repository.createArticle({ title: 'Two paragraphs', url: 'https://example.org/ranges', body: 'First paragraph.\n\nSecond paragraph.', extractor: 'manual' });
    await app.open(article.path); return { path: article.path, raw: await store.read(article.path) };
  });
  await page.evaluate(() => {
    const paragraphs = document.querySelectorAll('.r2-article-body p'), range = document.createRange();
    range.setStart(paragraphs[0].firstChild!, 0); range.setEnd(paragraphs[1].firstChild!, paragraphs[1].textContent!.length);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.locator('.r2-reading-page > .r2-error')).not.toBeEmpty();
  expect((await files(page))[before.path]).toBe(before.raw);
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '0');
});

test('explicit Defuddle replaces a verified RSS excerpt, moves Stream to Inbox, and reload protects unstamped full text', async ({ page }) => {
  await boot(page);
  const oldPath = await page.evaluate(async () => {
    const { controller, app } = window.reader;
    const article = await controller.repository.createArticle({ title: 'Explicit live fixture', url: 'https://reader.test/inline-explicit', status: 'feed', summary: 'Brief RSS excerpt.', body: 'Brief RSS excerpt.' });
    await app.refresh(); await app.open(article.path); return article.path;
  });
  await command(page, 'Fetch full text with Defuddle');
  await expect(page.locator('.r2-article-body')).toContainText('Reading is an encounter');
  const moved = await page.evaluate(() => ({ state: window.reader.app.getState(), dummy: window.reader.controller.settings.useDummyContent }));
  const path = oldPath.replace('/Stream/', '/Inbox/');
  expect(moved.state.file).toBe(path); expect(moved.dummy).toBe(true);
  const saved = await files(page); expect(saved[oldPath]).toBeUndefined(); markdownState(saved[path]); noSidecars(saved);
  expect(saved[path]).not.toContain('## Comments');
  expect(parseNote(saved[path]).doc.get('summary')).toBe('Brief RSS excerpt.');
  const extractedBody = parseNote(saved[path]).body;
  expect(extractedBody).toContain('Reading is an encounter');
  await command(page, 'Open Markdown'); await expect(page.locator('.preview-inspector pre')).toHaveText(saved[path]);
  await page.reload(); await expect(page.locator('.r2-article-body')).toBeVisible();
  await page.evaluate(async path => { window.reader.controller.setActive(false); await window.reader.app.open(path); }, path);
  await expect(page.locator('.r2-article-body')).toContainText('Reading is an encounter');
  const article = await page.evaluate(path => window.reader.controller.repository.getArticle(path), path);
  expect(article.status).toBe('inbox'); expect(article.body).toBe(extractedBody);
  expect(article.content).toBe('protected'); expect(article.extractor).toBe('manual');
  expect((await files(page))[path]).toBe(saved[path]);
});

for (const guard of ['authored', 'highlighted', 'offline'] as const) {
  test(`explicit Defuddle ${guard} guard preserves the entire Markdown note`, async ({ page }) => {
    await boot(page);
    const path = await page.evaluate(async guard => {
      const { controller, app } = window.reader;
      const article = await controller.repository.createArticle({ title: 'Guard ' + guard, url: 'https://reader.test/inline-' + guard, status: 'feed', extractor: guard === 'authored' ? 'manual' : 'summary', body: 'Protected source paragraph.\n\n## Comments\n\nUser comments stay.' });
      if (guard === 'highlighted') {
        const modulePath = '/src/inline/index.ts', { parseInlineMarkdown } = await import(modulePath);
        await controller.repository.addHighlight(article.path, { quote: 'Protected source paragraph.', revision: parseInlineMarkdown(article.body, { stripTitle: article.title }).revision });
      }
      await app.refresh(); await app.open(article.path);
      if (guard === 'offline') controller.setOnline(false);
      return article.path;
    }, guard);
    await expect.poll(() => page.evaluate(() => window.reader.app.getState().file)).toBe(path);
    const before = await files(page);
    await command(page, 'Fetch full text with Defuddle');
    await expect(page.getByRole('status').filter({ hasText: guard === 'offline' ? 'Offline' : /preserv|protect|highlight|authored/i })).toBeVisible();
    expect(await files(page)).toEqual(before);
    expect(await page.evaluate(() => window.reader.app.getState().file)).toBe(path);
    expect(await page.evaluate(() => window.reader.controller.settings.useDummyContent)).toBe(true);
  });
}
