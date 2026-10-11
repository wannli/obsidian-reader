import { expect, type Page } from '@playwright/test';
import type { ReadingPosition } from '../../src/ui/eink-types';
export { settle } from './highlight-paint-browser';
export const DEVICE_KEY = 'obsidian-reader:boox-eink:v1';
export const agents = {
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
  ios: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 12; BOOX) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
};
export const markdown = Array.from({ length: 32 }, (_, i) => [
  i % 8 === 0 ? `## Chapter ${i / 8 + 1}\n` : '',
  `Passage ${String(i + 1).padStart(2, '0')} keeps a place in the story. Reading slowly leaves room to notice the words and remember their meaning. ` +
    Array.from({ length: 5 }, (_, j) => `A quiet ${i}-${j} paragraph continues ${i}-${j} across the paper ${i}-${j} without replacing the ${i}-${j} original text. `).join(''),
  i === 9 ? '\n```ts\nconst page = "a view, not a new article";\nconsole.log(page);\n```' : '',
  i === 17 ? '\n| Feature | Meaning |\n| --- | --- |\n| Page | A window on the source |\n| Anchor | The same words after resizing |' : '',
].filter(Boolean).join('\n\n')).join('\n\n');

declare global {
  interface Window { einkEvidence: { body: HTMLElement; html: string; nodes: Node[]; mutations: number; observer: MutationObserver } }
}
/** Synthetic BrowserStore only; all Markdown goes through the real repository/ReaderApp. */
export async function fixture(page: Page, enabled?: boolean) {
  await page.route('**/*', route => /^(127\.0\.0\.1|localhost)$/.test(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.addInitScript(({ key, enabled }) => {
    if (enabled === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ enabled, reverseButtons: false }));
  }, { key: DEVICE_KEY, enabled });
  await page.goto('/'); await expect(page.locator('.r2-article-body')).toBeVisible();
  const result = await page.evaluate(async body => {
    const { controller, app, store } = window.reader; controller.setActive(false);
    const article = await controller.repository.createArticle({ title: 'EInk long source', url: '', status: 'later', body, extractor: 'manual' });
    const other = await controller.repository.createArticle({ title: 'EInk companion', url: '', status: 'later', body: 'Another article, never an automatic page destination.', extractor: 'manual' });
    await app.refresh(); await app.open(article.path);
    return { path: article.path, other: other.path, body: article.body, raw: await store.read(article.path) };
  }, markdown);
  await expect(page.locator('.r2-article-body')).toContainText('Passage 32');
  await expectNoPageBar(page);
  await page.evaluate(async () => { await document.fonts.ready; });
  return result;
}
export async function expectNoPageBar(page: Page) {
  await expect(page.locator('.r2-page-navigation,.r2-page-previous,.r2-page-next,.r2-page-position,.r2-eink-footer')).toHaveCount(0);
}
export async function progress(page: Page) {
  const { page: current, pageTotal } = await page.locator('.r2-reader').evaluate(el => (el as HTMLElement).dataset);
  expect(current, 'usable real page geometry').toMatch(/^[1-9]\d*$/);
  expect(pageTotal, 'usable real page geometry').toMatch(/^[1-9]\d*$/);
  const result = { page: Number(current), total: Number(pageTotal) };
  expect(result.page).toBeLessThanOrEqual(result.total);
  return result;
}
export async function turnTo(page: Page, target: number) {
  const current = await progress(page); expect(target).toBeGreaterThan(0); expect(target).toBeLessThanOrEqual(current.total);
  await focusReader(page);
  for (let n = current.page; n !== target; n += Math.sign(target - n)) {
    await page.keyboard.press(n < target ? 'PageDown' : 'PageUp');
    await expect.poll(async () => (await progress(page)).page).toBe(n + Math.sign(target - n));
  }
}
export async function focusReader(page: Page) { await page.locator('.r2-reader-scroll').focus(); }
export async function zeroScroll(page: Page) {
  await expect.poll(() => page.locator('.r2-reader-scroll').evaluate(el => [el.scrollTop, el.scrollLeft])).toEqual([0, 0]);
}
export async function position(page: Page) {
  const value = await page.evaluate(() => window.reader.app.getState().readingPosition);
  expect(value, 'eInk serializes a text anchor').toBeDefined(); return value!;
}
/** Check the actual source character, not just a page counter or opaque saved state. */
export async function expectVisiblePosition(page: Page, value: ReadingPosition) {
  await expect.poll(() => page.evaluate(async value => {
    const modulePath = '/src/ui/eink-anchor.ts';
    const { rangeForReadingPosition } = await import(/* @vite-ignore */ modulePath) as typeof import('../../src/ui/eink-anchor');
    const body = document.querySelector<HTMLElement>('.r2-article-body')!, viewport = document.querySelector('.r2-reader-scroll')!.getBoundingClientRect();
    if (!value.marker) return document.querySelector<HTMLElement>('.r2-reader-scroll')!.scrollTop === 0;
    const range = rangeForReadingPosition(body, value);
    return !!range && [...range.getClientRects()].some(r => r.width > 0 && r.left >= viewport.left - 1 && r.right <= viewport.right + 1 && r.top >= viewport.top - 1 && r.bottom <= viewport.bottom + 1);
  }, value)).toBe(true);
}
export async function watchBody(page: Page) {
  await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.r2-article-body')!, walker = document.createTreeWalker(body, NodeFilter.SHOW_ALL), nodes: Node[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const observer = new MutationObserver(records => { window.einkEvidence.mutations += records.length; });
    window.einkEvidence = { body, html: body.innerHTML, nodes, mutations: 0, observer };
    observer.observe(body, { subtree: true, characterData: true, childList: true });
  });
}
export async function expectUnchangedBody(page: Page, path: string, original: string, sameMount = true) {
  expect(await page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).body, path)).toBe(original);
  expect(await page.evaluate(sameMount => {
    const { body, html, nodes, observer, mutations } = window.einkEvidence;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ALL), current: Node[] = [];
    while (walker.nextNode()) current.push(walker.currentNode);
    return { connected: !sameMount || body.isConnected, html: body.innerHTML === html && document.querySelector('.r2-article-body')!.innerHTML === html,
      nodes: current.length === nodes.length && current.every((node, i) => node === nodes[i]), mutations: mutations + observer.takeRecords().length, nestedPaint: document.querySelectorAll('.r2-article-body [data-reader-ui]').length };
  }, sameMount)).toEqual({ connected: true, html: true, nodes: true, mutations: 0, nestedPaint: 0 });
}
/** Native Range selection on a fully visible later-page fragment; no scrollIntoView. */
export async function selectVisibleQuote(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('.r2-reader-scroll')!.getBoundingClientRect();
    for (const p of document.querySelectorAll('.r2-article-body p')) {
      if (!p.firstChild || p.firstChild.nodeType !== Node.TEXT_NODE) continue;
      const range = document.createRange(); range.setStart(p.firstChild, 0); range.setEnd(p.firstChild, 35);
      const rects = [...range.getClientRects()];
      if (!rects.length || !rects.every(r => r.left >= viewport.left && r.right <= viewport.right && r.top >= viewport.top && r.bottom <= viewport.bottom)) continue;
      const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange')); return range.toString();
    }
    throw new Error('No fully visible quote on current page');
  });
}
