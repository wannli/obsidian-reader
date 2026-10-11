import { test, expect, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import type { EinkPagination } from '../src/ui/eink-types';

declare global {
  interface Window {
    eink: typeof import('../src/ui/eink-pagination') & typeof import('../src/ui/eink-anchor') & typeof import('../src/highlights/highlight-paint');
    pagination: EinkPagination;
  }
}
const root = new URL('..', import.meta.url).pathname;
const bundle = buildSync({ stdin: { contents: `export * from './src/ui/eink-pagination'; export * from './src/ui/eink-anchor'; export * from './src/highlights/highlight-paint';`, resolveDir: root }, bundle: true, write: false, format: 'iife', globalName: 'eink' }).outputFiles[0]!.text;
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const settle = (page: Page) => page.waitForTimeout(150);
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 680 });
  await page.setContent(`<style>html,body{margin:0;height:100%}.r2-app{height:100vh}</style><div class="r2-app"><div class="r2-reader r2-eink"><div class="r2-reader-scroll"><article class="r2-reading-page"><h1 class="r2-article-title">Title outside body anchors</h1><div class="r2-article-body">${Array.from({ length: 24 }, (_, i) => `<h2>Section ${i}</h2><p>${(`Paragraph ${i} carries stable text across column boundaries. `).repeat(16)}</p>`).join('')}</div><p class="r2-highlight-summary"></p></article></div></div>`);
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    window.pagination = window.eink.createEinkPagination(document.querySelector('.r2-reader-scroll')!, document.querySelector('article')!, document.querySelector('.r2-article-body')!);
  });
  await settle(page);
});

test('whole lines, bounded turns, body immutability and no scroll', async ({ page }) => {
  const result = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.r2-article-body')!, viewport = document.querySelector<HTMLElement>('.r2-reader-scroll')!;
    const before = body.innerHTML, p = window.pagination, markers: string[] = [];
    const bounds = viewport.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(body);
    const allInside = [...range.getClientRects()].every(r => r.height === 0 || (r.top >= bounds.top + 15 && r.bottom <= bounds.bottom - 15));
    let turns = 0;
    while (p.turn(1)) { markers.push(p.getPosition().marker); if (++turns > 200) throw new Error('Unbounded pagination'); }
    return { allInside, unchanged: before === body.innerHTML, turns, progress: p.progress(), markers,
      backward: p.turn(-999), first: p.progress().page, further: p.turn(-1), scroll: [viewport.scrollTop, viewport.scrollLeft] };
  });
  expect(result.allInside).toBe(true); expect(result.unchanged).toBe(true);
  expect(result.turns).toBe(result.progress.total - 1); expect(result.progress.page).toBe(result.progress.total);
  expect(result.markers.every(marker => marker.length > 0 && marker.trim().split(/\s+/).length <= 5)).toBe(true);
  expect(result.backward).toBe(true); expect(result.first).toBe(1); expect(result.further).toBe(false); expect(result.scroll).toEqual([0, 0]);
});

test('missing paginated marker returns to the first page', async ({ page }) => {
  await page.evaluate(() => { window.pagination.turn(4); window.pagination.restore({ marker: 'words absent from this article' }); });
  await expect.poll(() => page.evaluate(() => window.pagination.progress().page)).toBe(1);
  expect(await page.evaluate(() => window.pagination.getPosition())).toEqual({ marker: '' });
});

test('queued resize/font refresh cannot undo a newer turn; hidden restore keeps exact anchor', async ({ page }) => {
  const nav = await page.evaluate(() => {
    const p = window.pagination; p.turn(4);
    document.querySelector<HTMLElement>('.r2-app')!.style.width = '440px';
    document.querySelector<HTMLElement>('.r2-article-body')!.style.fontSize = '23px';
    window.dispatchEvent(new Event('resize')); p.refresh(); p.turn(1);
    return { position: p.getPosition(), progress: p.progress() };
  });
  await settle(page);
  expect(await page.evaluate(() => window.pagination.getPosition())).toEqual(nav.position);
  expect(await page.evaluate(() => window.pagination.progress().ready)).toBe(true);
  // A short repeated marker resolves to its first occurrence after reflow, not its old page number.
  await page.evaluate(() => { document.querySelector<HTMLElement>('.r2-reader')!.hidden = true; window.pagination.refresh(); });
  await settle(page);
  expect(await page.evaluate(() => window.pagination.progress().ready)).toBe(false);
  expect(await page.evaluate(position => {
    window.pagination.restore(position);
    const range = window.eink.rangeForReadingPosition(document.querySelector('.r2-article-body')!, position);
    document.querySelector<HTMLElement>('.r2-reader')!.hidden = false;
    return range?.toString();
  }, nav.position)).toBe(nav.position.marker.slice(0, 1));
  await settle(page);
  expect(await page.evaluate(() => window.pagination.getPosition())).toEqual(nav.position);
  expect(await page.evaluate(() => window.pagination.progress().ready)).toBe(true);
});

