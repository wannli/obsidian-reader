import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from './artifacts.mjs';
import { assertRuntimeVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { inside, pluginId, vaultPath } from './sandbox.mjs';
import { assertPositionWrite, flushReaderPositions, positionDelta, readMarkdown } from './runtime-storage.mjs';
import { assertControlledAcquisition } from './runtime-scope.mjs';

export const dummyQuote = 'A useful highlight preserves an idea without losing its surrounding context.';

export async function assertDummyDefault(page) {
  await assertRuntimeVault(page);
  const state = await page.evaluate(id => {
    const app = window.app, plugin = app.plugins.plugins[id];
    // Inspect this exact loaded class's default field initializers without loading
    // or enabling a second plugin instance (no onload/registration is invoked).
    const defaults = new plugin.constructor(app, plugin.manifest).settings;
    return { declaredDefault: defaults.useDummyContent, effective: plugin.settings.useDummyContent };
  }, pluginId);
  assert.equal(state.declaredDefault, true, 'Use dummy article content must default ON in the actual bundle');
  assert.equal(state.effective, true, 'The dedicated test vault must start in dummy mode; restore that setting before running');
  return state;
}

export async function setDummyMode(page, value) {
  await assertNoSafetyHold('change/restore Reader extraction mode or schedule acquisition');
  await assertRuntimeVault(page);
  if (!value) await assertControlledAcquisition(page, true);
  return page.evaluate(async ({ pluginId, vaultPath, value }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before extraction setting update');
    const plugin = app.plugins.plugins[pluginId];
    if (typeof plugin.settings.useDummyContent !== 'boolean') throw new Error('Extraction-mode setting not implemented');
    const previous = plugin.settings.useDummyContent;
    plugin.settings.useDummyContent = value;
    await plugin.saveSettings();
    plugin.controller.scheduleAcquisition();
    return { previous, current: value, scope: 'Only Reader settings in the verified synthetic vault', explicitLiveOptIn: !value };
  }, { pluginId, vaultPath, value });
}

export async function assertNoRepeatedWrites(page, paths) {
  await assertNoSafetyHold('schedule Reader worker for stability checks');
  async function snapshot() {
    const result = {};
    for (const path of paths) {
      const text = await readMarkdown(path);
      result[path] = { sha256: sha256(text), mtimeMs: (await lstat(inside(vaultPath, resolve(vaultPath, path)))).mtimeMs };
    }
    return result;
  }
  // Verify the flush delta before taking the exact hash/mtime baseline. Daily notes
  // may lack YAML and remain byte-identical; only captured article anchors may differ.
  const unflushed = new Map(await Promise.all(paths.map(async path => [path, await readMarkdown(path)])));
  await flushReaderPositions(page);
  for (const path of paths) {
    const after = await readMarkdown(path), prior = unflushed.get(path);
    if (after !== prior) assertPositionWrite(prior, after, positionDelta(page, path, prior, after));
  }
  const before = await snapshot();
  await assertRuntimeVault(page);
  await page.evaluate(id => {
    const controller = window.app.plugins.plugins[id].controller;
    controller.scheduleAcquisition(); controller.scheduleAcquisition();
  }, pluginId);
  await page.waitForTimeout(1500); // Observe multiple 150/180ms acquisition/vault-event turns.
  await flushReaderPositions(page);
  assert.deepEqual(await snapshot(), before, 'Completed articles should not be repeatedly rewritten by the automatic worker');
  return { paths, repeatedScheduleCalls: 2, stableObservationMs: 1500, files: before };
}
