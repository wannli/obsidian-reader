import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { startRuntimeFixture } from './runtime-fixture.mjs';
import { nativeReaderCommand } from './runtime-native.mjs';
import { reloadReader } from './runtime-plugin.mjs';
import { assertSettledUnchanged, flushReaderPositions, parseMarkdown, readSettledMarkdown, runtimeArticle } from './runtime-storage.mjs';
import { commandReader, moveArticle, openArticle } from './runtime-ui.mjs';

export async function articlesForURL(page, url) {
  await assertRuntimeVault(page);
  return page.evaluate(async url => (await window.app.plugins.plugins['obsidian-reader'].controller.repository.listArticles()).filter(article => article.url === url), url);
}
export async function captureDialog(page, url) {
  await expect(page.locator('.modal-container')).toHaveCount(0);
  await flushReaderPositions(page);
  await nativeReaderCommand(page, 'capture-url');
  const dialog = page.locator('.modal-container').filter({ has: page.locator('.modal-title').filter({ hasText: /^Add URL$/ }) });
  await expect(dialog).toBeVisible(); await dialog.getByRole('textbox', { name: 'URL', exact: true }).fill(url);
  await assertRuntimeVault(page); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  return dialog;
}
export async function captureByUI(page, url) {
  const dialog = await captureDialog(page, url);
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await articlesForURL(page, url)).length).toBe(1);
  return (await articlesForURL(page, url))[0];
}

export async function verifyOfflineCapture(page, network, fixtures, buildId) {
  const fixture = await startRuntimeFixture(); fixtures.push(fixture);
  await network.setOffline(true);
  const captured = await captureByUI(page, fixture.articleURL);
  assert.equal(captured.extractor, 'pending'); assert.equal(captured.body.trim(), '');
  const pending = await readSettledMarkdown(page, captured.path);
  assert.match(captured.path, /^Reading\/Inbox\/\d{6} /);
  assert.equal(Object.hasOwn(parseMarkdown(pending).metadata, 'status'), false);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await assertSettledUnchanged(page, captured.path, pending);
  assert.equal(fixture.evidence().requests.length, 0);
  await reloadReader(page, buildId); await commandReader(page);
  // This offline-stub check claims stored-note durability, not active-view restoration.
  assert.equal(await readSettledMarkdown(page, captured.path), pending, 'Restart changed the offline Markdown/position snapshot');
  await network.setOffline(false);
  await expect.poll(async () => (await runtimeArticle(page, captured.path)).extractor, { timeout: 20_000 }).toBe('dummy');
  const ready = await runtimeArticle(page, captured.path);
  await openArticle(page, ready.title); const moved = await moveArticle(page, captured.path, 'later');
  const beforeDuplicate = await readSettledMarkdown(page, moved.path);
  await network.setOffline(true);
  const duplicate = await captureByUI(page, fixture.articleURL);
  assert.equal(duplicate.path, moved.path); assert.equal(duplicate.id, captured.id); assert.equal(duplicate.status, 'later');
  await assertSettledUnchanged(page, moved.path, beforeDuplicate);
  assert.equal(fixture.evidence().requests.length, 0);
  return { path: moved.path, initialPath: captured.path, persistedOffline: true, offlineEvenInDummyMode: true, restartedWhileOffline: true,
    automaticallyResumed: true, extractor: ready.extractor, duplicatePreservedState: true, articleRequests: 0 };
}

export async function verifyFailedCapture(page, fixture) {
  // articlesFolder is legacy inference only. Never mutate that setting or obstruct
  // the shared fixed Inbox folder to manufacture a failure in another capture.
  const url = `file:///reader-invalid-capture-${fixture.tag}`;
  const before = await page.evaluate(() => window.app.vault.getMarkdownFiles().map(file => file.path).sort());
  const dialog = await captureDialog(page, url);
  await expect(dialog.getByRole('alert')).not.toBeEmpty();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  assert.equal((await articlesForURL(page, url)).length, 0, 'Invalid capture was reported or stored as successful');
  assert.deepEqual(await page.evaluate(() => window.app.vault.getMarkdownFiles().map(file => file.path).sort()), before);
  const error = await dialog.getByRole('alert').innerText();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  return { failedWithoutSuccess: true, error, scope: 'Native Add URL rejects a non-HTTP(S) URL without a note or settings change',
    filesystemWriteFailure: 'NOT RUN; the obsolete configurable-destination blocker is not valid for fixed Inbox' };
}
