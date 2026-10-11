import { test, expect } from '@playwright/test';
import { parseNote } from '../src/storage/markdown';
import { expectOnlyReadingPositionChanged } from './helpers/reading-position-note';
import { agents, DEVICE_KEY, expectNoPageBar, expectUnchangedBody, expectVisiblePosition, fixture, focusReader, position, progress, settle, turnTo, watchBody, zeroScroll } from './helpers/eink-browser';
import { laterPageHighlights } from './helpers/eink-highlights';

// Chromium UA simulations only: not native Platform.isAndroidApp, Boox hardware, or iOS acceptance.
test.use({ viewport: { width: 760, height: 900 } });
for (const platform of ['desktop', 'ios', 'android'] as const) {
  for (const enabled of platform === 'android' ? [undefined, false] : [undefined, true]) {
    test.describe(`${platform} / stored enabled=${enabled}`, () => {
      test.use({ userAgent: agents[platform] });
      test('retains ordinary scrolling, serializes its anchor, and has no eInk page controls', async ({ page }) => {
        const article = await fixture(page, enabled);
        const yaml = parseNote(article.raw).doc.toJS();
        expect(yaml).toMatchObject({ type: 'article', title: 'EInk long source' });
        for (const key of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength', 'created-by']) expect(yaml).not.toHaveProperty(key);
        const reopened = await page.evaluate(path => window.reader.controller.repository.getArticle(path), article.path);
        expect(reopened.body).toBe(article.body);
        expect(reopened.content).toBe('protected'); expect(reopened.extractor).toBe('manual');
        await expect(page.locator('.r2-reader')).not.toHaveClass(/r2-eink/);
        await expectNoPageBar(page);
        expect(await page.evaluate(() => window.reader.app.getState())).toHaveProperty('readingPosition');
        await expect(page.locator('.r2-reading-page')).toHaveCount(1);
        await watchBody(page); await focusReader(page); await page.keyboard.press('PageDown');
        await expect.poll(() => page.locator('.r2-reader-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
        expect(await page.evaluate(() => window.reader.app.getState().file)).toBe(article.path);
        await expectUnchangedBody(page, article.path, article.body);
      });
    });
  }
}

test.describe('Android device opt-in / real Reader', () => {
  test.use({ userAgent: agents.android });
  test('whole-page keys and real repeats/endstops never auto-advance articles', async ({ page }) => {
    const article = await fixture(page, true); await watchBody(page);
    await expect(page.locator('.r2-reader')).toHaveClass(/r2-eink/);
    await expectNoPageBar(page);
    const first = await progress(page); expect(first.page).toBe(1); expect(first.total).toBeGreaterThan(4);
    await focusReader(page);
    await page.keyboard.press('PageUp'); expect((await progress(page)).page).toBe(1);
    const x = await page.locator('.r2-reading-page').evaluate(el => el.getBoundingClientRect().x);
    const width = await page.locator('.r2-reader-scroll').evaluate(el => el.clientWidth);
    await page.keyboard.down('PageDown'); await expect.poll(async () => (await progress(page)).page).toBe(2);
    // Playwright's repeated down generates a genuine Chromium event with repeat=true.
    await page.keyboard.down('PageDown'); await page.keyboard.down('PageDown'); await page.keyboard.up('PageDown');
    expect((await progress(page)).page).toBe(2);
    expect(x - await page.locator('.r2-reading-page').evaluate(el => el.getBoundingClientRect().x)).toBeCloseTo(width, 0);
    await page.keyboard.press('PageDown'); expect((await progress(page)).page).toBe(3);
    await zeroScroll(page); await expectVisiblePosition(page, await position(page));
    await page.locator('.r2-reader-scroll').evaluate(el => { el.scrollTop = 700; el.scrollLeft = 900; });
    await zeroScroll(page); await turnTo(page, first.total); await expectNoPageBar(page);
    await focusReader(page); await page.keyboard.press('PageDown'); expect((await progress(page)).page).toBe(first.total);
    expect(await page.evaluate(() => window.reader.app.getArticle()?.path)).toBe(article.path);
    await expectUnchangedBody(page, article.path, article.body);
    expectOnlyReadingPositionChanged(article.raw, await page.evaluate(async path => window.reader.store.read(path), article.path));
    // Existing +/- navigation remains ARTICLE navigation, rather than being repurposed as paging.
    await page.evaluate(() => window.reader.app.navigate(1));
    await expect.poll(() => page.evaluate(() => window.reader.app.getState().file)).toBe(article.other);
    await page.evaluate(() => window.reader.app.navigate(-1));
    await expect.poll(() => page.evaluate(() => window.reader.app.getState().file)).toBe(article.path);
  });

  test('completion controls occupy a reachable page after the text, without changing Markdown', async ({ page }) => {
    const article = await fixture(page, true); await watchBody(page);
    const finish = page.getByRole('navigation', { name: 'After reading' });
    await expect(finish).toBeHidden();
    const lastText = (await progress(page)).total - 1;
    await turnTo(page, lastText); await expect(finish).toBeHidden();
    const textPosition = await position(page);
    await focusReader(page); await page.keyboard.press('PageDown');
    await expect(finish).toBeVisible();
    const end = await progress(page); expect(end.page).toBe(end.total);
    expect(await position(page)).toEqual(textPosition);
    await expect(finish).toContainText('EInk companion');
    for (const label of ['Archive & next', 'Next without archiving', 'Back to reading list']) {
      const button = finish.getByRole('button', { name: label, exact: true });
      await expect(button).toBeVisible(); await expect(button).toBeInViewport();
    }
    expect(await page.locator('.r2-reading-page').evaluate(el => getComputedStyle(el).visibility)).toBe('hidden');
    await focusReader(page); await page.keyboard.press('PageDown');
    expect(await progress(page)).toEqual(end);
    expect(await page.evaluate(() => window.reader.app.getState().file)).toBe(article.path);
    await finish.getByRole('button', { name: 'Next without archiving', exact: true }).focus();
    await page.keyboard.press('PageUp'); await expect(finish).toBeHidden();
    expect(await page.locator('.r2-reader-scroll').evaluate(el => el === document.activeElement)).toBe(true);
    await expectVisiblePosition(page, await position(page));
    await focusReader(page); await page.keyboard.press('PageDown'); await expect(finish).toBeVisible();
    await expectUnchangedBody(page, article.path, article.body);
    expectOnlyReadingPositionChanged(article.raw, await page.evaluate(async path => window.reader.store.read(path), article.path));
    await finish.getByRole('button', { name: 'Next without archiving', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.reader.app.getState().file)).toBe(article.other);
    expect((await page.evaluate(async path => window.reader.controller.repository.getArticle(path), article.path)).status).toBe('later');
  });

  test('Boox finish fits narrow screens and archives to the next article', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const article = await fixture(page, true); const finish = page.getByRole('navigation', { name: 'After reading' });
    await turnTo(page, (await progress(page)).total);
    for (const button of await finish.getByRole('button').all()) {
      if (await button.isHidden()) continue;
      await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport();
    }
    await finish.getByRole('button', { name: 'Archive & next', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.reader.app.getState().file)).toBe(article.other);
    await expect.poll(() => page.evaluate(async path => (await window.reader.controller.repository.listArticles())
      .find(item => item.path.endsWith(path.split('/').pop()!))?.status, article.path)).toBe('archive');
  });

  test('completion survives reflow but reopen restores a text page, not UI', async ({ page }) => {
    const article = await fixture(page, true), finish = page.getByRole('navigation', { name: 'After reading' });
    await turnTo(page, (await progress(page)).total);
    const saved = await position(page);
    await page.setViewportSize({ width: 400, height: 630 });
    await expect(finish).toBeVisible();
    await expect.poll(async () => { const state = await progress(page); return state.page === state.total; }).toBe(true);
    expect(await position(page)).toEqual(saved);
    await page.evaluate(async path => { await window.reader.app.open(path); }, article.other);
    await page.evaluate(async path => { await window.reader.app.open(path); }, article.path);
    await expect(finish).toBeHidden();
    expect(await position(page)).toEqual(saved);
    await expectVisiblePosition(page, saved);
  });

  test('typing, outside focus, menu, modifiers and inactive reader guard page keys', async ({ page }) => {
    await fixture(page, true); await turnTo(page, 2); const before = await progress(page);
    await page.evaluate(() => {
      const input = document.createElement('input'); input.id = 'eink-typing';
      document.querySelector('.r2-reader')!.append(input); input.focus();
    });
    await page.keyboard.press('PageDown'); expect(await progress(page)).toEqual(before);
    await page.locator('#eink-typing').evaluate(el => el.remove());
    await page.getByRole('button', { name: 'Command palette', exact: true }).focus();
    await page.keyboard.press('PageDown'); expect(await progress(page)).toEqual(before);
    await focusReader(page); await page.keyboard.press('Control+PageDown'); expect(await progress(page)).toEqual(before);
    await page.evaluate(() => window.reader.ui.more()); await page.keyboard.press('PageDown');
    expect(await progress(page)).toEqual(before);
    await page.getByRole('dialog', { name: 'Reader commands' }).getByRole('button', { name: 'Close', exact: true }).click();
    await focusReader(page); await page.evaluate(() => { window.reader.ui.active = false; });
    await page.keyboard.press('PageDown'); expect(await progress(page)).toEqual(before);
    await page.evaluate(() => { window.reader.ui.active = true; });
    await page.keyboard.press('PageDown'); expect((await progress(page)).page).toBe(3);
  });

  test('reversed hardware mapping swaps page keys and respects both end stops', async ({ page }) => {
    const article = await fixture(page, true); await turnTo(page, 3);
    await page.evaluate(() => window.reader.setEinkForDevice(true, true));
    await expectNoPageBar(page); expect((await progress(page)).page).toBe(3); await focusReader(page);
    await page.keyboard.press('PageDown'); expect((await progress(page)).page).toBe(2);
    await page.keyboard.press('PageUp'); expect((await progress(page)).page).toBe(3);
    await page.keyboard.press('PageUp'); expect((await progress(page)).page).toBe(4);
    const last = (await progress(page)).total;
    for (let n = 4; n < last; n++) {
      await page.keyboard.press('PageUp'); expect((await progress(page)).page).toBe(n + 1);
    }
    await page.keyboard.press('PageUp'); expect((await progress(page)).page).toBe(last);
    expect(await page.evaluate(() => window.reader.app.getArticle()?.path)).toBe(article.path);
    await page.keyboard.press('PageDown'); expect((await progress(page)).page).toBe(last - 1);
    for (let n = last - 1; n > 1; n--) {
      await page.keyboard.press('PageDown'); expect((await progress(page)).page).toBe(n - 1);
    }
    await page.keyboard.press('PageDown'); expect((await progress(page)).page).toBe(1);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), DEVICE_KEY)).toEqual({ enabled: true, reverseButtons: true });
  });

  for (const fallback of [false, true]) test(`later-page selection, inline link/unlink/unmark and ${fallback ? 'forced fallback' : 'native CSS'} paint preserve words`, async ({ page }) => {
    await laterPageHighlights(page, fallback);
  });

  test('article revisit, font changes, resize and hidden layout retain the same visible source character', async ({ page }) => {
    const article = await fixture(page, true); await turnTo(page, 4); const anchor = await position(page);
    expect(anchor.marker).not.toBe(''); const originalPages = (await progress(page)).total;
    await page.evaluate(async path => { await window.reader.app.open(path); }, article.other);
    await page.evaluate(async path => { await window.reader.app.open(path); }, article.path);
    expect(await position(page)).toEqual(anchor); await expectVisiblePosition(page, anchor);
    await page.addStyleTag({ content: '.r2-article-body { font-size: 25px !important; line-height: 1.8 !important; }' });
    await expect.poll(async () => (await progress(page)).total).toBeGreaterThan(originalPages);
    expect(await position(page)).toEqual(anchor); await expectVisiblePosition(page, anchor);
    await page.setViewportSize({ width: 620, height: 730 }); await settle(page);
    expect(await position(page)).toEqual(anchor); await expectVisiblePosition(page, anchor);
    await page.locator('#app').evaluate(el => { el.style.display = 'none'; }); await settle(page);
    await page.setViewportSize({ width: 820, height: 920 });
    expect(await position(page)).toEqual(anchor);
    await page.locator('#app').evaluate(el => { el.style.removeProperty('display'); });
    await expect(page.locator('.r2-reader')).toHaveAttribute('data-page', /^[1-9]\d*$/);
    expect((await progress(page)).page).toBeGreaterThan(0);
    expect(await position(page)).toEqual(anchor); await expectVisiblePosition(page, anchor); await zeroScroll(page);
    expect(await page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).body, article.path)).toBe(article.body);
  });

  test('opting in while only the title is visible does not jump to the last page', async ({ page }) => {
    await fixture(page, false);
    await page.addStyleTag({ content: '.r2-reader:not(.r2-eink) .r2-article-title { min-height: 1400px; }' });
    await page.locator('.r2-reader-scroll').evaluate(el => { el.scrollTop = 200; });
    await page.evaluate(() => window.reader.setEinkForDevice(true));
    await expect(page.locator('.r2-reader')).toHaveAttribute('data-page', '1');
    expect((await progress(page)).page).toBe(1);
    expect(await position(page)).toMatchObject({ marker: '' });
  });

  test('mode changes preserve current text and persist only local device preference, not synced settings', async ({ page }) => {
    const article = await fixture(page, true); await turnTo(page, 4); const anchor = await position(page);
    const before = await page.evaluate(() => ({ settings: JSON.stringify(window.reader.controller.settings), files: window.reader.store.snapshot() }));
    await page.evaluate(() => window.reader.setEinkForDevice(false));
    await expectNoPageBar(page);
    await expect(page.locator('.r2-reader')).not.toHaveClass(/r2-eink/);
    expect(await page.evaluate(() => window.reader.app.getState())).toHaveProperty('readingPosition');
    await expectVisiblePosition(page, anchor);
    expect(await page.locator('.r2-reader-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await page.evaluate(() => window.reader.setEinkForDevice(true));
    await expectNoPageBar(page); await expect(page.locator('.r2-reader')).toHaveAttribute('data-page', /^[1-9]\d*$/);
    expect((await progress(page)).page).toBeGreaterThan(0);
    await expectVisiblePosition(page, anchor); await zeroScroll(page);
    const after = await page.evaluate(() => ({ settings: JSON.stringify(window.reader.controller.settings), files: window.reader.store.snapshot() }));
    // Only this article's reading_position may change; other notes and settings stay byte-identical.
    expect(after.settings).toEqual(before.settings);
    expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
    for (const [path, raw] of Object.entries(before.files)) {
      if (path === article.path) expectOnlyReadingPositionChanged(raw, after.files[path]);
      else expect(after.files[path], path).toBe(raw);
    }
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), DEVICE_KEY)).toEqual({ enabled: true, reverseButtons: false });
    expect(await page.evaluate(() => window.reader.app.getArticle()?.path)).toBe(article.path);
  });
});
