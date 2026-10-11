import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { nativeReaderCommand } from './runtime-native.mjs';
import { runtimeArticle } from './runtime-storage.mjs';

const queueLabels = { inbox: 'Inbox', later: 'Later', feed: 'Stream', archive: 'Treasury' };

export function readingPicker(page) {
  return page.locator('.modal-container').filter({ has: page.locator('input[placeholder^="Reading list · "]') });
}
export async function openLibrary(page) {
  await assertRuntimeVault(page);
  const picker = readingPicker(page);
  if (!await picker.isVisible()) {
    await expect(page.locator('.modal-container')).toHaveCount(0);
    await nativeReaderCommand(page, 'reading-list');
  }
  await expect(picker).toBeVisible();
  await expect(picker.locator('.prompt-input')).toBeFocused();
  return picker;
}
export async function closeLibrary(page) {
  await assertRuntimeVault(page);
  const picker = readingPicker(page);
  if (await picker.isVisible()) await picker.locator('.prompt-input').press('Escape');
  await expect(picker).toBeHidden();
}
export async function filterQueue(page, status) {
  assert.ok(['inbox', 'later', 'archive', 'feed'].includes(status));
  await closeLibrary(page);
  await expect(page.locator('.modal-container')).toHaveCount(0);
  await nativeReaderCommand(page, 'switch-queue');
  const queue = page.locator('.modal-container').filter({ has: page.getByPlaceholder('Switch queue — does not move articles', { exact: true }) });
  await expect(queue).toBeVisible();
  await assertRuntimeVault(page);
  await queue.locator('.suggestion-item').filter({ hasText: new RegExp('^' + queueLabels[status] + '$') }).click();
  const picker = readingPicker(page);
  await expect(picker).toBeVisible();
  await expect(picker.locator('.prompt-input')).toHaveAttribute('placeholder', 'Reading list · ' + queueLabels[status]);
  return picker;
}

export async function verifyNativeLibrary(page, article) {
  await closeLibrary(page);
  const scroller = page.locator('.workspace-leaf.mod-active .r2-reader-scroll');
  await scroller.evaluate(element => { element.scrollTop = Math.max(0, Math.min(140, element.scrollHeight - element.clientHeight)); });
  const state = () => page.evaluate(() => {
    const leaf = window.app.workspace.activeLeaf, reading = leaf.containerEl.querySelector('.r2-reading-page'), bounds = reading.getBoundingClientRect();
    return { leafId: leaf.id, state: leaf.view.getState(), x: bounds.x, width: bounds.width,
      scrollTop: leaf.containerEl.querySelector('.r2-reader-scroll').scrollTop };
  });
  const before = await state();
  const picker = await openLibrary(page);
  assert.deepEqual(await state(), before, 'Opening the native picker changed the reading leaf/queue/layout/scroll');
  assert.equal(await picker.evaluate(element => element.contains(document.activeElement)), true);
  await closeLibrary(page);
  for (const status of ['inbox', 'later', 'archive', 'feed']) {
    await filterQueue(page, status);
    assert.equal((await runtimeArticle(page, article.path)).status, article.status, 'A picker filter moved the article');
    assert.deepEqual(await state(), before, 'A picker filter changed the active reading context before article selection');
    await closeLibrary(page);
  }
  assert.deepEqual(await state(), before);
  return { nativeCommands: ['reading-list', 'switch-queue'], filteringDidNotMoveArticle: true,
    filteringDidNotChangeReadingQueue: true, cancelPreservedLeafAndScroll: true, scrollTop: before.scrollTop };
}