test('deep range reveal includes existing translation and ignores renderer-owned text', async ({ page }) => {
  const result = await page.evaluate(() => {
    const p = window.pagination, body = document.querySelector<HTMLElement>('.r2-article-body')!, article = document.querySelector('article')!;
    const viewport = document.querySelector<HTMLElement>('.r2-reader-scroll')!;
    const ui = document.createElement('div'); ui.dataset.readerUi = 'fixture'; ui.textContent = 'Not canonical text';
    ui.style.cssText = 'position:absolute;left:999999px'; article.append(ui);
    const inside = ui.cloneNode(true); body.prepend(inside);
    const total = p.progress().total; p.refresh(); p.turn(3);
    const node = body.querySelectorAll('p')[18]!.firstChild!;
    const range = document.createRange(); range.setStart(node, 42); range.setEnd(node, 200);
    const rect = range.getClientRects()[0]!;
    const expected = 1 + Math.floor((rect.left - viewport.getBoundingClientRect().left - parseFloat(article.style.left) + (p.progress().page - 1) * viewport.clientWidth + .5) / viewport.clientWidth);
    const revealed = p.reveal(range), position = p.getPosition();
    const clean = body.cloneNode(true) as HTMLElement; clean.querySelector('[data-reader-ui]')!.remove();
    return { revealed, expected, page: p.progress().page, total, after: p.progress().total,
      marker: position.marker, expectedMarker: clean.textContent!.includes(position.marker) };
  });
  expect(result.revealed).toBe(true); expect(result.page).toBe(result.expected); expect(result.after).toBe(result.total);
  expect(result.marker).not.toBe(''); expect(result.expectedMarker).toBe(true);
});

test('fallback highlight fragments stay visible across BODY/article columns without text mutation', async ({ page }) => {
  const before = await page.locator('.r2-article-body').innerHTML();
  await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.r2-article-body')!;
    const range = document.createRange(); range.selectNodeContents(body);
    window.eink.paintHighlights(body, [{ id: 'spanning', range, colour: 'yellow' }], { forceFallback: true });
    window.pagination.turn(5);
  });
  await settle(page);
  const painted = await page.evaluate(() => {
    const bounds = document.querySelector('.r2-reader-scroll')!.getBoundingClientRect();
    const rects = [...document.querySelectorAll('.reader-highlight-layer span')].map(el => el.getBoundingClientRect());
    return { count: rects.length, clipped: rects.every(r => r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom),
      z: getComputedStyle(document.querySelector('.r2-article-body')!).zIndex };
  });
  expect(painted.count).toBeGreaterThan(2); expect(painted.clipped).toBe(true); expect(painted.z).toBe('2');
  expect(await page.locator('.r2-article-body').innerHTML()).toEqual(before);
});

test('tall images, wide preformatted text and tables fit; explicit refresh recounts status', async ({ page }) => {
  await page.evaluate(() => {
    const body = document.querySelector('.r2-article-body')!;
    body.innerHTML = `<figure><img width="1200" height="9000" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="9000"><rect width="1200" height="9000" fill="grey"/></svg>')}"><figcaption>Tall image</figcaption></figure><pre><code>${'unbroken_identifier_'.repeat(160)}</code></pre><table><tbody>${Array.from({length: 12}, () => `<tr><td>${'wide_content_'.repeat(10)}</td><td>Second cell</td></tr>`).join('')}</tbody></table>`;
    window.pagination.refresh();
  });
  await settle(page);
  const result = await page.evaluate(() => {
    const p = window.pagination, body = document.querySelector('.r2-article-body')!;
    const range = document.createRange(); range.selectNodeContents(body);
    const h = document.querySelector('.r2-reader-scroll')!.clientHeight;
    const image = body.querySelector('img')!.getBoundingClientRect();
    return { total: p.progress().total, imageFits: image.height <= h - 32,
      linesFit: [...range.getClientRects()].every(r => r.height === 0 || (r.top >= 15 && r.bottom <= h - 15)),
      noInnerScroll: [...body.querySelectorAll('pre,table')].every(el => getComputedStyle(el).overflow === 'visible') };
  });
  expect(result.total).toBeGreaterThan(2); expect(result.imageFits).toBe(true); expect(result.linesFit).toBe(true); expect(result.noInnerScroll).toBe(true);
  await page.evaluate(() => { document.querySelector('.r2-highlight-summary')!.textContent = 'New status text. '.repeat(2000); window.pagination.refresh(); });
  await settle(page);
  expect(await page.evaluate(() => window.pagination.progress().total)).toBeGreaterThan(result.total);
});

