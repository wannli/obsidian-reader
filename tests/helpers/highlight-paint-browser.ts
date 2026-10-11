import type { Page, TestInfo } from '@playwright/test';
import type { ResolvedHighlight } from '../../src/highlights/types';

export type Theme = 'light' | 'dark';

/** Expected policy for our Playwright fixtures, not a production detector.
 * iOS device descriptors carry a Safari UA even when Chromium runs the page.
 * Keep this independent of production policy/paint output so regressions fail.
 * A mobile viewport/touch setting alone does not imply the overlay policy.
 */
export function expectsOverlayPolicy(browserName: string, userAgent?: string): boolean {
  return browserName === 'webkit' || /iPhone|iPad|iPod/u.test(userAgent ?? '');
}

export const colours = {
  light: { yellow: [248, 230, 163], blue: [196, 225, 245], ink: [36, 36, 36], paper: [255, 255, 255] },
  dark: { yellow: [88, 67, 21], blue: [24, 63, 89], ink: [229, 229, 229], paper: [0, 0, 0] },
};
interface Region { id: string; colour: 'yellow' | 'blue'; x: number; y: number; width: number; height: number; lines: number }
interface Integrity { html: boolean; nodes: boolean; ranges: boolean; selection: boolean; mutations: number; nestedUI: number }
declare global {
  interface Window {
    highlightFixture: {
      root: HTMLElement; items: ResolvedHighlight[]; regions: () => Region[];
      integrity: () => Integrity; clear: () => void; repaint: () => void;
      hit: (x: number, y: number) => string[];
    };
  }
}

