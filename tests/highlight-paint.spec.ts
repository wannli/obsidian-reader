import { test, expect } from '@playwright/test';
import { fixture, paintPixels, settle, colours, contrast, expectsOverlayPolicy, type Theme } from './helpers/highlight-paint-browser';

// Low-level renderer palette/geometry coverage, not a linked-highlight UI contract.
// Ordinary inline links are tested as anchors, without blue highlight overlays, in eink.spec.ts.
for (const forceFallback of [false, true]) for (const externalHost of [false, true]) {
  test(`${forceFallback ? 'forced fallback' : 'engine policy'} / ${externalHost ? 'external scope' : 'normal nested app'} paints article-local colours and refreshes both themes`, async ({ page, browserName, userAgent }, info) => {
    await fixture(page, forceFallback, 'light', externalHost);
    const overlay = forceFallback || expectsOverlayPolicy(browserName, userAgent);
    const strategy = await page.evaluate(() => ({
      overlays: document.querySelectorAll('[data-reader-ui="highlight-overlay"]').length,
      native: [...CSS.highlights.keys()].filter(key => key.startsWith('readerhl-')).length,
      styles: [...document.querySelectorAll('style[data-reader-ui="highlight-styles"]')].map(style => style.textContent),
    }));
    expect(strategy.overlays).toBe(overlay ? 1 : 0);
    expect(strategy.native).toBe(overlay ? 0 : 2);
    expect(strategy.styles.join('')).not.toContain('var(');
    for (const theme of ['light', 'dark', 'light'] as Theme[]) {
      await page.evaluate(theme => { document.body.className = 'theme-' + theme; }, theme);
      const pixels = await paintPixels(page, theme, info, `${theme}-${overlay ? 'overlay' : 'native'}`);
      for (const region of pixels) {
        expect(region.painted, `${region.id}: actual background pixels`).toBeGreaterThan(100);
        // Font rasterization varies across macOS/Linux: require actual glyph ink
        // on several rows, not 16 exact-RGB pixels from a particular font.
        expect(region.ink, `${region.id}: inherited foreground pixels`).toBeGreaterThan(0);
        expect(region.inkRows, `${region.id}: glyph height, not an underline`).toBeGreaterThanOrEqual(3);
        expect(contrast(colours[theme].ink, region.expected)).toBeGreaterThan(4.5);
        if (overlay) {
          expect(region.bands.length, `${region.id}: separately painted text lines`).toBe(region.lines);
          expect(region.inkOutside, `${region.id}: paint must cover the actual glyph ink vertically`).toEqual([]);
          for (const band of region.bands) expect(band.height).toBeLessThan(25); // 28.8px line-height must retain gaps.
          for (let i = 1; i < region.bands.length; i++) expect(region.bands[i].top - region.bands[i - 1].bottom).toBeGreaterThanOrEqual(3);
        }
      }
      expect(pixels[0].expected).not.toEqual(pixels[1].expected);
      expect(await page.evaluate(() => window.highlightFixture.integrity())).toEqual({ html: true, nodes: true, ranges: true, selection: true, mutations: 0, nestedUI: 0 });
      if (theme === 'dark' && browserName === 'webkit' && !forceFallback && !externalHost) {
        const selection = await page.locator('#selection').boundingBox();
        await page.screenshot({ path: info.outputPath('synthetic-local-WebKit-dark-highlights.png'), scale: 'css',
          clip: { x: 0, y: 0, width: 390, height: Math.floor(selection!.y - 8) } });
      }
      if (overlay && !externalHost) {
        const bluePaint = page.locator('[data-reader-ui="highlight-overlay"] [data-reader-highlight-colour="blue"]');
        expect(await bluePaint.count()).toBeGreaterThan(0);
        await expect.poll(() => page.evaluate(() => {
          const el = document.querySelector('[data-reader-ui="highlight-overlay"] [data-reader-highlight-colour="blue"]');
          return el ? getComputedStyle(el).borderBottomStyle : null;
        })).toBe('solid');
      }
    }
    await page.evaluate(() => { window.highlightFixture.clear(); window.highlightFixture.clear(); });
    expect(await page.locator('[data-reader-ui]').count()).toBe(0);
    expect(await page.evaluate(() => [...CSS.highlights.keys()].filter(key => key.startsWith('readerhl-')).length)).toBe(0);
    await page.evaluate(() => { document.body.className = 'theme-dark'; });
    expect((await paintPixels(page, 'dark')).every(region => region.painted === 0)).toBe(true);
    expect(await page.locator('[data-reader-ui]').count()).toBe(0);
  });
}

