import { test, expect, type Page } from '@playwright/test';
import { agents, expectNoPageBar, expectVisiblePosition, fixture, position, progress, settle, turnTo } from './helpers/eink-browser';

// Real Chromium geometry, synthetic BrowserStore only. A short line makes the
// predecessor visible within the 24px scroll-restoration inset on every host font.
test.use({ userAgent: agents.android, viewport: { width: 760, height: 900 } });
test('numbered-line reproduction preserves a restored marker instead of recapturing its predecessor', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const trackerPath = '/src/ui/scroll-position.ts', anchorPath = '/src/ui/eink-anchor.ts';
    const { trackScrollPosition } = await import(/* @vite-ignore */ trackerPath) as typeof import('../src/ui/scroll-position');
    const { captureReadingPosition, rangeForReadingPosition } = await import(/* @vite-ignore */ anchorPath) as typeof import('../src/ui/eink-anchor');
    const viewport = document.createElement('div'), body = document.createElement('div');
    viewport.style.cssText = 'all: initial; display: block; position: fixed; top: 0; left: 0; width: 360px; height: 220px; overflow: auto;';
    body.style.cssText = 'all: initial; display: block; white-space: pre; font: 16px/20px monospace;';
    body.textContent = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(2, '0')}`.padEnd(32, '.') + '\n').join('');
    viewport.append(body); document.body.append(viewport);
    const tracker = trackScrollPosition(viewport, body);
    try {
      const anchor = { marker: 'Line 42' };
      tracker.restorePosition(anchor);
      const immediate = tracker.getPosition();
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      viewport.dispatchEvent(new Event('scroll'));
      const restored = tracker.getPosition(), predecessor = captureReadingPosition(viewport, body);
      const rect = rangeForReadingPosition(body, restored)!.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
      return { anchor, immediate, restored, predecessor, visible: rect.width > 0 && rect.height > 0 &&
        rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.left >= bounds.left && rect.right <= bounds.right };
    } finally { tracker.dispose(); viewport.remove(); }
  });
  expect(result.predecessor.marker).not.toBe(result.anchor.marker);
  expect(result.immediate).toEqual(result.anchor); expect(result.restored).toEqual(result.anchor);
  expect(result.visible, 'the exact restored character remains on screen').toBe(true);
});

async function prepare(page: Page) {
  await fixture(page, true);
  await page.addStyleTag({ content: `
    .r2-article-body, .r2-article-body * { font-family: monospace !important; font-size: 16px !important; line-height: 24px !important; }
    .r2-article-body p, .r2-article-body h2 { margin: 0 !important; }
  ` });
  await settle(page); await turnTo(page, 5);
  return position(page);
}
async function toggle(page: Page, enabled: boolean) {
  await page.evaluate(enabled => window.reader.setEinkForDevice(enabled), enabled);
  await expectNoPageBar(page);
  if (enabled) await expect(page.locator('.r2-reader')).toHaveClass(/r2-eink/);
  else await expect(page.locator('.r2-reader')).not.toHaveClass(/r2-eink/);
}
async function firstVisible(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/ui/eink-anchor.ts';
    const { captureReadingPosition } = await import(/* @vite-ignore */ path) as typeof import('../src/ui/eink-anchor');
    return captureReadingPosition(document.querySelector('.r2-reader-scroll')!, document.querySelector('.r2-article-body')!);
  });
}
const hide = (page: Page) => page.locator('#app').evaluate(el => { el.style.display = 'none'; });
const show = (page: Page) => page.locator('#app').evaluate(el => { el.style.removeProperty('display'); });

for (const hidden of ['never', 'pending', 'restored'] as const) {
  test(`roundtrip retains exact anchor with a visible predecessor (hidden=${hidden})`, async ({ page }) => {
    const anchor = await prepare(page), before = await progress(page);
    if (hidden === 'pending') await hide(page);
    await toggle(page, false);
    if (hidden === 'pending') await show(page);
    await expectVisiblePosition(page, anchor); await settle(page);
    const predecessor = await firstVisible(page);
    expect(predecessor.marker).not.toBe(anchor.marker);
    await expectVisiblePosition(page, predecessor);
    // The delayed scroll notification caused by restoration must not recapture it.
    await page.locator('.r2-reader-scroll').dispatchEvent('scroll'); await settle(page);
    if (hidden === 'restored') await hide(page);
    await toggle(page, true);
    expect(await position(page)).toEqual(anchor);
    if (hidden === 'restored') await show(page);
    // Hidden remounts briefly show an unready counter until layout is measured.
    await expect(page.locator('.r2-reader')).toHaveAttribute('data-page', String(before.page));
    expect(await progress(page)).toEqual(before);
    await expectVisiblePosition(page, anchor);
  });
}

test('a real wheel scroll invalidates the restored anchor without repinning on layout notifications', async ({ page }) => {
  const anchor = await prepare(page);
  await toggle(page, false); await expectVisiblePosition(page, anchor); await settle(page);
  const viewport = page.locator('.r2-reader-scroll'), top = await viewport.evaluate(el => el.scrollTop);
  await viewport.hover(); await page.mouse.wheel(0, 360);
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(top);
  await settle(page); const moved = await firstVisible(page), after = await viewport.evaluate(el => el.scrollTop);
  expect(moved.marker).not.toBe(anchor.marker);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
    document.querySelector('.r2-article-body')!.dispatchEvent(new Event('load'));
  });
  await settle(page); expect(await viewport.evaluate(el => el.scrollTop)).toBe(after);
  await toggle(page, true); expect(await position(page)).toEqual(moved);
  await expectVisiblePosition(page, moved);
});

for (const notification of ['before', 'after'] as const) {
  test(`actual scrolling supersedes a restored anchor (${notification} scroll notification)`, async ({ page }) => {
    const anchor = await prepare(page);
    await toggle(page, false); await expectVisiblePosition(page, anchor); await settle(page);
    // Use scrollTop to exercise both a read before the browser delivers scroll and
    // a read after it. This is ordinary scrolling, not a new restore request.
    const moved = await page.evaluate(async notification => {
      const path = '/src/ui/eink-anchor.ts';
      const { captureReadingPosition } = await import(/* @vite-ignore */ path) as typeof import('../src/ui/eink-anchor');
      const viewport = document.querySelector<HTMLElement>('.r2-reader-scroll')!;
      viewport.scrollTop += 300;
      const expected = captureReadingPosition(viewport, document.querySelector('.r2-article-body')!);
      if (notification === 'before') window.reader.setEinkForDevice(true);
      return expected;
    }, notification);
    expect(moved.marker).not.toBe(anchor.marker);
    if (notification === 'after') {
      await settle(page); await hide(page); await toggle(page, true); await show(page);
    }
    await expectNoPageBar(page); await expect(page.locator('.r2-reader')).toHaveClass(/r2-eink/);
    expect(await position(page)).toEqual(moved);
    await expectVisiblePosition(page, moved);
  });
}
