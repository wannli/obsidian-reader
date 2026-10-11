import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { clickNativeMenu } from './runtime-actions.mjs';
import { focusNativeWindow, waitNativeMenu } from './runtime-menu.mjs';
import { articlesForURL, captureByUI } from './runtime-capture.mjs';
import { startRuntimeFixture } from './runtime-fixture.mjs';
import { assertNoRepeatedWrites, setDummyMode } from './runtime-modes.mjs';
import { assertSettledUnchanged, readSettledMarkdown, runtimeArticle } from './runtime-storage.mjs';
import { openArticle } from './runtime-ui.mjs';

async function saveBodyLink(page, url) {
  await focusNativeWindow(page);
  const link = page.locator('.workspace-leaf.mod-active .r2-article-body').getByRole('link', { name: 'A related article', exact: true });
  await link.scrollIntoViewIfNeeded();
  const before = { title: await page.locator('.workspace-leaf.mod-active .r2-article-title').innerText(), scrollTop: await page.locator('.workspace-leaf.mod-active .r2-reader-scroll').evaluate(element => element.scrollTop),
    url: page.url(), pages: page.context().pages().length };
  await assertRuntimeVault(page); await link.click();
  const menu = page.locator('.menu:visible').filter({ has: page.locator('.menu-item-title').filter({ hasText: /^Save as article$/ }) });
  await waitNativeMenu(page, menu, 'Save as article'); await clickNativeMenu(page, menu, 'Save as article');
  await expect(menu).toBeHidden();
  await expect.poll(async () => (await articlesForURL(page, url)).length).toBe(1);
  const after = { title: await page.locator('.workspace-leaf.mod-active .r2-article-title').innerText(), scrollTop: await page.locator('.workspace-leaf.mod-active .r2-reader-scroll').evaluate(element => element.scrollTop),
    url: page.url(), pages: page.context().pages().length };
  assert.deepEqual(after, before, 'Save as article navigated away or moved the current reader');
  return { article: (await articlesForURL(page, url))[0], position: before };
}

export async function verifyLiveCapture(page, network, fixtures) {
  await network.setOffline(false); await setDummyMode(page, false);
  const related = await startRuntimeFixture(); fixtures.push(related);
  const fixture = await startRuntimeFixture({ gateArticle: true, relatedURL: related.articleURL }); fixtures.push(fixture);
  const captured = await captureByUI(page, fixture.articleURL);
  assert.equal(captured.extractor, 'pending'); assert.equal(captured.body.trim(), '');
  assert.ok(fixture.evidence().requests.every(request => !request.responseAt), 'Capture returned only after article extraction');
  await expect.poll(() => fixture.evidence().pendingArticleResponses, { timeout: 20_000 }).toBe(1);
  const closedBeforeResponse = Date.now(); fixture.releaseArticle();
  await expect.poll(async () => (await runtimeArticle(page, captured.path)).extractor, { timeout: 25_000 }).toBe('defuddle');
  const ready = await runtimeArticle(page, captured.path);
  await openArticle(page, ready.title);
  await network.setOffline(true);
  const saved = await saveBodyLink(page, related.articleURL);
  assert.equal(saved.article.extractor, 'pending'); assert.equal(saved.article.body.trim(), '');
  assert.equal(related.evidence().requests.length, 0, 'Offline Save as article fetched HTML');
  const beforeDuplicate = await readSettledMarkdown(page, saved.article.path);
  const duplicate = await saveBodyLink(page, related.articleURL);
  assert.equal(duplicate.article.path, saved.article.path); assert.equal(duplicate.article.id, saved.article.id);
  await assertSettledUnchanged(page, saved.article.path, beforeDuplicate);
  await network.setOffline(false);
  await expect.poll(async () => (await runtimeArticle(page, saved.article.path)).extractor, { timeout: 20_000 }).toBe('defuddle');
  const unstable = await startRuntimeFixture({ articleStatus: 503 }); fixtures.push(unstable);
  const failed = await captureByUI(page, unstable.articleURL);
  await expect.poll(async () => (await runtimeArticle(page, failed.path)).content, { timeout: 20_000 }).toBe('error');
  const errored = await runtimeArticle(page, failed.path);
  assert.equal(await page.evaluate(() => navigator.onLine), true, 'This must be a transport failure while the renderer is online');
  assert.ok(errored.retryAfter && Number.isFinite(Date.parse(errored.retryAfter)), 'Failed capture lost its persisted retry metadata');
  assert.ok(errored.error);
  await network.setOffline(true); unstable.setArticleStatus(200); await network.setOffline(false);
  await expect.poll(async () => (await runtimeArticle(page, failed.path)).extractor, { timeout: 20_000 }).toBe('defuddle');
  const recovered = await runtimeArticle(page, failed.path);
  assert.equal(recovered.error, undefined); assert.equal(recovered.retryAfter, undefined);
  const stable = await assertNoRepeatedWrites(page, [captured.path, saved.article.path, failed.path]);
  return { nonblocking: { path: captured.path, captureReturnedBeforeGatedResponse: true, closedBeforeResponse },
    linkCapture: { path: saved.article.path, position: saved.position, offlineStub: true, duplicateReuse: true, reconnectAcquired: true },
    transportFailure: { path: failed.path, navigatorOnline: true, retryAfter: errored.retryAfter, error: errored.error, automaticallyRecovered: true, clearedErrorAndRetry: true }, stable };
}
