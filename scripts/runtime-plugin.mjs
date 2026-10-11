import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { sha256 } from './artifacts.mjs';
import { verifyAllowedPlugins } from './quickadd-pin.mjs';
import { assertRuntimeVault } from './cdp.mjs';
import { flushReaderPositions } from './runtime-storage.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { assertNoLegacyPlugin, pluginFiles, pluginId, pluginPath, regularFile, repository, vaultPath } from './sandbox.mjs';

export async function verifyInstalledBuild(build, options) {
  await assertNoSafetyHold('default-vault runtime build verification/activation');
  const installed = {};
  for (const name of pluginFiles) {
    installed[name] = sha256(await regularFile(join(pluginPath, name)));
    assert.equal(installed[name], build.metadata.artifacts[name].sha256, `Installed ${name} is stale; run npm run vault:update`);
  }
  await verifyBuildInputs(build);
  await verifyAllowedPlugins(options);
  return installed;
}

export async function verifyBuildInputs(build) {
  for (const [input, hash] of Object.entries(build.metadata.inputs ?? {})) {
    assert.equal(sha256(await regularFile(resolve(repository, input))), hash, `Source changed since this build: ${input}; run npm run build, then npm run vault:update`);
  }
  for (const name of ['manifest.json', 'styles.css']) {
    assert.equal(sha256(await regularFile(join(repository, name))), build.metadata.artifacts[name].sha256, `${name} changed since build`);
  }
}

export async function assertNoLegacyRuntimePlugin(page, expectedVault = vaultPath) {
  await page.evaluate(expectedVault => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== expectedVault) throw new Error('Vault changed during plugin identity check');
    for (const id of ['pullman', 'obsidian-reader2']) {
      if (app.plugins.plugins[id] || app.plugins.manifests?.[id] || app.plugins.enabledPlugins.has(id)) {
        throw new Error(`Legacy ${id} plugin exists; explicit migration approval required before activating Reader`);
      }
    }
  }, expectedVault);
}

export async function enableReader(page, buildId) {
  await assertNoSafetyHold('enable Reader');
  await assertNoLegacyPlugin();
  await assertNoLegacyRuntimePlugin(page);
  await assertRuntimeVault(page);
  await page.evaluate(async ({ vaultPath, pluginId, buildId }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before Reader shutdown');
    const loaded = app.plugins.plugins[pluginId];
    if (loaded && loaded.constructor.__readerBuildId !== buildId) await app.plugins.disablePlugin(pluginId);
    await app[Symbol.for('reader.shutdown')];
  }, { vaultPath, pluginId, buildId });
  await assertNoSafetyHold('enable Reader after shutdown barrier');
  await assertNoLegacyPlugin();
  await assertNoLegacyRuntimePlugin(page);
  await assertRuntimeVault(page);
  await page.evaluate(async ({ vaultPath, pluginId }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before Reader activation');
    await app.plugins.enablePluginAndSave(pluginId); await app.plugins.saveConfig();
  }, { vaultPath, pluginId });
  return verifyReader(page, buildId);
}

export async function verifyReader(page, buildId, { requireFixtureDefaults = true } = {}) {
  await assertNoSafetyHold('verify an enabled default-vault Reader runtime');
  await page.waitForFunction(() => typeof window.app?.vault?.adapter?.getBasePath === 'function');
  await assertRuntimeVault(page);
  await page.waitForFunction(id => Boolean(window.app.plugins.plugins[id]?.controller), pluginId);
  const result = await page.evaluate(({ pluginId }) => {
    const app = window.app, plugin = app.plugins.plugins[pluginId];
    return {
      vaultPath: app.vault.adapter.getBasePath(), manifest: plugin.manifest,
      buildId: plugin.constructor.__readerBuildId, enabled: app.plugins.enabledPlugins.has(pluginId),
      controllerMethods: ['capture', 'move', 'highlight', 'linkHighlight', 'deleteHighlight', 'setLinkTarget', 'unlink', 'acquire', 'refreshFeeds'].filter(name => typeof plugin.controller[name] === 'function'),
      settings: plugin.settings,
      daily: { enabled: app.internalPlugins.plugins['daily-notes']?.enabled, options: app.internalPlugins.plugins['daily-notes']?.instance?.options },
      userAgent: navigator.userAgent,
    };
  }, { pluginId });
  assert.equal(result.vaultPath, vaultPath);
  assert.equal(result.manifest.id, pluginId);
  assert.equal(result.buildId, buildId, 'Loaded constructor differs from the installed build identity');
  assert.equal(result.enabled, true, 'Plugin enablement is not persisted');
  assert.equal(result.controllerMethods.length, 9, 'Inline highlight/link/unlink controller API is required');
  if (!requireFixtureDefaults) return result;
  assert.equal(result.settings.articlesFolder, 'Reading/Articles'); // Legacy inference, not the capture destination.
  assert.equal(result.settings.feedsFolder, 'Reading/Wires');
  // Core Daily notes is optional and its existing configuration is observational
  // only. Annotation scenarios assert journal bytes/membership stay unchanged.
  // Legacy plugin settings may still be loaded, but must never cause copy writes.
  return result;
}

export async function reloadReader(page, buildId) {
  await assertNoSafetyHold('reload Reader');
  await assertRuntimeVault(page); await flushReaderPositions(page);
  await page.evaluate(async ({ vaultPath, pluginId }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before plugin reload');
    await app.plugins.disablePlugin(pluginId); await app[Symbol.for('reader.shutdown')];
  }, { vaultPath, pluginId });
  return enableReader(page, buildId);
}
