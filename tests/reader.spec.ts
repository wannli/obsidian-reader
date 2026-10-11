import { test, expect, type Page } from '@playwright/test';
import { parseNote } from '../src/storage/markdown';
import { expectOnlyReadingPositionChanged } from './helpers/reading-position-note';
const sampleTitle = 'A little room to read';
const attentionTitle = 'The value of paying attention';
const queueNames = { inbox: 'Inbox', later: 'Later', feed: 'Stream', archive: 'Treasury' } as const;
const queueTitles = ['Queue A', 'Queue B', 'Queue C'] as const;
async function command(page: Page, name: string) {
  await page.evaluate(() => window.reader.ui.more()); // Simulated native command palette, not Reader chrome.
  await page.getByRole('dialog', { name: 'Reader commands', exact: true }).getByRole('button', { name, exact: true }).click();
}
async function sample(page: Page) {
  await page.goto('/'); await expect(page.locator('.r2-article-body')).toBeVisible();
  await command(page, 'Reading list');
  await page.getByRole('button', { name: sampleTitle }).click();
}
async function files(page: Page): Promise<Record<string, string>> { return page.evaluate(() => window.reader.store.snapshot()); }
async function selection(page: Page, plain = false) {
  return page.evaluate(plain => {
    const p = [...document.querySelectorAll('.r2-article-body p')].find(p => p.textContent?.startsWith('A highlight'))!; p.scrollIntoView({ block: 'center' });
    const range = document.createRange(); range.selectNodeContents(p); if (plain) range.setEnd(p.firstChild!, p.textContent!.indexOf('. ')); const selected = document.getSelection()!; selected.removeAllRanges(); selected.addRange(range); document.dispatchEvent(new Event('selectionchange')); return range.toString();
  }, plain);
}
async function seedQueue(page: Page, origin: 'feed' | 'later') {
  await sample(page);
  return page.evaluate(async ({ origin, titles }) => {
    const { controller, app, store } = window.reader; controller.setActive(false);
    for (const article of await controller.repository.listArticles()) if (article.status === origin) await controller.move(article.path, 'archive');
    const paths = [];
    const body = 'Preserved source text.\n\n' + Array.from({ length: 40 }, (_, i) => `Queue paragraph ${i}: keep these authored words intact.`).join('\n\n');
    for (const title of titles) paths.push((await controller.repository.createArticle({ title, url: 'https://example.org/' + title.replace(' ', '-'), body, extractor: 'manual', status: origin })).path);
    const modulePath = '/src/inline/index.ts', { parseInlineMarkdown } = await import(modulePath), article = await controller.repository.getArticle(paths[1]);
    await controller.repository.addHighlight(paths[1], { quote: 'Preserved source text.', revision: parseInlineMarkdown(article.body, { stripTitle: article.title }).revision });
    await store.process(paths[1], raw => raw.replace('type: article', 'type: article\ncustom_move_fixture: preserved\ncustom_nested:\n  label: untouched'));
    await app.refresh(); await app.open(paths[1]); return paths;
  }, { origin, titles: queueTitles });
}
test('article-only native-themed reading surface and complete command catalog', async ({ page }, info) => {
  await sample(page); await expect(page.locator('.r2-article-title')).toHaveText(sampleTitle);
  await expect(page.locator('.r2-top,.r2-sidebar,.r2-article-links,.r2-status')).toHaveCount(0);
  await expect(page.locator('.r2-app')).not.toContainText('Select text to highlight');
  for (const brand of ['Reader 2', 'Reader']) await expect(page.locator('.r2-app')).not.toContainText(brand);
  if (!info.project.name.includes('mobile')) await expect(page.locator('.r2-reader-toolbar')).toBeHidden();
  const names = await page.evaluate(() => window.reader.ui.commands.map(command => command.name));
  expect(names).toEqual(expect.arrayContaining(['Open Markdown', 'Original', 'Previous', 'Next', 'RSS feeds', 'Add URL', 'Reading list', 'Switch queue', 'Move to Inbox', 'Move to Later', 'Move to Treasury', 'Fetch full text with Defuddle']));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('inline linking invalidates the old highlight identity and creates no journal copy', async ({ page }) => {
  await sample(page); const before = await files(page); await selection(page, true);
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1');
  const result = await page.evaluate(async () => {
    const { controller, app } = window.reader, path = app.getState().file!;
    const saved = await controller.repository.getArticle(path), id = saved.highlights[0].id;
    const linked = await controller.repository.setHighlightLink(path, id, 'Target');
    let rejected = false; try { await controller.repository.deleteHighlight(path, id); } catch { rejected = true; }
    return { linked: linked.body, highlights: linked.highlights.length, rejected, unchanged: (await controller.repository.getArticle(path)).body === linked.body };
  });
  expect(result.linked).toContain('[[Target|A highlight is a small act of recognition]]');
  expect(result).toMatchObject({ highlights: 0, rejected: true, unchanged: true });
  const after = await files(page); expect(Object.keys(after)).toEqual(Object.keys(before));
  expect(Object.keys(after).some(path => path.startsWith('Daily/') || path.endsWith('.json'))).toBe(false);
});
test('automatic highlight and primary Link use only inline syntax and preserve the words', async ({ page }) => {
  await sample(page); const before = await files(page), quote = await selection(page, true);
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1');
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  const paragraph = page.locator('.r2-article-body p').filter({ hasText: /^A highlight is a small/ }); await paragraph.click({ position: { x: 35, y: 12 } });
  await page.getByRole('dialog', { name: 'Highlight actions' }).getByRole('button', { name: 'Link', exact: true }).click();
  const path = Object.keys(before).find(path => path.includes('A little room'))!;
  await expect.poll(async () => (await files(page))[path]).toContain('[[' + quote + ']]');
  const saved = await files(page); expect(Object.keys(saved)).toEqual(Object.keys(before)); expect(saved[path]).not.toContain('<!--');
  expect(parseNote(saved[path]).body).toBe(parseNote(before[path]).body.replace(quote, '[[' + quote + ']]'));
  expect(saved[path]).not.toContain('## Highlights'); expect(saved[path]).not.toContain('highlights:');
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '0');
  await expect(page.getByRole('link', { name: quote, exact: true })).toBeVisible();
});
test('Link to existing note supports cancellation without creating a note', async ({ page }) => {
  await sample(page); await page.evaluate(() => window.reader.store.create('Topics/Attention.md', '---\ntype: topic\n---\n')); await selection(page);
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1'); await page.evaluate(() => document.getSelection()?.removeAllRanges()); const before = await files(page);
  const paragraph = page.locator('.r2-article-body p').filter({ hasText: /^A highlight is a small/ });
  await paragraph.click({ position: { x: 35, y: 12 } }); await page.getByRole('button', { name: 'Link to…', exact: true }).click(); await page.getByRole('dialog', { name: 'Link to an existing note', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click(); expect(await files(page)).toEqual(before);
  await paragraph.click({ position: { x: 35, y: 12 } }); await page.getByRole('button', { name: 'Link to…', exact: true }).click(); await page.getByRole('button', { name: 'Topics/Attention', exact: true }).click();
  const path = Object.keys(before).find(path => path.includes('A little room'))!; await expect.poll(async () => (await files(page))[path]).toContain('[[Topics/Attention|'); expect(Object.keys(await files(page))).toEqual(Object.keys(before));
});
test('unsafe primary Link preserves exact quote; cancel and explicit external alternate never create notes', async ({ page }) => {
  await sample(page); const quote = await selection(page); await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1'); await page.evaluate(() => document.getSelection()?.removeAllRanges()); const before = await files(page), paragraph = page.locator('.r2-article-body p').filter({ hasText: /^A highlight is a small/ }); await paragraph.click({ position: { x: 35, y: 12 } }); await page.getByRole('button', { name: 'Link', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Link to…', exact: true }); await expect(dialog.getByLabel('Selected text')).toHaveValue(quote); const path = await page.evaluate(() => window.reader.app.getState().file); await page.keyboard.press('j'); expect(await page.evaluate(() => window.reader.app.getState().file)).toBe(path); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(await files(page)).toEqual(before);
  await paragraph.click({ position: { x: 35, y: 12 } }); await page.getByRole('button', { name: 'Link to…', exact: true }).click(); await page.getByRole('dialog', { name: 'Link to an existing note', exact: true }).getByRole('button', { name: 'Link to an HTTP(S) URL…', exact: true }).click();
  await expect(dialog.getByLabel('Selected text')).toHaveValue(quote); await dialog.getByLabel('HTTP(S) URL').fill('https://outside.example/reference'); expect(await files(page)).toEqual(before); await dialog.getByRole('button', { name: 'Link URL', exact: true }).click();
  await expect.poll(async () => Object.values(await files(page)).filter(text => text.includes(`[${quote}](https://outside.example/reference)`)).length).toBe(1); expect(Object.keys(await files(page)).sort()).toEqual(Object.keys(before).sort());
});
test('real mouse drag selects and auto-highlights reading text under non-selectable native-like chrome', async ({ page }, info) => {
  test.skip(info.project.name.includes('mobile'), 'Real desktop mouse regression; not touch/device acceptance.'); await sample(page);
  await page.addStyleTag({ content: 'body, body * { -webkit-user-select: none; user-select: none; }' });
  const points = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.r2-article-body')!, paragraph = [...body.querySelectorAll('p')].find(p => p.textContent?.startsWith('A highlight'))!;
    paragraph.scrollIntoView({ block: 'center' }); const text = paragraph.firstChild!, end = text.textContent!.indexOf('.');
    const rect = (offset: number) => { const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); return range.getBoundingClientRect(); };
    const first = rect(2), last = rect(end - 1), control = document.createElement('button'); control.textContent = 'Fixture reading-page control'; document.querySelector('.r2-reading-page')!.append(control);
    return { start: { x: first.left + .2, y: first.top + first.height / 2 }, end: { x: last.right - .2, y: last.top + last.height / 2 }, bodySelect: getComputedStyle(body).userSelect, paragraphSelect: getComputedStyle(paragraph).userSelect, webkit: getComputedStyle(paragraph).getPropertyValue('-webkit-user-select'), hostSelect: getComputedStyle(document.body).userSelect, controlSelect: getComputedStyle(control).userSelect };
  });
  expect(points.bodySelect).toBe('text'); expect(points.paragraphSelect).toBe('text'); expect(points.webkit).toBe('text'); expect(points.hostSelect).toBe('none'); expect(points.controlSelect).toBe('none');
  await page.mouse.move(points.start.x, points.start.y); await page.mouse.down(); await page.mouse.move(points.end.x, points.end.y, { steps: 18 });
  const quote = await page.evaluate(() => document.getSelection()?.toString() ?? ''); expect(quote.trim().length).toBeGreaterThan(20);
  await page.waitForTimeout(1100); await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '0'); await page.mouse.up();
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1'); expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(quote);
  const saved = await files(page), path = await page.evaluate(() => window.reader.app.getState().file!); expect(saved[path]).toContain('==' + quote.trim() + '=='); expect(Object.keys(saved).some(file => file.startsWith('Daily/') || file.endsWith('.json'))).toBe(false);
});

