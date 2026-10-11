import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { captureFromURI, openCapturedMarkdown } from './quickadd-ui.mjs';
import { commentsSuffix, observeNativeWrites, requireInterleavedCommit, sourceEditorSnapshot, typeCommentsWithTrace } from './runtime-editor.mjs';
import { observeNativeSaveCoalescing, requireNativeSaveEarlyReturn } from './runtime-native-save.mjs';
import { assertNoRepeatedWrites, setDummyMode } from './runtime-modes.mjs';
import { parseMarkdown, readMarkdown, runtimeArticle } from './runtime-storage.mjs';
import { pluginId, vaultPath } from './sandbox.mjs';

export async function verifyLiveTyping(page, fixture, network) {
  assert.ok(network?.setOffline, 'This regression must control offline capture before any live opt-in');
  assert.equal(fixture.evidence().gateOpen, false, 'A fresh real HTTP response gate is required');
  assert.equal(fixture.evidence().requests.length, 0);
  await assertRuntimeVault(page);
  const { originalMode, wasOffline } = await page.evaluate(pluginId => ({ originalMode: window.app.plugins.plugins[pluginId].settings.useDummyContent,
    wasOffline: !navigator.onLine }), pluginId);
  let observer, saveObserver, saveProof, typing, typingError, typingResult, progress, failure, writes = [];
  try {
    await network.setOffline(true);
    // Fails closed if unrelated public articles could be acquired. This must
    // never be bypassed just to make the regression runnable in the demo vault.
    await setDummyMode(page, false);
    const captureStartedAt = Date.now();
    const captured = await captureFromURI(page, { url: fixture.articleURL, articleTitle: fixture.title,
      comments: `Comments supplied offline for ${fixture.tag}.\n\n## Personal follow-up\n\nThis custom section must survive byte-for-byte.` });
    const savedAt = Date.now(), stub = await runtimeArticle(page, captured.path);
    assert.equal(stub.body.trim(), '', 'Populated Comments were incorrectly treated as article content');
    assert.equal(stub.content, 'pending'); assert.equal(stub.extractor, 'pending');
    assert.equal(Object.hasOwn(parseMarkdown(captured.text).metadata, 'articleSection'), false, 'Test must use the delivered no-flag template');
    assert.equal(fixture.evidence().requests.length, 0, 'Saving the offline native stub requested the article');
    // Seed expired retry metadata as a fixture precondition, not a claim that a
    // preceding HTTP failure was tested here. The real worker must clear it.
    await page.evaluate(async ({ vaultPath, pluginId, path }) => {
      const app = window.app;
      if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before QA retry precondition');
      await app.plugins.plugins[pluginId].controller.repository.setArticleError(path, 'Controlled expired retry precondition', '2000-01-01T00:00:00.000Z');
    }, { vaultPath, pluginId, path: captured.path });
    const retryBefore = parseMarkdown(await readMarkdown(captured.path)).metadata;
    assert.equal(retryBefore.error, 'Controlled expired retry precondition'); assert.ok(retryBefore.retryAfter);
    await openCapturedMarkdown(page, captured.path); // Real registered native command, not an in-view button.
    const initial = await sourceEditorSnapshot(page, captured.path), originalComments = commentsSuffix(initial.text);
    assert.equal(originalComments, commentsSuffix(captured.text));
    observer = await observeNativeWrites(page, captured.path);
    saveObserver = await observeNativeSaveCoalescing(page, captured.path, fixture.quote);
    await network.setOffline(false);
    await expect.poll(() => fixture.evidence().pendingArticleResponses, { timeout: 20_000 }).toBe(1);
    assert.equal((await runtimeArticle(page, captured.path)).body.trim(), '', 'Article was filled before the controlled HTTP response');
    const typed = `\nNative editor flight ${fixture.tag}: keep each character and this cursor in Comments. `
      + 'A stored article insertion must not erase, split, duplicate, or relocate the sentence being typed. '.repeat(3) + '\n';
    progress = { typed: '' };
    typing = typeCommentsWithTrace(page, captured.path, typed, { delayMs: 18, progress: value => { progress = value; } })
      .then(value => { typingResult = value; }, error => { typingError = error; });
    await expect.poll(() => { if (typingError) throw typingError; return progress.typed.length; }).toBeGreaterThanOrEqual(12);
    const gateReleasedAt = Date.now(); fixture.releaseArticle();
    await expect.poll(async () => {
      if (typingError) throw typingError;
      return (await runtimeArticle(page, captured.path)).extractor;
    }, { timeout: 25_000 }).toBe('defuddle');
    await typing; if (typingError) throw typingError;
    await expect.poll(() => readMarkdown(captured.path)).toContain(typed);
    const text = await readMarkdown(captured.path), parsed = parseMarkdown(text), article = await runtimeArticle(page, captured.path);
    const editor = await sourceEditorSnapshot(page, captured.path);
    assert.equal(commentsSuffix(text), originalComments + typed, 'Article insertion changed Comments/custom sections or lost native typing');
    assert.equal(editor.text, text, 'Native editor and authoritative Markdown diverged');
    assert.equal(editor.leafId, initial.leafId); assert.equal(editor.cursorOffset, editor.text.length);
    assert.ok(article.body.includes(fixture.quote)); assert.ok(!article.body.includes('Native editor flight'));
    assert.equal(article.content, 'ready'); assert.equal(article.status, 'inbox');
    for (const field of ['error', 'retryAfter']) assert.equal(Object.hasOwn(parsed.metadata, field), false, `${field} unexpectedly persisted after successful acquisition`);
    writes = await observer.finish(); observer = undefined;
    saveProof = await saveObserver.finish(); saveObserver = undefined; const coalescing = requireNativeSaveEarlyReturn(saveProof);
    // Require a real durable article write bracketed by native keystrokes, with
    // an actual partial Comments buffer at that write. Merely overlapping the
    // Node operation's start/end timestamps is deliberately insufficient.
    const commit = requireInterleavedCommit({ writes, trace: typingResult, originalComments, typed, releasedAt: gateReleasedAt,
      quote: fixture.quote, path: captured.path, leafId: initial.leafId });
    const stable = await assertNoRepeatedWrites(page, [captured.path]);
    return { path: captured.path, markdown: text, commentsPreserved: true, customSectionsPreserved: true, stable,
      offlineStub: { captureStartedAt, savedAt, articleRequestsBeforeReconnect: 0, bodyEmptyDespiteComments: true, noArticleSectionFlag: true, opening: captured.reader },
      retry: { precondition: 'QA-seeded expired error/retryAfter, not a preceding HTTP failure', successClearedErrorAndRetry: true },
      typing: { ...typingResult, gateReleasedAt, durableWriteDuringNativeTyping: commit, vaultWrites: writes, saveProof, coalescing },
      editor: { leafId: editor.leafId, path: editor.path, state: editor.state, cursor: editor.cursor },
      scope: 'Actual registered QuickAdd handler, native Open Markdown, native keystrokes, automatic live worker and production requestUrl; not OS URI/Shortcut proof' };
  } catch (error) {
    failure = error; throw error;
  } finally {
    fixture.releaseArticle();
    try {
      if (typing) await typing;
      if (observer) writes = await observer.finish();
      if (saveObserver) saveProof = await saveObserver.finish();
    } finally {
      if (failure) failure.editorRegression = { typingError: String(typingError ?? ''), progress, typingResult, writes, saveProof };
      try { await setDummyMode(page, originalMode); }
      finally { await network.setOffline(wasOffline); }
    }
  }
}
