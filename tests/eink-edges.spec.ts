import { test, expect, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import type { EinkPagination } from '../src/ui/eink-types';

declare global {
  interface Window {
    edgeEngine: typeof import('../src/ui/eink-pagination') & typeof import('../src/ui/eink-anchor');
    edgePagination: EinkPagination;
  }
}
const root = new URL('..', import.meta.url).pathname;
const bundle = buildSync({ stdin: { contents: `export * from './src/ui/eink-pagination'; export * from './src/ui/eink-anchor';`, resolveDir: root }, bundle: true, write: false, format: 'iife', globalName: 'edgeEngine' }).outputFiles[0]!.text;
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
// Keep every five-word window distinguishable so a short persisted marker can
// resolve the same passage after a direction or viewport change.
const passage = Array.from({ length: 8 }, (_, i) => `<p>Section ${i}: ${Array.from({ length: 7 }, (_, j) =>
  `Readable text نص ${i}-${j} عربي واضح ${i}-${j} with mixed ${i}-${j} directions. `).join('')}</p>`).join('');
async function mount(page: Page, html: string, direction: string) {
  await page.setViewportSize({ width: 400, height: 520 });
  // Match the app viewport: mobile's legacy 980px layout otherwise defeats narrow-page cases.
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>html,body{margin:0;height:100%}.r2-app{height:100vh}</style><div class="r2-app" dir="${direction}"><div class="r2-reader r2-eink"><div class="r2-reader-scroll"><article class="r2-reading-page"><div class="r2-article-body">${html}</div></article></div></div>`);
  await page.addStyleTag({ content: styles });
  expect(await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.clientHeight])).toEqual([400, 520]);
  await page.addScriptTag({ content: bundle });
  expect(await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.r2-article-body')!, html = body.innerHTML, nodes = [...body.childNodes];
    window.edgePagination = window.edgeEngine.createEinkPagination(document.querySelector('.r2-reader-scroll')!, document.querySelector('article')!, body);
    return body.innerHTML === html && nodes.every(node => body.contains(node));
  })).toBe(true);
}
/** Inspect real one-character ranges on every displayed page, not element/column unions. */
async function reachable(page: Page) {
  const result = await page.evaluate(() => {
    const p = window.edgePagination, body = document.querySelector<HTMLElement>('.r2-article-body')!;
    const viewport = document.querySelector<HTMLElement>('.r2-reader-scroll')!, original = body.innerHTML;
    const nodes: Text[] = [], ranges: Range[] = [], walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      nodes.push(node);
      for (let i = 0; i < node.length; i++) {
        if (/\s/.test(node.data[i]!)) continue; // Collapsed whitespace is not a painted glyph.
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1); ranges.push(range);
      }
    }
    const box = viewport.getBoundingClientRect(), seen = new Set<number>(), ink: number[] = [], markers: string[] = [];
    const visible = (range: Range) => [...range.getClientRects()].some(r => r.width > 0 && r.height > 0 &&
      r.left >= box.left - .5 && r.right <= box.right + .5 && r.top >= box.top && r.bottom <= box.bottom);
    p.turn(-9999);
    do {
      let count = 0;
      ranges.forEach((range, i) => { if (visible(range)) { seen.add(i); count++; } });
      ink.push(count); markers.push(p.getPosition().marker);
      if (ink.length > 100) throw new Error('Unbounded pagination');
    } while (p.turn(1));
    return { missing: ranges.flatMap((range, i) => seen.has(i) ? [] : [`${i}:${range.toString()}`]).slice(0, 20),
      ink, markers, total: p.progress().total, last: p.progress().page, forward: p.turn(1),
      backward: p.turn(-9999), first: p.progress().page, beforeFirst: p.turn(-1),
      unchanged: body.innerHTML === original && nodes.every(node => body.contains(node)), scroll: [viewport.scrollLeft, viewport.scrollTop] };
  });
  expect(result.missing).toEqual([]); expect(result.ink.every(count => count > 0)).toBe(true);
  expect(result.ink).toHaveLength(result.total); expect(result.last).toBe(result.total);
  expect(result.markers[0]).toBe(''); expect(result.markers.slice(1).every(marker => marker.trim().split(/\s+/).length <= 5)).toBe(true);
  expect(result.forward).toBe(false); expect(result.backward).toBe(result.total > 1);
  expect(result.first).toBe(1); expect(result.beforeFirst).toBe(false);
  expect(result.unchanged).toBe(true); expect(result.scroll).toEqual([0, 0]);
  return result.total;
}
for (const direction of ['ltr', 'rtl']) {
  test(`${direction}: every body character is reachable and deep ranges reveal from a translated page`, async ({ page }) => {
    await mount(page, passage, direction);
    expect(await reachable(page)).toBeGreaterThan(3);
    expect(await page.evaluate(() => {
      const p = window.edgePagination; p.turn(2);
      const node = document.querySelector('.r2-article-body')!.lastChild!.firstChild!;
      const range = document.createRange(); range.setStart(node, 90); range.setEnd(node, 91);
      const revealed = p.reveal(range), r = range.getBoundingClientRect(), v = document.querySelector('.r2-reader-scroll')!.getBoundingClientRect();
      return revealed && r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom;
    })).toBe(true);
    expect(await page.locator('article').evaluate(el => getComputedStyle(el).direction)).toBe(direction);
  });
  for (const kind of ['col-attributes', 'col-inline', 'all-widths']) {
    test(`${direction}: readable native table with ${kind}, every cell character reachable`, async ({ page }) => {
      const sizing = 'width="1600" min-width="1600" style="width:1600px;min-width:1600px;inline-size:1600px;min-inline-size:1600px;white-space:nowrap"';
      const cols = kind === 'col-attributes' ? '<col width="1600"><col width="1600">' : `<col ${sizing}><col ${sizing}>`;
      const cells = kind === 'all-widths' ? sizing : '';
      const rows = kind === 'col-attributes' ? '<tr><td>First column text</td><td>SECOND_COLUMN_UNREACHABLE</td></tr>' :
        `<tr><th scope="col" ${cells}>First heading</th><th scope="col" ${cells}>Second heading</th></tr>` +
        Array.from({ length: 8 }, (_, i) => `<tr><td ${cells}>Row ${i}: ${'Readable data نص عربي '.repeat(3)}</td><td ${cells}>SECOND_COLUMN_${i} ${'unbroken_identifier_'.repeat(3)}</td></tr>`).join('');
      await mount(page, `<table ${kind === 'all-widths' ? sizing : ''}><colgroup ${kind === 'all-widths' ? sizing : ''}>${cols}</colgroup><tbody>${rows}</tbody></table>`, direction);
      await expect(page.getByRole('table')).toHaveCount(1);
      const total = await reachable(page);
      if (kind === 'col-attributes') expect(total).toBe(1); else expect(total).toBeGreaterThan(1);
      expect(await page.evaluate(() => {
        const body = document.querySelector('.r2-article-body')!, article = document.querySelector('article')!;
        return [...body.querySelectorAll('table,th,td')].every(el =>
          [...el.getClientRects()].every(r => r.width <= article.clientWidth + 1) && getComputedStyle(el).fontSize === getComputedStyle(body).fontSize);
      })).toBe(true);
    });
  }
}
async function expectVisibleSavedMarker(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const pagination = window.edgePagination, body = document.querySelector<HTMLElement>('.r2-article-body')!;
    const marker = pagination.getPosition(), range = window.edgeEngine.rangeForReadingPosition(body, marker);
    if (pagination.progress().page < 2 || !marker.marker || !range) return false;
    const rect = range.getBoundingClientRect(), viewport = document.querySelector('.r2-reader-scroll')!.getBoundingClientRect();
    return rect.width > 0 && rect.left >= viewport.left && rect.right <= viewport.right;
  })).toBe(true);
}
test('direction-only inline style updates invalidate the layout signature; document body dir is observed', async ({ page }) => {
  await mount(page, passage, 'ltr');
  await page.evaluate(() => document.querySelector('.r2-app')!.removeAttribute('dir'));
  await page.waitForTimeout(100); // Finish initial font/observer work before direction-only mutation.
  const position = await page.evaluate(() => { window.edgePagination.turn(3); return window.edgePagination.getPosition(); });
  await expectVisibleSavedMarker(page);
  await page.locator('article').evaluate(el => { el.style.direction = 'rtl'; });
  await expect.poll(() => page.locator('article').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.edgePagination.getPosition())).toEqual(position);
  await reachable(page);
  await page.evaluate(() => { document.querySelector('article')!.style.removeProperty('direction'); document.body.dir = 'rtl'; window.edgePagination.restore({ marker: 'Section 6: Readable text نص' }); });
  await page.waitForTimeout(100);
  await page.evaluate(() => { document.body.dir = 'ltr'; });
  await expect.poll(() => page.locator('article').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)).toBeLessThan(0);
  expect(await page.evaluate(() => window.edgePagination.getPosition().marker)).toBe('Section 6: Readable text نص');
  await reachable(page);
});
test('ancestor/page dir changes and resize retain the exact canonical character without explicit refresh', async ({ page }) => {
  await mount(page, passage, 'ltr');
  const position = await page.evaluate(() => { window.edgePagination.turn(3); return window.edgePagination.getPosition(); });
  await expectVisibleSavedMarker(page);
  for (const [target, direction, width] of [['.r2-app', 'rtl', '400px'], ['article', 'ltr', '340px'], ['article', 'rtl', '460px'], ['.r2-app', 'ltr', '400px']]) {
    await page.evaluate(({ target, direction, width }) => {
      if (target === '.r2-app') document.querySelector('article')!.removeAttribute('dir');
      document.querySelector(target!)!.setAttribute('dir', direction!);
      document.querySelector<HTMLElement>('.r2-app')!.style.width = width!;
    }, { target, direction, width });
    await expect.poll(() => page.evaluate(() => {
      const p = window.edgePagination, body = document.querySelector<HTMLElement>('.r2-article-body')!;
      const range = window.edgeEngine.rangeForReadingPosition(body, p.getPosition())!;
      const r = range.getBoundingClientRect(), v = document.querySelector('.r2-reader-scroll')!.getBoundingClientRect();
      return r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom;
    })).toBe(true);
    expect(await page.evaluate(() => window.edgePagination.getPosition())).toEqual(position);
    const expectedSign = direction === 'rtl' ? 1 : -1;
    expect(await page.locator('article').evaluate(el => Math.sign(new DOMMatrix(getComputedStyle(el).transform).m41))).toBe(expectedSign);
  }
  await reachable(page);
});