test('held pointer never saves; leaving Reader cancels an unsettled selection', async ({ page }) => {
  await sample(page); await page.locator('.r2-article-body').dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', buttons: 1 }); await selection(page); await page.waitForTimeout(1100);
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '0'); await page.evaluate(() => window.reader.app.destroy()); await page.waitForTimeout(1000);
  expect(Object.values(await files(page)).some(text => text.includes('==A highlight'))).toBe(false);
});
for (const [origin, destination, action] of [['feed', 'inbox', 'Move to Inbox'], ['feed', 'later', 'Move to Later'], ['feed', 'archive', 'Move to Treasury'], ['later', 'archive', 'Move to Treasury']] as const) {
  test(origin + ' → ' + destination + ' keeps origin queue, preserves notes and handles boundaries/empty queue', async ({ page }) => {
    const paths = await seedQueue(page, origin);
    await page.locator('.r2-reader-scroll').evaluate(el => { el.scrollTop = 500; });
    const { unflushed, before, position } = await page.evaluate(async () => {
      const { app, store } = window.reader, unflushed = store.snapshot(), position = app.getState().readingPosition;
      await app.flushPosition(); return { unflushed, before: store.snapshot(), position };
    });
    expect(position).toEqual({ marker: expect.stringContaining('Queue paragraph') }); expect(position!.marker.trim().split(/\s+/).length).toBeLessThanOrEqual(5);
    expect(parseNote(before[paths[1]]).doc.toJS().reading_position).toEqual(position!.marker);
    expectOnlyReadingPositionChanged(unflushed[paths[1]], before[paths[1]]);
    expect(Object.keys(before).sort()).toEqual(Object.keys(unflushed).sort());
    for (const path of Object.keys(unflushed)) if (path !== paths[1]) expect(before[path], path).toBe(unflushed[path]);
    await command(page, 'Switch queue'); await page.getByRole('button', { name: queueNames[destination], exact: true }).click(); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await files(page)).toEqual(before); await command(page, action); await expect(page.locator('.r2-article-title')).toHaveText(queueTitles[2]);
    expect(await page.evaluate(() => window.reader.app.getState().queue)).toBe(origin);
    const moved = await files(page), movedPath = `Reading/${queueNames[destination]}/${paths[1].split('/').at(-1)}`;
    expect(moved[paths[1]]).toBeUndefined(); expect(moved[movedPath]).toBeDefined();
    expect(moved[movedPath]).toBe(before[paths[1]]);
    const expected = { ...before, [movedPath]: before[paths[1]] }; delete expected[paths[1]]; expect(moved).toEqual(expected);
    expect(parseNote(moved[movedPath]).doc.toJS()).toMatchObject({ custom_move_fixture: 'preserved', custom_nested: { label: 'untouched' }, reading_position: position!.marker });
    expect(parseNote(moved[movedPath]).doc.toJS()).not.toHaveProperty('highlights');
    expect(moved['Daily/queue.md']).toBeUndefined();
    expect(await page.evaluate(() => window.reader.app.canNavigate(1))).toBe(false); await command(page, 'Previous'); await expect(page.locator('.r2-article-title')).toHaveText(queueTitles[0]);
    expect(await page.evaluate(() => window.reader.app.canNavigate(-1))).toBe(false); await command(page, 'Next'); await expect(page.locator('.r2-article-title')).toHaveText(queueTitles[2]);
    await command(page, action); await expect(page.locator('.r2-article-title')).toHaveText(queueTitles[0]); await command(page, action); await expect(page.locator('.r2-article-title')).toHaveText('No more articles in ' + queueNames[origin] + '.');
    expect(await page.evaluate(() => window.reader.app.getState().file)).toBeUndefined();
  });
}
test('failed move preserves context; moving another article does not navigate', async ({ page }) => {
  const paths = await seedQueue(page, 'feed'); await page.evaluate(async paths => { await window.reader.controller.move(paths[0], 'archive'); }, paths);
  await expect(page.locator('.r2-article-title')).toHaveText(queueTitles[1]);
  await page.evaluate(() => { window.reader.controller.repository.setStatus = async () => { throw new Error('Write refused'); }; });
  await command(page, 'Move to Treasury'); await expect(page.getByRole('status').filter({ hasText: 'Write refused' })).toBeVisible(); await expect(page.locator('.r2-article-title')).toHaveText(queueTitles[1]); expect(await page.evaluate(() => window.reader.app.getState().queue)).toBe('feed');
});
test('offline capture opens pending and explicit Defuddle targets one article without changing dummy preference', async ({ page, context }) => {
  await sample(page); await page.evaluate(() => window.reader.controller.setActive(false)); await context.setOffline(true); await command(page, 'Add URL');
  await page.getByRole('textbox', { name: 'URL', exact: true }).fill('https://reader.test/explicit-live'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.locator('.r2-article-body')).toContainText('Full text is pending');
  const before = await files(page); await command(page, 'Fetch full text with Defuddle'); await expect(page.getByRole('status').filter({ hasText: 'Offline.' })).toBeVisible(); expect(await files(page)).toEqual(before);
  await context.setOffline(false); await command(page, 'Fetch full text with Defuddle'); await expect(page.locator('.r2-article-body')).toContainText('Reading is an encounter'); expect(await page.evaluate(() => window.reader.controller.settings.useDummyContent)).toBe(true);
});
test('desktop j/k obey active leaf, typing, dialogs, modifiers and cleanup', async ({ page }, info) => {
  test.skip(info.project.name.includes('mobile'), 'Desktop shortcut requirement'); await sample(page); await page.setViewportSize({ width: 500, height: 800 }); await expect(page.locator('.r2-reader-toolbar')).toBeHidden(); await page.keyboard.press('j'); await expect(page.locator('.r2-article-title')).toHaveText(attentionTitle); await page.keyboard.press('k'); await expect(page.locator('.r2-article-title')).toHaveText(sampleTitle);
  await page.evaluate(() => { window.reader.ui.active = false; }); await page.keyboard.press('j'); await page.waitForTimeout(80); await expect(page.locator('.r2-article-title')).toHaveText(sampleTitle); await page.evaluate(() => { window.reader.ui.active = true; });
  await command(page, 'Reading list'); await page.keyboard.press('j'); await expect(page.locator('.r2-article-title')).toHaveText(sampleTitle); await page.keyboard.press('Escape');
  await page.evaluate(() => { for (const attrs of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { isComposing: true }]) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, ...attrs })); const prevented = new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }); prevented.preventDefault(); document.dispatchEvent(prevented); });
  for (const tag of ['input', 'textarea', 'select', 'div']) { await page.evaluate(tag => { const control = document.createElement(tag); control.id = 'typing'; if (tag === 'div') control.setAttribute('contenteditable', 'true'); document.querySelector('.r2-content')!.append(control); control.focus(); }, tag); await page.keyboard.press('j'); await page.locator('#typing').evaluate(el => el.remove()); }
  await expect(page.locator('.r2-article-title')).toHaveText(sampleTitle); await page.evaluate(() => window.reader.app.destroy()); await page.keyboard.press('j'); await expect(page.locator('.r2-app')).toHaveCount(0);
});
test('mobile reading viewport and dark highlights clear simulated native chrome and keyboard', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'), 'Mobile host fixture'); await sample(page);
  await page.evaluate(async () => { const modulePath = '/preview/mobile-host.ts'; const fixture = await import(modulePath); fixture.installMobileHostFixture(); await window.readerMobileHost.highlights(); });
  await expect.poll(() => page.evaluate(() => { const m = window.readerMobileHost.metrics(); return m.bottom < m.overlayTop && m.buttons.every(button => button.height >= 44 && button.reachable); })).toBe(true);
  const normal = await page.evaluate(() => window.readerMobileHost.metrics()); expect(normal.minContrast).toBeGreaterThan(4.5); expect(normal.distinct).toBe(true); expect(normal.hostStyle).toBeNull();
  await page.getByRole('button', { name: 'Native control 0', exact: true }).click(); expect((await page.evaluate(() => window.readerMobileHost.metrics())).hostClicks).toBe(1);
  await page.screenshot({ path: info.outputPath('native-mobile-host.png') }); await page.locator('.r2-article-body p').first().click({ position: { x: 30, y: 14 } }); await page.getByRole('button', { name: 'Link to…', exact: true }).click();
  await page.evaluate(() => window.readerMobileHost.state('keyboard')); await expect.poll(() => page.evaluate(() => { const m = window.readerMobileHost.metrics(); return m.popupBottom > 0 && m.popupBottom < m.overlayTop; })).toBe(true); await page.screenshot({ path: info.outputPath('native-mobile-keyboard.png') });
  await page.keyboard.press('Escape'); await page.evaluate(() => window.readerMobileHost.state('hidden')); await expect.poll(() => page.evaluate(() => window.readerMobileHost.root.style.height)).toBe('');
  await page.evaluate(() => { window.readerMobileHost.state('visible'); }); await expect.poll(() => page.evaluate(() => window.readerMobileHost.root.style.height)).not.toBe('');
  await page.evaluate(() => window.reader.app.destroy()); expect(await page.evaluate(() => window.readerMobileHost.root.style.height)).toBe(''); await page.getByRole('button', { name: 'Native control 0', exact: true }).click();
});

