import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { markdownPaths } from './quickadd-ui.mjs';
import { annotationCompanions, assertCompanionsUnchanged, assertInlineWrite, assertSettledUnchanged, parseMarkdown, positionDelta, readMarkdown, readSettledMarkdown, replacementBody, runtimeArticle } from './runtime-storage.mjs';
import { focusNativeWindow, pressNativeMenu, waitNativeMenu } from './runtime-menu.mjs';

export async function clickNativeMenu(page, menu, title) { return pressNativeMenu(page, menu, title); }
const readerBody = page => page.locator('.workspace-leaf.mod-active .r2-article-body');

// Controlled plain-label fixtures only, not a second production Markdown serializer.
export function fixtureLinkSyntax(quote, target, kind) {
  assert.doesNotMatch(quote, /[\[\]|\\*~`&<>\r\n]/, 'Use a plain-label fixture for exact syntax verification');
  assert.ok(!quote.includes('=='));
  if (kind === 'markdown' || /^https?:\/\//.test(target)) {
    assert.doesNotMatch(target, /[&\s()<>]/, 'Use a simple fixture URL');
    return `[${quote}](${target})`;
  }
  assert.ok(target && !/[\[\]|\\\r\n]/.test(target));
  return target === quote ? `[[${target}]]` : `[[${target}|${quote}]]`;
}
export async function renderedLink(page, quote, target, source, syntax) {
  await assertRuntimeVault(page);
  const read = () => readerBody(page).evaluate((root, { quote, target }) => ({
    revision: root.dataset.articleVersion,
    links: [...root.querySelectorAll('a[data-inline-link-id]')].filter(a => a.textContent === quote && a.getAttribute('href') === target)
      .map(a => ({ id: a.dataset.inlineLinkId, marked: !!a.closest('mark') })),
  }), { quote, target });
  await expect.poll(async () => (await read()).links.length).toBe(1);
  const result = await read(), link = result.links[0];
  assert.ok(result.revision && link.id.startsWith(result.revision + ':'), 'Rendered link has a stale revision');
  assert.equal(link.marked, false, 'Linking should replace the highlight, not nest it');
  return { kind: 'link', quote, target, source, syntax, id: link.id };
}
async function beforeAction(page, article, reference) {
  await focusNativeWindow(page); await assertRuntimeVault(page);
  assert.equal(await page.evaluate(() => window.app.workspace.activeLeaf?.view?.getState().file), article.path);
  const source = await readSettledMarkdown(page, article.path), current = await runtimeArticle(page, article.path);
  assert.equal(current.body, article.body, 'Refresh the article after every syntax change; never reuse a stale revision');
  assert.equal(parseMarkdown(source).body, current.body, 'These action fixtures require a flat article body');
  await readerBody(page).evaluate(root => root.ownerDocument.getSelection()?.removeAllRanges());
  let syntax;
  if (reference.kind === 'link') {
    const link = await renderedLink(page, reference.quote, reference.target, reference.source);
    assert.equal(link.id, reference.id, 'Reopen the current link after a source change');
    syntax = reference.syntax; assert.equal(typeof syntax, 'string', 'Carry the verified current link syntax');
  } else {
    const mark = current.highlights.find(item => item.id === reference.id);
    assert.ok(mark, 'Reopen the current mark after a source change');
    assert.deepEqual(mark.source, reference.source); assert.equal(mark.quote, reference.quote);
    syntax = `==${reference.quote}==`;
  }
  replacementBody(current.body, reference.source, syntax, syntax); // Validate exact current raw boundaries.
  return { article: current, source, syntax, reference, companions: await annotationCompanions(page), paths: await markdownPaths(page) };
}
async function openAnnotationMenu(page, before) {
  const { reference } = before, linked = reference.kind === 'link';
  const attribute = linked ? 'data-inline-link-id' : 'data-inline-highlight-id';
  const annotation = readerBody(page).locator(`[${attribute}=${JSON.stringify(reference.id)}]`);
  await expect(annotation).toHaveCount(1); await annotation.scrollIntoViewIfNeeded();
  await assertRuntimeVault(page); await annotation.click();
  const title = linked ? 'Unlink' : 'Remove highlight';
  const menu = page.locator('.menu:visible').filter({ has: page.locator('.menu-item-title').filter({ hasText: new RegExp('^' + title + '$') }) });
  await waitNativeMenu(page, menu, title); return menu;
}
async function verifyLinked(page, before, target) {
  const { reference, article } = before;
  // Retargeting an existing Markdown link preserves its label/delimiter style.
  const kind = reference.kind === 'link' && !before.syntax.startsWith('[[') ? 'markdown' : undefined;
  const syntax = fixtureLinkSyntax(reference.quote, target, kind);
  const expected = replacementBody(article.body, reference.source, before.syntax, syntax);
  await expect.poll(async () => parseMarkdown(await readMarkdown(article.path)).body).toBe(expected);
  const source = await readSettledMarkdown(page, article.path), linked = await runtimeArticle(page, article.path);
  assertInlineWrite(before.source, source, expected, positionDelta(page, article.path, before.source, source)); assert.equal(linked.body, expected);
  assert.equal(linked.highlights.length, article.highlights.length - (reference.kind === 'link' ? 0 : 1));
  const range = { start: reference.source.start, end: reference.source.start + syntax.length };
  const link = await renderedLink(page, reference.quote, target, range, syntax);
  if (expected !== article.body) assert.notEqual(link.id, reference.id, 'IDs must be refreshed after changing source syntax');
  await assertCompanionsUnchanged(page, before.companions);
  assert.deepEqual(await markdownPaths(page), before.paths, 'Link action auto-created a note');
  return { target, article: linked, link, source, noFileCreated: true };
}
export async function primaryLinkViaMenu(page, article, highlight) {
  assert.notEqual(highlight.kind, 'link', 'Primary Link requires a current mark');
  const before = await beforeAction(page, article, highlight), menu = await openAnnotationMenu(page, before);
  await clickNativeMenu(page, menu, 'Link');
  await expect(page.locator('.modal-container')).toHaveCount(0);
  return { ...await verifyLinked(page, before, highlight.quote), immediateBareWikiLink: true };
}
export async function linkViaMenu(page, article, reference, target = 'Welcome', visibleTargets = []) {
  const before = await beforeAction(page, article, reference), menu = await openAnnotationMenu(page, before);
  await clickNativeMenu(page, menu, reference.kind === 'link' ? 'Edit link…' : 'Link to…');
  const picker = page.locator('.modal-container').filter({ has: page.getByPlaceholder('Link to an existing note', { exact: true }) });
  await expect(picker).toBeVisible(); await picker.locator('.prompt-input').fill(visibleTargets.length ? target.split('/').at(-1) : target);
  for (const expected of visibleTargets) await expect(picker.locator('.suggestion-item').filter({ hasText: expected })).toHaveCount(1);
  const row = picker.locator('.suggestion-item').filter({ hasText: new RegExp('^' + target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') });
  await expect(row).toHaveCount(1); await assertRuntimeVault(page); await row.click();
  await expect(picker).toBeHidden();
  return { ...await verifyLinked(page, before, target), nativeExistingFileSuggestion: true };
}
async function assertCancelled(page, before) {
  await assertSettledUnchanged(page, before.article.path, before.source);
  await assertCompanionsUnchanged(page, before.companions);
  assert.deepEqual(await markdownPaths(page), before.paths);
}
export async function cancelLinkPicker(page, article, reference) {
  const before = await beforeAction(page, article, reference), menu = await openAnnotationMenu(page, before);
  await clickNativeMenu(page, menu, reference.kind === 'link' ? 'Edit link…' : 'Link to…');
  const picker = page.locator('.modal-container').filter({ has: page.getByPlaceholder('Link to an existing note', { exact: true }) });
  await expect(picker).toBeVisible();
  const context = () => page.evaluate(() => window.app.workspace.activeLeaf?.view?.getState());
  const readerBefore = await context(), input = picker.locator('.prompt-input'); await input.fill('');
  for (const key of ['j', 'k']) { await input.press(key); await page.waitForTimeout(200); assert.deepEqual(await context(), readerBefore, 'Typing in the native picker navigated Reader'); }
  await expect(input).toHaveValue('jk'); await input.press('Escape');
  await expect(page.locator('.modal-container')).toHaveCount(0);
  await assertCancelled(page, before);
  return { cancellationChangedNothing: true, typingJKDidNotNavigate: true };
}
export async function externalLinkViaMenu(page, article, reference, target) {
  const before = await beforeAction(page, article, reference), menu = await openAnnotationMenu(page, before);
  await clickNativeMenu(page, menu, reference.kind === 'link' ? 'Edit link…' : 'Link to…');
  const picker = page.locator('.modal-container').filter({ has: page.getByPlaceholder('Link to an existing note', { exact: true }) });
  await picker.locator('.prompt-input').fill('HTTP(S)');
  await picker.locator('.suggestion-item').filter({ hasText: 'Link to an HTTP(S) URL…' }).click();
  const modal = page.locator('.modal-container').filter({ has: page.locator('.modal-title').filter({ hasText: /^Link to…$/ }) });
  await expect(modal.getByLabel('Selected text', { exact: true })).toHaveValue(reference.quote);
  await modal.getByLabel('HTTP(S) URL', { exact: true }).fill(target);
  await assertRuntimeVault(page); await modal.getByRole('button', { name: 'Link URL', exact: true }).click();
  await expect(modal).toBeHidden();
  return { ...await verifyLinked(page, before, target), explicitNativeURLChoice: true };
}
export async function fallbackLinkCancellation(page, article, highlight) {
  const before = await beforeAction(page, article, highlight), menu = await openAnnotationMenu(page, before);
  await clickNativeMenu(page, menu, 'Link');
  const modal = page.locator('.modal-container').filter({ has: page.locator('.modal-title').filter({ hasText: /^Link to…$/ }) });
  await expect(modal).toBeVisible(); const quote = modal.getByLabel('Selected text', { exact: true });
  await expect(quote).toHaveValue(highlight.quote); await expect(quote).toHaveJSProperty('readOnly', true);
  await expect(modal.getByRole('button', { name: 'Choose note', exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(modal).toBeHidden();
  await assertCancelled(page, before);
  return { chooserFallback: true, quoteUnchanged: true, cancellationChangedNothing: true, noFileCreated: true };
}
/** Remove mark delimiters or unlink the CURRENT ordinary link; never reuse the old mark ID. */
export async function deleteViaMenu(page, article, reference) {
  const before = await beforeAction(page, article, reference), menu = await openAnnotationMenu(page, before);
  const expected = replacementBody(article.body, reference.source, before.syntax, reference.quote);
  await clickNativeMenu(page, menu, reference.kind === 'link' ? 'Unlink' : 'Remove highlight');
  await expect(menu).toBeHidden();
  await expect.poll(async () => parseMarkdown(await readMarkdown(article.path)).body).toBe(expected);
  const source = await readSettledMarkdown(page, article.path), deleted = await runtimeArticle(page, article.path);
  assertInlineWrite(before.source, source, expected, positionDelta(page, article.path, before.source, source)); assert.equal(deleted.body, expected);
  assert.equal(deleted.highlights.length, before.article.highlights.length - (reference.kind === 'link' ? 0 : 1));
  const attribute = reference.kind === 'link' ? 'data-inline-link-id' : 'data-inline-highlight-id';
  await expect(readerBody(page).locator(`[${attribute}=${JSON.stringify(reference.id)}]`)).toHaveCount(0);
  await assertCancelled(page, { ...before, source }); // Removal changes only this article, not companions or membership.
  return { source, article: deleted, highlightCount: deleted.highlights.length };
}
