import { test, expect } from '@playwright/test';
import { fixture, paintPixels, settle, expectsOverlayPolicy } from './helpers/highlight-paint-browser';

for (const forceFallback of [false, true]) {
  test(`resolves root-local light-dark() with the root colour scheme (fallback=${forceFallback})`, async ({ page }) => {
    await fixture(page, forceFallback, 'light');
    await page.evaluate(() => {
      const root = window.highlightFixture.root;
      root.style.colorScheme = 'dark'; root.style.color = '#e5e5e5';
      root.style.setProperty('--r2-highlight-yellow', 'light-dark(#f8e6a3, #584315)');
      root.style.setProperty('--r2-highlight-blue', 'light-dark(#c4e1f5, #183f59)');
    });
    for (const region of await paintPixels(page, 'dark')) expect(region.painted, region.id).toBeGreaterThan(100);
    expect(await page.locator('[data-reader-ui="highlight-styles"]').allTextContents()).not.toEqual(expect.arrayContaining([expect.stringContaining('light-dark(')]));
  });
}

for (const contents of [false, true]) test(`fallback pixels stay inside nested scroll clips (display:contents=${contents})`, async ({ page }) => {
  await fixture(page, true, 'light');
  const bounds = await page.evaluate(contents => {
    const { root, items } = window.highlightFixture;
    const scroll = document.createElement('div'); scroll.style.cssText = 'width:140px;height:58px;overflow:auto;';
    const text = document.createElement('pre'); text.style.cssText = 'width:650px;margin:0;font:inherit;';
    text.textContent = 'MMMM serif ink with several selected words extending outside the nested viewport.';
    if (contents) { const wrapper = document.createElement('div'); wrapper.style.display = 'contents'; wrapper.append(text); scroll.append(wrapper); }
    else scroll.append(text);
    root.replaceChildren(scroll); scroll.scrollLeft = 120;
    const range = document.createRange(); range.selectNodeContents(text);
    items.splice(0, items.length, { id: 'nested', range, colour: 'yellow' }); window.highlightFixture.repaint();
    const r = scroll.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, contents);
  await settle(page);
  const png = await page.screenshot({ scale: 'css' });
  const pixels = await page.evaluate(async ({ encoded, bounds }) => {
    const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let inside = 0, outside = 0;
    for (let y = Math.ceil(bounds.top); y < Math.floor(bounds.bottom); y++) for (let x = 0; x < 320; x++) {
      const offset = (y * canvas.width + x) * 4;
      if ([248, 230, 163].every((value, i) => Math.abs(bytes[offset + i] - value) <= 1)) {
        if (x >= bounds.left && x < bounds.right) inside++; else outside++;
      }
    }
    return { inside, outside };
  }, { encoded: png.toString('base64'), bounds });
  expect(pixels.inside).toBeGreaterThan(100); expect(pixels.outside).toBe(0);
});

for (const opaque of ['block', 'mixed', 'root'] as const) {
  test(`opaque ${opaque} stays visible through native fragments, with unchanged text and background`, async ({ page, browserName, userAgent }, info) => {
    await fixture(page, false, 'dark', false, opaque);
    const overlay = expectsOverlayPolicy(browserName, userAgent);
    if (opaque === 'mixed') await page.evaluate(() => {
      const regions = window.highlightFixture.regions;
      window.highlightFixture.regions = () => { const r = document.querySelector('#single-yellow code')!.getBoundingClientRect();
        return [...regions(), { id: 'opaque-inline-code', colour: 'yellow', x: r.x, y: r.y, width: r.width, height: r.height, lines: 1 }]; };
    });
    const state = () => page.evaluate(() => ({ native: [...CSS.highlights.keys()].filter(name => name.startsWith('readerhl-')).length,
      overlays: document.querySelectorAll('[data-reader-ui="highlight-overlay"] span').length }));
    expect((await state()).native).toBeGreaterThan(0);
    if (overlay && opaque !== 'root') expect((await state()).overlays).toBeGreaterThan(0);
    if (overlay && opaque === 'mixed') expect(await page.evaluate(() =>
      [...CSS.highlights.values()].flatMap(highlight => [...highlight].map(range => range.toString())))).toEqual(['serif']);
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(theme => { document.body.className = 'theme-' + theme; }, theme);
      const regions = await paintPixels(page, theme, info, `opaque-${opaque}-${theme}`);
      for (const region of regions) {
        expect(region.painted, region.id).toBeGreaterThan(100);
        expect(region.ink, `${region.id}: foreground pixels`).toBeGreaterThan(0);
        expect(region.inkRows, `${region.id}: glyph height, not an underline`).toBeGreaterThanOrEqual(3);
      }
      if (overlay && opaque !== 'root') {
        const normal = regions.find(region => region.id === 'multi-blue')!;
        expect(normal.bands.length).toBe(normal.lines);
        for (let i = 1; i < normal.bands.length; i++) expect(normal.bands[i].top - normal.bands[i - 1].bottom).toBeGreaterThanOrEqual(3);
      }
      expect(await page.evaluate(() => window.highlightFixture.integrity())).toEqual({ html: true, nodes: true, ranges: true, selection: true, mutations: 0, nestedUI: 0 });
      const background = opaque === 'block' ? '#multi-yellow' : opaque === 'mixed' ? '#single-yellow code' : '#source';
      expect(await page.locator(background).evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(23, 23, 23)');
    }
    // Real stylesheet edits are observed; CSSOM-only insertRule is not claimed.
    await page.evaluate(() => {
      const css = document.querySelector<HTMLStyleElement>('#highlight-fixture-css')!;
      css.textContent = css.textContent!.replaceAll('background-color: #171717', 'background-color: transparent');
    });
    for (const region of await paintPixels(page, 'light')) expect(region.painted).toBeGreaterThan(100);
    if (overlay) { expect((await state()).native).toBe(0); expect((await state()).overlays).toBeGreaterThan(0); }
    await page.evaluate(() => window.highlightFixture.clear());
    expect(await page.locator('[data-reader-ui]').count()).toBe(0); expect((await state()).native).toBe(0);
  });
}
