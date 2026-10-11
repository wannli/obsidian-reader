import { expect, type Page } from '@playwright/test';
import { expectNoPageBar, expectUnchangedBody, expectVisiblePosition, fixture, focusReader, position, progress, selectVisibleQuote, settle, turnTo, watchBody, zeroScroll } from './eink-browser';

/** Resolve revision-bound inline positions; optionally exercise the real paint fallback. */
async function highlightRect(page: Page, forceFallback = false) {
  return page.evaluate(async forceFallback => {
    const modulePath = '/src/highlights/index.ts';
    const { paintHighlights } = await import(modulePath);
    const inlinePath = '/src/inline/index.ts', indexPath = '/src/highlights/text-index.ts';
    const { parseInlineMarkdown } = await import(inlinePath);
    const { buildCanonicalTextIndex, rangeFromPosition } = await import(indexPath);
    const { app, controller } = window.reader, article = await controller.repository.getArticle(app.getState().file!);
    const parsed = parseInlineMarkdown(article.body, { stripTitle: article.title });
    const item = parsed.highlights[0], body = document.querySelector<HTMLElement>('.r2-article-body')!;
    if (!item) throw new Error('Expected inline highlight');
    const range = rangeFromPosition(buildCanonicalTextIndex(body), item.anchor);
    if (range.toString() !== item.quote) throw new Error('Inline quote did not resolve');
    if (forceFallback) paintHighlights(body, [{ id: item.id, range, colour: 'yellow' }], { forceFallback: true });
    const viewport = document.querySelector('.r2-reader-scroll')!.getBoundingClientRect();
    const rect = [...range.getClientRects()].find(r => r.width > 5 && r.left >= viewport.left && r.right <= viewport.right && r.top >= viewport.top && r.bottom <= viewport.bottom);
    if (!rect) throw new Error('Saved highlight is not on the visible page');
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, id: item.id };
  }, forceFallback);
}
async function expectPaint(page: Page, fallback: boolean) {
  const rect = await highlightRect(page, fallback); await settle(page);
  if (fallback) {
    await expect(page.locator('[data-reader-ui="highlight-overlay"]')).toHaveCount(1);
    expect(await page.locator('[data-reader-highlight-colour="yellow"]').count()).toBeGreaterThan(0);
  } else {
    expect(await page.evaluate(() => [...CSS.highlights.keys()].filter(key => key.startsWith('readerhl-')).length)).toBeGreaterThan(0);
    await expect(page.locator('[data-reader-ui="highlight-overlay"]')).toHaveCount(0);
  }
  // Screenshot pixels prove visible painting, not only CSS registry/overlay bookkeeping.
  const png = await page.screenshot({ scale: 'css' });
  const painted = await page.evaluate(async ({ encoded, rect, rgb }) => {
    const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let count = 0;
    for (let y = Math.ceil(rect.y); y < Math.floor(rect.y + rect.height); y++) for (let x = Math.ceil(rect.x); x < Math.floor(rect.x + rect.width); x++) {
      const offset = (y * canvas.width + x) * 4;
      if (rgb.every((value, i) => Math.abs(pixels[offset + i] - value) <= 2)) count++;
    }
    return count;
  }, { encoded: png.toString('base64'), rect, rgb: [184, 184, 184] });
  expect(painted, 'actual visible highlight background pixels').toBeGreaterThan(40);
}
async function clickHighlight(page: Page) {
  const r = await highlightRect(page); await page.mouse.click(r.x + Math.min(8, r.width / 2), r.y + r.height / 2);
  await expect(page.getByRole('dialog', { name: 'Highlight actions' })).toBeVisible();
}

