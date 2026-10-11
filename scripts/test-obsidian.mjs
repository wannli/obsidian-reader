#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { readBuild, sha256 } from './artifacts.mjs';
import { assertRuntimeVault, connectToTestVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { primaryLinkViaMenu, linkViaMenu, cancelLinkPicker, deleteViaMenu, renderedLink } from './runtime-actions.mjs';
import { startRuntimeFixture } from './runtime-fixture.mjs';
import { verifyOfflineCapture, verifyFailedCapture } from './runtime-capture.mjs';
import { verifyLiveCapture } from './runtime-capture-live.mjs';
import { verifyNativeLinkCases } from './runtime-link-cases.mjs';
import { verifyNativeLibrary, readingPicker, closeLibrary } from './runtime-library.mjs';
import { scopedNetwork } from './runtime-network.mjs';
import { focusNativeWindow, nativeMenuEvidence } from './runtime-menu.mjs';
import { disableFixtureFeed, ingestFixture, stopFixtureOrigin } from './runtime-ingestion.mjs';
import { assertDummyDefault, assertNoRepeatedWrites, setDummyMode } from './runtime-modes.mjs';
import { enableReader, reloadReader, verifyInstalledBuild, verifyReader } from './runtime-plugin.mjs';
import { defaultThenLive } from './runtime-scenarios.mjs';
import { annotationCompanions, assertCompanionsUnchanged, assertInlineWrite, assertRestoredMarkdown, assertSettledUnchanged, expectPositionRestore, flushReaderPositions, parseMarkdown, positionDelta, readSettledMarkdown, runtimeArticle, verifySaved } from './runtime-storage.mjs';
import { assertPaint, commandReader, highlightSelection, moveArticle, openArticle, tab } from './runtime-ui.mjs';
import { seedArticleId, seedQuote, seedTitle } from './seed.mjs';
import { assertOwnedVault, createOnly, directory, sandboxPath, vaultPath } from './sandbox.mjs';

if (process.argv.length !== 2) throw new Error('No arguments accepted; only the marked Reader test vault on CDP 19224 is allowed');
await assertNoSafetyHold('default-vault UI/testing/restoration entrypoint');
await assertOwnedVault();
const build = await readBuild(), installed = await verifyInstalledBuild(build);
// No screenshots, UI actions, plugin changes or vault writes before the exact path/marker guard.
const { browser, page } = await connectToTestVault();
let evidence, network;
const fixtures = [];
const result = {
  status: 'running', startedAt: new Date().toISOString(), vaultPath, buildId: build.metadata.buildId, installed,
  scope: 'Actual macOS Obsidian/Electron runtime; synthetic test vault and controlled loopback origins only',
  selection: 'Actual Chromium/Electron mouse drag; ranges measure endpoints only, no selection injection or direct save API',
  acceptance: { physicalIOS: 'NOT RUN', nativeTouchSelection: 'NOT RUN; paused native-handle adjustment/reselection after the delay requires hardware', sync: 'NOT RUN' },
  steps: [], pageErrors: [], consoleErrors: [],
};
async function screenshot(name) {
  await assertRuntimeVault(page);
  await createOnly(join(evidence, name + '.png'), await page.screenshot({ fullPage: true }));
}
async function saveText(name, text) { await createOnly(join(evidence, name + '.txt'), text); }
try {
  const root = join(sandboxPath, 'evidence'); await directory(root);
  evidence = await mkdtemp(join(root, 'obsidian-'));
  await createOnly(join(evidence, 'build-meta.json'), JSON.stringify(build.metadata, null, 2) + '\n');
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => result.pageErrors.push(String(error.stack ?? error)));
  page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
  await assertRuntimeVault(page); await page.bringToFront(); await focusNativeWindow(page);
  result.runtime = await enableReader(page, build.metadata.buildId);
  result.protocolHandlers = await page.evaluate(() => ({ legacyReaderSave: app.workspace.protocolHandler.handlers.has('reader2-save'), quickadd: app.workspace.protocolHandler.handlers.has('quickadd') }));
  assert.equal(result.protocolHandlers.legacyReaderSave, false, 'Obsolete custom reader2-save handler remains registered');
  assert.equal(result.protocolHandlers.quickadd, true, 'Official QuickAdd handler is missing');
  await commandReader(page);
  result.steps.push('Exact vault/ownership and actual loaded build verified; Reader enabled via its open-reader command');
  const seeds = await page.evaluate(id => window.app.plugins.plugins['obsidian-reader'].controller.repository.listArticles().then(articles => articles.filter(article => article.id === id)), seedArticleId);
  assert.equal(seeds.length, 1, 'Expected one fresh canonical seed; reset the designated dummy vault rather than migrating fixtures');
  const seed = seeds[0], seedArticlePath = seed.path, seedBefore = await readSettledMarkdown(page, seedArticlePath);
  assert.match(seedArticlePath, /^Reading\/Inbox\/\d{6} /);
  assert.ok(seed.title.endsWith(seedTitle)); assert.equal(seed.status, 'inbox'); assert.ok(seed.body.includes(seedQuote));
  assert.equal(Object.hasOwn(parseMarkdown(seedBefore).metadata, 'status'), false);
  assert.equal(parseMarkdown(seedBefore).metadata['test-note'], 'Preserve this unknown property');
  await openArticle(page, seed.title);
  await expect(page.locator('.workspace-leaf.mod-active .r2-article-body')).toContainText(seedQuote);
  for (const status of ['inbox', 'later', 'archive', 'feed']) await tab(page, status);
  await expect(readingPicker(page).locator('.suggestion-item').filter({ hasText: 'A paper lantern — Reader synthetic feed item' })).toHaveCount(1);
  await closeLibrary(page);
  result.defaultMode = await assertDummyDefault(page);
  network = await scopedNetwork(page);
  result.offlineCapture = await verifyOfflineCapture(page, network, fixtures, build.metadata.buildId);
  result.failedCapture = await verifyFailedCapture(page, fixtures[0]);
  result.liveCapture = await verifyLiveCapture(page, network, fixtures);
  await screenshot('capture-link-offline-recovery');
  await setDummyMode(page, true); await network.restore(); network = undefined;
  result.steps.push('Add URL saved offline, paused even dummy work, survived restart and resumed; duplicates preserved state; failed save stayed an error; gated live capture returned early; Save as article preserved position; online transport failure retained/recovered retry work');
  result.defaultAcquisition = await defaultThenLive(page, evidence, fixtures, screenshot);
  result.steps.push('Default dummy background acquisition made zero article requests; auto-highlight persisted; external template Comments survived dummy and explicit live acquisition');
  await commandReader(page);
  const fixture = await startRuntimeFixture({ gateArticle: true }); fixtures.push(fixture);
  const ingestion = await ingestFixture(page, fixture, 'live'); let article = ingestion.article;
  result.ingestion = { articlePath: article.path, feedPath: ingestion.feed.path, acquiredBeforeOpening: ingestion.acquiredBeforeOpening, extractor: article.extractor, explicitLiveOptIn: true, summaryPipeline: ingestion.summaryPipeline };
  result.nativeLibrary = await verifyNativeLibrary(page, article);
  await screenshot('native-article-and-picker');
  const quote = fixture.quote.replace(/\.$/, ''); // Literal safe selection for immediate bare-wikilink behavior; source remains unchanged.
  const originalMarkdown = await readSettledMarkdown(page, article.path), companions = await annotationCompanions(page);
  result.autoHighlight = await highlightSelection(page, quote);
  article = await runtimeArticle(page, article.path);
  const saved = await verifySaved({ page, article, originalMarkdown, quote, companions });
  result.highlight = saved.highlight; result.paint = await assertPaint(page, quote);
  await saveText('stored-article', saved.articleMarkdown); await saveText('unchanged-journals', JSON.stringify(companions, null, 2));
  await screenshot('live-highlight-saved');
  result.steps.push('Production RSS and gated acquisition persisted full text before opening; automatic selection inserted only inline mark delimiters with journals/legacy JSON untouched');
  result.offline = await stopFixtureOrigin(page, fixture, article);
  const primary = await primaryLinkViaMenu(page, article, saved.highlight);
  result.primaryLink = { target: primary.target, immediateBareWikiLink: primary.immediateBareWikiLink, noFileCreated: primary.noFileCreated };
  result.linkCancellation = await cancelLinkPicker(page, primary.article, primary.link);
  result.nativeLinkCases = await verifyNativeLinkCases(page, fixture, primary.article, primary.link);
  // External-link edits retain Markdown syntax. Explicitly unlink and select again
  // before the wiki-link move case; never bypass the relative-link move guard.
  const restored = await deleteViaMenu(page, result.nativeLinkCases.article, result.nativeLinkCases.link);
  assert.equal(restored.article.body, parseMarkdown(originalMarkdown).body);
  await highlightSelection(page, quote); article = await runtimeArticle(page, article.path);
  const reselected = await verifySaved({ page, article, originalMarkdown: restored.source, quote, companions });
  const linked = await linkViaMenu(page, article, reselected.highlight);
  article = linked.article;
  result.link = { target: linked.target, revisionBoundLinkId: linked.link.id };
  await saveText('linked-article', linked.source);
  await screenshot('ordinary-inline-link');
  for (const status of ['later', 'archive', 'inbox', 'later']) { article = await moveArticle(page, article.path, status); await openArticle(page, article.title, status); }
  const beforeReload = await assertSettledUnchanged(page, article.path, linked.source);
  const pluginRestore = expectPositionRestore(page, article.path, beforeReload);
  await assertCompanionsUnchanged(page, companions);
  await reloadReader(page, build.metadata.buildId); await commandReader(page); await openArticle(page, article.title, 'later');
  result.pluginReloadLink = await renderedLink(page, quote, linked.target, linked.link.source, linked.link.syntax);
  assert.equal((await runtimeArticle(page, article.path)).highlights.length, 0, 'An ordinary link is not remembered as a highlight');
  const afterPluginReload = await assertRestoredMarkdown(page, pluginRestore); await assertCompanionsUnchanged(page, companions);
  await saveText('plugin-reloaded-linked-article', afterPluginReload);
  const rendererRestore = expectPositionRestore(page, article.path, afterPluginReload);
  await screenshot('plugin-reloaded');
  await assertRuntimeVault(page); await flushReaderPositions(page); await page.reload({ waitUntil: 'domcontentloaded' });
  result.reloadedRuntime = await verifyReader(page, build.metadata.buildId);
  await commandReader(page); await openArticle(page, article.title, 'later');
  const currentLink = await renderedLink(page, quote, linked.target, linked.link.source, linked.link.syntax);
  const persisted = await runtimeArticle(page, article.path);
  assert.equal(persisted.status, 'later'); assert.equal(persisted.highlights.length, 0);
  assert.equal(persisted.body, linked.article.body);
  const afterRendererReload = await assertRestoredMarkdown(page, rendererRestore); await assertCompanionsUnchanged(page, companions);
  result.steps.push('With source origin stopped, inline link and queue survived plugin/renderer reload; no annotation IDs or daily copies were persisted');
  await saveText('persisted-linked-article', afterRendererReload);
  await screenshot('renderer-reloaded');
  const deleted = await deleteViaMenu(page, persisted, currentLink);
  assertInlineWrite(originalMarkdown, deleted.source, parseMarkdown(originalMarkdown).body, positionDelta(page, article.path, originalMarkdown, deleted.source));
  await saveText('unlinked-article', deleted.source);
  const unlinkedRestore = expectPositionRestore(page, article.path, deleted.source);
  await reloadReader(page, build.metadata.buildId); await commandReader(page); await openArticle(page, article.title, 'later');
  await expect(page.locator('.workspace-leaf.mod-active .r2-article-body')).toHaveAttribute('data-highlight-count', '0');
  const afterUnlinkReload = await assertRestoredMarkdown(page, unlinkedRestore); await assertCompanionsUnchanged(page, companions);
  await saveText('persisted-unlinked-article', afterUnlinkReload);
  await assertSettledUnchanged(page, seedArticlePath, seedBefore);
  result.stableWorker = await assertNoRepeatedWrites(page, [article.path, ...Object.keys(companions).filter(path => path.endsWith('.md'))]);
  result.steps.push('Unlink restored exact body words/formatting without resurrecting a highlight; protected source ownership and all journal bytes survived reload');
  result.markdownHashes = { afterHighlight: saved.articleSha256, afterLink: sha256(linked.source),
    afterPluginReload: sha256(afterPluginReload), afterRendererReload: sha256(afterRendererReload),
    afterUnlink: sha256(deleted.source), afterUnlinkReload: sha256(afterUnlinkReload), unchangedCompanions: sha256(JSON.stringify(companions)) };
  await screenshot('deleted-persisted');
  assert.deepEqual(result.pageErrors, [], 'Unexpected uncaught renderer errors');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = String(error.stack ?? error);
  if (evidence) { try { await screenshot('failure'); } catch (failure) { result.screenshotError = String(failure); } }
  process.exitCode = 1;
} finally {
  if (evidence) {
    try { result.restoredMode = await setDummyMode(page, true); if (network) await network.restore(); }
    catch (error) { result.status = 'failed'; result.settingsRestoreError = String(error); process.exitCode = 1; }
  }
  for (const fixture of fixtures) {
    try { await disableFixtureFeed(page, fixture); await fixture.stop(); }
    catch (error) { await fixture.stop(); result.status = 'failed'; result.cleanupError = String(error); process.exitCode = 1; }
  }
  result.nativeMenus = nativeMenuEvidence(page);
  result.fixtures = fixtures.map(fixture => fixture.evidence()); result.finishedAt = new Date().toISOString();
  try {
    if (evidence) await createOnly(join(evidence, 'runtime.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ status: result.status, evidence, buildId: result.buildId, steps: result.steps, error: result.error, acceptance: result.acceptance }, null, 2));
  } finally { await browser.close(); }
}
