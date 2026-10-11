import { test, expect, type Page } from '@playwright/test';
import type { ResolvedHighlight } from '../src/highlights/types';
import { agents, fixture, settle } from './helpers/eink-browser';
import { contrast } from './helpers/highlight-paint-browser';
import { expectOnlyReadingPositionChanged } from './helpers/reading-position-note';

// Browser pixels prove the treatment, not physical Boox visibility/refresh quality.
const palettes = {
  light: { yellow: [184, 184, 184], blue: [160, 160, 160], ink: [36, 36, 36], paper: [255, 255, 255] },
  dark: { yellow: [83, 83, 83], blue: [98, 98, 98], ink: [229, 229, 229], paper: [24, 24, 24] },
};
declare global {
  interface Window {
    einkContrast: { root: HTMLElement; html: string; nodes: Node[]; weight: string; items: ResolvedHighlight[]; clear: () => void };
  }
}
// Synthetic two-colour painter primitives: blue is not stored linked-highlight state.
async function prepare(page: Page, fallback: boolean) {
  await fixture(page, true);
  await page.addStyleTag({ content: `
    body.theme-light { --background-primary: #fff; --text-normal: #242424; }
    body.theme-dark { --background-primary: #181818; --text-normal: #e5e5e5; }
  ` });
  await page.evaluate(async fallback => {
    const { app, controller } = window.reader;
    const article = await controller.repository.createArticle({ title: 'E-ink highlight contrast', url: '', status: 'later',
      body: 'Marked words need a visible highlight, not just heavier type.\n\nLinked words need a distinct non-colour cue.', extractor: 'manual' });
    await app.open(article.path); await document.fonts.ready;
    const root = document.querySelector<HTMLElement>('.r2-article-body')!;
    const items = [...root.querySelectorAll('p')].map((p, i) => {
      const range = document.createRange(); range.setStart(p.firstChild!, 0); range.setEnd(p.firstChild!, 12);
      return { id: `contrast-${i}`, range, colour: i ? 'blue' as const : 'yellow' as const };
    });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL), nodes: Node[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const path = '/src/highlights/index.ts';
    const { paintHighlights } = await import(/* @vite-ignore */ path) as typeof import('../src/highlights');
    window.einkContrast = { root, items, nodes, html: root.innerHTML, weight: getComputedStyle(root).fontWeight,
      clear: paintHighlights(root, items, { forceFallback: fallback }) };
  }, fallback);
  await settle(page);
}
async function pixels(page: Page, png: Buffer, theme: keyof typeof palettes) {
  return page.evaluate(async ({ encoded, palette }) => {
    const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const equal = (at: number, rgb: number[]) => rgb.every((n, i) => Math.abs(data[at + i] - n) <= 1);
    const viewport = document.querySelector('.r2-reader-scroll')!.getBoundingClientRect();
    return window.einkContrast.items.map(item => {
      const r = item.range.getBoundingClientRect(), colour = item.colour as 'yellow' | 'blue';
      let fill = 0, ink = 0; const bands: number[][] = [];
      for (let y = Math.ceil(r.top); y < Math.ceil(r.bottom) + 8; y++) {
        let row = 0;
        for (let x = Math.ceil(r.left); x < Math.floor(r.right); x++) {
          const at = (y * canvas.width + x) * 4;
          if (y < r.bottom && equal(at, palette[colour])) fill++;
          if (equal(at, palette.ink)) { ink++; row++; }
        }
        // Glyphs are broken strokes. A near-continuous ink row below the glyph
        // midline proves an actual underline even if the grey fill washes out.
        if (y > r.top + r.height * .55 && row > r.width * .8) {
          const last = bands.at(-1);
          if (last && last.at(-1) === y - 1) last.push(y); else bands.push([y]);
        }
      }
      return { colour, fill, ink, bands, visible: r.top >= viewport.top && r.bottom + 8 <= viewport.bottom &&
        r.left >= viewport.left && r.right <= viewport.right };
    });
  }, { encoded: png.toString('base64'), palette: palettes[theme] });
}

