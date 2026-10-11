import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { pluginId, vaultPath } from './sandbox.mjs';
import { parseMarkdown, readMarkdown, runtimeArticle } from './runtime-storage.mjs';
import { openArticle } from './runtime-ui.mjs';
import { closeLibrary } from './runtime-library.mjs';
import { nativeReaderCommand } from './runtime-native.mjs';
import { sha256 } from './artifacts.mjs';
import { assertControlledAcquisition } from './runtime-scope.mjs';

async function library(page) {
  await assertRuntimeVault(page);
  return page.evaluate(id => Promise.all([app.plugins.plugins[id].controller.repository.listArticles(), app.plugins.plugins[id].controller.repository.listFeeds()]), pluginId);
}
async function subscriptions(page) {
  await closeLibrary(page); await expect(page.locator('.modal-container')).toHaveCount(0);
  await nativeReaderCommand(page, 'rss-feeds');
  const panel = page.locator('.modal-container').filter({ has: page.locator('.modal-title').filter({ hasText: /^RSS feeds$/ }) });
  await expect(panel).toBeVisible(); return panel;
}
const feedRow = (page, panel, title) => panel.locator('.setting-item').filter({ has: page.locator('.setting-item-name').filter({ hasText: new RegExp('^' + title + '$') }) });
async function closeFeeds(page, panel) { await assertRuntimeVault(page); await page.keyboard.press('Escape'); await expect(panel).toBeHidden(); }

async function views(page) {
  await assertRuntimeVault(page);
  return page.evaluate(() => {
    const result = []; app.workspace.iterateAllLeaves(leaf => {
      result.push({ id: leaf.id, type: leaf.view.getViewType(), file: leaf.getViewState().state?.file });
    }); return result;
  });
}
async function releaseNonemptySummary(page, fixture, path, initialViews) {
  await expect.poll(() => fixture.evidence().pendingArticleResponses, { timeout: 20_000 }).toBe(1);
  const article = await runtimeArticle(page, path), markdown = await readMarkdown(path);
  assert.ok(fixture.feedExcerpt.length > 0); assert.equal(article.body.trim(), fixture.feedExcerpt);
  assert.equal(article.extractor, 'summary'); assert.equal(article.content, 'partial');
  assert.ok(markdown.includes(fixture.feedExcerpt)); assert.ok(!markdown.includes(fixture.quote));
  const beforeViews = await views(page); assert.deepEqual(beforeViews, initialViews);
  assert.ok(beforeViews.every(view => view.file !== path), 'Summary fixture was opened before background acquisition');
  const requests = fixture.evidence().requests.filter(request => request.path === fixture.articlePath);
  assert.equal(requests.length, 1); assert.equal(requests[0].responseAt, undefined);
  const proof = { articlePath: path, before: { extractor: article.extractor, content: article.content,
    body: article.body, metadataSummary: parseMarkdown(markdown).metadata.summary ?? null, markdownSha256: sha256(markdown) },
    viewsBeforeResponse: beforeViews, observedBeforeResponseAt: new Date().toISOString(), articleRequestAlreadyInFlight: true };
  fixture.releaseArticle(); return proof;
}