export async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function fixture(page: Page, forceFallback: boolean, theme: Theme, externalHost = false, opaque: 'none' | 'block' | 'mixed' | 'root' = 'none') {
  const body = `<article class="r2-article-body" id="source">
    <p data-colour="yellow" id="single-yellow">MMMM <${opaque === 'mixed' ? 'code' : 'em'}>serif</${opaque === 'mixed' ? 'code' : 'em'}> ink</p>
    <p data-colour="blue" id="single-blue">MMMM linked ink</p>
    <p data-colour="yellow" id="multi-yellow">MMMM serif ink with several words wrapping across multiple lines for measurement.</p>
    <p data-colour="blue" id="multi-blue">MMMM linked ink with several words wrapping across multiple lines for measurement.</p>
    <p id="selection">Unpainted native selection remains intact.</p>
  </article>`;
  const inside = externalHost ? `<section data-reader-highlight-scope><main class="r2-app">${body}</main></section>`
    : `<main class="r2-app"><section class="r2-reading-page">${body}</section></main>`;
  await page.route('**/__highlight-regression__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">
    <style id="highlight-fixture-css">
      body { margin: 20px; --background-primary: white; --text-normal: #242424; background: var(--background-primary); }
      body.theme-dark { --background-primary: black; --text-normal: #e5e5e5; }
      .r2-app { display: block; height: auto; overflow: visible; background: transparent;
        --r2-highlight-yellow: #ff00ff; --r2-highlight-blue: #00ff00; }
      #source { width: 280px; margin: 0; font: 18px/1.6 Georgia, serif; color: var(--text-normal);
        --r2-highlight-yellow: #f8e6a3; --r2-highlight-blue: #c4e1f5; }
      .theme-dark #source { --r2-highlight-yellow: #584315; --r2-highlight-blue: #183f59; }
      #source p { margin: 0 0 18px; }
      #source code { font: inherit; }
      ${opaque === 'block' ? '#multi-yellow { background-color: #171717; }' : opaque === 'mixed' ? '#single-yellow code { background-color: #171717; }' : opaque === 'root' ? '#source { background-color: #171717; }' : ''}
    </style><body class="theme-${theme}">${inside}</body>` }));
  await page.goto('/__highlight-regression__');
  await page.evaluate(async forceFallback => {
    const modulePath = '/src/highlights/index.ts';
    const { paintHighlights, clearHighlights, hitTestHighlights } = await import(modulePath);
    await document.fonts.ready;
    const root = document.querySelector<HTMLElement>('#source')!;
    const paragraphs = [...root.querySelectorAll<HTMLElement>('[data-colour]')];
    const items = paragraphs.map(p => { const range = document.createRange(); range.selectNodeContents(p);
      return { id: p.id, range, colour: p.dataset.colour as 'yellow' | 'blue' }; });
    const html = root.innerHTML, walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL), nodes: Node[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const boundaries = items.map(({ range }) => [range.startContainer, range.startOffset, range.endContainer, range.endOffset, range.toString()]);
    const selection = document.getSelection()!, selected = document.createRange(); selected.selectNodeContents(root.querySelector('#selection')!);
    selection.removeAllRanges(); selection.addRange(selected);
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    const repaint = () => paintHighlights(root, items, { forceFallback });
    window.highlightFixture = { root, items, repaint, clear: () => clearHighlights(root),
      hit: (x, y) => hitTestHighlights(root, items, x, y).map((item: ResolvedHighlight) => item.id),
      integrity: () => {
        const current = document.createTreeWalker(root, NodeFilter.SHOW_ALL), actual: Node[] = [];
        while (current.nextNode()) actual.push(current.currentNode);
        return { html: root.innerHTML === html, nodes: actual.length === nodes.length && actual.every((node, i) => node === nodes[i]),
          ranges: items.every(({ range }, i) => [range.startContainer, range.startOffset, range.endContainer, range.endOffset, range.toString()].every((v, j) => v === boundaries[i][j])),
          selection: selection.rangeCount === 1 && selection.getRangeAt(0).toString() === selected.toString() &&
            selection.getRangeAt(0).startContainer === selected.startContainer && selection.getRangeAt(0).endContainer === selected.endContainer,
          mutations: mutations + observer.takeRecords().length, nestedUI: root.querySelectorAll('[data-reader-ui]').length };
      },
      regions: () => paragraphs.map((p, i) => { const box = p.getBoundingClientRect();
        const tops = [...items[i].range.getClientRects()].filter(r => r.width > 0 && r.height > 0).map(r => Math.round(r.top));
        return { id: p.id, colour: items[i].colour, x: box.x, y: box.y, width: box.width, height: box.height, lines: new Set(tops).size }; }),
    };
    repaint();
  }, forceFallback);
  await settle(page);
}

export async function paintPixels(page: Page, theme: Theme, info?: TestInfo, label: string = theme) {
  await settle(page);
  const png = await page.screenshot({ scale: 'css' });
  if (info) await info.attach(label, { body: png, contentType: 'image/png' });
  return page.evaluate(async ({ encoded, palette }) => {
    const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const equal = (offset: number, colour: number[]) => colour.every((v, i) => Math.abs(pixels[offset + i] - v) <= 1);
    // Subpixel antialiasing on Linux can tint otherwise opaque foreground ink.
    // Keep the background check exact; a small tolerance for glyphs excludes
    // both the light-theme opaque #171717 block and dark-theme white paper.
    const foreground = (offset: number) => palette.ink.every((v, i) => Math.abs(pixels[offset + i] - v) <= 10);
    return window.highlightFixture.regions().map(region => {
      const bands: { top: number; bottom: number; height: number }[] = [];
      let band: (typeof bands)[number] | undefined, painted = 0, ink = 0;
      const inkRows = new Set<number>();
      const expected = palette[region.colour];
      for (let y = Math.floor(region.y); y < Math.ceil(region.y + region.height); y++) {
        let row = 0;
        for (let x = Math.ceil(region.x); x < Math.floor(region.x + region.width); x++) {
          const offset = (y * canvas.width + x) * 4;
          if (equal(offset, expected)) { row++; painted++; }
          if (foreground(offset)) { ink++; inkRows.add(y); }
        }
        // Several exact background pixels reject antialiasing and thin linked underlines.
        if (row >= 10) {
          if (!band) { band = { top: y, bottom: y + 1, height: 1 }; bands.push(band); }
          else { band.bottom = y + 1; band.height++; }
        } else band = undefined;
      }
      // Sparse letters on a short final line can leave one or two raster rows
      // without ten exact background pixels. Join those gaps, but never join
      // separate 28.8px text lines (whose paint bands remain at least 3px apart).
      const mergedBands: typeof bands = [];
      for (const part of bands) {
        const last = mergedBands.at(-1);
        if (last && part.top - last.bottom <= 2) {
          last.bottom = part.bottom;
          last.height = last.bottom - last.top;
        } else mergedBands.push({ ...part });
      }
      // A linked underline replaces the final background row; allow one raster pixel.
      const inkOutside = [...inkRows].filter(y => !mergedBands.some(band => y >= band.top - 1 && y < band.bottom + 1));
      return { ...region, painted, ink, inkRows: inkRows.size, bands: mergedBands, expected, inkOutside };
    });
  }, { encoded: png.toString('base64'), palette: colours[theme] });
}

export function contrast(a: number[], b: number[]) {
  const luminance = (rgb: number[]) => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + .05) / (values[0] + .05);
}