test.describe('opted-in Boox contrast', () => {
  test.use({ userAgent: agents.android, viewport: { width: 760, height: 900 } });
  for (const fallback of [false, true]) test(`grey fill and single/double underlines survive theme changes (${fallback ? 'fallback' : 'native'})`, async ({ page }, info) => {
    await prepare(page, fallback);
    for (const theme of ['light', 'dark', 'light'] as const) {
      await page.evaluate(theme => { document.body.classList.remove('theme-light', 'theme-dark'); document.body.classList.add(`theme-${theme}`); }, theme);
      await settle(page); await settle(page);
      const png = await page.screenshot({ scale: 'css' });
      await info.attach(`${theme}-${fallback ? 'fallback' : 'native'}`, { body: png, contentType: 'image/png' });
      for (const region of await pixels(page, png, theme)) {
        expect(region.visible).toBe(true);
        expect(region.fill, `${region.colour}: actual opaque grey background pixels`).toBeGreaterThan(100);
        expect(region.ink).toBeGreaterThan(40);
        expect(region.bands, `${region.colour}: visible single/double underline`).toHaveLength(region.colour === 'blue' ? 2 : 1);
        expect(contrast(palettes[theme][region.colour], palettes[theme].paper)).toBeGreaterThan(1.8);
        expect(contrast(palettes[theme][region.colour], palettes[theme].ink)).toBeGreaterThan(4.5);
      }
      expect(await page.evaluate(() => {
        const { root, html, nodes, weight, items } = window.einkContrast;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL), current: Node[] = [];
        while (walker.nextNode()) current.push(walker.currentNode);
        return { html: root.innerHTML === html, nodes: current.length === nodes.length && current.every((node, i) => node === nodes[i]),
          weight: getComputedStyle(root).fontWeight === weight, quotes: items.map(item => item.range.toString()),
          nestedPaint: root.querySelectorAll('[data-reader-ui]').length };
      })).toEqual({ html: true, nodes: true, weight: true, quotes: ['Marked words', 'Linked words'], nestedPaint: 0 });
    }
    await page.evaluate(() => window.einkContrast.clear());
    await expect(page.locator('[data-reader-ui="highlight-overlay"], [data-reader-ui="highlight-styles"]')).toHaveCount(0);
    expect(await page.evaluate(() => [...CSS.highlights.keys()].filter(key => key.startsWith('readerhl-')))).toEqual([]);
    await page.evaluate(() => window.reader.setEinkForDevice(false));
    await expect(page.locator('.r2-reader')).not.toHaveClass(/r2-eink/);
    expect(await page.locator('.r2-article-body').evaluate(el => getComputedStyle(el).getPropertyValue('--r2-highlight-yellow').trim())).toBe('#f8e6a3');
  });
});

