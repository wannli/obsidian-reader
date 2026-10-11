import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { parseMarkdown, readMarkdown } from './runtime-storage.mjs';
import { nativeReaderCommand } from './runtime-native.mjs';
import { assertIsolatedReaderAbsent } from './quickadd-isolation.mjs';
import { vaultPath } from './sandbox.mjs';

export async function markdownPaths(page) {
  await assertRuntimeVault(page);
  return page.evaluate(() => window.app.vault.getMarkdownFiles().map(file => file.path).sort());
}
export async function readerLeaves(page) {
  await assertRuntimeVault(page);
  return page.evaluate(() => window.app.workspace.getLeavesOfType('reader').map(leaf => {
    const state = leaf.view.getState(); return { leafId: leaf.id, file: state.file, queue: state.queue };
  }));
}
export async function closeReaderViews(page) {
  await assertNoSafetyHold('close Reader views for QA');
  await assertRuntimeVault(page);
  await page.evaluate(vaultPath => {
    if (window.app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before closing test Reader leaves');
    for (const leaf of window.app.workspace.getLeavesOfType('reader')) leaf.detach();
  }, vaultPath);
  await expect(page.locator('.r2-app')).toHaveCount(0);
}
export async function quickAddCommand(page, options = {}) {
  await assertNoSafetyHold('invoke native QuickAdd QA capture');
  await assertRuntimeVault(page);
  await page.evaluate(({ vaultPath, opening }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before QuickAdd command');
    if (opening === 'native' && ['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) throw new Error('Reader must remain unloaded for isolated QuickAdd verification');
    const id = 'quickadd:choice:reader-article-template';
    if (!app.commands.commands[id]) throw new Error('Pinned native QuickAdd Template command is not registered');
    app.commands.executeCommandById(id);
  }, { vaultPath, opening: options.opening });
  const modal = page.locator('.modal-container');
  await expect(modal).toContainText('Provide inputs');
  await expect(modal.locator('input[type="text"]')).toHaveCount(2);
  await expect(modal.locator('textarea')).toHaveCount(1);
  return modal;
}
export async function captureFromCommand(page, values, options = {}) {
  const before = await markdownPaths(page), readerBefore = await readerLeaves(page), modal = await quickAddCommand(page, options);
  if (options.opening === 'native') await assertIsolatedReaderAbsent(page);
  await modal.locator('input[type="text"]').nth(0).fill(values.url);
  await modal.locator('input[type="text"]').nth(1).fill(values.articleTitle ?? '');
  await modal.locator('textarea').fill(values.comments ?? '');
  await assertRuntimeVault(page);
  if (options.opening === 'native') await assertIsolatedReaderAbsent(page);
  await modal.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(modal).toBeHidden();
  return capturedReader(page, before, { ...options, readerBefore });
}
export async function captureFromURI(page, values, choice = 'Reader article', options = {}) {
  await assertNoSafetyHold('dispatch native QuickAdd QA URI');
  const vaultName = basename(vaultPath);
  const before = await markdownPaths(page), readerBefore = await readerLeaves(page);
  const uri = new URL('obsidian://quickadd');
  uri.searchParams.set('vault', vaultName); uri.searchParams.set('choice', choice);
  for (const [name, value] of Object.entries(values)) uri.searchParams.set('value-' + name, value);
  await assertRuntimeVault(page);
  await page.evaluate(({ vaultPath, vaultName, uri, opening }) => {
    const app = window.app, parsed = new URL(uri);
    if (opening === 'native' && ['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) throw new Error('Reader must remain unloaded for isolated QuickAdd verification');
    if (app.vault.adapter.getBasePath() !== vaultPath || parsed.protocol !== 'obsidian:' || parsed.hostname !== 'quickadd'
      || parsed.searchParams.get('vault') !== app.vault.getName() || app.vault.getName() !== vaultName) throw new Error('Refusing unscoped QuickAdd URI');
    const params = { action: 'quickadd', ...Object.fromEntries(parsed.searchParams) };
    const registry = app.workspace.protocolHandler;
    if (!registry?.handlers?.has('quickadd')) throw new Error('The actual native QuickAdd URI handler is not registered');
    // Use Obsidian's existing dispatcher in this verified renderer. Never send an
    // OS-level open-URI request, register a fake handler, or route another vault.
    registry.dispatch(params);
  }, { vaultPath, vaultName, uri: uri.href, opening: options.opening });
  return { ...await capturedReader(page, before, { ...options, readerBefore }), uri: uri.href, delivery: 'Actual registered QuickAdd URI handler through the verified renderer dispatcher; OS routing not exercised' };
}

export async function capturedReader(page, before, options = {}) {
  await expect.poll(async () => (await markdownPaths(page)).filter(path => !before.includes(path)).length).toBe(1);
  const path = (await markdownPaths(page)).find(path => !before.includes(path));
  // quickadd-contracts verifies default date-leading names; collision cases deliberately override the format.
  assert.match(path, /^Reading\/Inbox\/[^/]+\.md$/);
  const expectedType = options.opening === 'native' ? 'markdown' : 'reader';
  await page.waitForFunction(({ path, expectedType }) => {
    const view = window.app.workspace.activeLeaf?.view;
    return view?.getViewType() === expectedType && view.getState().file === path
      && (expectedType !== 'reader' || view.getState().queue === 'inbox');
  }, { path, expectedType });
  const reader = await page.evaluate(() => {
    const leaf = window.app.workspace.activeLeaf, view = leaf.view;
    return { type: view.getViewType(), leafId: leaf.id, state: view.getState(), cursor: view.editor?.getCursor(), body: leaf.containerEl.querySelector('.r2-article-body')?.textContent };
  });
  assert.equal(reader.type, expectedType); assert.equal(reader.state.file, path);
  if (expectedType === 'reader') {
    const after = await readerLeaves(page);
    assert.deepEqual(after.filter(leaf => leaf.file === path).map(leaf => leaf.leafId), [reader.leafId], 'Fresh QuickAdd capture routed into an unintended Reader leaf');
    for (const prior of options.readerBefore ?? []) {
      if (prior.leafId !== reader.leafId) assert.deepEqual(after.find(leaf => leaf.leafId === prior.leafId), prior, 'QuickAdd routing changed another Reader leaf’s article/queue');
    }
    reader.otherLeavesBefore = options.readerBefore ?? []; reader.otherLeavesUnchanged = true;
  }
  const text = await readMarkdown(path), parsed = parseMarkdown(text);
  assert.equal(Object.hasOwn(parsed.metadata, 'created-by'), false); assert.equal(parsed.metadata.type, 'article');
  assert.equal(Object.hasOwn(parsed.metadata, 'status'), false, 'New QuickAdd captures derive Inbox from their path');
  assert.ok(!text.includes('{{CURSOR}}'));
  if (options.opening === 'native') {
    await assertIsolatedReaderAbsent(page);
    assert.equal(text.split('## Article\n')[1]?.split('## Comments\n')[0].trim(), '', 'Isolated capture unexpectedly acquired article content');
  }
  return { path, text, metadata: parsed.metadata, reader, openingPolicy: options.opening === 'native'
    ? 'Isolated native default opening with Reader disabled; not an end-to-end routing result' : 'Native capture automatically opens Reader in its intended leaf' };
}

export async function openCapturedMarkdown(page, path) {
  await assertRuntimeVault(page);
  const current = await page.evaluate(() => window.app.workspace.activeLeaf?.view?.getState());
  assert.equal(current.file, path, 'Refusing to edit a different active article');
  await nativeReaderCommand(page, 'open-markdown');
  await page.waitForFunction(path => {
    const view = window.app.workspace.activeLeaf?.view;
    return view?.getViewType() === 'markdown' && view.file?.path === path && Boolean(view.editor);
  }, path);
  await page.evaluate(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.setCursor(editor.lastLine(), editor.getLine(editor.lastLine()).length); editor.focus();
  });
}

export async function typeSourceComments(page, text, delay = 20) {
  await assertNoSafetyHold('type QA Comments');
  await assertRuntimeVault(page);
  await page.evaluate(() => window.app.workspace.activeLeaf.view.editor.focus());
  await page.keyboard.type(text, { delay });
}
