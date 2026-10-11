import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { localDay, pluginId, vaultPath } from './sandbox.mjs';
import { parseMarkdown, readMarkdown, runtimeArticle } from './runtime-storage.mjs';
import { openCapturedMarkdown, readerLeaves } from './quickadd-ui.mjs';

// Reader-independent note creation: no QuickAdd dependency and no Reader capture
// method/template engine. Official QuickAdd behavior has its own integration test.
export async function createExternalTemplate(page, fixture) {
  const title = `${localDay().replaceAll('-', '').slice(2)} Reader external template ${fixture.tag}`;
  const path = `Reading/Inbox/${title}.md`;
  const comments = `## Comments\n\nMy synthetic personal writing must survive acquisition for ${fixture.tag}.\n\nQuoted title: "attention: carefully".\n\n---\nThis is ordinary body text, not a second frontmatter record.\n`;
  const fields = { type: 'article', url: fixture.articleURL, 'test-note': 'Preserve unknown template metadata' };
  const text = `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n## Article\n\n${comments}`;
  await assertRuntimeVault(page);
  const readersBefore = await readerLeaves(page); assert.ok(readersBefore.length, 'Per-leaf routing needs an existing Reader context');
  const intendedLeafId = await page.evaluate(async ({ vaultPath, path, text }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before external-template creation');
    if (app.vault.getAbstractFileByPath(path)) throw new Error('Refusing to overwrite an external template fixture');
    const file = await app.vault.create(path, text);
    const leaf = app.workspace.getLeaf('tab'); await leaf.openFile(file); return leaf.id;
  }, { vaultPath, path, text });
  await page.waitForFunction(({ path, intendedLeafId }) => {
    const leaf = window.app.workspace.activeLeaf, view = leaf?.view;
    return leaf?.id === intendedLeafId && view?.getViewType() === 'reader' && view.getState().file === path && view.getState().queue === 'inbox';
  }, { path, intendedLeafId });
  const readersAfter = await readerLeaves(page);
  assert.ok(readersBefore.every(leaf => leaf.leafId !== intendedLeafId), 'Core new-tab open reused another Reader leaf');
  for (const prior of readersBefore) assert.deepEqual(readersAfter.find(leaf => leaf.leafId === prior.leafId), prior, 'New-tab routing changed another Reader article/queue');
  const readerRouting = { intendedLeafId, readersBefore, readersAfter, otherReaderContextsPreserved: true };
  await openCapturedMarkdown(page, path);
  await expect.poll(async () => (await runtimeArticle(page, path)).extractor, { timeout: 20_000 }).toBe('dummy');
  const dummy = await readMarkdown(path);
  assertComments(dummy, comments, fixture.articleURL);
  assert.ok(dummy.includes('Dummy article — extraction is disabled'));
  assert.equal(fixture.evidence().requests.length, 0, 'An externally-created template must fill in default dummy mode without fetching its URL');
  const editor = await page.evaluate(() => {
    const view = window.app.workspace.activeLeaf?.view;
    return { type: view?.getViewType(), path: view?.file?.path, state: view?.getState(), cursor: view?.editor?.getCursor() };
  });
  assert.equal(editor.type, 'markdown');
  assert.equal(editor.path, path, 'Background acquisition must not steal the active source editor');
  assert.equal(editor.state.mode, 'source');
  return { path, title, comments, initialMarkdown: text, dummyMarkdown: dummy, editor, readerRouting,
    sourceEditorOpenedBy: 'Explicit Open Markdown after ordinary article routing; not a claimed QuickAdd command' };
}

function assertComments(markdown, comments, url) {
  const parsed = parseMarkdown(markdown);
  assert.equal(parsed.metadata.type, 'article');
  assert.equal(Object.hasOwn(parsed.metadata, 'status'), false);
  assert.equal(parsed.metadata.url, url);
  assert.equal(Object.hasOwn(parsed.metadata, 'created-by'), false);
  assert.equal(parsed.metadata['test-note'], 'Preserve unknown template metadata');
  assert.ok(markdown.endsWith(comments), 'Acquisition rewrote personal text outside the Article region');
  assert.equal((parsed.body.match(/^## Article$/gm) ?? []).length, 1);
  assert.equal((parsed.body.match(/^## Comments$/gm) ?? []).length, 1);
}

export async function verifyExternalTemplateLive(page, fixture, template) {
  await expect.poll(async () => (await runtimeArticle(page, template.path)).extractor, { timeout: 25_000 }).toBe('defuddle');
  const live = await readMarkdown(template.path);
  assertComments(live, template.comments, fixture.articleURL);
  const articleRegion = live.slice(live.indexOf('## Article\n') + '## Article\n'.length, live.indexOf('## Comments\n'));
  assert.ok(articleRegion.includes(fixture.quote), 'Real extraction did not fill the Article region');
  assert.ok(!articleRegion.includes('Dummy article — extraction is disabled'));
  assert.equal(fixture.evidence().requests.filter(request => request.path === fixture.articlePath).length, 1);
  assert.equal((await runtimeArticle(page, template.path)).content, 'ready');
  return { markdown: live, path: template.path, commentsPreserved: true, unknownMetadataPreserved: true, extractor: 'defuddle' };
}
