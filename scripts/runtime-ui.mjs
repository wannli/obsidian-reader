import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { pluginId } from './sandbox.mjs';
import { filterQueue } from './runtime-library.mjs';
import { nativeReaderCommand } from './runtime-native.mjs';
import { focusNativeWindow } from './runtime-menu.mjs';
import { annotationCompanions, assertCompanionsUnchanged, flushReaderPositions, parseMarkdown, readMarkdown, readSettledMarkdown, remapPositionEvidence, runtimeArticle } from './runtime-storage.mjs';

export async function commandReader(page) {
  await assertRuntimeVault(page); await flushReaderPositions(page); await nativeReaderCommand(page, 'open-reader');
  await expect(page.locator('.workspace-leaf.mod-active .r2-app')).toHaveCount(1);
  await expect(page.locator('.workspace-leaf.mod-active .r2-app')).toBeVisible();
}
export async function tab(page, status) { return filterQueue(page, status); }
export async function openArticle(page, title, status = 'inbox') {
  await flushReaderPositions(page);
  const picker = await tab(page, status); await picker.locator('.prompt-input').fill(title);
  const row = picker.locator('.suggestion-item').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  await expect(row).toHaveCount(1); await assertRuntimeVault(page); await row.click();
  await expect(page.locator('.workspace-leaf.mod-active .r2-app .r2-article-title')).toHaveText(title);
  await expect(page.locator('.workspace-leaf.mod-active .r2-app .r2-article-body')).toBeVisible(); await expect(picker).toBeHidden();
}
export async function highlightSelection(page, quote, { rejected } = {}) {
  if (!quote) throw new Error('A nonempty native fixture quote is required');
  await focusNativeWindow(page); await assertRuntimeVault(page);
  const body = page.locator('.workspace-leaf.mod-active .r2-app .r2-article-body');
  await expect(body).toHaveAttribute('data-highlight-count', /^\d+$/);
  const before = Number(await body.getAttribute('data-highlight-count'));
  await body.evaluate((root, quote) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node, matches = 0;
    while ((node = walker.nextNode())) {
      let offset = 0, next;
      while ((next = node.textContent.indexOf(quote, offset)) !== -1) { matches++; offset = next + 1; }
    }
    if (!quote || matches !== 1) throw new Error('Native fixture quote must have one unambiguous rendered occurrence');
  }, quote);
  await body.evaluate((root, quote) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node;
    while ((node = walker.nextNode())) if (node.textContent.includes(quote)) {
      if (getComputedStyle(node.parentElement).userSelect === 'none') throw new Error('Native article text is not user-selectable; DOM selection injection would mask this failure');
      node.parentElement.scrollIntoView({ block: 'center' }); root.closest('.r2-reader-scroll').focus({ preventScroll: true }); return;
    }
    throw new Error('Synthetic quote not found before native selection');
  }, quote);
  await page.waitForTimeout(200);
  const points = await body.evaluate((root, quote) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node;
    while ((node = walker.nextNode())) {
      const index = node.textContent.indexOf(quote); if (index < 0) continue;
      const point = offset => {
        const range = document.createRange(); range.setStart(node, offset); range.collapse(true);
        const rect = range.getBoundingClientRect(); return { x: rect.left + 0.2, y: rect.top + rect.height / 2 };
      };
      const start = point(index), end = point(index + quote.length), bounds = root.closest('.r2-reader-scroll').getBoundingClientRect();
      for (const p of [start, end]) if (p.x < bounds.left || p.x > Math.min(innerWidth, bounds.right) || p.y < Math.max(0, bounds.top) || p.y > Math.min(innerHeight, bounds.bottom)) throw new Error('Selection endpoint is not visible; refusing a misleading drag');
      return { start, end };
    }
    throw new Error('Quote disappeared before native drag');
  }, quote);
  // Ranges measure endpoints only. The native mouse gesture creates selection
  // and supplies its real down/up lifecycle, including after an Escape cancel.
  await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 16 }); await page.mouse.up();
  if (rejected) {
    await expect(page.locator('.workspace-leaf.mod-active .r2-save-state')).toHaveText('Not fully saved');
    await expect(page.locator('.workspace-leaf.mod-active .r2-error')).toHaveText(rejected);
    await expect(body).toHaveAttribute('data-highlight-count', String(before));
    return { before, after: before, rejected: await page.locator('.workspace-leaf.mod-active .r2-error').textContent(), points };
  }
  const after = before + 1; await expect(body).toHaveAttribute('data-highlight-count', String(after));
  await assertRuntimeVault(page); await expect(page.locator('.workspace-leaf.mod-active .r2-save-state')).toHaveText('Saved');
  return { before, after, trigger: 'Actual Chromium/Electron mouse drag and automatic settled-selection save', points };
}
export async function moveArticle(page, path, status) {
  await assertRuntimeVault(page);
  const current = await page.evaluate(() => window.app.workspace.activeLeaf?.view?.getState()); expect(current?.file).toBe(path);
  const markdown = await readSettledMarkdown(page, path), before = await runtimeArticle(page, path), companions = await annotationCompanions(page);
  expect(before.id).not.toBe(''); // These controlled fixtures carry stable IDs across a real rename.
  const findMoved = () => page.evaluate(async ({ pluginId, id }) =>
    (await window.app.plugins.plugins[pluginId].controller.repository.listArticles()).find(article => article.id === id), { pluginId, id: before.id });
  await nativeReaderCommand(page, 'move-to-' + status);
  await expect.poll(async () => (await findMoved())?.status).toBe(status);
  await expect.poll(async () => Object.hasOwn(parseMarkdown(await readMarkdown((await findMoved()).path)).metadata, 'queueMove')).toBe(false);
  const moved = await findMoved(), folders = { inbox: 'Inbox', later: 'Later', feed: 'Stream', archive: 'Treasury' };
  expect(moved.path.startsWith('Reading/' + folders[status] + '/')).toBe(true);
  expect(moved.body).toBe(before.body); expect(moved.highlights).toEqual(before.highlights);
  const movedMarkdown = await readMarkdown(moved.path);
  // A successful move is a byte-preserving rename. Production guards may refuse
  // reference-breaking moves; do not repair journals or bypass those refusals here.
  expect(movedMarkdown).toBe(markdown);
  remapPositionEvidence(page, path, moved.path);
  await assertCompanionsUnchanged(page, companions);
  if (moved.path !== path) expect(await page.evaluate(path => Boolean(window.app.vault.getAbstractFileByPath(path)), path)).toBe(false);
  // A queue command may advance the active leaf; callers must use this returned path, never the old path.
  return moved;
}
export async function assertPaint(page, quote) {
  await expect(page.locator('.workspace-leaf.mod-active .r2-app .r2-article-body')).toHaveAttribute('data-highlight-count', '1');
  const paint = await page.locator('.workspace-leaf.mod-active .r2-app .r2-article-body').evaluate((root, quote) => {
    const names = [];
    for (const [name, highlight] of CSS.highlights ?? []) if (name.startsWith('readerhl-') && [...highlight].some(range => root.contains(range.startContainer) && range.toString() === quote)) names.push(name);
    return { cssHighlights: names, overlayRectangles: root.parentElement.querySelectorAll('.reader-highlight-layer span').length };
  }, quote);
  expect(paint.cssHighlights.length + paint.overlayRectangles).toBeGreaterThan(0); return paint;
}
