import { test, expect, type Page } from '@playwright/test';
import type { ArticleStatus } from '../src/types';
import { parseNote } from '../src/storage/markdown';
import { agents } from './helpers/eink-browser';
import { expectOnlyReadingPositionChanged } from './helpers/reading-position-note';

const labels = { inbox: 'Inbox', later: 'Later', feed: 'Stream', archive: 'Treasury' } as const;
const source = 'A kept quotation. A linked quotation.\n\n' + Array.from({ length: 18 }, (_, i) =>
  `Passage ${i + 1}. ` + 'Saved source stays readable after finishing, moving, and returning to the list. '.repeat(6)).join('\n\n');
const treasuryPath = (path: string) => 'Reading/Treasury/' + path.split('/').at(-1);
const finish = (page: Page) => page.getByRole('navigation', { name: 'After reading', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.reader.store.snapshot());
const state = (page: Page) => page.evaluate(() => window.reader.app.getState());
declare global { interface Window { finishArchiveProbe: { calls: number; release(): void }; } }

/** Synthetic BrowserStore data written through the real repository, never an Obsidian vault. */
async function fixture(page: Page, queue: ArticleStatus = 'later', url = '/?mobile=1') {
  await page.goto(url); await expect(page.locator('.r2-article-body')).toBeVisible();
  const articles = await page.evaluate(async ({ queue, source }) => {
    const { app, controller } = window.reader; controller.setActive(false);
    const repository = controller.repository;
    for (const article of await repository.listArticles()) {
      if (article.status === queue) await controller.move(article.path, queue === 'archive' ? 'inbox' : 'archive');
    }
    const articles = [];
    for (const title of ['Finish A — earlier article', 'Finish B — current article', 'Finish C — next article with a long title that must wrap on a narrow phone']) {
      articles.push(await repository.createArticle({ title, url: '', status: queue, body: source, extractor: 'manual' }));
    }
    await app.refresh(); await app.open(articles[1].path); return articles;
  }, { queue, source });
  await expect(page.locator('.r2-article-title')).toHaveText(articles[1].title);
  await page.evaluate(async () => { await document.fonts.ready; });
  return articles;
}
async function bottom(page: Page) {
  await page.locator('.r2-reader-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(finish(page)).toBeInViewport({ ratio: 1 });
}
function expectReadOnly(before: Record<string, string>, after: Record<string, string>, path: string) {
  expectOnlyReadingPositionChanged(before[path], after[path]);
  expect({ ...after, [path]: before[path] }).toEqual(before);
}
function expectInlineState(raw: string) {
  const yaml = parseNote(raw).doc.toJS();
  // Inline annotation edits protect the source; archive must retain that YAML state.
  expect(yaml).toMatchObject({ type: 'article' });
  for (const key of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength', 'highlights', 'queueMove'])
    expect(yaml).not.toHaveProperty(key);
  expect(raw).not.toMatch(/<!--|^## (?:Highlights|Article|Comments)$/m);
}
/** Actual browser pointer selection; no synthetic Range is installed into Selection. */
async function dragSourceText(page: Page) {
  const points = await page.locator('.r2-article-body p').first().evaluate(paragraph => {
    paragraph.scrollIntoView({ block: 'center' });
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT), text = walker.nextNode();
    if (!text || (text.textContent?.length ?? 0) < 18) throw new Error('Selection fixture needs a source text run');
    const rect = (offset: number) => { const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); return range.getBoundingClientRect(); };
    const first = rect(2), last = rect(17);
    return { start: { x: first.left + .2, y: first.top + first.height / 2 }, end: { x: last.right - .2, y: last.top + last.height / 2 } };
  });
  await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 12 }); await page.mouse.up();
  return page.evaluate(() => document.getSelection()?.toString() ?? '');
}

