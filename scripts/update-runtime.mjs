#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { readBuild } from './artifacts.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { assertRuntimeVault, connectToTestVault } from './cdp.mjs';
import { assertNoLegacyRuntimePlugin, verifyBuildInputs, verifyInstalledBuild, verifyReader } from './runtime-plugin.mjs';
import { captureSession, restoreSession, snapshotNotesAndSettings } from './runtime-session.mjs';
import { assertNoLegacyPlugin, assertOwnedVault, createOnly, directory, isMain, pluginId, sandboxPath, vaultPath } from './sandbox.mjs';
import { updatePlugin } from './setup-vault.mjs';

export async function updateRunningTestPlugin() {
  await assertNoSafetyHold('scoped default-vault update/reload');
  await assertOwnedVault();
  await assertNoLegacyPlugin();
  const build = await readBuild(); await verifyBuildInputs(build);
  const { browser, page } = await connectToTestVault();
  let result, failure, update, session, paused = false;
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error.stack ?? error)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  try {
    await assertRuntimeVault(page);
    await assertNoLegacyRuntimePlugin(page);
    session = await captureSession(page); // Refuses dirty editors/open dialogs without touching them.
    paused = true;
    const wasLoaded = await page.evaluate(async ({ pluginId, vaultPath }) => {
      const app = window.app;
      if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before plugin shutdown');
      const plugin = app.plugins.plugins[pluginId], loaded = Boolean(plugin);
      plugin?.controller.setActive(false);
      if (loaded) await app.plugins.disablePlugin(pluginId);
      await app[Symbol.for('reader.shutdown')];
      if (app.plugins.plugins[pluginId]) throw new Error('Reader did not unload; refusing to replace a running bundle');
      return loaded;
    }, { pluginId, vaultPath });
    const before = await snapshotNotesAndSettings(page);
    await verifyBuildInputs(build); // Fail before copying if an owner resumed editing.
    update = await updatePlugin();
    const installed = await verifyInstalledBuild(build, { requireReaderEnabled: false }); // Hash verification while Reader is deliberately unloaded.
    await assertRuntimeVault(page);
    await assertNoSafetyHold('activate updated Reader');
    await assertNoLegacyPlugin();
    await assertNoLegacyRuntimePlugin(page);
    await page.evaluate(async ({ vaultPath, pluginId }) => {
      const app = window.app;
      if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before Reader-only activation');
      await app.plugins.loadManifests();
      await app.plugins.enablePluginAndSave(pluginId); await app.plugins.saveConfig();
      app.plugins.plugins[pluginId]?.controller.setActive(false);
    }, { vaultPath, pluginId });
    const runtime = await verifyReader(page, build.metadata.buildId, { requireFixtureDefaults: false });
    const restored = await restoreSession(page, session);
    assert.deepEqual(await snapshotNotesAndSettings(page), before, 'Current Markdown or Reader settings changed during the scoped refresh');
    const commands = await page.evaluate(pluginId => Object.entries(window.app.commands.commands)
      .filter(([id]) => id.startsWith(pluginId + ':')).map(([id, command]) => ({ id, name: command.name, contextGuard: typeof command.checkCallback === 'function' })), pluginId);
    assert.deepEqual(pageErrors, [], 'Uncaught renderer error during targeted reload');
    result = { status: 'passed', vaultPath, buildId: build.metadata.buildId, wasLoaded, previousBuildId: session.loadedBuildId,
      backup: update.backup, updated: update.updated, installed, loadedBuildId: runtime.buildId, restartedApplication: false,
      restoredSession: restored, markdownFilesPreserved: Object.keys(before.files).length, settings: runtime.settings,
      commands, pageErrors, consoleErrors, scope: 'Reader-only refresh and state-preservation smoke, not full feature acceptance' };
  } catch (error) {
    failure = error;
    result = { status: 'failed', vaultPath, buildId: build.metadata.buildId, backup: update?.backup, error: String(error.stack ?? error),
      pageErrors, consoleErrors,
      note: 'Only Reader was eligible for unload. No native buffer is overwritten, no mode is toggled, and no app restart or unrelated-plugin change is attempted.' };
  } finally {
    if (paused) {
      try {
        await assertNoSafetyHold('finally resume Reader acquisition');
        await assertRuntimeVault(page);
        await page.evaluate(pluginId => window.app.plugins.plugins[pluginId]?.controller.setActive(!document.hidden), pluginId);
      } catch (error) { result.status = 'failed'; result.resumeError = String(error); failure ??= error; }
    }
    try {
      const root = join(sandboxPath, 'evidence'); await directory(root);
      const evidence = await mkdtemp(join(root, 'installation-'));
      if (result.status === 'passed') {
        try {
          await assertRuntimeVault(page);
          await createOnly(join(evidence, 'refreshed-view.png'), await page.screenshot({ fullPage: true }));
          result.screenshot = join(evidence, 'refreshed-view.png');
          assert.deepEqual(pageErrors, []);
        } catch (error) { result.status = 'failed'; result.smokeError = String(error); failure ??= error; }
      }
      await createOnly(join(evidence, 'installation.json'), `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify({ ...result, evidence }, null, 2));
    } finally { await browser.close(); }
  }
  if (failure) throw failure;
  return result;
}

if (isMain(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('No arguments accepted; update is restricted to Reader in the fixed verified test vault');
  await updateRunningTestPlugin();
}