export async function laterPageHighlights(page: Page, fallback: boolean) {
  const article = await fixture(page, true);
  await turnTo(page, 4); const savedPage = (await progress(page)).page;
  await watchBody(page); await focusReader(page); const quote = await selectVisibleQuote(page);
  await page.keyboard.press('PageDown'); expect((await progress(page)).page).toBe(savedPage);
  const preference = await page.evaluate(() => localStorage.getItem('obsidian-reader:boox-eink:v1'));
  const refused = await page.evaluate(() => {
    try { window.reader.setEinkForDevice(false); return ''; } catch (error) { return String(error); }
  });
  expect(refused).toContain('selection');
  expect(await page.evaluate(() => localStorage.getItem('obsidian-reader:boox-eink:v1'))).toBe(preference);
  // Real 900ms selection-settle timer, not a fake clock. NOT physical stylus/handle acceptance.
  await page.waitForTimeout(950);
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1');
  const saved = await page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).highlights, article.path);
  expect(saved).toHaveLength(1); expect(saved[0].quote).toBe(quote);
  const markedBody = article.body.replace(quote, '==' + quote + '==');
  // Syntax is saved, but the selected DOM/range must not be replaced mid-selection.
  await expectUnchangedBody(page, article.path, markedBody);
  expect(await page.evaluate(() => document.getSelection()!.toString())).toBe(quote);
  await page.evaluate(() => document.getSelection()!.removeAllRanges());
  await expect(page.locator('.r2-article-body mark')).toHaveText(quote);
  await expectPaint(page, fallback);
  expect(await page.locator('.r2-article-body mark').evaluate(el => ({ fill: getComputedStyle(el).backgroundColor,
    cue: getComputedStyle(el).textDecorationStyle }))).toEqual({ fill: 'rgb(184, 184, 184)', cue: 'solid' });
  await watchBody(page);
  await turnTo(page, savedPage + 1); await turnTo(page, savedPage);
  await expectPaint(page, fallback);
  await expectUnchangedBody(page, article.path, markedBody);
  await clickHighlight(page);
  await page.getByRole('dialog', { name: 'Highlight actions' }).getByRole('button', { name: 'Link', exact: true }).click();
  const linkedBody = article.body.replace(quote, '[[' + quote + ']]');
  await expect.poll(() => page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).body, article.path)).toBe(linkedBody);
  await expect(page.getByRole('dialog', { name: 'Highlight actions' })).toHaveCount(0);
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '0');
  const link = page.getByRole('link', { name: quote, exact: true });
  await expect(link).toBeVisible(); await expect(page.locator('.r2-article-body mark')).toHaveCount(0);
  expect(await link.evaluate(el => ({ cue: getComputedStyle(el).textDecorationStyle,
    ink: getComputedStyle(el).color, bodyInk: getComputedStyle(el.closest('.r2-article-body')!).color })))
    .toEqual({ cue: 'double', ink: 'rgb(36, 36, 36)', bodyInk: 'rgb(36, 36, 36)' });
  await expect(page.locator('[data-reader-ui="highlight-overlay"]')).toHaveCount(0);
  expect(await page.evaluate(() => [...CSS.highlights.keys()].filter(key => key.startsWith('readerhl-')).length)).toBe(0);
  await zeroScroll(page);
  // Inline IDs are not block IDs. Retain real text-position restoration on revisit/mode change.
  await turnTo(page, savedPage + 1); const later = await position(page);
  const state = await page.evaluate(async path => {
    const { app } = window.reader, state = app.getState(); await app.open(path, state); return state;
  }, article.path);
  expect(state.subpath).toBeUndefined(); expect(await position(page)).toEqual(later);
  expect((await progress(page)).page).toBe(savedPage + 1); await expectVisiblePosition(page, later);
  await page.evaluate(() => window.reader.setEinkForDevice(false));
  await expectNoPageBar(page); await expectVisiblePosition(page, later);
  await page.evaluate(() => window.reader.setEinkForDevice(true));
  await expectNoPageBar(page); expect((await progress(page)).page).toBe(savedPage + 1);
  await expectVisiblePosition(page, later); await zeroScroll(page);
  await turnTo(page, savedPage); await link.click();
  await page.getByRole('dialog', { name: 'Link actions' }).getByRole('button', { name: 'Unlink', exact: true }).click();
  await expect(link).toHaveCount(0);
  await expect.poll(() => page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).body, article.path)).toBe(article.body);
  // Removing a mark is distinct from unlinking: exercise the current highlight action too.
  await focusReader(page); expect(await selectVisibleQuote(page)).toBe(quote);
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1');
  await page.evaluate(() => document.getSelection()!.removeAllRanges());
  await expect(page.locator('.r2-article-body mark')).toHaveText(quote);
  await expectPaint(page, fallback); await clickHighlight(page);
  await page.getByRole('dialog', { name: 'Highlight actions' }).getByRole('button', { name: 'Remove highlight', exact: true }).click();
  await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '0');
  await expect(page.locator('[data-reader-ui="highlight-overlay"]')).toHaveCount(0);
  expect(await page.evaluate(() => [...CSS.highlights.keys()].filter(key => key.startsWith('readerhl-')).length)).toBe(0);
  const snapshot = await page.evaluate(() => window.reader.store.snapshot());
  expect(snapshot[article.path]).not.toContain('[[' + quote + ']]');
  expect(Object.keys(snapshot).filter(path => path.startsWith('Daily/') || path.endsWith('.json'))).toEqual([]);
  expect(await page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).body, article.path)).toBe(article.body);
}
