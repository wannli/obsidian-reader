import { test, expect } from '@playwright/test';
import { expectOnlyReadingPositionChanged } from './helpers/reading-position-note';
import { agents, fixture, turnTo, position, expectVisiblePosition, watchBody, expectUnchangedBody } from './helpers/eink-browser';

declare global { interface Window { readingDrain: { started: boolean; done: boolean; release(): void; finished: Promise<void> } } }
test.use({ viewport: { width: 760, height: 900 }, userAgent: agents.android });
for (const eink of [false, true]) test(`${eink ? 'e-ink' : 'scroll'} drains a delayed save after adjacent empty queue then immediate destroy`, async ({ page }) => {
  const article = await fixture(page, eink);
  await page.evaluate(async () => {
    const { app, controller } = window.reader; await app.flushPosition();
    for (const item of await controller.repository.listArticles()) if (item.status === 'feed') await controller.repository.setStatus(item.path, 'inbox');
    const original = controller.repository.saveReadingPositionRevision.bind(controller.repository);
    let release!: () => void; const hold = new Promise<void>(done => { release = done; });
    window.readingDrain = { started: false, done: false, release, finished: Promise.resolve() };
    controller.repository.saveReadingPositionRevision = async (...args) => { window.readingDrain.started = true; await hold; return original(...args); };
  });
  if (eink) await turnTo(page, 4); else await page.locator('.r2-reader-scroll').evaluate(el => { el.scrollTop = 2400; });
  const wanted = await position(page); expect(wanted.marker).not.toBe('');
  await page.evaluate(() => {
    const navigation = window.reader.app.navigateQueue(1);
    window.readingDrain.finished = Promise.all([navigation, window.reader.app.destroy()]).then(() => { window.readingDrain.done = true; });
  });
  await expect.poll(() => page.evaluate(() => window.readingDrain.started)).toBe(true);
  expect(await page.evaluate(() => window.readingDrain.done)).toBe(false);
  await page.evaluate(async () => { window.readingDrain.release(); await window.readingDrain.finished; });
  expect(await page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).readingPosition, article.path)).toEqual(wanted);
  expectOnlyReadingPositionChanged(article.raw, await page.evaluate(async path => window.reader.store.read(path), article.path));
});
for (const eink of [false, true]) test(`${eink ? 'e-ink' : 'scroll'} persists on idle, navigation and browser restart with only reading_position frontmatter changes`, async ({ page }) => {
  const article = await fixture(page, eink);
  await watchBody(page);
  if (eink) await turnTo(page, 4);
  else await page.locator('.r2-reader-scroll').evaluate(el => { el.scrollTop = 2400; });
  await expect.poll(() => page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).readingPosition?.marker ?? '', article.path)).not.toBe('');
  const saved = await page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).readingPosition!, article.path);
  expect(saved.marker.trim().split(/\s+/)).toHaveLength(5);
  await expectUnchangedBody(page, article.path, article.body);
  if (eink) await turnTo(page, 6);
  else await page.locator('.r2-reader-scroll').evaluate(el => { el.scrollTop = 4200; });
  // Navigate immediately, before the debounce: disposal must flush the newest anchor.
  await page.evaluate(async path => { await window.reader.app.open(path); }, article.other);
  await expect.poll(() => page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).readingPosition?.marker ?? '', article.path)).not.toBe(saved.marker);
  const latest = await page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).readingPosition!, article.path);
  await page.evaluate(async path => { await window.reader.app.open(path); }, article.path);
  await expectVisiblePosition(page, latest);
  if (eink) expect(await position(page)).toEqual(latest);
  await page.reload(); await expect(page.locator('.r2-article-body')).toBeVisible();
  await page.evaluate(async path => { window.reader.controller.setActive(false); await window.reader.app.open(path); }, article.path);
  await expectVisiblePosition(page, latest);
  if (eink) expect(await position(page)).toEqual(latest);
  else expect(await page.locator('.r2-reader-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0); // First occurrence may be earlier than the original pixel offset.
  // Reopening alone must not rewrite/recede the anchor after the debounce.
  await page.waitForTimeout(750);
  expect(await page.evaluate(async path => (await window.reader.controller.repository.getArticle(path)).readingPosition, article.path)).toEqual(latest);
  expectOnlyReadingPositionChanged(article.raw, await page.evaluate(async path => window.reader.store.read(path), article.path));
  await page.evaluate(async () => { await window.reader.app.move('archive'); });
  const moved = await page.evaluate(async () => (await window.reader.controller.repository.listArticles()).find(a => a.body.includes('Passage 32'))!);
  expect(moved.status).toBe('archive'); expect(moved.readingPosition?.marker).not.toBe('');
  await page.evaluate(async path => { await window.reader.app.open(path); }, moved.path);
  await expectVisiblePosition(page, moved.readingPosition!);
});

for (const legacyPixelsOnly of [false, true]) test(`ordinary native workspace restore prefers ${legacyPixelsOnly ? 'YAML anchor over legacy pixels' : 'serialized text anchor'} after reflow`, async ({ page }) => {
  await fixture(page, false);
  await page.locator('.r2-reader-scroll').evaluate(el => { el.scrollTop = 4200; });
  const state = await page.evaluate(async () => {
    const state = window.reader.app.getState();
    await window.reader.app.destroy(); // New instance has no per-session position cache.
    return state;
  });
  expect(state.readingPosition?.marker).not.toBe('');
  expect(state.scrollTop).toBeGreaterThan(3000);
  await page.setViewportSize({ width: 510, height: 720 });
  await page.addStyleTag({ content: '.r2-article-body { font-size: 25px !important; line-height: 1.8 !important; }' });
  await page.evaluate(async ({ state, legacyPixelsOnly }) => {
    const modulePath = '/src/ui/app.ts', { ReaderApp } = await import(modulePath);
    const restored = new ReaderApp(document.querySelector('#app')!, window.reader.controller, {
      autoOpen: false, shouldFocus: () => true, openNote: () => {},
    });
    window.reader.app = restored;
    const options = { ...state };
    if (legacyPixelsOnly) delete options.readingPosition;
    await restored.open(state.file!, options);
  }, { state, legacyPixelsOnly });
  await expectVisiblePosition(page, state.readingPosition!);
  expect(await page.evaluate(() => window.reader.app.getState().readingPosition)).toEqual(state.readingPosition);
  const restoredPixels = await page.locator('.r2-reader-scroll').evaluate(el => el.scrollTop);
  expect(Math.abs(restoredPixels - state.scrollTop!)).toBeGreaterThan(500);
});
