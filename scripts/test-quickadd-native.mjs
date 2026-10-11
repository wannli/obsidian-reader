#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstat, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './artifacts.mjs';
import { assertRuntimeVault, connectToTestVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { nativeQuickAddContracts } from './quickadd-contracts.mjs';
import { assertIsolatedReaderAbsent, bundleSnapshot, prepareIsolatedChoices, restoreIsolatedChoices, restoreIsolatedWorkspace, unloadReaderForIsolation } from './quickadd-isolation.mjs';
import { captureFromURI, markdownPaths } from './quickadd-ui.mjs';
import { verifyPinnedQuickAdd } from './quickadd-pin.mjs';
import { startRuntimeFixture } from './runtime-fixture.mjs';
import { scopedNetwork } from './runtime-network.mjs';
import { captureSession } from './runtime-session.mjs';
import { assertOwnedVault, createOnly, directory, inside, pluginPath, regularFile, sandboxPath, vaultPath } from './sandbox.mjs';

if (process.argv.length !== 2) throw new Error('Only isolated native QuickAdd in the marked Reader vault is allowed');
await assertNoSafetyHold('default-vault UI/testing/restoration entrypoint');
await assertOwnedVault();
const quickadd = await verifyPinnedQuickAdd(), beforeBuild = await bundleSnapshot();
const { browser, page } = await connectToTestVault();
try { await assertIsolatedReaderAbsent(page); }
catch (error) { await browser.close(); throw error; }
await directory(join(sandboxPath, 'evidence'));
const evidence = await mkdtemp(join(sandboxPath, 'evidence', 'quickadd-native-'));
let fixture, network, isolation, baseline, session;
const result = { status: 'running', startedAt: new Date().toISOString(), evidence, vaultPath, quickadd, beforeBuild, pageErrors: [], caseProgress: [],
  scope: 'Isolated real native QuickAdd; Reader unloaded; current delivered templates copied byte-for-byte into a temporary folder; canonical templates not repaired/overwritten',
  acceptance: { readerHandoff: 'NOT RUN; awaits coherent latest Reader build', sourceCursor: 'NOT APPLICABLE: confirmed assets use default mode and omit cursor tokens', physicalIOS: 'NOT RUN', osURIRouting: 'NOT RUN', sync: 'NOT RUN' } };
async function snapshotExisting() {
  const snapshot = {};
  for (const path of await markdownPaths(page)) {
    const full = inside(vaultPath, join(vaultPath, path));
    snapshot[path] = { sha256: sha256(await regularFile(full)), mtimeMs: (await lstat(full)).mtimeMs };
  }
  return snapshot;
}
async function screenshot(name) {
  await assertRuntimeVault(page);
  await createOnly(join(evidence, name + '.png'), await page.screenshot({ fullPage: true }));
}
try {
  page.setDefaultTimeout(15_000); page.on('pageerror', error => result.pageErrors.push(String(error.stack ?? error)));
  assert.equal(await page.locator('.modal-container').count(), 0, 'An existing host dialog is open; postpone QA instead of dismissing it');
  await assertIsolatedReaderAbsent(page);
  assert.equal(await page.evaluate(() => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)), false, 'An existing native input is focused; postpone rather than interrupt it');
  session = await captureSession(page);
  result.workspaceBefore = { activeLeafId: session.activeLeafId, leafIds: session.leafIds, editors: session.editors.map(editor => ({ path: editor.file, sha256: sha256(editor.text) })) };
  result.readerBefore = await unloadReaderForIsolation(page);
  await createOnly(join(evidence, 'before.json'), JSON.stringify({ beforeBuild, reader: result.readerBefore, quickadd }, null, 2) + '\n');
  const readerData = await regularFile(join(pluginPath, 'data.json'));
  result.readerSettingsBefore = sha256(readerData);
  baseline = await snapshotExisting();
  await createOnly(join(evidence, 'existing-markdown-before.json'), JSON.stringify(baseline, null, 2) + '\n');
  await assertIsolatedReaderAbsent(page);
  network = await scopedNetwork(page); await assertIsolatedReaderAbsent(page); await network.setOffline(true);
  fixture = await startRuntimeFixture();
  isolation = await prepareIsolatedChoices(page, fixture.tag, evidence);
  result.isolation = isolation;
  await page.bringToFront();
  result.cases = await nativeQuickAddContracts(page, fixture, { opening: 'native', onCase: item => result.caseProgress.push(item) });
  result.quickChoice = await captureFromURI(page, { url: fixture.articleURL }, 'Reader article quick', { opening: 'native' });
  await screenshot('native-capture-default-opening');
  assert.equal(fixture.evidence().requests.length, 0, 'Native capture unexpectedly requested the article origin');
  assert.deepEqual(result.pageErrors, []);
  assert.equal(sha256(await regularFile(join(pluginPath, 'data.json'))), result.readerSettingsBefore, 'Isolated QuickAdd testing changed Reader settings');
  result.status = 'passed';
} catch (error) {
  if (!isolation && error.isolation) isolation = error.isolation;
  result.status = 'failed'; result.error = String(error.stack ?? error); process.exitCode = 1;
  try { await screenshot('failure'); } catch (error) { result.screenshotError = String(error); }
} finally {
  try {
    if (isolation) {
      await assertIsolatedReaderAbsent(page);
      const prompt = page.locator('.modal-container').filter({ hasText: 'Provide inputs' });
      if (await prompt.count() === 1) await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await page.locator('.modal-container').count(), 0, 'A remaining native dialog needs inspection; retain its temporary choices/templates');
      result.cleanup = await restoreIsolatedChoices(page, isolation);
    }
  } catch (error) { result.status = 'failed'; result.choiceRestoreError = String(error.stack ?? error); process.exitCode = 1; }
  try { if (network) { await assertIsolatedReaderAbsent(page); await network.restore(); } }
  catch (error) { result.status = 'failed'; result.networkRestoreError = String(error); process.exitCode = 1; }
  if (fixture) await fixture.stop();
  try {
    if (baseline) {
      const after = await snapshotExisting();
      for (const [path, before] of Object.entries(baseline)) assert.deepEqual(after[path], before, `Existing note changed during isolated QuickAdd testing: ${path}`);
      result.createdNotes = Object.keys(after).filter(path => !Object.hasOwn(baseline, path));
      result.existingMarkdownUnchanged = true;
      if (session) result.workspaceRestored = await restoreIsolatedWorkspace(page, session, result.createdNotes.filter(path => path.startsWith('Reading/Inbox/')));
    }
    if (result.readerSettingsBefore) {
      result.readerSettingsAfter = sha256(await regularFile(join(pluginPath, 'data.json')));
      assert.equal(result.readerSettingsAfter, result.readerSettingsBefore, 'Native-only QA changed Reader settings');
    }
    if (isolation && result.cleanup?.choicesRestored) {
      const before = JSON.parse(await regularFile(join(evidence, 'quickadd-config-before.json')));
      const after = JSON.parse(await regularFile(join(vaultPath, '.obsidian/plugins/quickadd/data.json')));
      assert.deepEqual(after, before, 'QuickAdd configuration differs after choice restoration');
      result.quickAddConfigurationRestored = true;
    }
    result.afterBuild = await bundleSnapshot(); assert.deepEqual(result.afterBuild, beforeBuild, 'Reader/dist artifacts changed during isolated native tests');
    await verifyPinnedQuickAdd();
    await assertIsolatedReaderAbsent(page);
    result.readerLoadedAfter = false;
  } catch (error) { result.status = 'failed'; result.cleanupError = String(error.stack ?? error); process.exitCode = 1; }
  if (fixture) { await fixture.stop(); result.fixture = fixture.evidence(); }
  result.finishedAt = new Date().toISOString();
  try {
    await createOnly(join(evidence, 'runtime.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ status: result.status, evidence, readerBefore: result.readerBefore, readerLoadedAfter: result.readerLoadedAfter,
      createdNotes: result.createdNotes, cleanup: result.cleanup, workspaceRestored: result.workspaceRestored, caseProgress: result.caseProgress,
      error: result.error, cleanupError: result.cleanupError,
      choiceRestoreError: result.choiceRestoreError, networkRestoreError: result.networkRestoreError, acceptance: result.acceptance }, null, 2));
  } finally { await browser.close(); }
}