// A forced mobile host runs these assertions in both configured Chromium viewport projects.
test('finish navigation is after source/selection UI in normal flow, offscreen until the bottom', async ({ page }) => {
  const articles = await fixture(page);
  await expect(page.locator('.r2-reader-toolbar')).toHaveCount(0);
  await expect(finish(page)).toHaveClass(/r2-article-end/); await expect(finish(page)).not.toBeInViewport();
  expect(await finish(page).evaluate(end => {
    const body = document.querySelector('.r2-article-body')!, selection = document.querySelector('.r2-save-state')!;
    return { parent: end.parentElement?.classList.contains('r2-reading-page'), position: getComputedStyle(end).position,
      afterBody: !!(body.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING),
      afterSelection: !!(selection.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING), insideSource: body.contains(end) };
  })).toEqual({ parent: true, position: 'static', afterBody: true, afterSelection: true, insideSource: false });
  await bottom(page);
  await expect(finish(page)).toContainText('Up next in Later'); await expect(finish(page)).toContainText(articles[2].title);
  await expect(finish(page).getByRole('button', { name: 'Archive & next', exact: true })).toHaveClass(/r2-article-end-primary/);
  await expect(finish(page).getByRole('button', { name: 'Next without archiving', exact: true })).toBeVisible();
  await expect(finish(page).getByRole('button', { name: 'Back to reading list', exact: true })).toBeVisible();
});