export async function ingestFixture(page, fixture, mode = 'live') {
  await assertControlledAcquisition(page, mode !== 'dummy');
  const initialViews = await views(page), [, existingFeeds] = await library(page);
  assert.ok(existingFeeds.every(feed => !feed.enabled), 'Disable unrelated test-vault feeds manually before the controlled ingestion run');
  const transport = await page.evaluate(id => String(app.plugins.plugins[id].controller.get), pluginId);
  assert.match(transport, /requestUrl/, 'Must use production Obsidian requestUrl, not a test HttpGet');
  const panel = await subscriptions(page);
  await panel.getByRole('button', { name: 'Add feed', exact: true }).click();
  const subscribe = page.locator('.modal-container').filter({ has: page.locator('.modal-title').filter({ hasText: /^Add feed$/ }) });
  await expect(subscribe).toBeVisible(); await subscribe.getByRole('textbox', { name: 'URL', exact: true }).fill(fixture.feedURL);
  await assertRuntimeVault(page); await subscribe.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(subscribe).toBeHidden();
  await expect(feedRow(page, panel, fixture.feedTitle).locator('.checkbox-container')).toHaveClass(/is-enabled/);
  const [articles, feeds] = await library(page), matches = articles.filter(article => article.url === fixture.articleURL);
  assert.equal(matches.length, 1, 'RSS must import exactly one article');
  const pending = matches[0], feed = feeds.find(feed => feed.url === fixture.feedURL);
  assert.ok(feed); assert.equal(pending.status, 'feed'); assert.equal(parseMarkdown(await readMarkdown(feed.path)).metadata.type, 'feed');
  assert.ok(feed.path.startsWith('Reading/Wires/'));
  assert.match(pending.path, /^Reading\/Stream\/\d{6} /);
  const importedMetadata = parseMarkdown(await readMarkdown(pending.path)).metadata;
  assert.equal(Object.hasOwn(importedMetadata, 'status'), false);
  // This RSS fixture deliberately supplies no date: a dated filename must not invent published.
  assert.equal(Object.hasOwn(importedMetadata, 'published'), false);
  await assertRuntimeVault(page); await panel.getByRole('button', { name: 'Refresh feeds', exact: true }).click();
  await expect.poll(() => fixture.evidence().requests.filter(request => request.path.endsWith('/feed.xml')).length).toBeGreaterThan(1);
  await closeFeeds(page, panel);
  assert.equal((await library(page))[0].filter(article => article.url === fixture.articleURL).length, 1);
  const summaryPipeline = mode !== 'dummy' && !fixture.evidence().gateOpen
    ? await releaseNonemptySummary(page, fixture, pending.path, initialViews) : undefined;
  // RSS descriptions are genuine excerpts. Dummy mode MUST preserve them.
  const expectedExtractor = mode === 'dummy' ? 'summary' : 'defuddle';
  await expect.poll(async () => (await runtimeArticle(page, pending.path)).extractor, { timeout: 20_000 }).toBe(expectedExtractor);
  const article = await runtimeArticle(page, pending.path);
  assert.equal(article.content, mode === 'dummy' ? 'partial' : 'ready', article.error); assert.equal(article.title, article.path.split('/').at(-1).replace(/\.md$/, ''));
  if (mode === 'dummy') assert.equal(article.body.trim(), fixture.feedExcerpt);
  else { assert.ok(article.body.includes(fixture.quote)); assert.ok(article.body.includes('This final paragraph provides enough continuous prose')); }
  if (summaryPipeline) {
    const markdown = await readMarkdown(article.path); assert.ok(markdown.includes(fixture.quote));
    assert.deepEqual(await views(page), initialViews); assert.equal(article.error, undefined); assert.equal(article.retryAfter, undefined);
    summaryPipeline.after = { extractor: article.extractor, content: article.content, bodyLength: article.body.length,
      markdownSha256: sha256(markdown), observedDurableAt: new Date().toISOString() };
    summaryPipeline.backgroundFilledNonemptySummaryWithoutOpening = true;
  }
  await openArticle(page, article.title, 'feed');
  await expect(page.locator('.workspace-leaf.mod-active .r2-article-body')).toContainText(mode === 'dummy' ? fixture.feedExcerpt : fixture.quote);
  assert.ok(!article.body.includes('<script'));
  assert.equal(await page.evaluate(() => window.__readerFixtureScriptExecuted), undefined);
  const requests = fixture.evidence().requests;
  assert.ok(requests.some(request => request.path.endsWith('/feed.xml') && request.method === 'GET'));
  assert.ok(requests.some(request => request.path.endsWith('/feed.xml') && request.ifNoneMatch));
  assert.equal(requests.filter(request => request.path === fixture.articlePath).length, mode === 'dummy' ? 0 : 1);
  return { article, feed, summaryPipeline, transportReferencesRequestUrl: true, acquiredBeforeOpening: true, mode,
    suppliedExcerptPreservedInDummyMode: mode === 'dummy', filenameTitle: true };
}

export async function stopFixtureOrigin(page, fixture, article, quote = fixture.quote) {
  const panel = await subscriptions(page), toggle = feedRow(page, panel, fixture.feedTitle).locator('.checkbox-container');
  await expect(toggle).toHaveClass(/is-enabled/); await toggle.click();
  await expect.poll(async () => (await library(page))[1].find(feed => feed.url === fixture.feedURL)?.enabled).toBe(false);
  await closeFeeds(page, panel); await fixture.stop();
  await assert.rejects(fetch(fixture.articleURL, { signal: AbortSignal.timeout(1500) }));
  await openArticle(page, article.title, article.status);
  await expect(page.locator('.workspace-leaf.mod-active .r2-article-body')).toContainText(quote);
  const offline = await runtimeArticle(page, article.path);
  assert.equal(offline.content, article.content); assert.equal(offline.error, article.error); assert.equal(offline.body.trim(), article.body.trim());
  return { scope: 'Controlled source origin stopped; no OS-wide network changes', originUnavailable: true, savedBodyAvailable: true };
}

export async function disableFixtureFeed(page, fixture) {
  await assertNoSafetyHold('disable this QA run’s fixture feed'); await assertRuntimeVault(page);
  await page.evaluate(async ({ vaultPath, pluginId, url }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before fixture cleanup');
    const controller = app.plugins.plugins[pluginId]?.controller; if (!controller) return;
    const feed = (await controller.repository.listFeeds()).find(feed => feed.url === url);
    if (feed?.enabled) await controller.repository.updateFeed(feed.path, { enabled: false });
  }, { vaultPath, pluginId, url: fixture.feedURL });
}