test('normalized fallback excludes selected parent boxes, keeps source-range hits and respects clip/scale', async ({ page }) => {
  await fixture(page, true, 'dark');
  const geometry = await page.evaluate(() => {
    const { root, items } = window.highlightFixture;
    const host = root.parentElement!;
    host.style.transformOrigin = 'top left'; host.style.transform = 'translate(8px, 5px) scale(0.9)';
    host.style.height = '190px'; host.style.overflow = 'hidden';
    // Selecting the article also exposes paragraph/inline element rectangles. Those are not paint fragments.
    const range = document.createRange(); range.selectNodeContents(root);
    items.splice(0, items.length, { id: 'all', range, colour: 'yellow' });
    window.highlightFixture.repaint();
    const clip = host.getBoundingClientRect();
    return { clip: { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom } };
  });
  await settle(page);
  const result = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll<HTMLElement>('[data-reader-ui="highlight-overlay"] span')].map(el => {
      const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, pointerEvents: getComputedStyle(el).pointerEvents };
    });
    const source = window.highlightFixture.items[0].range.getClientRects()[0];
    return { boxes, hit: window.highlightFixture.hit(source.left + 2, source.top + 2),
      outside: window.highlightFixture.hit(-1, -1), nested: window.highlightFixture.root.querySelectorAll('[data-reader-ui]').length };
  });
  expect(result.boxes.length).toBeGreaterThan(2);
  for (const box of result.boxes) {
    expect(box.height).toBeLessThan(25);
    expect(box.left).toBeGreaterThanOrEqual(geometry.clip.left - 1);
    expect(box.right).toBeLessThanOrEqual(geometry.clip.right + 1);
    expect(box.top).toBeGreaterThanOrEqual(geometry.clip.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(geometry.clip.bottom + 1);
    expect(box.pointerEvents).toBe('none');
  }
  expect(result.hit).toEqual(['all']); expect(result.outside).toEqual([]); expect(result.nested).toBe(0);
});

test('paint/theme refresh never emits a synthetic held-selection autosave and disposal cancels pending work', async ({ page }) => {
  await fixture(page, true, 'light');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/highlights/index.ts';
    const { watchCompletedSelection } = await import(modulePath);
    const root = window.highlightFixture.root, completed: string[] = [];
    const stop = watchCompletedSelection(root, 'fixture-v1', (snapshot: { anchor: { quote: { exact: string } } }) => completed.push(snapshot.anchor.quote.exact), { settleMs: 40 });
    const pause = () => new Promise(resolve => setTimeout(resolve, 100));
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
    document.dispatchEvent(new Event('selectionchange')); window.highlightFixture.repaint(); document.body.className = 'theme-dark';
    await pause(); const held = completed.length;
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
    await pause(); const released = completed.length;
    window.highlightFixture.repaint(); document.body.className = 'theme-light'; await pause(); const unchanged = completed.length;
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(window.highlightFixture.items[0].range);
    document.dispatchEvent(new Event('selectionchange')); stop(); window.highlightFixture.clear(); await pause();
    return { held, released, unchanged, disposed: completed.length };
  });
  expect(result).toEqual({ held: 0, released: 1, unchanged: 1, disposed: 1 });
});
