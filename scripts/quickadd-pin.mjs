import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sha256 } from './artifacts.mjs';
import { pluginFiles, pluginId, regularFile, repository, vaultPath } from './sandbox.mjs';

export const quickaddId = 'quickadd';
export const quickaddPath = join(vaultPath, '.obsidian', 'plugins', quickaddId);
export const integrationPath = join(repository, 'integrations', 'quickadd');
export async function readQuickAddPin() {
  const pin = JSON.parse(await regularFile(join(integrationPath, 'release.json')));
  assert.equal(pin.repository, 'https://github.com/chhoumann/quickadd');
  assert.equal(pin.version, '2.32.0');
  assert.equal(pin.minAppVersion, '1.13.0');
  assert.equal(pin.isDesktopOnly, false);
  assert.deepEqual(Object.keys(pin.assets).sort(), [...pluginFiles].sort());
  for (const digest of Object.values(pin.assets)) assert.match(digest, /^[a-f0-9]{64}$/);
  return pin;
}
export async function verifyPinnedQuickAdd() {
  const pin = await readQuickAddPin(), installed = {};
  for (const name of pluginFiles) {
    installed[name] = sha256(await regularFile(join(quickaddPath, name)));
    assert.equal(installed[name], pin.assets[name], `QuickAdd ${name} differs from the approved official 2.32.0 asset`);
  }
  const manifest = JSON.parse(await regularFile(join(quickaddPath, 'manifest.json')));
  assert.equal(manifest.id, quickaddId);
  assert.equal(manifest.version, pin.version);
  assert.equal(manifest.minAppVersion, pin.minAppVersion);
  return { version: pin.version, installed };
}
export function validateAllowedPlugins(enabled, { requireReaderEnabled = true } = {}) {
  assert.equal(typeof requireReaderEnabled, 'boolean');
  assert.ok(Array.isArray(enabled) && (!requireReaderEnabled || enabled.includes(pluginId)) && enabled.length === new Set(enabled).size
    && enabled.every(id => id === pluginId || id === quickaddId), 'Only Reader and the explicitly approved pinned QuickAdd may be enabled by sandbox automation');
  return enabled;
}
export async function verifyAllowedPlugins(options) {
  const enabled = JSON.parse(await regularFile(join(vaultPath, '.obsidian', 'community-plugins.json')));
  validateAllowedPlugins(enabled, options);
  if (enabled.includes(quickaddId)) await verifyPinnedQuickAdd();
  return enabled;
}