test('Assign topics searches, cancels, rejects stale drafts, and saves after reopening', async ({ page }) => {
  await sample(page);
  const before = await page.evaluate(async () => {
    const { store, controller, app } = window.reader, path = app.getState().file!;
    for (const name of ['A/Attention', 'B/Attention', 'C/Reading']) await store.create(name + '.md', '---\ntype: topic\n---\nTopic body.');
    await store.create('Not a topic.md', '---\ntype: note\n---\n'); await controller.assignTopics(path, { add: ['A/Attention.md'] }); return { path, text: await store.read(path), body: (await controller.repository.getArticle(path)).body };
  });
  await command(page, 'Assign topics'); await expect(page.getByRole('checkbox')).toHaveCount(3); await expect(page.getByRole('checkbox', { name: 'A/Attention.md', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'B/Attention.md', exact: true }).check(); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); expect((await files(page))[before.path]).toBe(before.text);
  await command(page, 'Assign topics'); await page.getByRole('checkbox', { name: 'A/Attention.md', exact: true }).uncheck(); await page.getByRole('searchbox', { name: 'Search topics', exact: true }).fill('B/'); await expect(page.getByRole('checkbox')).toHaveCount(1); await page.getByRole('checkbox').check();
  await page.evaluate(async path => { await window.reader.controller.repository.updateArticleTopics(path, { add: ['C/Reading.md'] }); }, before.path);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Assign topics' }).getByRole('alert')).toContainText('Article topics changed');
  const rejected = await page.evaluate(path => window.reader.controller.repository.getArticle(path), before.path);
  expect(rejected.topics?.sort()).toEqual(['A/Attention.md', 'C/Reading.md']);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await command(page, 'Assign topics');
  await expect(page.getByRole('checkbox', { name: 'C/Reading.md', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'A/Attention.md', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'B/Attention.md', exact: true }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Assign topics' })).toBeHidden();
  const after = await page.evaluate(path => window.reader.controller.repository.getArticle(path), before.path); expect(after.topics?.sort()).toEqual(['B/Attention.md', 'C/Reading.md']); expect(after.body).toBe(before.body); expect((await files(page))[before.path]).not.toContain('## Topics'); await expect(page.locator('.r2-article-title')).toHaveText(sampleTitle);
});
test('two Reader instances retain independent file/queue state and inactive leaf never takes focus', async ({ page }) => {
  await sample(page);
  const result = await page.evaluate(async () => {
    const { app, controller } = window.reader, initial = app.getState(), focused = document.activeElement;
    const modulePath = '/src/ui/app.ts', { ReaderApp } = await import(modulePath), parent = document.createElement('div'); parent.style.cssText = 'position:fixed;left:-2000px;width:600px;height:800px'; document.body.append(parent);
    const second = new ReaderApp(parent, controller, { autoOpen: false, shouldFocus: () => false, openNote: () => {} });
    const other = (await controller.repository.listArticles()).find(article => article.status === 'later')!; await second.open(other.path);
    const otherState = second.getState(), unchangedFocus = document.activeElement === focused; await app.open((await controller.repository.listArticles()).find(article => article.status === 'archive')!.path);
    const unchangedOther = second.getState().file === otherState.file && second.getState().queue === otherState.queue;
    await app.open(initial.file!, initial); const restored = app.getState(); second.destroy(); parent.remove(); return { initial, restored, unchangedFocus, unchangedOther };
  });
  expect(result.unchangedFocus).toBe(true); expect(result.unchangedOther).toBe(true); expect(result.restored.file).toBe(result.initial.file); expect(result.restored.queue).toBe(result.initial.queue);
});