test('320px phone has wrapping titles, 44px targets, and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await fixture(page); await bottom(page);
  const geometry = await finish(page).getByRole('button').evaluateAll(buttons => buttons.map(button => {
    const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { left: r.left, right: r.right, width: r.width, height: r.height, reachable: !!hit && button.contains(hit) };
  }));
  expect(geometry).toHaveLength(3);
  for (const box of geometry) {
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(320); expect(box.reachable).toBe(true);
  }
  expect(await page.evaluate(() => [document.documentElement, ...document.querySelectorAll<HTMLElement>('.r2-app, .r2-reader-scroll, .r2-reading-page, .r2-article-end')]
    .every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
});

for (const queue of ['inbox', 'later', 'feed'] as const) {
  test(`Archive & next moves ${labels[queue]} to Treasury, preserving inline marks/links, YAML and journals`, async ({ page }) => {
    const articles = await fixture(page, queue), current = articles[1];
    const original = await page.evaluate(async path => {
      const { app, controller, store } = window.reader, repository = controller.repository;
      // A user-owned legacy excerpt/backlink is a fixture, not a newly generated annotation copy.
      await store.process(path, raw => raw.replace('type: article', 'type: article\ncustom_finish_property: preserve me') + '\n\nA retained legacy excerpt. ^hl-finish\n');
      const basename = path.split('/').at(-1)!.replace(/\.md$/, '');
      await store.create('Daily/finish.md', '# Journal\r\n\r\n> My edited older entry stays.\r\n\r\n[[' + basename + '#^hl-finish|Prior reading]]\r\n');
      await store.create('Topics/Reading.md', 'An ordinary topic target.\n');
      const modulePath = '/src/inline/index.ts', { parseInlineMarkdown } = await import(modulePath);
      let article = await repository.getArticle(path);
      article = await repository.addHighlight(path, { quote: 'A linked quotation.', revision: parseInlineMarkdown(article.body, { stripTitle: article.title }).revision });
      article = await repository.setHighlightLink(path, article.highlights[0].id, 'Topics/Reading');
      await repository.addHighlight(path, { quote: 'A kept quotation.', revision: parseInlineMarkdown(article.body, { stripTitle: article.title }).revision });
      await app.refresh(); await app.open(path); return repository.getArticle(path);
    }, current.path);
    expect(original.body).toBe(source.replace('A kept quotation.', '==A kept quotation.==').replace('A linked quotation.', '[[Topics/Reading|A linked quotation.]]') + '\n\nA retained legacy excerpt. ^hl-finish\n');
    expect(original.highlights.map(highlight => highlight.quote)).toEqual(['A kept quotation.']);
    expect(original.content).toBe('protected');
    await bottom(page); await page.evaluate(() => window.reader.app.flushPosition());
    const before = await snapshot(page), savedPosition = parseNote(before[current.path]).doc.toJS().reading_position;
    expect(savedPosition).toEqual(expect.any(String));
    expect(savedPosition.trim().split(/\s+/).length).toBeLessThanOrEqual(5);
    const movedPath = treasuryPath(current.path);
    const generations = await page.evaluate(({ from, to }) => {
      const repository = window.reader.controller.repository;
      return { from: repository.articleGeneration(from), to: repository.articleGeneration(to) };
    }, { from: current.path, to: movedPath });
    await finish(page).getByRole('button', { name: 'Archive & next', exact: true }).click();
    await expect(page.locator('.r2-article-title')).toHaveText(articles[2].title);
    expect(await state(page)).toMatchObject({ file: articles[2].path, queue });
    expect(await page.evaluate(({ from, to }) => {
      const repository = window.reader.controller.repository;
      return { from: repository.articleGeneration(from), to: repository.articleGeneration(to) };
    }, { from: current.path, to: movedPath })).toEqual({ from: generations.from + 1, to: generations.to + 1 });
    const moved = await page.evaluate(async path => window.reader.controller.repository.getArticle(path), movedPath);
    expect(moved.path).toBe(movedPath);
    expect(moved.status).toBe('archive'); expect(moved.body).toBe(original.body); expect(moved.highlights).toEqual(original.highlights);
    expect(moved.readingPosition).toEqual({ marker: savedPosition });
    const after = await snapshot(page); expect(after[current.path]).toBeUndefined();
    expect(after[moved.path]).toBe(before[current.path]); expectInlineState(after[moved.path]);
    expect(parseNote(after[moved.path]).doc.get('custom_finish_property')).toBe('preserve me');
    expect(after['Daily/finish.md']).toBe(before['Daily/finish.md']); expect(after['Daily/must-not-exist.md']).toBeUndefined();
    expect(Object.keys(after).filter(path => /\.json$/i.test(path))).toEqual([]);
    const expected = { ...before, [moved.path]: before[current.path] }; delete expected[current.path];
    expect(after).toEqual(expected); // Exact rename only: no sections, copies, sidecars or other file mutations.
  });
}

for (const reference of ['explicit', 'relative', 'ambiguous'] as const) {
  test(`unsafe ${reference} native-format legacy journal backlink blocks archive without rewriting the journal`, async ({ page }) => {
    const articles = await fixture(page), current = articles[1];
    await page.evaluate(async ({ path, reference }) => {
      const { app, store } = window.reader, basename = path.split('/').at(-1)!;
      await store.process(path, raw => raw + '\n\n> Retained legacy excerpt.\n\n^hl-finish\n');
      if (reference === 'ambiguous') await store.create('Other/' + basename, 'A different native note.\n');
      const target = reference === 'explicit' ? path : reference === 'relative' ? '../' + path : basename;
      await store.create('Daily/legacy.md', '> User-edited old journal\r\n\r\n[[' + target.replace(/\.md$/, '') + '#^hl-finish|Old source]]\r\n');
      await app.open(path);
    }, { path: current.path, reference });
    await bottom(page); await page.evaluate(() => window.reader.app.flushPosition()); const before = await snapshot(page);
    await finish(page).getByRole('button', { name: 'Archive & next', exact: true }).click();
    // Both move-link ambiguity and unconverted quote-block protection must refuse the rename.
    await expect(finish(page).getByRole('alert').filter({ hasText: /Queue move deferred|recognizable unconverted quote blocks require manual review/ })).toBeVisible();
    expect(await state(page)).toMatchObject({ file: current.path, queue: 'later' });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(finish(page).getByRole('button', { name: 'Archive & next', exact: true })).toBeEnabled();
    await expect(page.locator('.r2-article-body')).toHaveJSProperty('inert', false);
    expect(await snapshot(page)).toEqual(before);
  });
}

test('Next without archiving keeps the article and Back to reading list is nonmutating', async ({ page }) => {
  const articles = await fixture(page); await bottom(page); const before = await snapshot(page);
  await finish(page).getByRole('button', { name: 'Next without archiving', exact: true }).click();
  await expect(page.locator('.r2-article-title')).toHaveText(articles[2].title);
  expect(await state(page)).toMatchObject({ file: articles[2].path, queue: 'later' });
  const kept = await page.evaluate(path => window.reader.controller.repository.getArticle(path), articles[1].path);
  expect(kept.status).toBe('later'); expect(kept.body).toBe(articles[1].body);
  expectReadOnly(before, await snapshot(page), articles[1].path);
  await bottom(page); const atEnd = await snapshot(page);
  await finish(page).getByRole('button', { name: 'Back to reading list', exact: true }).click();
  const list = page.getByRole('dialog', { name: 'Reading list · Later', exact: true }); await expect(list).toBeVisible();
  for (const article of articles) await expect(list.getByRole('button', { name: article.title, exact: true })).toBeVisible();
  await list.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await state(page)).toMatchObject({ file: articles[2].path, queue: 'later' });
  expectReadOnly(atEnd, await snapshot(page), articles[2].path);
});

