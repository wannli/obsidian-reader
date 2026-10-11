import assert from 'node:assert/strict';
import { assertRuntimeVault, connectToTestVault } from './cdp.mjs';
import { captureSession, restoreSession } from './runtime-session.mjs';
import { assertNoLegacyRuntimePlugin, verifyReader } from './runtime-plugin.mjs';
import { pluginId as defaultPluginId, vaultPath as defaultVaultPath } from './sandbox.mjs';

export async function releaseInstallRuntime() {
  return createReleaseInstallRuntime(await connectToTestVault());
}

// Production callers supply only their independently verified, fixed sandbox.
// This lets a worktree control a local-main reload without targeting its own vault.
export function createReleaseInstallRuntime({ browser, page }, tools = { assertRuntimeVault, captureSession, restoreSession, verifyReader },
  { pluginId = defaultPluginId, vaultPath = defaultVaultPath } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const guard = async () => { await tools.assertRuntimeVault(page); await assertNoLegacyRuntimePlugin(page, vaultPath); };
  return {
    guard,
    async capture() {
      await guard();
      const enabled = await page.evaluate(async id => {
        const app = window.app;
        const persisted = JSON.parse(await app.vault.adapter.read('.obsidian/community-plugins.json'));
        return Array.isArray(persisted) && persisted.includes(id) && Boolean(app.plugins.plugins[id]) && app.plugins.enabledPlugins.has(id);
      }, pluginId);
      assert.equal(enabled, true, 'Reader must already be loaded and enabled; installer will not alter enablement settings');
      return tools.captureSession(page);
    },
    async unload() {
      await guard();
      await page.evaluate(async ({ pluginId, vaultPath }) => {
        const app = window.app;
        if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before shutdown');
        const plugin = app.plugins.plugins[pluginId];
        plugin?.controller?.setActive(false);
        if (plugin) await app.plugins.disablePlugin(pluginId);
        await app[Symbol.for('reader.shutdown')];
        if (app.plugins.plugins[pluginId]) throw new Error('Reader did not unload');
      }, { pluginId, vaultPath });
    },
    async activate() {
      await guard();
      await page.evaluate(async ({ pluginId, vaultPath }) => {
        const app = window.app;
        if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before activation');
        // disablePlugin may remove runtime enabledPlugins membership; persisted
        // enablement was checked at capture and is byte-checked by the transaction.
        await app.plugins.loadManifests();
        // enablePlugin, not enablePluginAndSave: persisted enablement is unchanged.
        if (typeof app.plugins.enablePlugin !== 'function') throw new Error('Runtime-only plugin activation API unavailable');
        await app.plugins.enablePlugin(pluginId);
        const plugin = app.plugins.plugins[pluginId];
        if (!plugin) throw new Error('Released plugin failed to load');
        plugin.controller?.setActive(false);
        if (!plugin.storagePreparation || typeof plugin.storagePreparation.then !== 'function') throw new Error('Cannot verify startup conversion outcome');
        const prepared = await plugin.storagePreparation;
        if (!Array.isArray(prepared?.errors)) throw new Error('Unknown startup conversion result');
        if (prepared.errors.length) throw new Error('Storage preparation errors: ' + prepared.errors.join('\n'));
      }, { pluginId, vaultPath });
    },
    verify: buildId => tools.verifyReader(page, buildId, { requireFixtureDefaults: false }),
    restore: session => tools.restoreSession(page, session),
    async assertClean() { assert.deepEqual(errors, [], 'Renderer errors during release installation'); },
    async resume() {
      await guard();
      await page.evaluate(({ pluginId, vaultPath }) => {
        if (window.app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before resume');
        window.app.plugins.plugins[pluginId]?.controller.setActive(!document.hidden);
      }, { pluginId, vaultPath });
    },
    async state() {
      await guard();
      return page.evaluate(async id => ({ loaded: Boolean(window.app.plugins.plugins[id]),
        runtimeEnabled: window.app.plugins.enabledPlugins.has(id),
        persistedEnabled: JSON.parse(await window.app.vault.adapter.read('.obsidian/community-plugins.json')).includes(id),
      }), pluginId);
    },
    close: () => browser.close(),
  };
}
