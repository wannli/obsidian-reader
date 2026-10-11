import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { captureFromCommand, captureFromURI, markdownPaths, quickAddCommand } from './quickadd-ui.mjs';
import { readMarkdown } from './runtime-storage.mjs';
import { assertIsolatedReaderAbsent } from './quickadd-isolation.mjs';
import { vaultPath } from './sandbox.mjs';

export async function nativeQuickAddContracts(page, fixture, options = {}) {
  const beforeCancel = await markdownPaths(page), modal = await quickAddCommand(page, options);
  if (options.opening === 'native') await assertIsolatedReaderAbsent(page);
  await modal.locator('input[type="text"]').first().fill(fixture.articleURL);
  await assertRuntimeVault(page);
  if (options.opening === 'native') await assertIsolatedReaderAbsent(page);
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  assert.deepEqual(await markdownPaths(page), beforeCancel, 'Cancelling native QuickAdd created a note');
  options.onCase?.({ name: 'native-command-cancel', status: 'passed' });
  const url = fixture.articleURL + '?q=100%25&tag=a:b';
  const articleTitle = '../../outside: "quoted": value';
  const comments = `Personal first line ${fixture.tag}\n\n{{DATE}} <% throw new Error('must not run') %>\n## Personal heading\nKeep this text.`;
  const command = await captureFromCommand(page, { url, articleTitle, comments }, options);
  assert.equal(command.metadata.url, url); assert.equal(command.metadata.title, articleTitle);
  assert.equal(command.metadata.status, undefined); assert.ok(command.text.includes(comments));
  assert.ok(!command.path.includes('outside'), 'Untrusted title controlled the capture filename');
  options.onCase?.({ name: 'native-command-hostile-values', status: 'passed', path: command.path });
  const uriTitle = 'Another "title": value\nstatus: archive';
  const uri = await captureFromURI(page, { url, articleTitle: uriTitle, comments: 'URI capture stays distinct.' }, 'Reader article', options);
  assert.equal(uri.metadata.url, url); assert.equal(uri.metadata.title, uriTitle); assert.ok(uri.text.includes('URI capture stays distinct.'));
  assert.notEqual(uri.path, command.path, 'Native QuickAdd must not overwrite an existing capture with the same URL');
  assert.equal(await readMarkdown(command.path), command.text, 'Repeated URL capture overwrote the previous source');
  options.onCase?.({ name: 'registered-uri-escaping-distinct-url-duplicate', status: 'passed', path: uri.path, osDelivery: 'NOT RUN' });
  const blank = await captureFromURI(page, { url: fixture.articleURL, articleTitle: '', comments: '' }, 'Reader article', options);
  assert.equal(blank.metadata.title, '');
  options.onCase?.({ name: 'blank-optional-fields', status: 'passed', path: blank.path });
  for (const capture of [command, uri, blank]) {
    assert.equal(capture.metadata.status, undefined, 'Queue belongs to the folder, not generated YAML');
    assert.match(capture.path, /^Reading\/Inbox\/\d{6} Article \d{2}-\d{2}-\d{2}-\d{3}(?: \(\d+\))?\.md$/, 'Expected the safe date-leading native filename in Inbox');
  }
  const original = await page.evaluate(async ({ vaultPath, tag, opening }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before collision test configuration');
    if (opening === 'native' && ['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) throw new Error('Reader appeared before isolated collision test configuration');
    const plugin = app.plugins.plugins.quickadd, choice = plugin.settings.choices.find(choice => choice.id === 'reader-article-template');
    const original = structuredClone(choice.fileNameFormat);
    choice.fileNameFormat = { enabled: true, format: `Article collision ${tag}` };
    await plugin.saveSettings();
    return original;
  }, { vaultPath, tag: fixture.tag, opening: options.opening });
  let collisionA, collisionB;
  try {
    collisionA = await captureFromURI(page, { url: fixture.articleURL, articleTitle: 'Collision one', comments: 'First collision content.' }, 'Reader article', options);
    collisionB = await captureFromURI(page, { url: fixture.articleURL, articleTitle: 'Collision two', comments: 'Second collision content.' }, 'Reader article', options);
    assert.notEqual(collisionA.path, collisionB.path);
    for (const capture of [collisionA, collisionB]) {
      assert.equal(capture.metadata.status, undefined);
      assert.ok(capture.path.startsWith('Reading/Inbox/'));
    }
    assert.ok(collisionA.path.includes(`Article collision ${fixture.tag}`) && collisionB.path.includes(`Article collision ${fixture.tag}`));
    assert.equal(await readMarkdown(collisionA.path), collisionA.text, 'Filename collision overwrote the first capture');
    assert.ok(collisionB.text.includes('Second collision content.'));
    options.onCase?.({ name: 'native-filename-collision-no-overwrite', status: 'passed', paths: [collisionA.path, collisionB.path] });
  } finally {
    await assertRuntimeVault(page);
    await page.evaluate(async ({ vaultPath, original, opening }) => {
      const app = window.app;
      if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before collision test restoration');
      if (opening === 'native' && ['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) throw new Error('Reader appeared before isolated collision test restoration');
      const plugin = app.plugins.plugins.quickadd;
      plugin.settings.choices.find(choice => choice.id === 'reader-article-template').fileNameFormat = original;
      await plugin.saveSettings();
    }, { vaultPath, original, opening: options.opening });
  }
  assert.equal(fixture.evidence().requests.length, 0, 'Offline native capture must not fetch article HTML');
  return { cancellationCreatedNothing: true, command, uri, blank, collisions: [collisionA, collisionB], all: [command, uri, blank, collisionA, collisionB] };
}