test.describe('real inline Markdown in opted-in Boox', () => {
  test.use({ userAgent: agents.android, viewport: { width: 760, height: 900 } });
  for (const fallback of [false, true]) test(`marks and ordinary links resist colourful host CSS (${fallback ? 'fallback' : 'native'})`, async ({ page }, info) => {
    await fixture(page, true);
    await page.addStyleTag({ content: 'body { --text-highlight-bg: #ff00ff; } body.theme-light { --background-primary: #fff; --text-normal: #242424; } body.theme-dark { --background-primary: #181818; --text-normal: #e5e5e5; }' });
    const before = await page.evaluate(async fallback => {
      const { controller, app, store } = window.reader;
      const article = await controller.repository.createArticle({ title: 'Native inline gray', url: '', extractor: 'manual',
        body: '==Marked words== stay readable.\n\n[[Target|Linked words]] remain ordinary links.' });
      await app.open(article.path); await document.fonts.ready;
      const root = document.querySelector<HTMLElement>('.r2-article-body')!, mark = root.querySelector('mark')!;
      const range = document.createRange(); range.selectNodeContents(mark);
      const items: ResolvedHighlight[] = [{ id: 'native-inline', range, colour: 'yellow' }];
      const modulePath = '/src/highlights/index.ts', { paintHighlights } = await import(modulePath);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL), nodes: Node[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      window.einkContrast = { root, items, nodes, html: root.innerHTML, weight: getComputedStyle(root).fontWeight,
        clear: paintHighlights(root, items, { forceFallback: fallback }) };
      return { path: article.path, raw: await store.read(article.path) };
    }, fallback);
    for (const theme of ['light', 'dark', 'light'] as const) {
      await page.evaluate(theme => { document.body.classList.remove('theme-light', 'theme-dark'); document.body.classList.add('theme-' + theme); }, theme);
      await settle(page); await settle(page);
      const [region] = await pixels(page, await page.screenshot({ scale: 'css' }), theme);
      expect(region.fill, 'real mark uses the grayscale fill, never host magenta').toBeGreaterThan(100);
      expect(region.ink).toBeGreaterThan(40); expect(region.bands).toHaveLength(1);
      const rgb = (values: number[]) => `rgb(${values.join(', ')})`;
      expect(await page.locator('.r2-article-body mark').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(rgb(palettes[theme].yellow));
      const link = page.getByRole('link', { name: 'Linked words', exact: true });
      expect(await link.evaluate(el => ({ ink: getComputedStyle(el).color, cue: getComputedStyle(el).textDecorationStyle,
        thickness: getComputedStyle(el).textDecorationThickness })))
        .toEqual({ ink: rgb(palettes[theme].ink), cue: 'double', thickness: '2px' });
      expect(await page.evaluate(() => {
        const { root, html, nodes, items } = window.einkContrast;
        return root.innerHTML === html && nodes.every(node => root.contains(node)) && items[0].range.toString() === 'Marked words';
      })).toBe(true);
      await expect(page.locator('.r2-article-body')).toHaveAttribute('data-highlight-count', '1');
      await info.attach(`inline-${theme}-${fallback ? 'fallback' : 'native'}`, { body: await page.screenshot({ scale: 'css' }), contentType: 'image/png' });
    }
    await page.evaluate(() => window.einkContrast.clear());
    await expect(page.locator('[data-reader-ui="highlight-overlay"], [data-reader-ui="highlight-styles"]')).toHaveCount(0);
    // Native syntax remains readable even when temporary painting is cleared.
    await expect(page.locator('.r2-article-body mark')).toHaveText('Marked words');
    expectOnlyReadingPositionChanged(before.raw, await page.evaluate(path => window.reader.store.read(path), before.path));
  });
});

for (const platform of ['desktop', 'ios', 'android'] as const) test.describe(`ordinary ${platform} colours`, () => {
  test.use({ userAgent: agents[platform] });
  test('keeps the existing palette outside opted-in Android pagination', async ({ page }) => {
    await fixture(page, platform !== 'android');
    await expect(page.locator('.r2-reader')).not.toHaveClass(/r2-eink/);
    expect(await page.locator('.r2-article-body').evaluate(el => {
      const style = getComputedStyle(el);
      return ['yellow', 'blue'].map(colour => style.getPropertyValue(`--r2-highlight-${colour}`).trim());
    })).toEqual(['#f8e6a3', '#c4e1f5']);
    await page.addStyleTag({ content: 'body { --text-highlight-bg: #ff00ff; }' });
    await page.evaluate(async () => {
      const { controller, app } = window.reader;
      const article = await controller.repository.createArticle({ title: 'Ordinary inline colour', url: '', extractor: 'manual', body: '==Marked words== and [[Target|Linked words]].' });
      await app.open(article.path);
    });
    expect(await page.locator('.r2-article-body mark').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 0, 255)');
    expect(await page.getByRole('link', { name: 'Linked words', exact: true }).evaluate(el => getComputedStyle(el).textDecorationStyle)).not.toBe('double');
  });
});
