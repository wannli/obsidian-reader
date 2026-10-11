#!/usr/bin/env node
// Focused native acceptance against the separately authorized dummy vault only.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { readBuild } from './artifacts.mjs';
import { assertRuntimeVault, connectToTestVault } from './cdp.mjs';
import { primaryLinkViaMenu, deleteViaMenu } from './runtime-actions.mjs';
import { captureSession } from './runtime-session.mjs';
import { verifyInstalledBuild, verifyReader } from './runtime-plugin.mjs';
import { annotationCompanions, assertCompanionsUnchanged, assertInlineWrite, parseMarkdown, positionDelta, readSettledMarkdown, runtimeArticle, verifySaved } from './runtime-storage.mjs';
import { commandReader, openArticle, highlightSelection, moveArticle } from './runtime-ui.mjs';
import { assertOwnedVault, createOnly, directory, runtimeTarget, sandboxPath } from './sandbox.mjs';

assert.equal(process.argv.length, 2, 'No arguments accepted');
assert.equal(runtimeTarget, 'acceptance', 'Use only the authorized Acceptance target');
await assertOwnedVault();
const build = await readBuild(); await verifyInstalledBuild(build);
const { page, browser } = await connectToTestVault();
const result = { status: 'running', buildId: build.metadata.buildId, version: build.metadata.plugin.version, checks: [], pageErrors: [], physicalIOS: 'NOT RUN', sync: 'NOT RUN' };
let evidence;
try {
  await captureSession(page); await verifyReader(page, result.buildId);
  await directory(join(sandboxPath, 'evidence'));
  evidence = await mkdtemp(join(sandboxPath, 'evidence', 'folder-queues-'));
  page.on('pageerror', error => result.pageErrors.push(String(error)));
  const article = await page.evaluate(async () => {
    const articles = await app.plugins.plugins['obsidian-reader'].controller.repository.listArticles();
    return articles.find(item => item.id === 'article-reader-synthetic-later');
  });
  assert.ok(article && article.status === 'later' && article.highlights.length === 0, 'Expected the fresh reset Later sample');
  assert.match(article.path, /^Reading\/Later\/\d{6} /);
  const originalMarkdown = await readSettledMarkdown(page, article.path), original = parseMarkdown(originalMarkdown);
  assert.equal(Object.hasOwn(original.metadata, 'status'), false);
  const companions = await annotationCompanions(page);
  await commandReader(page); await openArticle(page, article.title, 'later');
  const quote = 'This synthetic sample waits in Later';
  await highlightSelection(page, quote);
  const highlighted = await runtimeArticle(page, article.path);
  const saved = await verifySaved({ page, article: highlighted, originalMarkdown, quote, companions });
  result.checks.push('Actual native mouse selection inserted only inline delimiters; journals/legacy JSON unchanged');
  const moved = await moveArticle(page, article.path, 'archive');
  await openArticle(page, moved.title, 'archive');
  result.checks.push('Native Treasury command performed an exact Markdown rename through production collision/editor/reference guards');
  const linked = await primaryLinkViaMenu(page, moved, moved.highlights[0]);
  assert.equal(linked.noFileCreated, true); assert.notEqual(linked.link.id, saved.highlight.id);
  const unlinked = await deleteViaMenu(page, linked.article, linked.link);
  assert.equal(unlinked.article.body, article.body);
  result.checks.push('Native Link replaced the mark with an ordinary link; Unlink restored exact source words without remembered mark state');
  const returned = await moveArticle(page, moved.path, 'later');
  assert.equal(returned.path, article.path);
  const returnedMarkdown = await readSettledMarkdown(page, returned.path);
  assertInlineWrite(originalMarkdown, returnedMarkdown, original.body, positionDelta(page, returned.path, originalMarkdown, returnedMarkdown));
  // Annotation edits deliberately retain protected state even after all syntax is removed.
  assert.equal(returned.content, 'protected');
  await assertCompanionsUnchanged(page, companions);
  await openArticle(page, returned.title, 'later');
  await assertRuntimeVault(page);
  await createOnly(join(evidence, 'native-folder-queues.png'), await page.screenshot({ fullPage: true }));
  assert.deepEqual(result.pageErrors, []);
  result.checks.push('Returned sample to Later with original body/ownership/custom YAML intact, protected state retained, and journal bytes unchanged');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  if (evidence) await createOnly(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, evidence }, null, 2));
  await browser.close();
}
