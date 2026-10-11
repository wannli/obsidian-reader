import assert from 'node:assert/strict';
import test from 'node:test';
import { createReleaseInstallRuntime } from './release-install-runtime.mjs';
import { vaultPath } from './sandbox.mjs';

async function mockedRuntime(run, targetVault = vaultPath) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const persisted = '["obsidian-reader","another-plugin"]', events = [], buildId = 'a'.repeat(64);
  const plugin = { controller: { setActive: active => events.push(['active', active]) }, storagePreparation: Promise.resolve({ errors: [] }) };
  const app = { vault: { adapter: { getBasePath: () => targetVault, read: async path => {
    assert.equal(path, '.obsidian/community-plugins.json'); return persisted;
  } } }, plugins: {
    plugins: { 'obsidian-reader': plugin }, enabledPlugins: new Set(['obsidian-reader', 'another-plugin']),
    async disablePlugin(id) {
      assert.equal(id, 'obsidian-reader'); events.push(['disable', id]);
      this.enabledPlugins.delete(id); delete this.plugins[id];
      app[Symbol.for('reader.shutdown')] = Promise.resolve();
    },
    async loadManifests() { events.push(['manifests']); },
    async enablePlugin(id) { assert.equal(id, 'obsidian-reader'); events.push(['enable', id]); this.plugins[id] = plugin; this.enabledPlugins.add(id); },
    enablePluginAndSave() { throw new Error('Must not save enablement'); }, saveConfig() { throw new Error('Must not save config'); },
  } };
  globalThis.window = { app }; globalThis.document = { hidden: false };
  const page = { on() {}, evaluate: async (fn, args) => fn(args) };
  const tools = {
    assertRuntimeVault: async () => assert.equal(app.vault.adapter.getBasePath(), targetVault),
    captureSession: async () => ({ fixture: true }), restoreSession: async () => ({ restored: true }),
    verifyReader: async (_page, expected) => {
      assert.equal(expected, buildId); assert.equal(app.plugins.enabledPlugins.has('obsidian-reader'), true);
      return { buildId, manifest: { version: '0.1.9' } };
    },
  };
  const runtime = createReleaseInstallRuntime({ page, browser: { close: async () => events.push(['close']) } }, tools,
    targetVault === vaultPath ? undefined : { pluginId: 'obsidian-reader', vaultPath: targetVault });
  try { await run({ runtime, app, plugin, events, buildId, persisted }); }
  finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
}

test('runtime unload may remove enabled set membership; activation restores it without persisting settings', () => mockedRuntime(async ({ runtime, app, events, buildId, persisted }) => {
  const session = await runtime.capture();
  await runtime.unload();
  assert.equal(app.plugins.enabledPlugins.has('obsidian-reader'), false);
  assert.deepEqual(await runtime.state(), { loaded: false, runtimeEnabled: false, persistedEnabled: true });
  await runtime.activate(); await runtime.verify(buildId); await runtime.restore(session); await runtime.resume();
  assert.deepEqual(await runtime.state(), { loaded: true, runtimeEnabled: true, persistedEnabled: true });
  assert.equal(await app.vault.adapter.read('.obsidian/community-plugins.json'), persisted);
  assert.equal(events.filter(([name]) => name === 'enable').length, 1);
  await runtime.close();
}));

test('verified caller context, not the controller worktree, determines runtime vault checks', () => mockedRuntime(async ({ runtime, buildId }) => {
  const session = await runtime.capture();
  await runtime.unload(); await runtime.activate(); await runtime.verify(buildId);
  await runtime.restore(session); await runtime.resume(); await runtime.close();
}, '/fixed/acceptance-fixture'));

test('runtime requires original persisted and runtime enablement', () => mockedRuntime(async ({ runtime, app }) => {
  app.plugins.enabledPlugins.delete('obsidian-reader');
  await assert.rejects(runtime.capture(), /already be loaded and enabled/);
  app.plugins.enabledPlugins.add('obsidian-reader'); app.vault.adapter.read = async () => '["another-plugin"]';
  await assert.rejects(runtime.capture(), /already be loaded and enabled/);
}));

for (const legacy of ['pullman', 'obsidian-reader2']) for (const identity of ['loaded', 'enabled', 'manifest']) test(`runtime refuses legacy ${legacy} identity: ` + identity, () => mockedRuntime(async ({ runtime, app, events }) => {
  if (identity === 'loaded') app.plugins.plugins[legacy] = {};
  if (identity === 'enabled') app.plugins.enabledPlugins.add(legacy);
  if (identity === 'manifest') app.plugins.manifests = { [legacy]: {} };
  await assert.rejects(runtime.capture(), /Legacy (?:pullman|obsidian-reader2) plugin exists/);
  await assert.rejects(runtime.activate(), /Legacy (?:pullman|obsidian-reader2) plugin exists/);
  assert.deepEqual(events, []);
}));

test('runtime surfaces startup conversion errors and refuses changed vault', () => mockedRuntime(async ({ runtime, app, plugin }) => {
  await runtime.capture(); await runtime.unload();
  plugin.storagePreparation = Promise.resolve({ errors: ['fixture conversion conflict'] });
  await assert.rejects(runtime.activate(), /conversion conflict/);
  app.vault.adapter.getBasePath = () => '/personal';
  await assert.rejects(runtime.unload());
}));