test('last archive clears finish state and returns to list, never previous or wrapped article', async ({ page }) => {
  const articles = await fixture(page);
  await page.evaluate(path => window.reader.app.open(path), articles[2].path); await bottom(page);
  await expect(finish(page).getByRole('button', { name: 'Next without archiving', exact: true })).toHaveCount(0);
  const archive = finish(page).getByRole('button', { name: 'Archive & return to list', exact: true });
  await expect(archive).toHaveClass(/r2-article-end-primary/); await archive.click();
  const list = page.getByRole('dialog', { name: 'Reading list · Later', exact: true }); await expect(list).toBeVisible();
  expect((await state(page)).file).toBeUndefined(); expect((await state(page)).queue).toBe('later');
  await expect(finish(page)).toHaveCount(0); await expect(page.locator('.r2-article-body')).toHaveCount(0);
  await expect(list.getByRole('button', { name: articles[2].title, exact: true })).toHaveCount(0);
  for (const article of articles.slice(0, 2)) await expect(list.getByRole('button', { name: article.title, exact: true })).toBeVisible();
  const archivedPath = treasuryPath(articles[2].path);
  const archived = await page.evaluate(path => window.reader.controller.repository.getArticle(path), archivedPath);
  expect(archived.status).toBe('archive'); expect(archived.path).toBe(archivedPath);
  await list.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await state(page)).file).toBeUndefined(); await expect(finish(page)).toHaveCount(0);
  await page.evaluate(() => window.reader.ui.run('reading-list'));
  await list.getByRole('button', { name: articles[0].title, exact: true }).click();
  await expect(page.locator('.r2-article-title')).toHaveText(articles[0].title);
});

test('Treasury offers primary Next article, never Archive, including the last article', async ({ page }) => {
  const articles = await fixture(page, 'archive'); await bottom(page); const before = await snapshot(page);
  await expect(finish(page)).toContainText('Up next in Treasury'); await expect(finish(page)).toContainText(articles[2].title);
  await expect(finish(page).getByRole('button', { name: /Archive/i })).toHaveCount(0);
  const next = finish(page).getByRole('button', { name: 'Next article', exact: true }); await expect(next).toHaveClass(/r2-article-end-primary/); await next.click();
  await expect(page.locator('.r2-article-title')).toHaveText(articles[2].title); expect((await state(page)).queue).toBe('archive');
  expectReadOnly(before, await snapshot(page), articles[1].path); await bottom(page);
  await expect(finish(page).getByRole('button', { name: /Archive|Next/i })).toHaveCount(0);
  await expect(finish(page).getByRole('button', { name: 'Back to reading list', exact: true })).toBeVisible();
});

