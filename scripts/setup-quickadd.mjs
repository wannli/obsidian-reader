#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './artifacts.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { assertRuntimeVault, connectToTestVault } from './cdp.mjs';
import { integrationPath, quickaddId, quickaddPath, readQuickAddPin, verifyPinnedQuickAdd } from './quickadd-pin.mjs';
import { assertOwnedVault, assertSafePath, createOnly, directory, isMain, pluginFiles, pluginId, regularFile, sandboxPath, statOrNull, vaultPath } from './sandbox.mjs';

function includesFields(actual, expected) {
  if (expected && typeof expected === 'object') return Object.entries(expected).every(([key, value]) => includesFields(actual?.[key], value));
  return actual === expected;
}

export async function setupQuickAdd() {
  await assertNoSafetyHold('QuickAdd bootstrap that may rewrite plugin enablement/templates');
  await assertOwnedVault();
  const pin = await readQuickAddPin(), files = {};
  const download = join(sandboxPath, 'downloads', 'quickadd-2.32.0');
  await directory(download);
  for (const name of pluginFiles) {
    const cached = join(download, name);
    if (await statOrNull(cached)) files[name] = await regularFile(cached);
    else {
      const response = await fetch(`https://github.com/chhoumann/quickadd/releases/download/2.32.0/${name}`, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Official QuickAdd download failed: ${name} HTTP ${response.status}`);
      files[name] = Buffer.from(await response.arrayBuffer());
      assert.equal(sha256(files[name]), pin.assets[name], `Official QuickAdd checksum mismatch: ${name}`);
      await createOnly(cached, files[name]);
    }
    assert.equal(sha256(files[name]), pin.assets[name], `Cached QuickAdd checksum mismatch: ${name}`);
    const destination = join(quickaddPath, name);
    await assertSafePath(destination, 'file');
    if (await statOrNull(destination)) assert.ok((await regularFile(destination)).equals(files[name]), `Existing QuickAdd ${name} is different; refusing an implicit upgrade/overwrite`);
  }
  const manifest = JSON.parse(files['manifest.json']);
  assert.equal(manifest.id, quickaddId); assert.equal(manifest.version, pin.version);
  const choices = JSON.parse(await regularFile(join(integrationPath, 'choices.json')));
  const dataPath = join(quickaddPath, 'data.json'), communities = join(vaultPath, '.obsidian', 'community-plugins.json');
  const oldData = await statOrNull(dataPath) ? await regularFile(dataPath) : null;
  const data = oldData ? JSON.parse(oldData) : {};
  assert.ok(data && typeof data === 'object' && !Array.isArray(data));
  assert.ok(data.choices === undefined || Array.isArray(data.choices));
  const merged = [...(data.choices ?? [])];
  for (const choice of choices) {
    const found = merged.find(existing => existing.id === choice.id || existing.name === choice.name);
    if (found) assert.ok(includesFields(found, choice), `Existing test choice ${choice.name} differs; it was preserved, not overwritten`);
    else merged.push(choice);
  }
  const communityBytes = await regularFile(communities), enabled = JSON.parse(communityBytes);
  assert.ok(Array.isArray(enabled) && enabled.includes(pluginId) && enabled.every(id => id === pluginId || id === quickaddId), 'Unexpected plugin in the dedicated-vault enablement list');
  const templates = {};
  for (const name of ['Article.md', 'Article-quick.md']) {
    const bytes = await regularFile(join(integrationPath, name)), destination = join(vaultPath, 'Templates', 'Reader', name);
    await assertSafePath(destination, 'file');
    if (await statOrNull(destination)) assert.ok((await regularFile(destination)).equals(bytes), `Existing ${destination} differs; preserved without overwrite`);
    templates[destination] = bytes;
  }
  const { browser, page } = await connectToTestVault();
  try {
    await assertRuntimeVault(page);
    await page.evaluate(async ({ quickaddId, vaultPath }) => {
      const app = window.app;
      if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before QuickAdd installation');
      if (app.plugins.plugins[quickaddId]) await app.plugins.disablePlugin(quickaddId);
    }, { quickaddId, vaultPath });
    const replacements = [];
    if (!oldData || merged.length !== (data.choices ?? []).length) replacements.push({ path: dataPath, name: 'quickadd-data.json', bytes: Buffer.from(JSON.stringify({ ...data, choices: merged }, null, 2) + '\n'), original: oldData });
    if (!enabled.includes(quickaddId)) replacements.push({ path: communities, name: 'community-plugins.json', bytes: Buffer.from(JSON.stringify([...enabled, quickaddId], null, 2) + '\n'), original: communityBytes });
    await directory(join(sandboxPath, 'backups'));
    const backup = await mkdtemp(join(sandboxPath, 'backups', 'quickadd-config-'));
    for (const item of replacements) if (item.original) await createOnly(join(backup, item.name), item.original);
    console.log(`QuickAdd configuration originals preserved at ${backup}; unrelated settings/choices are retained.`);
    for (const name of pluginFiles) await createOnly(join(quickaddPath, name), files[name]);
    for (const [path, bytes] of Object.entries(templates)) await createOnly(path, bytes);
    await directory(join(sandboxPath, 'staging'));
    const staging = await mkdtemp(join(sandboxPath, 'staging', 'quickadd-config-'));
    try {
      for (const item of replacements) {
        await createOnly(join(staging, item.name), item.bytes);
        await assertSafePath(item.path, 'file');
        if (item.original) assert.ok((await regularFile(item.path)).equals(item.original), 'QuickAdd config changed during installation');
        await assertNoSafetyHold('install staged QuickAdd/plugin enablement configuration');
        await rename(join(staging, item.name), item.path);
      }
    } finally { await rm(staging, { recursive: true, force: true }); }
    const verified = await verifyPinnedQuickAdd();
    await assertRuntimeVault(page);
    await assertNoSafetyHold('QuickAdd bootstrap activation');
    await page.evaluate(async ({ quickaddId, vaultPath }) => {
      const app = window.app;
      if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before QuickAdd activation');
      await app.plugins.loadManifests();
      await app.plugins.enablePluginAndSave(quickaddId);
    }, { quickaddId, vaultPath });
    const loaded = await page.evaluate(id => window.app.plugins.plugins[id]?.manifest.version, quickaddId);
    assert.equal(loaded, pin.version);
    const result = { vaultPath, version: pin.version, loadedVersion: loaded, officialAssetHashes: verified.installed, backup, nativeTemplateChoices: choices.map(choice => choice.id) };
    const evidenceRoot = join(sandboxPath, 'evidence'); await directory(evidenceRoot);
    const evidence = await mkdtemp(join(evidenceRoot, 'quickadd-installation-'));
    await createOnly(join(evidence, 'installation.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, evidence }, null, 2));
    return result;
  } finally { await browser.close(); }
}

if (isMain(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('No arguments accepted; only the pinned official QuickAdd in the marked Reader vault is allowed');
  await setupQuickAdd();
}
