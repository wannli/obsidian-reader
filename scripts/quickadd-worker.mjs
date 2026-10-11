import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { captureFromURI, closeReaderViews, openCapturedMarkdown } from './quickadd-ui.mjs';
import { commentsSuffix, observeNativeWrites, requireInterleavedCommit, sourceEditorSnapshot, typeCommentsWithTrace } from './runtime-editor.mjs';
import { observeNativeSaveCoalescing, requireNativeSaveEarlyReturn } from './runtime-native-save.mjs';
import { assertNoRepeatedWrites, setDummyMode } from './runtime-modes.mjs';
import { reloadReader } from './runtime-plugin.mjs';
import { parseMarkdown, readMarkdown, runtimeArticle } from './runtime-storage.mjs';
import { vaultPath } from './sandbox.mjs';

export async function markSourceFixture(page, path, extractor, text) {
  await assertRuntimeVault(page);
  await page.evaluate(async ({ vaultPath, path, extractor, text }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before source-fixture preparation');
    const file = app.vault.getAbstractFileByPath(path);
    await app.fileManager.processFrontMatter(file, fields => {
      fields.extractor = extractor; fields.content = extractor === 'defuddle' ? 'ready' : 'pending';
      if (extractor === 'summary') fields.summary = text;
    });
    await app.vault.process(file, current => current.replace('## Article\n\n', `## Article\n\n${text}\n\n`));
  }, { vaultPath, path, extractor, text });
  return readMarkdown(path);
}

export async function verifyDummyWorker(page, network, fixture, captures) {
  const fullPath = captures.uri.path;
  const fullBefore = await markSourceFixture(page, fullPath, 'defuddle', 'This fixture represents an existing completed article. Its exact snapshot must not be acquired again.');
  // Confirmed policy: native capture opens Reader. Editing is an explicit UI
  // escape, not a Source-mode exception in the article router.
  const typingPath = captures.collisions[1].path;
  await openCapturedMarkdown(page, typingPath); await closeReaderViews(page);
  const typed = `\nTyped personal writing while the default dummy worker resumes: ${fixture.tag}. Keep every character.\n`;
  const initial = await sourceEditorSnapshot(page, typingPath), originalComments = commentsSuffix(initial.text);
  const observer = await observeNativeWrites(page, typingPath);
  const nativeSave = await observeNativeSaveCoalescing(page, typingPath, 'Dummy article — extraction is disabled');
  let progress = { typed: '' }, typingResult, typingError, writes, releasedAt;
  const typing = typeCommentsWithTrace(page, typingPath, typed, { progress: value => { progress = value; } })
    .then(value => { typingResult = value; }, error => { typingError = error; });
  const filled = captures.all.filter(item => item.path !== fullPath);
  try {
    await expect.poll(() => { if (typingError) throw typingError; return progress.typed.length; }).toBeGreaterThanOrEqual(12);
    releasedAt = Date.now(); await network.setOffline(false);
    for (const item of filled) await expect.poll(async () => {
      if (typingError) throw typingError; return (await runtimeArticle(page, item.path)).extractor;
    }, { timeout: 20_000 }).toBe('dummy');
    await typing; if (typingError) throw typingError;
    await expect.poll(() => readMarkdown(typingPath)).toContain(typed);
  } catch (error) {
    await typing; writes = await observer.finish();
    const saveProof = await nativeSave.finish();
    error.editorRegression = { path: typingPath, initial, progress, typingError: String(typingError ?? ''), writes, releasedAt, saveProof };
    throw error;
  }
  writes = await observer.finish();
  const saveProof = await nativeSave.finish(), coalescing = requireNativeSaveEarlyReturn(saveProof);
  const commit = requireInterleavedCommit({ writes, trace: typingResult, originalComments, typed, releasedAt,
    quote: 'Dummy article — extraction is disabled', path: typingPath, leafId: initial.leafId });
  for (const item of filled) {
    const after = await readMarkdown(item.path), comments = item.text.slice(item.text.indexOf('## Comments\n') + '## Comments\n'.length).trim();
    if (comments) assert.ok(after.includes(comments), 'Dummy acquisition clobbered native QuickAdd Comments');
    assert.ok(after.includes('Dummy article — extraction is disabled'));
  }
  assert.equal(await readMarkdown(fullPath), fullBefore, 'Already-complete source was not skipped');
  assert.equal(fixture.evidence().requests.length, 0, 'Default dummy worker fetched article HTML');
  assert.equal(await page.evaluate(() => window.app.workspace.getLeavesOfType('reader').length), 0);
  const stable = await assertNoRepeatedWrites(page, captures.all.map(item => item.path));
  return { blankWithCommentsAcquired: true, completedSnapshotUnchanged: true, commentsPreserved: true, articleRequests: 0, stable,
    typing: { path: typingPath, ...typingResult, releasedAt, durableWriteDuringNativeTyping: commit, writes, coalescing, saveProof } };
}

export { verifyLiveTyping } from './quickadd-editor-race.mjs';

export async function verifyProtectedDuringFetch(page, fixture, buildId) {
  await setDummyMode(page, true);
  const captured = await captureFromURI(page, { url: fixture.articleURL }, 'Reader article quick');
  await expect.poll(async () => (await runtimeArticle(page, captured.path)).extractor).toBe('dummy');
  await setDummyMode(page, false);
  await expect.poll(() => fixture.evidence().pendingArticleResponses, { timeout: 20_000 }).toBe(1);
  await assertRuntimeVault(page);
  await page.evaluate(async path => {
    const app = window.app;
    await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(path), fields => { fields.content = 'protected'; });
  }, captured.path);
  const protectedBefore = await readMarkdown(captured.path);
  assert.equal(parseMarkdown(protectedBefore).metadata.content, 'protected');
  fixture.releaseArticle();
  // Plugin unload waits for its real in-flight task, then a new instance must
  // recover the protected state from Markdown without a JSON work queue.
  await reloadReader(page, buildId);
  assert.equal(await readMarkdown(captured.path), protectedBefore, 'In-flight real completion overwrote the latest protected snapshot');
  assert.equal((await runtimeArticle(page, captured.path)).content, 'protected');
  assert.equal((await runtimeArticle(page, captured.path)).extractor, 'dummy');
  await fixture.stop();
  return { path: captured.path, latestProtectedStateWon: true, markdown: protectedBefore };
}
