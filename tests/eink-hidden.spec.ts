import { test, expect, type Page } from '@playwright/test';
import { agents, expectNoPageBar, expectUnchangedBody, expectVisiblePosition, fixture, position, progress, settle, turnTo, watchBody } from './helpers/eink-browser';

// Android UA simulation + synthetic BrowserStore only; no physical-device/vault claims.
test.use({ userAgent: agents.android, viewport: { width: 760, height: 900 } });
const hide = (page: Page) => page.locator('#app').evaluate(el => { el.style.display = 'none'; });
const show = (page: Page) => page.locator('#app').evaluate(el => { el.style.removeProperty('display'); });
async function toggle(page: Page, enabled: boolean) {
  await page.evaluate(enabled => window.reader.setEinkForDevice(enabled), enabled);
  await expectNoPageBar(page);
  if (enabled) await expect(page.locator('.r2-reader')).toHaveClass(/r2-eink/);
  else await expect(page.locator('.r2-reader')).not.toHaveClass(/r2-eink/);
  await settle(page);
}

for (const withoutResizeObserver of [false, true]) {
  test(`hidden eInk → scroll restores on reveal (ResizeObserver absent=${withoutResizeObserver})`, async ({ page }) => {
    const article = await fixture(page, true); await turnTo(page, 4); const anchor = await position(page);
    await hide(page);
    if (withoutResizeObserver) await page.evaluate(() => { Object.defineProperty(window, 'ResizeObserver', { value: undefined, configurable: true }); });
    await toggle(page, false); await watchBody(page);
    expect(await page.locator('.r2-reader-scroll').evaluate(el => el.clientHeight)).toBe(0);
    await show(page); await expectVisiblePosition(page, anchor);
    await expectUnchangedBody(page, article.path, article.body);
    // Completed restoration must not pin later ordinary scrolling, even after layout notifications.
    await page.locator('.r2-reader-scroll').evaluate(el => { el.scrollTop += 1000; }); await settle(page);
    const after = await page.locator('.r2-reader-scroll').evaluate(el => el.scrollTop);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#app')!.style.setProperty('--hidden-test', '1');
      document.querySelector('.r2-article-body')!.dispatchEvent(new Event('load'));
      window.dispatchEvent(new Event('resize'));
    });
    await settle(page);
    expect(await page.locator('.r2-reader-scroll').evaluate(el => el.scrollTop)).toBe(after);
  });
}

test('hidden eInk → scroll → eInk keeps the unresolved text anchor', async ({ page }) => {
  await fixture(page, true); await turnTo(page, 4); const anchor = await position(page);
  await hide(page); await toggle(page, false); await toggle(page, true);
  expect(await position(page)).toEqual(anchor);
  await show(page); await expectVisiblePosition(page, anchor);
  expect((await progress(page)).page).toBe(4);
});

for (const toggleBack of [false, true]) {
  test(`hidden scroll → eInk${toggleBack ? ' → scroll' : ''} uses the last visible text position`, async ({ page }) => {
    await fixture(page, false);
    await page.locator('.r2-reader-scroll').evaluate(el => { el.scrollTop = 2400; }); await settle(page);
    const anchor = await page.evaluate(async () => {
      const path = '/src/ui/eink-anchor.ts';
      const { captureReadingPosition } = await import(/* @vite-ignore */ path) as typeof import('../src/ui/eink-anchor');
      return captureReadingPosition(document.querySelector('.r2-reader-scroll')!, document.querySelector('.r2-article-body')!);
    });
    expect(anchor.marker).not.toBe('');
    await hide(page); await toggle(page, true); expect(await position(page)).toEqual(anchor);
    if (toggleBack) await toggle(page, false);
    await show(page); await expectVisiblePosition(page, anchor);
    if (!toggleBack) expect((await progress(page)).page).toBeGreaterThan(1);
  });
}

test('visibility-only reveal retries a pending ordinary anchor', async ({ page }) => {
  await fixture(page, true); await turnTo(page, 4); const anchor = await position(page);
  await page.locator('#app').evaluate(el => { el.style.visibility = 'hidden'; });
  await toggle(page, false);
  expect(await page.locator('.r2-reader-scroll').evaluate(el => el.scrollTop)).toBe(0);
  await page.locator('#app').evaluate(el => { el.style.removeProperty('visibility'); });
  await expectVisiblePosition(page, anchor);
});

test('pending restoration retries when body rendering provides range geometry', async ({ page }) => {
  await fixture(page, true); await turnTo(page, 4); const anchor = await position(page);
  await hide(page); await toggle(page, false);
  await page.locator('.r2-article-body').evaluate(el => { (el as HTMLElement).style.display = 'none'; });
  await show(page); await settle(page);
  expect(await page.locator('.r2-reader-scroll').evaluate(el => el.scrollTop)).toBe(0);
  await page.locator('.r2-article-body').evaluate(el => { (el as HTMLElement).style.removeProperty('display'); });
  await expectVisiblePosition(page, anchor);
});

test('ReaderMount disposal disconnects pending observers and removes its scroll listener', async ({ page }) => {
  await fixture(page, true); await turnTo(page, 4); await hide(page);
  await page.evaluate(() => {
    const records: { observer: ResizeObserver | MutationObserver; target: Element; stopped: boolean }[] = [];
    const listeners: { target: EventTarget; listener: unknown; removed: boolean }[] = [];
    const ro = ResizeObserver.prototype.observe, rd = ResizeObserver.prototype.disconnect;
    ResizeObserver.prototype.observe = function (target, options) {
      if (target.matches('.r2-reader-scroll')) records.push({ observer: this, target, stopped: false });
      ro.call(this, target, options);
    };
    ResizeObserver.prototype.disconnect = function () {
      records.filter(r => r.observer === this).forEach(r => { r.stopped = true; }); rd.call(this);
    };
    const mo = MutationObserver.prototype.observe, md = MutationObserver.prototype.disconnect;
    MutationObserver.prototype.observe = function (target, options) {
      if (target instanceof Element && target.matches('.r2-reader-scroll')) records.push({ observer: this, target, stopped: false });
      mo.call(this, target, options);
    };
    MutationObserver.prototype.disconnect = function () {
      records.filter(r => r.observer === this).forEach(r => { r.stopped = true; }); md.call(this);
    };
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === 'scroll' && this instanceof Element && this.matches('.r2-reader-scroll')) listeners.push({ target: this, listener, removed: false });
      add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      if (type === 'scroll') listeners.filter(r => r.target === this && r.listener === listener).forEach(r => { r.removed = true; });
      remove.call(this, type, listener, options);
    };
    Object.assign(window, { hiddenProbe: () => {
      const old = records.filter(r => !r.target.isConnected), oldListeners = listeners.filter(r => !(r.target as Element).isConnected);
      // ReaderApp also adds an anonymous state listener; only the mount-owned tracker is removed here.
      return { observers: old.length, stopped: old.every(r => r.stopped), listeners: oldListeners.length, removed: oldListeners.filter(r => r.removed).length };
    } });
  });
  await toggle(page, false); await toggle(page, true); await show(page); await settle(page);
  const result = await page.evaluate(() => (window as unknown as { hiddenProbe(): { observers: number; stopped: boolean; listeners: number; removed: number } }).hiddenProbe());
  expect(result.observers).toBeGreaterThanOrEqual(2); expect(result.stopped).toBe(true);
  expect(result.listeners).toBeGreaterThanOrEqual(1); expect(result.removed).toBe(2); // Scroll anchor tracking and debounced persistence.
});