test('archive failure remains on the article with an alert and no list or mutation', async ({ page }) => {
  const articles = await fixture(page); await bottom(page); const before = await snapshot(page);
  await page.evaluate(() => { window.reader.controller.repository.setStatus = async () => { throw new Error('Finish write refused'); }; });
  await finish(page).getByRole('button', { name: 'Archive & next', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Finish write refused' })).toBeVisible();
  expect(await state(page)).toMatchObject({ file: articles[1].path, queue: 'later' });
  await expect(page.locator('.r2-article-title')).toHaveText(articles[1].title); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(finish(page).getByRole('button', { name: 'Archive & next', exact: true })).toBeEnabled();
  expectReadOnly(before, await snapshot(page), articles[1].path);
});

test('rapid double activation archives once and waits for successful write before returning to list', async ({ page }) => {
  const articles = await fixture(page);
  await page.evaluate(path => window.reader.app.open(path), articles[2].path); await bottom(page);
  const archivedPath = treasuryPath(articles[2].path);
  const generations = await page.evaluate(({ from, to }) => {
    const repository = window.reader.controller.repository;
    return { from: repository.articleGeneration(from), to: repository.articleGeneration(to) };
  }, { from: articles[2].path, to: archivedPath });
  await page.evaluate(() => {
    const repository = window.reader.controller.repository, move = repository.setStatus.bind(repository);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    window.finishArchiveProbe = { calls: 0, release };
    repository.setStatus = async (path, status) => { window.finishArchiveProbe.calls++; await gate; return move(path, status); };
  });
  await finish(page).getByRole('button', { name: 'Archive & return to list', exact: true }).evaluate(button => {
    // Deliver both activations before the first async update; do not rely only on the disabled DOM attribute.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true })); button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => window.finishArchiveProbe.calls)).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0); expect((await state(page)).file).toBe(articles[2].path);
  for (const button of await finish(page).getByRole('button').all()) await expect(button).toBeDisabled();
  await page.evaluate(() => window.finishArchiveProbe.release());
  await expect(page.getByRole('dialog', { name: 'Reading list · Later', exact: true })).toBeVisible();
  expect((await state(page)).file).toBeUndefined(); expect(await page.evaluate(() => window.finishArchiveProbe.calls)).toBe(1);
  const remaining = await page.evaluate(() => window.reader.controller.repository.listArticles());
  expect(await page.evaluate(({ from, to }) => {
    const repository = window.reader.controller.repository;
    return { from: repository.articleGeneration(from), to: repository.articleGeneration(to) };
  }, { from: articles[2].path, to: archivedPath })).toEqual({ from: generations.from + 1, to: generations.to + 1 });
  expect(remaining.filter(article => article.path === archivedPath)).toHaveLength(1);
  expect(remaining.find(article => article.path === archivedPath)?.status).toBe('archive');
  expect(remaining.some(article => article.path === articles[2].path)).toBe(false);
  for (const article of articles.slice(0, 2)) expect(remaining.find(item => item.path === article.path)?.status).toBe('later');
});

for (const outcome of ['failure', 'success'] as const) {
  test(`deferred archive blocks new source selections and unlocks after ${outcome}`, async ({ page }) => {
    const articles = await fixture(page); await bottom(page); const before = await snapshot(page);
    await page.evaluate(outcome => {
      const repository = window.reader.controller.repository, move = repository.setStatus.bind(repository);
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      window.finishArchiveProbe = { calls: 0, release };
      repository.setStatus = async (path, status) => {
        window.finishArchiveProbe.calls++; await gate;
        if (outcome === 'failure') throw new Error('Deferred finish write refused');
        return move(path, status);
      };
    }, outcome);
    await finish(page).getByRole('button', { name: 'Archive & next', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.finishArchiveProbe.calls)).toBe(1);
    const body = page.locator('.r2-article-body');
    await expect(body).toHaveAttribute('inert', ''); await expect(body).toHaveJSProperty('inert', true);
    expect((await state(page)).file).toBe(articles[1].path); await expect(page.getByRole('dialog')).toHaveCount(0);
    for (const button of await finish(page).getByRole('button').all()) await expect(button).toBeDisabled();
    expect(await dragSourceText(page)).toBe('');
    expect(await page.evaluate(path => window.reader.controller.repository.getArticle(path).then(article => article.highlights), articles[1].path)).toEqual([]);
    expectReadOnly(before, await snapshot(page), articles[1].path);
    await page.evaluate(() => window.finishArchiveProbe.release());
    if (outcome === 'failure') {
      await expect(page.getByRole('alert').filter({ hasText: 'Deferred finish write refused' })).toBeVisible();
      expect((await state(page)).file).toBe(articles[1].path);
      await expect(finish(page).getByRole('button', { name: 'Archive & next', exact: true })).toBeEnabled();
      expectReadOnly(before, await snapshot(page), articles[1].path);
    } else {
      await expect(page.locator('.r2-article-title')).toHaveText(articles[2].title);
      expect(await state(page)).toMatchObject({ file: articles[2].path, queue: 'later' });
    }
    await expect(body).not.toHaveAttribute('inert', ''); await expect(body).toHaveJSProperty('inert', false);
    // Positive control: the same real pointer gesture can select text after unlock/remount.
    expect((await dragSourceText(page)).trim().length).toBeGreaterThan(5);
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    expect(await page.evaluate(() => window.finishArchiveProbe.calls)).toBe(1);
  });
}

for (const pending of [true, false]) {
  test(`${pending ? 'pending URL' : 'empty manual'} article has no misleading finished cue or archive action`, async ({ page }) => {
    await fixture(page);
    await page.evaluate(async pending => {
      const { app, controller } = window.reader;
      const article = await controller.repository.createArticle({ title: 'Unfinished capture', url: pending ? 'https://example.org/unfinished' : '', status: 'later', body: '', extractor: pending ? 'pending' : 'manual' });
      await app.refresh(); await app.open(article.path);
    }, pending);
    await expect(page.locator('.r2-article-body')).toContainText(pending ? 'Full text is pending.' : 'This article has no text yet.');
    await expect(finish(page).getByRole('button', { name: /^Archive/i })).toHaveCount(0);
    expect((await page.locator('.r2-article-end-context').allTextContents()).join(' ')).not.toMatch(/End of |Finished reading|You(?:’|')re done/i);
  });
}

test('simulated native chrome remains reachable at top and finish, including keyboard transitions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page);
  await page.evaluate(async () => { const modulePath = '/preview/mobile-host.ts'; const host = await import(modulePath); host.installMobileHostFixture(); });
  const native = page.getByRole('button', { name: 'Native control 0', exact: true });
  await expect(finish(page)).not.toBeInViewport(); await native.click(); await bottom(page);
  await expect.poll(() => page.evaluate(() => {
    const m = window.readerMobileHost.metrics(); return m.bottom < m.overlayTop && m.buttons.length === 3 && m.buttons.every(button => button.height >= 44 && button.reachable);
  })).toBe(true);
  await native.click(); expect(await page.evaluate(() => window.readerMobileHost.metrics().hostClicks)).toBe(2);
  await page.evaluate(() => window.reader.ui.more()); await expect(page.getByRole('dialog', { name: 'Reader commands', exact: true })).toBeVisible();
  await page.evaluate(() => window.readerMobileHost.state('keyboard'));
  await expect.poll(() => page.evaluate(() => { const m = window.readerMobileHost.metrics(); return m.popupBottom > 0 && m.popupBottom < m.overlayTop; })).toBe(true);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => window.readerMobileHost.state('visible')); await native.click();
  expect(await page.evaluate(() => window.readerMobileHost.metrics().hostClicks)).toBe(3);
  await page.evaluate(() => window.reader.app.destroy()); await native.click();
  expect(await page.evaluate(() => window.readerMobileHost.root.style.height)).toBe('');
});

test.describe('desktop finish exclusion', () => {
  test.use({ userAgent: agents.desktop, isMobile: false, hasTouch: false });
  test('desktop never mounts mobile finish navigation, even at phone width', async ({ page }) => {
    await fixture(page, 'later', '/'); await expect(page.locator('.r2-app')).toHaveAttribute('data-mobile', 'false');
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator('.r2-reader-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
      await expect(page.locator('.r2-reader-toolbar, .r2-article-end')).toHaveCount(0);
    }
    await page.evaluate(() => window.reader.ui.more()); await expect(page.getByRole('dialog', { name: 'Reader commands', exact: true })).toBeVisible();
  });
});