test('ancestor CSS variables and stylesheet typography changes reflow without resize', async ({ page }) => {
  const before = await page.evaluate(() => { window.pagination.turn(3); return { position: window.pagination.getPosition(), total: window.pagination.progress().total }; });
  await page.evaluate(() => document.querySelector<HTMLElement>('.r2-app')!.style.setProperty('--font-text-size', '26px'));
  await settle(page);
  expect(await page.evaluate(() => window.pagination.progress().total)).toBeGreaterThan(before.total);
  expect(await page.evaluate(() => window.pagination.getPosition())).toEqual(before.position);
  const previous = await page.evaluate(() => window.pagination.progress().total);
  await page.addStyleTag({ content: '.r2-reading-page { line-height: 2.2 }' });
  await settle(page);
  expect(await page.evaluate(() => window.pagination.progress().total)).toBeGreaterThan(previous);
  expect(await page.evaluate(() => window.pagination.getPosition())).toEqual(before.position);
});

test('late image load and repeated font reflows preserve the original text anchor', async ({ page }) => {
  await page.evaluate(async () => {
    const image = document.createElement('img'); image.id = 'late-image';
    image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')}`;
    document.querySelector('.r2-article-body')!.prepend(image); await image.decode(); window.pagination.refresh();
  });
  await settle(page);
  const position = await page.evaluate(() => { window.pagination.turn(4); return window.pagination.getPosition(); });
  await page.evaluate(async () => {
    const image = document.querySelector<HTMLImageElement>('#late-image')!;
    image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="4000"/>')}`;
    await image.decode();
  });
  await settle(page);
  for (const size of ['24px', '17px', '22px']) {
    await page.evaluate(fontSize => { document.querySelector<HTMLElement>('.r2-reading-page')!.style.fontSize = fontSize; }, size);
    await settle(page);
    expect(await page.evaluate(() => window.pagination.getPosition())).toEqual(position);
    expect(await page.evaluate(() => {
      const viewport = document.querySelector('.r2-reader-scroll')!.getBoundingClientRect();
      const range = window.eink.rangeForReadingPosition(document.querySelector('.r2-article-body')!, window.pagination.getPosition())!;
      const rect = range.getBoundingClientRect();
      return rect.left >= viewport.left && rect.right <= viewport.right;
    })).toBe(true);
  }
});

test('scroll/paged toggle helpers preserve body offset and dispose restores inline styles', async ({ page }) => {
  const result = await page.evaluate(() => {
    const p = window.pagination, body = document.querySelector<HTMLElement>('.r2-article-body')!, viewport = document.querySelector<HTMLElement>('.r2-reader-scroll')!;
    p.turn(4); const position = p.getPosition(); p.dispose();
    document.querySelector('.r2-reader')!.classList.remove('r2-eink');
    const range = window.eink.rangeForReadingPosition(body, position)!;
    viewport.scrollTop += range.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    const scrollPosition = window.eink.captureReadingPosition(viewport, body);
    const disposedStyle = document.querySelector('article')!.style.cssText;
    document.querySelector('.r2-reader')!.classList.add('r2-eink');
    const fresh = window.eink.createEinkPagination(viewport, document.querySelector('article')!, body, { initialPosition: scrollPosition });
    return { position, scrollPosition, disposedStyle, restored: fresh.getPosition(), ready: fresh.progress().ready };
  });
  expect(result.position.marker).not.toBe(''); expect(result.scrollPosition.marker).not.toBe('');
  expect(result.restored).toEqual(result.scrollPosition); expect(result.disposedStyle).toBe(''); expect(result.ready).toBe(true);
});
